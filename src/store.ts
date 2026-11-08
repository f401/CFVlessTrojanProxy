import { Meter } from "./do";
import { loadUsers } from "./proto";
import { cntDelta, spdSnapshot } from "./px";
import { S } from "./state";
import { enc } from "./util";

/* 存储与计量：KV/DO/加密/快照/统计缓存 */

/* ---------- 计量的全局帐本：Durable Object ----------
 * KV 的 read-modify-write 会丢更新，DO 是单实例串行，天然不丢。
 * 热路径只往 PEND 里加数（纯内存），攒够/到点才往 DO 送一批。
 * 没绑 METER 时自动退回原来的 KV 方案（env.METER 为空即可）。
 */
export const PEND_FLUSH_BYTES = 16 * 1024 * 1024;  // 大文件传输时别频繁打 DO：DO 调用会吃这条连接的 CPU

/**
 * 把一次连接的流量增量放进待推送缓冲（纯内存，热路径无阻塞）。
 * @param {string} id 用户 UUID
 * @param {number} up 上行字节
 * @param {number} down 下行字节
 * @param {boolean} [isNew] 是否为新连接（用于连接数统计）
 * @returns {void}
 */
export function pendAdd(id, up, down, isNew) {
  if (!id) return;
  const p = S.pend.get(id) || { up: 0, down: 0, conns: 0 };
  p.up += up || 0;
  p.down += down || 0;
  S.pendBytes += (up || 0) + (down || 0);
  if (isNew) p.conns += 1;
  if (S.pend.size > 500) S.pend.clear();
  S.pend.set(id, p);
}

/**
 * 合并推送：小而多的连接不逐条打 DO，先攒在 isolate 里，到点再一次性推。
 * @param {object} env Worker 环境
 * @param {number} [delay] 自定义延迟（毫秒），传 0 表示尽快
 * @returns {void}
 */
export function scheduleFlush(env: Env, delay) {
  if (S.tflush) return;
  const d = delay === undefined ? S.pendMs : delay;
  S.tflush = setTimeout(() => {
    S.tflush = null;
    pendFlush(env, true).catch(() => {});
  }, d);
}

/**
 * 把缓冲里的增量推给各用户的 Meter DO；失败自动回填并指数退避。
 * @param {object} env Worker 环境（需 env.METER 绑定）
 * @param {boolean} [force] 跳过节流立即发送
 * @returns {Promise<void>}
 */
export async function pendFlush(env: Env, force?: boolean): Promise<void> {
  if (!env || !env.METER || !S.pend.size) return;
  if (!force && Date.now() - S.pendAt < S.pendMs) return;
  S.pendAt = Date.now();
  const batch = [...S.pend.entries()];
  S.pend.clear();
  S.pendBytes = 0;
  let bad = 0;
  const cd = cntDelta();
  const today = new Date().toISOString().slice(0, 10);
  let attached = false;
  // 快照固定挂在主 uuid 的对象上：挂到"批次第一个"会挂到另一个用户，
  // 结果面板（读主 uuid）永远看不到更新。
  const primary = String(env.uuid || "").trim().toLowerCase();
  await Promise.all(
    batch.map(async ([id, d]) => {
      try {
        const stub = env.METER.get(env.METER.idFromName(id));
        const body = { ...d };
        const mine = !primary || String(id).toLowerCase() === primary;
        if (!attached && mine) {
          attached = true;
          body.c = { ...cd, d: today };        // 只挂一次，避免重复计
          body.spd = spdSnapshot();            // 节点快照：跨 isolate 可见
          body.e = S.errs.slice(-8);             // 错误也带上去：/logs 才能跨 isolate
        }
        const r = await stub.fetch("https://meter/add", {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error("do " + r.status);
        S.doCalls += 1;
        S.meterCache.delete(id);      // 刚推过增量，缓存立即失效，避免读数倒退
      } catch (e) {
        bad += 1;
        const cur = S.pend.get(id) || { up: 0, down: 0, conns: 0 };
        S.pend.set(id, { up: cur.up + d.up, down: cur.down + d.down, conns: cur.conns + d.conns });
      }
    })
  );
  // 自适应退避：失败了就把间隔翻倍（最多 60s），成功了慢慢降回 30s
  if (bad) S.pendMs = Math.min(S.pendMs * 2, 60000);
  else S.pendMs = Math.max(30000, Math.round(S.pendMs / 2));
}

export const METER_TTL = 15000;

/**
 * 读取某个用户在 Meter DO 里的全局累计。
 * 失败会重试一次；仍失败就返回上次成功读到的值（绝不返回 0，否则客户端会以为流量清零）。
 * @param {object} env Worker 环境
 * @param {string} id 用户 UUID
 * @returns {Promise<{up:number,down:number,conns:number,first?:number,ts?:number}|null>} 累计值
 */
export async function meterGet(env: Env, id) {
  if (!env || !env.METER || !id) return null;
  const hit = S.meterCache.get(id);
  if (hit && Date.now() - hit.t < METER_TTL) return hit.v;

  for (let i = 0; i < 2; i++) {
    try {
      const stub = env.METER.get(env.METER.idFromName(id));
      const r = await stub.fetch("https://meter/get");
      if (!r.ok) throw new Error("do " + r.status);
      const v = await r.json();
      if (S.meterCache.size > 500) S.meterCache.clear();
      S.meterCache.set(id, { v, t: Date.now() });
      return v;
    } catch (e) {
      if (i === 0) await new Promise((res) => setTimeout(res, 120));
    }
  }
  return hit ? hit.v : null;
}

export const USAGE_SNAP_KEY = "usage:snap";

/**
 * 读用量快照（KV）。用于 DO 被重置（比如重建脚本）后回填历史累计。
 * @param {object} env Worker 环境
 * @returns {Promise<{ts:number, users:Record<string,{up:number,down:number,conns:number}>}|null>} 快照
 */
export async function usageSnapGet(env: Env) {
  try {
    return (await kvGet<UsageSnap>(env, USAGE_SNAP_KEY)) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 把各用户当前的 DO 累计写成一份 KV 快照（cron 调用，1 次写/轮）。
 * @param {object} env Worker 环境
 * @returns {Promise<void>}
 */
export async function usageSnapWrite(env: Env) {
  if (!env.STATS || !env.METER) return;
  const prev = (await usageSnapGet(env)) || ({ users: {}, ts: 0 } as UsageSnap);
  // 灾备快照，2 小时一次足够（cron 是 30 分钟一轮，别每轮都写一遍）
  if (Date.now() - (prev.ts || 0) < 2 * 3600e3) return;
  const { list } = await loadUsers(env);
  const out = { ts: Date.now(), users: {} };
  for (const u of list) {
    const v = await meterGet(env, u.id);
    const old = (prev.users || {})[u.id];
    // 只增不减：DO 被重置（重建脚本）时不能把历史快照写回 0
    const up = Math.max((v && v.up) | 0, (old && old.up) | 0);
    const down = Math.max((v && v.down) | 0, (old && old.down) | 0);
    const conns = Math.max((v && v.conns) | 0, (old && old.conns) | 0);
    if (up || down || conns) {
      out.users[u.id] = { up, down, conns, first: (v && v.first) || (old && old.first) || 0 };
    }
  }
  if (!Object.keys(out.users).length) return;
  try {
    await kvSet(env, USAGE_SNAP_KEY, out, { expirationTtl: 86400 * 90 });
  } catch (e) {
    /* 额度耗尽：下次再写 */
  }
}


/**
 * 把 KV 快照里的历史累计写回 DO（只增不减），用于重建脚本后接续用量。
 * @param {object} env Worker 环境
 * @param {string} id 用户 UUID
 * @param {object} [snap] 已读到的 usage:snap；不传则现读
 * @returns {Promise<object|null>} 恢复后的累计值
 */
export async function restoreUsage(env: Env, id, snap?) {
  if (!env || !env.METER) return null;
  const s = snap || (await usageSnapGet(env));
  const u = s && s.users && s.users[id];
  if (!u) return null;
  try {
    const stub = env.METER.get(env.METER.idFromName(id));
    const r = await stub.fetch("https://meter/set", { method: "POST", body: JSON.stringify(u) });
    if (!r.ok) return null;
    const v = await r.json();
    S.meterCache.set(id, { v, t: Date.now() });
    return v;
  } catch (e) {
    return null;
  }
}

export const FLUSH_MIN_MS = 3600000;    // 1 小时（且累计 ≥2MB 才写）
export const FLUSH_DIRTY = 2 * 1024 * 1024;   // 脏字节门槛
export const FLUSH_MAX_MS = 7200000;    // 最迟 2 小时必落一次
export const FLUSH_GAP = 2700000;       // 全局闸门：45 分钟内已有别的 isolate 写过就不再写

/** snap 快照的内存缓存时长：读多写少，5 分钟足够（原来 60 秒 = 1440 读/天/isolate） */
export const SNAP_TTL = 300000;

/**
 * 累计一次连接的流量与连接数（同时写入本地表和待推送缓冲）。
 * @param {string} id 用户 UUID
 * @param {number} up 上行字节
 * @param {number} down 下行字节
 * @param {boolean} isNewConn 是否新连接
 * @returns {void}
 */
export function statBump(id, up, down, isNewConn) {
  if (!id) return;
  pendAdd(id, up, down, isNewConn);   // 全局帐本（DO）
  let s = S.stats.get(id);
  if (!s) {
    s = { up: 0, down: 0, conns: 0, first: Date.now(), last: Date.now() };
    S.stats.set(id, s);
  }
  s.up += up || 0;
  s.down += down || 0;
  S.snapBytes += (up || 0) + (down || 0);
  if (isNewConn) s.conns += 1;
  s.last = Date.now();
}


/**
 * KV 写入的唯一入口：记录写次数与最近一次写入结果（额度耗尽时 ok=false 并抛出）。
 * @param {KVNamespace} kv 命名空间
 * @param {string} key 键名
 * @param {any} val 值
 * @param {object} [opts] put 选项（如 expirationTtl）
 * @returns {Promise<void>}
 */

/* ---------- KV / DO 落盘加密 ----------
 * 存储里的所有内容（px 池子、用户表、统计快照、DO 计数）都用 AES-GCM 加密后落盘，
 * 密钥由 secret 绑定 kek 派生。没有 kek 时退化为明文（保证老部署还能跑）。
 * 读取兼容明文：解析失败当明文 JSON 处理，下次写入自动转成密文。
 */
export let AEK = null;
export function b64e(u8) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
export function b64d(str) {
  const bin = atob(str);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** 从 secret 绑定 kek 派生 AES-GCM 密钥（进程内缓存） */
export async function aesKey(env: Env) {
  if (AEK) return AEK;
  const raw = String((env && env.kek) || "");
  if (!raw) return null;
  const dig = await crypto.subtle.digest("SHA-256", enc.encode(raw));
  AEK = await crypto.subtle.importKey("raw", dig, "AES-GCM", false, ["encrypt", "decrypt"]);
  return AEK;
}

/** 对象 → 密文字符串（ENC1:iv:ct，均为 base64） */
export async function seal(env: Env, obj: unknown): Promise<string> {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj);
  const k = await aesKey(env);
  if (!k) return text;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, enc.encode(text)));
  return "ENC1:" + b64e(iv) + ":" + b64e(ct);
}

/** 密文 → 对象；明文（老数据）也能读 */
export async function unseal(env: Env, raw: unknown): Promise<any> {
  if (raw == null) return null;
  if (typeof raw !== "string") return raw;
  if (!raw.startsWith("ENC1:")) {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  const k = await aesKey(env);
  if (!k) return null;
  const parts = raw.split(":");
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64d(parts[1]) },
      k,
      b64d(parts[2])
    );
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (e) {
    return null;
  }
}

/** 读 KV 并解密 */
export async function kvGet<T = any>(env: Env, key: string): Promise<T | null> {
  if (!env || !env.STATS) return null;
  let raw = null;
  try { raw = await env.STATS.get(key); } catch (e) { return null; }
  return (await unseal(env, raw)) as T | null;
}

/** 加密后写 KV */
export async function kvSet(env: Env, key: string, obj: unknown, opts?: { expirationTtl?: number }): Promise<void> {
  return kvPut(env.STATS, key, await seal(env, obj), opts);
}

export async function kvPut(kv, key, val, opts) {
  // 10048 = 当日写额度耗尽。既然写不进去，10 分钟内别再试，
  // 免得每个连接都白跑一次 KV 调用并刷日志。
  // 注意：熔断期必须"抛错"而不是静默返回 —— 调用方（flushSnap 等）
  // 是靠 catch 判断写失败的，静默返回会让它以为写成功，直接把内存里的
  // 统计清空，配额耗尽期间的数据就真丢了。
  if (S.kvStat && S.kvStat.quota && Date.now() - (S.kvStat.quotaAt || 0) < 10 * 60000) {
    const e = new Error("kv quota breaker: " + key);
    (e as any).breaker = true;
    throw e;
  }
  S.kvw += 1;
  try {
    await kv.put(key, val, opts);
    S.kvStat = { ok: true, key, at: Date.now() };
  } catch (e) {
    // 10048 = 当日写入额度耗尽；此时所有改动只在内存里生效，必须让调用方知道
    const emsg = String((e && e.message) || e);
    S.kvStat = {
      ok: false, key, at: Date.now(), err: emsg.slice(0, 100),
      quota: /10048|quota|limit/i.test(emsg),
      quotaAt: Date.now(),
    };
    throw e;
  }
}

/**
 * 把统计 / RTT / 错误日志合并写入 KV 的 snap 快照。
 * @param {object} env Worker 环境
 * @param {boolean} [force] 由 cron 调用时强制写；请求路径只在攒够 2MB 时写
 * @returns {Promise<void>}
 */
export async function flushSnap(env: Env, force?: boolean): Promise<void> {
  const kv = env.STATS;
  if (!kv) return;
  const hasData = S.stats.size > 0 || S.rtt.size > 0 || S.errs.length > 0;
  if (!hasData) return;

  const now = Date.now();
  const since = now - (S.snapWritten || 0);
  // 关键：按"时间"节流，而不是按"脏字节"。
  // 以前 snapBytes >= 2MB 就写 —— 一天 12 GB 流量 = 6000 次写，直接把
  // 免费额度（1000/天）打爆。
  const due = !!force || (S.snapBytes >= FLUSH_DIRTY && since >= FLUSH_MIN_MS) || since >= FLUSH_MAX_MS;
  if (!due) return;

  // 第二个闸门是"全局"的：每个 isolate 各写各的会让写次数随实例数线性增长
  // （实测 8 个 isolate × 24 次/天 = 192 次）。快照本身就是合并写入，
  // 45 分钟内别人写过就跳过，自己的增量留在内存里下一轮合并，一条不丢。
  // 这里必须 fresh：缓存里的 ts 可能已经过时 5 分钟，会误判"该写了"。
  const prev = await getSnap(env, true);
  if (now - (prev.ts || 0) < FLUSH_GAP) return;

  const day = new Date().toISOString().slice(0, 10);
  const next = {
    v: 1,
    ts: now,
    date: day,
    stats: prev.date === day ? { ...(prev.stats || {}) } : {},   // 跨天重置
    rtt: { ...(prev.rtt || {}) },
    errs: (prev.errs || []).slice(-50),
  };

  for (const [id, s] of S.stats) {
    const p = next.stats[id] || { up: 0, down: 0, conns: 0, first: s.first, last: s.last };
    next.stats[id] = {
      up: (p.up || 0) + (s.up || 0),
      down: (p.down || 0) + (s.down || 0),
      conns: (p.conns || 0) + (s.conns || 0),
      first: Math.min(p.first || s.first || now, s.first || now),
      last: Math.max(p.last || 0, s.last || 0),
    };
  }

  for (const [id, bucket] of S.rtt) {
    const tgt = next.rtt[id] || {};
    for (const [tag, v] of Object.entries(bucket) as [string, RttEntry][]) {
      const p = tgt[tag];
      tgt[tag] = p
        ? {
            rtt: v.rtt ? Math.round((p.rtt || v.rtt) * 0.7 + v.rtt * 0.3) : p.rtt || 0,
            colo: v.colo || p.colo,
            bw: v.bw || p.bw,
            hits: (p.hits || 0) + (v.hits || 0),
            ok: (p.ok || 0) + (v.ok || 0),
            fail: (p.fail || 0) + (v.fail || 0),
            ts: v.ts || p.ts,
          }
        : { ...v, ok: v.ok || 0, fail: v.fail || 0 };
    }
    next.rtt[id] = tgt;
  }

  if (S.errs.length) next.errs = next.errs.concat(S.errs).slice(-50);

  try {
    await kvSet(env, "snap", next, { expirationTtl: 86400 * 30 });
    S.snapCache = { v: next, t: Date.now() };
    S.snapWritten = now;
    S.snapBytes = 0;
    S.stats.clear();
    S.rtt.clear();
    S.errs.length = 0;
  } catch (e) {
    /* 额度耗尽：保持内存，下次再试 */
  }
}

/* ---------- 统一快照：stats + rtt + errs 合成一个 KV key，一次写 ---------- */

/**
 * 读取 snap 快照（5 分钟内存缓存）。
 * @param {object} env Worker 环境
 * @param {boolean} [fresh] 跳过缓存（写之前判断"全局闸门"必须拿最新时间戳）
 * @returns {Promise<object>} 快照对象，读不到返回空对象
 */
export async function getSnap(env: Env, fresh?: boolean) {
  if (!fresh && S.snapCache.v && Date.now() - S.snapCache.t < SNAP_TTL) return S.snapCache.v;
  let v = null;
  try {
    v = (await kvGet<SnapDoc>(env, "snap")) || null;
  } catch (e) {
    v = null;
  }
  const out = v || { v: 1, date: "", stats: {}, rtt: {}, errs: [] };
  S.snapCache = { v: out, t: Date.now() };
  return out;
}


/**
 * 带 60 秒缓存的用量读取。
 * @param {object} env Worker 环境
 * @param {string} id 用户 UUID
 * @returns {Promise<object>} 用量对象
 */
export async function readStatsCached(env: Env, id) {
  const hit = S.statCache.get(id);
  if (hit && Date.now() - hit.t < 60000) return hit.v;
  const v = await readStats(env, id);
  S.statCache.set(id, { v, t: Date.now() });
  if (S.statCache.size > 200) S.statCache.clear();
  return v;
}

/**
 * 读取用户用量：优先 Meter DO（全局唯一帐本），未绑定时回退 KV 快照。
 * @param {object} env Worker 环境
 * @param {string} id 用户 UUID
 * @returns {Promise<{up:number,down:number,conns:number,backend:string}>} 含 backend 标记数据来源
 */
export async function readStats(env: Env, id) {
  const local = S.stats.get(id) || { up: 0, down: 0, conns: 0, first: 0, last: 0 };
  const p = S.pend.get(id) || { up: 0, down: 0, conns: 0 };

  // 首选：Meter DO（全网络唯一帐本，不存在丢更新）
  let doTotal = await meterGet(env, id);

  // DO 被重置过（重建脚本会把命名空间一起删掉）→ 用 KV 快照回填一次
  if (doTotal && !(doTotal.up || doTotal.down || doTotal.conns)) {
    const snap = await usageSnapGet(env);
    const s = snap && snap.users && snap.users[id];
    if (s) {
      try {
        const stub = env.METER.get(env.METER.idFromName(id));
        const r = await stub.fetch("https://meter/seed", { method: "POST", body: JSON.stringify(s) });
        if (r.ok) {
          doTotal = await r.json();
          S.meterCache.set(id, { v: doTotal, t: Date.now() });
        }
      } catch (e) {}
    }
  }

  if (doTotal) {
    return {
      id,
      up: (doTotal.up || 0) + p.up,
      down: (doTotal.down || 0) + p.down,
      conns: (doTotal.conns || 0) + p.conns,
      // 当日量 = DO 里的当日累计 + 还没推上去的增量
      todayUp: (doTotal.dU || 0) + p.up,
      todayDown: (doTotal.dD || 0) + p.down,
      firstSeen: doTotal.first || local.first || null,
      lastSeen: Math.max(doTotal.ts || 0, local.last) || null,
      isolateLocal: { up: local.up, down: local.down, conns: local.conns },
      backend: "do",
      persisted: true,
    };
  }

  // 回退：KV 快照（没绑 METER 时）
  let stored = null;
  if (env.STATS) {
    try {
      const snap = await getSnap(env);
      stored = (snap.stats || {})[id] || null;
    } catch (e) {
      stored = null;
    }
  }
  const base = stored || { up: 0, down: 0, conns: 0, first: 0, last: 0 };
  return {
    id,
    up: (base.up || 0) + local.up,
    down: (base.down || 0) + local.down,
    conns: (base.conns || 0) + local.conns,
    // 没绑 DO 时，快照本身就是"当日"口径（flushSnap 跨天会重置）
    todayUp: (base.up || 0) + local.up,
    todayDown: (base.down || 0) + local.down,
    firstSeen: base.first || local.first || null,
    lastSeen: Math.max(base.last || 0, local.last) || null,
    isolateLocal: { up: local.up, down: local.down, conns: local.conns },
    backend: "kv",
    persisted: !!stored,
  };
}

/* ==================================================================
 * §6.2  proxyip 代理池（探测 / 轮换 / Cron）
 *   env.proxyip = "auto"  → 自动模式
 *   env.proxyip = "h:p"   → 手动模式（原行为）
 *   env.proxyip = ""      → 关闭
 * ================================================================== */

// 预置的 TLS 1.2 ClientHello（SNI = 本项目域名），用于探测候选反代
