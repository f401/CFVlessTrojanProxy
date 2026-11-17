/**
 * 入口 RTT 学习：按用户记「入口标签 → RTT / 机房 / 带宽 / 成败」，供订阅里的入口排序使用。
 *
 * 状态在 `S.rtt`（本 isolate 内存）与 KV 快照里，这里只做读写与淘汰，所以按约定不配类 ——
 * 没有独占的跨请求可变状态，做成类只会多一层转发（见 AGENTS.md「类」那一节）。
 */
import { RTT_MAX } from "../core/const";
import { S } from "../core/state";
import { getSnap, kvGetStrict } from "../store/index";

/** 控制每个用户的入口标签数：?ip= 是用户可传的，不设上限能把 snap 写成超大 KV 值 */
function trimRtt(bucket: Record<string, RttEntry>) {
  const keys = Object.keys(bucket);
  if (keys.length <= RTT_MAX) return;
  keys.sort((a, b) => (bucket[a].ts || 0) - (bucket[b].ts || 0));
  for (let i = 0; i < keys.length - RTT_MAX; i++) delete bucket[keys[i]];
}

/**
 * 记录某个入口的一次成功/失败（用于 RTT 学习）。
 * @param {string} id 用户 UUID
 * @param {string} tag 入口标签
 * @param {boolean} ok 是否成功
 * @returns {void}
 */
export function rttMark(id: string | null, tag: string | null, ok: boolean) {
  if (!id || !tag) return;
  // 每个用户一张「入口标签 → 计数」小表，第一次见到这个用户才建
  let bucket = S.rtt.get(id);
  if (!bucket) {
    bucket = Object.create(null) as Record<string, RttEntry>; // 防 ?ip=__proto__ 污染原型
    S.rtt.set(id, bucket);
  }
  // 新标签建空记录；ts 供 trimRtt 按时间淘汰，ok/fail 是这台入口的成败计数
  const e = bucket[tag] || { rtt: 0, colo: "", bw: 0, hits: 0, ok: 0, fail: 0, ts: Date.now() };
  if (ok) e.ok = (e.ok || 0) + 1;
  else e.fail = (e.fail || 0) + 1;
  e.ts = Date.now();
  // 单用户标签数有上限：?ip= 是用户可传的，不裁剪会被灌爆内存
  bucket[tag] = e;
  trimRtt(bucket);
}

/**
 * 从 request.cf 里学习本次请求的机房与网络质量，写入 RTT 表。
 * @param {object} cf request.cf 对象
 * @param {string} tag 入口标签
 * @param {string} id 用户 UUID
 * @returns {void}
 */
export function rttLearn(cf: CfMeta | null, tag: string | null, id: string | null) {
  if (!cf || !tag || !id) return;
  const rtt = cf.clientTcpRtt;
  if (typeof rtt !== "number" || rtt <= 0) return;

  // 按 UUID 记录：自用场景下最准，也不会和别人的统计互相污染
  const key = id;
  let bucket = S.rtt.get(key);
  if (!bucket) {
    bucket = Object.create(null) as Record<string, RttEntry>;
    S.rtt.set(key, bucket);
  }

  const cur = bucket[tag];
  const bw = (cf.edgeL4 && cf.edgeL4.deliveryRate) || 0;

  if (cur) {
    // 老 KV 里的条目可能缺 hits/rtt（早期版本没有这两个字段），别让 EWMA 变成 NaN
    const base = typeof cur.rtt === "number" && cur.rtt > 0 ? cur.rtt : rtt;
    cur.rtt = Math.round(base * 0.7 + rtt * 0.3); // EWMA，抗抖动
    cur.hits = (cur.hits || 0) + 1;
    cur.ts = Date.now();
    if (cf.colo) cur.colo = cf.colo;
    if (bw) cur.bw = bw;
  } else {
    bucket[tag] = { rtt, colo: cf.colo || "", bw, hits: 1, ts: Date.now() };
  }
  trimRtt(bucket);
}

/**
 * 读取某用户的 RTT 学习结果（内存优先，其次 KV 快照）。
 * @param {object} env Worker 环境
 * @param {string} id 用户 UUID
 * @returns {Promise<object>} 入口标签 → RTT 信息
 */
export async function loadRtt(env: Env, id: string) {
  if (!id) return {};
  const mem = S.rtt.get(id) || {};
  if (!env.STATS) return mem;
  try {
    const snap = await getSnap(env);
    let stored: Record<string, RttEntry> = ((snap.rtt || {}) as Record<string, Record<string, RttEntry>>)[id] || {};
    if (!Object.keys(stored).length && (S.rttMiss.get(id) || 0) < Date.now()) {
      // 老键 rtt:<id> 只用于迁移；不存在时记住 10 分钟，避免每次刷订阅都打一次 KV。
      // 必须严格读：`kvGet` 会把 KV 异常吞成 null，于是「读不到」被记成「没有旧键」，
      // 给这个用户压上 10 分钟的 rttMiss —— KV 恢复了也拿不到学到的延迟（v7.206）。
      stored = (await kvGetStrict<Record<string, RttEntry>>(env, `rtt:${id}`)) || {};
      if (Object.keys(stored).length) S.rttMiss.delete(id);
      else {
        if (S.rttMiss.size > 500) S.rttMiss.clear();
        S.rttMiss.set(id, Date.now() + 10 * 60000);
      }
    }
    const out = { ...stored, ...mem };
    const keys = Object.keys(out);
    if (keys.length > RTT_MAX) {
      keys.sort((a, b) => (out[a].ts || 0) - (out[b].ts || 0));
      for (let i = 0; i < keys.length - RTT_MAX; i++) delete out[keys[i]];
    }
    return out;
  } catch (e) {
    return mem;
  }
}
