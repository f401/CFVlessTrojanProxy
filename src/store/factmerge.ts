// 远端事实的合并规则（store 层用）：把 DO 车身里的五类事实并进 Meter 的表。
//
// 为什么单独一个文件：这些规则原本写在 `src/store/meter.ts` 里，而那个文件有 560 行硬上限；
// 每加一种事实要写 20 行合并代码，加第五种（dns）时直接撞线。拆出来后 meter 只保留
// 「DO 生命周期 + 往返编解码」，合并规则集中在这里，加事实不再改 meter。

import { mergeAt, mergeBlk } from "../core/facts";

/** Meter 的五类事实表（就地修改）。 */
export interface FactTables {
  /** 出口族：ip → { f: 4|6, at } */
  eg: Record<string, { f: number; at: number }>;
  /** 站点×中继成功率：`host|ip` → { q 0..255, n 样本数, at } */
  ps: Record<string, { q: number; n: number; at: number; top?: number }>;
  /** 连不上：ip → { n 连续失败, at } */
  dead: Record<string, { n: number; at: number }>;
  /** 单 IP 封锁：`host|ip` → { n 批数, at } */
  blk2: Record<string, { n: number; at: number }>;
  /** 站点 DNS：host → { v 1 有 AAAA / 0 确证没有, at } */
  dns: Record<string, { v: number; at: number }>;
}

/** 上行/下行车身里与事实有关的字段（其余字段由 meter 自己处理）。 */
export interface FactDeltaIn {
  eg?: unknown;
  ps?: unknown;
  dead?: unknown;
  blk2?: unknown;
  dns?: unknown;
}

/**
 * 功能：把远端车身里的事实并进本地表（新观测胜、过期丢、按容量淘汰）。
 * @param t 本地事实表（就地修改）
 * @param d 远端车身
 * @returns {void}
 */
export function mergeFacts(t: FactTables, d: FactDeltaIn): void {
    // 出口族事实搭便车：新观测覆盖旧观测（at 更大者胜），过期行直接丢；表上限 512 条
    if (Array.isArray(d.eg) && d.eg.length) {
      for (const r of d.eg as Array<{ i?: unknown; f?: unknown; at?: unknown }>) {
        if (!r || typeof r.i !== "string" || typeof r.at !== "number") continue;
        if (r.f !== 4 && r.f !== 6) continue;
        if (r.at <= Date.now() - 21600000) continue;
        const cur = t.eg[r.i];
        if (cur && cur.at >= r.at) continue;
        t.eg[r.i] = { f: r.f, at: r.at };
      }
      const ek = Object.keys(t.eg);
      if (ek.length > 512) {
        ek.sort((a, b) => t.eg[b].at - t.eg[a].at);
        for (const k of ek.slice(512)) delete t.eg[k];
      }
    }
    // DNS 事实：24 小时寿命（DoH 全失败时调用方根本不写，所以不必区分「没有」与「不知道」）
    if (Array.isArray(d.dns) && d.dns.length) {
      mergeAt(t.dns, d.dns, 512, 86400000, (r) => {
        const x = r as { v?: unknown; at?: unknown };
        if (x.v !== 0 && x.v !== 1) return null;
        const at = Number(x.at) || 0;
        return at ? { v: x.v, at } : null;
      });
    }
    // 成功率事实（v8 §5 的 ps）：新观测覆盖旧观测；45 分钟没更新的行直接丢，表上限 512 条。
    // 不做「按样本数投票」之类合并：各 isolate 的样本不可比（每条 isolate 看到的路径不同）。
    if (Array.isArray(d.ps) && d.ps.length) {
for (const r of d.ps as Array<{ k?: unknown; q?: unknown; n?: unknown; at?: unknown; top?: unknown }>) {
        if (!r || typeof r.k !== "string" || !r.k.includes("|")) continue;
        if (typeof r.at !== "number" || typeof r.q !== "number" || typeof r.n !== "number") continue;
        if (r.at <= Date.now() - 2700000) continue;
        const cur = t.ps[r.k];
        if (cur && cur.at >= r.at) continue;
        // 历史最好只升不降（v7.163）：它不进 `at` 的比较，也不能被新观测的均值覆盖，
        // 否则「曾经行过」的证据每跨一次 isolate 就衰减一次，康复通道永远等不到那条通道。
        const qq = Math.max(0, Math.min(255, Math.round(r.q)));
        const wTop = Number(r.top);
        const top = Math.max(cur?.top ?? 0, qq, Number.isFinite(wTop) ? Math.max(0, Math.min(255, Math.round(wTop))) : 0);
        t.ps[r.k] = { q: qq, n: Math.max(0, Math.min(32, r.n)), at: r.at, top };
      }
      const pk = Object.keys(t.ps);
      if (pk.length > 512) {
        pk.sort((a, b) => t.ps[b].at - t.ps[a].at);
        for (const k of pk.slice(512)) delete t.ps[k];
      }
    }
    // 「连不上」事实（形状 { i, n, at }）：更新的胜、30 分钟过期、上限 256；只收判死（n>=2）的行
    if (Array.isArray(d.dead) && d.dead.length) {
      mergeAt(t.dead, d.dead, 256, 1800000, (r) => {
        const x = r as { n?: unknown; at?: unknown };
        if (typeof x.at !== "number" || typeof x.n !== "number" || x.n < 2) return null;
        return { n: Math.max(2, Math.min(9, Math.round(x.n))), at: x.at };
      });
    }
    // 单 IP 封锁事实：形状 `{ k, n, at }`，更新的胜、90 分钟过期、上限 1024 条（逻辑在 core/facts）
    if (Array.isArray(d.blk2) && d.blk2.length) mergeBlk(t.blk2, d.blk2, 1024, 90 * 60000);
}
