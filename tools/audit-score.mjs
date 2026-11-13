// 评分行为体检：把所有"看起来对、实际会卡住"的边角跑成一张表。
//   用法：node test/mk_test.mjs && node tools/audit-score.mjs
import * as W from "../test/_bundle.mjs";

const S = W.S;
const reset = () => {
  S.alive.clear();
  S.nstat.clear();
  S.hostNode.clear();
  S.hostDirect.clear();
  S.hostRankCache.clear();
  S.curs = { lat: "", tput: "" };
  S.prev = { lat: "", tput: "" };
  S.lastSwitch = { lat: 0, tput: 0 };
  S.switchHits = { lat: [], tput: [] };
  S.inflight.clear();
  S.rankCache = { t: 0, at: {}, v: {}, step: {} };
  S.candN = 0;
};
const node = (k, patch = {}) => {
  const i = k.lastIndexOf(":");
  S.alive.set(k, { h: k.slice(0, i), p: Number(k.slice(i + 1)) || 443, cc: patch.cc || "", ms: patch.tcp || 100 });
  Object.assign(W.nsGet(k), patch);
};

const pad = (s, n) => String(s).padEnd(n);

/* ---------- 1. lat 模式滞回：多快的节点才换得动 ---------- */
console.log("\n[1] lat 模式切换门槛（cur 已有 20 成功 / 2 失败）");
console.log(
  pad("cur/ms", 8) + pad("best/ms", 9) + pad("cur分", 9) + pad("best分", 9) + pad("差值", 7) +
    pad("旧门槛", 8) + pad("新门槛", 8) + "旧→新",
);
for (const [cur, best] of [
  [250, 60],
  [250, 100],
  [250, 150],
  [400, 60],
  [105, 100],
]) {
  reset();
  node("cur:443", { tcp: cur, tls: 60, okW: 20, failW: 2 });
  node("best:443", { tcp: best, tls: 60, okW: 20, failW: 2 });
  S.curs.lat = "cur:443";
  const a = W.scoreParts("cur:443", "lat");
  const b = W.scoreParts("best:443", "lat");
  const hOld = Math.max(20, a.score * 0.15);
  const hNew = Math.max(20, a.latencyMs * 0.25);
  const sw = W.SEL.maybeSwitch({ pxDwellMin: 0 }, "lat");
  const wouldNew = a.score - b.score > hNew;
  console.log(
    pad(cur, 8) + pad(best, 9) + pad(Math.round(a.score), 9) + pad(Math.round(b.score), 9) +
      pad(Math.round(a.score - b.score), 7) + pad(Math.round(hOld), 8) + pad(Math.round(hNew), 8) +
      `${sw ? "切" : "不切"}→${wouldNew ? "切" : "不切"}`,
  );
}

/* ---------- 2. 地区选路：可疑节点 / 并发堆积 ---------- */
console.log("\n[2] rg=xx 地区选路（candsFor 的排除规则是否也生效）");
reset();
node("de1:443", { tcp: 60, tls: 10, okW: 5, failW: 0, tS: 5, eCloseP: 6, cc: "DE" });
node("de2:443", { tcp: 180, tls: 20, okW: 20, failW: 1, tS: 20, eCloseP: 0, cc: "DE" });
const sus = W.emptyCloseSuspect("de1:443");
const inCands = W.candsFor("lat").some((x) => x.k === "de1:443");
const regionPick = await W.SEL.region({}, "DE", "lat");
console.log(`可疑(de1)=${sus}  candsFor 收录=${inCands}  region 选中=${regionPick && regionPick.h + ":" + regionPick.p}`);

reset();
node("jp1:443", { tcp: 60, tls: 10, okW: 20, failW: 1, tS: 20, cc: "JP" });
node("jp2:443", { tcp: 70, tls: 10, okW: 20, failW: 1, tS: 20, cc: "JP" });
S.inflight.set("jp1:443", 9);
const herd = await W.SEL.region({}, "JP", "lat");
console.log(`jp1 在途=9，jp2 在途=0 → region 选中=${herd && herd.h + ":" + herd.p}`);

/* ---------- 3. 快失败窗口：旧成功会不会稀释新失败 ---------- */
console.log("\n[3] 快失败窗口（4 次成功 → 9 分钟后 4 次失败）");
reset();
const s = W.nsGet("ff:443");
for (let i = 0; i < 4; i++) W.nsOk("ff:443", 50, 10);
const shift = 9 * 60000;
s.winAt -= shift;
s.at -= shift;
for (let i = 0; i < 4; i++) W.nsFail("ff:443");
console.log(
  `winOk=${s.winOk.toFixed(2)} winFail=${s.winFail.toFixed(2)} pFailFast=${W.pFailFast(s).toFixed(3)} ` +
    `blackUntil-now=${Math.round((s.blackUntil - Date.now()) / 1000)}s`,
);

/* ---------- 4. 站点画像：一次封禁是不是永久 ---------- */
console.log("\n[4] 站点画像 bad 的衰减（两次被拒 → 空闲 7 小时 → 一次成功）");
reset();
W.hostNodeMark("decay.test", "n1:443", { ok: false, bad: true, ttfb: 0 });
W.hostNodeMark("decay.test", "n1:443", { ok: false, bad: true, ttfb: 0 });
const rec = S.hostNode.get("decay.test").get("n1:443");
const before = W.hostScore(rec, "lat", Date.now());
rec.at -= 7 * 3600e3;
W.hostNodeMark("decay.test", "n1:443", { ok: true, bad: false, ttfb: 100 });
console.log(
  `bad 2 → ${rec.bad}；站点分 ${Math.round(before)}ms → ${Math.round(W.hostScore(rec, "lat", Date.now()))}ms`,
);

/* ---------- 5. 评分构成 ---------- */
console.log("\n[5] 典型节点（tcp=150/tls=40，20 成功 2 失败）的分项占比");
reset();
node("mix:443", { tcp: 150, tls: 40, okW: 20, failW: 2 });
const p = W.scoreParts("mix:443", "lat");
const risk = 8000 * p.pFailRisk;
const stall = 2500 * p.pStall;
console.log(
  `延迟 ${Math.round(p.latencyMs)}ms (${Math.round((p.latencyMs / p.score) * 100)}%)  ` +
    `失败 ${Math.round(risk)}ms (${Math.round((risk / p.score) * 100)}%)  ` +
    `卡顿 ${Math.round(stall)}ms (${Math.round((stall / p.score) * 100)}%)  合计 ${Math.round(p.score)}`,
);

/* ---------- 6. 候选规模 CPU ---------- */
console.log("\n[6] 400 候选的排序成本");
reset();
for (let i = 0; i < 400; i++) {
  node(`n${i}:443`, { tcp: 100 + (i % 80), tls: 40, okW: 10 + (i % 20), failW: i % 3 });
  const st = W.nsGet(`n${i}:443`);
  st.hist[7] = 5;
  st.sumW = 5;
  st.sumW2 = 5;
  st.recentBytesW = 5 * 1048576;
  st.lastSampleAt = Date.now();
}
for (const m of ["lat", "tput"]) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) {
    S.rankCache = { t: 0, at: {}, v: {}, step: {} };
    W.candsFor(m);
  }
  const us = Number(process.hrtime.bigint() - t0) / 50 / 1000;
  console.log(`candsFor(${m}) ≈ ${us.toFixed(0)} µs/次`);
}

/* ---------- 7. 地区选路的算分次数 ---------- */
console.log("\n[7] rg=xx 一次选路的算分成本（30 个同国节点）");
reset();
for (let i = 0; i < 30; i++) node(`d${i}:443`, { tcp: 100 + i, tls: 40, okW: 20, failW: 1, cc: "DE" });
{
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) await W.SEL.region({}, "DE", "lat");
  const us = Number(process.hrtime.bigint() - t0) / 100 / 1000;
  console.log(`region(DE) ≈ ${us.toFixed(0)} µs/次（旧实现按 sort 比较器反复算分，约 5 倍）`);
}
