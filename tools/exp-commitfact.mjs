// 事实写入决策器原型（v8 §17/§19/§22/§24 的合并规则）——只做实验，不进 src/
// 用法：node .tmp-sim/commitfact.mjs
// 目的：把「一条观测能不能变成一条事实」写成纯函数，并用表驱动向量验证。

const TINY_ABS = 2048;          // §19.2：绝对上限
const TINY_REL = 0.2;           // §19.2：相对本站点典型大响应
const BIG_PEER = 20000;         // §19.2：同窗口「有通道拿到整页」
const BIG_WIN = 120000;         // §19.2：同窗口 120s
const CONFIRM_GAP = 60000;      // §19.2：第二批至少隔 60s
const PS_TTL = 45 * 60000;      // §22.4
const BLK_TTL = 90 * 60000;     // §4.2 / D9
const DEAD_TTL = 30 * 60000;
const CAP_MIN_BYTES = 40 * 1024;// §24：≥5×TICK
const CAP_NOISE = 1.5;          // §24 R1
const CAP_SEP = 2.0;            // §24 R1
const WRITE_GAP = 60000;        // 节流：同一键 60s 内最多写一次

/** §19.2 tiny：拿到的响应「小到不像页面」 */
export function isTiny(o, bigTypical) {
  const down = o.down || 0;
  if (down <= 0) return false;                       // 没拿到字节，不是 tiny（是失败）
  if (down > TINY_ABS) return false;
  if (!bigTypical) return true;                      // 不知道站点典型大小时，只按绝对值
  return down < TINY_REL * bigTypical;
}

/**
 * 一条观测 → 一条事实（或拒绝理由）。
 * @param {object} o 观测
 * @param {object} ctx { bigTypical, lastWrite, lastBlk, prevBatch, lastBigAt, now }
 */
export function commitFact(o, ctx = {}) {
  const now = ctx.now ?? o.at;
  const bigTypical = ctx.bigTypical ?? 0;
  const down = o.down || 0;
  const status = o.status || 0;

  // 0) 节流：同一个键 60s 内只写一次（facts 是「事实」，不是日志）
  const keyOf = key(o);
  const lw = ctx.lastWrite?.[keyOf];
  if (lw && now - lw < WRITE_GAP) return { reason: "R_THROTTLED" };

  // 1) 回显观测：唯一能直接写 eg 的证据（§19.3）
  if (o.echoFam) {
    if (down < 64) return { reason: "R_ECHO_SMALL" };
    if (o.echoFam !== 4 && o.echoFam !== 6) return { reason: "R_ECHO_FAM" };
    return { write: { kind: "eg", key: o.relay, at: now, j: { fam: o.echoFam, at: now } }, reason: "ok" };
  }

  // 2) 中继自身坏了（证书/连接/TLS）→ dead，且不再往下判封锁
  if (o.err === "x509" || o.err === "tls" || o.err === "reset" || o.err === "timeout") {
    if (o.kind !== "relay") return { reason: "R_DEAD_DIRECT" };
    return { write: { kind: "dead", key: o.relay, at: now, j: { why: o.err, at: now } }, reason: "ok" };
  }

  // 3) 429：只退避，不写任何事实（§19.4）
  if (status === 429) return { reason: "R_429_BACKOFF" };

  // 4) 站点级 4xx：同窗口没有任何通道拿到整页 → 是站点在拒绝所有人（§19.1）
  const peers = sameWindow(o, ctx);
  const bigPeer = peers.some((p) => (p.down || 0) >= BIG_PEER);
  if (!bigPeer && status >= 400 && status < 500) return { reason: "R_SITE_LEVEL" };

  // 5) tiny 响应 = 候选封锁证据（只有中继腿可写；直连腿族不可归属）
  if (isTiny(o, bigTypical)) {
    if (o.kind !== "relay") return { reason: "R_DIRECT_NEVER" };          // 直连腿永不写 blk
    if (!bigPeer) return { reason: "R_NO_BIG_PEER" };
    const prev = ctx.prevBatch?.[keyOf];
    if (!prev || now - prev.at < CONFIRM_GAP) return { reason: "R_SINGLE_BATCH" };
    const bigAt = ctx.lastBigAt?.[o.host];
    if (bigAt && now - bigAt < 3 * 60000) return { reason: "R_CONTRADICTORY" }; // 3 分钟内这条通道还出过整页
    return { write: { kind: "blk", key: keyOf, at: now, j: { at: now } }, reason: "ok" };
  }

  // 6) 其余「拿到完整响应」→ ps 软折价 + 进「本站点典型大响应」样本
  if (down > 0) {
    const ok = !isTiny(o, bigTypical);
    return { write: { kind: "ps", key: keyOf, at: now, j: { ok: ok ? 1 : 0, at: now } }, reason: "ok" };
  }
  return { reason: "R_NO_BYTES" };
}

/** 同窗口（≤120s）的其他通道观测 */
function sameWindow(o, ctx) {
  const now = ctx.now ?? o.at;
  return (ctx.peers || []).filter((p) => p !== o && Math.abs(now - (p.at || now)) <= BIG_WIN);
}

/** 事实键：blk/ps 是 host|relay，eg/dead 是 relay */
function key(o) {
  if (o.kind === "relay" && (o.host === undefined || o.host === "")) return String(o.relay);
  return o.kind === "relay" ? `${o.host}|${o.relay}` : "d";
}

// ─── 表驱动向量 ───────────────────────────────────────────────────────────────
const T = 1_700_000_000_000;
const relay = (x = {}) => ({ kind: "relay", host: "x.com", relay: "45.136.117.194", at: T, ...x });
const direct = (x = {}) => ({ kind: "direct", host: "x.com", at: T, ...x });

const V = [
  ["回显 v4 写 eg", { o: relay({ echoFam: 4, down: 620 }) }, { reason: "ok", kind: "eg" }],
  ["回显太小不算", { o: relay({ echoFam: 4, down: 20 }) }, { reason: "R_ECHO_SMALL" }],
  ["tiny + 有大响应 + 两批 → 写 blk", {
    o: relay({ down: 737, status: 403 }),
    ctx: { bigTypical: 45000, peers: [direct({ down: 45290 })], prevBatch: { "x.com|45.136.117.194": { at: T - 61000 } } },
  }, { reason: "ok", kind: "blk" }],
  // 4xx 且同窗口没有任何整页 → 先判「站点级拒绝」（分不清站点还是通道，弃权最诚实）
  ["403 tiny 且无对照 → 站点级", { o: relay({ down: 737, status: 403 }), ctx: { bigTypical: 45000 } }, { reason: "R_SITE_LEVEL" }],
  // 200 却是 tiny：有对照但对照不够大（5KB）→ 缺对照，弃权
  ["200 tiny 且对照不够大", {
    o: relay({ down: 737, status: 200 }),
    ctx: { bigTypical: 45000, peers: [direct({ down: 5000 })] },
  }, { reason: "R_NO_BIG_PEER" }],
  ["tiny 只有一批", {
    o: relay({ down: 737, status: 403 }),
    ctx: { bigTypical: 45000, peers: [direct({ down: 45290 })] },
  }, { reason: "R_SINGLE_BATCH" }],
  ["直连腿 tiny 永不写 blk", {
    o: direct({ down: 737, status: 403 }),
    ctx: { bigTypical: 45000, peers: [relay({ down: 45290 })], prevBatch: { d: { at: T - 61000 } } },
  }, { reason: "R_DIRECT_NEVER" }],
  ["429 只退避", { o: relay({ down: 400, status: 429 }), ctx: { bigTypical: 45000 } }, { reason: "R_429_BACKOFF" }],
  ["全通道 4xx = 站点级", { o: relay({ down: 1277, status: 415 }), ctx: { bigTypical: 1277 } }, { reason: "R_SITE_LEVEL" }],
  ["业务 4xx 有对照 → 记 ps 且 ok", {
    o: relay({ down: 1277, status: 415 }),
    ctx: { bigTypical: 1277, peers: [direct({ down: 45290 })] },
  }, { reason: "ok", kind: "ps" }],
  ["正常大响应 → ps ok", { o: relay({ down: 45290, status: 200 }), ctx: { bigTypical: 45000 } }, { reason: "ok", kind: "ps" }],
  ["证书错 → dead", { o: relay({ err: "x509", down: 0 }), ctx: {} }, { reason: "ok", kind: "dead" }],
  ["直连证书错不写 dead", { o: direct({ err: "x509" }), ctx: {} }, { reason: "R_DEAD_DIRECT" }],
  ["三分钟内同通道出过整页 → 矛盾", {
    o: relay({ down: 737, status: 403 }),
    ctx: { bigTypical: 45000, peers: [direct({ down: 45290 })], prevBatch: { "x.com|45.136.117.194": { at: T - 61000 } }, lastBigAt: { "x.com": T - 120000 } },
  }, { reason: "R_CONTRADICTORY" }],
  ["节流：60s 内同键只写一次", {
    o: relay({ down: 45290, status: 200 }),
    ctx: { bigTypical: 45000, lastWrite: { "x.com|45.136.117.194": T - 30000 } },
  }, { reason: "R_THROTTLED" }],
  ["只有 1277B 且典型值 1277 → 不是 tiny（业务页）", {
    o: relay({ down: 1277, status: 200 }),
    ctx: { bigTypical: 1277, peers: [direct({ down: 1277 })] },
  }, { reason: "ok", kind: "ps" }],
  ["example.com 932B/典型 932 → 不是 tiny", {
    o: { kind: "relay", host: "example.com", relay: "45.147.250.39", at: T, down: 932, status: 200 },
    ctx: { bigTypical: 932 },
  }, { reason: "ok", kind: "ps" }],
  ["737B 但典型值未知 → 按绝对值仍算 tiny（需对照+两批）", {
    o: relay({ down: 737, status: 403 }),
    ctx: { bigTypical: 0, peers: [direct({ down: 45290 })], prevBatch: { "x.com|45.136.117.194": { at: T - 61000 } } },
  }, { reason: "ok", kind: "blk" }],
  ["没拿到任何字节", { o: relay({ down: 0, status: 0 }), ctx: {} }, { reason: "R_NO_BYTES" }],
];

let pass = 0;
const fails = [];
for (const [name, input, want] of V) {
  const r = commitFact(input.o, input.ctx);
  const okKind = want.kind ? r.write?.kind === want.kind : true;
  if (r.reason === want.reason && okKind) pass++;
  else fails.push(`${name}: got ${r.reason}${r.write ? "/" + r.write.kind : ""}, want ${want.reason}${want.kind ? "/" + want.kind : ""}`);
}
console.log(`${pass}/${V.length} 通过`);
for (const f of fails) console.log("  FAIL", f);
if (fails.length) process.exit(1);
