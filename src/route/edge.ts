// 入口偏好：本 isolate 实测「客户端 → CF 边缘」的优选 IP，按质量排序后进订阅。
// 与 docs/评分机制_final.md 的节点评分无关（那是 CF → 目标），这里量的是用户 → 边缘。
import { S } from "../core/state";
import { kvGet, kvSet } from "../store/kv";
import { probeTls } from "./probe";

// CF anycast 各网段的种子入口（每段 1 个，覆盖不同前缀）
export const EDGE_SEED: string[] = [
  "104.16.0.1",
  "104.17.0.1",
  "104.18.0.1",
  "104.19.0.1",
  "104.20.0.1",
  "104.21.0.1",
  "104.22.0.1",
  "104.23.0.1",
  "104.24.0.1",
  "104.25.0.1",
  "104.26.0.1",
  "104.27.0.1",
  "162.158.0.1",
  "162.159.0.1",
  "172.64.0.1",
  "172.65.0.1",
  "172.66.0.1",
  "172.67.0.1",
  "188.114.96.1",
  "188.114.97.1",
  "197.234.240.1",
  "198.41.128.1",
  "173.245.48.1",
  "103.21.244.1",
  "141.101.64.1",
  "108.162.192.1",
  "190.93.240.1",
  "131.0.72.1",
];

const PREF_KEY = "edge:pref";
const TTL = 6 * 3600_000;
const LOAD_MS = 5 * 60_000;
const WRITE_GAP = 90 * 60_000;
const PER_SCAN = 2;

export function edgeAdd(ip: string, ms: number, ok: boolean): void {
  const now = Date.now();
  const e = S.edge.get(ip);
  if (!e) {
    S.edge.set(ip, { h: ip, p: 443, ms, ok: ok ? 1 : 0, fail: ok ? 0 : 1, at: now });
  } else {
    if (ok) {
      e.ms = Math.round(e.ms * 0.6 + ms * 0.4);
      e.ok++;
    } else {
      e.fail++;
    }
    e.at = now;
  }
  S.edgeDirty = true;
}

/** 排序后的入口 IP（只保留最近 6 小时内实测过、成功率过半的） */
export function edgeRank(max = 5): string[] {
  const now = Date.now();
  const rows = [];
  for (const e of S.edge.values()) {
    const n = e.ok + e.fail;
    if (!e.ok || now - e.at > TTL) continue;
    if (n > 0 && e.fail / n > 0.5) continue;
    rows.push({ ip: e.h, cost: e.ms + (400 * e.fail) / (n + 2), ok: e.ok });
  }
  rows.sort((a, b) => a.cost - b.cost || b.ok - a.ok);
  return rows.slice(0, max).map((r) => r.ip);
}

export async function edgeLoad(env: Env, force = false): Promise<void> {
  const now = Date.now();
  if (!force && S.edgeAt && now - S.edgeAt < LOAD_MS) return;
  S.edgeAt = now;
  const raw = await kvGet(env, PREF_KEY);
  if (typeof raw !== "string" || !raw) return;
  try {
    const list = JSON.parse(raw) as { h: string; ms: number; ok: number; fail: number; at: number }[];
    for (const r of list) {
      if (!r || typeof r.h !== "string") continue;
      S.edge.set(r.h, { h: r.h, p: 443, ms: Number(r.ms) || 0, ok: Number(r.ok) || 0, fail: Number(r.fail) || 0, at: Number(r.at) || 0 });
    }
  } catch {
    S.edgeDirty = true;
  }
}

export async function edgeFlush(env: Env, force = false): Promise<void> {
  const now = Date.now();
  if (!S.edgeDirty) return;
  if (!force && S.edgeWrittenAt && now - S.edgeWrittenAt < WRITE_GAP) return;
  const rows = [...S.edge.values()].sort((a, b) => b.at - a.at).slice(0, 16);
  if (!rows.length) return;
  await kvSet(env, PREF_KEY, JSON.stringify(rows));
  S.edgeWrittenAt = now;
  S.edgeDirty = false;
}

/** cron 每轮探 ≤2 个入口（未测过优先，其次最久未测），对自家域名 /health 做 TLS + GET */
export async function edgeScan(env: Env): Promise<number> {
  const site = S.site;
  if (!site) return 0;
  await edgeLoad(env);
  const now = Date.now();
  const pending = EDGE_SEED.filter((ip) => {
    const e = S.edge.get(ip);
    return !e || now - e.at > TTL;
  });
  pending.sort((a, b) => (S.edge.get(a)?.at || 0) - (S.edge.get(b)?.at || 0));
  let n = 0;
  for (const ip of pending.slice(0, PER_SCAN)) {
    const r = await probeTls(site, "/health", ip + ":443");
    edgeAdd(ip, r.hsMs || r.ms, r.ok);
    n++;
  }
  if (n) await edgeFlush(env);
  return n;
}

/** 订阅里的入口条目：实测优先，没测到就回落到默认端口表 */
export function edgeNodes(max = 5): { host: string; port: number; tls: boolean; name: string }[] {
  return edgeRank(max).map((ip) => ({ host: ip, port: 443, tls: true, name: "edge" }));
}
