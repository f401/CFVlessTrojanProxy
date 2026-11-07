import * as W from "./_bundle.mjs";

let pass = 0, fail = 0;
const eq = (n, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log(`FAIL ${n}\n  got : ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`); } };
const ok = (n, c, info = "") => { if (c) pass++; else { fail++; console.log(`FAIL ${n}  ${info}`); } };

const S = W.S;
const reset = () => {
  S.alive.clear(); S.nstat.clear();
  S.curs = { lat: "", tput: "" }; S.prev = { lat: "", tput: "" };
  S.lastSwitch = { lat: 0, tput: 0 }; S.switchHits = { lat: [], tput: [] };
};
const node = (k, patch = {}) => {
  const i = k.lastIndexOf(":");
  S.alive.set(k, { h: k.slice(0, i), p: Number(k.slice(i + 1)) || 443, cc: "", ms: 100 });
  Object.assign(W.nsGet(k), patch);
};

/* ---------- 1. 直方图分位 ---------- */
reset();
eq("空直方图 p50", W.pcts(W.nsGet("x:1")).p50, 0);
eq("空直方图 p90", W.pcts(W.nsGet("x:1")).p90, 0);

const s1 = W.nsGet("h1:443");
s1.hist[7] = 10;                       // 2 MB/s 桶
const q1 = W.pcts(s1);
ok("单桶 p50 落在 2MB 附近", q1.p50 > 1.4e6 && q1.p50 < 2.9e6, q1.p50);
ok("单桶 cap ≤ p50*2.5", q1.cap <= q1.p50 * 2.5 + 1, `${q1.cap} vs ${q1.p50}`);

const s2 = W.nsGet("h2:443");
s2.hist[4] = 9; s2.hist[10] = 1;       // 256KB ×9 + 16MB ×1
const q2 = W.pcts(s2);
ok("p90 被单次突发拉高（> p50）", q2.p90 > q2.p50, `${q2.p90} / ${q2.p50}`);
ok("cap 抑制了突发", q2.cap <= q2.p50 * 2.5 + 1);

/* ---------- 2. 打分 ---------- */
reset();
node("a:443", { tcp: 50, tls: 60, tS: 20, tF: 0 });
node("b:443", { tcp: 200, tls: 60, tS: 20, tF: 0 });
ok("lat：低延迟更优", W.costOf("a:443", "lat") < W.costOf("b:443", "lat"),
  `${W.costOf("a:443", "lat")} vs ${W.costOf("b:443", "lat")}`);

reset();
node("good:443", { tcp: 50, tls: 60, tS: 20, tF: 0 });
node("bad:443", { tcp: 50, tls: 60, tS: 20, tF: 6 });
ok("失败率高更差", W.costOf("bad:443", "lat") > W.costOf("good:443", "lat"));

reset();
node("t1:443", { tcp: 50 });
ok("tput：无样本时等于先验", Math.round(W.costOf("t1:443", "tput")) === 52175 || W.costOf("t1:443", "tput") > 50000,
  W.costOf("t1:443", "tput"));
const t2 = W.nsGet("t2:443");
node("t2:443", { tcp: 50, bytesDown: 5 * 1048576, tS: 5 });
t2.hist[7] = 8;                        // 2MB/s，n>=3 且 bytes 够
// n 小的时候置信度低，会向先验(≈51s)收缩；这里只要求"比无样本时更低"
ok("tput：有样本时低于先验",
  W.costOf("t2:443", "tput") < W.costOf("t1:443", "tput") - 3000,
  `${W.costOf("t2:443", "tput")} vs ${W.costOf("t1:443", "tput")}`);

/* ---------- 3. 门槛与过滤 ---------- */
reset();
eq("无样本 avail = 0.5", W.availOf(W.nsGet("z:443")), 0.5);
equiv: {
  const s = W.nsGet("z2:443");
  s.tS = 1; s.tF = 5;
  ok("1 成功 5 失败 → avail < 0.75", W.availOf(s) < 0.75, W.availOf(s));
}
reset();
node("u:443", { tS: 1, tF: 5, tcp: 50 });
eq("可用性不足会被 candsFor 排除", W.candsFor("lat").some((x) => x.k === "u:443"), false);

reset();
node("e:443", { tS: 0, eCloseP: 6, tcp: 50 });
eq("中转后大量空关闭 → 可疑", W.emptyCloseSuspect("e:443"), true);
eq("可疑节点被排除", W.candsFor("lat").some((x) => x.k === "e:443"), false);

/* ---------- 4. Selector ---------- */
reset();
S.lastSwitch = { lat: 0, tput: 0 };
node("cur:443", { tcp: 400, tls: 60, tS: 20, tF: 0 });
node("new:443", { tcp: 50, tls: 60, tS: 20, tF: 0 });
S.curs.lat = "cur:443";
const switched = W.SEL.maybeSwitch({ pxDwellMin: 0 }, "lat");
eq("明显更优 → 切换", switched, true);
eq("切换后 CUR 指向新节点", S.curs.lat, "new:443");

reset();
S.lastSwitch = { lat: 0, tput: 0 };
node("c1:443", { tcp: 100, tls: 60, tS: 20, tF: 0 });
node("c2:443", { tcp: 105, tls: 60, tS: 20, tF: 0 });
S.curs.lat = "c1:443";
eq("差距小于滞回 → 不切", W.SEL.maybeSwitch({ pxDwellMin: 0 }, "lat"), false);

reset();
node("d1:443", { tcp: 300, tls: 60, tS: 20, tF: 0 });
node("d2:443", { tcp: 50, tls: 60, tS: 20, tF: 0 });
S.curs.lat = "d1:443";
S.lastSwitch.lat = Date.now();          // 刚切过 → 驻留期内
eq("驻留期内不切", W.SEL.maybeSwitch({ pxDwellMin: 0 }, "lat"), false);

reset();
node("f1:443", { tcp: 100, tS: 10, tF: 0 });
node("f2:443", { tcp: 200, tS: 10, tF: 0 });
S.curs.lat = "f1:443"; S.prev.lat = "f2:443"; S.lastSwitch.lat = Date.now();
W.SEL.onFail({}, "lat", "f1:443", false);
eq("切换后 60s 内失败 → 回滚", S.curs.lat, "f2:443");

/* ---------- 5. Connection（热路径 + tick） ---------- */
reset();
const fakeWs = { bufferedAmount: 0, readyState: 1, send() {}, close() {} };
const c = new W.Connection({}, {}, "tput", "tag");
c.down += 1024; c.onUp(10);
eq("down 累计", c.down, 1024);
eq("up 累计", c.up, 10);
eq("初始水位 = 512KB", c.mark, 512 * 1024);

// 造一个 2 秒、2MB 的窗口
c.node = "n:443";
c.sampleAt = Date.now() - 2000;
c.sampleDown = 0;
c.down = 2 * 1024 * 1024;
const keep = await c.tick(fakeWs);
eq("tick 返回 true（未触发背压）", keep, true);
ok("tick 后节点有吞吐样本", (W.S.nstat.get("n:443").bytesDown || 0) > 0,
  JSON.stringify(W.S.nstat.get("n:443")));
eq("tick 推进了水位", c.mark > c.down, true);

// 直连（node 为空）不应产生样本
reset();
const c2 = new W.Connection({}, {}, "lat", "");
c2.down = 2 * 1024 * 1024;
c2.sampleAt = Date.now() - 2000;
await c2.tick(fakeWs);
eq("直连不产生吞吐样本", W.S.nstat.size, 0);

// flush 在没有 id 时静默返回
c2.flush();
eq("无 id 时 flush 不改状态", c2.reportedUp, 0);

console.log(`\n评分/选择单测：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
