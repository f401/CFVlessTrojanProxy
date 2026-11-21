// 远端事实的合并规则（store 层用）：把 DO 车身里的五类事实并进本地表。
//
// 为什么是一个类而不是一个函数：五张表各有自己的形状、寿命与上限，但**合并纪律是同一套**
// （更新的胜、过期丢、按容量淘汰、只收语义上确定的行）。把它们写成同一个类里的五个私有方法，
// 「哪张表有什么特殊规矩」就落在一个文件里；`merge()` 只负责按表分派。
// 历史上这里是一个 60 行的函数，加第五种事实（dns）时就撞上了 `meter.ts` 的 560 行上限。

import { FACT_TTL, mergeAt, mergeBlk } from "../core/facts";
import type { FactTables as AllFactTables } from "./metershard";

/**
 * 合并不涉及的五类事实表（就地修改）：从七张表的单一真源里取子集。
 * 行类型不在这里重复声明 —— 一处改别处没跟的漂移由 tsc 兜底。
 */
export type FactMergeTarget = Pick<AllFactTables, "eg" | "ps" | "dead" | "blk2" | "dns">;

/** 上行/下行车身里与事实有关的字段（其余字段由 meter 自己处理）。 */
interface FactDeltaIn {
  eg?: unknown;
  ps?: unknown;
  dead?: unknown;
  blk2?: unknown;
  dns?: unknown;
}

/**
 * 功能：把远端车身里的事实并进本地表（新观测胜、过期丢、按容量淘汰）。
 *
 * 每张表一个私有方法，是因为它们的「有效观测」判据各不相同：出口族看族号是否 4/6、
 * 成功率表要保「历史最好」这条单调水位、连不上表只收 n>=2 的判死行、DNS 表只认 0/1。
 */
export class FactMerger {
  /**
   * 功能：按表分派合并。
   * @param t 本地事实表（就地修改）
   * @param d 远端车身
   * @returns {void}
   */
  merge(t: FactMergeTarget, d: FactDeltaIn): void {
    this.egRows(t, d.eg);
    this.dnsRows(t, d.dns);
    this.psRows(t, d.ps);
    this.deadRows(t, d.dead);
    this.blkRows(t, d.blk2);
  }

  /**
   * 功能：出口族事实（搭便车：整页 ⇒ v4、有对照的小页 ⇒ v6）。
   * @param t 本地事实表
   * @param raw 远端行（形状 `{ i, f, at }`）
   * @returns {void}
   */
  private egRows(t: FactMergeTarget, raw: unknown): void {
    if (!Array.isArray(raw) || !raw.length) return;
    for (const r of raw as Array<{ i?: unknown; f?: unknown; at?: unknown }>) {
      // 地址、族号、时间三件事任一不成立就整条跳过：坏行会让 `famOf` 返回未知族
      if (!r || typeof r.i !== "string" || typeof r.at !== "number") continue;
      if (r.f !== 4 && r.f !== 6) continue;
      if (r.at <= Date.now() - FACT_TTL.eg) continue;
      const cur = t.eg[r.i];
      if (cur && cur.at >= r.at) continue;
      t.eg[r.i] = { f: r.f, at: r.at };
    }
    // 上限 512：按证据时间降序保留，旧的先丢（按插入序切会切掉最新那条）
    const ek = Object.keys(t.eg);
    if (ek.length > 512) {
      ek.sort((a, b) => t.eg[b].at - t.eg[a].at);
      for (const k of ek.slice(512)) delete t.eg[k];
    }
  }

  /**
   * 功能：站点 DNS 事实（24 小时寿命；DoH 全失败时调用方根本不写，所以不必区分「没有」与「不知道」）。
   * @param t 本地事实表
   * @param raw 远端行（形状 `{ k, v, at }`）
   * @returns {void}
   */
  private dnsRows(t: FactMergeTarget, raw: unknown): void {
    if (!Array.isArray(raw) || !raw.length) return;
    mergeAt(t.dns, raw, 512, FACT_TTL.dns, (r) => {
      const x = r as { v?: unknown; at?: unknown };
      if (x.v !== 0 && x.v !== 1) return null;
      const at = Number(x.at) || 0;
      return at ? { v: x.v, at } : null;
    });
  }

  /**
   * 功能：站点×中继成功率（v8 §5 的 `ps`）：新观测覆盖旧观测，45 分钟没更新就丢，上限 512。
   *
   * 不做「按样本数投票」之类合并：各 isolate 的样本不可比（每个 isolate 看到的路径不同）。
   * @param t 本地事实表
   * @param raw 远端行（形状 `{ k, q, n, at, top? }`）
   * @returns {void}
   */
  private psRows(t: FactMergeTarget, raw: unknown): void {
    if (!Array.isArray(raw) || !raw.length) return;
    for (const r of raw as Array<{ k?: unknown; q?: unknown; n?: unknown; at?: unknown; top?: unknown }>) {
      // 键必须带 `|`：少了它就不是「站点×中继」，而是把两条维度混成一个字符串
      if (!r || typeof r.k !== "string" || !r.k.includes("|")) continue;
      if (typeof r.at !== "number" || typeof r.q !== "number" || typeof r.n !== "number") continue;
      if (r.at <= Date.now() - FACT_TTL.ps) continue;
      const cur = t.ps[r.k];
      const qq = Math.max(0, Math.min(255, Math.round(r.q)));
      const wTop = Number(r.top);
      const inTop = Math.max(qq, Number.isFinite(wTop) ? Math.max(0, Math.min(255, Math.round(wTop))) : 0);
      if (cur && cur.at >= r.at) {
        // 更旧的观测不覆盖均值与计数，但「历史最好」是单调水位：整行丢掉等于把别处那条成功抹了
        // （别处 10 分钟前成过一次、本地 1 分钟前只是又失败一次，康复通道要的是前者），所以只提 top。
        if (inTop > (cur.top ?? 0)) cur.top = inTop;
        continue;
      }
      t.ps[r.k] = { q: qq, n: Math.max(0, Math.min(32, r.n)), at: r.at, top: Math.max(cur?.top ?? 0, inTop) };
    }
    // 上限 512，同样按证据时间降序保留
    const pk = Object.keys(t.ps);
    if (pk.length > 512) {
      pk.sort((a, b) => t.ps[b].at - t.ps[a].at);
      for (const k of pk.slice(512)) delete t.ps[k];
    }
  }

  /**
   * 功能：「连不上」事实（形状 `{ i, n, at }`）：更新的胜、30 分钟过期、上限 256；只收判死（n>=2）。
   * @param t 本地事实表
   * @param raw 远端行
   * @returns {void}
   */
  private deadRows(t: FactMergeTarget, raw: unknown): void {
    if (!Array.isArray(raw) || !raw.length) return;
    mergeAt(t.dead, raw, 256, FACT_TTL.dead, (r) => {
      const x = r as { n?: unknown; at?: unknown };
      if (typeof x.at !== "number" || typeof x.n !== "number" || x.n < 2) return null;
      return { n: Math.max(2, Math.min(9, Math.round(x.n))), at: x.at };
    });
  }

  /**
   * 功能：单 IP 封锁事实（形状 `{ k, n, at }`）：更新的胜、90 分钟过期、上限 1024 条（逻辑在 core/facts）。
   * @param t 本地事实表
   * @param raw 远端行
   * @returns {void}
   */
  private blkRows(t: FactMergeTarget, raw: unknown): void {
    if (!Array.isArray(raw) || !raw.length) return;
    mergeBlk(t.blk2, raw, 1024, FACT_TTL.blk);
  }
}
