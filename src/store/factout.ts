// 出站事实车身的形状（store 层用）：DO 的 `/vt` 把七张表打成一份响应交给别的 isolate。
//
// 为什么单独一个文件：`src/store/meter.ts` 有 560 行硬上限，而「表 → 出站行」的映射每张表
// 都要写一段（取字段、算派生量、按上限切片）。更重要的原因是**切片顺序必须集中在一处**：
// 七张表的响应上限（120/160/200）都小于表上限（200/200/512/1024），谁按插入序切，谁就会
// 把最新学到的证据饿死 —— `Object.entries` 是插入序，而合并只追加新键，所以新行的位置
// 永远在最后（v7.177 的 pend 饥饿、v7.181 的 hl 淘汰留最旧、v7.187 的出口切片都是这个形状）。

import { St } from "../core/enums";

/** DO 里七张事实表的最小形状（只声明这里读到的东西） */
interface FactOutSrc {
  /** 判定表：`站点|通道` → 到期时间，或 `{ 状态, 到期时间 }`（老行是裸数字） */
  vt: Record<string, number | { s: number; t: number }>;
  /** 中继存活度：ip → 计数与最后观测时间 */
  hl: Record<string, { o: number; b: number; d: number; t?: number }>;
  /** 出口族：ip → { 族, 时间 } */
  eg: Record<string, { f: number; at: number }>;
  /** 站点×中继成功率：`站点|ip` → { 均值, 样本数, 时间, 历史最好 } */
  ps: Record<string, { q: number; n: number; at: number; top?: number }>;
  /** 连不上：ip → { 连续失败次数, 时间 } */
  dead: Record<string, { n: number; at: number }>;
  /** 单 IP 封锁：`站点|ip` → { 批数, 时间 } */
  blk2: Record<string, { n: number; at: number }>;
  /** 站点 DNS：站点 → { 有/无 AAAA, 时间 } */
  dns: Record<string, { v: number; at: number }>;
}

/** 判定行的线格式（状态 2 = blocked、3 = dead） */
interface VtOutRow {
  /** `站点|通道` */
  k: string;
  /** 状态 */
  s: number;
  /** 到期时间 */
  t: number;
}

/** 中继存活度行（`t` 缺省的老行按 0 发，由接收方按 TTL 判过期） */
interface HlOutRow {
  /** 中继 IP */
  i: string;
  /** 成功次数 */
  o: number;
  /** 失败次数 */
  b: number;
  /** 判死次数 */
  d: number;
  /** 最后观测时间 */
  t: number;
}

/**
 * 功能：按时间戳取最新的 n 行（出站切片必须按新鲜度，不能按插入序）。
 * 为什么要有这个函数：`Object.entries` 给的是插入序，而事实表合并只会「更新已有键」或
 * 「追加新键」（Delete 只在超容量时发生），所以新学到的证据永远排在最后。表上限大于响应
 * 上限时，直接 `slice(0, n)` 切出来的就是**最旧**的那批：新证据在这个 isolate 里躺着，
 * 永远到不了别的 isolate（`blk2` 上限 1024 却只发 120 行、`dns` 上限 512 只发 160 行）。
 * @template T 行类型
 * @param {T[]} rows 候选行（会被就地排序）
 * @param {(r: T) => number} at 取时间戳
 * @param {number} n 上限
 * @returns {T[]} 最多 n 行，按时间戳降序
 */
export function freshTop<T>(rows: T[], at: (r: T) => number, n: number): T[] {
  // 不超过上限时不用排序：调用方只关心「发哪些」，发出的顺序不进任何判断
  if (rows.length <= n) return rows;
  return rows.sort((a, b) => at(b) - at(a)).slice(0, n);
}

/**
 * 功能：把 DO 的七张事实表打成 `/vt` 的响应体。
 * @param {FactOutSrc} src 七张表（只读）
 * @param {number} now 当前时间，`vt` 只发未过期的行
 * @returns {Record<string, unknown>} 响应体；字段名即线协议，改名必须同步 `src/route/verdictsync.ts`
 */
export function factsOut(src: FactOutSrc, now = Date.now()): Record<string, unknown> {
  // 判定行：状态跟着存、跟着发（v7.164）。以前这里硬写 `s: 2`，任何 `dead` 证据跨一次
  // isolate 就降级成 `blocked`，硬排除在跨 isolate 之后消失。
  const vt: VtOutRow[] = [];
  for (const [k, v] of Object.entries(src.vt)) {
    const t = typeof v === "number" ? v : v.t;
    const s = typeof v === "number" ? St.Blocked : v.s === St.Dead ? St.Dead : St.Blocked;
    if (t > now) vt.push({ k, s, t });
  }
  const hl: HlOutRow[] = Object.entries(src.hl).map(([i, x]) => ({ i, o: x.o, b: x.b, d: x.d, t: Number(x.t) || 0 }));
  const eg = Object.entries(src.eg).map(([i, x]) => ({ i, f: x.f, at: x.at }));
  // `top` 也要发（v7.163）：只发均值的话，冷启动 isolate 只能看到「现在还行」，
  // 而康复闸门要的是「曾经行过」—— 那条证据必须跨 isolate 活着。
  const ps = Object.entries(src.ps).map(([k, x]) => ({ k, q: x.q, n: x.n, at: x.at, top: Number(x.top) || 0 }));
  const dead = Object.entries(src.dead).map(([i, x]) => ({ i, n: x.n, at: x.at }));
  const blk2 = Object.entries(src.blk2).map(([k, x]) => ({ k, n: x.n, at: x.at }));
  const dns = Object.entries(src.dns).map(([h, x]) => ({ h, v: x.v, at: x.at }));
  // 七张表一律先取最新再切片（v7.187）：`eg`/`ps`/`dead` 早就排过序，`vt`/`hl`/`blk2`/`dns` 漏了
  return {
    vt: freshTop(vt, (r) => r.t, 120),
    hl: freshTop(hl, (r) => r.t, 120),
    eg: freshTop(eg, (r) => r.at, 160),
    ps: freshTop(ps, (r) => r.at, 200),
    dead: freshTop(dead, (r) => r.at, 120),
    blk2: freshTop(blk2, (r) => r.at, 120),
    dns: freshTop(dns, (r) => r.at, 160),
  };
}
