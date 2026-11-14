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

/** 最近一次入口探测失败原因（供 /debug?edge=1 观察；空串=没失败过） */
export const EDGE_ERR = { s: "" };

/**
 * 功能：记录一次入口 IP 的探测结果（失败原因留在 EDGE_ERR 供 /health 展示）。
 * @param ip 入口 IP
 * @param ms 首字节毫秒（失败时为 0 或超时值）
 * @param ok 是否可用
 * @param err 失败原因（可选）
 * @returns 无
 */
export function edgeAdd(ip: string, ms: number, ok: boolean, err = ""): void {
  // 失败原因只留最近一条（给 /health 的 edge.err 看）；截断是防止整段异常堆栈被写进 KV
  if (!ok && err) EDGE_ERR.s = err.slice(0, 80);
  const now = Date.now();
  const e = S.edge.get(ip);
  if (!e) {
    S.edge.set(ip, { h: ip, p: 443, ms, ok: ok ? 1 : 0, fail: ok ? 0 : 1, at: now });
  } else {
    // 成功用 0.6/0.4 的指数平滑：单次抖动不该把排名甩出去；失败只累加计数，交给 edgeRank 按成功率淘汰
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
  // 过滤：必须成功过、TTL 内测过、失败率 ≤50%。宁可少给几个入口，也别把坏 IP 塞进订阅
  for (const e of S.edge.values()) {
    const n = e.ok + e.fail;
    if (!e.ok || now - e.at > TTL) continue;
    if (n > 0 && e.fail / n > 0.5) continue;
    // cost = 握手耗时 + 失败惩罚；分母 +2 相当于先验（1 次失败不至于判死），同分时成功次数多的优先
    rows.push({ ip: e.h, cost: e.ms + (400 * e.fail) / (n + 2), ok: e.ok });
  }
  rows.sort((a, b) => a.cost - b.cost || b.ok - a.ok);
  return rows.slice(0, max).map((r) => r.ip);
}

/**
 * 功能：从 KV 载入入口偏好（默认 5 分钟节流，force 可跳过）。
 * @param env 环境变量
 * @param force 强制重载
 * @returns 无
 */
export async function edgeLoad(env: Env, force = false): Promise<void> {
  const now = Date.now();
  // 5 分钟节流：订阅渲染和 cron 都会调它，不能每次都读 KV
  if (!force && S.edgeAt && now - S.edgeAt < LOAD_MS) return;
  S.edgeAt = now;
  const raw = await kvGet(env, PREF_KEY);
  // 没写过就当空表；解析失败也当空表——宁可重测一遍，也不能因为一条脏数据让订阅 500
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

/**
 * 功能：把入口偏好写回 KV（没有变化就不写，避免白白消耗写额度）。
 * @param env 环境变量
 * @param force 强制写入
 * @returns 无
 */
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
export async function edgeScan(env: Env, budget = PER_SCAN): Promise<number> {
  const site = S.site;
  if (!site) return 0;
  // 预算可能被 cron 分账压到 0（EDGE_AUTO=0 时恒为 0）：直接返回，别白烧一次握手
  const lim = Math.max(0, Math.min(PER_SCAN, budget));
  if (!lim) return 0;
  await edgeLoad(env);
  const now = Date.now();
  // 待测 = 从没测过 + 超过 TTL 的；排序让最久没测的先上，避免每轮都测同一批
  const pending = EDGE_SEED.filter((ip) => {
    const e = S.edge.get(ip);
    return !e || now - e.at > TTL;
  });
  pending.sort((a, b) => (S.edge.get(a)?.at || 0) - (S.edge.get(b)?.at || 0));
  let n = 0;
  // 逐个真握手：探的是「(入口 IP:443, SNI=自家域名)」，成功与否都记一笔，最后落 KV 给订阅用
  for (const ip of pending.slice(0, lim)) {
    const r = await probeTls(site, "/health", ip + ":443");
    edgeAdd(ip, r.hsMs || r.ms, r.ok, r.err);
    n++;
  }
  if (n) await edgeFlush(env);
  return n;
}

/** 订阅里的入口条目：实测优先，没测到就回落到默认端口表 */
export function edgeNodes(max = 5): { host: string; port: number; tls: boolean; name: string }[] {
  return edgeRank(max).map((ip) => ({ host: ip, port: 443, tls: true, name: "edge" }));
}

