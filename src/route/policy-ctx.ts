// 通道决策的输入/输出类型与共享上限：这里只有类型与常量，不含任何算法，
// 目的是让策略本体与装配层都能引用它而不产生循环依赖。
import { SC } from "../core/const";
import { FACT_ALL } from "./factflags";
import type { Chan } from "./channel";

/** 全开的默认集合：没有读到 `env.facts` 时用它，等价于「不裁剪」。 */
export const FULL_ON: ReadonlySet<string> = new Set<string>(FACT_ALL);

/**
 * 「按站点」的内存表上限：站点名来自客户端请求，不是有限集合。
 * 7.158 起这个数字在 `SC.HOST_MEM_MAX`（judge / dialer / verdictsync 也要用同一份），
 * 这里保留别名只是为了不把 trim 里的算式改得到处都是。
 */
export const HOST_MEM_MAX = SC.HOST_MEM_MAX;

/** 决策上下文：一次决策需要的全部外部输入（都是已算好的事实，不含 IO）。 */
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
  why: string;
}
