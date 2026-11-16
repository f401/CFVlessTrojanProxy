import { S } from "./state";
import { pcts } from "./hist";

/** 每个节点的紧凑快照（供 Meter DO 跨 isolate 展示） */
export function spdSnapshot() {
  const out: Record<string, NodeSnap> = {};
  // 按累计下行挑前 16 个：真正在跑的大流量节点经常不在 Map 的前 16 位
  const rows = [...S.nstat.entries()]
    .filter(([k, s]) => S.alive.has(k) && ((s.trafficOkW || 0) + (s.trafficFailW || 0) > 0 || (s.bytesDown || 0) > 0))
    .sort((a, b) => (b[1].bytesDown || 0) - (a[1].bytesDown || 0))
    .slice(0, 16);
  for (const [k, s] of rows) {
    const n = (s.trafficOkW || 0) + (s.trafficFailW || 0);
    const q = pcts(s);
    out[k] = {
      med: Math.round(q.p50 || 0),
      p90: Math.round(q.p90 || 0),
      cap: Math.round(q.cap || 0),
      n: Math.round(n),
      ts: Math.round(s.trafficOkW || 0),
      tf: Math.round(s.trafficFailW || 0),
      at: s.at || 0,
    };
  }
  return out;
}

