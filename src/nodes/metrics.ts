import { SC } from "../core/const";
import { candsFor, costOf, isBlack, isFrozen } from "./score";
import { S } from "../core/state";
import { TEN_MB } from "./score";
import { getSnap, kvGet } from "../store/index";

/* metrics */

/** 错误日志去重表：msg|tag → 上次记录时间（5 秒窗口） */
export const ERR_SEEN = new Map<string, number>();

/**
 * 记录某个入口的一次成功/失败（用于 RTT 学习）。
 * @param {string} id 用户 UUID
 * @param {string} tag 入口标签
 * @param {boolean} ok 是否成功
 * @returns {void}
 */
export function rttMark(id: string | null, tag: string | null, ok: boolean) {
  if (!id || !tag) return;
  let bucket = S.rtt.get(id);
  if (!bucket) {
    bucket = {};
    S.rtt.set(id, bucket);
  }
  const e = bucket[tag] || { rtt: 0, colo: "", bw: 0, hits: 0, ok: 0, fail: 0, ts: Date.now() };
  if (ok) e.ok = (e.ok || 0) + 1;
  else e.fail = (e.fail || 0) + 1;
  e.ts = Date.now();
  bucket[tag] = e;
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
    bucket = {};
    S.rtt.set(key, bucket);
  }

  const cur = bucket[tag];
  const bw = (cf.edgeL4 && cf.edgeL4.deliveryRate) || 0;

  if (cur) {
    cur.rtt = Math.round(cur.rtt * 0.7 + rtt * 0.3); // EWMA，抗抖动
    cur.hits += 1;
    cur.ts = Date.now();
    if (cf.colo) cur.colo = cf.colo;
    if (bw) cur.bw = bw;
  } else {
    bucket[tag] = { rtt, colo: cf.colo || "", bw, hits: 1, ts: Date.now() };
  }
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
    if (!Object.keys(stored).length) {
      stored = (await kvGet<Record<string, RttEntry>>(env, `rtt:${id}`)) || {};
    }
    return { ...stored, ...mem };
  } catch (e) {
    return mem;
  }
}


/**
 * 域名 → 站点族。
 * 目的：x.com / api.x.com / pbs.twimg.com 共享一份样本，否则每个域名
 * 各自只有一两条样本，永远学不出来。少数大厂手工归并，其余按可注册域。
 * @param {string} host 目标域名
 * @returns {string} 族名
 */
export function hostKey(host: string): string {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!h) return "";
  if (/^[\d.]+$/.test(h) || h.includes(":")) return h;   // IP 字面量原样

  // 手工归并（同一套基础设施，物理路径通常一致）
  if (/(^|\.)(x|twitter)\.com$|(^|\.)twimg\.com$/.test(h)) return "x.com";
  if (/(^|\.)(google|youtube|ytimg|googlevideo|gstatic|googleapis|ggpht)\.com$/.test(h)) return "google.com";
  if (/(^|\.)(facebook|instagram|fbcdn|cdninstagram)\.(com|net)$/.test(h)) return "meta.com";
  if (/(^|\.)(github|githubusercontent|githubassets)\.com$/.test(h)) return "github.com";
  if (/(^|\.)(cloudflare|cloudflareinsights|cfimages)\.com$/.test(h)) return "cloudflare.com";
  if (/(^|\.)(openai|oaistatic|oaiusercontent)\.com$/.test(h)) return "openai.com";

  const p = h.split(".");
  if (p.length <= 2) return h;
  // 形如 example.co.uk / xxx.com.cn 的，保留三段
  if (/^(co|com|net|org|gov|edu|ac|ne|or)\.(uk|cn|jp|kr|tw|hk|sg|au|nz|br|in|za|mx|tr)$/.test(p.slice(-2).join("."))) {
    return p.slice(-3).join(".");
  }
  return p.slice(-2).join(".");
}

/**
 * 站点样本的分数（毫秒当量，越小越好）。
 * 纯算术，不调 costOf —— 稳态下 8 个节点加起来不到 1µs。
 * @param {object} s HNStat
 * @param {number} now 当前时间
 * @returns {number} 分数
 */
/**
 * 站点画像打分。返回 -1 表示"这个模式没有站点级样本"，调用方回退全局分。
 *   lat  → 首字节 + 失败风险
 *   tput → 站点级 10MB 估算 + 0.5×首字节 + 失败风险（没有吞吐样本就不要拿 TTFB 冒充）
 */
export function hostScore(s: HNStat, mode: Mode, now: number): number {
  const fail = (s.bad + 1) / (s.n + 6);            // 小样本往坏里估
  const stale = now - (s.at || 0) > 6 * 3600e3 ? 300 : 0;   // 6 小时没更新就降权
  const ttfb = s.ttfb > 0 ? s.ttfb : 800;
  if (mode === "tput") {
    const bpsAge = now - (s.bpsAt || 0);
    if (!(s.bpsN && s.bps && s.bps > 0) || bpsAge > SC.SAMPLE_TTL) return -1;
    return (TEN_MB / s.bps) * 1000 + 0.5 * ttfb + fail * 4000 + stale;
  }
  return ttfb + fail * 4000 + (s.n < 2 ? 150 : 0) + stale;
}

/**
 * 某个站点上的节点排行（跳过黑名单/冻结），30 秒缓存。
 * @param {string} host 目标域名（内部转成族）
 * @param {string} mode "lat" | "tput"
 * @returns {Array<{k:string,v:number}>} 升序
 */
export function hostRank(host: string, mode: Mode) {
  const fam = hostKey(host);
  if (!fam) return [];
  const mkey = fam + "|" + (mode === "lat" ? "lat" : "tput");
  const now = Date.now();
  const hit = S.hostRankCache.get(mkey);
  if (hit && now - hit.t < 30000) return hit.v;

  const m = S.hostNode.get(fam);
  const out: RankRow[] = [];
  if (m) {
    for (const [k, s] of m) {
      if (!S.alive.has(k) || isBlack(k) || isFrozen(k)) continue;
      const hs = hostScore(s, mode, now);
      // 站点级没有该模式的样本：回退全局同模式分数，别用另一种模式冒充
      out.push({ k, v: hs >= 0 ? hs : costOf(k, mode) });
    }
  }
  // 只有样本少于 2 个时才把"没试过的节点"按全局分补进来（冷启动用）
  if (out.length < 2) {
    for (const r of candsFor(mode)) {
      if (m && m.has(r.k)) continue;
      out.push({ k: r.k, v: r.v + 300 });
    }
  }
  out.sort((a, b) => a.v - b.v);
  if (S.hostRankCache.size > 80) S.hostRankCache.clear();
  S.hostRankCache.set(mkey, { t: now, v: out });
  return out;
}

/**
 * 这个站还没试过、且全局分最好的节点（冷启动用）。
 * @param {string} host 目标域名
 * @param {string} mode 模式
 * @returns {string} 节点 key，没有返回 ""
 */
export function hostUntried(host: string, mode: Mode) {
  const m = S.hostNode.get(hostKey(host));
  // 直接用全局排行（20 秒缓存）：它就是按 costOf 升序排好的，
  // 取第一个没在这个站试过的即可。以前这里对每个节点现算 costOf，
  // 200 个候选时单次 pick 要 1 ms，全花在重复计算上。
  for (const r of candsFor(mode)) {
    if (!m || !m.has(r.k)) return r.k;
  }
  return "";
}

/**
 * 记录一条错误日志（只保留最近 50 条，同时打到 console）。
 * @param {string} msg 错误信息
 * @param {string} [tag] 关联标签（域名或入口）
 * @returns {void}
 */
export function logErr(msg: unknown, tag?: string | null) {
  const m = String(msg).slice(0, 200);
  // 同一个错误 5 秒内只记一次：节点大面积抖动时，每条连接都刷一行
  // console.error 既费 CPU 又把真正有用的日志冲掉（面板也只留 50 条）。
  const now0 = Date.now();
  const key = tag ? m + "|" + tag : m;
  const last = ERR_SEEN.get(key) || 0;
  if (now0 - last < 5000) return;
  if (ERR_SEEN.size > 200) ERR_SEEN.clear();
  ERR_SEEN.set(key, now0);

  try {
    S.errs.push({ t: now0, m, tag: tag || "" });
    while (S.errs.length > 50) S.errs.shift();
  } catch (e) {}
  try {
    console.error("[err]", msg);
  } catch (e) {}
}

/* ==================================================================
 * 按站点的节点画像（诊断：某个站到底该用哪个节点 / 为什么被拦）
 * ================================================================== */

export const HN_MAX_HOSTS = 120;   // 最多记 120 个域名
export const HN_MAX_NODES = 12;    // 每个域名最多记 12 个节点

/**
 * 记一次 (站点, 节点) 的连接结果。
 * @param {string} host 目标域名
 * @param {string} node "host:port" 节点
 * @param {{ok:boolean, bad:boolean, bytes:number, ttfb:number}} o 本次结果
 * @returns {void}
 */
export function hostNodeMark(host: string, node: string, o: Partial<HNStat>) {
  if (!host || !node) return;
  const fam = hostKey(host);
  if (!fam) return;
  let m = S.hostNode.get(fam);
  if (!m) {
    if (S.hostNode.size >= HN_MAX_HOSTS) {
      // 淘汰最久没更新过的域名（120 条，线性扫可接受）
      let oldK = "", oldT = Infinity;
      for (const [k, v] of S.hostNode) {
        let t = 0;
        for (const s of v.values()) if (s.at > t) t = s.at;
        if (t < oldT) { oldT = t; oldK = k; }
      }
      if (oldK) S.hostNode.delete(oldK);
    }
    m = new Map<string, HNStat>();
    S.hostNode.set(fam, m);
  }
  let s = m.get(node);
  if (!s) {
    if (m.size >= HN_MAX_NODES) {
      let oldN = "", oldT = Infinity;
      for (const [k, v] of m) if (v.at < oldT) { oldT = v.at; oldN = k; }
      if (oldN) m.delete(oldN);
    }
    s = { n: 0, ok: 0, bad: 0, bytes: 0, ttfb: 0, at: 0 };
    m.set(node, s);
  }
  // 只带 bps 的调用是"中途采样"，不能当成一条新的连接样本
  const isConn = o.ok !== undefined || o.bad !== undefined;
  if (isConn) {
    s.n += 1;
    if (o.ok) s.ok += 1;
    if (o.bad) s.bad += 1;
    // 缓存失效（两个模式各一份）。中途 bps 采样不失效：
    // 一次视频播放每 60 秒就刷一次，排行 30 秒本来也会过期。
    S.hostRankCache.delete(fam + "|lat");
    S.hostRankCache.delete(fam + "|tput");
  }
  s.bytes += o.bytes || 0;
  const ttfb = o.ttfb || 0;
  if (ttfb > 0) s.ttfb = s.ttfb ? Math.round(s.ttfb * 0.6 + ttfb * 0.4) : Math.round(ttfb);
  const bps = o.bps || 0;
  if (bps > 0) {
    s.bps = s.bps ? Math.round(s.bps * 0.6 + bps * 0.4) : bps;
    s.bpsN = (s.bpsN || 0) + 1;
    s.bpsAt = Date.now();
  }
  s.at = Date.now();
}

/**
 * 记一次直连结果（用来判断"是节点的锅还是站点/指纹的锅"）。
 * @param {string} host 目标域名
 * @param {boolean} ok 直连是否成功拿到数据
 * @returns {void}
 */
export function hostDirectMark(host: string, ok: boolean) {
  if (!host) return;
  if (S.hostDirect.size >= HN_MAX_HOSTS) {
    let oldK = "", oldT = Infinity;
    for (const [k, v] of S.hostDirect) if (v.at < oldT) { oldT = v.at; oldK = k; }
    if (oldK) S.hostDirect.delete(oldK);
  }
  const e = S.hostDirect.get(host) || { ok: 0, bad: 0, at: 0 };
  if (ok) e.ok += 1; else e.bad += 1;
  e.at = Date.now();
  S.hostDirect.set(host, e);
}

/**
 * 由样本推出结论（纯函数，便于单测）。
 * @param {Array} rows [{node, cc, n, ok, bad, bytes, ttfb}]
 * @param {{ok:number,bad:number}} direct 直连对照
 * @returns {{kind:string, verdict:string, suspect:string[]}}
 */
export function diagVerdict(rows: Array<{ node: string; n: number; ok: number; bad: number; cc?: string }> | null, direct: HDirect | null) {
  const tested = (rows || []).filter((r) => r.n > 0);
  const suspect = tested.filter((r) => r.bad >= 1 && r.bad * 2 >= r.n);
  const d = direct || { ok: 0, bad: 0 };

  if (!tested.length) {
    return {
      kind: "empty",
      verdict: "还没有样本：先访问一次这个站，或者加 &probe=1 做一轮主动探测",
      suspect: [],
    };
  }
  if (!suspect.length) {
    return {
      kind: "ok",
      verdict: `正常：${tested.length} 个节点有样本，没有可疑的`,
      suspect: [],
    };
  }
  const names = suspect.map((r) => r.node);
  if (suspect.length < tested.length) {
    const ccs = [...new Set(suspect.map((r) => String(r.cc || "").toUpperCase()).filter(Boolean))];
    if (ccs.length === 1 && suspect.length >= 2) {
      return {
        kind: "geo",
        verdict: `${suspect.length}/${tested.length} 个节点可疑，且都集中在 ${ccs[0]}：疑似地区 / ASN 规则，避开该地区即可`,
        suspect: names,
      };
    }
    return {
      kind: "ip",
      verdict: `${suspect.length}/${tested.length} 个节点可疑，分散在不同地区：疑似单 IP 信誉被拉黑（已按站避开）`,
      suspect: names,
    };
  }
  if (d.ok > 0 && d.ok >= d.bad) {
    return {
      kind: "pool",
      verdict: "全部节点都被拦，但直连正常：整个中转池的 IP 段被这个站拉黑了，换节点没用，得换出口类型",
      suspect: names,
    };
  }
  return {
    kind: "unknown",
    verdict: "全部节点都被拦，直连也不通：大概率是站点自身规则（地区封锁 / 登录态）或 TLS 指纹，需用浏览器直连验证一次",
    suspect: names,
  };
}
