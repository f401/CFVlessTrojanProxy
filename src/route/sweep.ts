// 以 IP 为单位扫「目标站 IP × 节点 IP」的判定：目标 IP 用 DoH 解析（最多 2 个），
// 节点取池子里活着的（最多 2 个），每个组合各探一次，写进 vtab。
import { S } from "../core/state";
import { resolveV4All } from "../proxy/dial";
import { probeTls } from "./probe";
import { DIRECT } from "./channel";
import { recordProbe } from "./observe";

export interface SweepRow {
  t: string;
  n: string;
  code: number;
  ms: number;
  hsMs: number;
  server: string;
  head: string;
  err: string;
}

const codeOf = (status: string): number => {
  const m = status.match(/^HTTP\/1\.[01] (\d{3})/);
  return m ? Number(m[1]) : 0;
};

export async function sweepHost(
  host: string,
  maxIp = 2,
  maxNode = 2,
): Promise<{ ips: string[]; nodes: string[]; rows: SweepRow[] }> {
  const ips = (await resolveV4All(host)).slice(0, maxIp);
  const nodes: string[] = [];
  for (const k of S.alive.keys()) {
    if (nodes.length >= maxNode) break;
    if (k.startsWith(host)) continue;
    nodes.push(k);
  }
  const rows: SweepRow[] = [];
  for (const ip of ips) {
    const r = await probeTls(host, "/", ip + ":443");
    const c = codeOf(r.status);
    recordProbe({ target: ip, chan: DIRECT, code: c, ms: r.ms });
    rows.push({ t: ip, n: "", code: c, ms: r.ms, hsMs: r.hsMs, server: r.server, head: r.head, err: r.err });
    for (const n of nodes) {
      const r2 = await probeTls(host, "/", n);
      const c2 = codeOf(r2.status);
      // 中继自己解析目标，我们无法钉死它连到哪一个 A 记录 → 记成节点级（*|node）
      recordProbe({ target: "*", chan: { kind: "r", ip: n.slice(0, n.lastIndexOf(":")) }, code: c2, ms: r2.ms });
      rows.push({ t: ip, n, code: c2, ms: r2.ms, hsMs: r2.hsMs, server: r2.server, head: r2.head, err: r2.err });
    }
  }
  return { ips, nodes, rows };
}
