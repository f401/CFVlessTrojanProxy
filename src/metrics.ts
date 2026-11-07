/* metrics */

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
 * 记录一条错误日志（只保留最近 50 条，同时打到 console）。
 * @param {string} msg 错误信息
 * @param {string} [tag] 关联标签（域名或入口）
 * @returns {void}
 */
function logErr(msg, tag?) {
  try {
    S.errs.push({ t: Date.now(), m: String(msg).slice(0, 200), tag: tag || "" });
    while (S.errs.length > 50) S.errs.shift();
  } catch (e) {}
  try {
    console.error("[err]", msg);
  } catch (e) {}
}

/* ==================================================================
 * §7  WebSocket 数据面
 * ================================================================== */

/**
 * 把 WebSocket 的可读消息包装成 ReadableStream，并可注入 0-RTT 早期数据。
 * @param {WebSocket} ws 服务端 WS
 * @param {string} [earlyData] base64url 编码的早期数据
 * @returns {ReadableStream<Uint8Array>} 数据流
 */
