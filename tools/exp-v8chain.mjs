// v8 链路验收：把「事实层 → 选路」这条链在本地完整跑一遍，断言每一段都真的在动。
//
// 为什么需要它：单测是**分模块**的（`commitFact` 19 条、`BlkFacts` 17 条……），全绿也不能证明
// 「judge 喂进来的证据会被写进表、再被 policy 读到」。这个文件只做一件事：用真实的 bundle
// 走真实入口（`JUDGE.onTraffic` / `HOOK.*`），再从**外部可观测的结果**反推整条链是否接通。
//
// 三条纪律：
// 1. 不手写内部状态。`S.peers` 这类环形由管线自己记录 —— 手工塞进去会被后一条事件覆盖，
//    于是测的是脚本而不是代码（第一版就这么错过）。
// 2. 时间戳显式给。三批确认要间隔 ≥60 秒，用 `at` 注入，不真的等。
// 3. 只断言外部结果：代价倍数、行数、计数、`decide` 的选择、`/health` 的字段。
import * as M from "../test/_bundle.mjs";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const W = M;
const H = M.default;

let pass = 0;
let fail = 0;
/**
 * 功能：断言一条验收结论。
 * @param {string} name 结论描述
 * @param {boolean} ok 是否成立
 * @param {unknown} [extra] 失败时附带的实际值
 * @returns {void}
 */
const ok = (name, ok2, extra) => {
  if (ok2) pass += 1;
  else {
    fail += 1;
    console.log(`FAIL ${name}${extra === undefined ? "" : " got=" + JSON.stringify(extra)}`);
  }
};

const HOST = "chain.example";
const IP4 = "203.0.113.201";
const IP6 = "203.0.113.202";
const now = Date.now();

// 清一下全局状态，保证可重复
W.BLK.clear();
W.PS.clear();
W.DEAD.clear();
W.EG.clear();
W.FO.clear();
W.S.peers.clear();
W.S.bigTyp.clear();

// ── 1) eg：出口族事实写进去后，v4 的代价倍数应低于 v6 ─────────────────────────
W.EG.note(IP4, 4, now);
W.EG.note(IP6, 6, now);
ok("eg：v4 出口的偏置低于 v6", W.EG.bias(IP4, now) < W.EG.bias(IP6, now), [W.EG.bias(IP4, now), W.EG.bias(IP6, now)]);

// ── 2) ps：成功 + 失败样本进来后，同一个中继的折价倍数上升 ─────────────────────
const psBefore = W.PS.factor(HOST, IP4, now);
W.PS.note(HOST, IP4, false, now);
W.PS.note(HOST, IP4, false, now);
W.PS.note(HOST, IP4, false, now);
const psAfter = W.PS.factor(HOST, IP4, now);
ok("ps：连续失败后折价倍数变大（p 变小）", psAfter > psBefore, [psBefore, psAfter]);

// ── 3) dead：走 HOOK（真实接线），两次连不上就判死 ──────────────────────────
ok("dead：HOOK.deadNote 已注册", typeof W.HOOK.deadNote === "function", typeof W.HOOK.deadNote);
W.HOOK.deadNote(IP6, false);
ok("dead：一次失败还不算死", !W.isDead(IP6, now));
W.HOOK.deadNote(IP6, false);
ok("dead：两次连不上判死", W.isDead(IP6, now), true);

// ── 4) blk：真实入口喂三批 tiny + 管线自己记的整页对照 ───────────────────────
// 每一批之前都要有一条「另一条通道出过整页」：对照的有效窗口只有 120 秒，而批次间隔 60 秒，
// 现实里对应「同站点另一条中继这段时间里一直在正常出页面」。
for (let b = 0; b < 3; b += 1) {
  const bigAt = now + 61000 * b;
  W.JUDGE.onTraffic({ host: HOST, via: "node", node: "203.0.113.203:443", down: 45000, ok: true, up: 900, life: 1200, at: bigAt });
  for (let k = 0; k < 3; k += 1) {
    const at = now + 61000 * (b + 1) + 1000 * k;
    W.JUDGE.onTraffic({ host: HOST, via: "node", node: IP4 + ":443", down: 737, ok: true, up: 120, life: 60, at });
  }
}
const pen = W.blkPen(HOST, IP4, now + 200000);
ok("blk：三批确认后代价 ×6", pen === W.BLK_PEN, pen);
ok("blk：表里有一行", W.BLK.snap(now + 200000).length === 1, W.BLK.snap(now + 200000));

// ── 5) 选路：被判封锁的那条排后面，但绝不消失 ────────────────────────────────
W.RELPERF.clear();
W.relNote(HOST, IP4, 100, 0, now); // IP4 首字节更快
W.relNote(HOST, "203.0.113.204", 300, 0, now);
const d1 = W.decide({ host: HOST, cfHost: true, clientV6: false, relays: [IP4, "203.0.113.204"], legacyWantsRelay: true, mode: "tput" });
ok("选路：被判封锁的更快中继被排到后面", d1.chan.ip === "203.0.113.204", d1.chan && d1.chan.ip);
const d2 = W.decide({ host: HOST, cfHost: true, clientV6: false, relays: [IP4], legacyWantsRelay: true, mode: "tput" });
ok("选路：只剩被判封锁的一条时仍然用它", d2.chan.ip === IP4, d2.chan && d2.chan.ip);

// ── 6) firstTry：口径落到了真实计数器上 ──────────────────────────────────────
W.FO.note(737);
W.FO.note(45000);
W.FO.note(0);
const fo = W.FO.snap();
ok("first：三条到上限", fo.n === 3, fo);
ok("first：737B 与 45KB 都算连通，只有 45KB 算整页", fo.first === 2 && fo.page === 1, fo);

// ── 7) /health：五个新字段都在 ───────────────────────────────────────────────
const env = { uuid: "u", adminKey: "k", proxyip: "auto", nodes: "" };
const res = await H.fetch(new Request("https://example.com/health", { headers: { "x-admin-key": "k" } }), env, {});
const j = await res.json();
for (const k of ["first", "eg", "ps", "dead", "blk", "cf"]) ok(`health：有 ${k}`, k in j, Object.keys(j));

console.log(`\nv8 链路验收：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
