// 策略与 HOOK 槽位之间的装配层。
//
// 为什么要单独一层：policy 本体只管「哪条通道」，而 HOOK 是 proxy / route 侧唯一能看见对手册；
// 把二十个注册点写在决策类里，会让「一个类一件事」变成「一个类还兼着接线」，
// 而漏注册一个槽位从来不会有门禁报错（7.123 的 `HOOK.facts` 就是这样静默失效的）。
import { HOOK } from "../core/hook";
import type { DecisionIn, DecisionOut, DecisionWhy } from "../core/hook";
import type { Chan } from "../facts/channel";

/**
 * 决策上下文：一次决策需要的全部外部输入（都是已算好的事实，不含 IO）。
 * 这个端口类型住在装配层，是为了让 `policy.ts` 单向依赖它 ——
 * 反过来（策略声明类型、装配层引用）会让两个文件互相 import。
 */
export interface Ctx {
  host: string;
  cfHost: boolean; // 目标托管在 CF 上
  clientV6: boolean; // 客户端出口是 IPv6（cf-connecting-ip）
  relays: string[]; // 池里可用中继的 IP
  legacyWantsRelay: boolean; // 现状：session 的 wantPx
  /** 传输模式（`tput` / `lat`）；缺省按吞吐模式，测试可省略 */
  mode?: string;
  /** 启用的事实集合；缺省视为全开（测试与旧调用点不必改） */
  facts?: ReadonlySet<string>;
}

/** 决策结果：选中的通道与一句可读理由（理由会进日志与影子统计）。 */
export interface Choice {
  chan: Chan;
  why: DecisionWhy;
}

/**
 * 装配层需要策略提供的四个能力（结构化接口，避免与 `policy.ts` 相互 import）。
 * 只有这四件事是「策略对外的行为面」，其余实现细节（三张内存表、排序算式）留在策略里。
 */
export interface PolicySource {
  /** 功能：做一次决策并记影子统计。 @param c 决策上下文 @returns 选中通道与理由 */
  shadow(c: Ctx): Choice;
  /** 功能：当前可用的中继候选（已按健康度排序）。 @returns 中继 IP 列表 */
  relays(): string[];
  /** 功能：该站点 × 该中继是否被实测判 ok。 @param host 目标站 @param ip 中继 IP @returns 判过 ok 为 true */
  prefer(host: string, ip: string): boolean;
  /** 功能：该站点的通道成功记忆。 @param host 目标站 @returns 直连/中继各自是否成功过 */
  win(host: string): { d: boolean; r: boolean };
}

/** 把策略装配到 HOOK 槽位：一次装配，之后 proxy 只调核心 HOOK */
export class PolicyWiring {
  /**
   * 功能：把策略的四个能力接到 HOOK 唯一剩下的 `decide` 槽位上。
   * 漏注册一个槽位不会有门禁报错（`check-wire` 扫的是「符号有没有生产调用点」，
   * 而槽位是「注册」不是「调用」）—— 7.123 的 `HOOK.facts` 就是这样静默失效的，
   * 7.439 起槽位只剩 `decide`：其余事实改为直接 import `src/facts/*`，注释里的示例名也必须写实，否则门禁会把注释当赋值。
   * @param policy 策略实例（只依赖 `PolicySource` 的四个方法）
   * @returns {void}
   */
  install(policy: PolicySource): void {
    HOOK.decide = (x: DecisionIn): DecisionOut => {
      const d = policy.shadow({ host: x.host, cfHost: x.cfHost, clientV6: x.clientV6, relays: policy.relays(), legacyWantsRelay: x.legacyWantsRelay });
      return { via: d.chan.kind === "d" ? "d" : "r", ip: d.chan.ip, why: d.why };
    };
  }
}

