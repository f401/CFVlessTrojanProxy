// 节点选择器的门面：`SEL` 是生产代码唯一入口。
// 实现分成三块 —— 挑谁（./pickpath 的 `PickPath`）、什么时候换（./rotation 的 `Rotation`）、
// 失败怎么记（./failbook 的 `FailBook`）；这个文件只做委托与再导出，不再有算法。

import { BoundedMap } from "../core/table";
import { logErr } from "../nodes/metrics";
import { timeoutSignal } from "../core/util";
import { checkTarget } from "../core/net";
import { socks5Open } from "../core/budgeted-io";
import type { BudgetedIO } from "../core/budgeted-io";
import { cnt } from "../core/counter";
import { PickPath } from "./pickpath";
import { Rotation } from "./rotation";
import { FailBook } from "./failbook";
import type { PickState } from "./pickpath";

export { Rotation, dwellOf } from "./rotation";
export { FailBook } from "./failbook";
export type { PickState } from "./pickpath";

/**
 * 节点选择器（门面）：把「挑哪台节点 / 什么时候换 / 失败怎么记」暴露成同一组方法。
 * 每个方法都委托给各自的执行器，返回值就是被委托函数的返回值 —— 不要在这里另做裁剪。
 */
export class Selector {
  /**
   * 换节点判定器：什么条件算「该换了」、留在新节点上至少多久，都封在 `Rotation` 里。
   * 7.356 前它是模块级 `ROTATION`，且失败记账器直接引它 —— 读门面看不出这件
   * 决策挂在谁身上。现在门面持有唯一实例，并把同一个实例交给记账器。
   */
  private readonly rotation = new Rotation();
  /**
   * 失败记账器：罚多重、什么时候清、连带要不要换节点都封在 `FailBook` 里。
   * 7.347 前它是模块级 `FAILS`，读门面时看不出谁在用它、用了几次。
   */
  private readonly fails = new FailBook(this.rotation);
  /**
   * 挑节点的执行器（7.385 起由门面自己持有）：画像、冷启动影子、抽样、粘滞兜底都在它里面。
   * 7.384 前它是模块级 `PICK`，selector.ts 还多一条 `export { PICK }` 死导出；
   * 现在门面是生产唯一入口，挑谁这件事就挂在 `SEL.picker` 上。
   */
  private readonly picker = new PickPath();
  /** 按国家挑一个节点（地区硬要求：调用方不得回落到直连/全球） */
  async region(env: Env, cc: string | null, mode: Mode = "tput", avoid = "") {
    // 实现见 PickPath.region：这个类只做委托。
    return this.picker.region(env, cc, mode, avoid);
  }

  /**
   * 选一个节点。
   *   ① 先看"这个站"的历史：有样本就按站点分选（hostCost）
   *   ② 冷启动（这个站试过的节点 <3）：一半概率去试一个没试过的
   *   ③ 都没有 → 回到全局游标 + 影子流量
   */
  pick(env: Env, mode: Mode, st: PickState | null) {
    // 实现见 PickPath.pick：这个类只做委托。
    return this.picker.pick(env, mode, st);
  }

  /** 重新评估是否该换节点（cron 与失败路径共用） */
  maybeSwitch(env: Env, mode: Mode) {
    // 实现见 Rotation.maybeSwitch：这个类只做委托。
    return this.rotation.maybeSwitch(env, mode);
  }

  /**
   * 失败处理：记账 → 必要时回滚/换节点。
   * 站点级试探（Connection.hostTrial）的失败只冻结它自己，不动主游标，也不进全局失败记忆。
   * @param {object} env Worker 环境
   * @param {string} mode 模式
   * @param {string} k 节点
   * @param {boolean} trial 是不是站点级试探（只有 hostTrial 会置位）
   * @returns {void}
   */
  onFail(_env: Env, mode: Mode, k: string, trial: boolean) {
    // 实现见 FailBook.onFail：这个类只做委托。
    return this.fails.onFail(_env, mode, k, trial);
  }

  /** 只记一次全局失败，不动游标也不冻结（站点级试探失败用） */
  async softFail(k: string) {
    // 实现见 FailBook.softFail：这个类只做委托。
    return this.fails.softFail(k);
  }

  /** 记一次失败；连续到阈值就换节点。兼容旧调用。 */
  async bumpFail(env: Env, mode: Mode, k: string, trial: boolean, kind: "node" | "site" = "node") {
    // 实现见 FailBook.bumpFail：这个类只做委托。
    return this.fails.bumpFail(env, mode, k, trial, kind);
  }

  /** 链路健康：清零计数。成功样本由 Connection.flush 在收尾时统一记一次。 */
  async resetFail(_env: Env, _k: string) {
    // 实现见 FailBook.resetFail：这个类只做委托。
    return this.fails.resetFail(_env, _k);
  }

  /**
   * 当前节点（"auto" 模式才用池子；手动配置直接返回）。
   * @param {object} env Worker 环境
   * @param {'lat'|'tput'} mode 选路模式
   * @param {object|null} st 连接状态（会写 st.node）
   * @param {string} host 目标站点（空串 = 没有站点上下文，只按通用分数挑）
   * @param {boolean} cfOnly 目标是否 CF 托管（是则跳过 CF 边缘中继）
   * @param {Set<string>|null} exclude 已经试过的 `host:port`（拨号重试要找「下一条」，
   *   不能把刚失败的同一条再挑回来 —— 这条链路的返回值在确定性路径下是每次都一样的）
   * @returns {string} `host:port`，没有可选候选时返回空串
   */
  async current(
    env: Env,
    mode: Mode,
    st: PickState | null,
    host = "",
    cfOnly = false,
    exclude: Set<string> | null = null,
  ) {
    // 实现见 PickPath.current：这个类只做委托。
    return this.picker.current(env, mode, st, host, cfOnly, exclude);
  }

  /** cron 扫描收尾：重算两个模式的游标，再做定时轮换 */
  afterScan(env: Env) {
    // 实现见 Rotation.afterScan：这个类只做委托。
    return this.rotation.afterScan(env);
  }

  /**
   * 定时轮换：让"成绩接近"的前二名轮流吃真实流量，保证吞吐样本不全压在一个人身上。
   * @param {object} env Worker 环境
   * @returns {void}
   */
  sched(env: Env) {
    // 实现见 Rotation.sched：这个类只做委托。
    return this.rotation.sched(env);
  }
}

/** 进程内唯一实例 */
export const SEL = new Selector();

/** 公共 SOCKS5 池的来源：都是 `ip:port` 纯文本，几分钟到半小时刷新一次 */
export const SOCKS_SOURCES = [
  "https://raw.githubusercontent.com/proxy-free/free-proxy-list/main/socks5.txt",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
  "https://raw.githubusercontent.com/r00tee/Proxy-List/main/Socks5.txt",
];

/** 池子硬上限：公共代理可用率只有十几个百分点，收太多只是把验证名额摊薄 */
export const SOCKS_MAX = 400;

/** 一次刷新最多验证几条：每条都是一次真实 `connect()`，要把免费计划的 6 个并发名额留给数据面 */
export const SOCKS_VERIFY_MAX = 12;

/** 验证失败后的冷却时间：失败过的代理不要每轮都重试 */
export const SOCKS_COOL_MS = 30 * 60e3;

/** 条目寿命：公共代理存活时间以小时计，过期就当从没见过 */
export const SOCKS_TTL_MS = 45 * 60e3;

/** 连不上几次以后进入冷却 */
const SOCKS_MAX_FAIL = 3;

/** 验证时连的目标：IP 字面量，省掉代理侧 DNS，能最快判出「这个代理通不通」 */
const VERIFY_TARGET = { host: "1.1.1.1", port: 443 };

/** 一条公共代理 */
export interface SocksRow {
  /** 主机（IPv4 字面量） */
  h: string;
  /** 端口 */
  port: number;
  /** 来源 URL */
  src: string;
  /** 入库时间 */
  at: number;
  /** 最近一次验证成功的时间（0 表示从未验证成功） */
  okAt: number;
  /** 最近一次验证的握手耗时（毫秒，0 表示没有成功记录） */
  rttMs: number;
  /** 连续失败次数 */
  fails: number;
}

/**
 * 功能：公共 SOCKS5 代理池 —— 抓列表、实测验证、按延迟挑一条给数据面用。
 *
 * 为什么独立于 `POOL_MEMORY.rows`：那是 CF 网络里的 proxyip 中继，只肯转发 CF 托管站点；
 * 这里是通用出口（能到任意站点），拨号要先做 SOCKS5 握手，两者不能混在一张表里。
 * 状态放 isolate 内存：这些是「这台机器此刻的实测结果」，按硬约束不写 KV/seed。
 */
export class SocksPool {
  private readonly rows = new BoundedMap<string, SocksRow>({
    max: SOCKS_MAX,
    ttlMs: SOCKS_TTL_MS,
    timeOf: (r) => r.at,
  });

  /** 最近一次抓取的时间与各源行数（面板展示用） */
  private lastAt = 0;
  private lastSrc: Record<string, number> = Object.create(null);

  /**
   * 功能：抓全部来源并合并去重（不做验证，验证是 `verify` 的事）。
   * @param env 环境变量（当前不读配置，留作后续自定义源）
   * @returns {Promise<number>} 本次池子里的条目数
   */
  async refill(env: Env): Promise<number> {
    void env;
    const seen = new Map<string, SocksRow>();
    const now = Date.now();
    const stat: Record<string, number> = Object.create(null);
    for (const src of SOCKS_SOURCES) {
      let n = 0;
      try {
        const r = await fetch(src, { signal: timeoutSignal(10000) });
        if (!r.ok) {
          stat[src] = -r.status;
          continue;
        }
        // 有的列表能到几万行：只读前 2MB，够用了，也防异常响应把 CPU 打满
        const txt = (await r.text()).slice(0, 2 * 1024 * 1024);
        for (const line of txt.split("\n")) {
          const m = /(\d{1,3}(?:\.\d{1,3}){3})[:\s](\d{1,5})/.exec(line);
          if (!m) continue;
          const port = Number(m[2]);
          if (!(port >= 1 && port <= 65535)) continue;
          // 内网/保留地址直接丢：这类条目在公共列表里很常见，连上去只会白烧一个 connect 名额
          if (checkTarget(m[1], port)) continue;
          const key = m[1] + ":" + port;
          if (seen.has(key)) continue;
          // 没验证过的先记 okAt=0：面板据此显示「未验证」，也不许被选作出口
          seen.set(key, { h: m[1], port, src, at: now, okAt: 0, rttMs: 0, fails: 0 });
          n += 1;
          if (seen.size >= SOCKS_MAX) break;
        }
      } catch {
        stat[src] = -1;
      }
      stat[src] = n;
      if (seen.size >= SOCKS_MAX) break;
    }
    // 整表替换：上一轮的陈旧条目留着会让「可用数」虚高
    this.rows.clear();
    for (const [k, v] of seen) this.rows.set(k, v);
    this.lastAt = now;
    this.lastSrc = stat;
    cnt("s5Refill", seen.size);
    logErr("socks refilled: " + seen.size, "");
    return seen.size;
  }

  /**
   * 功能：从池子里挑最多 n 条「没验证过或该重验」的候选做真实握手验证。
   * @param gate 额度闸门（每条都占一次 `connect()`）
   * @param n 本次最多验证几条
   * @returns {Promise<{ ok: number; bad: number }>} 成功与失败的条数
   */
  async verify(gate: BudgetedIO, n = SOCKS_VERIFY_MAX): Promise<{ ok: number; bad: number }> {
    const now = Date.now();
    const cand: SocksRow[] = [];
    for (const r of this.rows.values()) {
      // 冷却中的跳过：连续失败过的代理这一轮别再花名额
      if (r.fails >= SOCKS_MAX_FAIL && now - r.at < SOCKS_COOL_MS) continue;
      if (r.okAt > 0 && now - r.okAt < SOCKS_COOL_MS) continue; // 刚验过的不用重验
      cand.push(r);
      if (cand.length >= n) break;
    }
    let ok = 0;
    let bad = 0;
    for (const r of cand) {
      const t0 = Date.now();
      try {
        // 握手成功即视为可用：目标用 IP 字面量，避免把「代理侧 DNS 坏了」当成代理不可用
        const sock = await socks5Open(gate, { host: r.h, port: r.port }, VERIFY_TARGET);
        try {
          await sock.close();
        } catch {
          /* 已经关了 */
        }
        r.okAt = Date.now();
        r.rttMs = r.okAt - t0;
        r.fails = 0;
        ok += 1;
      } catch {
        r.fails += 1;
        bad += 1;
      }
    }
    cnt("s5Ok", ok);
    cnt("s5Bad", bad);
    return { ok, bad };
  }

  /**
   * 功能：挑一条已验证可用、最近没失败的代理（延迟最低优先）。
   * @param now 当前时间
   * @returns {SocksRow | null} 可用条目或 null
   */
  pick(now = Date.now()): SocksRow | null {
    let best: SocksRow | null = null;
    for (const r of this.rows.values()) {
      if (r.okAt <= 0) continue;
      if (now - r.okAt > SOCKS_TTL_MS) continue; // 验证结果也过期
      if (r.fails >= SOCKS_MAX_FAIL) continue;
      if (!best || r.rttMs < best.rttMs) best = r;
    }
    return best;
  }

  /**
   * 功能：面板/JSON 用的快照（不含内部 Map 结构）。
   * @returns {object} 池子规模、最近抓取时间、每源行数、条目列表
   */
  snap(): { n: number; ok: number; at: number; src: Record<string, number>; rows: SocksRow[] } {
    const rows = [...this.rows.values()].sort((a, b) => (a.rttMs || 1e9) - (b.rttMs || 1e9));
    return { n: rows.length, ok: rows.filter((r) => r.okAt > 0).length, at: this.lastAt, src: this.lastSrc, rows };
  }

  /**
   * 功能：记录一条代理的连接失败（数据面用），用于把它推进冷却。
   * @param key `ip:port`
   * @returns {void}
   */
  markFail(key: string): void {
    const r = this.rows.get(key);
    if (r) r.fails += 1;
  }
}

/** 全局单例：整个 isolate 共用一份（这些是客观事实，不是跨 isolate 的统计） */
export const SOCKS = new SocksPool();
