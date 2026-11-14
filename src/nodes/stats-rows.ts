import { S } from "../core/state";
import { costOf, p90Of, ZERO_STAT } from "./score";

/* 看板 view-model：把节点统计压成纯展示行，views 不再读 S / 算分 */

/**
 * 功能：生成面板「节点明细」的行数据（键、延迟、吞吐、成功率、探活次数）。
 * @param env 环境变量
 * @returns 行数组
 */
export function statsNodeRows(
  alive: NodeEntry[],
  nsMap: Record<string, Record<string, number | string>>,
): StatsNodeRow[] {
  return (alive || [])
    .map((x: NodeEntry) => {
      const k = x.h + ":" + x.p;
      const a1 = S.nstat.get(k) || ZERO_STAT;
      const b1 = (nsMap && nsMap[k]) || {};
      const st = {
        ok: Math.max(a1.ok || 0, Number(b1.ok) || 0),
        fail: Math.max(a1.fail || 0, Number(b1.fail) || 0),
        bps: Number(b1.bps) || p90Of(a1) || 0,
        samples: Number(b1.n) || 0,
      };
      const ok = st.ok || 0;
      const bad = st.fail || 0;
      const rate = ok + bad > 0 ? Math.round((ok / (ok + bad)) * 100) + "% (" + ok + "/" + (ok + bad) + ")" : "-";
      // bps 来自"真实下载窗口"的 p90：本实例没有样本时，面板会去读 Meter DO 里的跨实例快照
      const nSamp = Number(b1.nEff) || st.samples || 0;
      const kbps = st.bps
        ? Math.round(st.bps / 1024) + " KB/s" + (nSamp ? ` (n=${Math.round(nSamp)})` : "")
        : "未用（本实例无下载样本）";
      const p = (nsMap && nsMap[k]) || {};
      // nsOf 已经算过 tput 分；没有就走本地评分，别拿延迟分冒充总评分
      const score = Number(p.tput) || costOf(k, "tput");
      const tip =
        `lat ${Math.round(Number(p.lat) || 0)}ms · tput ${Math.round(Number(p.tput) || 0)}ms` +
        ` · E10 ${Math.round(Number(p.e10) || 0)}ms · pFail ${Number(p.pFail) || 0}` +
        ` · pStall ${Number(p.pStall) || 0} · confB ${Number(p.confB) || 0}` +
        ` · nEff ${Number(p.nEff) || 0} · latN ${Number(p.latN) || 0} · ${p.gate || "ok"}`;
      return { k, cc: x.cc || "", ms: x.ms || 0, score, kbps, rate, tip };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, 10);
}

