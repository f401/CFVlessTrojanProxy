// v8 事实层的**本地闭环证明**：真实选路代码 + 真实事实表 + 模拟传输层。
//
// 与 `exp-v8sim.mjs` 的区别：那个是「按文档重写一遍模型」，只能证明文档自洽；
// 这个直接调用生产代码的 `Policy.decide` / `egDerive` / `PS.note` / `BLK.note`，
// 模拟层只做两件事：按「这条出口的真实族」返回响应体大小、推进虚拟时钟。
//
// 虚拟时钟是必须的：`Policy.pinFor` 会把冷启动站点钉在一条中继上 60 秒，而脚本毫秒级跑完，
// 不推进时间就永远停在「第一条中继」——那样的数字证明不了任何学习能力（实测过，全场景 400/400 都是 cold-pin）。
//
// 口径提醒：这里证明的是**机制**（选对族就能过、关掉开关就退回盲选），
// 不代表线上真实成功率——线上还叠加客户端腿带宽、边缘漂移、站点请求级风控。

import * as W from "../test/_bundle.mjs";

/** 确定性伪随机：同代码同场景必须给出同样的数字，否则不能当回归用 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 线上实测的两种响应形态：整页（v4 出口）与 CF 的族级拒绝页（v6 出口） */
const PAGE = { down: 45290 };
const DENY = { down: 737 };
/** v6 出口不是「必被拒」：实测 2/16 也能过，只是概率低 */
const V6_PASS = 0.125;

/** 虚拟时钟：每条连接推进 dt，让 60 秒钉住、60 秒批次间隔、45 分钟 TTL 都能真实发生 */
let vnow = 1_700_000_000_000;
const advance = (ms) => {
  vnow += ms;
};
Date.now = () => vnow;

/** 事实表全清：每个场景从干净的 isolate 开始 */
function reset() {
  for (const t of [W.EG, W.PS, W.BLK, W.DEAD, W.DNS, W.CAP]) {
    if (t && typeof t.clear === "function") t.clear();
  }
  if (typeof W.vClear === "function") W.vClear();
  const S = W.S;
  for (const k of ["alive", "pool", "bigByHost", "bigChan", "peers", "bigTyp"]) {
    const m = S && S[k];
    if (m && typeof m.clear === "function") m.clear();
  }
}

/** 一条连接：真实决策 → 模拟响应 → 用 judge 同一批函数喂事实 */
function once(policy, world, host, facts, mode, rnd) {
  const relays = Array.from(world.fam.keys());
  const d = policy.decide({ host, cfHost: true, clientV6: false, relays, legacyWantsRelay: false, mode, facts });
  if (process.env.V8DBG && policy.dbg < 3) {
    policy.dbg += 1;
    process.stdout.write("  dbg " + d.why + " " + (d.chan.kind === "d" ? "direct" : d.chan.ip + "/fam" + (world.fam.get(d.chan.ip) ?? 0)) + "\n");
  }
  if (d.chan.kind === "d") {
    // 直连：v8 只允许「成功」进判定表（直连 403 不可归属，永不写共享事实）
    const ok = rnd() < world.direct;
    if (ok) W.vSetState(host, "d", 1, 1);
    return { why: d.why, ok };
  }
  const ip = d.chan.ip;
  const fam = world.fam.get(ip) ?? 0;
  const rej = world.rej.get(ip) ?? 0;
  const p = fam === 4 ? 1 - rej : V6_PASS;
  const ok = rnd() < p;
  const resp = ok ? PAGE : DENY;
  // 与 judge 相同的三个写入点：族推导、成功率、软封锁（软封锁必须带「同窗口有整页」的对照）
  const peerBig = ok || W.EG.snap().some((r) => r.f === 4);
  W.egDerive(ip, resp.down, { peerBig, known: peerBig }, vnow);
  W.PS.note(host, ip, ok, vnow);
  if (!ok && resp.down <= 2048 && peerBig) W.BLK.note(host, ip, vnow, resp.down, true);
  // 拿到整页 ⇒ 判定表记一次通道胜利（judge 的真实写入点之一）。没有这一步，`coldSite` 永远成立，
  // 策略就会一直被 `cold-pin` 钉在第一条中继上 —— 实测过：400 条全是 cold-pin，学不到任何东西。
  if (ok) W.vSetState(host, "r:" + ip, 1, 1);
  return { why: d.why, ok };
}

/** 跑 n 条连接 */
function run(spec) {
  reset();
  const world = { fam: new Map(spec.relays), direct: spec.direct, rej: new Map(Object.entries(spec.rej ?? {})) };
  const rnd = rng(spec.seed ?? 7);
  // 场景可预置「直连刚成功过」的证据（生产里由真实连接写入；本地无从产生，只能注入）
  if (spec.seedDirect) W.vSetState(spec.host, "d", 1, 1);
  const byWhy = new Map();
  let policy = new W.Policy();
  policy.dbg = 0;
  let ok = 0;
  for (let i = 0; i < spec.n; i += 1) {
    // `reborn=k` 模拟「每 k 条连接换一个 isolate」：钉住表、样本全都重来
    if (spec.reborn && i % spec.reborn === 0) policy = new W.Policy();
    advance(spec.dt ?? 10_000);
    const r = once(policy, world, spec.host, spec.facts ?? null, spec.mode ?? "tput", rnd);
    if (r.ok) ok += 1;
    byWhy.set(r.why, (byWhy.get(r.why) || 0) + 1);
  }
  const rate = ok / spec.n;
  const ci = 1.96 * Math.sqrt((rate * (1 - rate)) / spec.n);
  const cnt = { v4: 0, v6: 0 };
  for (const r of W.EG.snap()) {
    if (r.f === 4) cnt.v4 += 1;
    else if (r.f === 6) cnt.v6 += 1;
  }
  return { rate, ci, byWhy: Object.fromEntries([...byWhy].sort((a, b) => b[1] - a[1])), eg: cnt, blk: W.BLK.snap().length };
}

// 池子的顺序**故意打乱**（v6 在前）：盲选时按 ip 字典序近似「不知道族」，这样对照组才不会被列表顺序帮到
const MIXED = [
  ["91.215.153.143", 6],
  ["45.136.117.194", 4],
  ["91.215.154.80", 6],
  ["45.147.250.39", 4],
  ["193.181.211.185", 6],
  ["45.151.183.22", 4],
  ["185.253.117.147", 6],
  ["89.22.227.132", 6],
];
const ALL_V6 = MIXED.map(([ip]) => [ip, 6]);
const HOST = "site.example.com";
const FULL = new Set(W.FACT_ALL);
const EG_ONLY = new Set(["eg"]);
const NONE = new Set();
const N = 400;

const rows = [];
const add = (name, r) => rows.push({ name, ...r });
add("facts=none（直连必失败）", run({ host: HOST, relays: MIXED, direct: 0, facts: NONE, n: N }));
add("facts=eg（直连必失败）", run({ host: HOST, relays: MIXED, direct: 0, facts: EG_ONLY, n: N }));
add("facts=all（直连必失败）", run({ host: HOST, relays: MIXED, direct: 0, facts: FULL, n: N }));
add("facts=all + 每 isolate 3 条", run({ host: HOST, relays: MIXED, direct: 0, facts: FULL, n: N, reborn: 3 }));
add("facts=all + 1 条 v4 被拒 90%", run({ host: HOST, relays: MIXED, direct: 0, facts: FULL, n: N, rej: { "45.151.183.22": 0.9 } }));
add("facts=all + 直连 95%（预置直连证据）", run({ host: HOST, relays: MIXED, direct: 0.95, facts: FULL, n: N, seedDirect: true }));
add("facts=all + 全 v6 池", run({ host: HOST, relays: ALL_V6, direct: 0, facts: FULL, n: N }));

let fail = 0;
const out = (s) => process.stdout.write(s + "\n");
out("\nv8 事实层本地闭环证明（真实 Policy.decide + 真实事实表 + 模拟传输层，N=" + N + "）\n");
out("场景".padEnd(30) + "成功率".padEnd(12) + "±95%".padEnd(10) + "eg(v4/v6)".padEnd(12) + "blk".padEnd(6) + "主要原因");
for (const r of rows) {
  const why = Object.entries(r.byWhy).slice(0, 3).map(([k, v]) => k + ":" + v).join(" ");
  out(
    r.name.padEnd(30) +
      (r.rate * 100).toFixed(1).padStart(5) + "%".padEnd(7) +
      ("±" + (r.ci * 100).toFixed(1)).padEnd(10) +
      (r.eg.v4 + "/" + r.eg.v6).padEnd(12) +
      String(r.blk).padEnd(6) +
      why,
  );
}

/** 断言按**机制**写：树挪活了才算，数字好看不算 */
function check(label, cond, detail) {
  if (!cond) {
    fail += 1;
    out("✗ " + label + (detail ? "  (" + detail + ")" : ""));
  } else out("✓ " + label + (detail ? "  (" + detail + ")" : ""));
}
const [none, eg, all, cold, hostile, directGood, v6] = rows;
check("关闭事实层后退回盲选（≤20%）", none.rate <= 0.2, (none.rate * 100).toFixed(1) + "%");
check("只开 eg 就足以抬到 ≥85%", eg.rate >= 0.85, (eg.rate * 100).toFixed(1) + "%");
check("全开不劣于只开 eg（差 ≤3 点）", all.rate >= eg.rate - 0.03, (all.rate * 100).toFixed(1) + "%");
check("每 isolate 3 条连接仍 ≥80%", cold.rate >= 0.8, (cold.rate * 100).toFixed(1) + "%");
check("「族对但站点拒」被降权后仍 ≥80%", hostile.rate >= 0.8, (hostile.rate * 100).toFixed(1) + "%");
check("直连 95% 时优先直连（≥90% 且 direct 占比 > 50%）", directGood.rate >= 0.9 && (directGood.byWhy.direct || 0) + (directGood.byWhy["direct-ok"] || 0) > 200, (directGood.rate * 100).toFixed(1) + "% " + JSON.stringify(directGood.byWhy));
check("全 v6 池仍发请求（≥5% 且无 direct 兜底）", v6.rate >= 0.05 && !("direct" in v6.byWhy), (v6.rate * 100).toFixed(1) + "%");
check("eg 表同时学到 v4 与 v6（两种族都被观测过）", eg.eg.v4 >= 1 && eg.eg.v6 >= 1, "v4=" + eg.eg.v4 + " v6=" + eg.eg.v6);

out(fail ? "\n✗ " + fail + " 条断言未通过" : "\n✓ 全部 8 条断言通过");
process.exit(fail ? 1 : 0);
