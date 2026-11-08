/* metrics */

/** 错误日志去重表：msg|tag → 上次记录时间（5 秒窗口） */
const ERR_SEEN = new Map<string, number>();

/**
 * 记录某个入口的一次成功/失败（用于 RTT 学习）。
 * @param {string} id 用户 UUID
 * @param {string} tag 入口标签
 * @param {boolean} ok 是否成功
 * @returns {void}
 */
function rttMark(id, tag, ok) {
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
function rttLearn(cf, tag, id) {
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
async function loadRtt(env: Env, id) {
  if (!id) return {};
  const mem = S.rtt.get(id) || {};
  if (!env.STATS) return mem;
  try {
    const snap = await getSnap(env);
    let stored = (snap.rtt || {})[id] || {};
    if (!Object.keys(stored).length) {
      stored = (await kvGet<Record<string, RttEntry>>(env, `rtt:${id}`)) || {};
    }
    return { ...stored, ...mem };
  } catch (e) {
    return mem;
  }
}


/**
 * 某个节点在某个站点上的代价（毫秒当量）。
 * 有真实样本就用首字节时间，没有就用全局分 + 不确定性惩罚 —— 惩罚保证
 * "没试过的节点"不会因为先验乐观而一直霸占榜首。
 * @param {string} host 目标域名
 * @param {string} k "host:port"
 * @param {string} mode "lat" | "tput"
 * @returns {number} 代价，越小越好
 */
function hostCost(host: string, k: string, mode: string): number {
  const m = S.hostNode.get(host);
  const s = m && m.get(k);
  const g = costOf(k, mode);
  if (!s || !s.n) return g + 300;
  const fail = (s.bad + 1) / (s.n + 6);          // 小样本往坏里估，但不一票否决
  const ttfb = s.ttfb > 0 ? s.ttfb : Math.min(g, 800);
  return ttfb + fail * 4000 + (s.n < 2 ? 150 : 0);
}

/**
 * 某个站点上的节点排行（只算 alive 且没被黑/冻结的）。
 * @param {string} host 目标域名
 * @param {string} mode 模式
 * @returns {Array<{k:string,v:number}>} 升序
 */
function hostRank(host: string, mode: string) {
  const out = [];
  for (const k of S.alive.keys()) {
    if (isBlack(k) || isFrozen(k)) continue;
    out.push({ k, v: hostCost(host, k, mode) });
  }
  out.sort((a, b) => a.v - b.v);
  return out;
}

/**
 * 这个站还没试过、且全局分最好的节点（冷启动用）。
 * @param {string} host 目标域名
 * @param {string} mode 模式
 * @returns {string} 节点 key，没有返回 ""
 */
function hostUntried(host: string, mode: string) {
  const m = S.hostNode.get(host);
  let best = "", bv = Infinity;
  for (const k of S.alive.keys()) {
    if (isBlack(k) || isFrozen(k)) continue;
    if (m && m.has(k)) continue;
    const v = costOf(k, mode);
    if (v < bv) { bv = v; best = k; }
  }
  return best;
}

/**
 * 记录一条错误日志（只保留最近 50 条，同时打到 console）。
 * @param {string} msg 错误信息
 * @param {string} [tag] 关联标签（域名或入口）
 * @returns {void}
 */
function logErr(msg, tag?) {
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

const HN_MAX_HOSTS = 120;   // 最多记 120 个域名
const HN_MAX_NODES = 12;    // 每个域名最多记 12 个节点

/**
 * 记一次 (站点, 节点) 的连接结果。
 * @param {string} host 目标域名
 * @param {string} node "host:port" 节点
 * @param {{ok:boolean, bad:boolean, bytes:number, ttfb:number}} o 本次结果
 * @returns {void}
 */
function hostNodeMark(host, node, o) {
  if (!host || !node) return;
  let m = S.hostNode.get(host);
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
    S.hostNode.set(host, m);
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
  s.n += 1;
  if (o.ok) s.ok += 1;
  if (o.bad) s.bad += 1;
  s.bytes += o.bytes || 0;
  if (o.ttfb > 0) s.ttfb = s.ttfb ? Math.round(s.ttfb * 0.6 + o.ttfb * 0.4) : Math.round(o.ttfb);
  s.at = Date.now();
}

/**
 * 记一次直连结果（用来判断"是节点的锅还是站点/指纹的锅"）。
 * @param {string} host 目标域名
 * @param {boolean} ok 直连是否成功拿到数据
 * @returns {void}
 */
function hostDirectMark(host, ok) {
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
function diagVerdict(rows, direct) {
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
