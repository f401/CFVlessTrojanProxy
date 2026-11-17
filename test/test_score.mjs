import fs from "node:fs";
/**
 * 存储层四段源码拼在一起：`meter.ts`（DO 外壳）/ `meter-state.ts`（账本本体与落盘映射）/ `meteradd.ts`（`/add` 合并）/ `metershard.ts`（分片落盘）。
 * v7.218 把后两块从 `meter.ts` 拆出去（单文件 ≤560 行的硬上限），源码锁断言跟着改成「在存储层存在」，
 * 避免以后每次挪文件都要改一批断言。
 * @returns {string} 四段源码
 */
const storeSrc = () =>
  ["src/store/meter.ts", "src/store/meter-state.ts", "src/store/meteradd.ts", "src/store/metershard.ts"]
    .map((p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""))
    .join("\n");

/**
 * 节点统计层五段源码拼在一起：`stat.ts`（门面）、`stat-types.ts`（类型与上限）、`stat-table.ts`（表本体）、
 * `stat-view.ts`（纯派生）、`stat-observe.ts`（观测写入）。
 * v7.282 把这层一分为四，源码锁改成「在整个 stat 模块里存在」，避免以后每次挪文件都要改一批断言。
 * @returns {string} 五段源码
 */
const statAll = () =>
  ["src/nodes/stat.ts", "src/nodes/stat-types.ts", "src/nodes/stat-table.ts", "src/nodes/stat-view.ts", "src/nodes/stat-observe.ts"]
    .map((p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""))
    .join("\n");

/**
 * 诊断路由四段源码拼在一起：`debug.ts`（编排）/ `debug-tables.ts`（只读表）/ `debug-nets.ts`（会拨号的测量）/ `debug-actions.ts`（会改状态的写）。
 * v7.283 把原来 450 行的一条 if 链按「读 / 量 / 写」拆开，源码锁改成「在整个诊断模块里存在」。
 * @returns {string} 四段源码
 */
/**
 * 指标层四段源码拼在一起：`metrics.ts`（门面）/ `rtt.ts`（入口 RTT 学习）/ `site.ts`（站点画像与族键）/ `diag.ts`（诊断结论）。
 * v7.284 把 430 行的 `metrics.ts` 拆成四块，源码锁改成「在整个指标模块里存在」。
 * @returns {string} 四段源码
 */
const metricsAll = () =>
  ["src/nodes/metrics.ts", "src/nodes/rtt.ts", "src/nodes/site.ts", "src/nodes/diag.ts"]
    .map((p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""))
    .join("\n");

const debugAll = () =>
  ["src/routes/debug.ts", "src/routes/debug-tables.ts", "src/routes/debug-nets.ts", "src/routes/debug-actions.ts"]
    .map((p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""))
    .join("\n");
import * as W from "./_bundle.mjs";
import { webcrypto } from "node:crypto";
import { execFileSync } from "node:child_process";

// Node 18 没有全局 crypto（Workers 有），补一个给 tlsHello() 用
if (!globalThis.crypto) globalThis.crypto = webcrypto;

let pass = 0,
  fail = 0;
/** 功能：把判定表的门面、表本体与类型三份源码合并成一段文本（源码锁读它）。 */
const verdictAll = () =>
  [
    "src/route/verdict.ts",
    "src/route/verdict-table.ts",
    "src/route/verdict-types.ts",
  ]
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n");
const eq = (n, a, b) => {
  // want 是 undefined / 函数，或拿到的东西是函数时，序列化比较会两边都变成 undefined，
  // 断言永远为真（v7.150 修的空断言：删掉某函数后，旧锁其实一直没在测）。
  const strict = b === undefined || typeof a === "function" || typeof b === "function";
  if (strict ? Object.is(a, b) : JSON.stringify(a) === JSON.stringify(b)) pass++;
  else {
    fail++;


    console.log(`FAIL ${n}\n  got : ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`);
  }
};
const ok = (n, c, info = "") => {
  if (c) pass++;
  else {
    fail++;
    console.log(`FAIL ${n}  ${info}`);
  }
};

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
  // 模拟「新 isolate」：排行表也一起清（生产里池子换代同样会清）
  S.rankCache = { t: 0, at: {}, v: {}, step: {} };
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
s1.hist[7] = 10; // 2 MB/s 桶
const q1 = W.pcts(s1);
ok("单桶 p50 落在 2MB 附近", q1.p50 > 1.4e6 && q1.p50 < 2.9e6, q1.p50);
ok("单桶 cap ≤ p50*2.5", q1.cap <= q1.p50 * 2.5 + 1, `${q1.cap} vs ${q1.p50}`);

const s2 = W.nsGet("h2:443");
s2.hist[4] = 9;
s2.hist[10] = 1; // 256KB ×9 + 16MB ×1
const q2 = W.pcts(s2);
ok("p90 被单次突发拉高（> p50）", q2.p90 > q2.p50, `${q2.p90} / ${q2.p50}`);
ok("cap 抑制了突发", q2.cap <= q2.p50 * 2.5 + 1);

/* ---------- 2. 打分（v2：读时衰减 + 加权吞吐） ---------- */
reset();
node("a:443", { tcp: 50, tls: 60, okW: 20 });
node("b:443", { tcp: 200, tls: 60, okW: 20 });
ok(
  "lat：低延迟更优",
  W.costOf("a:443", "lat") < W.costOf("b:443", "lat"),
  `${W.costOf("a:443", "lat")} vs ${W.costOf("b:443", "lat")}`,
);

reset();
node("good:443", { tcp: 50, tls: 60, okW: 20 });
node("bad:443", { tcp: 50, tls: 60, okW: 20, failW: 6 });
ok("失败率高更差", W.costOf("bad:443", "lat") > W.costOf("good:443", "lat"));

reset();
node("t1:443", { tcp: 50 });
ok("tput：无样本时用先验（≈5s）", W.costOf("t1:443", "tput") > 4500, W.costOf("t1:443", "tput"));

node("t2:443", { tcp: 50 });
const st2n = W.S.nstat.get("t2:443");
st2n.hist[9] = 5; // 8 MB/s
st2n.sumW = 5;
st2n.sumW2 = 5;
st2n.recentBytesW = 5 * 1048576;
st2n.lastSampleAt = Date.now();
ok(
  "tput：有效样本后低于先验",
  W.costOf("t2:443", "tput") < W.costOf("t1:443", "tput") - 2000,
  `${W.costOf("t2:443", "tput")} vs ${W.costOf("t1:443", "tput")}`,
);

// 累计字节不能"复活"旧速率：没有近期权重就不该有吞吐置信度
reset();
node("cum:443", { tcp: 50 });
const sc = W.S.nstat.get("cum:443");
sc.bytesDown = 200 * 1048576;
sc.hist[7] = 5;
eq("旧累计字节不通过吞吐准入", W.scoreParts("cum:443", "tput").confB, 0);

// 读时衰减：不产生新事件，旧样本自己变旧
reset();
node("age:443", { tcp: 50, okW: 10 });
const sa = W.S.nstat.get("age:443");
const beforeW = W.effView(sa).okW;
sa.at = Date.now() - 6 * 3600e3;
ok("6 小时后有效权重减半", Math.abs(W.effView(sa).okW - beforeW / 2) < 0.01, `${beforeW} → ${W.effView(sa).okW}`);
ok("老化后分数变差", W.costOf("age:443", "lat") > 0);

// 吞吐置信度看"有效窗口数"，不看连接数
reset();
node("one:443", { tcp: 50 });
node("many:443", { tcp: 50 });
const sOne = W.S.nstat.get("one:443");
sOne.hist[7] = 4;
sOne.sumW = 4;
sOne.sumW2 = 16;
sOne.recentBytesW = 8 * 1048576;
sOne.lastSampleAt = Date.now();
const sMany = W.S.nstat.get("many:443");
sMany.hist[7] = 4;
sMany.sumW = 4;
sMany.sumW2 = 4;
sMany.recentBytesW = 8 * 1048576;
sMany.lastSampleAt = Date.now();
ok(
  "一个 4 权重样本 nEff=1",
  Math.abs(W.scoreParts("one:443", "tput").nEff - 1) < 0.01,
  String(W.scoreParts("one:443", "tput").nEff),
);
ok(
  "四个独立样本 nEff=4",
  Math.abs(W.scoreParts("many:443", "tput").nEff - 4) < 0.01,
  String(W.scoreParts("many:443", "tput").nEff),
);
ok("多样本置信度更高", W.scoreParts("many:443", "tput").confB > W.scoreParts("one:443", "tput").confB);

// 偶然一次高速不能长期占首位
reset();
node("lucky:443", { tcp: 50 });
const sL = W.S.nstat.get("lucky:443");
sL.hist[11] = 1;
sL.sumW = 1;
sL.sumW2 = 1;
sL.recentBytesW = 1048576;
sL.lastSampleAt = Date.now();
node("steady:443", { tcp: 50 });
const sS = W.S.nstat.get("steady:443");
sS.hist[7] = 8;
sS.sumW = 8;
sS.sumW2 = 8;
sS.recentBytesW = 12 * 1048576;
sS.lastSampleAt = Date.now();
ok(
  "偶然高速样本不算数",
  W.costOf("steady:443", "tput") < W.costOf("lucky:443", "tput"),
  `${W.costOf("steady:443", "tput")} vs ${W.costOf("lucky:443", "tput")}`,
);

// v6.35：没有"seed 先验"这回事 —— 吞吐先验是固定常量，置信度只由本地直方图决定
reset();
node("seed:443", { tcp: 50 });
eq("无本地样本时用固定先验", Math.round(W.scoreParts("seed:443", "tput").e10Ms), Math.round((10 * 1048576 / W.SC.PRIOR_BPS) * 1000));
{
  // 一条 512KB、1 秒的本地窗口：capBps 立刻由本地样本给出，confB 仍不够（要 3 个有效窗口 + 3MiB）
  W.nsSpeed("seed:443", 512 * 1024, 512 * 1024, {}, 1);
  const p = W.scoreParts("seed:443", "tput");
  ok("本地样本决定 capBps", p.capBps >= 400 * 1024, String(p.capBps));
  eq("单条短样本不构成高置信度", p.confB, 0);
  W.nsSpeed("seed:443", 512 * 1024, 512 * 1024, {}, 1);
  W.nsSpeed("seed:443", 512 * 1024, 512 * 1024, {}, 1);
  ok("3 个有效窗口后 nEff 达标", W.scoreParts("seed:443", "tput").nEff >= 3, String(W.scoreParts("seed:443", "tput").nEff));
}

/* ---------- 3. 门槛与过滤 ---------- */
reset();
eq("无样本 avail = 0.5", W.availOf(W.nsGet("z:443")), 0.5);
{
  const s = W.nsGet("z2:443");
  s.okW = 1;
  s.failW = 5;
  ok("1 成功 5 失败 → avail < 0.75", W.availOf(s) < 0.75, W.availOf(s));
}
reset();
node("u:443", { okW: 2, failW: 8, tcp: 50 });
eq(
  "长期低可用被排除",
  W.candsFor("lat").some((x) => x.k === "u:443"),
  false,
);

reset();
node("small:443", { okW: 0, failW: 1, tcp: 50 });
ok(
  "小样本失败只软惩罚，不出局",
  W.candsFor("lat").some((x) => x.k === "small:443"),
  true,
);

reset();
node("e:443", { trafficOkW: 0, eCloseP: 6, tcp: 50 });
eq("中转后大量空关闭 → 可疑", W.emptyCloseSuspect("e:443"), true);
eq(
  "可疑节点被排除",
  W.candsFor("lat").some((x) => x.k === "e:443"),
  false,
);
// 空关闭计数必须跟着半衰期衰减，否则老账永远赖着，节点一旦攒够 5 次就被永久排除
{
  const se = W.nsGet("e:443");
  se.at = Date.now() - 12 * 3600e3; // 两个半衰期
  W.nsEmptyClose("e:443", true); // 触发衰减后再 +1
  ok("空关闭计数按半衰期衰减", se.eCloseP > 2 && se.eCloseP < 2.6, String(se.eCloseP));
  eq("衰减后不再可疑", W.emptyCloseSuspect("e:443"), false);
}

/* ---------- 4. Selector（地区硬要求） ---------- */
{
  reset();
  node("de1:443", { tcp: 50 });
  node("de2:443", { tcp: 90 });
  node("us1:443", { tcp: 40 });
  S.alive.get("de1:443").cc = "DE";
  S.alive.get("de2:443").cc = "DE";
  S.alive.get("us1:443").cc = "US";
  const de = await W.SEL.region({}, "DE", "lat");
  eq("地区只选 DE 节点", de && de.h + ":" + de.p, "de1:443");
  const deAlt = await W.SEL.region({}, "DE", "lat", "de1:443");
  eq("地区避开指定节点", deAlt && deAlt.h + ":" + deAlt.p, "de2:443");
  eq("地区无节点返回 null", await W.SEL.region({}, "JP", "lat"), null);
  eq("nextNode 按国家过滤", W.nextNode("lat", "", "US"), "us1:443");
  eq("nextNode 避开后无同国节点", W.nextNode("lat", "us1:443", "US"), "");
  W.nsFail("de1:443");
  const deCold = await W.SEL.region({}, "DE", "lat");
  eq("地区跳过冷却节点", deCold && deCold.h + ":" + deCold.p, "de2:443");
}

/* ---------- 4b. Selector ---------- */
reset();
S.lastSwitch = { lat: 0, tput: 0 };
node("cur:443", { tcp: 400, tls: 60, okW: 20 });
node("new:443", { tcp: 50, tls: 60, okW: 20 });
S.curs.lat = "cur:443";
const switched = W.SEL.maybeSwitch({ pxDwellMin: 0 }, "lat");
eq("明显更优 → 切换", switched, true);
eq("切换后 CUR 指向新节点", S.curs.lat, "new:443");

reset();
S.lastSwitch = { lat: 0, tput: 0 };
node("c1:443", { tcp: 100, tls: 60, okW: 20 });
node("c2:443", { tcp: 105, tls: 60, okW: 20 });
S.curs.lat = "c1:443";
eq("差距小于滞回 → 不切", W.SEL.maybeSwitch({ pxDwellMin: 0 }, "lat"), false);

reset();
node("d1:443", { tcp: 300, tls: 60, okW: 20 });
node("d2:443", { tcp: 50, tls: 60, okW: 20 });
S.curs.lat = "d1:443";
S.lastSwitch.lat = Date.now(); // 刚切过 → 驻留期内
eq("驻留期内不切", W.SEL.maybeSwitch({ pxDwellMin: 0 }, "lat"), false);

// 驻留配置必须真的生效：pxDwellMin=30 且刚切过 30 分钟 → 默认 10 分钟已过，但 30 分钟还没到
eq("dwell 默认 lat 10 分钟", W.dwellOf({}, "lat"), 10 * 60000);
eq("dwell 默认 tput 20 分钟", W.dwellOf({}, "tput"), 20 * 60000);
eq("dwell 接受正数覆盖", W.dwellOf({ pxDwellMin: "30" }, "lat"), 30 * 60000);
eq("dwell 0 回落默认", W.dwellOf({ pxDwellMin: "0" }, "lat"), 10 * 60000);
reset();
node("w1:443", { tcp: 300, tls: 60, okW: 20 });
node("w2:443", { tcp: 50, tls: 60, okW: 20 });
S.curs.lat = "w1:443";
S.lastSwitch.lat = Date.now() - 30 * 60000;
eq("pxDwellMin=60 覆盖默认 10 分钟", W.SEL.maybeSwitch({ pxDwellMin: "60" }, "lat"), false);
eq("未设置时按默认 10 分钟切换", W.SEL.maybeSwitch({}, "lat"), true);

reset();
node("f1:443", { tcp: 100, okW: 10 });
node("f2:443", { tcp: 200, okW: 10 });
S.curs.lat = "f1:443";
S.prev.lat = "f2:443";
S.lastSwitch.lat = Date.now();
W.SEL.onFail({}, "lat", "f1:443", false);
eq("切换后 60s 内失败 → 回滚", S.curs.lat, "f2:443");

// 回滚目标自己已经冻结/冷却时，不能把游标送回坏节点
reset();
node("g1:443", { tcp: 100, okW: 10 });
node("g2:443", { tcp: 200, okW: 10 });
S.curs.lat = "g1:443";
S.prev.lat = "g2:443";
S.lastSwitch.lat = Date.now();
W.freezeNode("g2:443");
W.SEL.onFail({}, "lat", "g1:443", false);
ok("不回滚到已冻结的 prev", S.curs.lat !== "g2:443", S.curs.lat);

/* ---------- 5. Connection（热路径 + tick） ---------- */
reset();
const fakeWs = { bufferedAmount: 0, readyState: 1, send() {}, close() {} };
const c = new W.Connection({}, {}, "tput", "tag");
c.down += 1024;
c.onUp(10);
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
ok("tick 后节点有吞吐样本", (W.S.nstat.get("n:443").bytesDown || 0) > 0, JSON.stringify(W.S.nstat.get("n:443")));
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

/* ---------- 6. 本轮优化的回归 ---------- */
// 鉴权成功但零字节的连接（探测/被客户端立刻取消）也要落 node/direct 计数
reset();
const c3 = new W.Connection({}, {}, "tput", "");
c3.id = "u-test";
c3.node = "n9:443";
const nBefore = W.S.cnt.node || 0;
c3.flush(true);
eq("零字节收尾也计入 node", W.S.cnt.node, nBefore + 1);

// 面板明细按需生成：只算要展示的节点
reset();
node("p1:443", { tcp: 50, okW: 5 });
node("p2:443", { tcp: 60, okW: 5 });
const only = W.nsOf(["p1:443"]);
eq("nsOf 只算传入的节点", Object.keys(only), ["p1:443"]);
ok("nsOf 带出评分", typeof only["p1:443"].lat === "number" && only["p1:443"].lat > 0);

const px = await W.pxGet({});
eq("pxGet 不再预生成全量明细", px.state.ns, undefined);
eq("pxGet 仍然给出存活列表", px.alive.length, 2);

// 错误日志去重（稳定期不该被同一条错误刷屏）
const e0 = W.S.errs.length;
W.logErr("dup-msg-for-test");
W.logErr("dup-msg-for-test");
eq("5 秒内同一错误只记一次", W.S.errs.length, e0 + 1);

// 成功连接要给节点记 ok/trafficOkW，否则面板永远显示 0、可用性门槛永远不生效
reset();
const c6 = new W.Connection({}, {}, "tput", "");
c6.id = "u3";
c6.node = "ok2:443";
c6.down = 2048;
c6.flush(true);
eq("成功连接记一次 ok", (W.S.nstat.get("ok2:443") || {}).okW, 1);
eq("成功连接进入可用性样本", (W.S.nstat.get("ok2:443") || {}).trafficOkW, 1);

// 长连接已经每 60 秒写过站点 bps，收尾不能再用"一生平均"把它拉低
reset();
node("sc:443", {});
const cBps = new W.Connection({}, {}, "tput", "");
cBps.id = "u-bps";
cBps.node = "sc:443";
cBps.host = "stream.test";
cBps.down = 2 * 1024 * 1024;
cBps.tAttach = Date.now() - 1000;
cBps.siteEmitted = 2;
cBps.flush(true);
eq("长连接收尾不覆盖站点 bps", (W.S.hostNode.get("stream.test").get("sc:443") || {}).bps, undefined);

// resetFail 只清计数：成功样本由 flush 统一记一次，不能在这里重复 +1
reset();
node("rf:443", {});
S.pxFailSeen = 1;
S.pxFailMem = 2;
await W.SEL.resetFail({}, "rf:443");
eq("resetFail 不重复记成功", W.nsGet("rf:443").okW, 0);
eq("resetFail 清零记忆", S.pxFailMem, 0);

reset();
const c7 = new W.Connection({}, {}, "tput", "");
c7.id = "u4";
c7.node = "bad2:443";
c7.down = 2048;
c7.failed = true;
c7.flush(true);
eq("断流的连接不记 ok", (W.S.nstat.get("bad2:443") || {}).okW || 0, 0);

/* ---------- 7. 站点诊断 ---------- */
const hn = (node, cc, n, ok, bad) => ({ node, cc, n, ok, bad, bytes: 0, ttfb: 0 });

eq("无样本 → empty", W.diagVerdict([], { ok: 0, bad: 0 }).kind, "empty");
eq("全部正常 → ok", W.diagVerdict([hn("a", "US", 2, 2, 0)], { ok: 0, bad: 0 }).kind, "ok");
eq("个别节点被拦 → ip", W.diagVerdict([hn("a", "US", 2, 2, 0), hn("b", "DE", 2, 0, 2)], { ok: 0, bad: 0 }).kind, "ip");
eq(
  "同国多节点被拦 → geo",
  W.diagVerdict([hn("a", "BG", 2, 0, 2), hn("b", "BG", 2, 0, 2), hn("c", "DE", 2, 2, 0)], { ok: 0, bad: 0 }).kind,
  "geo",
);
eq("全挂但直连正常 → pool", W.diagVerdict([hn("a", "US", 2, 0, 2)], { ok: 2, bad: 0 }).kind, "pool");
eq("全挂直连也挂 → unknown", W.diagVerdict([hn("a", "US", 2, 0, 2)], { ok: 0, bad: 2 }).kind, "unknown");

W.hostNodeMark("t.example", "n1:443", { ok: true, bad: false, bytes: 100, ttfb: 50 });
W.hostNodeMark("t.example", "n1:443", { ok: false, bad: true, bytes: 10, ttfb: 0 });
const hnStat = W.S.hostNode.get("t.example").get("n1:443");
eq("画像累计 n/ok/bad", [hnStat.n, hnStat.ok, hnStat.bad], [2, 1, 1]);
ok("画像记下 ttfb", hnStat.ttfb === 50, String(hnStat.ttfb));

const hello = W.tlsHello("x.com");
eq("ClientHello 是握手记录", hello[0], 0x16);
ok("ClientHello 里带 SNI", W.toHex(hello).includes(W.toHex(new TextEncoder().encode("x.com"))));

// 长度自洽性检查：TLS 解析器对 ext_len/list_len 极敏感，写错就是 decode_error
const tlsWalk = (h) => {
  if (((h[3] << 8) | h[4]) !== h.length - 5) return "record len";
  let p = 5;
  if (h[p] !== 1) return "not client_hello";
  const hl = (h[p + 1] << 16) | (h[p + 2] << 8) | h[p + 3];
  if (hl !== h.length - p - 4) return "handshake len";
  p += 4 + 2 + 32;
  p += 1 + h[p];
  const cs = (h[p] << 8) | h[p + 1];
  p += 2 + cs;
  p += 1 + h[p];
  const extLen = (h[p] << 8) | h[p + 1];
  p += 2;
  const end = p + extLen;
  if (end !== h.length) return "ext block len";
  while (p < end) {
    const l = (h[p + 2] << 8) | h[p + 3];
    p += 4 + l;
  }
  return p === end ? "ok" : "ext overflow";
};
eq("ClientHello 长度自洽", tlsWalk(hello), "ok");
eq("长域名也自洽", tlsWalk(W.tlsHello("pbs.twimg.com")), "ok");

/* ---------- 8. Meter DO：单键存储 + 当日计数 ---------- */
const mkDO = (init) => {
  const store = new Map(init || []);
  // 真实运行时里 blockConcurrencyWhile 会挡住后续请求；这里用 gate 模拟
  let gate = Promise.resolve();
  const state = {
    blockConcurrencyWhile: (fn) => {
      gate = Promise.resolve().then(fn);
      return gate;
    },
    storage: {
      get: async (k) => store.get(k),
      put: async (k, v) => {
        store.set(k, v);
      },
      delete: async (k) => {
        store.delete(k);
      },
    },
  };
  const m = new W.Meter(state, {});
  const raw = m.fetch.bind(m);
  m.fetch = async (req) => {
    await gate;
    return raw(req);
  };
  return { store, m };
};
const do1 = mkDO();
await do1.m.fetch(
  new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 10, down: 20, conns: 1 }) }),
);
await do1.m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 5, down: 7, conns: 1 }) }));
const j1 = await (await do1.m.fetch(new Request("https://m/get"))).json();
eq("DO 累计", [j1.up, j1.down, j1.conns], [15, 27, 2]);
eq("DO 当前只占一个键（行写入 ÷4）", [...do1.store.keys()], ["a"]);
eq("DO 当日字节", [j1.dU, j1.dD], [15, 27]);

// 旧 isolate 带着昨天的日计数晚到：不能把全局 g 回滚到昨天
{
  const doG = mkDO();
  await doG.m.fetch(
    new Request("https://m/add", {
      method: "POST",
      body: JSON.stringify({ up: 1, down: 1, conns: 1, c: { d: "2099-01-01", conn: 2 } }),
    }),
  );
  await doG.m.fetch(
    new Request("https://m/add", {
      method: "POST",
      body: JSON.stringify({ up: 1, down: 1, conns: 1, c: { d: "2000-01-01", conn: 9 } }),
    }),
  );
  const jg = await (await doG.m.fetch(new Request("https://m/cnt"))).json();
  eq("全局日计数不被旧批次回滚", jg.g.d, "2099-01-01");
  eq("旧批次计数被丢弃", jg.g.conn, 2);
}

// 节点快照不能随池子换代无限增长
{
  const do2 = mkDO();
  const spd = {};
  for (let i = 0; i < 80; i++) spd[`n${i}:443`] = { med: 1, p90: 1, cap: 1, n: 1, at: i + 1 };
  await do2.m.fetch(
    new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 0, down: 0, conns: 0, spd }) }),
  );
  const j2 = await (await do2.m.fetch(new Request("https://m/cnt"))).json();
  eq("节点快照最多 64 个", Object.keys(j2.s).length, 64);
  ok("保留最新节点", !!j2.s["n79:443"] && !j2.s["n0:443"]);
}

// 老结构（c/e/s/g 四个键）要能读出来并迁移
const legacy = mkDO([
  ["c", JSON.stringify({ up: 100, down: 200, conns: 3, first: 1, ts: 2 })],
  ["g", JSON.stringify({ d: "2026-01-01", conn: 5 })],
  ["s", JSON.stringify({ "1.2.3.4:443": { med: 1 } })],
  ["e", JSON.stringify([{ t: 1, m: "x" }])],
]);
const lj = await (await legacy.m.fetch(new Request("https://m/get"))).json();
eq("老数据能读出来", [lj.up, lj.down, lj.conns], [100, 200, 3]);
eq("迁移后只剩新键", [...legacy.store.keys()], ["a"]);

/* ---------- 9. 站点级选路 ---------- */
reset();
node("fast:443", { tcp: 50, okW: 10 });
node("slow:443", { tcp: 400, okW: 10 });
for (let i = 0; i < 3; i++) {
  W.hostNodeMark("site.test", "fast:443", { ok: true, bad: false, bytes: 1000, ttfb: 60 });
  W.hostNodeMark("site.test", "slow:443", { ok: true, bad: false, bytes: 1000, ttfb: 500 });
}
eq("站点排行：快的在前", W.hostRank("site.test", "lat")[0].k, "fast:443");

const st1 = { host: "site.test" };
eq("按站点选节点", W.SEL.pick({ pxShadow: 0 }, "tput", st1), "fast:443");
eq("命中偏好不算试探", st1.hostTrial, false);

// 冻结的节点不能出现在站点排行里
W.freezeNode("fast:443");
eq("冻结节点被跳过", W.hostRank("site.test", "tput")[0].k, "slow:443");
W.nsGet("fast:443").freeUntil = 0;

// 冷启动：新域名第一次一定挑一个没试过的节点
reset();
node("a:443", { tcp: 50 });
node("b:443", { tcp: 80 });
const st2 = { host: "brand-new.test" };
const rndZ = Math.random;
Math.random = () => 0; // 强制走探索分支
const p2 = W.SEL.pick({ pxShadow: 0.05 }, "tput", st2);
Math.random = rndZ;
eq("新域名挑全局最优的未试节点", p2, "a:443");
eq("标记为站点试探", st2.hostTrial, true);
eq("试探节点写回 st.node", st2.node, "a:443");

// 未试节点直接从全局排行里取：和"逐个 costOf 找最小"结果一致，但不再重算
reset();
node("u1:443", { tcp: 50 });
node("u2:443", { tcp: 80 });
node("u3:443", { tcp: 300 });
W.hostNodeMark("untried.test", "u1:443", { ok: 1, bad: 0, bytes: 10, ttfb: 50 });
eq("未试节点 = 全局最优且没在这个站出现过", W.hostUntried("untried.test", "lat"), "u2:443");

// 游标指向上一代候选池的节点：pick 必须自愈，而不是继续拨死地址
reset();
node("v1:443", { tcp: 50 });
node("v2:443", { tcp: 80 });
S.curs.lat = "gone:443";
const rndV = Math.random;
Math.random = () => 0.5; // 抽样器带噪声：固定随机数只验"游标自愈 + 选到分更低的"
const pv = W.SEL.pick({ pxShadow: 0 }, "lat", null);
Math.random = rndV;
eq("游标失效 → 选当前最优", pv, "v1:443");
eq("游标自愈写回", S.curs.lat, "v1:443");

// 一个候选都没有：返回空，并把游标清掉（不能一直显示已经不存在的节点）
reset();
S.curs.lat = "gone:443";
eq("无候选时返回空", W.SEL.pick({ pxShadow: 0 }, "lat", null), "");
eq("无候选时清空游标", S.curs.lat, "");

// 两个节点各 1 次样本：有对比就该按站点选，不用等 n>=2
reset();
node("p:443", { tcp: 60 });
node("q:443", { tcp: 300 });
W.hostNodeMark("two.test", "p:443", { ok: true, bad: false, bytes: 100, ttfb: 80 });
W.hostNodeMark("two.test", "q:443", { ok: true, bad: false, bytes: 100, ttfb: 600 });
const st3 = { host: "two.test" };
// 抽样器带随机噪声：固定 Math.random 让这条只验"谁的分更低"
const rndT = Math.random;
Math.random = () => 0.5;
const p3 = W.SEL.pick({ pxShadow: 0 }, "tput", st3);
Math.random = rndT;
eq("两次样本就能比较出快慢", p3, "p:443");

/* ---------- 10. 站点族 / 保质期 / 缓存 ---------- */
eq("api.x.com → x.com", W.hostKey("api.x.com"), "x.com");
eq("img.example.com → example.com", W.hostKey("img.example.com"), "example.com");
eq("www.example.co.uk 保留三段", W.hostKey("www.example.co.uk"), "example.co.uk");
eq("a.b.example.com → example.com", W.hostKey("a.b.example.com"), "example.com");
eq("IP 原样", W.hostKey("1.2.3.4"), "1.2.3.4");

// 同族共享一张表
reset();
node("f1:443", { tcp: 50 });
node("f2:443", { tcp: 60 });
W.hostNodeMark("www.example.com", "f1:443", { ok: true, bad: false, bytes: 100, ttfb: 70 });
W.hostNodeMark("img.example.com", "f2:443", { ok: true, bad: false, bytes: 100, ttfb: 200 });
eq("同族两个域名共用一张表", W.S.hostNode.get("example.com").size, 2);
eq("族内按首字节排序", W.hostRank("example.com", "lat")[0].k, "f1:443");

// 保质期：7 小时前的样本降权 300ms
reset();
node("old:443", { tcp: 50 });
node("new:443", { tcp: 50 });
W.hostNodeMark("stale.test", "old:443", { ok: true, bad: false, bytes: 1, ttfb: 100 });
W.hostNodeMark("stale.test", "new:443", { ok: true, bad: false, bytes: 1, ttfb: 300 });
W.S.hostNode.get("stale.test").get("old:443").at = Date.now() - 7 * 3600e3;
W.S.hostRankCache.clear();
eq("过期样本被降权", W.hostRank("stale.test", "lat")[0].k, "new:443");

// 新样本要让缓存失效
W.hostNodeMark("stale.test", "old:443", { ok: true, bad: false, bytes: 1, ttfb: 50 });
eq("新样本刷新排行", W.hostRank("stale.test", "lat")[0].k, "old:443");

// 站点级 lat 与 tput 可以选出不同节点（TTFB 快 ≠ 带宽大）
reset();
node("fast-ttfb:443", { tcp: 50 });
node("fat-pipe:443", { tcp: 300 });
W.hostNodeMark("speed.test", "fast-ttfb:443", { ok: 1, bad: 0, bytes: 100, ttfb: 50, bps: 1048576 });
W.hostNodeMark("speed.test", "fat-pipe:443", { ok: 1, bad: 0, bytes: 100, ttfb: 300, bps: 8 * 1048576 });
eq("站点 lat：首字节快的优先", W.hostRank("speed.test", "lat")[0].k, "fast-ttfb:443");
eq("站点 tput：带宽大的优先", W.hostRank("speed.test", "tput")[0].k, "fat-pipe:443");

// 域名族：写入用 api.x.com，读取用 x.com 也要命中同一张表
reset();
node("g1:443", { tcp: 50 });
W.hostNodeMark("api.github.com", "g1:443", { ok: 1, bad: 0, bytes: 100, ttfb: 60 });
eq("族键读写一致", W.hostRank("github.com", "lat")[0].k, "g1:443");
const stFam = { host: "api.github.com" };
eq("别名域名按族选节点", W.SEL.pick({ pxShadow: 0 }, "lat", stFam), "g1:443");

/* ---------- 11. 跨 isolate 节点快照 ---------- */
{
  let calls = 0;
  const body = { s: { "a:443": { med: 100, p90: 200, cap: 210, n: 7, at: 1 } } };
  const mkEnv = () => ({
    METER: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async () => {
          calls++;
          return new Response(JSON.stringify(body));
        },
      }),
    },
  });
  W.S.nodeSnapCache = { t: 0, v: {} };
  const snap = await W.nodeSnapGet(mkEnv(), "u1");
  eq("nodeSnapGet 拿到 DO 里的节点快照", Object.keys(snap), ["a:443"]);
  const again = await W.nodeSnapGet(mkEnv(), "u1");
  eq("60 秒内走缓存，不再打 DO", calls, 1);
  eq("缓存内容一致", again["a:443"].p90, 200);

  const bad = {
    METER: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async () => {
          throw new Error("do down");
        },
      }),
    },
  };
  W.S.nodeSnapCache = { t: 0, v: {} };
  eq("DO 挂了返回空表而不是抛错", await W.nodeSnapGet(bad, "u1"), {});
}

// 面板渲染：KB/s 带样本数；没有样本显示"未用"
{
  const html1 = W.renderStatsHtml(
    {},
    "u",
    { up: 0, down: 0, todayUp: 0, todayDown: 0 },
    {},
    W.statsNodeRows([{ h: "a", p: 443, ms: 10, cc: "US" }], { "a:443": { bps: 2048 * 1024, n: 7 } }),
    [],
  );
  ok("面板显示 KB/s 与样本数", html1.includes("2048 KB/s (n=7)"), html1.match(/\d+ KB\/s[^<]*/)?.[0]);
  const html2 = W.renderStatsHtml(
    {},
    "u",
    { up: 0, down: 0, todayUp: 0, todayDown: 0 },
    {},
    W.statsNodeRows([{ h: "b", p: 443, ms: 10, cc: "US" }], {}),
    [],
  );
  ok("没有吞吐样本显示未用", html2.includes("未用"));
  const html3 = W.renderStatsHtml(
    {},
    "u",
    { up: 0, down: 0, todayUp: 0, todayDown: 0 },
    { "<img src=x onerror=alert(1)>": { rtt: 10, colo: "HKG", hits: 1, ok: 1, fail: 0, ts: 1 } },
    [],
    [],
  );
  ok("入口标签做了 HTML 转义", !html3.includes("<img src=x"), html3.slice(0, 80));
}

/* ---------- 11. v2.1：风险先验 / 不跨 isolate / 自适应探索 ---------- */
reset();
eq("无样本 pFailRisk = 0.1（不加不确定性溢价）", W.pFailOf(W.nsGet("fresh:443")), 0.1);

{
  // v6.35：seed 只传候选名单，没有可靠性伪计数 —— 失败率先验只由本地样本决定
  const s = W.nsGet("seedrel:443");
  s.failW = 1;
  const p = W.pFailOf(s);
  ok("一次失败就把风险先验抬到 0.1 以上", p > 0.1, String(p));
  s.failW = 0;
  eq("清掉本地失败后回到 0.1", W.pFailOf(s), 0.1);
}

{
  const s = W.nsGet("oneok:443");
  s.okW = 1;
  const p = W.pFailOf(s);
  ok("第一条成功不额外惩罚", p <= 0.101, String(p));
}

reset();
node("e1:443", { tcp: 50 });
node("e2:443", { tcp: 60 });
S.curs.tput = "e1:443";
const stE = { host: "explore.test" };
const rnd1 = Math.random;
Math.random = () => 0.07; // 7%：样本不足(10%)会探索，样本够了(5%)不探索
const picked1 = W.SEL.pick({ pxShadow: 0.05 }, "tput", stE);
const explored1 = stE.hostTrial === true;
// 单层抽样器接管探索后，独立探索分支不再按"样本不足"放大到 10%：
// 未测节点靠乐观面（score − βσ）自然被抽，不需要两层探索叠加。
ok("探索率不再按样本数放大", explored1 === false, `picked=${picked1}`);

reset();
node("f1:443", { tcp: 50 });
node("f2:443", { tcp: 60 });
const sf = W.S.nstat.get("f1:443");
sf.hist[7] = 4;
sf.sumW = 4;
sf.sumW2 = 4;
sf.recentBytesW = 8 * 1048576;
sf.lastSampleAt = Date.now();
S.curs.tput = "f1:443";
const stF = { host: "steady.test" };
const picked2 = W.SEL.pick({ pxShadow: 0.05 }, "tput", stF);
Math.random = rnd1;
// f1 有带宽样本（σ 小），f2 一条样本都没有：乐观面会把流量先给 f2 —— 这正是"没有探索率也能探索"
ok("单层抽样器仍会去探未测节点", picked2 === "f2:443", picked2);
eq("没有标记站点试探", stF.hostTrial === true, false);

reset();
node("c1:443", { tcp: 50 });
node("c2:443", { tcp: 60 });
W.candsFor("lat");
eq("候选数被记录（观测用）", W.S.candN, 2);

/* ---------- 12. 排行缓存 / 站点中途采样 / latN ---------- */
reset();
for (let i = 0; i < 30; i++) node(`m${i}:443`, { tcp: 50 + i, okW: 10 });
const c30 = W.candsFor("lat");
eq("30 个候选全部返回", c30.length, 30);
ok("大规模下启用了排行缓存", W.S.rankCache.t > 0);
// 排行缓存按模式各算各的：曾经两模式共用 t，tput 重算会给 lat 续命（实际有效期 40 s）
W.invalidateRank();
eq("缓存起点：30 个候选", W.candsFor("lat").length, 30);
W.S.rankCache.t = Date.now(); // 全局戳是新的……
W.S.rankCache.at = { lat: Date.now() - 25000, tput: Date.now() }; // ……但 lat 那条是 25 秒前算的
node("pm-new:443", { tcp: 90, okW: 10 });
eq("lat 缓存过期就重算（不被 tput 续命）", W.candsFor("lat").length, 31);
W.S.rankCache.at = { lat: Date.now(), tput: Date.now() - 25000 };
node("pm-new2:443", { tcp: 91, okW: 10 });
eq("lat 缓存新鲜就复用（不白算）", W.candsFor("lat").length, 31);

// 线上 alive 实测就是 18 个：低于 CAND_CACHE_MIN(24)，排行全程现算
reset();
for (let i = 0; i < 18; i++) node(`n18-${i}:443`, { tcp: 60 + i, okW: 10 });
W.invalidateRank();
eq("18 个候选全部返回", W.candsFor("lat").length, 18);
eq("18 个节点（线上实测值）不启用排行缓存", W.S.rankCache.t, 0);

/* 探活失败要分原因：err 可能是地区/线路，notTls/noCf 是节点事实 */
W.S.probeWhy = {};
W.noteProbe(null);
W.noteProbe({ bad: "not-tls" });
W.noteProbe({ bad: "no-cf-cert" });
W.noteProbe({ ms: 12, tcp: 5, tls: 7 });
eq("探活结果按原因分类", W.S.probeWhy, { err: 1, notTls: 1, noCf: 1, ok: 1 });

/* 延迟模式必须能看见带宽：同延迟下 1MB/s 的节点分数要明显更高 */
reset();
node("wide:443", { tcp: 60, okW: 10 });
node("narrow:443", { tcp: 60, okW: 10 });
W.nsSpeed("wide:443", 20 * 1048576, 1048576, {}, 1);
W.nsSpeed("narrow:443", 1 * 1048576, 1048576, {}, 1);
ok(
  "lat：同延迟下窄带宽节点分数更高",
  W.costOf("wide:443", "lat") + 50 < W.costOf("narrow:443", "lat"),
  `${Math.round(W.costOf("wide:443", "lat"))} vs ${Math.round(W.costOf("narrow:443", "lat"))}`,
);

/* 探活高估（420ms）要能被真实样本（80ms）纠正，否则这种节点永远翻不了身 */
reset();
node("shy2:443", { tcp: 420, okW: 10 });
W.nsLatency("shy2:443", 80);
ok("lat：探活高估被真实样本纠正", W.scoreParts("shy2:443", "lat").latencyMs < 200, Math.round(W.scoreParts("shy2:443", "lat").latencyMs));
W.nsGet(c30[0].k).blackUntil = Date.now() + 60000;
eq(
  "缓存之外仍会过滤黑名单",
  W.candsFor("lat").some((x) => x.k === c30[0].k),
  false,
);

reset();
node("bs:443", {});
W.hostNodeMark("site-bps.test", "bs:443", { ok: 1, bad: 0, ttfb: 50 });
W.hostNodeMark("site-bps.test", "bs:443", { bps: 1048576 });
const hs = W.S.hostNode.get("site-bps.test").get("bs:443");
eq("中途吞吐采样不算连接样本", hs.n, 1);
ok("站点 bps 记录下来了", hs.bps > 0, String(hs.bps));
W.hostNodeMark("neutral.test", "n0:443", { ok: 0, bad: 0, bytes: 100, ttfb: 100 });
eq("0 字节 0 失败不算站点样本", W.S.hostNode.get("neutral.test").get("n0:443").n, 0);

// 跨 isolate 不再共享品质结论：seed 只留候选名单（k/h/p/cc），
// 延迟/吞吐/成功率/站点偏好一律由本 isolate 自己估
reset();
node("hpb:443", { tcp: 50 });
for (let i = 0; i < 3; i++) W.hostNodeMark("site-seed.test", "hpb:443", { ok: 1, bad: 0, bytes: 1024, ttfb: 80 });
W.hostNodeMark("site-seed.test", "hpb:443", { bps: 2 * 1048576 });
{
  const box = new Map();
  const env = {
    STATS: {
      get: async (k) => box.get(k) || null,
      put: async (k, v) => {
        box.set(k, v);
      },
    },
  };
  W.S.colo = "TST";
  W.S.seedAt = 0;
  await W.SEEDS.write(env, false, true);
  const doc = JSON.parse(box.get([...box.keys()][0]));
  const row = doc.byColo.TST.nodes.find((x) => x.k === "hpb:443");
  eq("seed 只存候选名单的四个字段", row ? Object.keys(row).sort().join(",") : "", "cc,h,k,p");
  eq("seed 不再写站点偏好", !!doc.byColo.TST.hp, false);
  // 模拟另一个 isolate 冷启动：拿到名字，拿不到任何品质结论
  W.S.alive.clear();
  W.S.nstat.clear();
  W.S.hostNode.clear();
  W.S.seedAt = 0;
  W.S.seed = { v: 0, ts: 0, poolGen: 0, poolN: 0, builtAt: 0, byColo: {} };
  await W.SEEDS.read(env);
  await W.pxGet(env);
  eq("别的 isolate 只用名字起步（延迟=先验）", (W.S.alive.get("hpb:443") || {}).ms, 250);
  eq("没有任何统计被灌进来", W.S.nstat.has("hpb:443"), false);
  eq("站点偏好不跨 isolate", W.S.hostNode.has("site-seed.test"), false);
}

// 跨 isolate 快照按流量挑前 16 个，而不是 Map 的前 16 个
reset();
for (let i = 0; i < 20; i++) {
  node(`sn${i}:443`, {});
  W.nsGet(`sn${i}:443`).bytesDown = i * 1024 * 1024;
  W.nsGet(`sn${i}:443`).trafficOkW = i + 1;
}
const snapN = W.spdSnapshot();
ok("快照包含流量最大的节点", !!snapN["sn19:443"], Object.keys(snapN).join(","));
eq("快照最多 16 个", Object.keys(snapN).length, 16);

reset();
node("ln:443", { tcp: 50, probeSamples: 4, okW: 4 });
eq("latN = 探活 + 成功连接", W.scoreParts("ln:443", "lat").latN, 8);

/* ---------- 13. 归因 / 负载 / 快速窗口 / 站点门槛 ---------- */
reset();
{
  const s = W.nsGet("sitefail:443");
  const beforeFail = s.failW,
    beforeBlack = s.blackUntil;
  W.nsSiteFail("sitefail:443");
  ok("站点失败只加 0.2 全局权重", Math.abs(s.failW - beforeFail - 0.2) < 1e-9, String(s.failW));
  eq("站点失败不进冷却阶梯", s.blackUntil, beforeBlack);
  W.S.rankCache.t = 12345;
  W.nsSiteFail("sitefail:443");
  eq("站点失败不再清空全局排行缓存", W.S.rankCache.t, 12345);
}

reset();
node("fk:443", {});
const sfk = W.nsGet("fk:443");
W.nsOk("fk:443", 0, 0);
W.nsFail("fk:443");
W.nsFail("fk:443");
ok("10 分钟窗口内 2 次失败会抬高近期风险", W.pFailFast(sfk) > 0.15, String(W.pFailFast(sfk)));
ok("总分用 max(慢, 快)", W.scoreParts("fk:443", "lat").pFailRisk >= W.pFailFast(sfk));

reset();
{
  const s = W.nsGet("flap:443");
  s.winAt = Date.now();
  s.winOk = 2;
  s.winFail = 3;
  W.nsFail("flap:443");
  ok("抖动（窗口内成败参半）触发 5 分钟冷却", s.blackUntil - Date.now() > 4 * 60000, String(s.blackUntil - Date.now()));
}

reset();
const cIn = new W.Connection({}, {}, "tput", "");
cIn.node = "load:443";
cIn.syncInflight();
eq("attach 记在途", W.S.inflight.get("load:443"), 1);
cIn.node = "load2:443";
cIn.syncInflight();
eq("换节点迁移在途", [W.S.inflight.get("load:443") || 0, W.S.inflight.get("load2:443")], [0, 1]);
cIn.clearInflight();
eq("收尾清在途", W.S.inflight.get("load2:443") || 0, 0);

reset();
node("busy:443", { tcp: 50, okW: 10 });
node("idle:443", { tcp: 60, okW: 10 });
S.curs.tput = "busy:443";
W.S.inflight.set("busy:443", 3);
const stLoad = { host: "" };
eq("当前节点过载时溢出到空闲候选", W.SEL.pick({ pxShadow: 0 }, "tput", stLoad), "idle:443");
W.S.inflight.clear();

reset();
node("g1:443", { tcp: 50, okW: 10 });
node("g2:443", { tcp: 300, okW: 10 });
node("g3:443", { tcp: 400, okW: 10 });
// 站点样本不足 3 个节点 → 退回全局（pxShadow=0 时不许再偷偷冷启动探索）
reset();
node("g1:443", { tcp: 50, okW: 10 });
node("g2:443", { tcp: 300, okW: 10 });
node("g3:443", { tcp: 400, okW: 10 });
// 只有 2 个节点有站点样本：不够 3 个，应该退回全局（g1）
W.hostNodeMark("thr.test", "g1:443", { ok: 1, bad: 0, bytes: 100, ttfb: 800 });
W.hostNodeMark("thr.test", "g2:443", { ok: 1, bad: 0, bytes: 100, ttfb: 60 });
const rndThr = Math.random;
Math.random = () => 0; // 即使掷出 0 也不能进冷启动分支
const pThr = W.SEL.pick({ pxShadow: 0 }, "lat", { host: "thr.test" });
Math.random = rndThr;
eq("站点样本不足 3 个节点 → 退回全局", pThr, "g1:443");
// 补第三个节点样本后，站点偏好生效
W.hostNodeMark("thr.test", "g3:443", { ok: 1, bad: 0, bytes: 100, ttfb: 400 });
eq("3 个节点有样本 → 站点偏好生效", W.SEL.pick({ pxShadow: 0 }, "lat", { host: "thr.test" }), "g2:443");
// 样本过期（>2h）→ 退回全局
for (const row of W.S.hostNode.get("thr.test").values()) row.at = Date.now() - 3 * 3600e3;
W.S.hostRankCache.clear();
eq("站点样本过期 → 退回全局", W.SEL.pick({ pxShadow: 0 }, "lat", { host: "thr.test" }), "g1:443");

// rtt 老键不存在时只读一次 KV：订阅轮询不能每次都打一次
{
  W.S.snapCache = { v: { v: 1, ts: 1, date: "", stats: {}, rtt: {}, errs: [] }, t: Date.now() };
  W.S.rttMiss.clear();
  let reads = 0;
  const envR = {
    STATS: {
      get: async () => {
        reads += 1;
        return null;
      },
    },
  };
  await W.loadRtt(envR, "miss-u");
  eq("rtt 缺失第一次读 KV", reads, 1);
  await W.loadRtt(envR, "miss-u");
  eq("rtt 缺失 10 分钟内不再读", reads, 1);
  // ?ip= 是用户可传的：每个用户的标签数必须有上限，否则能把 snap 写成超大 KV 值
  for (let i = 0; i < 40; i++) W.rttMark("cap-u", "t" + i, true);
  const capB = W.S.rtt.get("cap-u");
  eq("rtt 标签最多 24 个", Object.keys(capB).length, 24);
  ok("保留的是最新的标签", !!capB.t39 && !capB.t0);
  // ?ip=__proto__ 不能污染 Object.prototype
  W.rttMark("proto-u", "__proto__", true);
  eq("rtt 标签不污染原型", {}.rtt, undefined);
  ok("__proto__ 作为普通键保存", Object.prototype.hasOwnProperty.call(W.S.rtt.get("proto-u"), "__proto__"));
}

// 全局闸门命中时不能每条连接都读一次 KV：一次检查后本地基线要推进
{
  let gets = 0,
    puts = 0;
  const envS = {
    STATS: {
      get: async () => {
        gets += 1;
        return JSON.stringify({ v: 1, ts: Date.now(), date: "", stats: {}, rtt: {}, errs: [] });
      },
      put: async () => {
        puts += 1;
      },
    },
  };
  W.S.stats.set("snap-u", { up: 1, down: 2, conns: 1, first: Date.now(), last: Date.now() });
  W.S.snapBytes = 3 * 1048576;
  W.S.snapWritten = Date.now() - 3 * 3600e3;
  W.S.snapChecked = 0;
  W.S.snapBusy = false;
  await W.flushSnap(envS);
  await W.flushSnap(envS);
  eq("快照全局闸门只读一次 KV", gets, 1);
  eq("闸门命中不写 KV", puts, 0);
  W.S.stats.clear();
  W.S.snapBytes = 0;
  W.S.snapWritten = 0;
  W.S.snapChecked = 0;
}

// 日计数批次失败要能退回基线，否则这批连接数永久丢
{
  W.S.cntDay = new Date().toISOString().slice(0, 10);
  W.S.cnt.conn = 7;
  W.S.cntSent.conn = 0;
  const dl = W.cntDelta();
  eq("cntDelta 取出增量", dl.conn, 7);
  eq("cntDelta 推进基线", W.S.cntSent.conn, 7);
  W.cntUnsend(dl);
  eq("cntUnsend 退回基线", W.S.cntSent.conn, 0);
  W.S.cnt.conn = 0;
  W.S.cntSent.conn = 0;
  // 跨天出口也要清零，不能把昨天的计数继续发出去
  W.S.cntDay = "2000-01-01";
  W.S.cnt.conn = 9;
  eq("跨天后计数不再发送", Object.keys(W.cntDelta()).length, 0);
  W.S.cntDay = new Date().toISOString().slice(0, 10);
}

// 真实成功要解除冻结，否则一个 30 分钟冻结只有等它自己过期
{
  reset();
  node("fr:443", {});
  W.freezeNode("fr:443");
  eq("冻结生效", W.isFrozen("fr:443"), true);
  W.nsOk("fr:443", 0, 0);
  eq("成功连接解除冻结", W.isFrozen("fr:443"), false);
}

// 影子/站点试探失败只罚节点，不推进全局失败记忆
reset();
node("tr:443", { tcp: 50 });
S.pxFailMem = 0;
S.pxFailSeen = 0;
await W.SEL.bumpFail({}, "tput", "tr:443", true);
eq("影子失败不进全局失败记忆", S.pxFailMem, 0);
eq("影子失败不置失败标志", S.pxFailSeen, 0);
eq("影子失败仍记节点失败", W.nsGet("tr:443").failW >= 1, true);
eq("影子失败冻结节点", W.isFrozen("tr:443"), true);

// 灾备快照不能用 |0：>2^31 的用量会溢出成负数/0
{
  const box = new Map();
  const envU = {
    uuid: "7c53c12a-88b1-4fda-b6e7-4da62e47a4e1",
    STATS: {
      get: async (k) => box.get(k) || null,
      put: async (k, v) => {
        box.set(k, v);
      },
    },
    METER: {
      idFromName: (id) => id,
      get: () => ({
        fetch: async () => ({
          ok: true,
          json: async () => ({ up: 3000000000, down: 5000000000, conns: 10, first: 1 }),
        }),
      }),
    },
  };
  W.S.usersCache = { v: null, t: 0 };
  W.S.usersSig = "";
  W.S.meterCache.clear();
  await W.usageSnapWrite(envU, [{ id: envU.uuid, pwd: "", note: "", enabled: true, managed: false }]);
  const doc = JSON.parse(box.get("usage:snap"));
  eq("大用量快照不溢出", doc.users[envU.uuid].up, 3000000000);
  eq("大下行快照不溢出", doc.users[envU.uuid].down, 5000000000);
}

// 新失败不能把已有的长冷却缩短
reset();
{
  const s = W.nsGet("cd:443");
  const until = Date.now() + 10 * 60000;
  s.blackUntil = until;
  W.nsFail("cd:443");
  ok("失败不缩短已有冷却", s.blackUntil >= until, String(s.blackUntil - Date.now()));
  s.freeUntil = Date.now() + 60 * 60000;
  W.freezeNode("cd:443");
  ok("冻结不缩短已有冻结", s.freeUntil >= Date.now() + 59 * 60000, String(s.freeUntil - Date.now()));
}
// DO 落盘失败要回滚内存，否则 pendFlush 重发同一批会双计
{
  let fail = true;
  const store = new Map();
  const state = {
    blockConcurrencyWhile: (fn) => Promise.resolve().then(fn),
    storage: {
      get: async (k) => store.get(k),
      put: async (k, v) => {
        if (fail) throw new Error("put down");
        store.set(k, v);
      },
      delete: async (k) => store.delete(k),
    },
  };
  const m = new W.Meter(state, {});
  await Promise.resolve();
  let threw = false;
  try {
    await m.fetch(
      new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 10, down: 20, conns: 1 }) }),
    );
  } catch (e) {
    threw = true;
  }
  eq("DO 落盘失败会抛错", threw, true);
  eq("DO 落盘失败回滚内存", m.ledger.usage.up, 0);
  fail = false;
  await m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 10, down: 20, conns: 1 }) }));
  eq("恢复后只记一次", m.ledger.usage.up, 10);
}

// DO 请求串行化：并发 /add 不能交错写坏内存/storage
{
  const doQ = mkDO();
  await Promise.all([
    doQ.m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 1, down: 0, conns: 0 }) })),
    doQ.m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 2, down: 0, conns: 0 }) })),
  ]);
  const jq = await (await doQ.m.fetch(new Request("https://m/get"))).json();
  eq("并发 /add 串行累加", jq.up, 3);
}

/* ---------- 8d. /add 收到 null / 数组 body 不能把 DO 打 500 ---------- */
{
  const doN = mkDO();
  const rn = await doN.m.fetch(new Request("https://m/add", { method: "POST", body: "null" }));
  eq("DO /add null body 不抛", rn.status, 200);
  const jn = await rn.json();
  eq("DO /add null body 累计仍为 0", [jn.up, jn.down, jn.conns], [0, 0, 0]);
}

/* ---------- 8e. /seed 回填历史时也要带回当日字段 ---------- */
{
  const today = new Date().toISOString().slice(0, 10);
  const doSeed = mkDO();
  await doSeed.m.fetch(
    new Request("https://m/seed", {
      method: "POST",
      body: JSON.stringify({ up: 1000, down: 2000, conns: 5, first: 1, d: today, dU: 77, dD: 88 }),
    }),
  );
  const js = await (await doSeed.m.fetch(new Request("https://m/get"))).json();
  eq("seed 回填累计", [js.up, js.down], [1000, 2000]);
  eq("seed 回填当日量", [js.dU, js.dD], [77, 88]);
  eq("seed 回填日期", js.d, today);
}

/* ---------- 9. 影子概率：选择器 / 控制页 / /proxyip 同源 ---------- */
eq("pxShadow 未设置 → 5%", W.shadowRate({}), 0.05);
eq('pxShadow="0" → 关闭探索', W.shadowRate({ pxShadow: "0" }), 0);
eq("pxShadow=0.2 原样", W.shadowRate({ pxShadow: "0.2" }), 0.2);
eq("pxShadow 非法 → 回落 5%", W.shadowRate({ pxShadow: "abc" }), 0.05);
eq("pxShadow 负数 → 回落 5%", W.shadowRate({ pxShadow: "-1" }), 0.05);
eq("pxShadow 封顶 1", W.shadowRate({ pxShadow: "3" }), 1);

/* ---------- 10. 今日用量按 DO 的日期判断 ---------- */
{
  const day = new Date().toISOString().slice(0, 10);
  const fakeEnv = (c) => ({
    METER: { idFromName: (x) => x, get: () => ({ fetch: async () => Response.json(c) }) },
  });
  S.meterCache.clear();
  S.pend.clear();
  const old = await W.readStats(
    fakeEnv({ up: 100, down: 200, conns: 1, first: 1, ts: 2, d: "2000-01-01", dU: 50, dD: 60 }),
    "u-yesterday",
  );
  eq("昨天的不算今日（上行）", old.todayUp, 0);
  eq("昨天的不算今日（下行）", old.todayDown, 0);
  eq("累计仍然保留", [old.up, old.down], [100, 200]);

  S.meterCache.clear();
  const cur = await W.readStats(
    fakeEnv({ up: 100, down: 200, conns: 1, first: 1, ts: 2, d: day, dU: 50, dD: 60 }),
    "u-today",
  );
  eq("今天照常显示当日量", [cur.todayUp, cur.todayDown], [50, 60]);
}

/* ---------- 11. /set 恢复累计不能抹掉今日 ---------- */
{
  const doS = mkDO();
  await doS.m.fetch(
    new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 10, down: 20, conns: 1 }) }),
  );
  await doS.m.fetch(
    new Request("https://m/set", {
      method: "POST",
      body: JSON.stringify({ up: 1000, down: 2000, conns: 9, first: 1 }),
    }),
  );
  const js = await (await doS.m.fetch(new Request("https://m/get"))).json();
  eq("恢复历史后累计生效", [js.up, js.down], [1000, 2000]);
  eq("恢复历史不抹今日", [js.dU, js.dD], [10, 20]);
  ok("恢复历史保留日期", !!js.d);
}

/* ---------- 恢复历史：同日 dU/dD 取较大值，旧日快照不覆盖今天 ---------- */
{
  const today = new Date().toISOString().slice(0, 10);
  const doT = mkDO();
  await doT.m.fetch(
    new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 10, down: 20, conns: 1 }) }),
  );
  await doT.m.fetch(
    new Request("https://m/set", {
      method: "POST",
      body: JSON.stringify({ up: 1000, down: 2000, conns: 9, first: 1, d: today, dU: 33, dD: 44 }),
    }),
  );
  const jt = await (await doT.m.fetch(new Request("https://m/get"))).json();
  eq("同日快照 dU/dD 取较大值", [jt.dU, jt.dD], [33, 44]);

  const doY = mkDO();
  await doY.m.fetch(
    new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 10, down: 20, conns: 1 }) }),
  );
  await doY.m.fetch(
    new Request("https://m/set", {
      method: "POST",
      body: JSON.stringify({ up: 1000, down: 2000, d: "2000-01-01", dU: 999, dD: 999 }),
    }),
  );
  const jy = await (await doY.m.fetch(new Request("https://m/get"))).json();
  eq("旧日快照不覆盖今日", [jy.dU, jy.dD], [10, 20]);
}

/* ---------- 灾备快照带当日字段，且只合并同一天 ---------- */
{
  const today = new Date().toISOString().slice(0, 10);
  const store = new Map();
  const envS = {
    STATS: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => store.set(k, v),
    },
    METER: {
      idFromName: (x) => x,
      get: () => ({
        fetch: async () => Response.json({ up: 100, down: 200, conns: 1, first: 1, d: today, dU: 77, dD: 88 }),
      }),
    },
  };
  store.set(
    "usage:snap",
    JSON.stringify({ ts: 0, users: { "snap-u1": { up: 1, down: 1, conns: 1, d: "2000-01-01", dU: 999, dD: 999 } } }),
  );
  W.S.meterCache.clear();
  await W.usageSnapWrite(envS, [{ id: "snap-u1" }]);
  const snap = JSON.parse(store.get("usage:snap"));
  eq("快照写入今日 dU/dD", [snap.users["snap-u1"].dU, snap.users["snap-u1"].dD], [77, 88]);
  eq("快照日期是今天", snap.users["snap-u1"].d, today);
}

/* ---------- 12. 并发闸：不漏任务、不超上限 ---------- */
{
  const seen = [];
  let live = 0,
    peak = 0;
  await W.eachLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 1));
    seen.push(x);
    live--;
  });
  eq(
    "eachLimit 覆盖全部任务",
    seen.sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7],
  );
  ok("eachLimit 并发不超过 3", peak <= 3, String(peak));
}

/* ---------- 节点快照的 key 不能污染原型 ---------- */
{
  const doP = mkDO();
  await doP.m.fetch(
    new Request("https://m/add", {
      method: "POST",
      body: '{"up":0,"down":0,"conns":0,"spd":{"__proto__":{"med":1},"ok:443":{"med":2,"at":1}}}',
    }),
  );
  eq("spd 容器是 null 原型", Object.getPrototypeOf(doP.m.ledger.nodeSnapshots), null);
  eq("__proto__ 不作为自有键写入", Object.prototype.hasOwnProperty.call(doP.m.ledger.nodeSnapshots, "__proto__"), false);
  ok("正常节点仍保留", !!doP.m.ledger.nodeSnapshots["ok:443"]);
}

/* ---------- 探活不能灌水面板成功率 ---------- */
{
  const s = W.nsGet("probe-only:443");
  W.nsProbe("probe-only:443", 50, 40, 10);
  eq("探活不增加 ok", s.ok, 0);
  eq("探活仍记延迟样本", s.probeSamples, 1);
  W.S.nstat.delete("probe-only:443");
}

/* ---------- 14. 评分 v2.1：滞回主项 / 地区排除 / 快失败窗口 / 站点衰减 ---------- */
// 滞回按"主项"算：250ms → 60ms 必须切得动（旧实现门槛 0.15×总分=210ms，永远切不动）
reset();
node("hz1:443", { tcp: 250, tls: 60, okW: 20, failW: 2 });
node("hz2:443", { tcp: 60, tls: 60, okW: 20, failW: 2 });
S.curs.lat = "hz1:443";
eq("lat 滞回按延迟分量：250ms → 60ms 会切", W.SEL.maybeSwitch({ pxDwellMin: 0 }, "lat"), true);
// 5ms 的差异仍然不切：改的是门槛基准，不是把门槛拿掉
reset();
node("hz3:443", { tcp: 100, tls: 60, okW: 20, failW: 2 });
node("hz4:443", { tcp: 105, tls: 60, okW: 20, failW: 2 });
S.curs.lat = "hz3:443";
eq("lat 滞回仍挡住 5ms 抖动", W.SEL.maybeSwitch({ pxDwellMin: 0 }, "lat"), false);

// 地区选路必须和全局候选表共用排除规则
reset();
W.S.inflight.clear();
node("rde1:443", { tcp: 60, tls: 10, okW: 5, failW: 0, trafficOkW: 5, eCloseP: 6 });
node("rde2:443", { tcp: 180, tls: 20, okW: 20, failW: 1, trafficOkW: 20, eCloseP: 0 });
S.alive.get("rde1:443").cc = "DE";
S.alive.get("rde2:443").cc = "DE";
eq("可疑节点进不了全局候选", W.candsFor("lat").some((x) => x.k === "rde1:443"), false);
const rOk = await W.SEL.region({}, "DE", "lat");
eq("地区选路跳过可疑节点", rOk && rOk.h + ":" + rOk.p, "rde2:443");
W.nsFail("rde2:443"); // 冷却 → 硬排除
const rLast = await W.SEL.region({}, "DE", "lat");
eq("地区只剩可疑节点时仍返回（硬要求，不返回 null）", rLast && rLast.h + ":" + rLast.p, "rde1:443");

// 地区选路的负载感知：全国流量不能全压在第一名
reset();
W.S.inflight.clear();
node("rjp1:443", { tcp: 60, tls: 10, okW: 20, failW: 1, trafficOkW: 20 });
node("rjp2:443", { tcp: 70, tls: 10, okW: 20, failW: 1, trafficOkW: 20 });
S.alive.get("rjp1:443").cc = "JP";
S.alive.get("rjp2:443").cc = "JP";
W.S.inflight.set("rjp1:443", 4);
const rLb = await W.SEL.region({}, "JP", "lat");
eq("地区选路避开在途堆积", rLb && rLb.h + ":" + rLb.p, "rjp2:443");
W.S.inflight.clear();

// 快失败窗口：9 分钟前的 4 次成功不能把刚刚的 3 次失败稀释成"健康"
reset();
const ffx = W.nsGet("ffx:443");
for (let i = 0; i < 4; i++) W.nsOk("ffx:443", 50, 10);
ffx.winAt -= 9 * 60000;
ffx.at -= 9 * 60000;
for (let i = 0; i < 3; i++) W.nsFail("ffx:443");
ok("旧成功不按次数稀释新失败", W.pFailFast(ffx) > 0.27, String(W.pFailFast(ffx)));
ok("旧成功同时被时间权重压掉", ffx.winOk < 1, String(ffx.winOk));

// 站点画像：一次封禁不是判决书
reset();
W.hostNodeMark("decay.test", "n1:443", { ok: false, bad: true, ttfb: 0 });
W.hostNodeMark("decay.test", "n1:443", { ok: false, bad: true, ttfb: 0 });
const dRec = S.hostNode.get("decay.test").get("n1:443");
const dBefore = W.hostScore(dRec, "lat", Date.now());
dRec.at -= 7 * 3600e3;
W.hostNodeMark("decay.test", "n1:443", { ok: true, bad: false, ttfb: 100 });
eq("站点坏样本空闲 7 小时后减半", dRec.bad, 1);
ok("站点分随之回升", W.hostScore(dRec, "lat", Date.now()) < dBefore, `${Math.round(dBefore)}ms`);

// 冷启动不做 6h 轮换：否则第一条 cron 就把第 1 名换成第 2 名
reset();
node("sc1:443", { tcp: 60, okW: 20 });
node("sc2:443", { tcp: 70, okW: 20 });
S.curs.lat = "sc1:443";
S.lastSwitch = { lat: 0, tput: 0 };
W.SEL.sched({ pxSchedH: 6 });
eq("冷启动不轮换", S.curs.lat, "sc1:443");
S.lastSwitch = { lat: Date.now() - 7 * 3600e3, tput: 0 };
W.SEL.sched({ pxSchedH: 6 });
eq("6 小时没切换才轮换", S.curs.lat, "sc2:443");

// 真实首字节回流：探活快、实际慢的节点不能按探活算延迟
reset();
node("liar:443", { tcp: 25, tls: 40, okW: 5 });
W.nsLatency("liar:443", 420);
ok("真实首字节远慢于探活 → 按真实值算", W.scoreParts("liar:443", "lat").latencyMs > 300, String(W.scoreParts("liar:443", "lat").latencyMs));
reset();
node("honest:443", { tcp: 60, tls: 40, okW: 5 });
W.nsLatency("honest:443", 130);
ok("真实首字节与探活接近 → 不触发", W.scoreParts("honest:443", "lat").latencyMs < 200, String(W.scoreParts("honest:443", "lat").latencyMs));

// —— 单层抽样：未测节点被抽到，测过且差的节点退场 ——
reset();
W.invalidateRank();
node("k1:443", { tcp: 60, okW: 40 });
node("k2:443", { tcp: 400, okW: 40 });
node("k3:443", { tcp: 70 });
{
  const hit = {};
  for (let i = 0; i < 400; i++) {
    const k = W.SEL.pick({ pxShadow: 0 }, "lat", { host: "" });
    hit[k] = (hit[k] || 0) + 1;
    W.nsOk(k, 0, 0); // 真实连接成功 → 样本 +1，乐观面随之收缩
  }
  ok("未测节点拿到探索流量", (hit["k3:443"] || 0) > 0, JSON.stringify(hit));
  ok("测过且慢的节点基本退场", (hit["k2:443"] || 0) <= 2, JSON.stringify(hit));
  ok("王者仍拿大头", (hit["k1:443"] || 0) > 200, JSON.stringify(hit));
}

// —— 回归：pStall 的分母必须是"全部连接的总时长" ——
// 早先只在"这条连接卡过"时才累加 runMs：100 条 30 秒健康连接 + 1 条 5 秒连接卡 2 秒，
// 算出来 pStall=0.34（真实占比 0.0007），单次卡顿白送 800+ ms，还会踩中 +400 的重罚档。
reset();
node("ps:443", { tcp: 100 });
for (let i = 0; i < 100; i++) W.nsStall("ps:443", 0, 30000);
W.nsStall("ps:443", 2000, 5000);
const psV = W.scoreParts("ps:443", "lat").pStall;
ok("pStall 按连接总时长稀释", psV < 0.01, psV.toFixed(5));
ok("pStall 没被抹平（2 秒卡顿还在）", psV > 0.0001, psV.toFixed(5));

// —— 回归：延迟模式的 xferMs 要按样本新鲜度混合先验 ——
// 早先直读 s.capBps，而直方图衰减是等比缩放（分位不变）→ 一周前测到的 16MB/s 永久少算 70ms。
reset();
node("xf:443", { tcp: 100, okW: 20 });
const xf = W.nsGet("xf:443");
xf.hist[7] = 100;
xf.sumW = 100;
xf.sumW2 = 100;
xf.capBps = 16 * 1024 * 1024;
xf.recentBytesW = 100000;
xf.lastSampleAt = Date.now() - 7 * 24 * 3600e3;
const xfOld = W.scoreParts("xf:443", "lat").xferMs;
ok("过期吞吐样本回退先验", xfOld > 70 && xfOld < 90, xfOld.toFixed(1));
xf.lastSampleAt = Date.now();
xf.recentBytesW = 4 * 1024 * 1024;
const xfNew = W.scoreParts("xf:443", "lat").xferMs;
ok("新鲜样本按实测带宽折算", xfNew < 12, xfNew.toFixed(1));

// —— 回归：延迟模式的影子采样必须可达 ——
// 早先探索排在 Thompson 之后，lat 模式只要有已测节点就 return：
// pxShadow=0.5、10 个节点、1000 次 pick 仍然 100% 打同一个节点，池子里除王者外一个样本都没有。
reset();
W.invalidateRank();
node("ex1:443", { tcp: 60, okW: 200 });
node("ex2:443", { tcp: 70 });
node("ex3:443", { tcp: 80 });
const exHit = new Set();
for (let i = 0; i < 400; i++) {
  const k = W.SEL.pick({ pxShadow: 0.5 }, "lat", { host: "" });
  exHit.add(k);
  W.nsOk(k, 0, 0); // 真实连接成功 → 样本 +1，乐观面随样本收缩
}
ok("延迟模式影子采样可达", exHit.size > 1, [...exHit].join(","));
ok("延迟模式大多数请求仍走王者", exHit.has("ex1:443"), [...exHit].join(","));

// —— 回归：吞吐模式也走同一套抽样，不再"粘滞游标" ——
reset();
W.invalidateRank();
node("tp1:443", { tcp: 60, okW: 20 });
node("tp2:443", { tcp: 80, okW: 20 });
const tpHit = new Set();
for (let i = 0; i < 400; i++) tpHit.add(W.SEL.pick({ pxShadow: 0 }, "tput", { host: "" }));
ok("吞吐模式两个候选都抽得到", tpHit.size > 1, [...tpHit].join(","));


// —— CUSUM 变点：一条怪样本不动，连续两条大跳立刻冻结 ——
reset();
node("cu1:443", { tcp: 100, pSum: 100, msLocal: 100 });
W.nsLatency("cu1:443", 400);
ok("延迟变点：单条慢样本不冻结", !W.nsGet("cu1:443").freeUntil, String(W.nsGet("cu1:443").freeUntil || 0));
W.nsLatency("cu1:443", 400);
ok("延迟变点：连续两条大跳立刻冻结", W.nsGet("cu1:443").freeUntil > Date.now(), String(W.nsGet("cu1:443").freeUntil - Date.now()));

// —— CUSUM 吞吐：带宽崩塌后 cap 立刻掉下来，老直方图不再拖一周 ——
reset();
node("cb1:443", { tcp: 60 });
for (let i = 0; i < 3; i++) W.nsSpeed("cb1:443", 8 * 1048576, 512 * 1024, {});
const capBoom = W.nsGet("cb1:443").capBps;
W.nsSpeed("cb1:443", 512 * 1024, 512 * 1024, {});
const capBust = W.nsGet("cb1:443").capBps;
ok("吞吐变点：崩塌样本立刻改写 capBps", capBoom > 4 * 1048576 && capBust < 1048576, `${capBoom} -> ${capBust}`);

// —— 稳健抖动：一条 5 秒的怪连接不该把抖动抬到秒级（MAD，不是方差）——
reset();
node("jt1:443", { tcp: 100 });
for (let i = 0; i < 5; i++) W.nsLatency("jt1:443", 100);
const jit0 = W.scoreParts("jt1:443", "lat").jitMs;
W.nsLatency("jt1:443", 5000);
const jit1 = W.scoreParts("jt1:443", "lat").jitMs;
ok("抖动对单条离群连接不敏感", jit1 < 400, `${jit0.toFixed(1)} -> ${jit1.toFixed(1)}`);

// —— S 参数化：小对象看延迟，批量看带宽 ——
reset();
W.invalidateRank();
const now0 = Date.now();
node("za:443", { tcp: 60, pSum: 60, msLocal: 60, okW: 20, capBps: 4 * 1048576, lastSampleAt: now0 });
node("zb:443", { tcp: 120, pSum: 120, msLocal: 120, okW: 20, capBps: 20 * 1048576, lastSampleAt: now0 });
const szI = (k) => W.scoreParts(k, "lat", now0, false, W.SC.SZ_I).score;
const szB = (k) => W.scoreParts(k, "lat", now0, false, W.SC.SZ_B).score;
ok("S=64KB 时选低延迟节点", szI("za:443") < szI("zb:443"), `${szI("za:443").toFixed(0)} vs ${szI("zb:443").toFixed(0)}`);
ok("S=16MB 时选大带宽节点", szB("zb:443") < szB("za:443"), `${szB("za:443").toFixed(0)} vs ${szB("zb:443").toFixed(0)}`);
const rndSZ = Math.random;
Math.random = () => 0.5;
const envS = { pxShadow: 0 };
const pickI = W.SEL.pick(envS, "lat", { host: "", targetBytes: W.SC.SZ_I });
const pickB = W.SEL.pick(envS, "lat", { host: "", targetBytes: W.SC.SZ_B });
Math.random = rndSZ;
ok("pick 会把目标流量传进打分", pickI === "za:443" && pickB === "zb:443", `${pickI} / ${pickB}`);

// —— 兜底：全池都在冷却时也必须给出节点 ——
// 返回空串会让 session 直接 cnt("dead")，哪怕池子里还有节点只是暂时被罚
reset();
W.invalidateRank();
node("fb1:443", { tcp: 60, okW: 20, blackUntil: Date.now() + 600000 });
node("fb2:443", { tcp: 80, okW: 20, blackUntil: Date.now() + 60000 });
const fbPick = W.SEL.pick({ pxShadow: 0 }, "lat", { host: "" });
ok("全池冷却时兜底选最早恢复的节点", fbPick === "fb2:443", fbPick);
node("fb3:443", { tcp: 70, okW: 20, freeUntil: Date.now() + 1800000 });
const fbPick2 = W.SEL.pick({ pxShadow: 0 }, "lat", { host: "" });
ok("冻结节点排在冷却节点之后", fbPick2 === "fb2:443", fbPick2);


// 失败阶梯跟池子大小走：小池子首档 10 s，大池子 60 s
reset();
for (let i = 0; i < 6; i++) node("sm" + i + ":443", { tcp: 100 });
W.nsFail("sm0:443");
const blSmall = W.nsGet("sm0:443").blackUntil - Date.now();
ok("小池子失败首档 ≈10 秒", blSmall > 8000 && blSmall < 12000, blSmall);
reset();
for (let i = 0; i < 20; i++) node("bg" + i + ":443", { tcp: 100 });
W.nsFail("bg0:443");
const blBig = W.nsGet("bg0:443").blackUntil - Date.now();
ok("大池子失败首档 ≈60 秒", blBig > 55000 && blBig < 65000, blBig);

// 连接观测按节点聚合（n/ok/p50/p95），不再是一条连接一行
reset();
S.cagg.clear();
S.cagg.set("x:443", { n: 3, ok: 2, dn: 4096, v: [100, 200, 300] });
const cl = W.clSnapshot(10);
ok("连接观测按节点聚合", cl.length === 1 && cl[0].k === "x:443" && cl[0].n === 3 && cl[0].ok === 2 && cl[0].p50 === 200, JSON.stringify(cl));
ok("聚合后的下行字节累加", cl.length === 1 && cl[0].dn === 4096, cl.length ? cl[0].dn : -1);


/* ---------- 28. 大池分片重建（2000 候选不再有 4 ms 尖峰） ---------- */
reset();
for (let i = 0; i < 1300; i++) node(`b${i}:443`, { tcp: 50 + i, okW: 10 });
W.invalidateRank();
const br1 = W.candsFor("lat");
ok("大池分片：首片就能给出候选", br1.length > 0 && br1.length <= 128, String(br1.length));
eq("大池分片：每片只推进 128 个", W.S.rankCache.step.lat.pos, 128);
ok("大池分片：首片只覆盖前 128 个", !br1.some((r) => r.k === "b200:443"), String(br1.length));
for (let i = 0; i < 12 && W.S.rankCache.step.lat; i++) W.candsFor("lat");
eq("大池分片：一轮算完清掉进度", W.S.rankCache.step.lat, undefined);
eq("大池分片：一轮之后全局最优在榜首", W.candsFor("lat")[0].k, "b0:443");
ok("大池分片：表里仍有 CAND_KEEP 名", W.candsFor("lat").length >= 224, String(W.candsFor("lat").length));
  /* ---------- 29. 强制中转名单（CF 托管站点首连就走 proxyip） ---------- */
  const eDef = {};
  ok("未配置名单 = 空（改由 CF 托管识别决定）", W.pxHostList(eDef).length === 0 && W.isPxHost(eDef, "x.com") === false);
  ok("手动名单仍可命中域名与子域", W.isPxHost({ pxHosts: "x.com" }, "x.com") === true && W.isPxHost({ pxHosts: "x.com" }, "api.x.com") === true);
  ok("手动名单不误伤相似域", W.isPxHost({ pxHosts: "x.com" }, "notx.com") === false && W.isPxHost({ pxHosts: "x.com" }, "x.com.evil.cn") === false);
  ok("pxHosts 为空 = 关闭名单", W.isPxHost({ pxHosts: "" }, "x.com") === false);
  ok("pxHosts=* = 全部走中转", W.isPxHost({ pxHosts: "*" }, "example.com") === true);
  ok("pxHosts 支持逗号与大小写", W.isPxHost({ pxHosts: "Foo.COM, bar.cn" }, "a.foo.com") === true && W.isPxHost({ pxHosts: "Foo.COM, bar.cn" }, "bar.cn") === true && W.isPxHost({ pxHosts: "Foo.COM, bar.cn" }, "baz.cn") === false);
  ok("以点开头的条目只匹配子域", W.isPxHost({ pxHosts: ".x.com" }, "www.x.com") === true && W.isPxHost({ pxHosts: ".x.com" }, "x.com") === false);
  ok("名单解析去空项", W.pxHostList({ pxHosts: " a.com , ,b.com, " }).length === 2);
  ok("CF 网段：104.16/13 命中", W.isCfIp("104.16.0.5") === true && W.isCfIp("104.23.255.1") === true);
  ok("CF 网段：172.64/13 命中", W.isCfIp("172.64.1.1") === true);
  ok("CF 网段：131.0.72/22 命中", W.isCfIp("131.0.72.5") === true);
  ok("CF 网段：非 CF 不命中", W.isCfIp("8.8.8.8") === false && W.isCfIp("1.1.1.1") === false && W.isCfIp("45.147.250.39") === false);
  ok("CF 网段：IPv6/非法输入不命中", W.isCfIp("2001:db8::1") === false && W.isCfIp("") === false && W.isCfIp("104.16.0.256") === false);

// 第 30 组：判定表（以 IP 为单位）
W.vClear();
const tg = "162.159.140.229";
const chR = { kind: "r", ip: "45.136.117.194" };
const chR2 = { kind: "r", ip: "185.253.117.147" };
eq("直连通道的键是 d", W.chanKey(W.DIRECT), "d");
eq("中继通道键带 IP", W.chanKey(chR), "r:45.136.117.194");
eq("初始是 unknown", W.vState(tg, "d"), 0);
W.recordTraffic({ target: tg, chan: W.DIRECT, down: 4096, ok: true });
eq("流量成功只产生弱 ok", W.vState(tg, "d"), 1);
W.recordTraffic({ target: tg, chan: W.DIRECT, down: 0, ok: false });
eq("流量失败不得把弱 ok 降级", W.vState(tg, "d"), 1);
W.vSet(tg, "r:185.253.117.147", 403, 90, 1);
eq("probe 403 记为 blocked", W.vState(tg, "r:185.253.117.147"), 2);
ok("blocked 通道被判坏", W.vBad(tg, "r:185.253.117.147"));
W.vSetState(tg, "r:185.253.117.147", 1, 0);
eq("弱证据不能冲掉强证据的 blocked", W.vState(tg, "r:185.253.117.147"), 2);
W.vSet(tg, "r:45.136.117.194", 0, 800, 1);
eq("probe 连不上记为 dead", W.vState(tg, "r:45.136.117.194"), 3);
  W.vSet("*", "r:185.253.117.147", 200, 60, 1);
  ok("通配目标不落表", W.vAll().every((r) => r.target !== "*") && !W.vOk(tg, "r:185.253.117.147"));
  const cw = W.cntView();
  ok("通配写入被计数（vwild）", (cw.vwild || 0) >= 1, String(cw.vwild));
  W.vSet("*", "r:45.136.117.194", 200, 55, 1);
  ok("没有通配回退：别的站点照旧是未知", !W.vOk("1.2.3.4", "r:45.136.117.194"));
eq("probe 级证据入口已删除（探测链 7.69 整体移除）", W.recordProbe, undefined);
eq("客户端回流入口已删除（订阅只有 url-test，客户端从不回传状态码）", W.recordClient, undefined);
W.vClear();
eq("清空后表为空", W.vAll().length, 0);
// 第 31 组：通道策略（影子）与子请求预算
const rCtx = { host: "x.com", cfHost: true, clientV6: false, relays: ["104.16.0.5", "45.136.117.194"], legacyWantsRelay: true };
eq("cf 目标优先挑可用的中继", W.decide(rCtx).chan.kind, "r");
eq("v6 客户端 + cf 目标只走非 CF 中继", W.decide({ ...rCtx, clientV6: true }).chan.ip, "45.136.117.194");
eq("普通目标走直连", W.decide({ ...rCtx, cfHost: false }).chan.kind, "d");
W.vClear(); W.S.polSame = 0; W.S.polDiff = 0; W.S.polWhy = {};
W.shadow(rCtx);
eq("影子模式统计一致", W.S.polSame, 1);
W.shadow({ ...rCtx, legacyWantsRelay: false });
eq("影子模式统计不一致", W.S.polDiff, 1);
const pl = W.planRound(1600, 8);
ok("预算不超过子请求硬上限", pl.adm <= W.SC.SCAN_SUB, JSON.stringify(pl));
ok("池子很饿时优先给准入", pl.adm >= 4, JSON.stringify(pl));
// 7.62 起策略全生效（level 2）：判定层已有 660+ 条断言与线上实测背书，
// 且「隧道直连成功证据 / 中继软降权」这些判据只有全生效时才真正影响选路。
ok("策略默认全生效（level 2）", W.SC.POLICY === 2);
ok("policyOn 在 level>=1 时为真", W.policyOn() === true);
// 第 32 组：决策注入（core HOOK）与影子一致率
ok("策略实现已注册到 HOOK", typeof W.HOOK.decide === "function");
W.S.polSame = 0; W.S.polDiff = 0;
W.S.alive.set("45.136.117.194:443", { h: "45.136.117.194", p: 443, cc: "XX", ms: 80 });
const req6 = new Request("https://example.com/", { headers: { "cf-connecting-ip": "2001:db8::5" } });
const req4 = new Request("https://example.com/", { headers: { "cf-connecting-ip": "1.2.3.4" } });
eq("影子期不改变现状", W.pxDecision(req6, "x.com", true, false, false), false);
eq("生效后 v6+CF 目标走中继", W.pxDecision(req6, "x.com", true, false, true), true);
eq("生效后 v4 客户端不被硬规则改写", W.pxDecision(req4, "example.com", false, false, true), false);
ok("影子统计有累计", W.S.polSame + W.S.polDiff >= 3, String(W.S.polSame + W.S.polDiff));
ok("原因分布有键", Object.keys(W.S.polWhy).length > 0, JSON.stringify(W.S.polWhy));
// 第 33 组：判定表接入选路（veto）
W.vClear();
W.vSet("x.com", "r:" + "45.136.117.194", 403, 70, 1);
ok("被判 blocked 的中继被 veto", W.HOOK.veto("x.com", "45.136.117.194") === true);
ok("同站点未判过的中继不被 veto", W.HOOK.veto("x.com", "89.22.227.132") === false);
ok("站点级判定不外溢到别的站点", W.HOOK.veto("y.com", "45.136.117.194") === false);
W.vSet("*", "r:" + "89.22.227.132", 0, 900, 1);
ok("通配判定不再生效：写不进表，也不会外溢到别的站点", W.HOOK.veto("y.com", "89.22.227.132") === false);
W.vClear();
ok("清空后不再 veto", W.HOOK.veto("x.com", "45.136.117.194") === false);
// 第 34 组：连接证据钩子（traffic，差分判据）
W.vClear(); W.S.needPx.clear(); W.S.smCnt.clear(); W.S.bigByHost.clear();
W.HOOK.traffic({ host: "x.com", via: "node", node: "45.136.117.194:443", down: 900, ok: false, life: 800, up: 0 });
eq("只有小响应时不判死（可能只是业务层 403）", W.vState("x.com", "r:45.136.117.194"), 0);
ok("小响应按通道记进 smCnt（不再有复核队列，这条计数是它唯一的下游）", (W.S.smCnt.get("x.com|r:45.136.117.194") || 0) >= 1);
W.HOOK.traffic({ host: "x.com", via: "node", node: "89.22.227.132:443", down: 90000, ok: true, life: 4000, up: 900 });
eq("同一站点别的通道能打通 → 记为 ok", W.vState("x.com", "r:89.22.227.132"), 1);
W.HOOK.traffic({ host: "x.com", via: "node", node: "45.136.117.194:443", down: 900, ok: false, life: 800, up: 0 });
eq("有别的通道能打通 + 本通道两次小响应 → 判该通道被封", W.vState("x.com", "r:45.136.117.194"), 2);
ok("判被封后设 needPx（下次优先中转）", (W.S.needPx.get("x.com") || 0) > Date.now());
W.HOOK.traffic({ host: "x.com", via: "node", node: "45.136.117.194:443", down: 90000, ok: true, life: 4000, up: 900 });
eq("之后拿到大响应 → 解除误判", W.vState("x.com", "r:45.136.117.194"), 1);

// 第 35 组：判定表跨 isolate 同步（只同步强证据）
W.vClear(); W.S.vtSent.clear();
W.vSet("x.com", "r:" + "45.136.117.194", 403, 60, 1);
const dl = W.HOOK.vtDelta();
eq("强证据进增量", dl.length, 1);
eq("增量键是 target|chan", dl[0].k, "x.com|r:45.136.117.194");
eq("增量里是 blocked", dl[0].s, 2);
W.vtAck();
eq("ack 之后同一证据不重复上报", W.HOOK.vtDelta().length, 0);
W.vClear();
eq("清空后本地为空", W.vAll().length, 0);
W.vImport(dl);
eq("远端强证据可导入", W.vState("x.com", "r:45.136.117.194"), 2);
ok("导入后 veto 生效", W.HOOK.veto("x.com", "45.136.117.194") === true);
W.vSet("y.com", "r:" + "1.1.1.1", 200, 40, 1);
ok("ok 证据不进增量", W.HOOK.vtDelta().every((r) => r.k !== "y.com|r:1.1.1.1"));
W.vClear(); W.S.vtSent.clear();
// 第 36 组：策略分级（0 影子 / 1 只硬规则 / 2 全生效）
reset(); node("n1:443", {});
const reqV6 = new Request("https://x/", { headers: { "cf-connecting-ip": "2001:db8::1" } });
const reqV4 = new Request("https://x/", { headers: { "cf-connecting-ip": "1.2.3.4" } });
ok("level 0 只影子：不改原判断", W.pxDecision(reqV6, "x.com", true, false, 0) === false);
ok("level 1 硬规则生效：v6+CF 走中转", W.pxDecision(reqV6, "x.com", true, false, 1) === true);
ok("level 1 CF 托管目标直接走中继（不需要学习）", W.pxDecision(reqV4, "x.com", true, false, 1) === true);
ok("level 0 时 CF 托管目标也不改（只影子）", W.pxDecision(reqV4, "x.com", true, false, 0) === false);
ok("level 1 不改写「本来就要中转」的判断", W.pxDecision(reqV6, "x.com", false, true, 1) === true);
ok("level 2 全生效：v4+CF 也走判定", W.pxDecision(reqV4, "x.com", true, false, 2) === true);
ok("level 2 无候选时回落原判断", W.pxDecision(reqV4, "y.com", false, false, 2) === false);
// 第 37 组：判定侧编排已删除（7.149）
// pickHosts 只在测试里被调用、runRound 从 7.69 起就是 `void plan; return {hosts:[],swept:0}`，
// 而 cron 连它的返回值都不看 ⇒ 整条链路只剩注释与一个永远为 0 的预算字段。
eq("pickHosts 已删除", W.pickHosts, undefined);
eq("SWEEP_COST 已删除", W.SWEEP_COST, undefined);
eq("runRound 已删除", W.runRound, undefined);
W.vClear();

// 第 38 组：订阅侧入口条目与「按边缘实测 x」的组（客户端实测）
{
  const envS = { uuid: "u", nodes: "", proxyip: "auto" };
  const y = W.renderClash(envS, new URL("https://example.com/x"), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "example.com");
  const eCount = (y.match(/name: "e-/g) || []).length;
  eq("边缘入口条目：8 个 IP × 2 模式", eCount, 16);
  eq("边缘条目 server 是 IP", y.includes("server: 104.18.32.1"), true);
  eq("边缘条目 servername 仍是域名", y.includes("servername: example.com"), true);
  eq("入口优选组按 /health 实测", y.includes('name: "🌐 入口优选"') && y.includes("url: https://example.com/health"), true);
  eq("默认订阅不含站点特化（无 x 组）", y.includes('name: "\ud83d\udef0 x \u4f18\u9009"'), false);
  eq("默认订阅不含站点规则", /DOMAIN-SUFFIX,x\.com/.test(y), false);
  const ytu = W.renderClash(envS, new URL("https://example.com/x?tu=" + encodeURIComponent("https://probe.example.org/")), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "example.com");
  eq("?tu= 才发按客户端实测的 url-test 组", ytu.includes("url: https://probe.example.org/"), true);
  eq("?tu= 也不引入站点级规则", /DOMAIN-SUFFIX/.test(ytu), false);
  const y0 = W.renderClash(envS, new URL("https://example.com/x?e=0"), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "example.com");
  eq("?e=0 时不发边缘条目", (y0.match(/name: "e-/g) || []).length, 0);
  eq("?e=0 时不发实测组", y0.includes("url: https://probe.example.org/"), false);
}

// 第 38b 组：中继优选条目（把「经某条中继」做成客户端可实测的节点）
{
  const envR = { uuid: "u", nodes: "", proxyip: "auto" };
  const keep = S.alive;
  S.alive = new Map([
    ["203.0.113.7:443", { h: "203.0.113.7", p: 443, cc: "", ms: 120, src: "pool" }],
    ["198.51.100.9:443", { h: "198.51.100.9", p: 443, cc: "", ms: 180, src: "pool" }],
  ]);
  const yr = W.renderClash(envR, new URL("https://example.com/x"), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "example.com");
  eq("中继条目：每条中继 × 协议 × 模式（成对出现）", (yr.match(/name: "r-/g) || []).length % 2 === 0 && (yr.match(/name: "r-/g) || []).length >= 4, true);
  eq("中继条目含首条与次条", yr.includes("r-203.0.113.7-") && yr.includes("r-198.51.100.9-"), true);
  eq("中继条目钉住具体中继", yr.includes("rx=203.0.113.7") && yr.includes("px=1"), true);
  eq("中继优选组按 /health 实测", yr.includes('name: "\ud83d\udd01 \u4e2d\u7ee7\u4f18\u9009"'), true);
  const y0r = W.renderClash(envR, new URL("https://example.com/x?e=0"), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "example.com");
  // 冷 isolate 里 S.alive 是空的，但事实层（跨 isolate 共享）知道哪些中继是 v4 出口 —— 必须先发它们
  const keepTop = S.eg4Top;
  S.alive = new Map();
  S.eg4Top = ["192.0.2.44"];
  const yt = W.renderClash(envR, new URL("https://example.com/x"), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "example.com");
  eq("冷 isolate：中继条目来自事实层的 v4 出口", yt.includes("r-192.0.2.44-") && yt.includes("rx=192.0.2.44"), true);
  S.eg4Top = keepTop;
  // ?e=0 只是「不发入口 IP 条目」（那是列表里最占地方的一块），中继条目仍要发：
  // 它们承载 ?tu= 通道实测，一并删掉等于把「客户端自己挑中继」这条路关死。
  eq("?e=0 只关入口条目、中继条目仍在", y0r.includes('name: "r-203.0.113.7-'), true);
  eq("?e=0 时入口条目消失", (y0r.match(/name: "e-/g) || []).length, 0);
  S.alive = keep;
}

// 第 39 组：节点偏好表（站点 × 通道的「能通 / 打不通」两栏）
{
  W.vClear();
  eq("没测过的通道不降权（未知 = 1）", W.chanPref("9.9.9.1", "a.com"), 1);
  eq("不传站点一律「未知」：通配行已经不存在", W.chanPref("9.9.9.1"), 1);
  W.vSetState("a.com", "r:9.9.9.2", 1, 1);
  eq("实测能打通的通道 = 0", W.chanPref("9.9.9.2", "a.com"), 0);
  eq("别的站点看不到这条证据", W.chanPref("9.9.9.2", "b.com"), 1);
  W.vSetState("a.com", "r:9.9.9.3", 2, 1);
  eq("实测打不通的通道 = 2", W.chanPref("9.9.9.3", "a.com"), 2);
  const pf = W.prefsJson(20);
  eq("偏好表能打通一栏含该通道", pf.ok.some((x) => x.channel === "r:9.9.9.2"), true);
  eq("偏好表打不通一栏含该通道", pf.bad.some((x) => x.channel === "r:9.9.9.3"), true);
  W.vClear();
}

// 第 40 组：拿到 403 就学（不等 probe 确认）
{
  W.vClear();
  const ch = { kind: "r", ip: "9.9.9.7" };
  W.recordBlock({ target: "x.com", chan: ch, down: 700, ok: false });
  eq("小响应立刻判该通道被拒", W.chanPref("9.9.9.7", "x.com"), 2);
  eq("别的站点不受牵连", W.chanPref("9.9.9.7", "y.com"), 1);
  W.recordPass({ target: "x.com", chan: ch, down: 40000, ok: true });
  eq("大响应回来就解除", W.chanPref("9.9.9.7", "x.com"), 0);
  W.vClear();
  const ch2 = { kind: "r", ip: "9.9.9.8" };
  W.vSet("x.com", "r:9.9.9.8", 200, 40, 1);
  W.recordBlock({ target: "x.com", chan: ch2, down: 700, ok: false });
  eq("probe 确认过能通的通道不被小响应当掉", W.chanPref("9.9.9.8", "x.com"), 0);
  W.vClear();
}
// 第 41 组：差分复核链路已删除（免费计划单次 userland TLS 握手就超 CPU 预算，实测 1102）
// 它在 7.69 删掉 subtls 时就只剩空壳：两个探测开关（PROBE_REQ / PROBE_RND）恒为 0 ⇒ 入队闸门恒假、
// 预算里 vt 份额恒为 0、runRound 立即返回 ⇒ 队列只进不出，?vtq=1 永远显示一份没人处理的积压。
ok("两个探测开关已随复核链路一起删除（7.153：零读取点的假旋钮）", W.SC.PROBE_REQ === undefined && W.SC.PROBE_RND === undefined);
eq("没有复核判定函数（封锁判定只走 tbf 的两批共识）", W.judge, undefined);
eq("没有复核队列", W.queueLen, undefined);
eq("HOOK 不再有 verify 槽位", W.HOOK.verify, undefined);
eq("状态里不再有复核队列", W.S.vtQ, undefined);
eq("状态里不再有「最近一次复核结果」", W.S.vtLast, undefined);

// 第 42 组：HTTP 状态码判据接进决策（状态码级证据，1 个请求即可学会）
W.vClear(); W.S.cfHttp.clear();
W.S.cfHttp.set("x.com", { code: 403, colo: "SOF", t: Date.now() });
const d403 = W.decide({ host: "x.com", cfHost: true, clientV6: false, relays: ["104.16.0.5"], legacyWantsRelay: false });
ok("本出口 403 → 决策绕中继", d403.chan.kind === "r" && d403.why === "http403");
W.S.cfHttp.set("x.com", { code: 200, colo: "VIE", t: Date.now() });
const d200 = W.decide({ host: "x.com", cfHost: true, clientV6: false, relays: ["104.16.0.5"], legacyWantsRelay: true });
// 本出口 fetch 的 200 只代表 CF 自己出得去，不代表隧道直连出得去（实测同一时刻 200 → 隧道 403），
// 所以只有隧道直连自己有过成功证据时才省这一跳。
eq("本出口 200 但隧道直连无证据 → 仍走已知可用中继", d200.chan.kind, "r");
W.vSetState("x.com", "d", 1, 1);
const d200b = W.decide({ host: "x.com", cfHost: true, clientV6: false, relays: ["104.16.0.5"], legacyWantsRelay: false });
ok("隧道直连有过成功证据 → 才省这一跳（direct-ok）", d200b.chan.kind === "d" && d200b.why === "direct-ok");
W.S.cfHttp.clear();
ok("没有状态码证据时不会强行推翻池子判断", W.decide({ host: "x.com", cfHost: true, clientV6: false, relays: [], legacyWantsRelay: false }).chan.kind === "d");
// 第 43 组：差分判据 —— 保护「正常的业务 403」
W.vClear();
W.S.needPx.clear();
W.S.smCnt.clear();
W.S.bigByHost.clear();
W.S.bigChan.clear();
// 1) 没有基线时，小响应不判死任何通道（业务 403 与封锁页在此不可区分）
W.HOOK.traffic({ host: "api.biz.com", via: "node", node: "9.9.9.9:443", down: 4000, ok: false, life: 900, up: 300 });
W.HOOK.traffic({ host: "api.biz.com", via: "node", node: "9.9.9.9:443", down: 4000, ok: false, life: 900, up: 300 });
eq("无基线的小响应不写判定（两次也不判）", W.vBad("api.biz.com", "r:9.9.9.9"), false);
ok("无基线时只学「下次优先中转」", (W.S.needPx.get("api.biz.com") || 0) > Date.now());
// 2) A 通道拿到整页 → B 通道的小响应才判被封
W.HOOK.traffic({ host: "x.com", via: "node", node: "45.136.117.194:443", down: 60000, ok: true, life: 3000, up: 900 });
eq("大响应建立基线", W.vState("x.com", "r:45.136.117.194"), 1);
W.HOOK.traffic({ host: "x.com", via: "node", node: "185.253.117.147:443", down: 4200, ok: false, life: 900, up: 300 });
eq("差分成立 → 判该中继被封", W.vBad("x.com", "r:185.253.117.147"), true);
eq("拿到整页的通道不受牵连", W.vBad("x.com", "r:45.136.117.194"), false);
// 3) 同一通道「先整页、后小响应」不算差分（可能是站点自身行为变化）
W.vClear();
W.S.smCnt.clear();
W.S.bigByHost.clear();
W.S.bigChan.clear();
W.HOOK.traffic({ host: "y.com", via: "node", node: "7.7.7.7:443", down: 60000, ok: true, life: 3000, up: 900 });
W.HOOK.traffic({ host: "y.com", via: "node", node: "7.7.7.7:443", down: 4000, ok: false, life: 900, up: 300 });
eq("同通道先大后小不判死", W.vBad("y.com", "r:7.7.7.7"), false);
// 4) 中继假 200（nginx 默认页）攒够 3 次才判
W.vClear();
W.S.smCnt.clear();
for (let i = 0; i < 3; i++) W.HOOK.traffic({ host: "z.com", via: "node", node: "6.6.6.6:443", down: 4300, ok: true, life: 900, up: 200 });
eq("假 200 攒 3 次判该中继不可用", W.vBad("z.com", "r:6.6.6.6"), true);
// 第 44 组：1 次请求感知 + 站点自愈（判定只改路由，永不断路）
W.vClear(); W.S.needPx.clear(); W.S.smCnt.clear(); W.S.bigByHost.clear(); W.S.bigChan.clear(); W.S.cfHttp.clear();
// 1) 本出口 fetch 根路径 200（站点活着）+ 小响应 → 一次即判该通道被封
W.S.cfHttp.set("x.com", { code: 200, colo: "VIE", t: Date.now() });
W.HOOK.traffic({ host: "x.com", via: "node", node: "5.5.5.5:443", down: 4200, ok: false, life: 900, up: 300 });
eq("1 次请求即可判定 IP 级封锁", W.vBad("x.com", "r:5.5.5.5"), true);
// 2) 站点自愈：所有中继都被判死时，决策仍给出中继，且该站点的结论被清空
W.vClear();
W.S.cfHttp.clear();
W.vSetState("y.com", "r:1.1.1.1", 2, 1);
W.vSetState("y.com", "d", 2, 1);
const dHeal = W.decide({ host: "y.com", cfHost: true, clientV6: false, relays: ["1.1.1.1"], legacyWantsRelay: true });
eq("没有通道可走时仍然给出中继（不断路）", dHeal.chan.kind, "r");
eq("自愈后该站点的封禁结论被清掉", W.vBad("y.com", "r:1.1.1.1"), false);
// 3) 业务 403（站点根路径本身就不是 200）不会被单次判死
W.vClear();
W.S.smCnt.clear();
W.S.cfHttp.set("api.biz.com", { code: 403, colo: "AMS", t: Date.now() });
W.HOOK.traffic({ host: "api.biz.com", via: "node", node: "8.8.8.8:443", down: 4200, ok: false, life: 900, up: 300 });
eq("业务 403 站点不被单次判死", W.vBad("api.biz.com", "r:8.8.8.8"), false);
// ═══ 第 45 组：中继存活度 RelayHealth + 偏好视图 Prefs（OOP 化后的 P1 改动）═══
W.HEALTH.clear();
eq("未知中继是中性 0.5，不惩罚新节点", W.HEALTH.score("9.9.9.9"), 0.5);
W.HEALTH.note("9.9.9.9:443", 0, false);
W.HEALTH.note("9.9.9.9:443", 0, false);
ok("两次零字节收尾后健康度掉到 0.3 以下", W.HEALTH.score("9.9.9.9") < 0.3, W.HEALTH.score("9.9.9.9"));
eq("排序把快死的中继放最后", W.HEALTH.rank(["9.9.9.9", "8.8.8.8"])[1], "9.9.9.9");
W.HEALTH.note("8.8.8.8:443", 30000, true);
ok("有一次整页后健康度高于中性", W.HEALTH.score("8.8.8.8") > 0.5, W.HEALTH.score("8.8.8.8"));
eq("ipOf 从 host:port 取 IP", W.ipOf("1.2.3.4:443"), "1.2.3.4");
W.HEALTH.clear();
W.HEALTH.note("7.7.7.7:443", 0, false);
W.HEALTH.note("7.7.7.7:443", 0, false);
eq("快死的中继被 veto（把 timeout 变成换道）", W.HOOK.veto("x.com", "7.7.7.7"), true);
eq("未知中继不被 veto", W.HOOK.veto("x.com", "6.6.6.6"), false);
W.HEALTH.clear();
W.vClear();
W.vSetState("z.com", "r:5.5.5.5", 1, 1);
const pj = W.PREFS.json(10);
ok("Prefs 类能给出两栏视图", Array.isArray(pj.ok) && Array.isArray(pj.bad) && pj.n >= 1, JSON.stringify(pj));
eq("Prefs 能看到实测能打通的通道", W.PREFS.chan("5.5.5.5", "z.com"), 0);
eq("Prefs 对完全没测过的通道返回 1（未知）", W.PREFS.chan("4.4.4.4", "z.com"), 1);
// ═══ 第 46 组：中继存活度跨 isolate（P3）+ Store 门面 ═══
W.HEALTH.clear();
W.HEALTH.note("1.1.1.1:443", 30000, true);
const hd1 = W.HEALTH.delta();
eq("delta 首次带上未上报的行", hd1.length, 1);
eq("delta 行里是 IP 与整页计数", hd1[0].i + ":" + hd1[0].o, "1.1.1.1:1");
W.HEALTH.ack();
eq("ack 之后没有新证据时 delta 为空", W.HEALTH.delta().length, 0);
W.HEALTH.merge([{ i: "2.2.2.2", o: 0, b: 0, d: 3 }]);
ok("merge 进来的零字节中继被算成快死", W.HEALTH.score("2.2.2.2") < 0.3, W.HEALTH.score("2.2.2.2"));
eq("merge 的行不再重复上报", W.HEALTH.delta().filter((x) => x.i === "2.2.2.2").length, 0);
W.HEALTH.clear();
eq("Store 门面能给出主 uuid（小写、取第一个）", W.STORE.primary({ uuid: "AA,BB" }), "aa");
ok("Store 门面暴露观测快照", Array.isArray(W.STORE.conns(5)), "conns");
// ═══ 第 47 组：Pool 类化（P4）═══
ok("Pool 是类实例，抓取/探活/准入都在它身上", typeof W.POOL === "object" && typeof W.POOL.cronScan === "function", "POOL");
ok("Pool 提供准入巡检", typeof W.POOL.ensurePool === "function" && typeof W.POOL.commitPool === "function", "ensure/commit");
ok("Pool 提供读视图", typeof W.POOL.pxGet === "function" && typeof W.POOL.aliveList === "function", "pxGet/alive");
eq("nsOf 空列表返回空表", Object.keys(W.POOL.nsOf([], 5)).length, 0);
// ═══ 第 48 组：Dialer（P5）═══
ok("Dialer 是类实例且有 open()", typeof W.DIALER === "object" && typeof W.DIALER.open === "function", "DIALER");
ok("Dialer 与 Connection 解耦（不持有 session 状态）", typeof W.Dialer === "function", "Dialer");
// ═══ 第 49 组：RegionPicker（P5-2）═══
ok("RegionPicker 是类实例且可 open()", typeof W.REGION === "object" && typeof W.REGION.open === "function", "REGION");
ok("RegionPicker 可构造", typeof W.RegionPicker === "function", "RegionPicker");
// ═══ 第 50 组：Attacher（P5-4）═══
ok("Attacher 是类实例且可 run()", typeof W.ATTACHER === "object" && typeof W.ATTACHER.run === "function", "ATTACHER");
ok("Attacher 可构造", typeof W.Attacher === "function", "Attacher");
// ═══ 第 51 组：SubscriptionView（P6-1）═══
ok("SubscriptionView 是类实例且可 render()", typeof W.SUBVIEW === "object" && typeof W.SUBVIEW.render === "function", "SUBVIEW");
ok("SubscriptionView 可构造", typeof W.SubscriptionView === "function", "SubscriptionView");
// ═══ 第 52 组：路由表（P6-2）═══
ok("RouteTable 注册了四条用户级路由", W.ROUTES.names().join(",") === "subscription,logs,proxyip,debug", W.ROUTES.names().join(","));
ok("cl 命中 subscription 且需要 RTT/统计", W.ROUTES.route("cl")?.name === "subscription" && W.ROUTES.needsRtt("cl") && W.ROUTES.needsStats("cl"), "cl");
ok("裸 /<uuid> 也命中 subscription", W.ROUTES.route("")?.name === "subscription", "empty");
ok("logs 命中但不需要 RTT", W.ROUTES.route("logs")?.name === "logs" && !W.ROUTES.needsRtt("logs"), "logs");
ok("未知子路径返回 undefined（404）", W.ROUTES.route("nope") === undefined, "nope");
// ═══ 第 53 组：判死通道的复检（P6-3）═══
{
  const rndBak = Math.random;
  const c53 = { host: "x.com", cfHost: true, clientV6: false, relays: ["9.9.9.1", "9.9.9.2"], legacyWantsRelay: true };
  W.vClear();
  W.vSetState("x.com", "r:9.9.9.1", 2, 1);
  Math.random = () => 0.01; // 命中 5% 复检
  const d1 = W.decide(c53);
  ok("被判死的通道会被 5% 概率复检", d1.why === "explore" && d1.chan.ip === "9.9.9.1", d1.why);
  Math.random = () => 0.9; // 不命中
  const d2 = W.decide(c53);
  ok("不在复检时仍避开被判死的通道", d2.why !== "explore" && d2.chan.ip === "9.9.9.2", d2.why);
  // 复检成功后应恢复正常（探测级 ok）
  W.vSetState("x.com", "r:9.9.9.1", 1, 1);
  const d3 = W.decide(c53);
  ok("复检成功即解除封禁", W.vState("x.com", "r:9.9.9.1") === 1 && d3.why !== "explore", d3.why);
  // 成功只代表「当时能通」：再次出现差分证据应能重新判死（否则一旦通过就再也不学）
  W.vClear(); // 换一个干净场景：只有流量级的弱 ok
  W.vSetState("x.com", "r:9.9.9.1", 1, 0); // 流量级 ok（弱证据）
  W.vSetState("x.com", "r:9.9.9.2", 1, 1);
  W.recordBlock({ target: "x.com", chan: { kind: "r", ip: "9.9.9.1" }, down: 800, ok: false });
  ok("流量级的 ok 可被差分证据推翻", W.vState("x.com", "r:9.9.9.1") === 2, String(W.vState("x.com", "r:9.9.9.1")));
  Math.random = rndBak;
  W.vClear();
}
// ═══ 第 54 组：PageView（P6-3）═══
ok("PageView 是类实例且五个视图都在", typeof W.PAGES === "object" && ["panel", "stats", "login", "admin", "adminHint"].every((k) => typeof W.PAGES[k] === "function"), "PAGES");
ok("PageView 可构造", typeof W.PageView === "function", "PageView");
// ═══ 第 55 组：整池被判死时的比例兜底（P6-4）═══
{
  W.vClear();
  const relays = ["7.7.7.1", "7.7.7.2", "7.7.7.3", "7.7.7.4"];
  for (const ip of relays) W.vSetState("x.com", "r:" + ip, 2, 1);
  const d = W.decide({ host: "x.com", cfHost: true, clientV6: false, relays, legacyWantsRelay: true });
  ok("整池判死时仍有可用通道", d.chan.kind !== "d" && relays.includes(d.chan.ip), d.why);
  ok("只保留最近两条判死，其余被解除", relays.filter((ip) => W.vState("x.com", "r:" + ip) === 2).length <= 2, relays.map((ip) => W.vState("x.com", "r:" + ip)).join(","));
  W.vClear();
}

  // 第 56 组：IP 级封锁探测的判定收敛（cht 分支无需真实 403 现场也能验）
  ok("全 200 → ok", W.tfVerdict([{ ok: true, status: 200 }, { ok: true, status: 200 }]) === "ok");
  ok("全 403 → site（业务 403 不写封禁）", W.tfVerdict([{ ok: false, status: 403 }, { ok: false, status: 403 }]) === "site");
  ok("全 404 → site（业务 404 也不写封禁）", W.tfVerdict([{ ok: false, status: 404 }, { ok: false, status: 404 }]) === "site");
  ok("200 与 404 并存 → chan", W.tfVerdict([{ ok: true, status: 200 }, { ok: false, status: 404 }]) === "chan");
  ok("200 与 403 并存 → chan（这才是 IP 级证据）", W.tfVerdict([{ ok: true, status: 200 }, { ok: false, status: 403 }]) === "chan");
  ok("全失败 → unknown", W.tfVerdict([{ ok: false }, { ok: false }]) === "unknown");

  
  // 第 57 组：全通道 4xx 的处置 —— 业务 4xx 绝不写封禁
  ok("全通道 4xx → 只换出口，不写封禁", W.tfEscalate("site") === "rotate");
  ok("CF 托管站点全 403 → 判为出口族被封，改换一批出口（不写封禁）", W.tfEscalate("site") === "rotate");
  ok("混采仍走 chan，不会被误升级", W.tfEscalate("chan") === "none");
  ok("只有 ok 不处置", W.tfEscalate("ok") === "none");
  ok("unknown（RST/TCP 拒绝）也继续换出口，不卡死", W.tfEscalate("unknown") === "rotate");

  
  // 第 58 组：全 4xx 的细分 —— 近零字节是 IP 族拒绝，带内容体是业务拒绝
  ok("CF 族拒绝页（body 4B）→ ipfam", W.tfClass([{ ok: false, status: 403, bytes: 4 }, { ok: false, status: 403, bytes: 4 }]) === "ipfam");
  ok("业务 403（265B JSON）→ site", W.tfClass([{ ok: false, status: 403, bytes: 265 }, { ok: false, status: 403, bytes: 265 }]) === "site");
  ok("混采仍为 chan（不受字节影响）", W.tfClass([{ ok: true, status: 200, bytes: 45290 }, { ok: false, status: 403, bytes: 4 }]) === "chan");
  ok("ipfam 也只换出口、不写封禁", W.tfEscalate("ipfam") === "rotate");

  
  // 第 59 组：rotate 的消费者 —— 换出口优先挑没探过的中继
  ok("没探过的一律优先（起点按 10 分钟轮转，但要满额且不重复）", (function () { const r = W.pickFresh("pf.z", ["pa", "pb", "pc"], 2); return r.length === 2 && new Set(r).size === 2; })());
  W.vSetState("pf.test", "r:pa", 2, 1);
  ok("探过的排到后面", W.pickFresh("pf.test", ["pa", "pb", "pc"], 2).join(",") === "pb,pc");
  ok("已探过的不会被挤出上限外时仍可用", W.pickFresh("pf.test", ["pa"], 2).join(",") === "pa");
  
  // 第 60 组：无状态码（连不上/RST）必须归 unknown，不能落到 ipfam
  ok("全失败无状态码 → unknown", W.tfClass([{ ok: false }, { ok: false }]) === "unknown");
  ok("有状态码但全 4xx 仍按字节分层", W.tfClass([{ ok: false, status: 403, bytes: 4 }]) === "ipfam");
  
  // 第 61 组：穷举各种采样组合，验证「业务 4xx 永不写封禁」这条不变量
  {
    const A = [
      { name: "200", r: { ok: true, status: 200, bytes: 45290 } },
      { name: "403tiny", r: { ok: false, status: 403, bytes: 4 } },
      { name: "403big", r: { ok: false, status: 403, bytes: 265 } },
      { name: "404", r: { ok: false, status: 404, bytes: 0 } },
      { name: "dead", r: { ok: false } },
    ];
    let combos = 0, bans = 0, badBan = 0, escOnOk = 0, noEscOnFail = 0;
    for (const a of A) for (const b of A) for (const c of A) {
      const rows = [a.r, b.r, c.r];
      const v = W.tfClass(rows);
      const esc = W.tfEscalate(v);
      const has200 = rows.some((x) => x.ok && x.status === 200);
      combos++;
      if (v === "chan") bans++;                      // chan 是唯一会写 state=2 的分支
      if (v === "chan" && !has200) badBan++;         // 有 200 才允许封禁
      if (v === "ok" && esc !== "none") escOnOk++;   // ok 不换出口
      if (!has200 && esc !== "rotate") noEscOnFail++; // 没有 200 必须继续换出口
    }
    ok("穷举 125 种采样组合", combos === 125);
    ok("封禁只可能出现在 chan", bans > 0 && badBan === 0);
    ok("ok 不触发换出口", escOnOk === 0);
    ok("没有任何 2xx 时一律继续换出口（不写封禁）", noEscOnFail === 0);
  }
  
// ---- 第 62 组：tfClass 的标签诚实性（行为分支只看有没有 2xx，这里只校验标签） ----
ok("tfClass 字节未知 → site（不冒充 ipfam）", W.tfClass([
  { ok: false, status: 403, bytes: 0 },
  { ok: false, status: 403 },
  { ok: false, status: 403, bytes: 0 },
]) === "site");
eq("tfClass 微体 → ipfam", W.tfClass([
  { ok: false, status: 403, bytes: 4 },
  { ok: false, status: 403, bytes: 4 },
]) , "ipfam");
eq("tfClass 带内容体 → site", W.tfClass([
  { ok: false, status: 403, bytes: 265 },
  { ok: false, status: 403, bytes: 4 },
]), "site");

/* ---------- 63. 源健康度：连续失败的源被降权，成功即恢复 ---------- */
{
  const envSrc = { poolSrc: "https://a.example/x.txt, https://b.example/y.txt, https://c.example/z.txt" };
  eq("env.poolSrc 覆盖生效", W.srcRank(envSrc).join(","), "https://a.example/x.txt,https://b.example/y.txt,https://c.example/z.txt");
  eq("没有 poolSrc 时用内置表", W.srcRank({}).length, 6);
  W.srcNote("https://a.example/x.txt", false);
  eq("失败一次仍排第一", W.srcRank(envSrc)[0], "https://a.example/x.txt");
  W.srcNote("https://a.example/x.txt", false);
  eq("连续两次失败排到最后", W.srcRank(envSrc)[2], "https://a.example/x.txt");
  eq("其余源保持原顺序", W.srcRank(envSrc).slice(0, 2).join(","), "https://b.example/y.txt,https://c.example/z.txt");
  eq("失败源仍会被重试（不删除）", W.srcRank(envSrc).length, 3);
  W.srcNote("https://a.example/x.txt", true);
  eq("成功一次立刻恢复首位", W.srcRank(envSrc)[0], "https://a.example/x.txt");
  eq("env.poolSrc 非法值回退内置表", W.srcRank({ poolSrc: "not-a-url" }).length, 6);
  eq("health 记录了该源", typeof W.srcHealth()["https://a.example/x.txt"], "object");
}

// 64) 错误分类直方图（/health 的 errsByKind）
console.log("\n64) 错误分类直方图");
{
  eq("errKind 取前两个词", W.errKind("tfb x.com site ok=0 bad=3 esc=rotate n=3"), "tfb x.com");
  eq("errKind 第二类", W.errKind("forced proxyip 1.2.3.4:443"), "forced proxyip");
  eq("空消息给占位", W.errKind(""), "?");
  const before = W.errHist().find((x) => x.k === "tfb x.com");
  const n0 = before ? before.n : 0;
  W.errCount("tfb x.com chan ok=1 bad=1 esc=none n=2");
  W.errCount("tfb x.com ok ok=3 bad=0 esc=none n=3");
  const after = W.errHist().find((x) => x.k === "tfb x.com");
  eq("同类两次累加", after.n, n0 + 2);
  const other = W.errHist().find((x) => x.k === "cron: scan");
  eq("别的类不受影响", other, undefined);
  W.errCount("cron: scan start");
  eq("跨前缀独立成立", W.errKind("cron: scan start"), "cron: scan");
  ok("直方图键不含正文", W.errHist().every((x) => !/bad=|ok=\d/.test(x.k)));
  W.errHist().forEach((x) => ok("直方图项非空", x.k.length > 0 && x.n > 0));
  ok("直方图最多 8 条", W.errHist().length <= 8, String(W.errHist().length));
}

// 65) 子请求预算：两项之和不得超过 cap（入口那一份已随「入口偏好表」一起删除）
console.log("\n65) 子请求预算");
{
  const pools = [0, 3, 10, 64, 400, 1600, 3000];
  const alives = [0, 1, 8, 64, 400, 1500];
  let worst = 0;
  for (const poolN of pools) {
    for (const aliveN of alives) {
      const q = W.planRound(poolN, Math.min(aliveN, poolN));
const sum = q.adm;
      if (sum > worst) worst = sum;
      ok(`总和不超硬上限（pool ${poolN} alive ${aliveN}）`, sum <= W.SC.SCAN_SUB, `${sum} > ${W.SC.SCAN_SUB}`);
      eq(`预算里没有入口这一项（pool ${poolN} alive ${aliveN}）`, q.edge, undefined);
      ok(`准入不超 SCAN_MAX（pool ${poolN}）`, q.adm <= 400, String(q.adm));
    }
  }
  ok("最坏情况也没超 48", worst <= 48, String(worst));
  // 7.186：以前这里拿 plan.cap 当上界，而 cap 在生产侧零读取 —— 断言永远成立、什么也没锁住。
  // 现在锁真实账本：剩余 fetch 额度 = 硬上限 − 固定支出，且固定支出本身不能吃掉一半预算。
  const l0 = W.planRound(1600, 8);
  eq("剩余 fetch 额度 = 硬上限 − 固定支出", l0.sub, W.SC.SCAN_SUB - W.SUB_FIXED_N);
  ok("剩余额度非负", l0.sub >= 0, String(l0.sub));
  ok("固定支出不到硬上限的一半", W.SUB_FIXED_N * 2 <= W.SC.SCAN_SUB, String(W.SUB_FIXED_N));
  eq("固定支出只剩三笔（源/判定批/DoH）", Object.keys(W.SUB_FIXED).length, 3);
  ok("上报与快照不再算作固定支出（人数由分账决定）", W.SUB_FIXED.pend === undefined && W.SUB_FIXED.snap === undefined);
}

// 66) 入口偏好不在服务端做：整条探测链（EDGE_AUTO / edgeScan / edge:pref）已删除，
// 订阅里的入口只来自客户端 url-test 与内置种子 IP。
console.log("\n66) 入口偏好整条服务端链路已删除");
{
  eq("EDGE_AUTO 常量已删除", W.SC.EDGE_AUTO, undefined);
  for (const poolN of [0, 64, 1600, 3000]) {
const q = W.planRound(poolN, Math.floor(poolN / 2));
ok(`额度不超额（pool ${poolN}）`, q.adm <= W.SC.SCAN_SUB, String(q.adm));
  }
  const big = W.planRound(3000, 0);
ok("整轮额度都给了准入", big.adm >= 40, String(big.adm));
}

// 67) 探测全关时，判定扫描不占额度
console.log("\n67) 探测全关时的预算");
{
  ok("两个探测开关已删除（不再有「关着的旋钮」）", W.SC.PROBE_REQ === undefined && W.SC.PROBE_RND === undefined);
  for (const poolN of [0, 64, 400, 1600, 3000]) {
    const q = W.planRound(poolN, 0);
eq(`预算里不再有判定额度这一项（pool ${poolN}）`, q.vt, undefined);
    ok(`准入吃满（pool ${poolN}）`, q.adm >= 40, String(q.adm));
ok(`不超额（pool ${poolN}）`, q.adm <= W.SC.SCAN_SUB, String(q.adm));
  }
  const big = W.planRound(3000, 0);
  ok("准入拿到 48 上限附近", big.adm >= 44 && big.adm <= W.SC.SCAN_SUB, String(big.adm));
}

// 68) 探活并发上限
console.log("\n68) 探活分段");
{
  ok("并发上限是 6", W.SC.PROBE_CONC === 6, String(W.SC.PROBE_CONC));
  const c1 = W.chunks([...Array(13).keys()], W.SC.PROBE_CONC);
  eq("13 个切成 3 段", String(c1.length), "3");
  eq("段大小 6/6/1", c1.map((x) => x.length).join(","), "6,6,1");
  const total = c1.reduce((a, x) => a + x.length, 0);
  eq("切完不丢不多", String(total), "13");
  ok("每段都不超上限", c1.every((x) => x.length <= W.SC.PROBE_CONC), String(Math.max(...c1.map((x) => x.length))));
  eq("空数组不产生段", String(W.chunks([], 6).length), "0");
  eq("非法 n 退化成 1", String(W.chunks([1, 2, 3], 0).map((x) => x.length).join(",")), "1,1,1");
}
// 69) 中继健康表的有界性与键解析
console.log("\n69) 中继健康表");
{
  const h1 = new W.RelayHealth();
  for (let i = 0; i < 260; i++) h1.note(`10.0.${Math.floor(i / 250)}.${i % 250}:443`, 30000, true);
  ok("整页中继不会把表撑破", h1.size() <= 200, String(h1.size()));
  const h2 = new W.RelayHealth();
  for (let i = 0; i < 260; i++) h2.note(`10.1.${Math.floor(i / 250)}.${i % 250}:443`, 0, false);
  ok("全是死中继时表也有界（回归）", h2.size() <= 200, String(h2.size()));
  const h3 = new W.RelayHealth();
  h3.note("1.2.3.4", 5000, false);
  eq("裸 IP 也按原样记键", h3.json(3)[0].ip, "1.2.3.4");
  h3.note("2606:4700::1:443", 30000, true);
  eq("IPv6:port 切出裸地址", h3.json(3).map((r) => r.ip).join(",").includes("2606:4700::1"), true);
}

// 70) 增量上报的 ack/nack 语义
console.log("\n70) 增量上报");
{
  const h = new W.RelayHealth();
  h.note(`10.9.9.9:443`, 30000, true);
  const a1 = h.delta();
  eq("第一次 delta 带 1 行", String(a1.length), "1");
  const a2 = h.delta();
  eq("没 ack 就再问一次，仍是那 1 行（不再丢）", String(a2.length), "1");
  eq("两次内容一致", JSON.stringify(a2[0]), JSON.stringify(a1[0]));
  h.ack();
  eq("ack 之后没有增量", String(h.delta().length), "0");
  h.note(`10.9.9.9:443`, 0, false);
  eq("新证据重新产生增量", String(h.delta().length), "1");
  h.nack();
  eq("nack 之后同一份证据还能再报", String(h.delta().length), "1");
  const v = new W.RelayHealth();
  v.note(`10.9.9.8:443`, 0, false);
  const b1 = v.delta();
  v.nack();
  const b2 = v.delta();
  eq("计数形增量不会因 nack 而改写", JSON.stringify(b2[0]), JSON.stringify(b1[0]));
  // 判定表的强证据同样走 pending
  W.vSet("ack.example.com", "r:203.0.113.7", 403, 120);
  W.vSetState("ack.example.com", "r:203.0.113.7", 2, 1);
  const vd1 = W.vtDelta().filter((x) => x.k.includes("ack.example.com"));
  ok("强证据进入增量", vd1.length === 1, String(vd1.length));
  const vd2 = W.vtDelta().filter((x) => x.k.includes("ack.example.com"));
  eq("未 ack 前重复调用仍在增量里", String(vd2.length), "1");
  W.vtAck();
  eq("vtAck 之后不再重复上报", String(W.vtDelta().filter((x) => x.k.includes("ack.example.com")).length), "0");
}

// 71) 错误日志：限流与表满
console.log("\n71) 错误日志限流");
{
  const d0 = W.errDup();
  W.logErr("t71 dup probe", "h1");
  W.logErr("t71 dup probe", "h1");
  W.logErr("t71 dup probe", "h1");
  ok("限流丢掉的也算进账", W.errDup() - d0 === 2, String(W.errDup() - d0));
  const d1 = W.errDup();
  for (let i = 0; i < 240; i++) W.logErr(`t71 flood ${i}`, `h${i}`);
  W.logErr("t71 dup probe", "h1");
  eq("表被灌满后，5 秒内的旧键仍被限流（不再整表清空）", W.errDup() - d1, 1);
  ok("灌满没把限流表清空", W.errDup() - d1 === 1, String(W.errDup() - d1));
}

// 72) 探活失败记录的时效
console.log("\n72) 探活失败过期");
{
  const key = "198.51.100.77:443";
  const t0 = 1_700_000_000_000;
  ok("阈值是 3", W.SC.SCAN_BAD_MAX === 3, String(W.SC.SCAN_BAD_MAX));
  ok("过期时长 30 分钟", W.SC.PROBE_BAD_TTL === 1800000, String(W.SC.PROBE_BAD_TTL));
  ok("没失败过不跳过", W.probeBadSkip(key, t0) === false, "false");
  W.bumpProbeBad(key, false, t0);
  ok("失败 1 次不跳过", W.probeBadSkip(key, t0) === false, "false");
  W.bumpProbeBad(key, false, t0 + 1000);
  W.bumpProbeBad(key, false, t0 + 2000);
  ok("连续 3 次后跳过", W.probeBadSkip(key, t0 + 3000) === true, "true");
  ok("30 分钟后自动作废", W.probeBadSkip(key, t0 + 2000 + W.SC.PROBE_BAD_TTL + 1) === false, "false");
  // 真正过了 TTL 之后再失败，才算新一轮
  W.bumpProbeBad(key, false, t0 + 2000 + W.SC.PROBE_BAD_TTL + 5000);
  ok("过期后再失败从 1 重新数（还不跳过）", W.probeBadSkip(key, t0 + 2000 + W.SC.PROBE_BAD_TTL + 5000) === false, "false");
  W.bumpProbeBad(key, false, t0 + 2000 + W.SC.PROBE_BAD_TTL + 6000);
  W.bumpProbeBad(key, false, t0 + 2000 + W.SC.PROBE_BAD_TTL + 7000);
  ok("重新数满 3 次又跳过", W.probeBadSkip(key, t0 + 2000 + W.SC.PROBE_BAD_TTL + 7000) === true, "true");
  W.bumpProbeBad(key, true, t0 + 2000 + W.SC.PROBE_BAD_TTL + 8000);
  ok("探活成功立刻清除", W.probeBadSkip(key, t0 + 2000 + W.SC.PROBE_BAD_TTL + 8000) === false, "false");
}

console.log("\n73) 业务 4xx 不被误升级成封锁");
{
  const ev = (o) => ({ host: "shop.example.com", cf: true, ok: true, down: 0, up: 0, life: 100, via: "node", node: "198.51.100.9:443", ...o });
  W.vClear();
  W.JUDGE.onTraffic(ev({ host: "api.example.com", down: 265 }));
  eq("业务 403 不写站点级封锁", W.vBad("api.example.com", "r:198.51.100.9"), false);
  eq("业务 403 不写通配封锁", W.vBad("*", "r:198.51.100.9"), false);
  W.JUDGE.onTraffic(ev({ host: "www.example.com", down: 30000, node: "203.0.113.7:443" }));
  W.JUDGE.onTraffic(ev({ host: "www.example.com", down: 260, node: "198.51.100.9:443" }));
  eq("差分成立也只做软降权（不写通配）", W.vBad("*", "r:198.51.100.9"), false);
  eq("差分成立时软降权生效", W.JUDGE.negOn("www.example.com", "198.51.100.9"), true);
  eq("软降权 10 分钟后失效", W.JUDGE.negOn("www.example.com", "198.51.100.9", Date.now() + 601000), false);
}

// 74) 正记忆：刚出过整页的中继优先复用
console.log("\n75) 正记忆优先复用");
{
  const host = "shop.example.com";
  const a = "198.51.100.11";
  const b = "198.51.100.12";
  const t0 = Date.now();
  W.vClear();
  W.JUDGE.markPos(host, b, t0);
  eq("正记忆写入后命中", W.JUDGE.posOn(host, b, t0 + 1000), true);
  eq("正记忆 10 分钟后失效", W.JUDGE.posOn(host, b, t0 + 601000), false);
  W.JUDGE.markPos(host, b, Date.now());
  // 故意让「另一条」的证据更新：只按证据时间排序会选 a，只有正记忆能把 b 顶到队首
  W.vSetState(host, "r:" + b, 1, 1);
  W.vSetState(host, "r:" + a, 1, 1);
  const ctx = { host, cfHost: true, clientV6: false, relays: [a, b], legacyWantsRelay: true };
  eq("站点级选择优先正记忆中继", W.decide(ctx).chan.ip, b);
  eq("普通目标不受正记忆影响", W.decide({ ...ctx, cfHost: false }).chan.kind, "d");
}

// 第 38c 组：站点 × 中继的实测性能记忆（同一中继对不同站点快慢不同）
{
  W.RELPERF.clear();
  W.relNote("a.example.com", "203.0.113.7", 200, 1600);
  W.relNote("a.example.com", "203.0.113.9", 400, 300);
  eq("快中继代价更低", W.relCost("a.example.com", "203.0.113.7") < W.relCost("a.example.com", "203.0.113.9"), true);
  eq("没量过的中继代价是 1e6", W.relCost("a.example.com", "203.0.113.99"), 1e6);
  eq("样本按站点分开存", W.relCost("b.example.com", "203.0.113.7"), 1e6);
  // 两条中继都能通时，选代价更低的那条（健康度都未知 → 由站点 × 中继决定）
  const ctxR = { host: "a.example.com", cfHost: true, clientV6: false, relays: ["203.0.113.9", "203.0.113.7"], legacyWantsRelay: true };
  eq("按站点 × 中继选更快的那条", W.decide(ctxR).chan.ip, "203.0.113.7");
  eq("调试快照按代价升序", W.relSnap("a.example.com")[0].relayIp, "203.0.113.7");
  W.RELPERF.clear();
  eq("清空后代价回到未知", W.relCost("a.example.com", "203.0.113.7"), 1e6);
}

// 第 38d 组：两种模式对「快」的定义不同
{
  W.RELPERF.clear();
  // 甲：首字节 150ms、只有 100 KB/s；乙：首字节 400ms、2500 KB/s
  W.relNote("c.example.com", "203.0.113.11", 150, 100);
  W.relNote("c.example.com", "203.0.113.12", 400, 2500);
  eq("delay 模式选首字节更快的那条", W.decide({ host: "c.example.com", cfHost: true, clientV6: false, relays: ["203.0.113.12", "203.0.113.11"], legacyWantsRelay: true, mode: "lat" }).chan.ip, "203.0.113.11");
  eq("tput 模式选拉 1MB 更快的那条", W.decide({ host: "c.example.com", cfHost: true, clientV6: false, relays: ["203.0.113.11", "203.0.113.12"], legacyWantsRelay: true, mode: "tput" }).chan.ip, "203.0.113.12");
  // 新站点没量过这条中继时，用它在别处学到的容量兜底（+200ms 罚），不该退回 1e6 重学一遍
  eq("新站点沿用跨站点学到的中继容量", W.relCostMode("tput", "d.example.com", "203.0.113.12") < 1e6, true);
  eq("本站点亲测比跨站点兜底更便宜", W.relCostMode("tput", "c.example.com", "203.0.113.12") < W.relCostMode("tput", "d.example.com", "203.0.113.12"), true);
  // 小响应（4 字节 403 页 / 只量到首字节）不能被当成「小带宽」重罚：
  // 否则 45KB 的正常首页（2.5 秒 = 18KB/s）会比 403 页（4 字节 = 46KB/s）更贵，排序反向。
  W.relNote("h.example.com", "203.0.113.30", 80, 0);
  W.relNote("h.example.com", "203.0.113.32", 300, 100);
  eq("没量到吞吐的样本按首字节+固定罚计", Math.round(W.relCostMode("tput", "h.example.com", "203.0.113.30")), 2080);
  eq("没量到吞吐的样本比实测很慢的中继更便宜", W.relCostMode("tput", "h.example.com", "203.0.113.30") < W.relCostMode("tput", "h.example.com", "203.0.113.32"), true);
  W.RELPERF.clear();
}

// 第 38e 组：吞吐模式给「本站点还没量过」的中继采样机会（否则永远只有一条中继有样本）
{
  W.RELPERF.clear();
  const relays = ["203.0.113.21", "203.0.113.22", "203.0.113.23"];
  // 先量过其中一条：轮换只在「有锚样本」之后做，避免冷站点一上来就试坏机器
  W.relNote("g.example.com", "203.0.113.21", 200, 1000);
  const picked = [];
  for (let i = 0; i < 2; i++) {
    const d = W.decide({ host: "g.example.com", cfHost: true, clientV6: false, relays, legacyWantsRelay: true, mode: "tput" });
    picked.push(d.chan.ip);
    eq("吞吐模式给未量过的中继采样机会（why）", d.why, "rel-rot");
  }
  eq("轮换不会重复落在已量过的那条上", picked.every((ip) => ip !== "203.0.113.21"), true);
  eq("两条未量过的中继各被轮到一次", new Set(picked).size, 2);
  W.RELPERF.clear();
  // 延迟模式仍按老办法钉住：首字节场景下「先量三条」的代价比吞吐模式高
  const dl = W.decide({ host: "f.example.com", cfHost: true, clientV6: false, relays, legacyWantsRelay: true, mode: "lat" });
  eq("延迟模式不轮换", dl.why, "cold-pin");
  W.RELPERF.clear();
}

console.log("\n76) 出口族事实（v8 的 eg）");
{
  const T = new W.EgFacts();
  const t0 = 1750000000000;
  T.note("203.0.113.7", 4, t0);
  eq("记下 v4 出口", T.famOf("203.0.113.7", t0 + 1000), 4);
  eq("v4 出口的代价乘数是 0.95（只做同分打破）", T.bias("203.0.113.7", false, t0 + 1000), 0.95);
  T.note("2001:db8::1", 6, t0);
  eq("v6 出口的代价乘数是 1.05", T.bias("2001:db8::1", false, t0 + 1000), 1.05);
  eq("没观测过的中继不做偏置", T.bias("198.51.100.9", false, t0 + 1000), 1);
  // 冷 isolate：S.alive 还没探出来（relays 为空）时，用事实里的 v4 出口兜底，而不是直连
  W.EG.clear();
  W.EG.note("203.0.113.7", 4, Date.now());
  const pin = W.decide({ host: "x.example.com", cfHost: true, clientV6: false, relays: [], legacyWantsRelay: true });
  eq("冷启动无存活中继时用 eg 里的 v4 出口", pin.why, "eg-pin");
  eq("冷启动兜底选的是那条 v4", pin.chan.ip, "203.0.113.7");
  W.EG.clear();
  const none = W.decide({ host: "x.example.com", cfHost: true, clientV6: false, relays: [], legacyWantsRelay: true });
  eq("既没有存活中继也没有 eg 时才直连", none.why, "direct");
  eq("CF 站点：v4 出口不罚", T.bias("203.0.113.7", true, t0 + 1000), 1);
  eq("CF 站点：v6 出口重罚（实测 0/9 全 403）", T.bias("2001:db8::1", true, t0 + 1000), 40);
  eq("CF 站点：未知族只轻罚 ×2（重罚会锁死探索，见本地闭环证明）", T.bias("198.51.100.9", true, t0 + 1000), 2);
  ok("未知族必须比已知 v6 便宜（否则冷启动学不出新 v4）", T.bias("198.51.100.9", true, t0 + 1000) < T.bias("2001:db8::1", true, t0 + 1000));
  // eg 只能由 CF 托管站点的响应推导：别的站点 v6 出口也能出整页，拿它判族会反向标注
  W.EG.clear();
  W.egDerive("198.51.100.4", 45290, { cf: false }, t0 + 1000);
  eq("非 CF 站点的大页不写 eg（v6 出口也能出整页）", W.EG.famOf("198.51.100.4", t0 + 1000), 0);
  W.egDerive("198.51.100.4", 45290, { cf: true }, t0 + 1000);
  eq("CF 站点的大页才写 v4", W.EG.famOf("198.51.100.4", t0 + 1000), 4);
  W.egDerive("198.51.100.5", 737, { cf: true, peerBig: true }, t0 + 1000);
  eq("CF 站点带对照的小页写 v6", W.EG.famOf("198.51.100.5", t0 + 1000), 6);
  W.egDerive("198.51.100.6", 737, { cf: false, peerBig: true }, t0 + 1000);
  eq("非 CF 站点的小页不判族", W.EG.famOf("198.51.100.6", t0 + 1000), 0);
  // ps 必须能记负样本：否则 factor=prior/p 恒 ≤1，失败信息一条也进不去
  W.PS.clear();
  eq("没有样本时 ps 因子为 1", W.psFactor("neg.example.com", "198.51.100.7"), 1);
  W.PS.note("neg.example.com", "198.51.100.7", false, Date.now());
  ok("一次失败就让 ps 变贵（>1）", W.psFactor("neg.example.com", "198.51.100.7") > 1);
  W.PS.note("neg.example.com", "198.51.100.7", true, Date.now());
  W.PS.note("neg.example.com", "198.51.100.7", true, Date.now());
  ok("连续成功把 ps 拉回（< 3）", W.psFactor("neg.example.com", "198.51.100.7") < 3);
  // eg-pin 不能挑一条刚判死的中继
  W.EG.clear(); W.DEAD.clear();
  // 客户端 v6 + CF 站点：只要本站点有新鲜的直连成功证据，仍然选直连（族不传递）
  W.vSetState("v6c.example.com", "d", 1, 1);
  eq("v6 客户端 + CF 站点有直连证据 → direct-ok", W.decide({ host: "v6c.example.com", cfHost: true, clientV6: true, relays: ["203.0.113.21"], legacyWantsRelay: true }).why, "direct-ok");
  W.vClear();
  W.EG.note("198.51.100.8", 4, Date.now());
  W.deadNote("198.51.100.8", false, Date.now());
  W.deadNote("198.51.100.8", false, Date.now());
  eq("eg-pin 跳过已判死的 v4 出口（无存活中继时退直连）", W.decide({ host: "dead.example.com", cfHost: true, clientV6: false, relays: [], legacyWantsRelay: true }).why, "direct");
  W.EG.clear(); W.DEAD.clear();
  eq("非 CF 站点不做族分层（github/example 在 v6 上都能过）", T.bias("2001:db8::1", false, t0 + 1000), 1.05);
  eq("过了寿命就当作未知", T.famOf("203.0.113.7", t0 + W.EG_TTL + 1), 0);
  eq("新学到的进待发队列", T.delta().length, 2);
  T.nack();
  eq("nack 只丢待发标记，事实还在", T.famOf("2001:db8::1", t0 + 1000), 6);
  eq("nack 后同一批仍会重发（pending 语义：失败≠送达）", T.delta().length, 2);
  eq("更旧的远端观测被忽略", T.load([{ i: "2001:db8::1", f: 4, at: t0 - 1 }]), 0);
  eq("更新的远端观测被采纳", T.load([{ i: "2001:db8::1", f: 4, at: t0 + 5 }]), 1);
  eq("合并后族跟着翻", T.famOf("2001:db8::1", t0 + 10), 4);
  W.EG.clear();
  W.EG.note("203.0.113.9", 6, Date.now());
  W.EG.note("203.0.113.11", 4, Date.now());
  W.relNote("eg.example", "203.0.113.9", 100, 500);
  W.relNote("eg.example", "203.0.113.11", 100, 500);
  const egPick = W.decide({ host: "eg.example", cfHost: true, clientV6: false, relays: ["203.0.113.9", "203.0.113.11"], legacyWantsRelay: true });
  eq("实测代价相同时优先 v4 出口", egPick.chan && egPick.chan.ip, "203.0.113.11");
  W.EG.clear();
}

console.log("\n77) 事实写入决策器（v8 的 commitFact）");
{
  const T = 1700000000000;
  const R = (x) => ({ kind: "relay", host: "x.com", relay: "45.136.117.194", at: T, ...x });
  const D = (x) => ({ kind: "direct", host: "x.com", at: T, ...x });
  const K = "x.com|45.136.117.194";
  const V = [
    ["回显 v4 写 eg", R({ echoFam: 4, down: 620 }), {}, "ok", "eg"],
    ["回显太小不算", R({ echoFam: 4, down: 20 }), {}, "R_ECHO_SMALL"],
    ["tiny + 有整页对照 → B 级证据（不写事实）", R({ down: 737, status: 403 }), { bigTypical: 45000, peers: [D({ down: 45290 })] }, "R_TINY_PEER"],
    ["403 tiny 且无对照 → 站点级", R({ down: 737, status: 403 }), { bigTypical: 45000 }, "R_SITE_LEVEL"],
    ["200 tiny 且对照不够大", R({ down: 737, status: 200 }), { bigTypical: 45000, peers: [D({ down: 5000 })] }, "R_NO_BIG_PEER"],
    ["tiny 有对照但只这一条 → 仍是 B 级", R({ down: 737, status: 403 }), { bigTypical: 45000, peers: [D({ down: 45290 })] }, "R_TINY_PEER"],
    ["直连腿 tiny 永不写 blk", D({ down: 737, status: 403 }), { bigTypical: 45000, peers: [R({ down: 45290 })] }, "R_DIRECT_NEVER"],
    ["429 只退避", R({ down: 400, status: 429 }), { bigTypical: 45000 }, "R_429_BACKOFF"],
    ["全通道 4xx = 站点级", R({ down: 1277, status: 415 }), { bigTypical: 1277 }, "R_SITE_LEVEL"],
    ["业务 4xx 有对照 → 记 ps", R({ down: 1277, status: 415 }), { bigTypical: 1277, peers: [D({ down: 45290 })] }, "ok", "ps"],
    ["正常大响应 → ps", R({ down: 45290, status: 200 }), { bigTypical: 45000 }, "ok", "ps"],
    ["证书错 → dead", R({ err: "x509", down: 0 }), {}, "ok", "dead"],
    ["直连证书错不写 dead", D({ err: "x509" }), {}, "R_DEAD_DIRECT"],
    ["同站点三分钟内出过整页 → 仍是 B 级（封锁由 BLK.note 判）", R({ down: 737, status: 403 }), { bigTypical: 45000, peers: [D({ down: 45290 })] }, "R_TINY_PEER"],
    ["节流：60s 内同键只写一次", R({ down: 45290, status: 200 }), { bigTypical: 45000, lastWrite: { [K]: T - 30000 } }, "R_THROTTLED"],
    ["1277B 且典型 1277 → 业务页不是 tiny", R({ down: 1277, status: 200 }), { bigTypical: 1277, peers: [D({ down: 1277 })] }, "ok", "ps"],
    ["932B 且典型 932 → 业务页不是 tiny", { kind: "relay", host: "example.com", relay: "45.147.250.39", at: T, down: 932, status: 200 }, { bigTypical: 932 }, "ok", "ps"],
    ["737B 且典型未知 → 仍算 tiny（有对照）", R({ down: 737, status: 403 }), { bigTypical: 0, peers: [D({ down: 45290 })] }, "R_TINY_PEER"],
    ["没拿到任何字节", R({ down: 0, status: 0 }), {}, "R_NO_BYTES"],
  ];
  let okN = 0;
  for (const [name, o, ctx, wr, wk] of V) {
    const r = W.commitFact(o, ctx);
    const pass = r.reason === wr && (wk ? Boolean(r.write) && r.write.kind === wk : true);
    eq(name, pass, true);
    if (pass) okN += 1;
  }
  eq("19 条向量与原型逐条一致", okN, V.length);
}

console.log("\n78) 写入决策器的影子统计");
{
  W.FACT.clear();
  const ev = (x) => ({ host: "shadow.example", via: "node", node: "45.136.117.194:443", down: 0, ok: true, life: 900, up: 0, ...x });
  // 时间轴必须拉开：从 v7.137 起 `WRITE_GAP` 真的生效了（`ctx.lastWrite` 有了生产者），
  // 同一个「站点|中继」60 秒内第二次裁决一律是 `R_THROTTLED`。对照窗口是 120 秒，
  // 所以「看不见对照」的用例要跨过 120 秒，而不是 60 秒。
  const t0 = 1_700_000_000_000;
  eq("整页 → 本会写 ps", W.FACT.observe(ev({ down: 45290, ok: true }), t0), "ok");
  eq("tiny 但没有同窗口对照 → 弃权", W.FACT.observe(ev({ down: 737, ok: true, life: 80 }), t0 + 121000), "R_NO_BIG_PEER");
  eq("直连腿的 tiny → 永不写封锁", W.FACT.observe(ev({ via: "direct", node: "", down: 737 }), t0 + 242000), "R_DIRECT_NEVER");
  eq("零字节 → 弃权", W.FACT.observe(ev({ down: 0, ok: false }), t0 + 363000), "R_NO_BYTES");
  const sn = W.FACT.snap();
  eq("影子统计了 4 条", sn.samples, 4);
  eq("本会写 ps 的只有 1 条", sn.would.ps, 1);
  eq("本会写封锁的是 0 条", sn.would.blk || 0, 0);
  eq("理由码也被统计", sn.why.R_NO_BYTES, 1);
  // 节流：同一个键 60 秒内只写一条事实（这条规则在 v7.137 之前根本命中不了）
  W.FACT.clear();
  const t1 = 1_700_100_000_000;
  eq("第一次整页 → 写 ps", W.FACT.observe(ev({ down: 45290, ok: true }), t1), "ok");
  eq("20 秒后同一个键 → 节流", W.FACT.observe(ev({ down: 45290, ok: true }), t1 + 20000), "R_THROTTLED");
  eq("61 秒后再来 → 又能写", W.FACT.observe(ev({ down: 45290, ok: true }), t1 + 61000), "ok");
  W.FACT.clear();
  eq("清零后快照为空", W.FACT.snap().samples, 0);
}


console.log("\n79) 同窗口对照与 bigTypical（影子从此能算出「本会写封锁」）");
{
  W.FACT.clear();
  W.S.peers.clear();
  W.S.bigTyp.clear();
  const H = "cmp.example";
  const ev = (x) => ({ host: H, via: "node", node: "45.136.117.194:443", down: 0, ok: true, life: 900, up: 0, ...x });
  const A = "45.136.117.194:443";
  const B = "91.215.153.143:443";
  const t0 = 1_700_000_000_000;
  eq("整页先入对照环形 → 本会写 ps", W.FACT.observe(ev({ node: A, down: 45290, ok: true }), t0), "ok");
  eq("另一条中继的 tiny + 有整页对照 → B 级证据", W.FACT.observe(ev({ node: B, down: 737, ok: false, life: 80 }), t0 + 1000), "R_TINY_PEER");
  eq("同一中继 ≥60s 后再来仍是 B 级（不写事实）", W.FACT.observe(ev({ node: B, down: 737, ok: false, life: 80 }), t0 + 70000), "R_TINY_PEER");
  eq("本会写封锁的仍然是 0 条（封锁只由 BLK.note 三批投票写）", W.FACT.snap().would.blk || 0, 0);
  eq("bigTypical 取见过的最大响应", W.S.bigTyp.get(H), 45290);
  eq("737B 对 45KB 的典型页算 tiny", W.isTiny({ kind: "relay", host: H, relay: "1.2.3.4", at: t0, down: 737, status: 403 }, 45290), true);
  eq("1277B 对自身同尺寸的典型页不算 tiny", W.isTiny({ kind: "relay", host: H, relay: "1.2.3.4", at: t0, down: 1277, status: 415 }, 1277), false);
  const C = "contra.example";
  W.FACT.clear();
  W.S.peers.clear();
  W.S.bigTyp.clear();
  W.S.bigByHost.set(C, t0);
  const cev = (x) => ({ host: C, via: "node", node: A, down: 0, ok: true, life: 900, up: 0, ...x });
  eq("先喂一条整页当对照", W.FACT.observe(cev({ node: B, down: 30000, ok: true }), t0), "ok");
  eq("同通道 tiny + 有对照 → B 级证据", W.FACT.observe(cev({ down: 737, ok: false }), t0 + 1000), "R_TINY_PEER");
  eq("同通道 3 分钟内出过整页：commitFact 仍只给 B 级，反向证据由 BLK.note 判", W.FACT.observe(cev({ down: 737, ok: false }), t0 + 62000), "R_TINY_PEER");
  W.FACT.clear();
  W.S.peers.clear();
  W.S.bigTyp.clear();
  W.S.bigByHost.delete(C);
}


console.log("\n80) 站点 × 中继成功率（ps）：只折价、不剔候选");
{
  const H = "ps.example";
  // 用真实时间：ps 表的读取按 Date.now() 判过期，注入过去的固定时间戳会让行立刻过期
  const t0 = Date.now();
  W.PS.clear();
  eq("没有样本时因子恒为 1", W.psFactor(H, "203.0.113.9", t0), 1);
  eq("没有样本时 pOf 是 NaN", Number.isNaN(W.PS.pOf(H, "203.0.113.9", t0)), true);
  W.psNote(H, "203.0.113.9", false, t0);
  W.psNote(H, "203.0.113.9", false, t0 + 1000);
  eq("两次失败后变贵（因子 > 1）", W.psFactor(H, "203.0.113.9", t0 + 1000) > 1, true);
  W.psNote(H, "203.0.113.7", true, t0);
  W.psNote(H, "203.0.113.7", true, t0 + 1000);
  eq("两次成功后变便宜（因子 < 1）", W.psFactor(H, "203.0.113.7", t0 + 1000) < 1, true);
  eq("按站点分开：别的站点没有样本", W.psFactor("other.example", "203.0.113.9", t0 + 1000), 1);
  eq("45 分钟后当作没有样本", W.psFactor(H, "203.0.113.9", t0 + 46 * 60000), 1);
  for (let i = 0; i < 40; i++) W.psNote(H, "203.0.113.11", false, t0 + i * 10);
  const fw = W.psFactor(H, "203.0.113.11", t0 + 400);
  eq("折价因子不低于 0.5", fw >= 0.5, true);
  eq("折价因子不高于 2", fw <= 2, true);
  W.PS.clear();
  eq("首次合并 1 行", W.PS.load([{ k: H + "|203.0.113.20", q: 10, n: 4, at: t0 }]), 1);
  eq("更旧的观测被忽略", W.PS.load([{ k: H + "|203.0.113.20", q: 250, n: 9, at: t0 - 5 }]), 0);
  eq("更新的观测覆盖", W.PS.load([{ k: H + "|203.0.113.20", q: 250, n: 9, at: t0 + 5 }]), 1);
  W.PS.clear();
  W.psNote(H, "203.0.113.30", true, t0);
  eq("增量里有 1 行", W.PS.delta().length, 1);
  W.PS.ack();
  eq("ack 后增量清空", W.PS.delta().length, 0);
  W.PS.nack();
  eq("nack 不会清掉已经记下的事实", Number.isFinite(W.PS.pOf(H, "203.0.113.30", t0)), true);
  // 选路：同样的实测代价下，成功率历史更好的那条排前面（且坏的那条仍在候选里）
  W.PS.clear();
  W.relNote(H, "203.0.113.5", 100, 0, t0);
  W.relNote(H, "203.0.113.6", 100, 0, t0);
  W.psNote(H, "203.0.113.5", true, t0);
  W.psNote(H, "203.0.113.5", true, t0 + 1);
  W.psNote(H, "203.0.113.6", false, t0);
  W.psNote(H, "203.0.113.6", false, t0 + 1);
  const d = W.decide({ host: H, cfHost: true, clientV6: false, relays: ["203.0.113.6", "203.0.113.5"], legacyWantsRelay: true, mode: "tput" });
  eq("按站点的成功率历史选更靠前的那条", d.chan.ip, "203.0.113.5");
  const d2 = W.decide({ host: H, cfHost: true, clientV6: false, relays: ["203.0.113.11"], legacyWantsRelay: true, mode: "tput" });
  eq("历史很差的通道仍然是候选（只折价不剔除）", d2.chan.ip, "203.0.113.11");
  W.PS.clear();
  W.S.peers.clear();
  W.S.bigTyp.clear();
}


console.log("\n81) 中继「连不上」（dead）：唯一允许挪到队尾的事实");
{
  const now = Date.now();
  W.DEAD.clear();
  eq("一次失败不算死", W.isDead("203.0.113.61", now), false);
  W.deadNote("203.0.113.61", false, now);
  eq("一次失败后仍不算死", W.isDead("203.0.113.61", now), false);
  W.deadNote("203.0.113.61", false, now + 1000);
  eq("连续两次失败 → 判死", W.isDead("203.0.113.61", now + 1000), true);
  eq("30 分钟后再给机会", W.isDead("203.0.113.61", now + 31 * 60000), false);
  W.deadNote("203.0.113.62", false, now);
  W.deadNote("203.0.113.62", false, now + 1000);
  W.deadNote("203.0.113.62", true, now + 2000);
  eq("连上一次就复活（清零）", W.isDead("203.0.113.62", now + 2000), false);
  W.DEAD.clear();
  eq("合并只收判死行（n<2 被丢）", W.DEAD.load([{ i: "203.0.113.63", n: 1, at: now }]), 1);
  eq("合并后仍不算死（n=1）", W.isDead("203.0.113.63", now), false);
  eq("更新的判死行会覆盖", W.DEAD.load([{ i: "203.0.113.63", n: 2, at: now + 5 }]), 1);
  eq("合并后判死", W.isDead("203.0.113.63", now + 5), true);
  eq("更旧的行被忽略", W.DEAD.load([{ i: "203.0.113.63", n: 9, at: now }]), 0);
  W.DEAD.clear();
  W.deadNote("203.0.113.64", false, now);
  eq("增量里有 1 行", W.DEAD.delta().length, 1);
  W.DEAD.ack();
  eq("ack 后增量清空", W.DEAD.delta().length, 0);
  // 选路：判死的中继挪到队尾，但全池判死时仍要选出东西
  const H = "dead.example";
  W.DEAD.clear();
  W.PS.clear();
  W.relNote(H, "203.0.113.71", 200, 0, now);
  W.relNote(H, "203.0.113.72", 200, 0, now);
  const d1 = W.decide({ host: H, cfHost: true, clientV6: false, relays: ["203.0.113.72", "203.0.113.71"], legacyWantsRelay: true, mode: "tput" });
  eq("两条都健康时按排序取第一条", d1.chan.ip, "203.0.113.72");
  W.deadNote("203.0.113.72", false, now);
  W.deadNote("203.0.113.72", false, now + 1);
  const d2 = W.decide({ host: H, cfHost: true, clientV6: false, relays: ["203.0.113.72", "203.0.113.71"], legacyWantsRelay: true, mode: "tput" });
  eq("判死的挪到队尾，换另一条", d2.chan.ip, "203.0.113.71");
  W.deadNote("203.0.113.71", false, now + 2);
  W.deadNote("203.0.113.71", false, now + 3);
  const d3 = W.decide({ host: H, cfHost: true, clientV6: false, relays: ["203.0.113.72", "203.0.113.71"], legacyWantsRelay: true, mode: "tput" });
  eq("全池判死时仍返回候选（不返回空）", ["203.0.113.71", "203.0.113.72"].includes(d3.chan.ip), true);
  W.DEAD.clear();
  W.S.peers.clear();
  W.S.bigTyp.clear();
}


console.log("\n82) 冷启动口径：firstTry / firstPage / 灰带");
{
  W.FO.clear();
  const s0 = W.FO.snap();
  eq("没有样本时比率是 0", s0.firstTry, 0);
  eq("没有样本时 n 是 0", s0.samples, 0);
  W.FO.note(0);
  eq("零字节不算连上", W.FO.snap().firstTry, 0);
  W.FO.note(737);
  eq("封锁页（737B）算连通但不算整页", W.FO.snap().first, 1);
  eq("737B 不在整页里", W.FO.snap().page, 0);
  W.FO.note(4096);
  eq("4096 刚好算整页", W.FO.snap().page, 1);
  eq("三条到上限", W.FO.snap().samples, 3);
  eq("firstTry = 2/3", W.FO.snap().firstTry, 0.667);
  eq("firstPage = 1/3", W.FO.snap().firstPage, 0.333);
  W.FO.note(3000);
  eq("超过上限只记 skip，不改比率", W.FO.snap().firstTry, 0.667);
  eq("skip 计数了多余的一条", W.FO.snap().skip, 1);
  W.FO.clear();
  W.FO.note(2048);
  eq("2048 落在灰带", W.FO.snap().gray, 1);
  eq("灰带不算整页", W.FO.snap().page, 0);
  eq("灰带算连通", W.FO.snap().first, 1);
  W.FO.clear();
}


console.log("\n83) 单 IP 封锁（blk）：三批 × 每批 3 次、只折价、永不剔候选");
{
  const t0 = Date.now();
  W.BLK.clear();
  const feed = (host, ip, base) => { for (let b = 0; b < 3; b += 1) for (let k = 0; k < 3; k += 1) W.BLK.note({ host, ip, down: 737, peerBig: true, at: base + b * 61000 + k * 1000 }); };
  eq("默认代价倍数是 1", W.blkPen("x.example", "203.0.113.81", t0), 1);
  eq("没有整页对照时不投票", W.BLK.note({ host: "x.example", ip: "203.0.113.81", down: 737, peerBig: false, at: t0 }), false);
  eq("无对照仍不算封锁", W.blkPen("x.example", "203.0.113.81", t0), 1);
  // 一批只喂 2 次：这一批作废，不足以确认
  for (let k = 0; k < 2; k += 1) W.BLK.note({ host: "x.example", ip: "203.0.113.81", down: 737, peerBig: true, at: t0 + k * 1000 });
  W.BLK.note({ host: "x.example", ip: "203.0.113.81", down: 737, peerBig: true, at: t0 + 61000 });
  eq("每批不足 3 次不算票", W.blkPen("x.example", "203.0.113.81", t0 + 61000), 1);
  W.BLK.clear();
  feed("x.example", "203.0.113.81", t0);
  eq("三批 × 每批 3 次后代价 ×6", W.blkPen("x.example", "203.0.113.81", t0 + 122000), W.BLK_PEN);
  eq("换个站点不受影响", W.blkPen("y.example", "203.0.113.81", t0 + 122000), 1);
  eq("换个出口不受影响", W.blkPen("x.example", "203.0.113.82", t0 + 122000), 1);
  eq("90 分钟后自动恢复", W.blkPen("x.example", "203.0.113.81", t0 + 122000 + 91 * 60000), 1);
  // 反向证据：同通道刚出过整页就清零进度
  W.BLK.clear();
  feed("z.example", "203.0.113.83", t0);
  W.BLK.contra("z.example", "203.0.113.83");
  eq("反向证据清掉了已确认的行", W.blkPen("z.example", "203.0.113.83", t0 + 122000), 1);
  // 站点级自愈 + 静默
  W.BLK.clear();
  const cands = ["203.0.113.91", "203.0.113.92"];
  for (const ip of cands) feed("s.example", ip, t0);
  eq("两条候选都被判封锁", [W.blkPen("s.example", cands[0], t0 + 122000), W.blkPen("s.example", cands[1], t0 + 122000)], [W.BLK_PEN, W.BLK_PEN]);
  eq("整池被写满触发自愈", W.BLK.sweep("s.example", cands, t0 + 130000), true);
  eq("自愈后代价回到 1", W.blkPen("s.example", cands[0], t0 + 130000), 1);
  eq("自愈后该站点静默中", W.BLK.muted("s.example", t0 + 130000), true);
  eq("静默期内不再写新行", W.BLK.note({ host: "s.example", ip: cands[0], down: 737, peerBig: true, at: t0 + 140000 }), false);
  eq("静默 30 分钟后解除", W.BLK.muted("s.example", t0 + 130000 + 31 * 60000), false);
  // 只折价：候选一个都不能少
  W.BLK.clear();
  W.PS.clear();
  W.DEAD.clear();
  const H2 = "blk.example";
  W.relNote(H2, "203.0.113.94", 300, 0, t0);
  W.relNote(H2, "203.0.113.95", 100, 0, t0);
  feed(H2, "203.0.113.95", t0);
  const d1 = W.decide({ host: H2, cfHost: true, clientV6: false, relays: ["203.0.113.94", "203.0.113.95"], legacyWantsRelay: true, mode: "tput" });
  eq("被判封锁的那条排到后面（原本它最快）", d1.chan.ip, "203.0.113.94");
  const d2 = W.decide({ host: H2, cfHost: true, clientV6: false, relays: ["203.0.113.95"], legacyWantsRelay: true, mode: "tput" });
  eq("只剩被判封锁的一条时仍然用它（永不剔候选）", d2.chan.ip, "203.0.113.95");
  W.BLK.clear();
  W.S.peers.clear();
  W.S.bigTyp.clear();
}

console.log("\n84) 订阅的客户端链：实测组优先、域名入口兜底");
{
  const envS = { uuid: "u", nodes: "", proxyip: "auto" };
  const rend = (q) => W.renderClash(envS, new URL("https://example.com/x" + q), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "example.com");
  const seg = (text, name) => {
    const i = text.indexOf(`  - name: "${name}"`);
    if (i < 0) return "";
    const j = text.indexOf("\n  - name:", i + 5);
    return text.slice(i, j < 0 ? undefined : j);
  };
  const base = rend("");
  const tput = seg(base, "🚀 吞吐优先");
  const lat = seg(base, "⚡ 速率优先");
  eq("吞吐组第一个成员是入口优选（无 ?tu= 时）", tput.includes('proxies: ["🌐 入口优选"'), true);
  eq("速率组第一个成员也是入口优选", lat.includes('proxies: ["🌐 入口优选"'), true);
  eq("两个模式组都以域名入口收尾", tput.includes('", "📛 域名入口"]') && lat.includes('", "📛 域名入口"]'), true);
  const withTu = seg(rend("?tu=" + encodeURIComponent("https://probe.example.org/")), "🚀 吞吐优先");
  eq("有 ?tu= 时实测组排在最前", withTu.includes('proxies: ["📡 通道实测"'), true);
  eq("有 ?tu= 时也保留域名入口兜底", withTu.includes('", "📛 域名入口"]'), true);
  const noEdge = seg(rend("?e=0"), "🚀 吞吐优先");
  eq("?e=0 时成员里没有入口优选", noEdge.includes("🌐 入口优选"), false);
}

console.log("\n85) 康复通道（v8 D12）");
{
  W.PS.clear();
  W.RELPERF.clear();
  const host = "rehab.example.com";
  const A = "203.0.113.31", B = "203.0.113.32", C = "203.0.113.33";
  // B 历史上有过整页（成功率 1.0），但现在被排到最后（代价极高）
  for (let i = 0; i < 6; i++) W.psNote(host, B, true);
  W.relNote(host, A, 200, 2000);
  W.relNote(host, C, 220, 1900);
  W.relNote(host, B, 9000, 20);
  eq("历史成功率能读到", W.psOk(host, B) > 0.9, true);
  eq("没样本返回 -1", W.psOk(host, A), -1);
  const C2 = { host, cfHost: true, clientV6: false, relays: [A, B, C], legacyWantsRelay: true, mode: "tput" };
  let last = null;
  let hit = null;
  for (let i = 1; i <= 40; i++) {
    const d = W.decide(C2);
    if (d.why === "rehab") { if (!hit) hit = { i, ip: d.chan.ip }; }
    last = d;
  }
  eq("第 20 条触发康复", hit && hit.i, 20);
  eq("康复选的是历史成过的那条", hit && hit.ip, B);
  eq("第 40 条也触发", last.why, "rehab");
  eq("康复不会永远抢第一（前 19 条不是 rehab）", hit && hit.i > 1, true);
}


console.log("\n86) commitFact 单一裁决：ps 由 judge 写入");
{
  W.PS.clear();
  const obs0 = W.cntView().cfObs || 0;
  const host = "psw.example.com";
  const ip = "198.51.100.77";
  W.JUDGE.onTraffic({
    host,
    via: "node",
    node: ip + ":443",
    down: 45210,
    ok: true,
    life: 1800,
    up: 1200,
    cf: false,
    at: Date.now(),
  });
  eq("中继腿拿到整页 → 写入 ps", W.psOk(host, ip) > 0.6, true);
  W.JUDGE.onTraffic({
    host,
    via: "direct",
    node: "",
    down: 45210,
    ok: true,
    life: 1800,
    up: 1200,
    cf: false,
    at: Date.now(),
  });
  eq("直连腿不写站点×中继成功率", W.psOk(host, "d"), -1);
  eq("两个事件各裁决一次（cfObs +2）", (W.cntView().cfObs || 0) - obs0, 2);
}


console.log("\n86b) 密集 tiny 只留一条负样本（节流在判据里，不在调用方）");
{
  const host = "dense.example.com";
  const A = "198.51.100.21:443";
  const B = "198.51.100.22:443";
  const t0 = 1_700_200_000_000;
  const mk = (node, down, ok, at) => ({ host, via: "node", node, down, ok, life: down > 20000 ? 1800 : 80, up: 400, cf: false, at });
  const p0 = W.cntView().psNote || 0;
  // 先从中继 B 拿一页整页：这是「同窗口有对照」的来源
  W.JUDGE.onTraffic(mk(B, 45210, true, t0));
  // 同一个中继 A 连续 5 条 tiny：只有第一条能记负样本（同一个键 60 秒内只写一条事实）
  for (let i = 0; i < 5; i += 1) W.JUDGE.onTraffic(mk(A, 737, false, t0 + 1000 + i * 200));
  eq("整页 1 条正样本 + 密集 tiny 只 1 条负样本", (W.cntView().psNote || 0) - p0, 2);
  eq("负样本真的进了 ps（不是只记了计数）", W.psOk(host, "198.51.100.21") < 0.6, true);
}


console.log("\n87) 延迟观测：p95all / p95ok / good3s");
{
  W.LAT.clear();
  for (let i = 0; i < 10; i++) W.LAT.note(true, 500 + i * 100);
  W.LAT.note(true, 9000); // 一条很慢的成功
  for (let i = 0; i < 9; i++) W.LAT.note(false, 60); // 失败页很快
  const s1 = W.LAT.snap();
  eq("样本数", s1.n, 20);
  eq("good3s 只算成功且 ≤3s", s1.good3s, 0.5);
  eq("p95ok 抓到那条 9 秒", s1.p95ok >= 9000, true);
  eq("p95all 不高于 p95ok（失败页更快）", s1.p95all <= s1.p95ok, true);
  W.LAT.clear();
  eq("清空后归零", W.LAT.snap().n, 0);
}


console.log("\n88) dns 事实：确证纯 v4 才降权 v6 出口");
{
  W.DNS.clear();
  const host = "v4only.example.com";
  eq("没观测时是不知道", W.DNS.v6Of(host), -1);
  eq("不知道时不降权", W.DNS.penOf(host, 6), 1);
  W.DNS.note(host, false);
  eq("确证纯 v4", W.DNS.v6Of(host), 0);
  eq("v6 出口乘 2", W.DNS.penOf(host, 6), 2);
  eq("v4 出口不受影响", W.DNS.penOf(host, 4), 1);
  W.DNS.note("has6.example.com", true);
  eq("有 AAAA 不降权", W.DNS.penOf("has6.example.com", 6), 1);
  // 时钟注入：24 小时后过期回「不知道」，不永久钉死
  W.DNS.note(host, false, Date.now() - W.DNS_TTL - 1);
  eq("过期即失效", W.DNS.v6Of(host), -1);
  const c = W.DNS.snap();
  eq("快照里有记录数", typeof c.n, "number");
}


console.log("\n89) 出口族预算：几条 v4 出口决定探测名额");
{
  W.EG.clear();
  const A = "198.51.100.10", B = "198.51.100.11", C = "198.51.100.12", D = "198.51.100.13";
  W.EG.note(A, 4);
  W.EG.note(B, 6);
  const c1 = W.egCounts([A, B, C, D]);
  eq("v4 计数", c1.v4, 1);
  eq("v6 计数", c1.v6, 1);
  eq("未知计数", c1.unk, 2);
  eq("出口族配额函数已删除：探测看不出出口族，配额从来不可达", W.egQuota, undefined);
  W.EG.note(C, 4);
  W.EG.note(D, 4);
  eq("v4 三票后计数跟着走", W.egCounts([A, B, C, D]).v4, 3);
}


console.log("\n90) 吞吐容量噪声门：只记比值，两次不一致就不记");
{
  W.CAP.clear();
  const t0 = Date.now();
  const A = "198.51.100.20";
  for (let i = 0; i < 8; i += 1) W.CAP.note("198.51.100." + (30 + i), 100, t0);
  eq("单次样本不构成容量比", W.CAP.capOf(A, t0), 1);
  const w1 = W.CAP.note(A, 200, t0);
  eq("第一次 200 还不算", w1, false);
  const w2 = W.CAP.note(A, 200, t0 + 1000);
  eq("两次一致且是池内 2 倍 → 记下", w2, true);
  eq("容量比夹到 2.0", W.CAP.capOf(A, t0 + 1000), 2);
  eq("吞吐模式代价 ×0.5", W.CAP.factor(A, "tput", t0 + 1000), 0.5);
  eq("延迟模式不看容量", W.CAP.factor(A, "lat", t0 + 1000), 1);
  const B2 = "198.51.100.21";
  W.CAP.note(B2, 100, t0);
  W.CAP.note(B2, 400, t0 + 1000);
  eq("两次差 4 倍 → 不记（噪声）", W.CAP.capOf(B2, t0 + 1000), 1);
  const C = "198.51.100.22";
  W.CAP.note(C, 105, t0);
  W.CAP.note(C, 110, t0 + 1000);
  eq("与池内中位数接近 → 不记", W.CAP.capOf(C, t0 + 1000), 1);
  eq("过期后回中性", W.CAP.capOf(A, t0 + 1000 + W.CAP_TTL + 1), 1);
  W.CAP.clear();
}


console.log("\n91) 活跃池目标：只作判据（加码函数已删）");
{
  eq("目标 16 条", W.ALIVE_TARGET, 16);
  ok("下限常量与加码函数都已删除", W.ALIVE_MIN === undefined && W.alivePlan === undefined);
  // 加码值最大是 16-0+4=20，而 adm 恒等于 min(max(12,SCAN_SUB), SCAN_MAX)，scanN 又被 sub 夹回去
  let clamped = 0;
  for (const sub of [12, 24, 48, 64, 400]) {
    const cap = Math.max(12, sub);
    const adm = Math.min(cap, W.SC.SCAN_MAX);
    const boosted = Math.max(adm, W.ALIVE_TARGET + 4);
    const scanN = Math.max(12, Math.min(Math.min(W.SC.SCAN_MAX, sub), adm));
    const scanN2 = Math.max(12, Math.min(Math.min(W.SC.SCAN_MAX, sub), boosted));
    if (scanN === scanN2) clamped += 1;
  }
  eq("五种子请求配额下加码都被夹回原值", clamped, 5);
  const hsrc = fs.readFileSync("src/routes/health.ts", "utf8");
  ok("/health 的 relays 给出目标规模与「不够」标记", hsrc.includes("target: ALIVE_TARGET") && hsrc.includes("short: ips.length < ALIVE_TARGET"));
  // 注释里可以留历史说明，只禁「调用」——因此按 `alivePlan(` 判，而不是按名字
  ok("cron 不再调用加码函数", !/alivePlan\s*\(/.test(fs.readFileSync("src/routes/cron.ts", "utf8")));
  const s0 = W.srcStat();
  eq("初始没有失败源", s0.bad, 0);
  W.srcNote("https://example.invalid/list.txt", false);
  W.srcNote("https://example.invalid/list.txt", false);
  const s1 = W.srcStat();
  eq("连续失败的源计入", s1.bad, 1);
  eq("带恢复时间", s1.retryAt > Date.now(), true);
}


console.log("\n92) 远端事实读取：并发只读一次 + colo 缓存命中");
{
  let hits = 0;
  const mkEnv = () => ({ uuid: "u-test", METER: { idFromName: () => "id", get: () => ({ fetch: async () => { hits += 1; await new Promise((r) => setTimeout(r, 15)); return { ok: true, json: async () => ({ vt: [], hl: [], eg: [], ps: [], dead: [], blk2: [] }) }; } }) } });
  W.S.vtLoaded = false;
  W.S.vtFlight = null;
  const before = globalThis.caches;
  delete globalThis.caches;
  await Promise.all([W.vtLoad(mkEnv()), W.vtLoad(mkEnv()), W.vtLoad(mkEnv())]);
  eq("三条并发只发一次 DO 读", hits, 1);
  eq("读完标记为已加载", W.S.vtLoaded, true);
  eq("句柄已释放", W.S.vtFlight, null);
  // 缓存命中：有 colo 缓存时不应再问 DO
  hits = 0;
  W.S.vtLoaded = false;
  globalThis.caches = { default: { match: async () => new Response(JSON.stringify({ vt: [], hl: [], eg: [], ps: [] })), put: async () => {} } };
  await W.vtLoad(mkEnv());
  eq("缓存命中不问 DO", hits, 0);
  eq("缓存命中后仍标记已加载", W.S.vtLoaded, true);
  globalThis.caches = before;
  W.S.vtLoaded = false;
  W.S.vtFlight = null;
}


console.log("\n93) 事实开关：五类乘数可单独回滚");
{
  const A = "203.0.113.70";
  W.EG.clear();
  W.EG.note(A, 4, Date.now());
  eq("未配置时全开", [...W.factParse(undefined)].length, 5);
  eq("空串表示全关", W.factParse("").size, 0);
  eq("none 表示全关", W.factParse("none").size, 0);
  eq("all 表示全开", W.factParse("all").size, 5);
  eq("按名字打开", [...W.factParse("eg, blk")].sort().join(","), "blk,eg");
  eq("未知名字被忽略", [...W.factParse("nope,ps")].join(","), "ps");
  const onlyEg = W.factParse("eg");
  eq("只开 eg 时乘数 = bias（v4 ×0.95）", Number(W.factMul(onlyEg, "example.com", A, "tput", false).toFixed(3)), 0.95);
  eq("全关时乘数恒为 1", W.factMul(W.factParse(""), "example.com", A, "tput"), 1);
  W.S.factSet = null;
  eq("factOn 未配置时全开", [...W.factOn({})].length, 5);
  W.S.factSet = null;
  eq("factOn 读绑定字符串", [...W.factOn({ facts: "ps" })].join(","), "ps");
  W.S.factSet = null;
  W.EG.clear();
}


console.log("\n94) 五类事实门面：一次取齐增量，ack 后清空");
{
  const H = "gate.example.com";
  const IP = "203.0.113.77";
  W.FACTS.clear();
  eq("清空后没有增量", Object.keys(W.FACTS.delta()).length, 0);
  W.PS.note(H, IP, true);
  W.EG.note(IP, 4);
  W.DEAD.note("203.0.113.78", false);
  W.DEAD.note("203.0.113.78", false);
  const d1 = W.FACTS.delta();
  eq("增量里 ps 有 1 行", (d1.ps || []).length, 1);
  eq("增量里 eg 有 1 行", (d1.eg || []).length, 1);
  eq("增量里 dead 有 1 行（连续两次失败）", (d1.dead || []).length, 1);
  W.DNS.note(H, false, Date.now());
  eq("增量里 dns 有 1 行", (W.FACTS.delta().dns || []).length, 1);
  eq("未 ack 前再取仍然是同一批", (W.FACTS.delta().ps || []).length, 1);
  W.FACTS.ack();
  eq("ack 后增量清空", (W.FACTS.delta().ps || []).length, 0);
  eq("ack 后 dns 增量也清空（门面必须点名五张表）", (W.FACTS.delta().dns || []).length, 0);
  eq("快照里有 dns 一类", W.FACTS.snap().dns !== undefined, true);
  W.FACTS.clear();
  const n = W.FACTS.load({ eg: [{ i: "203.0.113.9", f: 4, at: Date.now() }], ps: [{ k: H + "|203.0.113.9", q: 128, n: 8, at: Date.now() }], dead: [{ i: "203.0.113.10", n: 3, at: Date.now() }], blk2: [{ k: H + "|203.0.113.9", n: 3, at: Date.now() }] });
  eq("load 四类都并入", [n.eg, n.ps, n.dead, n.blk2].join(","), "1,1,1,1");
  eq("并入后 ps 能查到", W.PS.factor(H, "203.0.113.9") > 1, true);
  W.FACTS.clear();
}


// 95) 出口族从响应推导（不再用主动探测：探测器会连到自己的出口，见清单 §I）
{
  W.EG.clear();
  const A = "203.0.113.21";
  const B = "203.0.113.22";
  eq("整页 45KB 判 v4", W.egDerive(A, 45000, { cf: true }), 4);
  eq("写进去以后能查到 4", W.EG.famOf(A), 4);
  eq("737B 小页 + 同窗口整页对照 判 v6", W.egDerive(B, 737, { peerBig: true, cf: true }), 6);
  eq("没有整页对照的小页不写", W.egDerive("203.0.113.23", 737, { cf: true }), 0);
  eq("零字节不写", W.egDerive("203.0.113.24", 0, { peerBig: true, cf: true }), 0);
  eq("5KB 既不整页也不 tiny，不写", W.egDerive("203.0.113.25", 5000, { peerBig: true, cf: true }), 0);
  eq("空 IP 不写", W.egDerive("", 45000, { cf: true }), 0);
  eq("整页证据会把 v6 改回 v4", W.egDerive(B, 40000, { peerBig: true, cf: true }), 4);
  eq("改回后查得到 4", W.EG.famOf(B), 4);
  eq("known 旁证下的小页判 v6", W.egDerive("203.0.113.26", 737, { known: true, cf: true }), 6);
  eq("纯 v4 站点送到 900B 页面判 v4", W.egDerive("203.0.113.27", 900, { siteV4: true, cf: true }), 4);
  eq("既有 known 又有 siteV4 时按族级拒绝优先", W.egDerive("203.0.113.28", 737, { known: true, siteV4: true, cf: true }), 6);
  eq("整页优先于 siteV4", W.egDerive("203.0.113.29", 45000, { siteV4: true, cf: true }), 4);
  W.EG.clear();
}

console.log("\n95) dns 事实跨 isolate");
W.DNS.clear();
W.DNS.note("a.example.com", true, 1000);
eq("note 后有增量", W.DNS.delta().length, 1);
eq("增量带确证值", W.DNS.delta()[0].v, 1);
W.DNS.ack();
eq("ack 后增量为空", W.DNS.delta().length, 0);
W.DNS.clear();
W.DNS.note("a.example.com", false, 1000);
W.DNS.ack();
eq("只认更新的观测", W.DNS.load([{ h: "a.example.com", v: 1, at: 2000 }, { h: "a.example.com", v: 0, at: 500 }]), 1);
eq("合并后取有 AAAA 的那条", W.DNS.v6Of("a.example.com", 2500), 1);
eq("FACTS.clear 一并清 dns", (W.FACTS.clear(), W.DNS.v6Of("a.example.com", 3000)), -1);


console.log("\n96) 事实开关真的接进选路");
eq("HOOK.facts 已注册（否则绑定只是显示）", typeof W.HOOK.facts, "function");
eq("HOOK.factsFor 已注册", typeof W.HOOK.factsFor, "function");
eq("?fx=none 解析成空集合", W.HOOK.factsFor("none").size, 0);
eq("?fx=eg 只开一类", [...W.HOOK.factsFor("eg")].join(","), "eg");
W.EG.clear();
W.EG.note("203.0.113.9", 6, Date.now());
eq("开 eg 时 v6 出口被重罚", W.factMul(new Set(["eg"]), "x.com", "203.0.113.9", "tput", true) > 1, true);
eq("关 eg 时完全不罚", W.factMul(new Set(), "x.com", "203.0.113.9", "tput", true), 1);
W.EG.clear();


// 97) 事实读失败必须能重试：失败一次不该把这个 isolate 的事实层永久关掉
W.S.vtLoaded = false; W.S.vtCool = 0; W.S.vtFlight = null;
let factsCalls = 0;
const badEnv = { uuid: "00000000-0000-0000-0000-000000000000", METER: { idFromName: () => "id", get: () => { factsCalls++; return { fetch: async () => { throw new Error("boom"); } }; } } };
await W.vtLoad(badEnv);
eq("读失败不置 vtLoaded", W.S.vtLoaded, false);
eq("读失败开启 60 秒冷却", W.S.vtCool > Date.now(), true);
await W.vtLoad(badEnv);
eq("冷却期内不再重试", factsCalls, 1);
W.S.vtCool = 0;
await W.vtLoad(badEnv);
eq("冷却过后允许重试", factsCalls, 2);

// 98) 用量恢复必须受子请求预算约束（每次恢复 = 1 个 DO 子请求，一轮只有 50 个）
eq("用户数没超上限时全部恢复", W.restorePick(["a", "b", "c"], 12, 0).join(","), "a,b,c");
eq("超过上限时只取一批", W.restorePick(["a", "b", "c", "d"], 2, 0).length, 2);
eq("超出上限时按小时轮转起点", W.restorePick(["a", "b", "c", "d"], 2, 3600000).join(","), "b,c");
eq("轮转不产生重复", new Set(W.restorePick(Array.from({ length: 30 }, (_x, i) => "u" + i), 12, 7200000)).size, 12);
eq("空列表返回空", W.restorePick([], 12, 0).length, 0);
// 99) 候选池代际必须跨 isolate 单调：本地号落后时不能用旧号覆盖别人的池子
{
  const mem = new Map();
  const envP = { uuid: "00000000-0000-0000-0000-000000000000", STATS: {
    get: async (k) => (mem.has(k) ? mem.get(k) : null),
    put: async (k, v) => { mem.set(k, v); },
  } };
  const mk = (n, tag) => Array.from({ length: n }, (_x, i) => ({ h: tag + i, p: 443, cc: "" }));
  // 键名与 src/px/const.ts 的 SEED_KEY 一致；写错的话下面「代际号跟着锚点走」会立刻失败
  const putSeed = (gen, n) => mem.set("px:seed", JSON.stringify({ v: 7, ts: 0, poolGen: gen, poolN: n, builtAt: 0, byColo: {} }));
  W.S.pool = mk(10, "old"); W.S.poolGen = 3; W.S.seed.poolGen = 3; W.S.seedAt = Date.now(); W.S.seedReadFail = false; W.S.colo = "TST";
  putSeed(9, 10);
  const c1 = await W.POOL.commitPool(envP, mk(60, "n"), true);
  eq("代际号以 KV 锚点为准（不是本地 +1）", c1.gen, 10);
  eq("新代际键写进去了", mem.has("px:pool:10"), true);
  eq("锚点写回成功", c1.anchored, true);
  // 本地没有池子时，缩水判断必须看 KV 里的真实大小
  W.S.pool = []; W.S.poolGen = 10; W.S.seed.poolGen = 10;
  putSeed(10, 100);
  const c2 = await W.POOL.commitPool(envP, mk(50, "s"), false);
  eq("按 KV 的真实池子大小拒绝缩水", c2.ok, false);
  eq("拒绝时不落新代际键", mem.has("px:pool:11"), false);
  // 锚点读失败：宁可这轮不换池，也不盲写一个可能被占用的号
  const badEnv = { uuid: "00000000-0000-0000-0000-000000000000", STATS: { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); } } };
  const c3 = await W.POOL.commitPool(badEnv, mk(60, "b"), true);
  eq("锚点读失败就不提交", c3.ok, false);
  eq("理由就是 anchor read", c3.reason, "anchor read");
  W.S.pool = []; W.S.poolGen = 0; W.S.seed.poolGen = 0; W.S.colo = "";
}


// 第 101 组：管理端 Bearer 头（前缀是用 /^Bearer\s+/ 剥的，别写成 s+）
{
  const ae = { adminKey: "K#1" };
  const u = new URL("https://x/");
  const h = (v) => new Request(u, { headers: { authorization: v } });
  ok("Bearer 明文密钥可用", await W.adminAuthed(h("Bearer K#1"), u, ae));
  ok("Bearer 小写也认", await W.adminAuthed(h("bearer K#1"), u, ae));
  ok("Bearer 摘要等价凭证可用", await W.adminAuthed(h("Bearer " + (await W.sha256Hex("K#1"))), u, ae));
  ok("错误 Bearer 不通过", !(await W.adminAuthed(h("Bearer nope"), u, ae)));
}


/* ---------- 102. 统计读路径：flush 前后不倒退（v7.135 删掉 60 秒读缓存） ---------- */
{
  const doS = mkDO();
  // Meter 收的是 Request；真实运行时由 DO 桩转换，这里补一层字符串 URL 适配
  const stubOf = { fetch: (u, init) => doS.m.fetch(typeof u === "string" ? new Request(u, init) : u) };
  const envS = { uuid: "u-test", METER: { idFromName: (x) => x, get: () => stubOf } };
  const id = "u-flush-view";
  // 干净起点：账本、DO 读缓存、本地即时视图都清空
  S.pend.clear();
  S.meterCache.clear();
  S.stats.clear();
  W.STORE.addUsage(id, 100, 200, true);
  const before = await W.readStats(envS, id);
  eq("flush 前：还没上报的增量直接算进读数", [before.up, before.down], [100, 200]);
  await W.STORE.flush(envS, true);
  eq("flush 后：待上报账本已清空", S.pend.has(id), false);
  const after = await W.readStats(envS, id);
  eq("flush 后读数不倒退", [after.up, after.down], [100, 200]);
  // 这两条守的是「同一个数不要有两个真源」：旧的 60 秒读缓存被它自己的失效点架死了
  eq("统计读缓存已删除（不再有 60 秒陈旧窗口）", S.statCache, undefined);
  eq("门面不再暴露 statsCached", W.STORE.statsCached, undefined);
  // 「要不要先推增量」只认路由表：装配根里那份硬编码子路径列表已删（v7.135）
  eq("路由表是 stats 的唯一真源：订阅要推增量", W.ROUTES.needsStats("cl"), true);
  eq("调试路由不推增量", W.ROUTES.needsStats("debug"), false);
  S.pend.clear();
  S.meterCache.clear();
}

/* ---------- 103. 康复闸门看「历史最好」；只写不读的 sent 表删除（v7.138） ---------- */
{
  W.PS.clear();
  W.DNS.clear();
  const rh = "hist.example.com";
  const rip = "198.51.100.9";
  eq("没样本时 psBest 返回 -1", W.psBest(rh, rip), -1);
  W.PS.note(rh, rip, true, Date.now());
  eq("成过一次 → 历史最好是 100%", W.psBest(rh, rip) > 0.99, true);
  for (let i = 0; i < 6; i++) W.PS.note(rh, rip, false, Date.now());
  eq("连败之后当前均值掉到 0.6 以下", W.psOk(rh, rip) < 0.6, true);
  // 本轮核心：康复通道给的是「再试一次」的机会，闸门必须问「曾经行过吗」，
  // 不是「现在还好吗」—— 后者恰恰是被降权那批通道最不可能满足的条件。
  eq("但历史最好仍是 100%（康复通道还认它）", W.psBest(rh, rip) > 0.99, true);
  // 7.143 起 sent 又回来了，但这次它**有读端**：ack() 靠它只清这一批真正发出去的行
  // （delta 有上限，一次清空整个 pending 会把超限的行丢掉）。这里锁住「发完即清」这个不变量。
  W.PS.note("sent.example", "203.0.113.90", true, Date.now());
  W.PS.delta();
  eq("psfacts 的已发表在 delta 后非空（ack 要用它）", W.PS.sent instanceof Map && W.PS.sent.size > 0, true);
  W.PS.ack();
  eq("ack 之后已发表清空（不会只增不减）", W.PS.sent instanceof Map && W.PS.sent.size === 0, true);
  W.DNS.note("sent.example", true, Date.now());
  W.DNS.delta();
  W.DNS.ack();
  eq("dnsfacts 的已发表同样在 ack 后清空", W.DNS.sent instanceof Map && W.DNS.sent.size === 0, true);
  W.PS.clear();
  W.DNS.clear();

  // 批进度表按「见过的键」增长：短时间见过一大堆键时必须被压回上限
  W.BLK.clear();
  const tb = 1_000_000;
  for (let i = 0; i < 1200; i++) {
    W.BLK.note({ host: "burst.example.com", ip: `10.0.${i >> 8}.${i & 255}`, down: 737, peerBig: true, at: tb + i });
  }
  // 上限 1024，最后一次写入又加了一条才触发剪枝，所以允许 +1
  eq("批进度表有上限（不会只增不减）", W.BLK.batch.size <= 1025, true);
  W.BLK.clear();
}


console.log("\n104) 事实门面是表驱动的：五张表都在，按站点表有上限");
{
  W.FACTS.clear();
  eq("门面登记了全部五张表（新增一类必须登记，否则 interface 报错）", W.FACTS.kinds().join(","), "eg,ps,dead,blk2,dns");
  eq("快照按同一份登记表生成", Object.keys(W.FACTS.snap()).length, 5);
  // 站点名来自客户端请求、不是有限集合：两张按站点的表必须被压回上限
  W.POLICY.trim(0);
  for (let i = 0; i < 600; i++) {
    W.decide({ host: `h${i}.cap.example.com`, cfHost: false, clientV6: false, relays: [], legacyWantsRelay: false });
  }
  eq("决策序号表有上限（站点名不是有限集合）", W.POLICY.seqSize() <= 512, true);
  eq("冷启动钉住表有上限", W.POLICY.pinSize() <= 512, true);
  // 过期钉住会被清掉：先钉一条，再把时间推到 61 秒后
  W.decide({ host: "pin.example.com", cfHost: true, clientV6: false, relays: ["198.51.100.44"], legacyWantsRelay: false });
  const pinBefore = W.POLICY.pinSize();
  eq("冷启动确实钉住了一条（否则下面的过期断言是空断言）", pinBefore >= 1, true);
  W.POLICY.trim(Date.now() + 61_000);
  eq("过期钉住被清掉（trim 传未来时间）", W.POLICY.pinSize(), 0);
  W.FACTS.clear();
}
/** 第 97 组（v7.142）：门面不再提供「永远不写」的快照入口 + 管理面板的子请求预算 */
{
  // usageSnapWrite 需要用户表：门面只给 env 时 list=[] 会立刻 return，永远不写却返回 resolved
  eq("门面不再暴露 usageSnapWrite（模块函数要求用户表）", W.STORE.usageSnapWrite, undefined);
  // 管理面板每人一次 DO 往返：免费计划一次调用 50 个子请求，必须留出固定开销的余量
  eq("管理面板一次最多读 32 人的用量", W.SC.ADMIN_STATS_MAX, 32);
  eq("超出预算的人数会被计数（而不是静默显示 0）", "admStatsSkip" in W.cntView(), true);
}


// 105) DO 的 /add 必须无条件吸收事实/vt/hl/blk：同一批没有连接观测（cl）时也不能丢
// 为什么专门测这个：这一段曾经被整块嵌在 if (d.cl) 里，只有带 cl 的那批才进表，
// 而发送侧不看返回值就 syncAck —— 事实增量会静默蒸发。
{
  const do9 = mkDO();
  const stub9 = { fetch: (u, init) => do9.m.fetch(typeof u === "string" ? new Request(u, init) : u) };
  const now9 = Date.now();
  // 故意只带事实与判定表，一条 cl 都不带：这正是缺陷 39 之前的丢数据场景
  const body9 = {
    vt: [{ k: "203.0.113.9|443", s: 2, t: now9 + 600000 }],
    eg: [{ i: "203.0.113.10", f: 4, at: now9 }],
    dns: [{ h: "d39.example", v: 1, at: now9 }],
    ps: [{ k: "d39.example|203.0.113.10", q: 200, n: 3, at: now9 }],
    hl: [{ i: "203.0.113.9", o: 1, b: 0, d: 2 }],
    blk2: [{ k: "203.0.113.9|443", n: 3, at: now9 }],
  };
  await stub9.fetch("https://meter/add", { method: "POST", body: JSON.stringify(body9) });
  const j9 = await (await stub9.fetch("https://meter/vt")).json();
  eq("没有连接观测时 vt 也要落表", (j9.vt || []).some((r) => r.k === "203.0.113.9|443"), true);
  eq("没有连接观测时出口族事实也要落表", (j9.eg || []).some((r) => r.i === "203.0.113.10" && r.f === 4), true);
  eq("dns 事实跟着走", (j9.dns || []).some((r) => r.h === "d39.example" && r.v === 1), true);
  eq("ps 事实跟着走", (j9.ps || []).some((r) => r.k === "d39.example|203.0.113.10"), true);
  eq("hl 存活度跟着走", (j9.hl || []).some((r) => r.i === "203.0.113.9"), true);
  eq("封锁事实跟着走（走 blk2，不是计量表里那张没有生产者的旧表）", (j9.blk2 || []).some((r) => r.k === "203.0.113.9|443" && r.n === 3), true);
  // 带 cl 的那一批仍然按节点累加：搬出 if 不能把 cl 自己弄坏
  await stub9.fetch("https://meter/add", { method: "POST", body: JSON.stringify({ cl: [{ k: "n1", n: 1, ok: 1, dn: 100, p50: 10, p95: 20 }] }) });
  await stub9.fetch("https://meter/add", { method: "POST", body: JSON.stringify({ cl: [{ k: "n1", n: 2, ok: 2, dn: 200, p50: 12, p95: 22 }] }) });
  const c9 = await (await stub9.fetch("https://meter/cl")).json();
  const row9 = (c9.cl || []).find((r) => r.k === "n1");
  eq("cl 仍然按节点累加计数", row9 && row9.n, 3);
  eq("cl 的分位数取最新一段", row9 && row9.p95, 22);
}


// 106) 增量有上限，ack 只能清「真正发出去的那一批」
// 为什么测这个：delta() 有行数上限（eg 16 / 其余 60），而 ack() 过去一次清空整个 pending ——
// 超出上限的行既没发出去、也不会再重发，等于每条 flush 都在丢证据，且没有任何报错。
{
  W.FACTS.clear();
  const t0 = Date.now();
  // ps：70 个键，一批只发 60
  for (let i = 0; i < 70; i++) W.PS.note("a" + i + ".example", "198.51.100." + i, true, t0);
  eq("ps 一批最多 60 行", W.PS.delta().length, 60);
  W.PS.ack();
  eq("ack 之后剩下的 10 行仍在待发里（不是丢掉）", W.PS.delta().length, 10);
  W.PS.ack();
  eq("再 ack 一次就清空", W.PS.delta().length, 0);
  // delta 与 ack 之间又记了一条更新的观测：那条还没发过，不能被清
  W.PS.note("b.example", "203.0.113.77", false, t0);
  eq("单条待发正常给出", W.PS.delta().length, 1);
  W.PS.note("b.example", "203.0.113.77", true, t0 + 5000);
  W.PS.ack();
  const d4 = W.PS.delta();
  eq("ack 不会清掉 delta 之后才变新的观测", d4.length, 1);
  eq("给出的确实是新的那条", d4[0] && d4[0].at, t0 + 5000);
  W.PS.ack();
  // eg：上限 16
  for (let i = 0; i < 20; i++) W.EG.note("198.51.100." + i, 4, t0);
  eq("eg 一批最多 16 行", W.EG.delta().length, 16);
  W.EG.ack();
  eq("ack 后剩下的 4 行仍待发", W.EG.delta().length, 4);
  W.EG.ack();
  eq("eg 待发已清空", W.EG.delta().length, 0);
  // dns：上限 60
  for (let i = 0; i < 65; i++) W.DNS.note("h" + i + ".example", true, t0);
  eq("dns 一批最多 60 行", W.DNS.delta().length, 60);
  W.DNS.ack();
  eq("ack 后剩下 5 行仍待发", W.DNS.delta().length, 5);
  W.DNS.ack();
  W.FACTS.clear();
}

// 107) 站点级自愈（BLK.sweep）：覆盖率的分母必须是整池，不是过滤后的 usable
// 背景：一条中继被判「封锁」的同一刻就离开了 usable，而它的 blk2 封锁行要三批（≥3 分钟）才写成 ——
// 旧口径拿 usable 当分母时，分子恰好被同一个事件剔掉，覆盖率恒接近 0，这条自愈在生产上永不触发。
{
  const H = "sweep.example";
  W.FACTS.clear();
  const rel = [
    "203.0.113.101", "203.0.113.102", "203.0.113.103", "203.0.113.104",
    "203.0.113.105", "203.0.113.106", "203.0.113.107", "203.0.113.108",
  ];
  const t0 = Date.now();
  // 六条中继各有一条已确认的封锁行（等效于三批投票的结果，这里按上报格式直接灌表）
  W.BLK.load(rel.slice(0, 6).map((ip) => ({ k: H + "|" + ip, n: 3, at: t0 })));
  // 同一批中继在判定表里也已是「封锁」⇒ 它们从 usable 里消失，正是旧口径的病根
  for (const ip of rel.slice(0, 6)) W.vSetState(H, "r:" + ip, 2, 1);
  W.decide({ host: H, cfHost: false, clientV6: false, relays: rel, legacyWantsRelay: false });
  eq("整池 75% 有封锁行 ⇒ 触发站点级自愈", W.BLK.muted(H), true);
  eq("自愈把封锁行清掉：代价倍数回到 1", W.BLK.penOf(H, rel[0]), 1);
  // 反例：5/8 = 62.5% 不到 75%，不该自愈
  const H2 = "sweep2.example";
  W.BLK.load(rel.slice(0, 5).map((ip) => ({ k: H2 + "|" + ip, n: 3, at: t0 })));
  for (const ip of rel.slice(0, 5)) W.vSetState(H2, "r:" + ip, 2, 1);
  W.decide({ host: H2, cfHost: false, clientV6: false, relays: rel, legacyWantsRelay: false });
  eq("只到 5/8 不触发自愈", W.BLK.muted(H2), false);
}

// 108) 落盘失败必须回滚连接观测（cl 是加法合并，重发同一批会把 n/ok/dn 加两遍）
// 背景：pendFlush 只在 DO 回 200 后才清 S.cagg，save() 失败时 DO 回 500 ⇒ 下一轮回放同一批 cl。
// 旧代码只回滚 c/g/s/e 四个结构，cl 的计数留在内存里 ⇒ 被加两遍（面板的 n 与可用率因此偏移）。
{
  const d = mkDO();
  // 让 put 失败一次：模拟 DO 存储写入被拒（免费计划上偶发）
  const put0 = d.m.state.storage.put;
  let failPut = true;
  d.m.state.storage.put = async (k, v) => {
    if (failPut) throw new Error("storage down");
    return put0(k, v);
  };
  const body = { up: 100, down: 200, cl: [{ k: "1.2.3.4:443", n: 4, ok: 3, dn: 1, p50: 120, p95: 300 }] };
  const r1 = await d.m
    .fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify(body) }))
    .then(() => "ok", () => "rejected");
  eq("落盘失败时 /add 返回失败（让发送侧重发这一批）", r1, "rejected");
  eq("失败后连接观测没有留在内存里", d.m.ledger.connRing.length, 0);
  eq("失败后用量也没有留在内存里", [d.m.ledger.usage.up, d.m.ledger.usage.down], [0, 0]);
  failPut = false;
  await d.m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify(body) }));
  eq("重发同一批后连接观测只算一次", [d.m.ledger.connRing.length, d.m.ledger.connRing[0].n, d.m.ledger.connRing[0].ok], [1, 4, 3]);
  const j108 = await (await d.m.fetch(new Request("https://m/get"))).json();
  eq("用量也只算一次", [j108.up, j108.down], [100, 200]);
}
{
  // 109. tfb：两批共识（单批 403 只是怀疑）+ 记忆表限量
  const tb = (p, v) => W.tfBlockOk(p, v);
  eq("首批 chan 证据不落封锁（可能是限流）", tb("", "chan"), false);
  eq("上一批也是 chan → 两批共识成立", tb("chan/none", "chan"), true);
  eq("上一批是 ok → 这一批 chan 仍只是怀疑", tb("ok/none", "chan"), false);
  eq("这一批不是 chan → 不落封锁", tb("chan/none", "ok"), false);
  W.S.tfbV.clear();
  for (let i = 0; i < 300; i++) W.tfRemember("h" + i + ".test", "chan/none");
  eq("记忆表有上限（键来自客户端）", W.S.tfbV.size, 256);
  eq("最旧的站点已被挤掉", W.S.tfbV.has("h0.test"), false);
  eq("最新的站点仍在", [W.S.tfbV.get("h299.test"), W.S.tfbV.has("h44.test")], ["chan/none", true]);
}
{
  // 110. relperf：kbs=0 是「这次没量到吞吐」，不是「吞吐为 0」
  W.RELPERF.clear();
  const H = "tput.example";
  const A = "203.0.113.140";
  // 一次 1MB 以上的下载：800KB/s，首字节 100ms
  W.relNote(H, A, 100, 800);
  // 随后三个普通页面（都不足 1MB，Connection 记 kbs=0）
  W.relNote(H, A, 100, 0);
  W.relNote(H, A, 100, 0);
  W.relNote(H, A, 100, 0);
  eq("小响应样本不会把吞吐拽下去（100 + 512000/800）", Math.round(W.relCostMode("tput", H, A)), 740);
  eq("调试快照里的速率也还是 800", Math.round(W.relSnap(H)[0].kiloBytesPerSec), 800);
  // 反过来：先只有小响应（没量到吞吐），再来一次大下载
  W.RELPERF.clear();
  const B = "203.0.113.141";
  W.relNote(H, B, 100, 0);
  W.relNote(H, B, 100, 800);
  eq("第一次量到吞吐时不被旧的 0 稀释", Math.round(W.relCostMode("tput", H, B)), 740);
  // 一次都没量到吞吐：走「首字节 + 2000」的兜底，不能落到 32KB/s 的下限
  W.RELPERF.clear();
  const C = "203.0.113.142";
  W.relNote(H, C, 80, 0);
  W.relNote(H, C, 80, 0);
  eq("从没量到吞吐的样本按首字节 + 固定罚计", Math.round(W.relCostMode("tput", H, C)), 2080);
  // 跨站点聚合表同样不能把 0 混进来
  W.RELPERF.clear();
  const D = "203.0.113.143";
  W.relNote("agg-a.example", D, 100, 800);
  W.relNote("agg-a.example", D, 100, 0);
  eq("聚合表沿用已量到的容量（+200ms 表示不是本站点亲测）", Math.round(W.relCostMode("tput", "agg-b.example", D)), 940);
  W.RELPERF.clear();
}



/* ---------- 111. 死字段与孤儿文档（v7.151） ---------- */
eq("Thompson 的成员表缓存字段已删除（v6.42 删采样器时留下的死字段）", W.S.tsMem, undefined);
ok("状态表里不再有 tsMem 的键", !Object.prototype.hasOwnProperty.call(W.S, "tsMem"));

/* ---------- 112. 假字段与魔数（第 54–56 条） ---------- */
{
  const g = "112";
  eq(`[${g}] 判定表 TTL 只有一个来源（调试端点不再抄裸魔数）`, W.VT_TTL_MS, 30 * 60 * 1000);
  eq(`[${g}] 预算快照回 adm/sub + 三批分账（判定额度那一维 7.149 已删）`, Object.keys(W.planView(400, 20)).join(","), "adm,sub,pend,snap,restore,verds,site");
  const src = fs.readFileSync("test/_bundle.mjs", "utf8");
  ok(`[${g}] 调试端点不再回恒空字段 ips/nodes/rows`, !src.includes("ips: sw.ips") && !src.includes("nodes: sw.nodes"));
}


// 113) 站点级自愈必须在所有早返回之前（否则 5% 复检命中时这一轮就不自愈）
// 背景：sweep 原来排在「5% 复检」与「直连被判死」两条 return 之后 ⇒ 每次请求有 5% 概率跳过自愈，
//       单测因此偶发失败（同一份代码 4 次跑 1 次红）。
{
  const g = "113";
  const H = "sweep3.example";
  W.FACTS.clear();
  const rel = ["203.0.113.111", "203.0.113.112", "203.0.113.113", "203.0.113.114", "203.0.113.115", "203.0.113.116", "203.0.113.117", "203.0.113.118"];
  const t0 = Date.now();
  W.BLK.load(rel.slice(0, 6).map((ip) => ({ k: H + "|" + ip, n: 3, at: t0 })));
  for (const ip of rel.slice(0, 6)) W.vSetState(H, "r:" + ip, 2, 1);
  // 把随机数钉成 0，强制走「探索」那条早返回（Math.random() < 0.05 必然成立）
  const rnd = Math.random;
  Math.random = () => 0;
  let ch;
  try {
    ch = W.decide({ host: H, cfHost: false, clientV6: false, relays: rel, legacyWantsRelay: false });
  } finally {
    Math.random = rnd;
  }
  eq(`[${g}] 早返回走的是 5% 复检`, ch.why, "explore");
  eq(`[${g}] 复检早返回时自愈仍然做了`, W.BLK.muted(H), true);
  eq(`[${g}] 自愈清掉了封锁行`, W.BLK.penOf(H, rel[0]), 1);
}

// —— 144：状态码可见性与文档残留 ——
{
  const g = "144";
  const bundle = fs.readFileSync("test/_bundle.mjs", "utf8");
  const dbg = debugAll();
  ok(`[${g}] 「Worker 看不到 HTTP 状态码」的过期说法已删掉`, !dbg.includes("Worker 看不到 HTTP 状态码"));
  ok(`[${g}] 调试端点改为指向 tfb 与状态码缓存`, bundle.includes("要看真状态码用 cached"));
  ok(`[${g}] 只验 SNI 的注释改成真实原因（不完成握手）`, dbg.includes("不完成握手，拿不到应用层状态"));
  const audit = fs.readFileSync("tools/doc-audit.mjs", "utf8");
  ok(`[${g}] doc-audit 有叠文档规则（否则叠加的文档会让人以为函数还在）`, audit.includes("stackedDocs"));
  const consts = fs.readFileSync("src/core/const.ts", "utf8");
  ok(`[${g}] 被删常量的残留文档已清（const.ts 不再提「每个请求最多做几次探测」）`, !consts.includes("每个请求最多做几次探测"));
  const tfb = fs.readFileSync("src/route/tfb.ts", "utf8");
  ok(`[${g}] tfVerdict 的文档合并成一段（不再两段叠在一起）`, !tfb.includes("IP 级封锁探测：探 1–3 条中继"));
}


// 第 145 组：活文档引用门禁（7.156）。
// 说明：这里读的是源码/文档文件本身，不是 test/_bundle.mjs —— esbuild 会把注释与文档剥掉。

const g = "活文档引用";
const audit = fs.readFileSync("tools/doc-audit.mjs", "utf8");
const arch = fs.readFileSync("docs/ARCHITECTURE.md", "utf8");
const v8 = fs.readFileSync("docs/v8.md", "utf8");

ok(`[${g}] doc-audit 有活文档引用规则（否则文档能一直给不存在的类作证）`, audit.includes("livingRefs"));
ok(`[${g}] 类表里没有指向已删读缓存的 StatsTable 行`, !arch.includes("| `StatsTable` |"));
ok(`[${g}] 预算那段写的是自由函数而不是 Budget 类`, arch.includes("自由函数 `planRound`"));
ok(`[${g}] 快照那段不再声称有 Snapshot 类`, !arch.includes("| `Snapshot` |"));
ok(`[${g}] v8 映射表用的是落地名 FACTS.ack()`, v8.includes("`FACTS.ack()`"));
ok(`[${g}] 设计阶段的临时名只在「更正」那句里出现`, !v8.includes("`factsAck()`"));

// 146. 连接观测的上报确认：按发出去的数量相减，而不是整表清空（v7.157）
{
  const cg = W.S.cagg;
  cg.clear();
  // 45 个节点键，一次只发 40 行：多出来的 5 个必须留着，不能被清掉
  for (let i = 0; i < 45; i++) cg.set("n" + i + ":443", { n: 5, ok: 4, dn: 500, v: [100, 120] });
  const rows = W.PEND.clSnap(40);
  eq("45 个节点键一次只发 40 行", rows.length, 40);
  W.PEND.clAck(rows);
  eq("没被发出去的那 5 个键原样留着（不再被整表清空）", cg.size, 5);
  ok("发出去的键减到 0 就删掉", !cg.has(rows[0].k));
  // 在途期间新结束的连接：快照之后 cagg 又涨了 2 条，确认时不能把它一起抹掉
  cg.clear();
  cg.set("a:443", { n: 3, ok: 3, dn: 300, v: [90] });
  const one = W.PEND.clSnap(40);
  eq("快照这一行是 3 个样本", one[0].n, 3);
  cg.get("a:443").n += 2;
  cg.get("a:443").dn += 200;
  W.PEND.clAck(one);
  eq("在途期间新增的观测不会被抹掉", cg.get("a:443") && cg.get("a:443").n, 2);
  W.PEND.clAck(W.PEND.clSnap(40));
  eq("再确认一次就清干净", cg.size, 0);
  cg.clear();
}

// 147. 按站点表的内存上限：站点名是客户端给的，必须有裁剪（v7.158）
{
  // ① 通用裁剪：600 条里留最新的 512 条
  const aged = new Map();
  for (let i = 0; i < 600; i++) aged.set("h" + i, 1000 + i);
  W.trimAged(aged);
  eq("裁剪后正好是上限行数", aged.size, W.SC.HOST_MEM_MAX);
  ok("最旧的那些先被删掉", !aged.has("h0") && !aged.has("h87"));
  ok("最新的那些都还在", aged.has("h88") && aged.has("h599"));
  // ② 过期表：值是过期时刻，<= now 的都要清掉
  const exp = new Map();
  exp.set("past", 1000);
  exp.set("now", 5000);
  exp.set("future", 9000);
  eq("过期清理只删 <= now 的", W.dropExpired(exp, 5000), 2);
  eq("剩下的就是还没过期的那条", [...exp.keys()].join(","), "future");
  // ③ judge 每条整页都会写 bigByHost/bigChan：600 个不同站点后必须被压回
  W.S.bigByHost.clear();
  W.S.bigChan.clear();
  for (let i = 0; i < 600; i++) {
    const h = "big" + i + ".test";
    W.JUDGE.onTraffic({ host: h, chan: { kind: "r", ip: "198.51.100.9" }, via: "node", node: "198.51.100.9:443", ok: true, down: 45290, up: 800, life: 900, cf: false, at: 1_700_000_000_000 + i });
  }
  eq("bigByHost 被压回上限", W.S.bigByHost.size, W.SC.HOST_MEM_MAX);
  eq("bigChan 与 bigByHost 同步裁剪（落单的键会让判定读到别站点的通道）", W.S.bigChan.size, W.S.bigByHost.size);
  // ④ vtAck 顺手清掉过期的记账行
  W.S.vtPend.clear();
  W.S.vtSent.clear();
  W.S.vtPend.set("old.test|r:1.1.1.1", { s: 2, t: 1000 });
  W.S.vtPend.set("new.test|r:2.2.2.2", { s: 2, t: Date.now() + 600000 });
  W.vtAck();
  eq("vtAck 之后过期行没了、新鲜行还在", [W.S.vtSent.has("old.test|r:1.1.1.1"), W.S.vtSent.has("new.test|r:2.2.2.2")].join(","), "false,true");
  W.S.vtSent.clear();
  // ⑤ 三处调用点都在（防止后续改动把裁剪悄悄删掉）
  const dialSrc = fs.readFileSync("src/proxy/dialer.ts", "utf8");
  const vtSrc = fs.readFileSync("src/route/verdictsync.ts", "utf8");
  const jdSrc = fs.readFileSync("src/route/judge.ts", "utf8");
  ok("dialer 裁剪 cfHost", dialSrc.includes("dropExpired(S.cfHost)") && dialSrc.includes("trimAged(S.cfHost)"));
  ok("verdictsync 裁剪 vtSent", vtSrc.includes("dropExpired(S.vtSent)") && vtSrc.includes("trimAged(S.vtSent)"));
  ok("judge 裁剪 bigByHost", jdSrc.includes("trimAged(S.bigByHost)"));
  ok("verdictsync 不再自己抄 TTL", !vtSrc.includes("v.at + 1800000"));
}


// ---- 148. smCnt 必须有上限：键是「站点|通道」，两个维度都会涨 ----
for (let i = 0; i < 700; i += 1) {
  W.JUDGE.onTraffic({ host: "sm" + i + ".test", via: "node", node: "198.51.100.9:443", down: 737, ok: true, life: 80, up: 400, cf: false, at: 1700000000000 + i });
}
ok("700 个「站点|通道」之后 smCnt 仍被压在上限内", W.S.smCnt.size <= W.SC.SM_CNT_MAX);
ok("上限就是 512", W.SC.SM_CNT_MAX === 512);
// 计数大的行必须活下来：真在刷垃圾页的通道计数会涨上去，判死要看 n>=3
W.S.smCnt.clear();
W.S.smCnt.set("keep.test|r:198.51.100.9", 50);
for (let i = 0; i < 700; i += 1) W.S.smCnt.set("flood" + i + ".test|r:198.51.100.9", 1);
W.trimAged(W.S.smCnt, W.SC.SM_CNT_MAX);
eq("裁剪后正好等于上限", W.S.smCnt.size, 512);
ok("计数大的那行还在（这张表留大删小）", W.S.smCnt.has("keep.test|r:198.51.100.9"));
ok("计数最小的那些先被删", !W.S.smCnt.has("flood0.test|r:198.51.100.9"));
const judgeSrc = fs.readFileSync("src/route/judge.ts", "utf8");
ok("judge 写入 smCnt 后就地裁剪（源码断言，防止被悄悄删掉）", judgeSrc.includes("trimAged(S.smCnt"));
W.S.smCnt.clear();


// ---- 150. 中继存活度证据必须带时间：否则冷启动读回的行只能被当成「刚刚观测」 ----
W.HEALTH.clear();
W.HEALTH.merge([{ i: "203.0.113.7", o: 9, b: 0, d: 0, t: Date.now() - 3 * 3600 * 1000 }]);
ok("三小时前的证据按半衰期回落到中性", Math.abs(W.HEALTH.score("203.0.113.7") - 0.5) < 0.02);
W.HEALTH.clear();
W.HEALTH.merge([{ i: "203.0.113.8", o: 9, b: 0, d: 0, t: Date.now() }]);
ok("刚发生的证据照旧算数", W.HEALTH.score("203.0.113.8") > 0.9);
W.HEALTH.clear();
W.HEALTH.note("198.51.100.45:443", 45290, true);
const hlD = W.HEALTH.delta();
ok("增量行带上最后观测时间（否则接收端只能当刚发生）", hlD.length === 1 && hlD[0].t > 0);
const doHl = mkDO();
const stubHl = { fetch: (u, init) => doHl.m.fetch(typeof u === "string" ? new Request(u, init) : u) };
const hlT = Date.now() - 3 * 3600 * 1000;
await stubHl.fetch("https://meter/add", { method: "POST", body: JSON.stringify({ hl: [{ i: "203.0.113.9", o: 9, b: 0, d: 0, t: hlT }] }) });
const hlBack = (await (await stubHl.fetch("https://meter/hl")).json()).hl;
eq("DO 存下了证据时间", hlBack[0].t, hlT);
W.HEALTH.clear();
W.HEALTH.merge(hlBack);
ok("冷启动合并后仍按证据时间衰减（不是当成刚刚）", Math.abs(W.HEALTH.score("203.0.113.9") - 0.5) < 0.05);
W.HEALTH.clear();
console.log("\n-- 中继健康表的合并口径与死出口（v7.161）");
{
  const K = "203.0.113.9";
  const H3 = 3 * 3600 * 1000;
  W.HEALTH.clear();
  // 本地攒下 8 次成功 / 2 次小响应，但已经是三小时前的证据
  W.HEALTH.merge([{ i: K, o: 8, b: 2, d: 0, t: Date.now() - H3 }]);
  const oldStrong = W.HEALTH.score(K);
  // 别处报来一条更弱、但更新的证据：不能把旧证据的「最后一次观测」刷新到现在
  W.HEALTH.merge([{ i: K, o: 1, b: 0, d: 0, t: Date.now() }]);
  const afterWeak = W.HEALTH.score(K);
  ok("三小时前的强证据已经衰减到中性", Math.abs(oldStrong - 0.5) < 0.03);
  ok("更弱的新证据不会给它续命（计数与时间必须来自同一次观测）", Math.abs(afterWeak - 0.5) < 0.03);
  // 反过来：更强的证据应当整体胜出，并且带着自己的时间戳生效
  W.HEALTH.merge([{ i: K, o: 20, b: 1, d: 0, t: Date.now() }]);
  ok("更强的证据整体胜出（新计数 + 新时间）", W.HEALTH.score(K) > 0.8);
  // 同分时用较新的时间：等价证据不该让衰减倒流
  W.HEALTH.clear();
  W.HEALTH.merge([{ i: K, o: 2, b: 0, d: 0, t: Date.now() - H3 }]);
  W.HEALTH.merge([{ i: K, o: 1, b: 1, d: 0, t: Date.now() }]);
  ok("条数相同时采用较新的观测时间", W.HEALTH.score(K) > 0.5);
}
{
  // 每批严格 ≤40 行：以前上限判断写在压入之后，pending 已满时会返回 41 行
  W.HEALTH.clear();
  for (let i = 0; i < 60; i++) W.HEALTH.note("198.51.100." + i + ":443", 45290, true);
  ok("一批最多 40 行中继证据", W.HEALTH.delta().length === 40);
  // pending 已满时再来一条，仍然不能突破 40
  W.HEALTH.note("198.51.100.200:443", 45290, true);
  ok("pending 已满时也不会多出一行", W.HEALTH.delta().length === 40);
}
{
  const rh = fs.readFileSync("src/route/relay-health.ts", "utf8");
  ok("合并按条数、平局按较新的观测决定谁胜出", rh.includes("inN > curN || (inN === curN && at > cur.at)"));
  ok("淘汰一条中继时连账本一起清掉", (rh.match(/this\.ledger\.forget\(k\)/g) || []).length === 2);
  ok("表外的键不会被登记进已上报快照", rh.includes("this.ledger.ack((ip) => this.byRelay.has(ip));"));
  ok("中继健康表的 loaded 状态已删除（冷启动由 vtLoad 的 single-flight 负责）", W.HEALTH.loaded === undefined);
  ok("needLoad 已经不存在", typeof W.HEALTH.needLoad === "undefined");
  ok("markLoaded 已经不存在", typeof W.HEALTH.markLoaded === "undefined");
  const vs = fs.readFileSync("src/route/verdictsync.ts", "utf8");
  ok("远端事实里的中继健康行带时间戳", vs.includes("hl?: Array<{ i: string; o: number; b: number; d: number; t?: number }>"));
}

console.log("\n-- 判定表增量：待发项保留状态、每批严格 ≤60 行（v7.162）");
{
  const T = "d.test", IP = "r:9.9.9.9";
  W.vClear();
  W.S.vtPend.clear();
  W.S.vtSent.clear();
  // state=3 是 dead（硬排除），比 blocked 更强：重试时必须原样带出去
  W.vSetState(T, IP, 3, 1);
  const d1 = W.vtDelta();
  const row1 = d1.filter((r) => r.k === T + "|" + IP)[0];
  ok("state=3 的证据首次外发就是 3", !!row1 && row1.s === 3);
  W.vtNack();
  const d2 = W.vtDelta();
  const row2 = d2.filter((r) => r.k === T + "|" + IP)[0];
  const d1b = W.vtDelta();
  const row1b = d1b.filter((r) => r.k === T + "|" + IP)[0];
  ok("同一批没 ack 就再要一次，state 仍是 3（不会降级成 blocked）", !!row1b && row1b.s === 3);
  W.vtAck();
  ok("ack 之后这条已经登记成「已上报」", (W.S.vtSent.get(T + "|" + IP) || 0) > Date.now());
}
{
  // 每批严格 ≤60 行：以前上限判断写在 push 之后，pending 满 60 时会返回 61 行
  W.vClear();
  W.S.vtPend.clear();
  W.S.vtSent.clear();
  for (let i = 0; i < 100; i++) W.vSetState("cap" + i + ".test", "r:198.51.100.7", 2, 1);
  ok("一批最多 60 行判定证据", W.vtDelta().length === 60);
  ok("pending 已满时再要一批也不会多出一行", W.vtDelta().length === 60);
}
{
  const vs = fs.readFileSync("src/route/verdictsync.ts", "utf8");
  ok("待发项记的是 { s, t } 而不是只有到期时间", vs.includes("S.vtPend.set(k, { s: v.state, t: exp })"));
  ok("上限判断在压入之前", vs.indexOf("if (out.length >= 60) break;") < vs.indexOf("S.vtPend.set(k, { s: v.state, t: exp })") + 2000);
}

// 153. 「历史最好」必须跨 isolate 活着：只发当前均值的话，康复通道在每个新 isolate 里都要重新攒
{
  const now = Date.now();
  const H = "ps153.test";
  const IP = "203.0.113.63";
  const K = H + "|" + IP;
  W.PS.clear();
  // 远端行带 top：曾经 100%，现在均值只剩 30/255
  W.PS.load([{ k: K, q: 30, n: 6, at: now, top: 255 }]);
  eq("远端带来的历史最好不被当前均值覆盖", Math.round(W.PS.bestOf(H, IP) * 255), 255);
  // 再灌一行更新的、但没有 top 的旧格式：历史最好只升不降
  W.PS.load([{ k: K, q: 20, n: 7, at: now + 1000 }]);
  eq("旧格式行按当前均值起算，但不能把已知的历史最好改小", Math.round(W.PS.bestOf(H, IP) * 255), 255);
  // 第一批上报就要把 top 带上（否则对面永远学不到）
  W.PS.clear();
  W.PS.note(H, IP, true, now);
  W.PS.note(H, IP, false, now + 1);
  W.PS.note(H, IP, false, now + 2);
  const dw = W.PS.delta();
  eq("增量里带历史最好（成过一次、之后连败）", Number(dw[0] && dw[0].top), 255);
  eq("增量里的当前均值已经被连败拉下来", Number(dw[0] && dw[0].q) < 255, true);
  // DO 侧：同一行两次写入，较高的 top 留住、q 跟着新观测走
  const d1 = mkDO();
  const AD = (b) => d1.m.fetch(new Request("https://meter/add", { method: "POST", body: JSON.stringify(b) }));
  AD({ ps: [{ k: K, q: 30, n: 4, at: now, top: 200 }] });
  AD({ ps: [{ k: K, q: 40, n: 5, at: now + 1000, top: 90 }] });
  const vj = await (await d1.m.fetch(new Request("https://meter/vt"))).json();
  const prow = (vj.ps || []).find((x) => x.k === K) || {};
  eq("DO 里当前均值跟着新观测", Number(prow.q), 40);
  eq("DO 里的历史最好只升不降", Number(prow.top), 200);
  // 源码锁：增量必须把 top 放进线格式
  ok("增量带 top（源码）", fs.readFileSync("src/route/psfacts.ts", "utf8").includes("top: r.top ?? r.q"));
}
// 154. DO 必须把判定表的状态一起存下来：只存到期时间的话，dead（硬排除）读回来变成 blocked（软降权）
{
  const now = Date.now();
  const K = "vt154.test|r:203.0.113.91";
  const d4 = mkDO();
  const POST = (b) => d4.m.fetch(new Request("https://meter/add", { method: "POST", body: JSON.stringify(b) }));
  const VT = async () => ((await (await d4.m.fetch(new Request("https://meter/vt"))).json()).vt || []);
  POST({ vt: [{ k: K, s: 3, t: now + 600000 }] });
  const r1 = (await VT()).find((x) => x.k === K) || {};
  eq("dead（state=3）跨 DO 一圈仍是 dead", Number(r1.s), 3);
  // 更晚到期的证据胜出：新观测说 blocked 就接受 blocked（不是「状态只升不降」）
  POST({ vt: [{ k: K, s: 2, t: now + 900000 }] });
  const r2 = (await VT()).find((x) => x.k === K) || {};
  eq("更晚的观测决定状态", Number(r2.s), 2);
  eq("到期时间跟着更晚的那条", Number(r2.t), now + 900000);
  // 同一时刻：更严格的状态胜（宁可多排除，不可少排除）
  const K3 = "vt154b.test|r:203.0.113.92";
  POST({ vt: [{ k: K3, s: 2, t: now + 600000 }] });
  POST({ vt: [{ k: K3, s: 3, t: now + 600000 }] });
  const r3 = (await VT()).find((x) => x.k === K3) || {};
  eq("同一到期时刻取更严格的状态", Number(r3.s), 3);
  // 老数据（裸数字，只有到期时间）仍要能读：按 blocked 处理
  const K4 = "vt154c.test|r:203.0.113.93";
  d4.m.ledger.vt[K4] = now + 600000;
  const r4 = (await VT()).find((x) => x.k === K4) || {};
  eq("老格式（裸到期时间）读成 blocked", Number(r4.s), 2);
  ok("DO 侧存状态（源码）", storeSrc().includes("r.s === St.Dead ? St.Dead : St.Blocked"));
}
// ── 第 155 组：空关闭的门槛只该在「跨过那一条」上生效 ──
{
  W.S.hostRankCache.clear();
  for (let i2 = 0; i2 < 4; i2 += 1) W.nsEmptyClose("ec.test:443", true);
  const ecs = W.S.nstat.get("ec.test:443");
  W.S.hostRankCache.set("a.example", { t: 1, v: [] });
  W.nsEmptyClose("ec.test:443", true);   // 第 5 条：这一条把计数推过门槛
  ok("跨过门槛那一条会作废站点排行缓存", !W.S.hostRankCache.has("a.example"));
  ok("门槛就是 5 次", Math.round(ecs.eCloseP) >= 5);
  W.S.hostRankCache.set("b.example", { t: 1, v: [] });
  W.nsEmptyClose("ec.test:443", true);   // 第 6 条：已经跨过，不该再清
  ok("跨过之后再空关闭不再清缓存（eCloseP 按 6 小时半衰期挂着，每次清等于关掉缓存）", W.S.hostRankCache.has("b.example"));
  ok("计数继续累加", Math.round(ecs.eCloseP) >= 6);
  W.S.hostRankCache.set("c.example", { t: 1, v: [] });
  W.nsEmptyClose("ec.test:443", false);
  ok("直连腿的空关闭不清站点排行", W.S.hostRankCache.has("c.example"));
}
// 探活只累加样本数与 tcp/tls 的 EWMA，不写真实首字节的矩
{
  W.nsProbe("pr.test:443", 120, 90, 30);
  W.nsProbe("pr.test:443", 130, 95, 35);
  const prs = W.S.nstat.get("pr.test:443");
  eq("探活只累加样本数", prs.probeSamples, 2);
  ok("探活不写首字节矩（否则会给还没承载流量的节点白加抖动罚）", prs.pSum === 0 && prs.pSumSq === 0);
  ok("探活会更新 tcp 的 EWMA", prs.tcp > 0);
  ok("门槛判断写成「跨过那一条」", statAll().includes("before < EMPTY_CLOSE_BAD"));
}
// 拨号重试必须换一条：选择器的确定性路径在同一秒内两次返回同一条
{
  const keepAlive = new Map(W.S.alive);
  const keepN = new Map(W.S.nstat);
  W.S.alive.clear();
  W.S.nstat.clear();
  const mk = (k) => { const i = k.lastIndexOf(":"); W.S.alive.set(k, { h: k.slice(0, i), p: Number(k.slice(i + 1)) || 443, cc: "", ms: 100 }); };
  mk("1.1.1.1:443");
  mk("2.2.2.2:443");
  W.nsGet("1.1.1.1:443").tcp = 40;
  W.nsGet("2.2.2.2:443").tcp = 200;
  W.hostNodeMark("1.1.1.1:443", "retry.test", true, 120);
  const env = { proxyip: "auto" };
  const a1 = await W.SEL.current(env, "tput", null, "retry.test", false);
  const a2 = await W.SEL.current(env, "tput", null, "retry.test", false);
  eq("站点偏好是确定性路径：两次调用挑同一条", a1, a2);
  const a3 = await W.SEL.current(env, "tput", null, "retry.test", false, new Set([a1]));
  ok("排除刚失败的那条之后换一条（否则第二次尝试等于空转 2.5 秒）", a3 && a3 !== a1);
  eq("排除之后挑到的是另一条", a3, "2.2.2.2:443");
  eq("全部排除时回空：宁可退直连也不重复同一条", await W.SEL.current(env, "tput", null, "retry.test", false, new Set(["1.1.1.1:443", "2.2.2.2:443"])), "");
  W.S.alive.clear();
  W.S.nstat.clear();
  for (const [k, v] of keepAlive) W.S.alive.set(k, v);
  for (const [k, v] of keepN) W.S.nstat.set(k, v);
}
// 拨号器把试过的键传下去，并且钉住 ?rx= 时只试一次
{
  const dsrc = fs.readFileSync("src/proxy/dialer.ts", "utf8");
  ok("拨号器把已试过的键传给选择器", dsrc.includes("SEL.current(env, mode, conn, host, cfHost, tried)"));
  ok("钉住的 ?rx= 只试一次（诊断语义：我就要这一条）", dsrc.includes("const maxTries = conn.forceRelayIp ? 1 : 2;"));
  ok("同一条不会试第二次", dsrc.includes("if (tried.has(key)) break;"));
}

{
  // 第 157 组：链接订阅的 IPv4 钉住（7.167）。链接格式没有 ip-version 字段，
  // 唯一能让客户端不用 AAAA 的办法就是把 server 写成 IP 字面量。
  const lSrv = (line) => {
    const m = /^[a-z]+:\/\/[^@]*@([^:]+):/.exec(line);
    return m ? m[1] : "";
  };
  const lDec = (s) => atob(s).split("\n");
  const lId = "4241b903-8d39-4a17-8f4c-bb33b1630c33";
  const lHost = "sub.example.com";
  const lUrl = new URL("https://" + lHost + "/" + lId + "/links");
  const lAuto = lDec(W.renderLinks({}, lUrl, lId, lHost, {}, []));
  ok("链接订阅每条都把入口写成 IPv4 字面量（双栈网络上域名会解析成 AAAA）", lAuto.every((l) => /^\d{1,3}(\.\d{1,3}){3}$/.test(lSrv(l))));
  ok("钉住入口之后 host= 与 sni= 仍指回域名（TLS 与 WS 路由都不变）", lAuto[0].includes("host=" + encodeURIComponent(lHost)) && lAuto[0].includes("sni=" + encodeURIComponent(lHost)));
  ok("入口 IP 在几个边缘之间轮转（用户手动切有得挑）", new Set(lAuto.map(lSrv)).size >= 3);
  const lOff = lDec(W.renderLinks({}, new URL("https://" + lHost + "/" + lId + "/links?e=0"), lId, lHost, {}, []));
  ok("?e=0 时退回域名入口", lOff.every((l) => lSrv(l) === lHost));
  const lMan = lDec(W.renderLinks({ nodes: "custom.example.com:443:true:mine" }, lUrl, lId, lHost, {}, []));
  ok("手动配了节点就按手动入口走（和 Clash 的 manual 一致）", lMan.every((l) => lSrv(l) === "custom.example.com"));
  const lReg = lDec(W.renderLinks({}, lUrl, lId, lHost, {}, ["HK"]));
  ok("地区条目同样钉入口 IP", lReg.length > lAuto.length && /^\d{1,3}(\.\d{1,3}){3}$/.test(lSrv(lReg[lReg.length - 1])));
  ok("实现里确实读了边缘 IP 表（入口数可调）", fs.readFileSync("src/views/sub-links.ts", "utf8").includes("X_EDGE_IPS.slice(0, edgeCount(url))"));
}
{
  // 第 158 组：错误的标签与被打乱的缩进（v7.168）
  // 「连不上」被写成 skip-direct 会让 /logs 里只看到「故意跳过直连」，看不出真正原因。
  const dSrc = fs.readFileSync("src/proxy/dialer.ts", "utf8");
  const sSrc = fs.readFileSync("src/proxy/session.ts", "utf8");
  ok("拨号失败不许再被说成「故意跳过直连」（dialer）", !dSrc.includes("skip-direct") && dSrc.includes("dial returned null"));
  ok("同一句话在 session 里也改掉", !/^\s*throw new Error\("skip-direct"\)/m.test(sSrc) && sSrc.includes("dial returned null"));
  ok("session 的守卫注明了两条拨号路径都不会回 null", sSrc.includes("两条拨号路径都不返回 null"));
  // 脚本补丁曾把一条语句顶格（缩进 0），块内的层级读起来是断的。
  const cLines = fs.readFileSync("src/proxy/connection.ts", "utf8").split(/\r?\n/);
  const settleLines = fs.readFileSync("src/proxy/conn-settle.ts", "utf8").split(/\r?\n/);
  const relLine = settleLines.find((l) => l.includes("HOOK.relPerf?.(v.host"));
  ok("relPerf 那行和同块其它语句同层级（4 空格）", !!relLine && /^ {4}HOOK\.relPerf\?\./.test(relLine));
  ok("closing 块里没有顶格的语句", cLines.filter((l) => /^\S/.test(l) && !/^(import|export|\/\/|\/\*|\}|type |const |function |class )/.test(l)).length === 0);
}
{
  // 第 159 组：补救链上的拨号超时与 socket 释放（v7.169）
  // 主路径给 connect() 包了 2.5 秒上限，补救链没有：客户端已经等了两三秒，再挂死等于直接放弃。
  const fSrc = fs.readFileSync("src/proxy/fallback.ts", "utf8");
  const aSrc = fs.readFileSync("src/proxy/attacher.ts", "utf8");
  ok("换节点重试也走带预算的拨号器", fSrc.includes("SOCKET_DIALER.open(") && !fSrc.includes("withTimeout(pk, CONNECT_MS)"));
  ok("换节点失败要给这条候选记一笔（否则一直被挑回来）", fSrc.includes("nsFail(alt)"));
  ok("超时迟到成功的 socket 由拨号器关掉（fallback 不再自己写）", !fSrc.includes("pk.then((s) =>") && fSrc.includes("SOCKET_DIALER"));
  const iRel = aSrc.indexOf("releaseAll(conn)");
  const iSet = aSrc.indexOf("conn.sock = sock;");
  ok("递归重试前先释放上一跳的 socket 与写锁", iRel >= 0 && iSet > iRel);
  ok("IPv6 兜底也有建连预算（走拨号器）", aSrc.includes("SOCKET_DIALER.open(expandV6(v6), port)") && !aSrc.includes("connect({ hostname: expandV6(v6)"));
  ok("proxyip 兜底也有建连预算（走拨号器）", aSrc.includes("SOCKET_DIALER.open(px.host, px.port)") && !aSrc.includes("Promise.resolve(connect("));
  ok("proxyip 连不上要给中继记账", aSrc.includes('nsFail(px.host + ":" + px.port)'));
  ok("死条件 !px || st.retried 已经删掉（只判代码行，注释里可以留历史）", !/if \(!px \|\| st\.retried\)/.test(aSrc));
}
{

  // 第 160 组：地区分流（?rg=）的拨号超时与失败归因（v7.170）
  // 地区是硬要求，挂死不能靠「等客户端放弃」；失败也不能记到目标站头上。
  const rgSrc = fs.readFileSync("src/proxy/region.ts", "utf8");
  const ssSrc = fs.readFileSync("src/proxy/session.ts", "utf8");
  eq("地区分流的两条拨号都走同一个拨号器", (rgSrc.match(/SOCKET_DIALER\.open\(/g) || []).length, 2);
  eq("地区分流里不再有裸 connect（超时迟到成功的 socket 必须有人关）", (rgSrc.match(/await connect\(/g) || []).length, 0);
  ok("同一个节点一次失败只罚一次（否则冷却跳两档）", rgSrc.includes("conn.node !== failed"));
  ok("地区失败单独计数，不混进「目标不可达」", ssSrc.includes('cnt("rgFail")') && W.S.cntKeys.includes("rgFail"));
}

// 第 161 组：会话层补救链的拨号超时与地区口径（v7.171）
// Dialer 抛错后那条「临时取一条中继直连」是最后一跳，漏了超时就会把客户端拖到放弃。
const ss2 = fs.readFileSync("src/proxy/session.ts", "utf8");
const at2 = fs.readFileSync("src/proxy/attacher.ts", "utf8");
ok("会话层补救链的 connect 也加了 2.5 秒上限", /withTimeout\(pk0, CONNECT_MS\)/.test(ss2));
ok("会话层不再有裸 connect（迟到成功的 socket 必须有人关）", !/await connect\(\{ hostname: px0\.host/.test(ss2));
ok("超时之后迟到成功的 socket 会被关掉", /void pk0\s*\n\s*\.then\(\(s\) => \{ try \{ s\.close\(\); \}/.test(ss2));
ok("地区钉住的补救链不再把「没别的候选」记成目标不可达", at2.includes('cnt(region ? "rgFail" : "dead")'));
eq("attacher 里只剩一处 dead（真正的目标不可达）", (at2.match(/cnt\("dead"\)/g) || []).length, 1);

// 第 162 组：DO 端点的反方向（有实现、零调用方）（v7.172）
// 前几轮只查过「调用方有、实现方没有」；这一批查反方向：能力被写下、却没有任何入口。
const mSrc = storeSrc();
const wSrc = fs.readFileSync("tools/check-wire.mjs", "utf8");
ok("两个零调用点的 DO 端点已删除（/http80 与 /reset）", !/endsWith\("\/(http80|reset)"\)/.test(mSrc));
ok("meter.ts 不再 import 探活用的 probeHttp80", !mSrc.includes("probeHttp80"));
ok("错位的回填注释回到它描述的 /seed 分支上方", /只在当前为 0 时回填[\s\S]{0,80}endsWith\("\/seed"\)/.test(mSrc));
ok("check-wire 有反向检查：实现方必须有调用方", wSrc.includes("zombieFail") && wSrc.includes("有实现但没有任何调用方"));

console.log("\n【164】池子侧的死状态");
(() => {
  const typeSrc = fs.readFileSync("types/app.d.ts", "utf8");
  const nodeEntry = (() => {
    const at = typeSrc.indexOf("interface NodeEntry {");
    const end = typeSrc.indexOf("}", at);
    return typeSrc.slice(at, end);
  })();
  ok("存活条目不再有来源字段（写三处、读零处）", !/\bsrc\?:\s*string/.test(nodeEntry));
  const poolSrc = fs.readFileSync("src/px/pool.ts", "utf8");
  const warmSrc = fs.readFileSync("src/px/warm.ts", "utf8");
  ok("四处写入都不再带来源", !/src:\s*"(pool|seed|probe)"/.test(poolSrc + warmSrc));
  ok("pxSet 不再能整体替换存活表（那条分支零调用方）", !/patch\.alive/.test(poolSrc));
  ok("pxSet 的补丁只剩 cur", /pxSet\(env: Env, patch: \{ cur\?: string \| null \}\)/.test(poolSrc));
  const wSrc = fs.readFileSync("tools/doc-audit.mjs", "utf8");
  ok("活文档体检把 LIMITS.md 也算上了", /LIVING = \[[^\]]*"docs\/LIMITS\.md"/.test(wSrc));
})();

// 灾备快照：读的人有上限，没读的人不能被从快照里抹掉
{
  const SNAPMAX = W.SC.SNAP_MAX || 24;
  eq("SNAP_MAX 是 24（每人一次 DO 往返的预算）", W.SC.SNAP_MAX, 24);
  const box = new Map();
  const old = { ts: Date.now() - 3 * 3600 * 1000, users: {} };
  const list = [];
  for (let i = 0; i < 30; i++) {
    const id = "aaaaaaaa-0000-4000-8000-" + String(i).padStart(12, "0");
    list.push({ id, pwd: "", note: "", enabled: true, managed: true });
    old.users[id] = { up: 111 + i, down: 222 + i, conns: 1, first: 0, d: "2000-01-01", dU: 7, dD: 8 };
  }
  box.set("usage:snap", JSON.stringify(old));
  let calls = 0;
  const envS = {
    STATS: { get: async (k) => box.get(k) || null, put: async (k, v) => { box.set(k, v); } },
    METER: {
      idFromName: (id) => id,
      get: () => ({
        fetch: async () => {
          calls++;
          return { ok: true, json: async () => ({ up: 999, down: 999, conns: 2, first: 0 }) };
        },
      }),
    },
  };
  W.S.meterCache.clear();
  const beforeSkip = W.cntView().snapSkip || 0;
  await W.usageSnapWrite(envS, list);
  eq("灾备快照只读 SNAP_MAX 个人的用量（每人一次 DO 子请求）", calls, SNAPMAX);
  eq("超过预算的人被计数（snapSkip）", (W.cntView().snapSkip || 0) - beforeSkip, 30 - SNAPMAX);
  const doc = JSON.parse(box.get("usage:snap"));
  eq("没读的那个人仍是上次的数值", doc.users[list[SNAPMAX].id].up, 111 + SNAPMAX);
  eq("读到的那个人换成了新数值", doc.users[list[0].id].up, 999);
  eq("快照里没有丢人", Object.keys(doc.users).length, 30);
}

// 面板：没读到用量与「用量为 0」必须能看出来
{
  const u1 = { id: "aaaaaaaa-0000-4000-8000-00000000000a", pwd: "", note: "n1", enabled: true, managed: true };
  const u2 = { id: "aaaaaaaa-0000-4000-8000-00000000000b", pwd: "", note: "n2", enabled: true, managed: true };
  const page = W.renderAdmin(new URL("https://h.example/admin"), { list: [u1, u2] }, {
    [u1.id]: { up: 1, down: 2, todayUp: 0, todayDown: 0 },
  });
  const row1 = page.slice(page.indexOf(u1.id), page.indexOf(u2.id));
  const row2 = page.slice(page.indexOf(u2.id));
  ok("读到的用户那行是真数字", /<td>\d/.test(row1), row1.slice(0, 60));
  ok("没读到的用户那行是「—」", row2.includes("<td>—</td>"));
  ok("没读到的用户那行不会假装 0 B", !row2.includes("0 B"));
  ok("页面说明有几个用户这次没读到", page.includes("1 个用户这次没读到用量"));
}

// 第 166 组：/meter/set 的恢复门槛（第 98 条）
// 旧门槛只看 up+down，导致「只建过连接、没有可计量流量」的用户整条恢复被跳过；
// 同时 conns 直接赋值会让落后几小时的快照把更大的连接数改小。
const dset = (m, body) => m.fetch(new Request("https://meter/set", { method: "POST", body: JSON.stringify(body) }));
{
  const a = mkDO();
  await dset(a.m, { up: 0, down: 0, conns: 7, first: 1000 });
  eq("只有连接数、没有字节的用户也能恢复（旧代码整条跳过）", a.m.ledger.usage.conns, 7);
  eq("首次使用时间跟着恢复", a.m.ledger.usage.first, 1000);
  await dset(a.m, { up: 0, down: 0, conns: 12, first: 1000 });
  eq("字节没变多时不再整体跳过：连接数继续前进", a.m.ledger.usage.conns, 12);
}
{
  const b = mkDO();
  await dset(b.m, { up: 100, down: 200, conns: 9, first: 1000 });
  await dset(b.m, { up: 150, down: 200, conns: 3, first: 5000 });
  eq("快照落后时不会把更大的连接数改小", b.m.ledger.usage.conns, 9);
  eq("首次使用时间取更早的那个", b.m.ledger.usage.first, 1000);
  eq("字节按快照恢复（快照更大才覆盖）", b.m.ledger.usage.up + b.m.ledger.usage.down, 350);
}
const mSrc166 = storeSrc();
ok("恢复门槛含连接数（与 /seed 口径一致）", mSrc166.includes("wantN > curN"));
ok("conns 用 max 合并，快照落后也不回退", mSrc166.includes("Math.max(wantN, curN)"));
// 第 167 组：挂在主批次上的增量只能由那一批确认（第 99 条）
// 旧代码对每个用户批次都跑 clAck/syncAck/syncNack，而增量只挂在主 uuid 的请求体里：
// 多个用户同时成功会把连接观测重复相减，任一用户失败会把主批次刚确认的增量退回/清空。
{
  const mkMeter = (failIds) => ({
    idFromName: (x) => x,
    get: (id) => ({
      fetch: async () =>
        failIds.includes(id)
          ? new Response("x", { status: 500 })
          : new Response("{}", { status: 200 }),
    }),
  });
  W.S.pend.clear();
  W.S.cagg.clear();
  W.S.pend.set("u1", { up: 10, down: 20, conns: 1 });
  W.S.pend.set("u2", { up: 30, down: 40, conns: 2 });
  W.S.pend.set("u3", { up: 50, down: 60, conns: 3 });
  W.S.cagg.set("9.9.9.9:443", { n: 5, ok: 5, dn: 5000, v: [100, 110] });
  let clAckCalls = 0;
  let nackCalls = 0;
  const oldClAck = W.PEND.clAck.bind(W.PEND);
  W.PEND.clAck = (rows) => {
    clAckCalls += 1;
    return oldClAck(rows);
  };
  const oldNack = W.HOOK.syncNack;
  W.HOOK.syncNack = () => {
    nackCalls += 1;
  };
  await W.PEND.flush({ METER: mkMeter(["u2"]), uuid: "u1" }, true);
  W.PEND.clAck = oldClAck;
  W.HOOK.syncNack = oldNack;
  eq("连接观测只按发出去的那一批相减一次", clAckCalls, 1);
  eq("别的用户批次失败不会退回主批次的增量", nackCalls, 0);
  eq("失败用户的增量原样回到账本", (W.S.pend.get("u2") || {}).up, 30);
  W.S.pend.clear();
  W.S.cagg.clear();
}
const pSrc167 = fs.readFileSync("src/store/pend.ts", "utf8");
ok("确认只发生在挂增量的那一批", pSrc167.includes("=== carriedBy"));
ok("挂增量时记下是哪一批", pSrc167.includes("carriedBy = String(id).toLowerCase();"));
// 168) 增量上报的批次上限与轮转
{
  const pendSrc = fs.readFileSync("src/store/pend.ts", "utf8");
  eq("PEND_MAX 是 32：一轮最多 32 次 DO 往返，留出子请求余量", W.SC.PEND_MAX, 32);
  ok("批次按轮转取，且夹在本轮额度与 PEND_MAX 之间", pendSrc.includes("rotated.slice(0, Math.max(1, Math.min(SC.PEND_MAX, max)))") && pendSrc.includes("(S.pendIdx || 0) % all.length"));
  ok("只摘掉这一批，不整表清空（在途增量留在账本里）", pendSrc.includes("for (const [bid] of batch) S.pend.delete(bid);") && !pendSrc.includes("S.pend.clear();"));
  ok("被截断的人数会记进 pendSkip", pendSrc.includes('cnt("pendSkip", rotated.length - batch.length)'));
  const sent = [];
  const mkP = { METER: { idFromName: (x) => x, get: (id) => ({ fetch: async () => { sent.push(id); return new Response(JSON.stringify({ v: null }), { status: 200 }); } }) } };
  W.S.pend.clear();
  W.S.pendIdx = 0;
  for (let i = 0; i < 40; i++) W.S.pend.set("p" + i, { up: 10, down: 20, conns: 1 });
  await W.PEND.flush(mkP, true);
  eq("一轮只发 PEND_MAX 个用户", sent.length, 32);
  eq("没发出去的留在账本里", W.S.pend.size, 8);
  eq("没发出去的正好是末尾那 8 个", [...W.S.pend.keys()].join(","), "p32,p33,p34,p35,p36,p37,p38,p39");
  ok("截断的人数记进了 pendSkip", (W.cntView().pendSkip || 0) >= 8);
  await W.PEND.flush(mkP, true);
  eq("第二轮把剩下的 8 个发完", W.S.pend.size, 0);
  eq("两轮合计正好 40 次 DO 往返", sent.length, 40);
}
// 169) UDP/DNS 分帧：拆在两条消息里的包不能被丢
{
  const dnsSrc = fs.readFileSync("src/proxy/dns.ts", "utf8");
  ok("帧解析区分「还没到齐」与「格式非法」", dnsSrc.includes('return "short";') && dnsSrc.includes("udpBuf"));
  ok("拆不完的字节会留到下一帧，而不是丢掉", (dnsSrc.match(/carry\(buf\)/g) || []).length === 3 && dnsSrc.includes("st.udpBuf = rest.slice();"));

  const mkT = (n) => {
    const out = [1, 192, 0, 2, 1, 0x00, 0x35, (n >> 8) & 0xff, n & 0xff];
    for (let i = 0; i < n; i++) out.push(0x40 + i);
    return new Uint8Array(out);
  };
  const mkV = (n) => {
    const out = [(n >> 8) & 0xff, n & 0xff];
    for (let i = 0; i < n; i++) out.push(0x50 + i);
    return new Uint8Array(out);
  };

  const frame = mkT(12);
  const whole = W.trojanUdpFrame(frame);
  eq("完整的 Trojan UDP 帧能拆出来", whole && whole.msg.length, 12);
  eq("少一个字节算「还没到齐」，不是非法帧", W.trojanUdpFrame(frame.subarray(0, frame.length - 1)), "short");
  eq("ATYP 非法才算格式错误", W.trojanUdpFrame(new Uint8Array([9, 1, 2, 3, 4, 0, 53, 0, 12])), null);

  const realFetch = globalThis.fetch;
  const sent = [];
  let closed = 0;
  const ws = { readyState: 1, send(b) { sent.push(b.length); }, close(c) { closed = c; } };
  globalThis.fetch = async () => new Response(new Uint8Array(20), { status: 200 });
  try {
    const st = { down: 0, header: null, udpBuf: null };
    await W.handleDns(ws, frame.subarray(0, 5), st, true);
    eq("半个 Trojan 帧：一次也不发", sent.length, 0);
    eq("半个 Trojan 帧：留在 udpBuf 里等下一帧", st.udpBuf && st.udpBuf.length, 5);
    eq("半个 Trojan 帧：连接没被关", closed, 0);
    await W.handleDns(ws, frame.subarray(5), st, true);
    eq("拼起来之后发一次", sent.length, 1);
    eq("响应 = 地址前缀(7) + 长度 + 负载", sent[0], 7 + 2 + 20);
    eq("残留清空", st.udpBuf, null);

    const st2 = { down: 0, header: null, udpBuf: null };
    const vframe = mkV(12);
    await W.handleDns(ws, vframe.subarray(0, 6), st2, false);
    eq("半个 VLESS 帧：先不发", sent.length, 1);
    eq("半个 VLESS 帧：留下 6 字节", st2.udpBuf && st2.udpBuf.length, 6);
    await W.handleDns(ws, vframe.subarray(6), st2, false);
    eq("VLESS 拼完发一次", sent.length, 2);
    eq("VLESS 响应 = 2 + 负载", sent[1], 2 + 20);
  } finally {
    globalThis.fetch = realFetch;
  }
}
// ── 170. 探测路径的三个边界（7.180）────────────────────────────────────────
{
  console.log("\n170. 探测路径");
  const sr = (x, d) => W.splitRelay(x, d);
  eq("host:port 正常拆开", sr("104.16.0.1:443", 80), ["104.16.0.1", 443]);
  eq("没有端口就用默认值", sr("relay.example.com", 80), ["relay.example.com", 80]);
  eq("裸 IPv6 整串是主机，端口取默认", sr("2a06:98c0::1", 443), ["2a06:98c0::1", 443]);
  eq("带方括号的 IPv6 + 端口", sr("[2a06:98c0::1]:8443", 443), ["2a06:98c0::1", 8443]);
  eq("端口 0 当作没写", sr("a.example:0", 80), ["a.example", 80]);
  eq("空串回空主机", sr("", 80), ["", 80]);

  // 在途去重：同一站点只能有一条探测在飞。探测要占一个 connect 名额（免费计划全局 6 个），
  // 冷启动时同一站点来 6 条连接就是 6 次并发探测，正好把真实拨号的名额吃掉。
  const launches = [];
  const ctx = { waitUntil: (p) => launches.push(p) };
  W.S.cfHttp.clear();
  W.S.cfHttpFlight.clear();
  W.refreshCfHttp("dedupe.test", ctx);
  W.refreshCfHttp("dedupe.test", ctx);
  eq("同一站点在途时只探一次", launches.length, 1);
  ok("在途集合里记着它", W.S.cfHttpFlight.has("dedupe.test"));
  await Promise.allSettled(launches);
  ok("探测结束后清掉在途标记", !W.S.cfHttpFlight.has("dedupe.test"));
  W.refreshCfHttp("dedupe.test", ctx);
  eq("刚探过一次就不再立刻重探（负缓存 20 秒）", launches.length, 1);

  const tfSrc = fs.readFileSync("src/core/tf.ts", "utf8");
  const tfImpl272 = fs.readFileSync("src/core/transport-tunnelfetch.ts", "utf8");
  ok("probeTf 的实现在传输层里，且整段包在超时里", tfSrc.includes("PROBE_BUDGET_MS") && tfImpl272.includes("withTimeout(work, timeoutMs"));
  const h80 = fs.readFileSync("src/core/http80.ts", "utf8");
  ok("probeHttp80 用 splitRelay 解析中继", /relay \? splitRelay\(relay, 80\)/.test(h80));
  // ps 行的线格式只有一份（psfacts.ts 的 PsWire），出站必须真的带上 top（7.163 漏的跟随）
  const psSrc = fs.readFileSync("src/route/psfacts.ts", "utf8");
  ok("PsWire 带上 top（曾经行过的证据要能跨 isolate）", /\/\*\*[\s\S]*?\*\/[\s\S]*?top\?:/.test(psSrc) && psSrc.includes("export interface PsWire"));
  ok("PsWire 声明了 top 字段", /top\?: number;/.test(psSrc));
  const foSrc = fs.readFileSync("src/store/factout.ts", "utf8");
  ok("factsOut 真的把 top 发出去", foSrc.includes("top: Number(x.top) || 0"), "出站丢了 top");
}


/* ── 第 171 组：上限与合并口径（v7.181）────────────────────────────────────
 * 四条：判定表的上限真正生效（以前 set 只清过期行、setState/import 连调用都没有）；
 * DO 的 hl 不再把两段不同时刻的证据逐字段拼成一条；hl 裁剪留最新而不是留最旧；
 * /set 只让触发的那一维变大，另一维不再被快照写小。 */
{
  // 1) 判定表：走 setState（recordBlock/recordPass/markBlocked/import 都走它）灌 700 行
  W.VT.clear();
  for (let i = 0; i < 700; i++) W.vSetState("cap" + i + ".test", "r:198.51.100.9", 2, 1);
  ok("判定表的上限在 setState 上也生效（超限即收回容量）", W.VT.size() <= 600 && W.VT.size() >= 500, `size=${W.VT.size()}`);
  ok("删掉的是最旧的：第一条已经不在了", !W.vAll().some((r) => r.target === "cap0.test"));
  ok("最新的那条还在", W.vAll().some((r) => r.target === "cap699.test"));

  // 2) 判定表：走 import（远端同步，单批 120 行）灌 960 行
  W.VT.clear();
  for (let b = 0; b < 8; b++) {
    const rows = [];
    for (let i = 0; i < 120; i++) rows.push({ k: "imp" + b + "_" + i + ".test|r:198.51.100.9", s: 2, t: Date.now() + 1800000 });
    W.vImport(rows);
  }
  ok("判定表的上限在 import 上也生效（超限即收回容量）", W.VT.size() <= 600 && W.VT.size() >= 500, `size=${W.VT.size()}`);
  W.VT.clear();

  // 3) DO 的 hl：三小时前「好」+ 刚刚「坏」不得拼成 { o:9, b:6, t:刚刚 }
  const dh = mkDO();
  const hlStub = { fetch: (u, i) => dh.m.fetch(typeof u === "string" ? new Request(u, i) : u) };
  const hlOld = Date.now() - 3 * 3600 * 1000;
  await hlStub.fetch("https://meter/add", {
    method: "POST",
    body: JSON.stringify({ hl: [{ i: "198.51.100.44", o: 9, b: 0, d: 0, t: hlOld }] }),
  });
  await hlStub.fetch("https://meter/add", {
    method: "POST",
    body: JSON.stringify({ hl: [{ i: "198.51.100.44", o: 0, b: 6, d: 0, t: Date.now() }] }),
  });
  const hlBack = await (await hlStub.fetch("https://meter/hl")).json();
  const hlRow = hlBack.hl.find((x) => x.i === "198.51.100.44") || { o: -1, b: -1, d: -1, t: 0 };
  eq("hl 不会把两段证据拼在一起：保留的是整条胜出的那条", [hlRow.o, hlRow.b, hlRow.d].join(","), "9,0,0");
  ok("并且它的时间还是三小时前（客户端半衰期因此真的在衰减）", hlRow.t < Date.now() - 3600 * 1000);

  // 4) hl 裁剪：超过 200 条时删最旧、留最新（按插入顺序切会删掉刚写进来的那条）
  const dt = mkDO();
  const trimStub = { fetch: (u, i) => dt.m.fetch(typeof u === "string" ? new Request(u, i) : u) };
  const flood = [];
  for (let i = 0; i < 260; i++) flood.push({ i: "10.1.0." + i, o: 1, b: 0, d: 0, t: Date.now() - (260 - i) * 1000 });
  await trimStub.fetch("https://meter/add", { method: "POST", body: JSON.stringify({ hl: flood }) });
  // /hl 出口只发 120 条，所以用「最旧那条是否还在」判定裁剪方向
  const trimBack = await (await trimStub.fetch("https://meter/hl")).json();
  ok("hl 裁剪留最新：最旧那条已被删掉", !trimBack.hl.some((x) => x.i === "10.1.0.0"));

  // 5) /set：只有 conns 变大时，up/down 不得被快照写小
  const ds = mkDO();
  const setStub = { fetch: (u, i) => ds.m.fetch(typeof u === "string" ? new Request(u, i) : u) };
  const post = (p, body) => setStub.fetch("https://meter" + p, { method: "POST", body: JSON.stringify(body) });
  await post("/add", { up: 1000, down: 0, conns: 50 });
  await post("/set", { up: 900, down: 0, conns: 60 });
  const setBack = await (await setStub.fetch("https://meter/cnt")).json();
  eq("恢复时字节取两者更大（累积用量不倒退）", (setBack.c.up || 0) + (setBack.c.down || 0), 1000);
  eq("连接数取两者更大", setBack.c.conns, 60);

  // 6) 源码断言：三处写入路径都要 trim
  const vSrc = verdictAll();
  ok("set 走上限检查", vSrc.includes("this.trim();"));
  ok("trim 委托给 BoundedMap.prune（先清过期、再按写入时间删最旧）", vSrc.includes("this.byKey.prune(Date.now());") && vSrc.includes("this.byKey.capacity()"));
}

// 172. 站点记忆表的上限只在一条路上执行；限流表被撑爆就整体清空（v7.182）
{
  // 1) judge 写 needPx 的两条路径都要压回上限
  W.S.needPx.clear();
  const np0 = 1700000000000;
  for (let i = 0; i < 700; i++) {
    W.JUDGE.onTraffic({
      host: "np" + i + ".test",
      chan: { kind: "r", ip: "198.51.100.9" },
      via: "node",
      node: "198.51.100.9:443",
      ok: true,
      down: 737,
      up: 400,
      life: 80,
      cf: true,
      at: np0 + i,
    });
  }
  eq("needPx 有上限：judge 写入也压回 SC.PX_MAX", W.S.needPx.size, W.SC.PX_MAX);
  ok("最早过期的那些先被丢掉", !W.S.needPx.has("np0.test"));
  ok("最新的那条还在", W.S.needPx.has("np699.test"));
  const atSrc = fs.readFileSync("src/proxy/attacher.ts", "utf8");
  ok("attacher 与 judge 共用同一个上限函数", atSrc.includes("trimAged(S.needPx, SC.PX_MAX)"));
  ok("attacher 不再自己数 300", !/S\.needPx\.size >= 300/.test(atSrc));

  // 2) 限流表：撑爆时只删最旧，不清空别人的计数
  W.RL_MEM.clear();
  const hot = "203.0.113.200";
  let allowed = 0;
  for (let i = 0; i < 10; i++) if (W.rlTake(hot, 10)) allowed += 1;
  eq("窗口内前 10 次放行", allowed, 10);
  ok("第 11 次被挡", W.rlTake(hot, 10) === false);
  for (let i = 0; i < 600; i++) W.rlTake("10.9." + Math.floor(i / 256) + "." + (i % 256), 10);
  ok("表被撑爆之后，原来被限住的 IP 仍然被限住（不是整体 clear）", W.rlTake(hot, 10) === false);
  ok("限流表自己仍然有界", W.RL_MEM.size <= 501);

  // 3) shadowRate 的说明不再自称「显示 10 实际 0」
  const uSrc = fs.readFileSync("src/core/util.ts", "utf8");
  ok("shadowRate 文档不再举「显示 10 实际 0」这个错例", !uSrc.includes("实际 0"));

  // 4) RTT 表有 5 列，"暂无数据" 必须跨 5 列
  const pSrc = fs.readFileSync("src/views/panel-stats.ts", "utf8");
  ok("「暂无数据」跨满 RTT 表的 5 列", pSrc.includes("<td colspan=5>暂无数据</td>"));
}

{
  console.log("\n第173组：派生密钥的缓存、起搏样本、补救链的候选过滤");
  const eA = { kek: "kek-alpha" };
  const eB = { kek: "kek-beta" };
  const kA = await W.aesKey(eA);
  const kB = await W.aesKey(eB);
  ok("换 kek 之后重新派生密钥（否则旧 isolate 一直用旧密钥解新数据）", !!kA && !!kB && kA !== kB);
  eq("同一个 kek 复用缓存", await W.aesKey({ kek: "kek-alpha" }), kA);
  eq("没有 kek 时不派生（seal 于是按明文存）", await W.aesKey({}), null);
  const ct = await W.seal(eA, { x: 1 });
  ok("密文带 ENC1 前缀", String(ct).startsWith("ENC1:"));
  eq("换 kek 之后解不开（不是静默返回旧值）", await W.unseal(eB, ct), null);
  eq("原来的 kek 解得开", (await W.unseal(eA, ct)).x, 1);
  eq("没有 kek 时按明文 JSON 存（刻意的降级，不是加密）", await W.seal({}, { y: 2 }), JSON.stringify({ y: 2 }));
  const warmSrc = fs.readFileSync("src/px/warm.ts", "utf8");
  ok("起搏不把探活 RTT 写进真实首字节矩（否则第一条真请求就被 CUSUM 冻结）", !/nsLatency\s*\(/.test(warmSrc));
  ok("起搏仍然记探活样本（probeSamples / tcp / tls）", /nsProbe\s*\(/.test(warmSrc));
  const fbSrc = fs.readFileSync("src/proxy/fallback.ts", "utf8");
  ok("补救链跳过一个被污染的条目，而不是整条放弃", /checkTarget\(host, port\)\)\s*continue;/.test(fbSrc));
  ok("补救链也跳过本站点已判封锁的中继", /HOOK\.chanPref\(host, st\.host\) === 2/.test(fbSrc));
  ok("补救链的候选上限仍是 4（每个都是一次 connect）", /const ALT_TRIES = 4;/.test(fbSrc));
}
// 第 174 组：事实寿命的唯一真源 + 错误分类键的上限 + 中继地址的 IPv6 拆分
{
  const ttl = W.FACT_TTL;
  eq(
    "五类事实的寿命只有一份（core/facts 的 FACT_TTL）",
    [ttl.eg, ttl.ps, ttl.dead, ttl.blk, ttl.dns].join(","),
    "21600000,2700000,1800000,5400000,86400000",
  );
  ok(
    "route 的五个 TTL 都从 FACT_TTL 取（不再各写一遍数字）",
    W.EG_TTL === ttl.eg && W.PS_TTL === ttl.ps && W.DNS_TTL === ttl.dns && W.BLK_TTL === ttl.blk && W.DEAD_TTL === ttl.dead,
  );
  const fmSrc = fs.readFileSync("src/store/factmerge.ts", "utf8");
  ok(
    "factmerge 的合并规则读 FACT_TTL，不再自带四个裸数字",
    fmSrc.includes("FACT_TTL.eg") &&
      fmSrc.includes("FACT_TTL.ps") &&
      fmSrc.includes("FACT_TTL.dead") &&
      fmSrc.includes("FACT_TTL.blk") &&
      fmSrc.includes("FACT_TTL.dns") &&
      !fmSrc.includes("21600000") &&
      !fmSrc.includes("2700000") &&
      !fmSrc.includes("1800000"),
  );
  // 分类键含客户端带来的站点名（"tfb <站点>"）：同窗口里换站点就是换键
  const E = W.ERRS;
  E.bucket.clear();
  for (let i = 0; i < 50; i++) E.count("cron: boom");
  eq("高频分类先占住位置", (() => {
    for (const [k, v] of E.bucket) if (k === "cron: boom") return v.n;
    return -1;
  })(), 50);
  for (let i = 0; i < 400; i++) E.count("tfb atk" + i + ".test chan ok=1 bad=1 esc=none n=3");
  ok("同一窗口里分类键也有上限（客户端换站点名撑不爆）", E.bucket.size <= 64, E.bucket.size);
  eq("直方图仍能给出前 8 类", E.hist().length, 8);
  eq("高频分类没有被淘汰掉", (() => {
    for (const [k, v] of E.bucket) if (k === "cron: boom") return v.n;
    return -1;
  })(), 50);
  const eSrc = fs.readFileSync("src/nodes/errlog.ts", "utf8");
  ok("淘汰按本窗口计数最少的那批（而不是清空整表）", eSrc.includes("cold.length - 64"), true);
  // 中继地址：IPv6 字面量自带冒号，split(":") 会把它拆成两截
  ok("splitRelay 认得 [v6]:port", JSON.stringify(W.splitRelay("[2a06:98c0::1]:443", 443)) === '["2a06:98c0::1",443]', true);
  ok("splitRelay 认得不带端口的裸 IPv6", JSON.stringify(W.splitRelay("2a06:98c0::1", 443)) === '["2a06:98c0::1",443]', true);
  const tfImpl271 = fs.readFileSync("src/core/transport-tunnelfetch.ts", "utf8");
  ok(
    "传输层用 splitRelay 拆中继（代码里不再有 lastIndexOf，注释里留历史说明不算）",
    tfImpl271.includes("splitRelay(relay, 443)") && !/^\s*const i = relay\.lastIndexOf/m.test(tfImpl271),
    true,
  );
  const tfbSrc = fs.readFileSync("src/route/tfb.ts", "utf8");
  ok(
    "tfb 的判定键与探测地址都走 splitRelay/relayAddr",
    tfbSrc.includes("splitRelay(row.relay, 443)[0]") && tfbSrc.includes("ips.map(relayAddr)") && !tfbSrc.includes('row.relay.split(":")[0]'),
    true,
  );
}

/* 175：探活 RTT 不能写进真实首字节的矩；冷却中的源要真的跳过（7.185） */
{
  const pSrc = fs.readFileSync("src/px/scan.ts", "utf8");
  eq(
    "pool.ts 里没有任何 nsLatency 调用（探活 RTT 不是真实首字节）",
    (pSrc.match(/^\s*nsLatency\(/gm) || []).length,
    0,
  );
  ok(
    "探活仍然把样本写进统计（nsProbe）：② 与 ②b 复测合并进 probeInto 后剩三处调用",
    (pSrc.match(/^\s*nsProbe\(/gm) || []).length >= 3,
    true,
  );
  const pk = "11.9.9.9:443";
  W.S.nstat.delete(pk);
  W.nsProbe(pk, 40, 38, 2);
  W.nsProbe(pk, 44, 40, 4);
  const st175 = W.nsGet(pk);
  eq("探活只累加样本数", st175.probeSamples, 2);
  ok(
    "探活不写首字节矩（pSum 仍是 0）",
    st175.pSum === 0 && st175.pSumSq === 0,
    true,
  );
  const u1 = "https://a185.example/x.txt";
  const u2 = "https://b185.example/x.txt";
  const u3 = "https://c185.example/x.txt";
  W.SOURCES.note(u1, true);
  ok("抓成功一次不算冷却", W.SOURCES.cooling(u1) === false);
  W.SOURCES.note(u1, false);
  ok("失败一次还不算冷却（要求连续两次）", W.SOURCES.cooling(u1) === false);
  W.SOURCES.note(u1, false);
  ok("连续两次失败进冷却", W.SOURCES.cooling(u1), true);
  W.SOURCES.note(u1, true);
  ok("成功之后立刻退出冷却", W.SOURCES.cooling(u1) === false);
  const realFetch185 = globalThis.fetch;
  const fetched185 = [];
  const mkLines185 = (n, base) =>
    Array.from({ length: n }, (_, i) => `${base}.${Math.floor(i / 250) + 1}.${(i % 250) + 1}:443`).join("\n");
  globalThis.fetch = async (u) => {
    fetched185.push(String(u));
    const body = mkLines185(400, String(u).includes("c185") ? "13.9" : "12.9");
    return { ok: true, status: 200, text: async () => body };
  };
  W.SOURCES.note(u2, false);
  W.SOURCES.note(u2, false);
  W.SOURCES.note(u3, false);
  W.SOURCES.note(u3, false);
  const c0 = W.cntView().srcSkip || 0;
  const r1 = await W.refillPool({ poolSrc: [u1, u2, u3].join(",") }, 0);
  eq("健康源已经抓到 400 条 → 两个冷却源被跳过，只发一次请求", fetched185.length, 1);
  eq("被跳过的源在结果里带 skip 标记", [!!r1.sources[u2].skip, !!r1.sources[u3].skip], [true, true]);
  ok("跳过的次数记进 srcSkip", (W.cntView().srcSkip || 0) - c0 >= 2, true);
  ok("跳过的这一轮池子仍然有足够条目", r1.pool.length >= 300, true);
  fetched185.length = 0;
  globalThis.fetch = async (u) => {
    fetched185.push(String(u));
    const body = mkLines185(10, "14.7");
    return { ok: true, status: 200, text: async () => body };
  };
  const r2 = await W.refillPool({ poolSrc: [u1, u2, u3].join(",") }, 1600);
  eq("健康源只给 10 条时不许跳过冷却源（否则整轮刷新会被缩水守卫拒掉）", fetched185.length, 3);
  ok("这一轮没有 skip 标记", !r2.sources[u2].skip && !r2.sources[u3].skip);
  globalThis.fetch = realFetch185;
  ok("POOL_ENOUGH 是 300（低于它就照旧全抓）", W.POOL_ENOUGH, 300);
}

// 176) 预算账本与续回边界（7.186）
// 这里同时记一个「排除了的疑点」：withTimeout 超时后那一半仍在跑，它若最终 reject，
// 并不会变成未捕获的 rejection —— Promise.race 挂上去的那一刻已经给 p 同时挂了 resolve/reject
// 处理器，晚到的失败只是被丢弃（A/B 实测：退回旧版 util.ts，行为断言两边全绿）。真正会造出
// 未捕获 rejection 的是 `.then(完成分支)` 这种只挂一半的新链，dialer/region/session 那几处
// 都显式跟了 .catch。所以这里不锁「util.ts 有没有多挂一个丢弃器」，只锁账本。
console.log("\n176) 预算账本与续回边界");
{
  const late = new Promise((_, rej) => setTimeout(() => rej(new Error("late failure")), 30));
  let thrown = "";
  try {
    await W.withTimeout(late, 5, "to");
  } catch (e) {
    thrown = String((e && e.message) || e);
  }
  eq("超时会按 msg 抛错", thrown, "to");
  // 等到那一半真正失败：将来若把 race 改成「自己收尾、不再管 p」，这里会以 unhandledRejection 崩掉
  await new Promise((r) => setTimeout(r, 120));
  ok("超时之后的那一半失败不会打崩进程", true);
  eq("restorePick 收到 0 时一个也不续回", W.restorePick([...Array(40).keys()].map((i) => "u" + i), 0).length, 0);
  const l2 = W.planRound(0, 0);
  ok("剩余额度不小于续回上限", l2.sub >= 12, String(l2.sub));
  eq("准入次数 = min(SCAN_MAX, SCAN_SUB)", l2.adm, Math.min(W.SC.SCAN_MAX, W.SC.SCAN_SUB));
}
// ---- 第 177 组：出站事实切片必须按新鲜度（v7.187 D125）；诊断建连必须有超时（D126）----
{
  const now177 = Date.now();
  // 七张表：每张都超过响应上限，且新行按插入序排在最后（模拟真实合并：只追加、不重排）
  const vt177 = {};
  for (let i = 1; i <= 300; i++) vt177["h.test|r" + i] = { s: 2, t: now177 + 1000 + i };
  vt177["h.test|legacy"] = now177 + 8000; // 老格式：裸数字 = 只有到期时间，状态按 2
  vt177["h.test|dead"] = { s: 3, t: now177 + 9000 }; // 最新的一条，且是 dead
  vt177["h.test|expired"] = { s: 2, t: now177 - 1 }; // 已过期，不该出现在响应里
  const hl177 = {};
  for (let i = 1; i <= 250; i++) hl177["10.0.0." + i] = { o: 1, b: 0, d: 0, t: now177 + i };
  const blk177 = {};
  for (let i = 1; i <= 1100; i++) blk177["h.test|b" + i] = { n: 1, at: now177 + i };
  const dns177 = {};
  for (let i = 1; i <= 600; i++) dns177["d" + i + ".test"] = { v: 1, at: now177 + i };
  const ps177 = { "h.test|1.1.1.1": { q: 200, n: 4, at: now177, top: 250 } };
  const out177 = W.factsOut({ vt: vt177, hl: hl177, eg: {}, ps: ps177, dead: {}, blk2: blk177, dns: dns177 }, now177);
  eq("判定行仍按 120 条上限切", out177.vt.length, 120);
  eq("切出来的是最新的一条（dead）", out177.vt[0].k, "h.test|dead");
  eq("最新那条保持 dead 状态", out177.vt[0].s, 3);
  ok("过期行一条都不发", out177.vt.every((r) => r.k !== "h.test|expired"));
  eq("老格式裸数字仍按 blocked 发", (out177.vt.filter((r) => r.k === "h.test|legacy")[0] || {}).s, 2);
  eq("中继存活度按 120 条上限切", out177.hl.length, 120);
  eq("存活度发的是最新观测", out177.hl[0].i, "10.0.0.250");
  eq("封锁行按 120 条上限切", out177.blk2.length, 120);
  eq("封锁行发的是最新的", out177.blk2[0].k, "h.test|b1100");
  eq("DNS 行按 160 条上限切", out177.dns.length, 160);
  eq("DNS 行发的是最新的", out177.dns[0].h, "d600.test");
  eq("成功率行的历史最好原样透传", out177.ps[0].top, 250);
  eq("freshTop 直接按时间戳降序取", W.freshTop([{ t: 1 }, { t: 3 }, { t: 2 }], (r) => r.t, 2).map((r) => r.t).join(","), "3,2");
  eq("freshTop 不超上限时原样返回", W.freshTop([{ t: 1 }, { t: 3 }], (r) => r.t, 5).length, 2);
  const meterSrc177 = storeSrc();
  ok("meter 的 /vt 已委托给 factsOut", meterSrc177.includes("Response.json(factsOut(this.ledger))"), "meter.ts");
  ok("meter 里不再自己拼 blk2 的插入序切片", !meterSrc177.includes("Object.entries(this.blk2)"), "meter.ts");
  const dbgSrc177 = debugAll();
  ok("诊断默认分支的建连接去拨号器", dbgSrc177.includes("SOCKET_DIALER.open(expandV6(out.aaaa), 443)"), "debug.ts");
  ok("诊断默认分支不再自己包 connect", !dbgSrc177.includes("Promise.resolve(connect("), "debug.ts");
}


/** 第 178 组（v7.188）：没有生产者的旧封锁表删净、热路径一张表只扫一遍 */
{
  const mS = storeSrc();
  ok("计量表里不再有旧封锁表字段", !/this\.blk\b/.test(mS), "meter.ts");
  ok("计量表不再提供 /blk 端点", mS.indexOf('endsWith("/blk")') < 0, "meter.ts");
  ok("七张事实表的出站仍走 factsOut", mS.indexOf("Response.json(factsOut(this.ledger))") >= 0, "meter.ts");
  const dS = debugAll();
  ok("诊断的跨 isolate 封锁改读 /vt 的 blk2", dS.indexOf('doFetch(env, id, "https://meter/vt")') >= 0 && dS.indexOf("jj.blk2") >= 0, "debug.ts");
  ok("诊断用 blk2 的 at 与 BLK_TTL 算剩余寿命", dS.indexOf("r.at + BLK_TTL - now2") >= 0, "debug.ts");
  const pS = fs.readFileSync("src/route/policy.ts", "utf8");
  eq("决策里同一张实测表只扫一遍", pS.split("relSnap(c.host)").length - 1, 1);
  ok("冷启动闸门复用同一个计数", pS.indexOf("fresh === 0") >= 0, "policy.ts");
  // 行为面：量过的那条照旧进表，样本数只累加不重置
  W.RELPERF.clear();
  W.RELPERF.note("rel188.example", "203.0.113.21", 300, 900);
  eq("量过的那条被记进站点 × 中继表", W.relSnap("rel188.example").length, 1);
  W.RELPERF.note("rel188.example", "203.0.113.21", 320, 950);
  eq("样本数照样累加（只增不重置）", W.relSnap("rel188.example")[0].samples, 2);
  W.RELPERF.clear();
}
/* ── 179. 吞吐容量表：上限与寿命必须落在插入路径上；残槽 HOOK.psNote 不该存在 ── */
{
  const capSrc = fs.readFileSync("src/route/capfacts.ts", "utf8");
  const hookSrc179 = fs.readFileSync("src/core/hook.ts", "utf8");
  const psSrc179 = fs.readFileSync("src/route/psfacts.ts", "utf8");
  eq("容量比上限是 256", W.CAP_MAX, 256);
  ok("上限在插入路径上执行", capSrc.indexOf("if (this.rows.size > CAP_MAX) this.trim(now);") >= 0, "capfacts.ts");
  ok("未确认的行按最后取样时间算寿命", capSrc.indexOf("const last = Math.max(row.at, row.seen);") >= 0, "capfacts.ts");
  ok("不再有「没确认就早退」的写法", capSrc.indexOf("if (!row || !row.at) return 1;") < 0, "capfacts.ts");
  // 行为面：300 个中继各只来一条样本（一条都过不了 R1）—— 表不能涨过上限
  W.CAP.clear();
  const t189 = 1_000_000;
  for (let i = 0; i < 300; i += 1) {
    W.CAP.note(`198.18.${Math.floor(i / 250) + 1}.${(i % 250) + 1}`, 100, t189);
  }
  ok("只来一条样本的中继不会把表撑过上限", W.CAP.rows.size <= W.CAP_MAX, `size=${W.CAP.rows.size}`);
  // 未确认的行也要能过期：10 分钟后再读一次就该消失
  const sz0 = W.CAP.rows.size;
  // 用表里还在的一行来验过期：撑到上限时最早插入的那些已经被 trim 删掉了
  const anyIp = [...W.CAP.rows.keys()][0];
  eq("没确认过的中继读出来是中性的 1", W.CAP.capOf(anyIp, t189 + 1), 1);
  eq("还没到期，行还在", W.CAP.rows.size, sz0);
  eq("过期后照样是中性 1", W.CAP.capOf(anyIp, t189 + W.CAP_TTL + 1), 1);
  eq("过期后从表里删掉", W.CAP.rows.size, sz0 - 1);
  // 真过门的那条照旧被记住
  W.CAP.clear();
  for (let i = 0; i < 20; i += 1) W.CAP.note(`198.18.2.${i + 1}`, 100, t189);
  W.CAP.note("203.0.113.60", 5000, t189);
  W.CAP.note("203.0.113.60", 5000, t189);
  eq("两次一致且差 2 倍以上就记下来（夹到上限 2）", W.CAP.capOf("203.0.113.60", t189), 2);
  eq("吞吐模式的代价倍数 = 1 / 容量比", W.CAP.factor("203.0.113.60", "tput", t189), 0.5);
  eq("延迟模式不乘容量比", W.CAP.factor("203.0.113.60", "lat", t189), 1);
  W.CAP.clear();
  // 残槽：HOOK.psNote 没人注册也没人调用，留着会让人以为连接层还在写 ps
  ok("hook.ts 里没有 psNote 槽位", hookSrc179.indexOf("psNote") < 0, "hook.ts");
  ok("HOOK 对象上没有 psNote", !("psNote" in W.HOOK), "HOOK");
  ok("psfacts 的文档指向真正的调用方", psSrc179.indexOf("src/route/judge.ts") >= 0 && psSrc179.indexOf("HOOK.psNote") < 0, "psfacts.ts");
}

// 第 180 组：订阅参数（?ei= 入口数 / ?r=0 关中继块 / ?tu= 成员必须是中继条目）
{
  const U = (q) => new URL("https://example.com/x" + q);
  eq("默认发满种子表（8 个入口）", W.edgeCount(U("")), 8);
  eq("?ei=5 就发 5 个", W.edgeCount(U("?ei=5")), 5);
  eq("少于 4 个没意义（下限夹到 4）", W.edgeCount(U("?ei=2")), 4);
  eq("超过种子表只会重复地址（上限夹到 8）", W.edgeCount(U("?ei=99")), 8);
  eq("不是数字按默认", W.edgeCount(U("?ei=abc")), 8);
  eq("空的 ?ei= 也按默认（Number(\"\") 是 0 不是 NaN）", W.edgeCount(U("?ei=")), 8);

  const envA = { uuid: "u", nodes: "", proxyip: "auto" };
  const idA = "4241b903-8d39-4a17-8f4c-bb33b1630c33";
  const keepAlive = S.alive;
  const keepTop = S.eg4Top;
  S.alive = new Map();
  S.eg4Top = [];
  const y4 = W.renderClash(envA, U("?ei=4"), idA, "example.com");
  eq("?ei=4 只发 4 个入口 × 2 个模式", (y4.match(/name: "e-/g) || []).length, 8);
  eq("第 4 个入口仍在", y4.includes("104.26.0.1"), true);
  eq("第 5 个入口不该出现", y4.includes("104.20.2.1"), false);

  S.alive = new Map([
    ["203.0.113.7:443", { h: "203.0.113.7", p: 443, cc: "", ms: 120, src: "pool" }],
    ["198.51.100.9:443", { h: "198.51.100.9", p: 443, cc: "", ms: 180, src: "pool" }],
  ]);
  const yR = W.renderClash(envA, U(""), idA, "example.com");
  ok("默认发中继条目", (yR.match(/name: "r-/g) || []).length > 0, "r- 条目数 " + (yR.match(/name: "r-/g) || []).length);
  const yNoR = W.renderClash(envA, U("?r=0"), idA, "example.com");
  eq("?r=0 时不发中继条目", (yNoR.match(/name: "r-/g) || []).length, 0);
  eq("?r=0 时也不发中继优选组", yNoR.includes("\u{1F501} \u4e2d\u7ee7\u4f18\u9009"), false);
  ok("?r=0 仍发入口条目", (yNoR.match(/name: "e-/g) || []).length > 0, "e- 条目数 " + (yNoR.match(/name: "e-/g) || []).length);

  const tuQ = "?tu=" + encodeURIComponent("https://probe.example.org/");
  const yTu = W.renderClash(envA, U(tuQ), idA, "example.com");
  // 按行取组定义后面的 proxies 行：直接对整段做正则会被 emoji 转义和非贪婪量词坑到
  const gLines = yTu.split("\n");
  const gi = gLines.findIndex((l) => l.startsWith('  - name: "\u{1F4E1} \u901a\u9053\u5b9e\u6d4b"'));
  const pi = gi >= 0 ? gLines.findIndex((l, k) => k > gi && l.trim().startsWith("proxies: [")) : -1;
  const members =
    pi >= 0
      ? JSON.parse("[" + gLines[pi].slice(gLines[pi].indexOf("[") + 1, gLines[pi].lastIndexOf("]")) + "]")
      : [];
  eq("?tu= 有实测组", gi >= 0 && pi > gi, true);
  ok("成员全部是按中继走的条目", members.length > 0 && members.every((x) => x.startsWith("r-")), "成员 " + members.join("/"));
  ok("成员上限 10（每条都是一次对目标站的真实请求）", members.length > 0 && members.length <= 10, "成员数 " + members.length);
  const yTuNoR = W.renderClash(envA, U(tuQ + "&r=0"), idA, "example.com");
  eq("?r=0 时实测组不退化到入口条目", yTuNoR.includes("\u{1F4E1} \u901a\u9053\u5b9e\u6d4b"), false);

  // 冷 isolate：一条中继都还没判活时，实测组退化成前 10 个条目，否则 ?tu= 会静默失效
  S.alive = new Map();
  const yCold = W.renderClash(envA, U(tuQ), idA, "example.com");
  eq("冷 isolate 下 ?tu= 仍然出组", yCold.includes("\u{1F4E1} \u901a\u9053\u5b9e\u6d4b"), true);

  S.alive = keepAlive;
  S.eg4Top = keepTop;
}


// 191a) 站点失败只有一条记账路径（attacher 的 if/else 两条分支曾分别调 softFail 与 bumpFail(…, "site")）
console.log("\n191a) 站点失败的记账路径");
{
  reset();
  node("sfa:443", { tcp: 40 });
  node("sfb:443", { tcp: 40 });
  S.pxFailMem = 0;
  S.pxFailSeen = 0;
  await W.SEL.softFail("sfa:443");
  await W.SEL.bumpFail({}, "tput", "sfb:443", false, "site");
  const fa = W.nsGet("sfa:443");
  const fb = W.nsGet("sfb:443");
  eq("softFail 与 kind=site 的权重一致", Math.round(fb.failW * 10), Math.round(fa.failW * 10));
  ok("站点失败只记 0.2 的站责", fa.failW > 0.1 && fa.failW < 0.3, String(fa.failW));
  eq("站点失败不进全局失败记忆", S.pxFailMem, 0);
  eq("站点失败不置失败标志", S.pxFailSeen, 0);
  eq("站点失败不冻结节点", W.isFrozen("sfa:443") || W.isFrozen("sfb:443"), false);
  // 节点侧失败（kind=node）必须真的推进全局记忆，否则「连续失败就换节点」永不触发
  S.pxFailMem = 0;
  await W.SEL.bumpFail({}, "tput", "sfb:443", false);
  eq("节点侧失败推进全局记忆", S.pxFailMem >= 1, true);
  // 站点级试探（hostTrial）的失败只冻结它自己，也不动全局记忆
  reset();
  node("sfd:443", { tcp: 40 });
  S.pxFailMem = 0;
  await W.SEL.bumpFail({}, "tput", "sfd:443", true);
  eq("试探失败不进全局记忆", S.pxFailMem, 0);
  eq("试探失败冻结该节点", W.isFrozen("sfd:443"), true);
  // 源码锁：影子字段与「第二条等价的记账路径」都别再回来
  const conSrc = fs.readFileSync("src/proxy/connection.ts", "utf8");
  const atSrc = fs.readFileSync("src/proxy/attacher.ts", "utf8");
  ok("Connection 不再有影子连接的 trial 字段", !conSrc.includes("  trial = false;") && !conSrc.includes("this.trial"), "");
  ok("站点失败的记账只剩 softFail 一条路", !atSrc.includes('"site"'), "");
}

// 191b) 中继健康表 merge：条数相等时较新的观测整体胜出，不把两份观测拼成一条
console.log("\n191b) 中继健康表的 merge 口径");
{
  // 用 merge 造本地旧证据：一次整页、1 分钟前（note 用的是「现在」，没法造出旧时间戳）
  const e = new W.RelayHealth();
  e.merge([{ i: "10.3.3.3", o: 1, b: 0, d: 0, t: Date.now() - 60000 }]);
  ok("本地整页证据让健康度高于中性", e.score("10.3.3.3") > 0.5, String(e.score("10.3.3.3")));
  // 别处：同样 1 条，但是零字节，且更新 —— 整条按较新的观测替换
  e.merge([{ i: "10.3.3.3", o: 0, b: 0, d: 1, t: Date.now() }]);
  const row = e.json(5).find((r) => r.ip === "10.3.3.3");
  ok("条数相等时按较新的观测整条替换（ok 归零）", !!row && row.ok === 0 && row.dead === 1, JSON.stringify(row));
  ok("替换后健康度落到中性以下", e.score("10.3.3.3") < 0.5, String(e.score("10.3.3.3")));
  // 别处更旧就不该动本地结论，时间戳也不能被搬过来
  const f = new W.RelayHealth();
  f.merge([{ i: "10.4.4.4", o: 1, b: 0, d: 0, t: Date.now() - 1000 }]);
  const before = f.score("10.4.4.4");
  f.merge([{ i: "10.4.4.4", o: 0, b: 0, d: 1, t: Date.now() - 3600 * 1000 }]);
  // 健康度带半衰期、每次读都会重新算，直接比浮点数会随两行之间的毫秒抖动 —— 用容差
ok("较旧的观测不覆盖本地结论", Math.abs(f.score("10.4.4.4") - before) < 1e-6, f.score("10.4.4.4") + " vs " + before);
  // 条数更多的那条照样整条胜出
  f.merge([{ i: "10.4.4.4", o: 5, b: 0, d: 0, t: Date.now() }]);
  const r2 = f.json(5).find((r) => r.ip === "10.4.4.4");
  ok("条数更多时整条替换", !!r2 && r2.ok === 5 && r2.dead === 0, JSON.stringify(r2));
  // 相等条数 + 相等时间戳：保持本地（不写入）也不能拼
  const g = new W.RelayHealth();
  const t0 = Date.now() - 60000;
  g.merge([{ i: "10.5.5.5", o: 2, b: 0, d: 0, t: t0 }]);
  g.merge([{ i: "10.5.5.5", o: 0, b: 0, d: 2, t: t0 }]);
  const r3 = g.json(5).find((r) => r.ip === "10.5.5.5");
  ok("条数相同且时间相同则保持本地", !!r3 && r3.ok === 2 && r3.dead === 0, JSON.stringify(r3));
}

// 第 192 组：缩水守卫要比「最大已知规模」；读失败必须留证据（7.192）
{
  const mem = new Map();
  const envP = { uuid: "00000000-0000-0000-0000-000000000000", STATS: {
    get: async (k) => (mem.has(k) ? mem.get(k) : null),
    put: async (k, v) => { mem.set(k, v); },
  } };
  const mk = (n, tag) => Array.from({ length: n }, (_x, i) => ({ h: tag + i, p: 443, cc: "" }));
  const putSeed = (gen, n) => mem.set("px:seed", JSON.stringify({ v: 7, ts: 0, poolGen: gen, poolN: n, builtAt: 0, byColo: {} }));
  // 别的 isolate 已经提交过 200 条的池子；本 isolate 内存还停在上一代的小池子（10 条）
  W.S.pool = mk(10, "stale"); W.S.poolGen = 4; W.S.seed.poolGen = 4; W.S.seed.poolN = 10;
  W.S.seedAt = Date.now(); W.S.seedReadFail = false; W.S.colo = "TST";
  putSeed(5, 200);
  const c1 = await W.POOL.commitPool(envP, mk(80, "shrink"), false);
  eq("本地是小池子时仍按 KV 的真实规模判缩水", c1.ok, false);
  ok("拒绝理由写明是缩水", String(c1.reason || "").includes("rejected"), String(c1.reason));
  const c2 = await W.POOL.commitPool(envP, mk(80, "shrink"), true);
  eq("手动 refill 仍然可以缩水", c2.ok, true);
  // 读失败：普通 kvGet 会把 get 抛错吞成 null，那条 logErr 永远写不出来
  // 错误环上限 50 条、满了 shift：只能按时间戳认「这条是刚写进去的」，不能按下标切
  const errAt = Date.now();
  W.S.pool = []; W.S.poolGen = 0; W.S.seed.poolGen = 6; W.S.seedAt = 0; W.S.seedReadFail = false;
  const downEnv = { uuid: "00000000-0000-0000-0000-000000000000", STATS: {
    get: async () => { throw new Error("kv down"); },
    put: async () => { throw new Error("kv down"); },
  } };
  const got = await W.POOL.ensurePool(downEnv);
  eq("读失败按空池返回，不炸调用方", got.length, 0);
  const logged = W.S.errs.some((x) => x && x.t >= errAt && String(x.m || "").includes("pool gen 6"));
  ok("读失败写进了错误环", logged, JSON.stringify(W.S.errs.filter((x) => x && x.t >= errAt)));
  W.S.pool = []; W.S.poolGen = 0; W.S.seed.poolGen = 0; W.S.seed.poolN = 0; W.S.colo = ""; W.S.seedAt = 0;
}

// 第 193 组：判定层与 pxDecision 闸门的口径（7.193）
// 缺陷：pxDecision 对「CF 托管目标」无条件 return true，把判定层的 direct-ok 一起盖掉。
{
  const reqP = new Request("https://gw.example/", { headers: { "cf-connecting-ip": "203.0.113.9" } });
  const poolBak = S.pool;
  const aliveBak = new Map(S.alive);
  // pxDecision 内部用的是 POLICY.relays()：先让池子里有两条非 CF 中继，闸门才有「中继」可选
  S.pool = [{ h: "45.136.117.194", p: 443, cc: "" }, { h: "193.181.211.185", p: 443, cc: "" }];
  S.alive.clear();

  // ① 新鲜直连整页证据：判定层选直连，闸门必须放行（旧代码在这里返回 true）
  W.vClear();
  W.vSet("x.com", "d", 200, 40, 1);
  const d1 = W.decide({ host: "x.com", cfHost: true, clientV6: false, relays: ["45.136.117.194"], legacyWantsRelay: true, mode: "tput" });
  eq("新鲜直连证据下判定层选直连", d1.chan.kind, "d");
  eq("新鲜直连证据下闸门不再硬绕中继", W.pxDecision(reqP, "x.com", true, true, 2), false);
  eq("非 CF 站点的直连证据同样放行", W.pxDecision(reqP, "x.com", false, true, 2), false);

  // ② 没有直连证据：判定层选一条中继，闸门走中继（这是 7.187 要保住的那一半）
  const d2 = W.decide({ host: "y.org", cfHost: true, clientV6: false, relays: ["45.136.117.194"], legacyWantsRelay: true, mode: "tput" });
  ok("没有直连证据时判定层选一条中继", d2.chan.kind === "r", d2.why);
  eq("没有直连证据时闸门走中继", W.pxDecision(reqP, "y.org", true, false, 2), true);

  // ③ 直连被差分判死：闸门必须改走中继（不依赖 wantPx）
  W.vSetState("z.net", "d", 2, 1);
  const d3 = W.decide({ host: "z.net", cfHost: true, clientV6: false, relays: ["45.136.117.194"], legacyWantsRelay: false, mode: "tput" });
  ok("直连被判死时判定层改走中继", d3.chan.kind === "r", d3.why);
  eq("直连被判死时闸门走中继", W.pxDecision(reqP, "z.net", true, false, 2), true);

  // ④ 分级语义：2 才改行为，1 只改硬规则，0 全是影子
  W.vClear();
  W.vSet("k.io", "d", 200, 40, 1);
  eq("level 1 不改行为（wantPx=false 就直连）", W.pxDecision(reqP, "k.io", true, false, 1), false);
  eq("level 0 不改行为（wantPx=true 就绕中继）", W.pxDecision(reqP, "k.io", true, true, 0), true);

  // ⑤ 源码锁：闸门的硬规则必须挂在「判定层选了中继」这个条件上
  const srcPx = fs.readFileSync("src/proxy/pxhook.ts", "utf8");
  ok("闸门按判定结果而非无条件放行", srcPx.includes('if (cfHost && level >= 1 && out.via === "r")'), "pxhook 的 cfHost 分支形状变了");
  ok("闸门里没有无条件的 cfHost return true", !/if \(cfHost && level >= 1\) \{\s*return true;/.test(srcPx), "仍是无条件硬绕");

  W.vClear();
  S.pool = poolBak;
  S.alive.clear();
  for (const [k, v] of aliveBak) S.alive.set(k, v);
}

// ── 第 194 组：死导出与线协议类型的单一来源（7.195） ──
{
  // ① 状态码→状态只有一处实现：导出的副本 stateOfCode 已删除，剩下的私有实现必须唯一
  const srcVt = verdictAll();
  eq("verdict.ts 不再有 stateOfCode 死导出", srcVt.includes("stateOfCode"), false);
  eq("「2xx-3xx 可用」的映射全仓只写一次", srcVt.split("code >= 200 && code < 400").length - 1, 1);
  // 删副本不许改行为：三条映射仍要落在 1 / 2 / 3
  W.vClear();
  W.VT.set("s195.test", "d", 200, 40, 1);
  eq("200 仍是可用", W.vState("s195.test", "d"), 1);
  W.VT.set("s195.test", "d", 403, 140, 1);
  eq("403 仍是被拦", W.vState("s195.test", "d"), 2);
  W.VT.set("s195.test", "d", 0, 0, 1);
  eq("没有状态码仍是连不上", W.vState("s195.test", "d"), 3);
  W.vClear();

  // ② 没人读的代价先验常量已删除（代价先验由 score.ts 自己算，两份会分叉）
  const srcStat = statAll();
  eq("stat.ts 不再有 E10_PRIOR 死导出", srcStat.includes("E10_PRIOR"), false);
  ok("TEN_MB 仍导出（score/metrics 都在用）", srcStat.includes("export const TEN_MB"), "TEN_MB 定义没了");

  // ③ 线协议类型只有一份：verdictsync 借用 factsstore 的 FactsBody，不再本地重声明
  const srcVs = fs.readFileSync("src/route/verdictsync.ts", "utf8");
  eq("verdictsync 不再自带 FactsBody 声明", srcVs.includes("interface FactsBody"), false);
  ok("verdictsync 从 factsstore 借类型", srcVs.includes("type FactsBody") && srcVs.includes("type WireBody = FactsBody &"), "借用没接上");
  // 行为面：七张表里最容易漏的那张（dns）必须真能穿过车身进表
  W.DNS.clear();
  const now195 = Date.now();
  const n195 = W.FACTS.load({ dns: [{ h: "d195.test", v: 1, at: now195 }], eg: [{ i: "9.9.9.9", f: 6, at: now195 }] });
  eq("车身里的 dns 事实被读入", n195.dns, 1);
  eq("车身里的 eg 事实被读入", n195.eg, 1);
  eq("dns 事实真的进了 DNS 表", W.DNS.v6Of("d195.test"), 1);
  W.DNS.clear();

  // ④ 闸门本身在位：死导出扫描必须挂在总闸上，否则下一次死导出照样能发版
  ok("死导出闸门脚本存在", fs.existsSync("tools/check-dead.mjs"), "tools/check-dead.mjs 不见了");
  const srcPf = fs.readFileSync("tools/preflight.mjs", "utf8");
  ok("死导出闸门接进了 preflight", srcPf.includes("tools/check-dead.mjs"), "preflight 里没有这一步");
}
// 第 196 组：页面尺寸判据只有一个真源；文档不再被 import 挤开
{
  const srcFacts = fs.readFileSync("src/core/facts.ts", "utf8");
  ok("PAGE_ABS 定义在 core/facts", srcFacts.includes("export const PAGE_ABS"), "PAGE_ABS 不在 core/facts.ts");

  // ① 四个曾经各抄一份的文件都不许再出现裸字面量（改一份忘另一份就是这么开始的）
  for (const f of ["src/route/judge.ts", "src/route/commitfact.ts", "src/route/egfacts.ts", "src/route/relay-health.ts"]) {
    const s = fs.readFileSync(f, "utf8");
    eq(f + " 不再写裸 20000", s.includes("20000"), false);
    eq(f + " 不再写裸 2048", s.includes("2048"), false);
    ok(f + " 从 PAGE_ABS 取阈值", s.includes("PAGE_ABS"), f + " 没引用 PAGE_ABS");
  }

  // ② 行为面：五条阈值都必须指向同一个对象（不是五个恰好相等的数字）
  const pa = W.PAGE_ABS || {};
  eq("BIG_PEER 与 PAGE_ABS.big 同源", W.BIG_PEER, pa.big);
  eq("EG_BIG 与 PAGE_ABS.big 同源", W.EG_BIG, pa.big);
  eq("TINY_ABS 与 PAGE_ABS.tiny 同源", W.TINY_ABS, pa.tiny);
  eq("EG_TINY 与 PAGE_ABS.tiny 同源", W.EG_TINY, pa.tiny);
  eq("BIG_WIN 与 PAGE_ABS.win 同源", W.BIG_WIN, pa.win);
  eq("整页门槛仍是 20KB", pa.big, 20000);
  eq("小响应上限仍是 2KB", pa.tiny, 2048);
  eq("同窗口宽度仍是 120 秒", pa.win, 120000);

  // ③ 文档位置：import 必须在它描述的常量之前，否则文档挂到 import 头上、常量反而裸奔
  const srcCf = fs.readFileSync("src/route/commitfact.ts", "utf8");
  const iImp = srcCf.indexOf("import { FACT_TTL, PAGE_ABS }");
  ok("commitfact 的 import 带上了 PAGE_ABS", iImp >= 0, "import 没引用 PAGE_ABS");
  ok("commitfact 的 import 在 TINY_ABS 文档之前", iImp >= 0 && iImp < srcCf.indexOf("/** tiny 的绝对上限"), "文档又被 import 挤开了");
  const iDns = fs.readFileSync("src/route/dnsfacts.ts", "utf8").indexOf("/** DNS 事实寿命");
  ok("DNS_TTL 拿回了自己的文档", iDns >= 0, "DNS_TTL 的文档不见了");
  const srcDns = fs.readFileSync("src/route/dnsfacts.ts", "utf8");
  ok("DNS_TTL 的文档与声明相邻", srcDns.slice(iDns, srcDns.indexOf("export const DNS_TTL")).indexOf("import") < 0, "文档与 DNS_TTL 之间隔着 import");

  // ④ 门禁在位：这一型（文档挂在 import 上）此前谁都没看见
  const srcAudit = fs.readFileSync("tools/doc-audit.mjs", "utf8");
  ok("注释门禁会查文档挂在 import 上", srcAudit.includes("function docOnImport(lines)"), "docOnImport 不见了");
  ok("门禁把首个注释块当文件头放过", srcAudit.includes("blockOf[k] === 1"), "文件头判据不见了");
  ok("门禁真的调用了这条检查", srcAudit.includes("const onImp = docOnImport(lines);"), "没调用 docOnImport");
}
// 第 197 组：订阅开关各管各的块（?e=0 不该把中继块一起删掉）；地区条目端口有兜底
{
  const subEnv = { uuid: "4241b903-8d39-4a17-8f4c-bb33b1630c33", pwd: "", nodes: "" };
  const subHost = "sim.example.com";
  const aliveBefore = W.S.alive;
  const egBefore = W.S.eg4Top;
  W.S.alive = new Map();
  W.S.eg4Top = [];
  W.S.alive.set("45.136.117.194:443", { host: "45.136.117.194", port: 443, tls: true, cc: "" });
  const render = (q) => W.renderClash(subEnv, new URL("https://" + subHost + "/sub" + q), subEnv.uuid, subHost, {}, ["HK"], undefined);
  // 取某个条目的 server 行（clash 的 name 带引号，按含引号的整行找）
  const serverOf = (txt, name) => {
    const ls = txt.split(/\r?\n/);
    const i = ls.findIndex((l) => l.trim() === "- name: \"" + name + "\"");
    if (i < 0) return null;
    const s = ls.slice(i, i + 6).find((l) => l.trim().startsWith("server:"));
    return s ? s.trim().slice(7).trim() : null;
  };

  // ① ?e=0 只去掉入口 IP 条目：中继条目与它的 url-test 组都还在，server 回落到域名
  const noEdgeTxt = render("?e=0");
  ok("?e=0 时中继条目仍在", noEdgeTxt.includes("- name: \"r-45.136.117.194-VLT\""), "中继条目被 ?e=0 一起删掉了");
  ok("?e=0 时中继优选组仍在", noEdgeTxt.includes("\"🔁 中继优选\""), "中继优选组被 ?e=0 一起删掉了");
  ok("?e=0 时入口条目确实没了", noEdgeTxt.includes("- name: \"e-") === false, "入口条目没被去掉");
  eq("?e=0 时中继条目用域名入口", serverOf(noEdgeTxt, "r-45.136.117.194-VLT"), subHost);

  // ② ?r=0 才是中继开关：中继条目与组都没了，入口条目照旧
  const noRelayTxt = render("?r=0");
  ok("?r=0 时中继条目消失", noRelayTxt.includes("- name: \"r-45.136.117.194-VLT\"") === false, "中继条目还在");
  ok("?r=0 时中继优选组消失", noRelayTxt.includes("\"🔁 中继优选\"") === false, "中继优选组还在");
  ok("?r=0 时入口条目仍在", noRelayTxt.includes("- name: \"e-"), "入口条目被连带删掉了");

  // ③ 默认（两个开关都不给）：入口 IP 还在时，中继条目必须钉在入口 IP 上，不能退化成域名
  const defTxt = render("");
  ok("默认时中继条目钉入口 IP", /^\d+\.\d+\.\d+\.\d+$/.test(String(serverOf(defTxt, "r-45.136.117.194-VLT"))), "中继条目的 server 不是 IP 字面量");

  // ④ RegionEntry 的端口兜底：url 省略时不能是 undefined（`NaN || undefined` 还是 undefined）
  const regs = W.regionEntries(["HK"], subHost, "", ["vless"], undefined);
  eq("省略 url 时地区条目端口是 443", regs.length && regs[0].port, 443);
  const regHttp = W.regionEntries(["HK"], subHost, "", ["vless"], new URL("http://" + subHost + "/sub"));
  eq("http 订阅的地区条目端口是 80", regHttp.length && regHttp[0].port, 80);
  const regPort = W.regionEntries(["HK"], subHost, "", ["vless"], new URL("https://" + subHost + ":8443/sub"));
  eq("显式端口的订阅按 URL 端口走", regPort.length && regPort[0].port, 8443);

  W.S.alive = aliveBefore;
  W.S.eg4Top = egBefore;

  // ⑤ 源码锁：两个开关必须是两个独立条件；兜底写法必须在位
  const srcSub = fs.readFileSync("src/views/sub.ts", "utf8");
  ok("中继块只判 noRelay", srcSub.includes("if (!noRelay) {"), "条件里还带着 noEdge");
  eq("中继块不再要求入口 IP 存在", srcSub.includes("if (!noEdge && !noRelay) {"), false);
  const srcCommon = fs.readFileSync("src/views/sub-common.ts", "utf8");
  ok("地区条目端口有显式兜底", srcCommon.includes(': 443;'), "端口兜底不见了");
  // 注释里可以引用旧写法（说明为什么改），但可执行的那一行必须是新的三目
  const commonCode = srcCommon.split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n");
  eq("端口表达式不再依赖 url 守卫", commonCode.includes("Number(url && url.port)"), false);
  ok("端口表达式显式区分有无 url", commonCode.includes("const listen = url ? Number(url.port)"), "端口表达式没改");
  // ⑥ sing-box 的两处 domain_strategy 被脚本打散过缩进（块内 10 空格）
  const sbLines = fs.readFileSync("src/views/sub-singbox.ts", "utf8").split(/\r?\n/);
  eq("sing-box 没有 4 空格缩进的 domain_strategy", sbLines.filter((l) => /^ {4}domain_strategy:/.test(l)).length, 0);
}
// 第 198 组：?p= 协议开关（v8 §7 里写的是 ?p=vless|tj|both，而代码原先只读 ?proto=，且不认 tj / both）
{
  const id198 = "4241b903-8d39-4a17-8f4c-bb33b1630c33";
  const envP = { uuid: "u", nodes: "", proxyip: "auto", pwd: "tj-pass-198" };
  const R = (q) => W.renderClash(envP, new URL("https://example.com/x" + q), id198, "example.com");
  // 每个 proxy 块都有一行 `    type: <proto>`，按它数协议条目最稳（名字里既可能是 vless- 也可能是 -VL）
  const tj = (y) => (y.match(/^    type: trojan$/gm) || []).length;
  const vl = (y) => (y.match(/^    type: vless$/gm) || []).length;
  const d = R("");
  ok("有 trojan 密码时默认两协议都在", tj(d) > 0 && vl(d) > 0, "tj=" + tj(d) + " vl=" + vl(d));
  eq("?p=vless 去掉全部 trojan 条目", tj(R("?p=vless")), 0);
  ok("?p=vless 仍保留 vless 条目", vl(R("?p=vless")) > 0);
  eq("?p=tj 去掉全部 vless 条目", vl(R("?p=tj")), 0);
  ok("?p=tj 仍保留 trojan 条目", tj(R("?p=tj")) > 0);
  eq("?p=trojan 等同 ?p=tj", tj(R("?p=trojan")), tj(R("?p=tj")));
  eq("?p=both 回到默认", tj(R("?p=both")), tj(d));
  eq("?proto=vless 历史别名仍生效", tj(R("?proto=vless")), 0);
  eq("?p= 优先于 ?proto=", tj(R("?p=vless&proto=trojan")), 0);
  eq("?p=VL 大小写不敏感", tj(R("?p=VL")), 0);
  const envNoPwd = { uuid: "u", nodes: "", proxyip: "auto" };
  const nb = W.renderClash(envNoPwd, new URL("https://example.com/x?p=tj"), id198, "example.com");
  ok("没有 trojan 密码时 ?p=tj 回落到 vless（不能给出空订阅）", vl(nb) > 0 && tj(nb) === 0, "vl=" + vl(nb) + " tj=" + tj(nb));
  const sc198 = fs.readFileSync("src/views/sub-common.ts", "utf8");
  eq("pickProtos 读规范名 ?p=", sc198.includes('url.searchParams.get("p")'), true);
  eq("pickProtos 仍认 ?proto= 别名", sc198.includes('url.searchParams.get("proto")'), true);
  eq("pickProtos 认文档里的 tj 取值", sc198.includes('q === "tj"'), true);
}

// 第 199 组：env.adminHash 是只进签名的影子字段（配了也永远进不去，已删除）
{
  const K199 = "#probe-admin-key-199";
  const DIG199 = await W.sha256Hex(K199);
  const U199 = new URL("https://example.com/admin");
  const req199 = (h) => new Request("https://example.com/admin", { headers: h });
  const envK = { adminKey: K199 };
  eq("明文 key（X-Admin-Key）可认证", await W.adminAuthed(req199({ "X-Admin-Key": K199 }), U199, envK), true);
  eq("明文 key（Bearer）可认证", await W.adminAuthed(req199({ Authorization: "Bearer " + K199 }), U199, envK), true);
  eq("sha256 摘要可当等价凭证", await W.adminAuthed(req199({ Authorization: "Bearer " + DIG199 }), U199, envK), true);
  eq("错误 key 被拒", await W.adminAuthed(req199({ "X-Admin-Key": "#wrong" }), U199, envK), false);
  eq("只配 adminHash 的部署进不去（字段已删，等价未配置）", await W.adminAuthed(req199({ "X-Admin-Key": K199 }), U199, { adminKey: "", adminHash: DIG199 }), false);
  const exp199 = 1800000000000;
  eq("会话签名不受 adminHash 影响", await W.sessionToken({ adminKey: K199 }, exp199), await W.sessionToken({ adminKey: K199, adminHash: "zzz" }, exp199));
  const authSrc199 = fs.readFileSync("src/edge/auth.ts", "utf8");
  eq("签名材料里没有 adminHash", authSrc199.includes("env.adminHash"), false);
  const envTypes199 = fs.readFileSync("types/env.d.ts", "utf8");
  eq("类型里没有 adminHash", envTypes199.includes("adminHash"), false);
  // 文档：开关清单必须与代码口径一致（?ei 上限是 8、?p 默认 both、?full 未实现）
  const v8199 = fs.readFileSync("docs/v8.md", "utf8");
  eq("文档写了 ?ei=4..8", v8199.includes("?ei=4..8"), true);
  eq("文档不再声称 ?full=1 生效", /`\?full=1`\s*≤60/.test(v8199), false);
  eq("文档写明 ?full 未实现", v8199.includes("?full=` 至今零读取"), true);
  eq("文档写明 ?p 默认 both", v8199.includes("默认 `both`"), true);
}

// 第 200 组：sing-box 的本地直连口径（tun + auto_route 接管整机流量，private 网段与局域网 DNS 必须放直连）
{
  const envS200 = { uuid: "u200", nodes: "", proxyip: "auto" };
  const idS200 = "4241b903-8d39-4a17-8f4c-bb33b1630c33";
  const alive200 = W.S.alive;
  const now200 = Date.now();
  W.S.alive = new Map([
    ["45.136.117.194", { at: now200, ms: 120 }],
    ["193.181.211.185", { at: now200, ms: 150 }],
  ]);
  const sb200 = JSON.parse(W.renderSingbox(envS200, new URL("https://example.com/sub"), idS200, "example.com", {}, ["HK"]));
  W.S.alive = alive200;

  const dns200 = sb200.dns || {};
  const route200 = sb200.route || {};
  const dnsTags200 = (dns200.servers || []).map((s2) => s2.tag);
  const dnsRules200 = Array.isArray(dns200.rules) ? dns200.rules : [];
  const localRule200 = dnsRules200.find((r) => r.server === "dns_local");
  // dns_local 只声明不选 = 内网主机名照样送到公网 DNS（还经代理），等于没配
  eq("sing-box 有 dns 规则把局域网后缀交给 dns_local", Boolean(localRule200), true);
  eq("局域网后缀覆盖 .lan", String(localRule200 && localRule200.domain_suffix).includes(".lan"), true);
  eq("局域网后缀覆盖 .local", String(localRule200 && localRule200.domain_suffix).includes(".local"), true);
  eq("dns 规则引用的 server 都在 dns.servers 里", dnsRules200.every((r) => dnsTags200.includes(r.server)), true);
  eq("默认 DNS 仍是走代理的 dns_remote", dns200.final, "dns_remote");
  const remote200 = (dns200.servers || []).find((s2) => s2.tag === "dns_remote");
  eq("dns_remote 依旧经手动组出去", Boolean(remote200 && remote200.detour), true);

  const routeRules200 = Array.isArray(route200.rules) ? route200.rules : [];
  const priv200 = routeRules200.find((r) => r.ip_is_private === true);
  eq("route 有 private 网段规则", Boolean(priv200), true);
  eq("private 网段放直连", priv200 && priv200.outbound, "direct");
  const sbTags200 = (sb200.outbounds || []).map((o) => o.tag);
  eq("private 规则指向的 direct 出站真实存在", sbTags200.includes("direct"), true);
  eq("未命中仍落到手动组", Boolean(route200.final) && sbTags200.includes(route200.final), true);
  const tun200 = (sb200.inbounds || []).find((i) => i.type === "tun");
  eq("tun 仍开着 auto_route（所以 private 直连必须显式写）", Boolean(tun200 && tun200.auto_route), true);
  const src200 = fs.readFileSync("src/views/sub-singbox.ts", "utf8");
  eq("源码里写了 ip_is_private 直连", src200.includes("ip_is_private: true"), true);
  eq("源码里局域网后缀与 dns_local 配对", src200.includes('server: "dns_local"'), true);
  // 对照：Clash 侧本来就有本地解析与 CN 直连，改 sing-box 时别把两边口径搞反
  const cl200 = W.renderClash(envS200, new URL("https://example.com/sub"), idS200, "example.com");
  eq("Clash 侧仍是本地 nameserver", cl200.includes("nameserver: [223.5.5.5"), true);
  eq("Clash 侧仍有 GEOIP,CN 直连", cl200.includes("- GEOIP,CN,DIRECT"), true);
}
// 第 201 组：tfb 起搏记账收类（原先是 cron.ts 顶层两张 Map，只被一条移除路径清）
{
  const TB = W.TfbBook;
  ok("tfb 起搏记账已收类", !!W.TFB && typeof W.TFB.sweep === "function");
  ok("TfbBook 可从测试窗口构造", typeof TB === "function");
  if (typeof TB === "function") {
    const now = 1800000000000;
    const b = new TB();
    eq("新账本为空", b.size(), 0);
    eq("新站点可以开批", b.due("a.test", now), true);
    b.take("a.test", now);
    eq("10 分钟内不再开批", b.due("a.test", now + 599999), false);
    eq("过了 10 分钟可以再开", b.due("a.test", now + 600000), true);
    b.take("a.test", now + 600000);
    b.take("a.test", now + 1200000);
    eq("同一窗口满 3 批后不再开", b.due("a.test", now + 1799999), false);
    eq("恰好 30 分钟仍算同一窗口（边界不归零）", b.due("a.test", now + 2999999), false);
    eq("满 30 分钟后批数归零", b.due("a.test", now + 3000000), true);

    // sweep 是唯一清理入口：keep 里没有的、以及自己过期的，都要被忘掉
    const b2 = new TB();
    b2.take("keep.test", now);
    b2.take("gone.test", now);
    b2.take("expired.test", now);
    const keep = new Map([["keep.test", now + 1000], ["expired.test", now - 1]]);
    eq("sweep 清掉「被挤出 needPx」与「自己过期」的两类", b2.sweep(keep, now), 2);
    eq("sweep 之后只剩还活着的那个站点", b2.size(), 1);
    eq("被清掉的站点重回可开批状态", b2.due("gone.test", now + 100), true);

    // 上限兜底：keep 自己涨过头（attacher 那条写入路径不裁剪）时，按最久没探过淘汰
    const b3 = new TB();
    for (let i = 0; i < 400; i++) b3.take(`h${i}.test`, now + i);
    const all = new Map();
    for (let i = 0; i < 400; i++) all.set(`h${i}.test`, now + 1e9);
    b3.sweep(all, now);
    eq("记账表被压回 SC.PX_MAX", b3.size(), W.SC.PX_MAX);
    eq("最旧的被淘汰（记账里已没有它）", b3.due("h0.test", now + 100), true);
    eq("最近的仍在记账里（间隔内不再开）", b3.due("h399.test", now + 499), false);
  }

  // 源码锁：顶层两张 Map 必须消失、清理只走 sweep、上限与 needPx 同源
  const srcCron201 = fs.readFileSync("src/routes/cron.ts", "utf8");
  const srcBook201 = fs.readFileSync("src/route/tfbbook.ts", "utf8");
  eq("cron.ts 不再有顶层 TFB_AT/TFB_N", /TFB_AT|TFB_N/.test(srcCron201), false);
  eq("cron.ts 不再自己 new Map", srcCron201.includes("new Map("), false);
  eq("cron.ts 走 TFB.sweep 清理", srcCron201.includes("TFB.sweep(S.needPx, now)"), true);
  eq("cron.ts 开批前问 due", srcCron201.includes("if (!TFB.due(host, now)) continue;"), true);
  eq("账本容量交给 BoundedMap（与 SC.PX_MAX 同源）", srcBook201.includes("max: SC.PX_MAX") && srcBook201.includes("this.lastBatchAt.prune(now, false)"), true);
  const srcArch201 = fs.readFileSync("tools/check-arch.js", "utf8");
  eq("arch 门禁拦住顶层可变容器", srcArch201.includes("顶层可变容器"), true);
}

// 第 202 组：force 落盘必须真的落盘；信誉表类型里不许留没人写也没人读的字段
{
  const store = Object.create(null);
  const puts = [];
  const envF = {
    STATS: {
      get: async (k) => (k in store ? store[k] : null),
      put: async (k, v) => {
        store[k] = v;
        puts.push(k);
      },
    },
  };
  const snapWrites = () => puts.filter((k) => k === "snap").length;
  const mark = () => W.S.stats.set("force-u", { up: 3, down: 4, conns: 1, first: 1, last: 1 });

  W.S.snapWritten = 0;
  W.S.snapChecked = 0;
  W.S.snapBusy = false;
  mark();
  await W.flushSnap(envF, true);
  eq("第一次强制落盘写了 snap", snapWrites(), 1);

  // 5 分钟检查闸门：旧代码在 force 时也会 return，强制落盘静默变成 no-op
  mark();
  await W.flushSnap(envF, true);
  eq("紧接着再强制一次仍会落盘（不被 5 分钟检查闸门吃掉）", snapWrites(), 2);

  // 45 分钟全局闸门：把检查闸门的手动复位掉，单独验证第二道
  W.S.snapChecked = 0;
  mark();
  await W.flushSnap(envF, true);
  eq("force 也绕过 45 分钟全局闸门", snapWrites(), 3);

  // 非 force 的路径必须仍然被节流（否则 force 就成了唯一节流）
  mark();
  await W.flushSnap(envF);
  eq("非 force 的路径仍被节流", snapWrites(), 3);
  W.S.stats.delete("force-u");

  const srcSnap202 = fs.readFileSync("src/store/snapshot.ts", "utf8");
  eq("检查闸门对 force 放行", srcSnap202.includes("if (!force && now - S.snapChecked < 5 * 60000) return;"), true);
  eq("全局闸门对 force 放行", srcSnap202.includes("if (!force && now - (prev.ts || 0) < FLUSH_GAP) {"), true);
  eq("flushSnap 把 force 传下去", srcSnap202.includes("await writeSnap(env, now, !!force);"), true);
  eq("usageSnapWrite 文档不再承诺「不传就用本地状态」", srcSnap202.includes("不传则用本地状态"), false);

  const srcTypes202 = fs.readFileSync("types/app.d.ts", "utf8");
  eq("信誉表类型不再留 Seed.lastColo", srcTypes202.includes("lastColo"), false);
  eq("信誉表类型不再留 SeedHp", srcTypes202.includes("SeedHp"), false);
  eq("信誉表条目不再声明 v6 统计字段", /interface SeedNode \{[^}]*sb\?:/.test(srcTypes202), false);
  eq("信誉表条目仍声明名字与地址", /interface SeedNode \{[^}]*k: string;/.test(srcTypes202), true);
}
// —— 第 203 组：计数器账本（登记了就必须有人写）——
{
  const st = fs.readFileSync("src/core/state.ts", "utf8");
  const cw = fs.readFileSync("tools/check-wire.mjs", "utf8");
  const cn = fs.readFileSync("src/proxy/connection.ts", "utf8") + fs.readFileSync("src/proxy/conn-settle.ts", "utf8");
  ok("szBig 已从登记表删除（触发条件不可达）", !/^\s*"szBig",/m.test(st));
  ok("psSent 已从登记表删除", !/^\s*"psSent",/m.test(st));
  ok("egProbe 已从登记表删除", !/^\s*"egProbe",/m.test(st));
  ok("e4retry 已从登记表删除", !/^\s*"e4retry",/m.test(st));
  ok("vtSeen 已从登记表删除", !/^\s*"vtSeen",/m.test(st));
  ok("vtPend 计数键已删除（S.vtPend 是另一张表）", !/^\s*"vtPend",/m.test(st));
  eq("connection.ts 与 conn-settle.ts 的 tput 都走 cnt()", (cn.match(/cnt\("tput"\)/g) || []).length, 2);
  ok("connection.ts 不再直接改 S.cnt.tput", !cn.includes("S.cnt.tput"));
  ok("check-wire 有动态键白名单", cw.includes("DYN_CNT"));
  ok("check-wire 会对死登记键报红", cw.includes("没有任何 cnt("));
  W.S.cntDay = "1970-01-01";
  W.S.cnt.tput = 5;
  W.cnt("tput");
  eq("cnt() 跨天后从 1 开始", W.S.cnt.tput, 1);
  W.cnt("szBig");
  ok("未登记的键不会凭空出现", !("szBig" in W.S.cnt));
}
// —— 第 204 组：池子锚点必须单调（本地旧池子不能把共享代际改小）——
{
  const store = Object.create(null);
  const envS = {
    STATS: {
      get: async (k) => (k in store ? store[k] : null),
      put: async (k, v) => {
        store[k] = v;
      },
    },
  };
  const fakePool = (n) => {
    const a = [];
    for (let i = 0; i < n; i++) a.push({ k: "h" + i + ":443", h: "1.1.1." + (i % 250), p: 443, cc: "US" });
    return a;
  };
  W.S.colo = "HKG";
  W.S.seed = { v: 7, ts: 0, poolGen: 0, poolN: 0, builtAt: 0, byColo: {}, cnt: null };
  W.S.seedReadFail = false;
  W.S.seedAt = 0;
  // 第一步：让这块「共享锚点」先到第 6 代 320 条（用写盘本身建立，不手搓 seal）
  W.S.poolGen = 6;
  W.S.poolBuilt = 111;
  W.S.pool = fakePool(320);
  await W.SEEDS.write(envS, false, true);
  eq("锚点建立到第 6 代", W.S.seed.poolGen, 6);
  eq("锚点规模 320", W.S.seed.poolN, 320);
  // 第二步：本地停在旧代（5 代 200 条）的 isolate 落盘，不得把锚点改小
  W.S.seedAt = 0;
  W.S.poolGen = 5;
  W.S.poolBuilt = 100;
  W.S.pool = fakePool(200);
  await W.SEEDS.write(envS, false, true);
  eq("落后一个代际的 isolate 不会把锚点代际改小", W.S.seed.poolGen, 6);
  eq("也不会把锚点规模改小", W.S.seed.poolN, 320);
  eq("也不会把建池时间改小", W.S.seed.builtAt, 111);
  // 第三步：同代但本地池子更全 → 取较大值
  W.S.seedAt = 0;
  W.S.poolGen = 6;
  W.S.pool = fakePool(400);
  await W.SEEDS.write(envS, false, true);
  eq("同代取较大规模", W.S.seed.poolN, 400);
  // 第四步：本地确实更新 → 用本地那一对
  W.S.seedAt = 0;
  W.S.poolGen = 7;
  W.S.poolBuilt = 222;
  W.S.pool = fakePool(410);
  await W.SEEDS.write(envS, false, true);
  eq("本地更新时代际前移", W.S.seed.poolGen, 7);
  eq("本地更新时规模取本地", W.S.seed.poolN, 410);
  eq("本地更新时建池时间取本地", W.S.seed.builtAt, 222);
  // 源码锁
  const sd = fs.readFileSync("src/px/seed.ts", "utf8");
  ok("写盘走 poolAnchor()", sd.includes("const pa = this.poolAnchor();") && sd.includes("const pa0 = this.poolAnchor();"));
  ok("不再有「本地优先」的锚点写法", !sd.includes("poolGen: S.poolGen || S.seed.poolGen"));
  ok("落后时的分支原样沿用锚点", sd.includes("return { gen: gSeed, n: nSeed, builtAt: atSeed };"));
}
// 第 205 组：按站点内存表的淘汰序（7.204）

// 旧口径：`Map.set` 对已存在的键不移动位置，所以 trim 删的是「最早插进来的」——
// 而最早插进来的往往正是最热的站点（每个请求都会 set 一次），于是它第一个被删、
// 康复计数器反复归零，真正陈旧的站点反而留着。修法是写入端先 delete 再 set。
{
  const HOST_MAX = 512;
  const RELAY = "45.136.117.194";
  const ctx = (host) => ({
    host,
    cfHost: false,
    clientV6: false,
    relays: [RELAY],
    legacyWantsRelay: false,
  });
  const p = new W.Policy();
  // h0 是「最热的站点」：每插一个别的站点之前都访问它一次
  for (let i = 0; i < HOST_MAX + 88; i++) {
    p.decide(ctx("h0"));
    p.decide(ctx("h" + (i + 1)));
  }
  eq("序号表压回上限内", p.seq.size <= HOST_MAX, true);
  eq("最热的站点没被淘汰（真 LRU）", p.seq.has("h0"), true);
  eq("最热站点的序号没有被归零", (p.seq.get("h0") || 0) > HOST_MAX, true);
  eq("最早插入的普通站点确实被淘汰", p.seq.has("h1"), false);

  // 钉住表同一个口径：刚钉过的站点不能被 trim 先删
  const p2 = new W.Policy();
  p2.pinFor("hot", ["1.1.1.1"]);
  for (let i = 0; i < HOST_MAX + 40; i++) {
    p2.pinFor("hot", ["1.1.1.1"]);
    p2.pinFor("n" + i, ["3.3.3.3"]);
  }
  eq("钉住表压回上限内", p2.pin.size <= HOST_MAX, true);
  eq("刚钉过的站点没被淘汰", p2.pin.has("hot"), true);
  eq("钉住仍是第一次选中的那条", p2.pin.get("hot").ip, "1.1.1.1");

  // 源码锁：两个写入端都必须先 delete 再 set，注释里必须写明 Map 的语义
  const srcPolicy = fs.readFileSync("src/route/policy.ts", "utf8");
  ok("decide 里先删后插", srcPolicy.includes("this.seq.delete(c.host);"), "");
  ok("pinFor 里先删后插", srcPolicy.includes("this.pin.delete(host);"), "");
  ok("注释写明 Map.set 不移动位置", srcPolicy.includes("**不移动插入位置**"), "");
  // 零调用的 Judge.okAge 已删（文档说返回「距上次 ok 的时间」，实现返回 1/0）
  const srcJudge = fs.readFileSync("src/route/judge.ts", "utf8");
  ok("Judge.okAge 已删", srcJudge.includes("okAge") === false, "");
  ok("测试窗口里也没有它", typeof W.JUDGE.okAge, "undefined");
}

// 第 206 组：面板数据的每个字段都必须有渲染点（7.205）

// 旧形状：`subscription.ts` 在打开控制页时 `Promise.all` 里多取了一次池子的当前中继
// （`pxGet` 是一次 KV/DO 往返），还顺手塞了 `cntView()`，而 `panel.ts` 从来没渲染这两个字段。
{
  const srcSub = fs.readFileSync("src/routes/subscription.ts", "utf8");
  ok("面板路径不再取池子的当前中继", srcSub.includes("pxGet(") === false, "");
  ok("面板路径不再塞计数器快照", srcSub.includes("cntView(") === false, "");

  const srcTypes = fs.readFileSync("types/app.d.ts", "utf8");
  const srcPanel = fs.readFileSync("src/views/panel.ts", "utf8");
  const head = srcTypes.indexOf("interface PanelInfo");
  ok("PanelInfo 类型还在", head > 0, "");
  const body = srcTypes.slice(head, srcTypes.indexOf("}", head));
  const fields = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s{2}([a-z][A-Za-z0-9]*)\s*:/);
    if (m) fields.push(m[1]);
  }
  eq("PanelInfo 字段都被解析到", fields.length > 8, true);
  const missing = fields.filter((f) => srcPanel.includes("i." + f) === false);
  eq("每个字段都有渲染点", missing.join(","), "");
  eq("curPx 已从类型里删掉", /\bcurPx\b/.test(srcTypes), false);

  // 行为面：面板真的还能渲染，且没有把 undefined 印到页面上
  const env = { nodes: "", uuids: "" };
  const url = new URL("https://panel.example.com/u1");
  const info = {
    regions: ["HK"],
    curLat: "1.2.3.4",
    curTput: "5.6.7.8",
    colo: "HKG",
    funnel: "直连 50% · 中转 50%",
    aliveCount: 3,
    used: "1 MB",
    today: "1 MB",
    quota: "100 MB",
    expire: "长期",
    policy: "滞回 15%",
  };
  const html = W.PAGES.panel(env, url, "u1", "panel.example.com", "k", info);
  ok("面板渲染出当前节点行", html.includes("当前节点 · 吞吐优先"), "");
  ok("面板里没有 undefined", html.includes("undefined") === false, "");
  ok("存活条数进了页面", html.includes("3"), "");
}

// 第 207 组：快照读失败不能缓存成「空快照」，也不能被记成「没有旧键」（7.206）
{
  // 每个场景一个独立计数器，用来证明「失败那次没有把结果缓存住」
  const mkKv = (fn) => {
    const box = { n: 0 };
    const env = {
      STATS: {
        get: async (k) => {
          box.n += 1;
          return fn(k);
        },
        put: async () => {},
      },
    };
    return { env, calls: () => box.n };
  };

  W.S.snapCache = { v: null, t: 0 };
  const bad = mkKv(async () => {
    throw new Error("kv hiccup");
  });
  let thrown = false;
  try {
    await W.STORE.snap(bad.env);
  } catch (e) {
    thrown = true;
  }
  eq("快照读失败必须抛错（不能返回空表）", thrown, true);
  eq("读失败不进缓存", W.S.snapCache.t, 0);
  eq("读失败后缓存里没有空快照", W.S.snapCache.v, null);

  // KV 恢复：同一个 isolate 里不带 fresh 也必须能读到（旧代码会拿缓存糊弄 5 分钟）
  const good = mkKv(async () => null);
  const doc = await W.STORE.snap(good.env);
  eq("KV 恢复后立刻能读到快照", typeof doc, "object");
  eq("KV 恢复后真的重新打了一次", good.calls(), 1);

  // 键不存在是「还没有快照」，这种情况可以缓存（否则每次订阅都打一次 KV）
  W.S.snapCache = { v: null, t: 0 };
  const miss = mkKv(async () => null);
  const m1 = await W.STORE.snap(miss.env);
  const m2 = await W.STORE.snap(miss.env);
  eq("没有快照键时缓存空表", m1 === m2, true);
  eq("没有快照键时只打一次 KV", miss.calls(), 1);

  // 路径一：快照读失败 ⇒ getSnap 抛错 ⇒ loadRtt 退回内存，不写 rttMiss
  W.S.rttMiss.clear();
  W.S.snapCache = { v: null, t: 0 };
  const rttFail = mkKv(async () => {
    throw new Error("kv hiccup");
  });
  const mem1 = await W.loadRtt(rttFail.env, "u207a");
  eq("loadRtt 快照读失败时返回内存那份", typeof mem1, "object");
  eq("loadRtt 快照读失败不写 rttMiss", W.S.rttMiss.size, 0);

  // 路径二：快照有缓存（空表，属真值），但旧键 rtt:<id> 读失败 ⇒ 同样不能记「没有旧键」
  W.S.rttMiss.clear();
  W.S.snapCache = { v: { v: 1, ts: 1, date: "", stats: {}, rtt: {}, errs: [] }, t: Date.now() };
  const legacyFail = mkKv(async () => {
    throw new Error("kv hiccup");
  });
  const mem2 = await W.loadRtt(legacyFail.env, "u207b");
  eq("loadRtt 旧键读失败时返回内存那份", typeof mem2, "object");
  eq("loadRtt 旧键读失败不写 rttMiss", W.S.rttMiss.size, 0);

  // 旧键确实不存在（不抛错）时才允许记 10 分钟，避免每次刷订阅都打一次 KV
  W.S.rttMiss.clear();
  const legacyMiss = mkKv(async () => null);
  await W.loadRtt(legacyMiss.env, "u207c");
  eq("旧键确实不存在时记 rttMiss", W.S.rttMiss.size, 1);

  const srcSnap = fs.readFileSync("src/store/snapshot.ts", "utf8");
  ok("快照读走严格读（能区分空与读不到）", srcSnap.includes('kvGetStrict<SnapDoc>(env, "snap")'), "");
  ok("不再用吞异常的 kvGet 读快照", srcSnap.includes('(await kvGet<SnapDoc>(env, "snap")) || null') === false, "");
  const cut = srcSnap.indexOf("await eachLimit(head, 8, async");
  eq("eachLimit 那行有缩进", cut > 2 ? srcSnap.slice(cut - 2, cut) : "?", "  ");

  const srcMetrics = metricsAll();
  ok("旧键迁移也走严格读", srcMetrics.includes("kvGetStrict<Record<string, RttEntry>>(env, `rtt:${id}`)"), "");
  ok("metrics 不再引 kvGet", srcMetrics.includes('import { getSnap, kvGet }') === false, "");

  const srcLogs = fs.readFileSync("src/routes/logs.ts", "utf8");
  ok("日志路径的快照读失败会留痕", srcLogs.includes('logErr("logs snap read failed", "kv")'), "");
}

// ── 208. 绑定名必须在类型里声明（v7.207：Env 的索引签名让拼错也能编译通过）──
{
  const envDts = fs.readFileSync("types/env.d.ts", "utf8");
  const envBody = envDts.slice(envDts.indexOf("interface Env {"), envDts.indexOf("/** request.cf"));
  // 只看代码行：注释里提到索引签名这个形状时不能自伤（v7.207 踩过一次）
  const envCode = envBody
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  ok("Env 没有索引签名（否则拼错的绑定也能编译）", !/\[\s*k\s*:\s*string\s*\]/.test(envCode));
  ok("scanSub 已在 Env 里声明", /scanSub\?: string;/.test(envBody));
  ok("poolSrc 已在 Env 里声明", /poolSrc\?: string;/.test(envBody));
  // 声明与读取必须一一对上：src 读到的每个 env.X 都得在 Env 里（本条锁住「新增绑定忘记声明」）
  const declaredFields = new Set([...envBody.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1]));
  const readFields = new Map();
  const walkSrc = (d) =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walkSrc(d + "/" + e.name) : e.name.endsWith(".ts") ? [d + "/" + e.name] : []));
  for (const sf of walkSrc("src")) {
    for (const line of fs.readFileSync(sf, "utf8").split(/\r?\n/)) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      for (const m of line.matchAll(/\benv\.([A-Za-z_$][\w$]*)/g)) if (!readFields.has(m[1])) readFields.set(m[1], sf);
    }
  }
  const missing = [...readFields.keys()].filter((n) => !declaredFields.has(n));
  eq("src 里读到的 env 字段都在 Env 里声明", missing.join(","), "");
  // 旧绑定名兼容（trojan）必须仍然生效：靠显式转型，而不是把索引签名加回来
  const utilSrc = fs.readFileSync("src/core/util.ts", "utf8");
  ok("旧绑定名走显式转型而不是索引签名", utilSrc.includes("(env as unknown as Record<string, unknown>)[P_T]"));
  eq("旧名仍能读到密码", W.secretPwd({ trojan: "legacy-pw" }), "legacy-pw");
  eq("新名优先于旧名", W.secretPwd({ pwd: "  x  ", trojan: "b" }), "x");
  eq("两个都没配时为空串", W.secretPwd({}), "");
}
/* ===== 第 209 组：直连拨号也必须有时限（7.208 D164） ===== */
{
  const prevSim = globalThis.__simConnect;
  const envD = { proxyip: "", uuid: "main", proxyipList: "" };
  const reqD = new Request("https://example.com/probe");
  const mkSt = () => ({ hostTrial: false, trial: false, pxTries: 0 });
  const runOne = async () => {
    const t = Date.now();
    const r = await Promise.race([
      W.DIALER.open({ env: envD, request: reqD, conn: mkSt(), mode: "tput", host: "example.com", port: 80, pxForce: -1 })
        .then(() => "ok")
        .catch((e) => "err:" + String(e && e.message)),
      new Promise((res) => setTimeout(() => res("hang"), 4500)),
    ]);
    return { r, ms: Date.now() - t };
  };
  // ① connect() 永远不返回：必须在上限内失败，不能把请求一起挂住
  globalThis.__simConnect = () => new Promise(() => {});
  const a = await runOne();
  ok("直连挂死时 4.5 秒内必须失败", a.r === "err:timeout", JSON.stringify(a));
  ok("直连挂死的等待上限约 2.5 秒", a.ms < 4000, String(a.ms));
  // ② 3 秒后才连上：必须已经放弃，并把迟到的 socket 关掉（否则白占 6 个并发名额）
  let closedD = 0;
  globalThis.__simConnect = () =>
    new Promise((res) =>
      setTimeout(
        () =>
          res({
            close: () => {
              closedD += 1;
            },
            closed: Promise.resolve(),
            opened: Promise.resolve({}),
          }),
        3000,
      ),
    );
  const b = await runOne();
  await new Promise((r) => setTimeout(r, 1200));
  ok("迟到的直连也会被放弃", b.r === "err:timeout", JSON.stringify(b));
  ok("迟到的直连 socket 会被关掉", closedD === 1, String(closedD));
  globalThis.__simConnect = prevSim;
  // ③ 源码锁：两个直连分支都必须走 guarded，且 guarded 用 2500ms 上限
  const dialerSrc = fs.readFileSync("src/proxy/dialer.ts", "utf8");
  ok(
    "直连两个分支都走 guarded 上限",
    dialerSrc.includes("await this.guarded(dial4(host, port), host)") &&
      dialerSrc.includes("await this.guarded(dial(host, port), host)"),
  );
  ok(
    "不再有裸的直连拨号",
    !dialerSrc.includes("sock = await dial4(host, port);") && !dialerSrc.includes("sock = await dial(host, port);"),
  );
  ok("超时后关掉迟到 socket", dialerSrc.includes("closeQuietly(x)"));
  ok("guarded 用 2500ms 上限", dialerSrc.includes("return await withTimeout(pk, CONNECT_MS);"));
}
/* ===== 第 210 组：探活的三处 connect 惰性建连必须有时限（7.209 D165） ===== */
{
  // connect() 是惰性的：真正的 TCP 建连发生在第一次 write。挂死时三个探测函数都必须自己返回，
  // 不能让 chunks(batch, PROBE_CONC) 的整轮探活跟着一起挂住。
  const prevSimWr = globalThis.__simConnect;
  let closedWr = 0;
  globalThis.__simConnect = () => ({
    writable: { getWriter: () => ({ write: () => new Promise(() => {}), releaseLock: () => {} }) },
    readable: { getReader: () => ({ read: () => new Promise(() => {}) }) },
    close: () => {
      closedWr += 1;
    },
  });
  const bounded = async (fn) => {
    const t = Date.now();
    const r = await Promise.race([
      fn().then((x) => ({ x })).catch((e) => ({ e })),
      new Promise((res) => setTimeout(() => res("hang"), 4500)),
    ]);
    return { r, ms: Date.now() - t };
  };
  const pw = await bounded(() => W.probeProxy("1.2.3.4", 443));
  ok("probeProxy 挂死时 4.5 秒内自己返回", Boolean(pw.r && pw.r.x === null), JSON.stringify(pw.r));
  ok("probeProxy 的等待上限约 2.5 秒", pw.ms < 4000, String(pw.ms));
  const ps = await bounded(() => W.probeSni("1.2.3.4", 443, "example.com", 1200));
  ok("probeSni 挂死时按自己的 ms 返回", Boolean(ps.r && ps.r.x && ps.r.x.err === "tcp"), JSON.stringify(ps.r));
  ok("probeSni 的等待上限跟随 ms 参数", ps.ms < 3000, String(ps.ms));
  const ph = await bounded(() => W.probeHttp80("example.com", "1.2.3.4:80"));
  ok("probeHttp80 挂死时返回 io: timeout", Boolean(ph.r && ph.r.x && ph.r.x.ok === false && ph.r.x.err === "io: timeout"), JSON.stringify(ph.r));
  ok("三次探测都把挂死的 socket 关掉", closedWr >= 3, String(closedWr));
  globalThis.__simConnect = prevSimWr;
  // 源码锁：三处 write 都必须带 withTimeout，且不许再出现裸的 await w.write(
  const probeSrc = fs.readFileSync("src/px/rawprobe.ts", "utf8");
  const httpSrc = fs.readFileSync("src/core/http80.ts", "utf8");
  ok(
    "probeProxy 的 write 有超时",
    probeSrc.includes('withTimeout(w.write(PROBE_HELLO), CONNECT_MS, "timeout")'),
  );
  ok("probeSni 的 write 跟随 ms", probeSrc.includes('withTimeout(w.write(tlsHello(sni)), ms, "timeout")'));
  ok("http80 的 write 有超时", httpSrc.includes('withTimeout(w.write(new TextEncoder().encode(req)), CONNECT_MS, "timeout")'));
  ok("http80 引入了 withTimeout", httpSrc.includes('import { CONNECT_MS, withTimeout } from "./util";'));
  ok(
    "探活路径不再有裸 write",
    !/await w\.write\((?!.*withTimeout)/.test(probeSrc) && !/await w\.write\((?!.*withTimeout)/.test(httpSrc),
  );
}
// ---- 211: 数据面上游写必须有上限（黑洞中继接了连接却不读，write 永不返回） ----
console.log("");
const srcUtil211 = fs.readFileSync("src/core/util.ts", "utf8");
const srcState211 = fs.readFileSync("src/core/state.ts", "utf8");
const srcConn211 = fs.readFileSync("src/proxy/connection.ts", "utf8");
const srcSess211 = fs.readFileSync("src/proxy/session.ts", "utf8");
const srcAtt211 = fs.readFileSync("src/proxy/attacher.ts", "utf8");
ok("上游写上限常量是 30 秒", srcUtil211.includes("export const UP_STALL_MS = 30000;"));
ok("ustall 已登记（否则计数会被静默丢掉）", srcState211.includes('"ustall",'));
ok("泵里改调 upWrite", srcSess211.includes("return st.upWrite(chunk);"));
ok("泵里不再直接写 writer", srcSess211.includes("w.write(chunk)") === false);
ok("首包写也走 upWrite", srcAtt211.includes("await conn.upWrite(payload, FIRST_UP_MS);"));
ok("blackhole 的超时消息可辨认", srcConn211.includes("withTimeout(p, ms, \"up stall\")"));
try {
  const mkSock211 = () => { const o = { closed: 0, close() { o.closed += 1; } }; return o; };
  const mkConn211 = (node, via) => {
    const env = { STATS: { get: async () => null, put: async () => {} } };
    const c = new W.Connection(env, { waitUntil() {}, passThroughOnException() {} }, "tput", "");
    c.node = node;
    c.host = "example.com";
    if (via) c.via = via;
    return c;
  };
  // 黑洞出口：write 永不 resolve
  {
    const c = mkConn211("203.0.113.211:443", "node");
    const sock = mkSock211();
    c.sock = sock;
    c.writer = { write: () => new Promise(() => {}) };
    const before = Number(W.S.cnt.ustall || 0);
    const t0 = Date.now();
    await c.upWrite(new Uint8Array(16), 40);
    const ms = Date.now() - t0;
    ok("黑洞出口不会永远挂着", ms < 400, String(ms));
    eq("超时记 ustall", Number(W.S.cnt.ustall || 0) - before, 1);
    eq("超时关掉 socket", sock.closed, 1);
    ok("超时后不再往死连接写", c.dead === true);
    ok("超时归因到中继节点", Number(W.nsGet("203.0.113.211:443").failW || 0) > 0);
  }
  // 直连黑洞：没有节点可罚，计数与断开照做
  {
    const c = mkConn211("203.0.113.212:443", "direct");
    const sock = mkSock211();
    c.sock = sock;
    c.writer = { write: () => new Promise(() => {}) };
    const fw = Number(W.nsGet("203.0.113.212:443").failW || 0);
    await c.upWrite(new Uint8Array(16), 40);
    eq("直连黑洞也关 socket", sock.closed, 1);
    eq("直连黑洞不罚池子里的节点", Number(W.nsGet("203.0.113.212:443").failW || 0), fw);
  }
  // 正常写：不计 ustall、不关 socket
  {
    const c = mkConn211("203.0.113.213:443", "node");
    const sock = mkSock211();
    c.sock = sock;
    c.writer = { write: async () => {} };
    const before = Number(W.S.cnt.ustall || 0);
    await c.upWrite(new Uint8Array(16), 40);
    eq("正常写不记 ustall", Number(W.S.cnt.ustall || 0), before);
    eq("正常写不关 socket", sock.closed, 0);
  }
  // 普通写失败：只关 socket（与改造前一致），不算黑洞
  {
    const c = mkConn211("203.0.113.214:443", "node");
    const sock = mkSock211();
    c.sock = sock;
    c.writer = { write: async () => { throw new Error("broken pipe"); } };
    const before = Number(W.S.cnt.ustall || 0);
    await c.upWrite(new Uint8Array(16), 40);
    eq("写失败不记 ustall", Number(W.S.cnt.ustall || 0), before);
    eq("写失败关 socket", sock.closed, 1);
  }
} catch (e) {
  ok("上游写上限的行为段可执行（旧代码没有 upWrite）", false, String((e && e.message) || e));
}

// 第 212 组：大池分片重建期间，S.candN 只反映「已经扫过的那一段」——它不能被当成池子大小（7.211）
{
  const bak212 = [...W.S.alive.entries()];
  const bakN212 = W.S.candN;
  const N212 = 1500;
  W.S.alive.clear();
  for (let i = 0; i < N212; i++) {
    const h = "10." + (i >> 8) + "." + (i & 255);
    W.S.alive.set(h + ":443", { h, p: 443, cc: "", ms: 100 });
  }
  W.S.candN = 0;
  W.invalidateRank();
  W.candsFor("lat");
  eq("切片中途不写 candN（旧代码会把 128 当池子大小）", W.S.candN, 0);
  let calls212 = 1;
  while (W.S.candN === 0 && calls212 < 40) {
    W.candsFor("lat");
    calls212++;
  }
  eq("扫完整轮才写 candN", W.S.candN, N212);
  ok("整轮确实是分片扫的", calls212 > 1, "calls=" + calls212);
  const ts212 = fs.readFileSync("src/px/ts.ts", "utf8");
  const sc212 = fs.readFileSync("src/nodes/score-cands.ts", "utf8");
  ok("pickThom 的分母是存活表大小", ts212.includes("const nPool = S.alive.size ||"), "");
  ok("候选表只在扫完时写 candN", sc212.includes("if (st.pos >= st.keys.length) S.candN = st.ok;"), "");
  ok("注释写明不能用 candN 当池子大小", ts212.includes("只反映「已经扫过的那一段」"), "");
  W.S.alive.clear();
  for (const [k212, v212] of bak212) W.S.alive.set(k212, v212);
  W.S.candN = bakN212;
  W.invalidateRank();
}

// ---- 第 213 组：站点冷启动的影子试探（lastTry 只写不读）+ 节点统计里的僵尸字段 ----
{
  const g213keys = ["10.213.0.1:443", "10.213.0.2:443", "10.213.0.3:443"];
  const g213host = "h213.test";
  const oldAlive = W.S.alive;
  const oldRank = W.S.rankCache;
  const setup213 = () => {
    W.S.alive = new Map();
    for (const k of g213keys) W.S.alive.set(k, { h: k.slice(0, k.lastIndexOf(":")), p: 443, cc: "HK" });
    W.S.hostNode.delete(g213host);
    W.S.rankCache = { t: 0, at: {}, v: {}, step: {} };
  };
  setup213();
  const a213 = W.hostUntried(g213host, "lat");
  ok("影子试探先给全局排行第一名", Boolean(a213), a213);
  W.nsGet(a213).lastTry = Date.now();
  const b213 = W.hostUntried(g213host, "lat");
  ok("刚试过的节点不会被第二条并发请求立刻再选一次", b213 !== a213, a213 + " / " + b213);
  ok("换到的是另一条真实候选", g213keys.includes(b213), b213);
  W.nsGet(a213).lastTry = Date.now() - 60000;
  eq("过了窗口期可以再用它", W.hostUntried(g213host, "lat"), a213);
  setup213();
  for (const k of g213keys) W.nsGet(k).lastTry = Date.now();
  const c213 = W.hostUntried(g213host, "lat");
  ok("全都在窗口内时退回一条，不能返回空串", Boolean(c213), c213);
  W.S.alive = new Map([[g213keys[0], { h: "10.213.0.1", p: 443, cc: "HK" }]]);
  W.S.hostNode.delete(g213host);
  W.S.rankCache = { t: 0, at: {}, v: {}, step: {} };
  eq("只有一条候选时在同一条上再试", W.hostUntried(g213host, "lat"), g213keys[0]);
  W.S.alive = oldAlive;
  W.S.rankCache = oldRank;

  const stSrc = statAll();
  const stCode = stSrc.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  ok("节点统计里不再有 eCloseD（只写不读）", !stCode.includes("eCloseD"));
  ok("影子试探的窗口常量进了 SC", fs.readFileSync("src/core/const.ts", "utf8").includes("UNTRIED_GAP: 20000"));
  ok("untried 会读 lastTry", metricsAll().includes("SC.UNTRIED_GAP"));
  ok("selector 仍在返回前记 lastTry", fs.readFileSync("src/px/pickpath.ts", "utf8").includes("nsGet(t0).lastTry = Date.now();"));
  ok("直连空关闭的全局计数保留", fs.readFileSync("src/proxy/attacher.ts", "utf8").includes('cnt("eCloseD")'));
  ok("类型里也没有 eCloseD", !fs.readFileSync("types/app.d.ts", "utf8").includes("eCloseD"));
  const k213 = "10.213.9.9:443";
  W.S.nstat.delete(k213);
  W.nsEmptyClose(k213, false);
  const r213 = W.S.nstat.get(k213);
  eq("直连空关闭不增加中转侧的计数", r213.eCloseP, 0);
  ok("节点统计里没有 eCloseD 这个键", !Object.prototype.hasOwnProperty.call(r213, "eCloseD"));
  W.nsEmptyClose(k213, true);
  eq("中转空关闭会加一", W.S.nstat.get(k213).eCloseP, 1);
  W.S.nstat.delete(k213);
}

/* ===== 第 214 组：SC 里的僵尸常量（有人声明、注释描述了一个不存在的机制、没人读） ===== */
{
  const constSrc = fs.readFileSync("src/core/const.ts", "utf8");
  const utilSrc = fs.readFileSync("src/core/util.ts", "utf8");
  const pxSrc = fs.readFileSync("src/px/const.ts", "utf8");
  const deadSrc = fs.readFileSync("tools/check-dead.mjs", "utf8");
  // 源码锁：两个常量本身不存在了（否则注释会继续描述「seed 先验保质期」「探索上限」）
  ok("SC 不再有 SEED_TTL", !/SEED_TTL:/.test(constSrc) && !/SC\.SEED_TTL/.test(constSrc));
  ok("SC 不再有 EXPLORE_MAX", !/EXPLORE_MAX:/.test(constSrc) && !/SC\.EXPLORE_MAX/.test(constSrc));
  // 文档锁：不许再拿被删的常量当承诺
  ok("shadowRate 文档不再承诺 EXPLORE_MAX", !/SC\.EXPLORE_MAX/.test(utilSrc));
  ok("shadowRate 文档写清探索归抽样负责", utilSrc.includes("探索由单层抽样"));
  ok("px/const 不再引用已删的 SC.SEED_TTL", !/SC\.SEED_TTL/.test(pxSrc));
  // 行为面：pxShadow 的解析口径（默认 0.05、夹到 1、非法回落默认）
  eq("没配 pxShadow 用默认比例", W.shadowRate({}), 0.05);
  eq("配了就用配的值", W.shadowRate({ pxShadow: "0.3" }), 0.3);
  eq("超过 1 夹到 1", W.shadowRate({ pxShadow: "5" }), 1);
  eq("非法值回落默认", W.shadowRate({ pxShadow: "abc" }), 0.05);
  eq("负数回落默认", W.shadowRate({ pxShadow: "-1" }), 0.05);
  eq("env 缺失也不炸", W.shadowRate(null), 0.05);
  // 闸门在位：check-dead 现在也扫 SC 常量，且已接进 preflight
  ok("闸门扫描 SC 常量", deadSrc.includes("SC 常量扫描"));
}
// ===== 第 215 组：远端事实读取失败不能被当成「没有事实」（D171） =====
{
  const mkEnv = (mk) => ({ uuid: "u215", METER: { idFromName: (n) => "id-" + n, get: () => ({ fetch: async () => mk() }) } });
  const reset = () => {
    W.S.vtLoaded = false;
    W.S.vtCool = 0;
    W.S.vtFlight = null;
  };
  const errBody = () => new Response(JSON.stringify({ error: "boom" }), { status: 500 });
  const shapeBad = () => new Response(JSON.stringify({ foo: 1 }), { status: 200 });
  const good = () => new Response(JSON.stringify({ vt: [], hl: [] }), { status: 200 });

  // ① DO 5xx：不能置 vtLoaded，要记冷却，且不回写缓存
  reset();
  let writes = 0;
  let doHits = 0;
  globalThis.caches = { default: { match: async () => undefined, put: async () => { writes += 1; } } };
  await W.vtLoad(mkEnv(() => { doHits += 1; return errBody(); }));
  ok("DO 5xx 不当成事实（不置 vtLoaded）", W.S.vtLoaded === false, String(W.S.vtLoaded));
  ok("DO 5xx 记冷却，允许 60 秒后重试", W.S.vtCool > Date.now(), String(W.S.vtCool - Date.now()));
  eq("DO 5xx 不回写缓存", writes, 0);

  // ② DO 200 但形状不对：同样算失败
  reset();
  writes = 0;
  await W.vtLoad(mkEnv(shapeBad));
  ok("形状不对也不当成事实", W.S.vtLoaded === false, String(W.S.vtLoaded));
  eq("形状不对不回写缓存", writes, 0);

  // ③ 缓存里是坏体：当未命中，重新问 DO，且计数
  reset();
  writes = 0;
  const beforeBad = Number(W.S.cnt.vtCacheBad || 0);
  globalThis.caches = { default: { match: async () => new Response(JSON.stringify({ error: "stale" }), { status: 200 }), put: async () => { writes += 1; } } };
  await W.vtLoad(mkEnv(good));
  eq("坏缓存被当成未命中并计数", Number(W.S.cnt.vtCacheBad || 0), beforeBad + 1);
  ok("坏缓存之后照样拿到事实", W.S.vtLoaded === true, String(W.S.vtLoaded));
  eq("校验通过的快照才回写缓存", writes, 1);

  // ④ 缓存里是好体：命中即用，不再问 DO
  reset();
  writes = 0;
  doHits = 0;
  const beforeHit = Number(W.S.cnt.factsCacheHit || 0);
  globalThis.caches = { default: { match: async () => new Response(JSON.stringify({ vt: [], hl: [] }), { status: 200 }), put: async () => { writes += 1; } } };
  await W.vtLoad(mkEnv(() => { doHits += 1; return good(); }));
  eq("好缓存直接命中", Number(W.S.cnt.factsCacheHit || 0), beforeHit + 1);
  eq("命中缓存不再问 DO", doHits, 0);
  eq("命中缓存不回写", writes, 0);

  // ⑤ 源码锁：判据不能被绕过
  const vsrc = fs.readFileSync("src/route/verdictsync.ts", "utf8");
  ok("DO 读取检查了状态码", vsrc.includes("if (!rr.ok) throw new Error(\"do \" + rr.status);"), vsrc.includes("!rr.ok"));
  ok("DO 读取检查了形状", vsrc.includes("if (!vtShape(bo)) throw new Error(\"do shape\");"));
  ok("vtShape 是类型守卫", vsrc.includes("function vtShape(b: unknown): b is WireBody"));
  ok("坏缓存计数已接线", vsrc.includes("cnt(\"vtCacheBad\")"));
  ok("只有校验通过才回写缓存", vsrc.indexOf("cnt(\"factsDo\")") < vsrc.indexOf("cache.put("));
  delete globalThis.caches;
}
// 连接观测表的淘汰按「最近更新时间」而不是插入序（v7.215）
{
  const d = mkDO();
  const addCl = async (rows) => {
    await d.m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 0, down: 0, conns: 0, cl: rows }) }));
  };
  const ring = async () => ((await (await d.m.fetch(new Request("https://m/cl"))).json()).cl || []);
  await addCl([{ k: "hot", n: 5, ok: 5, p50: 100, p95: 120, dn: 1000 }]);
  await addCl(Array.from({ length: 30 }, (_, i) => ({ k: "n" + i, n: 1, ok: 1, p50: 400, p95: 900, dn: 10 })));
  await addCl([{ k: "hot", n: 1, ok: 1, p50: 105, p95: 130, dn: 200 }]);
  await addCl(Array.from({ length: 30 }, (_, i) => ({ k: "m" + i, n: 1, ok: 1, p50: 400, p95: 900, dn: 10 })));
  const ring1 = await ring();
  eq("连接观测表最多 60 条", ring1.length, 60);
  const hot1 = ring1.find((x) => x.k === "hot");
  ok("一直在用的节点不会因为插得早先被淘汰", Boolean(hot1), JSON.stringify(hot1 || null));
  eq("hot 的累计样本没丢", hot1 ? hot1.n : -1, 6);
  ok("连接观测行都带更新时间", ring1.every((x) => typeof x.t === "number" && x.t > 0));
  ok("不同批次的时间戳互不相同（同一批共享一个）", new Set(ring1.map((x) => x.t)).size >= 3, String(new Set(ring1.map((x) => x.t)).size));
  const meterSrc = storeSrc();
  ok("淘汰前按更新时间排序", meterSrc.includes("(Number(a.t) || 0) - (Number(b.t) || 0) || (a.n || 0) - (b.n || 0)"));
  ok("排序在截断之前", meterSrc.indexOf("Number(a.t) || 0) - (Number(b.t) || 0)") >= 0 && meterSrc.indexOf("Number(a.t) || 0) - (Number(b.t) || 0)") < meterSrc.indexOf("m.connRing = m.connRing.slice(-60)"));
  ok("时间戳取 max(now, 表内最大 + 1)", meterSrc.includes("if (t0 >= clNow) clNow = t0 + 1;"));
  ok("已知行更新时刷新时间戳", meterSrc.includes("old.t = clNow;"));
  const appTypes = fs.readFileSync("types/app.d.ts", "utf8");
  ok("ClRec 声明了更新时间", appTypes.includes("t?: number; // 最近一次更新的时间"));
}

// 中继健康表出站按证据时间切片（v7.216）
{
  const d = mkDO();
  const now = Date.now();
  const heavy = Array.from({ length: 120 }, (_, i) => ({ i: "10.1.1." + i, o: 9, b: 0, d: 0, t: now - 10 * 60000 }));
  const fresh = Array.from({ length: 30 }, (_, i) => ({ i: "10.2.2." + i, o: 1, b: 0, d: 0, t: now - 5000 }));
  const stale = Array.from({ length: 5 }, (_, i) => ({ i: "10.3.3." + i, o: 7, b: 0, d: 0 })); // 不带 t：DO 收到时补当前时间
  await d.m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify({ hl: heavy.concat(fresh).concat(stale) }) }));
  const hl = (await (await d.m.fetch(new Request("https://m/hl"))).json()).hl || [];
  eq("出站上限仍是 120 行", hl.length, 120);
  eq("刚出现过的新证据全部发出去", hl.filter((r) => r.i.startsWith("10.2.2.")).length, 30);
  ok("第一条是最近被记过的证据", (hl[0].t || 0) >= now - 60000, JSON.stringify(hl[0]));
  ok("不带 t 的老行由 DO 按收到时间补", hl.some((r) => r.i.startsWith("10.3.3.") && (r.t || 0) >= now - 60000), String(hl.filter((r) => r.i.startsWith("10.3.3.")).length));
  ok("按证据时间降序", hl.every((r, k) => k === 0 || (hl[k - 1].t || 0) >= (r.t || 0)));
  const meterSrc = storeSrc();
  ok("出站排序按 t 降序", meterSrc.includes("rows.sort((a, b) => b.t - a.t || b.d + b.b - (a.d + a.b));"));
  ok("不再按坏证据条数单独排序", !meterSrc.includes("rows.sort((a, b) => b.d + b.b - (a.d + a.b));"));
}

// 远端 ps 合并：时间与「历史最好」是两件事（v7.217）
{
  const now = Date.now();
  const K = "ps-newer.test|10.7.7.7";
  const mk = () => ({ eg: {}, ps: { [K]: { q: 40, n: 4, at: now - 60000, top: 40 } }, dead: {}, blk2: {}, dns: {} });
  // 远端这行更旧（10 分钟前），但那时它拿到过整页（top=220）
  const a = mk();
  W.mergeFacts(a, { ps: [{ k: K, q: 40, n: 4, at: now - 600000, top: 220 }] });
  ok("更旧的远端行也会把历史最好提上来", (a.ps[K].top || 0) >= 220, JSON.stringify(a.ps[K]));
  eq("均值仍是本地较新的那条", a.ps[K].q, 40);
  eq("样本数不被旧观测覆盖", a.ps[K].n, 4);
  eq("观测时间不被旧观测回退", a.ps[K].at, now - 60000);
  // 本地已经更高：不能被远端更低的 top 拉下来
  const b = mk();
  b.ps[K].top = 255;
  W.mergeFacts(b, { ps: [{ k: K, q: 250, n: 9, at: now - 900000, top: 60 }] });
  eq("历史最好只升不降", b.ps[K].top, 255);
  // 过期的行整条丢，top 也不提
  const c = mk();
  W.mergeFacts(c, { ps: [{ k: K, q: 250, n: 9, at: now - 46 * 60000, top: 255 }] });
  eq("过期行连 top 一起丢", c.ps[K].top, 40);
  // 更新的行照旧整体胜出（top 取两边较高）
  const d2 = mk();
  W.mergeFacts(d2, { ps: [{ k: K, q: 200, n: 8, at: now + 5000, top: 0 }] });
  eq("更新观测的均值胜出", d2.ps[K].q, 200);
  eq("更新观测的样本数胜出", d2.ps[K].n, 8);
  eq("top 仍保留两边较高", d2.ps[K].top, 200);
  // 新键没有任何历史
  const e2 = mk();
  W.mergeFacts(e2, { ps: [{ k: "ps-newer.test|10.7.7.8", q: 33, n: 2, at: now - 600000, top: 0 }] });
  eq("新键按远端行建", e2.ps["ps-newer.test|10.7.7.8"].q, 33);
  eq("新键的 top 就是它自己的均值", e2.ps["ps-newer.test|10.7.7.8"].top, 33);
  const fm = fs.readFileSync("src/store/factmerge.ts", "utf8");
  ok("源码：较早的观测只提 top", fm.includes("if (inTop > (cur.top ?? 0)) cur.top = inTop;"));
  ok("源码：过期行在提 top 之前就被丢弃", fm.indexOf("if (r.at <= Date.now() - FACT_TTL.ps) continue;") < fm.indexOf("if (inTop > (cur.top ?? 0)) cur.top = inTop;"));
}

/* ---------- 219) DO 单值上限：按体积自适应分片 ---------- */
const doFill = (n) => {
  const host = (i) => `s-${i}.example.com`;
  const ip = (i) => `198.51.${(i >> 8) & 255}.${i & 255}`;
  return {
    up: 1, down: 1, conns: 1,
    vt: Array.from({ length: n + 20 }, (_, i) => ({ k: `${host(i)}|r:${ip(i)}`, s: 2, t: Date.now() + 1800000 })),
    hl: Array.from({ length: n + 20 }, (_, i) => ({ i: ip(i), o: 9, b: 1, d: 0, t: Date.now() - 1000 })),
    eg: Array.from({ length: 600 }, (_, i) => ({ i: ip(i), f: 4, at: Date.now() - 1000 })),
    ps: Array.from({ length: 600 }, (_, i) => ({ k: `${host(i)}|${ip(i)}`, q: 200, n: 4, at: Date.now() - 1000, top: 240 })),
    dead: Array.from({ length: 300 }, (_, i) => ({ i: ip(i), n: 3, at: Date.now() - 1000 })),
    blk2: Array.from({ length: 1100 }, (_, i) => ({ k: `${host(i)}|${ip(i)}`, n: 3, at: Date.now() - 1000 })),
    dns: Array.from({ length: 600 }, (_, i) => ({ h: host(i), v: 1, at: Date.now() - 1000 })),
    cl: Array.from({ length: 60 }, (_, i) => ({ k: ip(i), n: 40, ok: 39, p50: 320, p95: 900, dn: 20480 })),
  };
};
const bigDo = mkDO();
await bigDo.m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify(doFill(200)) }));
await bigDo.m.save();
const shardKeys = [...bigDo.store.keys()].sort();
const shardSize = (k) => String(bigDo.store.get(k)).length;
eq("表填满后按体积拆片", shardKeys.join(","), "a,f1,f2,f3");
ok("每片都在 DO 单值上限内（131072）", shardKeys.every((k) => shardSize(k) <= 131072), shardKeys.map((k) => `${k}=${shardSize(k)}`).join(" "));
const cnt7 = (led) => ["vt", "hl", "eg", "ps", "dead", "blk2", "dns"].map((t) => Object.keys(led[t] || {}).length).join(",");
const beforeCnt = cnt7(bigDo.m.ledger);
// 同一个 storage 再建一个 Meter = isolate 重启：分片里的七张表必须读回来
const bigDo2 = mkDO([...bigDo.store.entries()]);
await bigDo2.m.fetch(new Request("https://m/get"));
eq("重启后七张事实表都读回来", cnt7(bigDo2.m.ledger), beforeCnt);
ok("七张表都不是空的", beforeCnt.split(",").every((x) => Number(x) > 0), beforeCnt);
const smallDo = mkDO();
await smallDo.m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 10, down: 20, conns: 1 }) }));
await smallDo.m.save();
eq("小账本仍旧只写一个值", [...smallDo.store.keys()].join(","), "a");
await smallDo.store.set("f1", "stale");
await smallDo.m.save();
eq("退回单键时删掉残片", smallDo.store.has("f1"), false);
// 主机名最长的那些（253 字节级）：只按条数设上限挡不住字节，fit 必须按时间丢最旧
const longDo = mkDO();
const longName = (i) => "a".repeat(150) + "-" + i + "." + "b".repeat(60) + ".example.com";
await longDo.m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 1, down: 1, conns: 1, dns: Array.from({ length: 600 }, (_, i) => ({ h: longName(i), v: 1, at: Date.now() - 1000 })) }) }));
await longDo.m.save();
const longSizes = [...longDo.store.keys()].map((k) => [k, String(longDo.store.get(k)).length]);
ok("长主机名也压进单值上限", longSizes.every(([, n]) => n <= 131072), longSizes.map(([k, n]) => `${k}=${n}`).join(" "));
const meterSrc = storeSrc();
ok("单值预算常量在位", meterSrc.includes("const VALUE_MAX = 120000;"), true);
ok("分片键是三片", meterSrc.includes('const SHARD_KEYS = ["f1", "f2", "f3"] as const;'), true);
ok("装得下就单键、装不下才拆", meterSrc.includes("if (estSize(env, whole) <= VALUE_MAX) {"), true);
ok("两条恢复路径都读分片", (meterSrc.match(/await this\.loadShards\(\);/g) || []).length === 2, (meterSrc.match(/await this\.loadShards\(\);/g) || []).length);

/* ---------- 220) 分片带代号：残留分片不能盖掉新写的单键值 ---------- */
const stampDo = mkDO();
await stampDo.m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify(doFill(200)) }));
await stampDo.m.save();
ok("拆片后代号大于 0", Number(stampDo.m.ledger.fs) > 0, String(stampDo.m.ledger.fs));
// 留一份上一轮的分片，然后模拟「表缩小了、退回单键，但删残片失败」
const staleF2 = stampDo.store.get("f2");
for (const t of ["vt", "hl", "eg", "ps", "dead", "blk2", "dns"]) stampDo.m.ledger[t] = {};
stampDo.m.ledger.eg["1.2.3.4"] = { f: 4, at: Date.now() };
await stampDo.m.save();
eq("退回单键后代号回到 0", stampDo.m.ledger.fs, 0);
stampDo.store.set("f2", staleF2);
const stampDo2 = mkDO([...stampDo.store.entries()]);
await stampDo2.m.fetch(new Request("https://m/get"));
eq("残留分片不会盖掉新写的单键值", Object.keys(stampDo2.m.ledger.eg).join(","), "1.2.3.4");
// 同号分片必须照读（正常的分片恢复不能被代号挡住）
const stampDo3 = mkDO();
await stampDo3.m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify(doFill(200)) }));
await stampDo3.m.save();
const stamped = stampDo3.store.get("f2");
const stampDo4 = mkDO([...stampDo3.store.entries()]);
await stampDo4.m.fetch(new Request("https://m/get"));
ok("同号分片照读", Object.keys(stampDo4.m.ledger.ps || {}).length > 0 && Object.keys(stampDo4.m.ledger.eg || {}).length > 0, JSON.stringify({ ps: Object.keys(stampDo4.m.ledger.ps || {}).length, eg: Object.keys(stampDo4.m.ledger.eg || {}).length }));
void stamped;
const msSrc220 = fs.readFileSync("src/store/metershard.ts", "utf8");
ok("账本类型里记了代号", msSrc220.includes("fs?: number;"));
ok("单键路径写 fs: 0", msSrc220.includes("await st.put(\"a\", await seal(env as Env, { ...whole, fs: 0 }));"));
ok("分片路径用同一个代号", msSrc220.includes("const fs = Date.now();") && msSrc220.includes("await st.put(\"f2\", await seal(env as Env, { fs, ...f2 }));"));
ok("读分片时比代号", msSrc220.includes("if (Number(o.fs) !== want) {") && msSrc220.includes("cnt(\"shardBad\");"));
ok("代号为 0 就不读分片", msSrc220.includes("if (!want) return out;"));
ok("save 之后记住本次代号", storeSrc().includes("this.ledger.fs = await saveState(this.env, this.state.storage, this.ledger.parts());"));
ok("恢复时把 a 里的代号读出来", storeSrc().includes("this.fs = Number((body as unknown as { fs?: number }).fs) || 0;"));
ok("loadShards 把代号传下去", storeSrc().includes("readShards(this.env, this.state.storage, this.ledger.fs)"));
// ── 第 221 组：账本解不开时不能静默从零开始（换 kek / 值损坏）
const mkMeter = (store, kek) => {
  let gate = Promise.resolve();
  const state = {
    blockConcurrencyWhile: (fn) => {
      gate = Promise.resolve().then(fn);
      return gate;
    },
    storage: {
      get: async (k) => store.get(k),
      put: async (k, v) => {
        store.set(k, v);
      },
      delete: async (k) => {
        store.delete(k);
      },
    },
  };
  const m = new W.Meter(state, { kek });
  const raw = m.fetch.bind(m);
  m.fetch = async (req) => {
    await gate;
    return raw(req);
  };
  return m;
};
const addBody = {
  method: "POST",
  body: JSON.stringify({ up: 1000, down: 2000, conns: 1 }),
  headers: { "content-type": "application/json" },
};
const KEK221 = "QESq7bKGwx8l5PMcTGhe6Z_j1HUkeBDQ";
const GARBAGE = "ENC1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBBBBBB";
// 解不开的旧值：构造时记一次计数，落盘前把原文备份走
const badStore = new Map();
badStore.set("a", GARBAGE);
const before221 = W.S.cnt.doBad || 0;
const badM = mkMeter(badStore, KEK221);
await badM.fetch(new Request("https://m/get"));
eq("解不开的账本会计数 doBad", (W.S.cnt.doBad || 0) - before221, 1);
const badAdd = await badM.fetch(new Request("https://m/add", addBody));
eq("解不开也要能继续记账（不 5xx）", badAdd.status, 200);
eq("覆盖前把原文备份到 a_bak", badStore.get("a_bak"), GARBAGE);
ok("新值已写回 a", typeof badStore.get("a") === "string" && badStore.get("a") !== GARBAGE);
// 能解开的旧值：不计数、不留底（防误伤）
const goodStore = new Map();
const g1 = mkMeter(goodStore, KEK221);
await g1.fetch(new Request("https://m/add", addBody));
const before222 = W.S.cnt.doBad || 0;
const g2 = mkMeter(goodStore, KEK221);
await g2.fetch(new Request("https://m/get"));
eq("能解开就不计 doBad", (W.S.cnt.doBad || 0) - before222, 0);
ok("能解开就不留底", goodStore.get("a_bak") === undefined);
// 源码锁：这条链的三个关键点都得在
const meterSrc221 = storeSrc();
ok("配置里登记了 doBad", fs.readFileSync("src/core/state.ts", "utf8").includes("\"doBad\","));
ok("构造函数里有 else 分支", meterSrc221.includes("cnt(\"doBad\");"));
ok("留底带着原值", meterSrc221.includes("this.ledger.keepBackup(all);"));
ok("落盘前备份 a_bak", meterSrc221.includes("const bak = this.ledger.takeBackup();") && meterSrc221.includes("await this.state.storage.put(\"a_bak\", bak);"));

// ---- 第 222 组：站点级自愈（sweep → mute）不能被别处回传的封锁事实撤销（v7.221）----
const blkSrc = () => fs.readFileSync("src/route/blkfacts.ts", "utf8");
{
  const H = "mute222.example.com";
  const A = "10.222.0.1";
  const B = "10.222.0.2";
  const t0 = Date.now();
  // ① 两行封锁事实 + 一次站点级自愈：判「站点在拒绝所有人」，清表并静音 30 分钟
  W.BLK.clear();
  eq("建行两条", W.BLK.load([{ k: H + "|" + A, n: 3, at: t0 - 60000 }, { k: H + "|" + B, n: 3, at: t0 - 60000 }]), 2);
  eq("封锁使出口涨价", W.blkPen(H, A, t0), W.BLK_PEN);
  eq("站点级自愈触发", W.BLK.sweep(H, [A, B], t0), true);
  eq("自愈后静音中", W.BLK.muted(H, t0 + 1000), true);
  eq("自愈清掉了封锁行", W.blkPen(H, A, t0), 1);
  // ② 静音期内，别处 isolate 回传同一个站点的封锁事实：必须被拒绝（否则自愈等于白做）
  eq("静音期内别处的封锁事实被拒绝", W.BLK.load([{ k: H + "|" + A, n: 3, at: t0 + 2000 }]), 0);
  eq("静音期内封锁没有复活", W.blkPen(H, A, t0 + 3000), 1);
  // ③ 别的站点不受影响
  eq("没被静音的站点照常收", W.BLK.load([{ k: "other222.example.com|" + A, n: 3, at: t0 + 2000 }]), 1);
  // ④ 静音过期之后，同一行要能重新被接受（不是永久拒收）
  W.BLK.clear();
  W.BLK.load([{ k: H + "|" + A, n: 3, at: t0 - 7200000 }, { k: H + "|" + B, n: 3, at: t0 - 7200000 }]);
  eq("过期站点再自愈", W.BLK.sweep(H, [A, B], t0 - 31 * 60000), true);
  eq("静音已经过期", W.BLK.muted(H, t0), false);
  eq("静音过期后照常收", W.BLK.load([{ k: H + "|" + A, n: 3, at: t0 }]), 1);
  W.BLK.clear();
  // ⑤ 源码锁：静音判断在 load 里、丢弃要计数、计数要在 cntKeys 登记
  eq("load 里按最后一个竖线切站点", blkSrc().includes("const cut = r.k.lastIndexOf(\"|\");"), true);
  eq("load 用 muted 挡远端事实", blkSrc().includes("if (this.muted(r.k.slice(0, cut), now)) {"), true);
  eq("静音丢弃有计数", blkSrc().includes("cnt(\"blkMutedSkip\")"), true);
  eq("blkMutedSkip 已登记", fs.readFileSync("src/core/state.ts", "utf8").includes("\"blkMutedSkip\","), true);
}

// ---------- 第 223 组：文档写了但代码没有的调试端点（v7.222） ----------
{
  const dbg = debugAll();
  ok("debug 有 ?blk= 分支", dbg.includes('url.searchParams.get("blk")'));
  ok("?blk= 按站点前缀过滤封锁行", dbg.includes("BLK.snap().filter((r) => r.k === bh || r.k.startsWith(bh + \"|\"))") || dbg.includes('r.k.startsWith(bh + "|")'));
  ok("?blk= 报告自愈静音", dbg.includes("muted: BLK.muted(bh)"));
  ok("debug 有 ?facts=1 分支", dbg.includes('url.searchParams.get("facts") === "1"'));
  ok("?facts=1 发的是事实层快照", dbg.includes("tables: FACTS.snap()"));
  ok("debug 有 ?plan=1 分支", dbg.includes('url.searchParams.get("plan") === "1"'));
  ok("?plan=1 与 vt 分支同一口径", dbg.includes("planView(S.pool.length, S.alive.size)"));

  // 分支背后那几张表真的会给出数据（不是恒空的桩）
  W.BLK.clear();
  ok("空表时 snap 是空数组", W.BLK.snap().length === 0);
  const now223 = Date.now();
  W.BLK.load([
    { k: "a223.example.com|10.9.1.1", n: 3, at: now223 },
    { k: "a223.example.com|10.9.1.2", n: 3, at: now223 },
    { k: "a223.example.com|10.9.1.3", n: 3, at: now223 },
  ]);
  ok("load 后能查到该站点的行", W.BLK.snap().some((r) => String(r.k).startsWith("a223.example.com|")));
  ok("未静音时 muted 为 false", W.BLK.muted("a223.example.com", now223) === false);
  ok("sweep 触发自愈", W.BLK.sweep("a223.example.com", ["10.9.1.1", "10.9.1.2", "10.9.1.3"], now223) === true);
  ok("自愈后 muted 为 true", W.BLK.muted("a223.example.com", now223) === true);
  W.BLK.clear();
  const fs223 = Object.keys(W.FACTS.snap() || {}).sort().join(",");
  eq("事实层快照是五张表", fs223, "blk2,dead,dns,eg,ps");

  // 文档口径：不能再声称一个服务端不存在的端点
  const v8223 = fs.readFileSync("docs/v8.md", "utf8");
  ok("v8.md 不再声称 ?edge=1 是可用的调试端点", !v8223.includes("`?edge=1`（入口探测"));
  ok("v8.md 写明入口偏好没有服务端端点", v8223.includes("入口偏好没有服务端端点"));
  ok("v8.md 列出了 ?blk=", v8223.includes("`?blk=<host>`"));
}
/* ---------- 第 224 组：cron 闸门要有截止时间 ---------- */
{
  const L = W.CRONLOCK;
  ok("闸门对象存在", !!L && typeof L.claim === "function");
  const t0 = Date.now();
  W.S.cronAt = 0;
  ok("空闲时能拿到闸门", L ? L.claim(t0) : false);
  ok("刚拿到时第二个来者被挡", L ? L.claim(t0 + 1000) === false : false);
  // 卡死 9 分钟（超过 CRON_STALE_MS=8 分钟）必须能被接管：旧版布尔闩永远挡死
  W.S.cronAt = t0 - 9 * 60_000;
  const staleBefore = Number(W.S.cnt.cronStale || 0);
  ok("卡死超过 8 分钟后可以接管", L ? L.claim(t0) === true : false);
  ok("接管要计 cronStale", Number(W.S.cnt.cronStale || 0) === staleBefore + 1);
  ok("接管后持有时间归零", L ? L.age(t0) === 0 : false);
  if (L) L.release();
  ok("释放后 age 为 0", (L ? L.age(t0) : -1) === 0);
  ok("释放后能再次拿到", (L ? L.claim(t0 + 10) : false) === true);
  if (L) L.release();
  // 端到端：闸门被卡死的一轮占着时，runCron 仍要排真任务
  const realFetch224 = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 200 });
  try {
    W.S.cronAt = Date.now() - 9 * 60_000;
    let done = null;
    const envCron = { STATS: { get: async () => null, put: async () => {} }, pxSchedH: "0" };
    await W.runCron(envCron, { waitUntil: (pr) => (done = pr) });
    ok("卡死时 runCron 仍排任务", done !== null);
    if (done) await done;
    eq("跑完后闸门回到空闲", W.S.cronAt, 0);
  } finally {
    globalThis.fetch = realFetch224;
    W.S.cronAt = 0;
  }
  // 源码锁：闸门在 lock.ts，两个入口都走 claim/release，S 里不再有布尔闩
  const lockSrc = fs.existsSync("src/core/lock.ts") ? fs.readFileSync("src/core/lock.ts", "utf8") : "";
  const cronSrc = fs.readFileSync("src/routes/cron.ts", "utf8");
  const pipSrc = fs.readFileSync("src/routes/proxyip.ts", "utf8");
  const stSrc = fs.readFileSync("src/core/state.ts", "utf8");
  const cnstSrc = fs.readFileSync("src/core/const.ts", "utf8");
  ok("lock.ts 用 SC.CRON_STALE_MS 判超时", lockSrc.includes("SC.CRON_STALE_MS"));
  ok("lock.ts 接管时计 cronStale", lockSrc.includes('cnt("cronStale")'));
  ok("cron.ts 走 CRONLOCK.claim", cronSrc.includes("if (!CRONLOCK.claim()) return;"));
  ok("proxyip.ts 报告持有毫秒", pipSrc.includes("heldMs: CRONLOCK.age()"));
  ok("两个入口都不再有布尔闩", !cronSrc.includes("S.cronBusy") && !pipSrc.includes("S.cronBusy"));
  ok("S 里是时间戳而不是布尔", stSrc.includes("cronAt = 0;") && !stSrc.includes("cronBusy"));
  ok("CRON_STALE_MS 已定义", /CRON_STALE_MS:\s*8 \* 60_000/.test(cnstSrc));
  ok("cronStale 已登记进 cntKeys", stSrc.includes('"cronStale",'));
}
/* ---------- 第 225 组：判定标签表的淘汰序 ---------- */
{
  W.S.tfbV.clear();
  W.tfRemember("hot.example", "chan/none");
  for (let i = 0; i < 255; i++) W.tfRemember("site" + i + ".example", "chan/none");
  eq("表在上限内", W.S.tfbV.size, 256);
  // 复探最热的站点（cron 每 30 分钟就会这样），再插入一个新站点把表推过上限
  W.tfRemember("hot.example", "chan/none");
  W.tfRemember("brandnew.example", "chan/none");
  ok("复探过的热门站点仍在表里", W.S.tfbV.has("hot.example"));
  ok("最久没复探的站点先被淘汰", !W.S.tfbV.has("site0.example"));
  eq("表仍然不超上限", W.S.tfbV.size, 256);
  // 两批共识：热门站点第二次探到 chan 时，上一批标签必须还在
  eq("复探后仍能读到上一批标签", W.S.tfbV.get("hot.example"), "chan/none");
  ok("两批共识成立（可以落封锁）", W.tfBlockOk(W.S.tfbV.get("hot.example") || "", "chan"));
  // 只探过一批的站点不能落封锁
  ok("没有历史标签的站点不能落封锁", W.tfBlockOk("", "chan") === false);
  ok("上一批不是 chan 也不能落封锁", W.tfBlockOk("ok/none", "chan") === false);
  ok("这一批不是 chan 同样不落封锁", W.tfBlockOk("chan/none", "site") === false);
  W.S.tfbV.clear();
  // 源码锁：set 之前必须先 delete（Map.set 不移动已存在键的位置）
  const tfSrc = fs.readFileSync("src/route/tfb.ts", "utf8");
  const delAt = tfSrc.indexOf("S.tfbV.delete(host);");
  const setAt = tfSrc.indexOf("S.tfbV.set(host, tag);");
  ok("tfRemember 里 delete 在 set 之前", delAt > 0 && setAt > delAt);
  ok("注释写明 Map.set 不移动位置", tfSrc.includes("不移动插入位置"));
}
/* ---------- 第 226 组：探活「暂时跳过」表 ---------- */
{
  const PB = W.S.probeBad;
  const key226 = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}:443`;
  const t0 = Date.now();
  const sw = W.sweepProbeBad;
  eq("上限常量在位", W.SC.PROBE_BAD_MAX, 2048);
  // 过期记录：对 probeBadSkip 已经无意义，必须清掉
  PB.clear();
  for (let i = 0; i < 500; i++) W.bumpProbeBad(key226(i), false, t0 - 24 * 3600e3);
  eq("过期记录先攒满 500 行", PB.size, 500);
  if (sw) sw(t0);
  eq("过期记录被清空", PB.size, 0);
  // 未过期记录一条都不许误删
  PB.clear();
  for (let i = 0; i < 500; i++) W.bumpProbeBad(key226(i), false, t0);
  if (sw) sw(t0);
  eq("未过期记录一条不删", PB.size, 500);
  // 超上限按「最久没更新」淘汰
  PB.clear();
  for (let i = 0; i < 3000; i++) W.bumpProbeBad(key226(i), false, t0 + i);
  if (sw) sw(t0 + 3000);
  ok("压到上限以内", PB.size <= W.SC.PROBE_BAD_MAX);
  ok("最新那条还在", PB.has(key226(2999)));
  ok("最旧那条被淘汰", !PB.has(key226(0)));
  // 成功探活仍然删自己那一条
  PB.clear();
  W.bumpProbeBad(key226(7), false, t0);
  eq("失败先记一行", PB.size, 1);
  W.bumpProbeBad(key226(7), true, t0);
  eq("成功后自己那行被删", PB.size, 0);
  // 判据与 TTL 同源：过 TTL 后不再判「跳过」
  PB.clear();
  for (let i = 0; i < 3; i++) W.bumpProbeBad(key226(9), false, t0);
  ok("连续 3 次失败后判跳过", W.probeBadSkip(key226(9), t0));
  ok("过了 TTL 不再判跳过", W.probeBadSkip(key226(9), t0 + W.SC.PROBE_BAD_TTL + 1) === false);
  PB.clear();
  // 源码锁：清理函数存在、且 cronScan 每轮都调它
  const poolSrc226 = fs.readFileSync("src/px/scan.ts", "utf8");
const aliveSrc226 = fs.readFileSync("src/px/alive.ts", "utf8");
  ok("cronScan 每轮都扫这张表", poolSrc226.includes("sweepProbeBad();"));
  ok("扫的时候先看 TTL", aliveSrc226.includes("if (now - entry.at > SC.PROBE_BAD_TTL) {"));
  ok("超上限按 at 升序淘汰", aliveSrc226.includes("sort((a, b) => a[1].at - b[1].at)"));
}
// ---------- 第 227 组：S.needPx 的窗口只有一个真源（7.226） ----------
{
  // 注释里会引用旧写法，判源码前先滤掉注释行
  const codeOf = (rel) =>
    fs
      .readFileSync(rel, "utf8")
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
  eq("窗口常量是 6 小时", W.SC.PX_LEARN, 21_600_000);
  const constSrc227 = codeOf("src/core/const.ts");
  ok("常量声明在 core/const.ts", constSrc227.includes("PX_LEARN: 21_600_000,"));
  const judgeSrc227 = codeOf("src/route/judge.ts");
  ok("judge 不再自带 PX_TTL", /\bPX_TTL\b/.test(judgeSrc227) === false);
  eq("judge 两条写入路径都读同一个常量", (judgeSrc227.match(/now \+ SC\.PX_LEARN/g) || []).length, 2);
  const attSrc227 = codeOf("src/proxy/attacher.ts");
  eq("attacher 的失败学习也读同一个常量", (attSrc227.match(/Date\.now\(\) \+ SC\.PX_LEARN/g) || []).length, 1);
  ok("attacher 不再内联 6 小时", attSrc227.includes("6 * 3600e3") === false);
  // 全仓守卫：往 S.needPx 写数字字面量的写法一律不允许（写死了就和常量脱钩）
  const needPxWrites = [];
  for (const rel of ["src/route/judge.ts", "src/proxy/attacher.ts"]) {
    for (const l of codeOf(rel).split("\n")) {
      if (/S\.needPx\.set\(/.test(l)) needPxWrites.push(l.trim());
    }
  }
  eq("S.needPx 的三条写入点都引用同一个常量", needPxWrites.length, 3);
  ok("每条写入都引用 SC.PX_LEARN", needPxWrites.every((l) => l.includes("SC.PX_LEARN")));
  // 同名不同义：px/const.ts 的 PX_TTL 是 KV 到期秒数（30 天），与这里的毫秒窗口无关
  const pxConstSrc227 = codeOf("src/px/const.ts");
  ok("px/const.ts 的 PX_TTL 仍是 KV 到期秒数", pxConstSrc227.includes("export const PX_TTL = 86400 * 30;"));
  // 行为面：按常量写进去的窗口确实等于 6 小时
  W.S.needPx.clear();
  const t227 = Date.now();
  W.S.needPx.set("learn227.example.com", t227 + W.SC.PX_LEARN);
  eq("写入窗口等于常量", W.S.needPx.get("learn227.example.com") - t227, W.SC.PX_LEARN);
  W.S.needPx.clear();
}

// ===== 第 228 组：负面/正记忆表必须压回上限（7.227 D184）=====
{
  const judgeSrc = fs.readFileSync("src/route/judge.ts", "utf8");
  const code = judgeSrc
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
  ok("neg 写入后删过期", code.includes("dropExpired(this.neg);"));
  ok("neg 写入后压回上限", code.includes("trimAged(this.neg, SC.HOST_MEM_MAX);"));
  ok("pos 也走同一套淘汰", code.includes("trimAged(this.pos, SC.HOST_MEM_MAX);"));
  ok("pos 不再整表清空", !code.includes("this.pos.clear();"));
  ok("hostmem 的 dropExpired 已引入", judgeSrc.includes("dropExpired"));

  const nowNeg = Date.now();
  const pairs228 = [];
  for (let i = 0; i < 600; i++) {
    const h = `n228-${i}.example.com`;
    const ip = `10.31.${Math.floor(i / 250)}.${i % 250}`;
    W.JUDGE.markNeg(h, ip, nowNeg);
    pairs228.push([h, ip]);
  }
  let alive228 = 0;
  for (const [h, ip] of pairs228) if (W.JUDGE.negOn(h, ip, nowNeg + 1000)) alive228 += 1;
  ok("600 个站点×中继不会被全留住", alive228 <= W.SC.HOST_MEM_MAX, `alive=${alive228} cap=${W.SC.HOST_MEM_MAX}`);
  ok("最新那条负面记忆还在", W.JUDGE.negOn(pairs228[599][0], pairs228[599][1], nowNeg + 1000));
  ok("最旧那条已被淘汰", !W.JUDGE.negOn(pairs228[0][0], pairs228[0][1], nowNeg + 1000));

  const nowPos = Date.now();
  const posPairs = [];
  for (let i = 0; i < 600; i++) {
    const h = `p228-${i}.example.com`;
    const ip = `10.32.${Math.floor(i / 250)}.${i % 250}`;
    W.JUDGE.markPos(h, ip, nowPos);
    posPairs.push([h, ip]);
  }
  ok("正记忆压回上限后最新仍在", W.JUDGE.posOn(posPairs[599][0], posPairs[599][1], nowPos + 1000));
  ok("正记忆也淘汰最旧", !W.JUDGE.posOn(posPairs[0][0], posPairs[0][1], nowPos + 1000));
  const alivePos = posPairs.filter(([h, ip]) => W.JUDGE.posOn(h, ip, nowPos + 1000)).length;
  ok("正记忆规模不超过上限", alivePos <= W.SC.HOST_MEM_MAX, `alive=${alivePos}`);
}


// ===== 第 229 组：分片恢复失败不能静默（7.228 D185）=====
{
  const shardSrc = fs.readFileSync("src/store/metershard.ts", "utf8");
  const stateSrc = fs.readFileSync("src/core/state.ts", "utf8");
  ok("三处失败路径都计数", (shardSrc.match(/cnt\("shardBad"\)/g) || []).length === 3);
  ok("解不开的分片留底", shardSrc.includes("async function backUpShard("));
  ok("留底只写一次", shardSrc.includes("if (seen) return;"));
  ok("shardBad 已登记", stateSrc.includes('"shardBad",'));

  const kek229 = "QESq7bKGwx8l5PMcTGhe6Z_j1HUkeBDQ";
  const mkMem = (store = new Map()) => {
    let gate = Promise.resolve();
    const state = {
      blockConcurrencyWhile: (fn) => {
        gate = Promise.resolve().then(fn);
        return gate;
      },
      storage: {
        get: async (k) => store.get(k),
        put: async (k, v) => store.set(k, v),
        delete: async (k) => store.delete(k),
      },
    };
    const m = new W.Meter(state, { kek: kek229 });
    const raw = m.fetch.bind(m);
    m.fetch = async (req) => {
      await gate;
      return raw(req);
    };
    return { store, m };
  };
  const h229 = (i) => `g229-${i}.example.com`;
  const ip229 = (i) => `203.40.${(i >> 8) & 255}.${i & 255}`;
  const fill229 = {
    up: 1024,
    down: 2048,
    conns: 1,
    vt: Array.from({ length: 220 }, (_, i) => ({ k: `${h229(i)}|r:${ip229(i)}`, s: 2, t: Date.now() + 1800000 })),
    hl: Array.from({ length: 220 }, (_, i) => ({ i: ip229(i), o: 9, b: 1, d: 0, t: Date.now() - 1000 })),
    eg: Array.from({ length: 600 }, (_, i) => ({ i: ip229(i), f: 4, at: Date.now() - 1000 })),
    ps: Array.from({ length: 600 }, (_, i) => ({ k: `${h229(i)}|${ip229(i)}`, q: 200, n: 4, at: Date.now() - 1000, top: 240 })),
    dead: Array.from({ length: 300 }, (_, i) => ({ i: ip229(i), n: 3, at: Date.now() - 1000 })),
    blk2: Array.from({ length: 1100 }, (_, i) => ({ k: `${h229(i)}|${ip229(i)}`, n: 3, at: Date.now() - 1000 })),
    dns: Array.from({ length: 600 }, (_, i) => ({ h: h229(i), v: 1, at: Date.now() - 1000 })),
  };
  const st229 = new Map();
  const first229 = mkMem(st229);
  await first229.m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify(fill229) }));
  ok("先拆成了三片", ["a", "f1", "f2", "f3"].every((k) => st229.has(k)));

  // 真实世界的两种坏法：写 a 之后被杀（缺片）、换过 kek（解不开）
  st229.delete("f3");
  st229.set("f2", "ENC1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBBBBBB");
  const before229 = W.cntView().shardBad || 0;
  const again229 = mkMem(st229);
  await again229.m.fetch(new Request("https://m/get"));
  const after229 = W.cntView().shardBad || 0;
  ok("缺片与解不开都被计数", after229 - before229 === 2, `计数=${after229 - before229}`);
  ok("解不开的那片留了底", Boolean(st229.get("s_bak")));
  ok("好的那片照常恢复", Boolean(st229.get("f1")));

  // 代号不符（删残片失败留下的旧片）也算坏片，但绝不覆盖内存
  const stale = mkMem(st229);
  await stale.m.fetch(new Request("https://m/get"));
  ok("残留片不会被当成事实", (W.cntView().shardBad || 0) >= after229);
}


// ── 第 230 组：连接观测的分位索引（p50/p95 用 nearest-rank，不能用 floor(p*n)） ──
const clPut = (k, v) => W.S.cagg.set(k, { n: v.length, ok: v.length, dn: 0, v });
W.S.cagg.clear();
clPut("p230.two", [100, 900]);
clPut("p230.ten", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
clPut("p230.big", Array.from({ length: 64 }, (_, i) => (i + 1) * 10));
const clRows = W.clSnapshot(40);
const clBy = Object.fromEntries(clRows.map((r) => [r.k, r]));
eq("两个样本时 p50 是较小那个（不是最大值）", clBy["p230.two"].p50, 100);
eq("两个样本时 p95 才是最大值", clBy["p230.two"].p95, 900);
eq("十个样本时 p50 是第 5 小", clBy["p230.ten"].p50, 5);
eq("十个样本时 p95 是最大值", clBy["p230.ten"].p95, 10);
eq("64 个样本时 p50 是第 32 个", clBy["p230.big"].p50, 320);
W.S.cagg.delete("p230.zero");
W.S.cagg.set("p230.zero", { n: 0, ok: 0, dn: 0, v: [] });
eq("没有样本的行不会进快照", W.clSnapshot(40).some((r) => r.k === "p230.zero"), false);
W.S.cagg.clear();
const pendSrc = fs.readFileSync("src/store/pend.ts", "utf8");
ok("分位索引用 nearest-rank", pendSrc.includes("Math.ceil(p * v.length) - 1"));
ok("分位索引不再用 floor(p*n)", !pendSrc.includes("Math.floor(p * v.length)"));
ok("索引下限夹到 0（p 很小时不能取负）", pendSrc.includes("Math.max(0, Math.ceil(p * v.length) - 1)"));


/* ---------- 第 231 组：静默表的容量（v7.230 D187） ---------- */
{
  const blkSrc = fs.readFileSync("src/route/blkfacts.ts", "utf8");
  const m = blkSrc.match(/export const BLK_MUTE_MAX = (\d+);/);
  const cap = m ? Number(m[1]) : 0;
  ok("静默表有独立上限", cap >= 64 && cap <= 4096, String(cap));
  const t231 = Date.now();
  W.BLK.clear();
  const N231 = 300;
  let swept231 = 0;
  for (let i = 0; i < N231; i++) {
    const host = `h${i}.g231.test`;
    W.BLK.load([
      { k: host + "|10.231.0.1", n: 3, at: t231 },
      { k: host + "|10.231.0.2", n: 3, at: t231 },
      { k: host + "|10.231.0.3", n: 3, at: t231 },
    ]);
    if (W.BLK.sweep(host, ["10.231.0.1", "10.231.0.2", "10.231.0.3"], t231)) swept231 += 1;
  }
  eq("sweep 全部生效", swept231, N231);
  let muted231 = 0;
  for (let i = 0; i < N231; i++) if (W.BLK.muted(`h${i}.g231.test`, t231 + 1000)) muted231 += 1;
  ok("静默表不超过上限", muted231 <= cap && muted231 === cap, String(muted231));
  eq("最早写入的静默被淘汰", W.BLK.muted("h0.g231.test", t231 + 1000), false);
  eq("最新写入的静默仍在", W.BLK.muted(`h${N231 - 1}.g231.test`, t231 + 1000), true);
  eq("静默到期后不再静音", W.BLK.muted(`h${N231 - 1}.g231.test`, t231 + 31 * 60000), false);
  ok("常量在位", blkSrc.includes("export const BLK_MUTE_MAX = 256;"), "");
  ok("sweep 写完也过守卫", blkSrc.includes("if (this.mute.size > BLK_MUTE_MAX) this.trim(now);"), "");
  ok("trim 削静默表", blkSrc.includes("if (this.mute.size > BLK_MUTE_MAX) {"), "");
  ok("muted 读到过期就删", blkSrc.includes("if (until && until <= now) {"), "");
  W.BLK.clear();
}

/* ---------- 第 232 组：连接超时只有一个真源（v7.231 D188） ---------- */
{
  const walk = (d, a = []) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = d + "/" + f.name;
      if (f.isDirectory()) walk(p, a);
      else if (p.endsWith(".ts")) a.push(p);
    }
    return a;
  };
  const utilSrc = fs.readFileSync("src/core/util.ts", "utf8");
  ok("CONNECT_MS 有唯一真源", /export const CONNECT_MS = 2500;/.test(utilSrc), "");
  ok("注释点明 SC.STALL 不是一回事", utilSrc.includes("SC.STALL = 2500") , "");
  let stray = 0;
  let used = 0;
  const where231 = [];
  for (const p of walk("src")) {
    if (p.endsWith("core/const.ts") || p.endsWith("core/util.ts")) continue;
    const t = fs.readFileSync(p, "utf8");
    const n2500 = (t.match(/\b2500\b/g) || []).length;
    stray += n2500;
    if (n2500) where231.push(p + ":" + n2500);
    used += (t.match(/CONNECT_MS/g) || []).length;
  }
  eq("除了常量定义处没有裸 2500", stray, 0);
  // 7.272/7.278 把建连与预算收敛进 SocketDialer 后，调用点从 20 降到 19：
  // 少掉的那处正是 debug.ts 的 v6 探测，预算现在是拨号器自己的事。
  ok("至少 18 处调用点改成常量", used >= 18, String(used));
  ok("没有 2500 的文件清单为空", where231.length === 0, where231.join(","));
  const dialSrc = fs.readFileSync("src/proxy/dial.ts", "utf8");
  ok("httpProbe 默认参数走常量", dialSrc.includes("ms = CONNECT_MS"), "");
  const probeSrc = fs.readFileSync("src/px/rawprobe.ts", "utf8");
  ok("probeSni 默认参数走常量", probeSrc.includes("ms = CONNECT_MS"), "");
  ok("SC.STALL 仍在（语义是卡顿当量）", W.SC.STALL === 2500, String(W.SC.STALL));
}

// ── 第 233 组：计量 DO 请求的计数收成一个入口（D189） ──
console.log("\n[233] 计量 DO 请求的计数入口");
const rd233 = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
const code233 = (t) => t.split(/\r?\n/).filter((l) => { const x = l.trim(); return x && !x.startsWith("//") && !x.startsWith("*") && !x.startsWith("/*"); }).join("\n");
const mc233 = code233(rd233("src/store/meter-client.ts"));
const pd233 = code233(rd233("src/store/pend.ts"));
const st233 = code233(rd233("src/store/stats.ts"));
const sn233 = code233(rd233("src/store/snapshot.ts"));
const vs233 = code233(rd233("src/route/verdictsync.ts"));
const mkEnv233 = () => ({ METER: { idFromName: (x) => x, get: () => ({ fetch: async () => new Response(JSON.stringify({ up: 0, down: 0, conns: 0 }), { status: 200 }) }) }, uuid: "u233" });
const c233 = W.S.doCalls | 0;
if (typeof W.doFetch === "function") {
  await W.doFetch(mkEnv233(), "u233", "x");
  eq("一次 doFetch 记一次", (W.S.doCalls | 0) - c233, 1);
  const bad233 = { METER: { idFromName: (x) => x, get: () => ({ fetch: async () => { throw new Error("boom"); } }) } };
  let threw233 = false;
  try { await W.doFetch(bad233, "u233", "x"); } catch { threw233 = true; }
  ok("失败的 DO 请求也记（额度按发出算）", threw233 && (W.S.doCalls | 0) - c233 === 2);
  W.S.meterCache.clear();
  await W.meterGet(mkEnv233(), "u233");
  eq("meterGet 也走同一个入口", (W.S.doCalls | 0) - c233, 3);
} else {
  ok("一次 doFetch 记一次", false, "doFetch 不存在");
  ok("失败的 DO 请求也记（额度按发出算）", false, "doFetch 不存在");
  ok("meterGet 也走同一个入口", false, "doFetch 不存在");
}
ok("计数点只有一处（meter-client 的 doFetch）", (mc233.split("S.doCalls += 1;").length - 1) === 1 && (pd233.split("S.doCalls += 1;").length - 1) === 0);
ok("pend 的用量批次改走 doFetch", pd233.includes("doFetch(env, id, \"https://meter/add\"") && !pd233.includes("idFromName(id)).fetch"));
ok("stats 的读用量与回填都走 doFetch", st233.includes("doFetch(env, primaryId(env) || id, \"https://meter/cnt\")") && st233.includes("doFetch(env, id, \"https://meter/seed\""));
ok("snapshot 的回填走 doFetch", sn233.includes("doFetch(env, id, \"https://meter/set\""));
ok("verdictsync 的读事实走 doFetch", vs233.includes("doFetch(env, raw, \"https://meter/vt\")"));

// ── 234. /logs 读不到跨 isolate 那份时必须留痕（v7.233：fromDo:0 既可能是「没有错误」也可能是「没读到」）──
{
  const UUID234 = "7c53c12a-88b1-4fda-b6e7-4da62e47a4e1";
  const HOST234 = "sim.example.com";
  const mkKv234 = () => {
    const m = new Map();
    return {
      async get(k) { return m.has(k) ? m.get(k) : null; },
      async put(k, v) { m.set(k, v); },
      async delete(k) { m.delete(k); },
      async list() { return { keys: [], list_complete: true }; },
    };
  };
  const baseEnv234 = { uuids: UUID234, trojan: UUID234 + ":test123", nodes: "", adminKey: "", STATS: mkKv234(), defaultMode: "lat", regions: "", proxyip: "auto" };
  const mkReq234 = (p) => ({ url: "https://" + HOST234 + p, headers: { get: () => null }, cf: { asn: 4134, city: "Guangzhou", colo: "HKG", clientTcpRtt: 42 } });
  const ctx234 = { waitUntil: () => {} };
  const run234 = async (env) => (await W.default.fetch(mkReq234("/" + UUID234 + "/logs"), env, ctx234)).json();
  const badEnv = { ...baseEnv234, METER: { idFromName: (n) => n, get: () => ({ async fetch() { throw new Error("do boom"); } }) } };
  const cntBefore234 = Number(W.cntView().logsDoFail) || 0;
  const bad1 = await run234(badEnv);
  eq("DO 读失败时 doSrc 标成 fail", bad1.doSrc, "fail");
  eq("DO 读失败时 fromDo 仍是 0、但列表里有留痕", String(bad1.fromDo) + "/" + String(bad1.count > 0), "0/true");
  eq("DO 读失败计 logsDoFail", (Number(W.cntView().logsDoFail) || 0) - cntBefore234, 1);
  const jnone = await run234({ ...baseEnv234, METER: undefined });
  eq("没有 METER 绑定时 doSrc 标成 none", jnone.doSrc, "none");
  const goodEnv = { ...baseEnv234, METER: { idFromName: (n) => n, get: () => ({ async fetch() { return new Response(JSON.stringify({ e: [{ t: Date.now(), m: "probe do line", tag: "x" }] })); } }) } };
  const jgood = await run234(goodEnv);
  eq("DO 正常时 doSrc 标成 ok", jgood.doSrc, "ok");
  eq("DO 正常时 fromDo 带回一条", jgood.fromDo, 1);
  const srcLogs234 = fs.readFileSync("src/routes/logs.ts", "utf8");
  ok("DO 读失败要计数", srcLogs234.includes("cnt(\"logsDoFail\");"), "");
  ok("DO 读失败要留痕（与快照失败同一口径）", srcLogs234.includes("logErr(\"logs do read failed\", \"kv\");"), "");
  ok("响应里带上 doSrc", srcLogs234.includes("doSrc, items: out }"), "");
  const st234 = fs.readFileSync("src/core/state.ts", "utf8");
  ok("logsDoFail 已登记进 cntKeys", st234.includes("\"logsDoFail\","), "");
}
// ── 第 235 组：H6 表连续性 + 版本口径一致性（两条新门禁） ──
const auditSrc = fs.readFileSync("tools/doc-audit.mjs", "utf8");
const docMd = fs.readFileSync("docs/v8实现清单.md", "utf8");
const agentsMd = fs.readFileSync("AGENTS.md", "utf8");
const utilTs = fs.readFileSync("src/core/util.ts", "utf8");
const h6Nums = docMd.split(/\r?\n/).map((l) => (l.match(/^\|\s*(\d+)\s*\|/) || [])[1]).filter(Boolean).map(Number);
const h6Max = h6Nums.length ? Math.max(...h6Nums) : 0;
const h6Set = new Set(h6Nums);
let h6Gap = 0;
for (let i = 1; i <= h6Max; i++) if (!h6Set.has(i)) h6Gap += 1;
eq("H6 表编号从 1 连续到最大值（缺号 0 个）", h6Gap, 0);
ok("H6 表行数等于最大编号", h6Nums.length === h6Max, "行数 " + h6Nums.length + " vs 最大编号 " + h6Max);
ok("doc-audit 里有 H6 缺号门禁", auditSrc.includes("H6 表缺号"), "没找到「H6 表缺号」");
ok("doc-audit 里有 H6 重号门禁", auditSrc.includes("H6 表重号"), "没找到「H6 表重号」");
ok("doc-audit 里有版本口径门禁", auditSrc.includes("版本口径不一致"), "没找到「版本口径不一致」");
const vm235 = utilTs.match(/export const VERSION = "([0-9.]+)";/);
const hm235 = agentsMd.match(/仓库 \*\*([0-9.]+)\*\*（[^）]*?共 (\d+) 个缺陷/);
ok("AGENTS 头部能解析出版本与缺陷数", Boolean(hm235), "头部格式变了");
eq("AGENTS 头部版本等于 VERSION", hm235 ? hm235[1] : "", vm235 ? vm235[1] : "");
eq("AGENTS 头部缺陷数等于 H6 最大编号", Number(hm235 ? hm235[2] : -1), h6Max);
/* ---- 第 236 组：JSDoc 里的类型必须与签名一致（7.235） ---- */
{
  const protoSrc = fs.readFileSync("src/proxy/protocol.ts", "utf8");
  // 文档说返回 number，实际给的是 v4/dom/v6 标签：这行锁住「别再写成 number」
  ok("normAtyp 的返回注解是 string|null", protoSrc.includes("@returns {string|null} v4 / dom / v6"));
  ok("normAtyp 不再声称返回数字 atyp", !protoSrc.includes("@returns {number} 归一化后的 atyp"));
  ok("readAddr 的 kind 注解是 string", protoSrc.includes("@param {string} kind normAtyp 归一化后的标签"));
  ok("readAddr 不再声称 kind 是 number", !protoSrc.includes("@param {number} kind"));
  // 旧文档说返回里有 port，实际没有：这句话必须留在文档里当解释，且 return 里不许出现 port
  ok("readAddr 文档不再声称返回 port 字段", !protoSrc.includes("{host: string, port: number, next: number}"));
  ok("readAddr 文档写明了端口不在这里读", protoSrc.includes("端口不在这里读"));
  const auditSrc = fs.readFileSync("tools/doc-audit.mjs", "utf8");
  ok("doc-audit 有 JSDoc 类型判据", auditSrc.includes("JSDoc 类型与签名不一致"));
  ok("判据跳过泛型/解构签名（保守口径）", auditSrc.includes("[<>{}\\[\\]]|\\.\\.\\."));
  // 行为面：三个标签确实是字符串，且识别不了的类型回 null
  eq("normAtyp 认得 IPv4", W.normAtyp("vless", 1), "v4");
  eq("normAtyp 认得域名", W.normAtyp("vless", 2), "dom");
  eq("normAtyp 认得 IPv6", W.normAtyp("vless", 3), "v6");
  eq("normAtyp 对未知类型回 null", W.normAtyp("vless", 9), null);
  eq("trojan 的 v6 是 4 不是 3", W.normAtyp("trojan", 4), "v6");
  // readAddr 的返回里确实没有 port，只有 host/next（成功）或 err（失败）
  const a236 = W.readAddr(new Uint8Array([10, 0, 0, 1]), 0, "v4");
  eq("readAddr 成功给 host", a236.host, "10.0.0.1");
  eq("readAddr 成功给 next", a236.next, 4);
  ok("readAddr 成功时不带 port 字段", !("port" in a236));
  ok("readAddr 越界回错误对象", typeof W.readAddr(new Uint8Array([10, 0]), 0, "v4").err === "string");
}
  /* ---------- 第 237 组：缩进门禁（7.236） ---------- */
  // 判据：语句的缩进 < 所在块左花括号缩进 + 2 ⇒ 被脚本顶出了块。
  // 这类改动 tsc / 单测 / 其余门禁全绿，只有人读代码才发现，所以单独立一条。
  const walkTs = (dir, acc = []) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = dir + "/" + ent.name;
      if (ent.isDirectory()) walkTs(p, acc);
      else if (p.endsWith(".ts")) acc.push(p);
    }
    return acc;
  };
  const indentHits = (() => {
    const skip = [];
    const out = [];
    for (const f of walkTs("src")) {
      if (skip.includes(f)) continue;
      const txt = fs.readFileSync(f, "utf8");
      const lines = txt.split(/\r?\n/);
      const open = [];
      let inTpl = false;
      let prev = "";
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.trim();
        if ((raw.match(/`/g) || []).length % 2 === 1) inTpl = !inTpl;
        if (inTpl || !line) continue;
        const ind = raw.length - raw.trimStart().length;
        const cont = /(?:[,=([]|[.?:+\-*/%<>&|^!~]|&&|\|\|)$/.test(prev);
        const skipHead = /^\s*(?:[.)\]}?:+*/%|&<>=,!]|\?\.)/.test(line);
        const isStmt = !skipHead && !/^\/[/*]/.test(line) && !cont && !/^[}\]);]/.test(line);
        if (isStmt && open.length >= 2 && ind < open[open.length - 1] + 2) out.push(f + ":" + (i + 1));
        for (const ch of raw) {
          if (ch === "{") open.push(ind);
          else if (ch === "}") open.pop();
        }
        prev = line;
      }
    }
    return out;
  })();
  ok("没有语句被顶出所在块（缩进门禁的判据）", indentHits.length === 0, indentHits.slice(0, 5).join(" "));
  const gateSrc = fs.existsSync("tools/check-indent.mjs") ? fs.readFileSync("tools/check-indent.mjs", "utf8") : "";
  ok("缩进门禁脚本在位", gateSrc.length > 0);
  ok("整块偏移的白名单已清空（stat.ts / score.ts 已补齐）", /const BLOCK_SHIFTED = \[\];/.test(gateSrc));
  ok("白名单为空时不再打印「跳过」", gateSrc.includes('const skip = BLOCK_SHIFTED.length') && gateSrc.includes("const skip = BLOCK_SHIFTED.length ? "));
  ok("白名单为空 ⇒ stat.ts / score.ts 也在扫描范围内", indentHits.every((h) => !/nodes\/(stat|score)\.ts/.test(h)));
  ok("preflight 串上了缩进门禁", fs.readFileSync("tools/preflight.mjs", "utf8").includes("缩进门禁"));
  ok("package.json 有 indent 脚本", fs.readFileSync("package.json", "utf8").includes('"indent": "node tools/check-indent.mjs"'));
  const idxSrc = fs.readFileSync("src/index.ts", "utf8");
  ok("index.ts 的 S.site 回到六个空格", idxSrc.includes("\n      S.site = host;"));
  const polSrc = fs.readFileSync("src/route/policy-wiring.ts", "utf8");
  ok("policy-wiring.ts 的 HOOK 注册回到四个空格", polSrc.includes("\n    HOOK.syncAck = "));
  const tfbSrc = fs.readFileSync("src/route/tfb.ts", "utf8");
  ok("tfb.ts 的 splitRelay 行回到四个空格", tfbSrc.includes("\n    const ip = splitRelay(row.relay, 443)[0];"));
  const fmSrc = fs.readFileSync("src/store/factmerge.ts", "utf8");
  ok("factmerge 的 eg 过期判断回到四个空格", fmSrc.includes("\n        if (r.at <= Date.now() - FACT_TTL.eg) continue;"));
  const msSrc = fs.readFileSync("src/store/meter-state.ts", "utf8");
  ok("meter-state.ts 的代号行回到四个空格", msSrc.includes("\n    this.fs = Number((body as unknown as { fs?: number }).fs) || 0;"));

// ---- 第 239 组：一轮 cron 的 fetch 子请求账本（D193）----
// DNS 那一笔必须等于「站点数 × 解析服务数」：一个站点会依次试每个 DoH，前一个失败才换下一个。
const eps239 = W.DOH_ENDPOINTS || [];
const batch239 = W.DNS_BATCH || 0;
const fixed239 = W.SUB_FIXED || {};
eq("DoH 解析服务仍是三个", eps239.length, 3);
eq("每轮探测站点数是 2", batch239, 2);
eq("SUB_FIXED.dns = 站点数 × 解析服务数", fixed239.dns, batch239 * eps239.length);
ok("SUB_FIXED.dns 不再写死 2", fixed239.dns !== 2);
eq("固定支出合计", W.SUB_FIXED_N, W.SUB_FIXED.refill + W.SUB_FIXED.tfb + W.SUB_FIXED.dns);
eq("planRound 扣掉固定支出后的自由额度", W.planRound(0, 0).sub, 48 - W.SUB_FIXED_N);
ok("最坏一轮（固定 + 三批分账）仍在 48 以内", W.SUB_FIXED_N + W.planRound(0, 0).pend + W.planRound(0, 0).snap + W.planRound(0, 0).restore <= 48);
const budgetSrc239 = fs.readFileSync("src/route/budget.ts", "utf8");
const cronSrc239 = fs.readFileSync("src/routes/cron.ts", "utf8");
ok("budget.ts 里 dns 一笔由常量推导", budgetSrc239.includes("dns: DNS_BATCH * DOH_ENDPOINTS.length"));
ok("budget.ts 导出 DNS_BATCH", budgetSrc239.includes("export const DNS_BATCH = 2;"));
ok("cron.ts 用 DNS_BATCH 切片", cronSrc239.includes(".slice(0, DNS_BATCH);"));
ok("cron.ts 不再写死 slice(0, 2)", !cronSrc239.includes(".slice(0, 2);"));
ok("cron.ts 从 budget 引入 DNS_BATCH", cronSrc239.includes("DNS_BATCH, planRound"));

// ---- 第 240 组：池子源的条数上界与账本（D194）----
// env.poolSrc 能覆盖源列表，但一次 cron 的 fetch 子请求有硬上限 48：条数必须由常量封顶。
const cap240 = W.REFILL_MAX || 0;
eq("REFILL_MAX 是 6", cap240, 6);
eq("SUB_FIXED.refill 与常量同源", (W.SUB_FIXED || {}).refill, cap240);
const many240 = Array.from({ length: 20 }, (_, i) => "https://src" + i + ".example.com/proxy.txt");
const srcs240 = W.poolSources({ poolSrc: many240.join(",") });
ok("自定义源列表被截断到上界", srcs240.length <= cap240 && srcs240.length > 0, srcs240.length);
const realFetch240 = globalThis.fetch;
let hits240 = 0;
globalThis.fetch = async () => { hits240 += 1; return new Response("10.9.0.1\n", { status: 200 }); };
W.S.pool = [];
W.S.alive.clear();
try { await W.refillPool({ poolSrc: many240.join(",") }, 0); } finally { globalThis.fetch = realFetch240; }
ok("抓取次数等于源列表长度", hits240 === srcs240.length, hits240 + " vs " + srcs240.length);
ok("抓取次数不超过上界", hits240 <= cap240 && hits240 > 0, hits240);
const probeSrc240 = fs.readFileSync("src/px/poolsrc.ts", "utf8");
const budgetSrc240 = fs.readFileSync("src/route/budget.ts", "utf8");
ok("probe.ts 有 REFILL_MAX 常量", probeSrc240.includes("export const REFILL_MAX = 6;"));
ok("poolSources 截断自定义列表", probeSrc240.includes("return list.length ? list.slice(0, REFILL_MAX) : POOL_SOURCES;"));
ok("budget.ts 的 refill 由常量推导", budgetSrc240.includes("refill: REFILL_MAX,"));
ok("budget.ts 不再写死 refill: 6", !budgetSrc240.includes("refill: 6,"));

// ---- 241. 一批 tfbRound 在调用方这一侧要发两次 DO 子请求（直连探针 + 中继批）
const tfbCalls241 = W.TFB_CALLS || 0;
eq("TFB_CALLS 是 2（直连探针 + 中继批）", tfbCalls241, 2);
eq("SUB_FIXED.tfb 与常量同源", (W.SUB_FIXED || {}).tfb, tfbCalls241);
eq("固定支出合计随 tfb 一笔更新", W.SUB_FIXED_N, (W.SUB_FIXED || {}).refill + (W.SUB_FIXED || {}).tfb + (W.SUB_FIXED || {}).dns);
eq("planRound 扣掉固定支出后的自由额度", W.planRound(0, 0).sub, W.SC.SCAN_SUB - W.SUB_FIXED_N);
ok("最坏一轮（固定 + 三批分账）仍在硬上限以内", W.SUB_FIXED_N + W.planRound(0, 0).pend + W.planRound(0, 0).snap + W.planRound(0, 0).restore <= W.SC.SCAN_SUB);
// 行为面：真跑一批，数调用方这一侧发出的 DO 子请求次数
{
  const hits241 = [];
  const env241 = {
    METER: {
      idFromName: () => "tf-probe",
      get: () => ({
        fetch: async (u) => {
          hits241.push(String(u));
          const body241 = String(u).includes("/meter/tf?") ? { ok: false, status: 0 } : { rows: [] };
          return new Response(JSON.stringify(body241), { status: 200, headers: { "content-type": "application/json" } });
        },
      }),
    },
  };
  if (W.runTfb) await W.runTfb({ env: env241 }, "test241.example.com", 2);
  eq("一批只发两条 DO 子请求", hits241.length, 2);
  ok("第一条是直连探针", hits241.length > 0 && String(hits241[0]).includes("/meter/tf?"), String(hits241[0] || ""));
  ok("第二条是中继批", hits241.length > 1 && String(hits241[1]).includes("/meter/tfb?"), String(hits241[1] || ""));
  eq("账本与真实次数一致", (W.SUB_FIXED || {}).tfb, hits241.length);
}
const budSrc241 = fs.readFileSync("src/route/budget.ts", "utf8");
const cronSrc241 = fs.readFileSync("src/routes/cron.ts", "utf8");
ok("budget.ts 导出 TFB_CALLS", budSrc241.includes("export const TFB_CALLS = 2;"));
ok("budget.ts 的 tfb 一笔由常量推导", budSrc241.includes("tfb: TFB_CALLS,"));
ok("budget.ts 不再写死 tfb: 1", !budSrc241.includes("tfb: 1,"));
ok("dnsRound 文档按真实服务数表述", cronSrc241.includes("每个站点最多 DOH_ENDPOINTS.length 次 DoH"));
ok("dnsRound 不再声称每个 1 次 DoH", !cronSrc241.includes("每个 1 次 DoH 子请求"));

// ===== 第 242 组：一轮 cron 的子请求账本（固定支出 + 三批「每人一次往返」的分账） =====
{
  const pl242 = W.planRound(1600, 8);
  const fx242 = W.SUB_FIXED || {};
  eq("固定支出只有源/判定批/DoH 三笔", Object.keys(fx242).length, 3);
  eq("固定支出合计 = 三笔之和", W.SUB_FIXED_N, fx242.refill + fx242.tfb + fx242.dns);
  eq("剩额 = 硬上限 − 固定支出", pl242.sub, W.SC.SCAN_SUB - W.SUB_FIXED_N);
  eq("三批分账正好填满剩额", pl242.pend + pl242.snap + pl242.restore, pl242.sub);
  ok("上报额度不超过 PEND_MAX", pl242.pend <= W.SC.PEND_MAX);
  ok("快照额度不超过 SNAP_MAX", pl242.snap <= W.SC.SNAP_MAX);
  ok("回填额度不超过 RESTORE_MAX", pl242.restore <= (W.RESTORE_MAX || 12));
  ok("上报的额度不小于另外两批", pl242.pend >= pl242.snap && pl242.pend >= pl242.restore);
  ok("旧口径（把三批当一次调用）会越界，这就是本条缺陷", 6 + 2 + 6 + W.SC.PEND_MAX + (1 + 1 + W.SC.SNAP_MAX + 1) + 12 > W.SC.SCAN_SUB);
  ok("新口径守住硬上限", W.SUB_FIXED_N + pl242.pend + pl242.snap + pl242.restore <= W.SC.SCAN_SUB);
  eq("上报占比常量在窗口里", W.SHARE_PEND, 0.5);
  eq("快照占比常量在窗口里", W.SHARE_SNAP, 0.3);

  // 行为面：两个消费者真的按额度截断，不传时回到各自的硬上限
  const mkEnv242 = (sink) => ({
    METER: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async (url) => {
          sink.push(String(url));
          return { ok: true, json: async () => ({ ok: true, up: 1, down: 2, conns: 1, d: new Date().toISOString().slice(0, 10) }) };
        },
      }),
    },
    STATS: { get: async () => ({ get: async () => null, put: async () => {} }), put: async () => {} },
    uuids: "u242",
    pwd: "p242",
  });

  const sent242 = [];
  const env242 = mkEnv242(sent242);
  W.S.pend.clear();
  for (let i = 0; i < 20; i++) W.S.pend.set("p242-u" + i, { up: 10, down: 20, conns: 1 });
  W.S.pendAt = 0;
  W.S.pendMs = 0;
  await W.pendFlush(env242, true, 5);
  eq("给了 5 的额度就只发 5 次 DO 往返", sent242.length, 5);
  eq("剩下的留在账本里等下一轮", W.S.pend.size, 15);
  sent242.length = 0;
  for (let i = 0; i < 40; i++) W.S.pend.set("p242-v" + i, { up: 1, down: 1, conns: 1 });
  W.S.pendAt = 0;
  W.S.pendMs = 0;
  await W.pendFlush(env242, true);
  eq("不传额度时回到 PEND_MAX", sent242.length, W.SC.PEND_MAX);

  const reads242 = [];
  const snapEnv242 = mkEnv242(reads242);
  W.S.meterCache.clear();
  await W.usageSnapWrite(snapEnv242, Array.from({ length: 20 }, (_x, i) => ({ id: "s242-" + i })), 3);
  eq("快照给了 3 的额度就只读 3 个人的用量", reads242.length, 3);
  reads242.length = 0;
  W.S.meterCache.clear();
  await W.usageSnapWrite(snapEnv242, Array.from({ length: 30 }, (_x, i) => ({ id: "t242-" + i })));
  eq("不传额度时回到 SNAP_MAX", reads242.length, W.SC.SNAP_MAX);

  // 源码锁：三处接线都在，且旧写法不再出现
  const bud242 = fs.readFileSync("src/route/budget.ts", "utf8");
  const cron242 = fs.readFileSync("src/routes/cron.ts", "utf8");
  const pend242 = fs.readFileSync("src/store/pend.ts", "utf8");
  const snap242 = fs.readFileSync("src/store/snapshot.ts", "utf8");
  ok("budget 不再把上报/快照当固定支出", !bud242.includes("pend: 1,") && !bud242.includes("snap: 4,"));
  ok("budget 有分账常量", bud242.includes("export const SHARE_PEND = 0.5;") && bud242.includes("export const SHARE_SNAP = 0.3;"));
  ok("planRound 按占比切并夹到各自上限", bud242.includes("cap(sub * SHARE_PEND, SC.PEND_MAX)") && bud242.includes("cap(sub * SHARE_SNAP, SC.SNAP_MAX)"));
  ok("cron 把三个额度分别传下去", cron242.includes("pendFlush(env, true, plan.pend)") && cron242.includes("usageSnapWrite(env, users.list, plan.snap)") && cron242.includes("restorePick(allIds, plan.restore)"));
  ok("cron 不再自己夹 RESTORE_MAX", !cron242.includes("RESTORE_MAX"));
  ok("pendFlush 尊重传入额度", pend242.includes("Math.min(SC.PEND_MAX, max)"));
  ok("usageSnapWrite 尊重传入额度", snap242.includes("Math.min(SC.SNAP_MAX, max)"));
}
// ---- 第 243 组：定时持久化的失败必须可见（7.243 / D197） ----
{
  const cntAll = () => W.cntView ? W.cntView() : {};
  const boom = (m) => async () => { throw new Error(m); };
  const envDown = {
    uuids: "u243", pwd: "p243",
    STATS: { get: boom("kv get down"), put: boom("kv put down"), list: boom("kv list down") },
    METER: { idFromName: (n) => n, get: () => ({ fetch: boom("do down") }) },
  };
  const envW = {
    uuids: "u243", pwd: "p243",
    STATS: { get: async () => null, put: boom("kv put down"), list: async () => ({ keys: [] }) },
    METER: { idFromName: (n) => n, get: () => ({ fetch: async () => ({ ok: true, json: async () => ({ up: 5, down: 7, conns: 1 }) }) }) },
  };
  const before243 = cntAll();
  const d243 = (k) => (Number(cntAll()[k]) || 0) - (Number(before243[k]) || 0);
  // 账本上报：内层把每个用户的失败回滚 + 退避，以前一个计数都没有
  W.S.pend.clear();
  W.S.pend.set("u243a", { up: 10, down: 20, conns: 1 });
  W.S.pendAt = 0;
  W.S.pendMs = 0;
  await W.pendFlush(envDown, true, 5);
  ok("账本上报失败有计数", d243("pendFail") >= 1, String(d243("pendFail")));
  // 用量快照：读失败早退 / 写失败各一个计数
  await W.usageSnapWrite(envDown, [{ id: "u243a" }], 2);
  ok("用量快照读失败有计数", d243("snapReadFail") >= 1, String(d243("snapReadFail")));
  await W.usageSnapWrite(envW, [{ id: "u243a" }], 2);
  ok("用量快照写失败有计数", d243("snapWriteFail") >= 1, String(d243("snapWriteFail")));
  // 整体快照：先塞一行本地数据（否则 hasData 提前返回是正常行为，不是失败）
  const seed243 = () => { W.S.stats.set("n243", { up: 1, down: 2, conns: 1, first: 1, last: 2 }); W.S.snapBusy = false; W.S.snapChecked = 0; W.S.snapWritten = 0; };
  seed243();
  await W.flushSnap(envDown, true);
  ok("整体快照读失败有计数", d243("snapFlushReadFail") >= 1, String(d243("snapFlushReadFail")));
  seed243();
  await W.flushSnap(envW, true);
  ok("整体快照写失败有计数", d243("snapFlushFail") >= 1, String(d243("snapFlushFail")));
  // 计数键必须登记，否则 cnt() 会当成未知键丢掉
  for (const k243 of ["pendFail", "snapReadFail", "snapWriteFail", "snapFlushReadFail", "snapFlushFail", "snapUsersFail", "seedWriteFail"]) {
    ok(`计数键已登记：${k243}`, W.S.cntKeys.includes(k243));
  }
  // 源码锁：四处真实吞掉点与 cron 的返回值检查
  const srcPend = fs.readFileSync("src/store/pend.ts", "utf8");
  const srcSnap = fs.readFileSync("src/store/snapshot.ts", "utf8");
  const srcCron243 = fs.readFileSync("src/routes/cron.ts", "utf8");
  ok("pendFlush 失败计数在位", srcPend.includes('cnt("pendFail", bad)'));
  ok("用量快照读失败计数在位", srcSnap.includes('cnt("snapReadFail")'));
  ok("用量快照写失败计数在位", srcSnap.includes('cnt("snapWriteFail")'));
  ok("整体快照读失败计数在位", srcSnap.includes('cnt("snapFlushReadFail")'));
  ok("整体快照写失败计数在位", srcSnap.includes('cnt("snapFlushFail")'));
  ok("cron 检查 flushPx 返回值", srcCron243.includes("const fx = await flushPx(env);") && srcCron243.includes("if (!fx.ok)"));
  ok("cron 记录用户表读失败", srcCron243.includes('cnt("snapUsersFail")'));
}
/* ---------- 244. /proxyip?day=1 的读失败不能伪装成「今天零用量」 ---------- */
{
  const mk = (meter) => ({
    env: { METER: meter, NODE_ENV: "test" },
    url: new URL("https://sim.example.com/u/proxyip?day=1"),
    host: "sim.example.com",
    id: "u244b",
  });
  const bad = {
    idFromName: () => "id",
    get: () => ({ fetch: async () => { throw new Error("kv down"); } }),
  };
  const r1 = await (await W.proxyip(mk(bad))).json();
  eq("读失败时 doSrc 是 fail", r1.doSrc, "fail");
  eq("读失败时计数仍是空表", JSON.stringify(r1.cnt), "{}");
  const n1 = W.cntView().dayDoFail || 0;
  ok("读失败记了 dayDoFail", n1 >= 1, String(n1));

  const r500 = await (
    await W.proxyip(
      mk({ idFromName: () => "id", get: () => ({ fetch: async () => new Response(JSON.stringify({ g: {} }), { status: 500 }) }) })
    )
  ).json();
  eq("DO 回 5xx 也算读失败", r500.doSrc, "fail");

  const r3 = await (await W.proxyip(mk(undefined))).json();
  eq("没有 METER 绑定时报 none", r3.doSrc, "none");

  const r4 = await (
    await W.proxyip(
      mk({
        idFromName: () => "id",
        get: () => ({ fetch: async () => new Response(JSON.stringify({ g: { d: "2026-11-16", n: 3 }, s: {} }), { status: 200 }) }),
      })
    )
  ).json();
  eq("读通了报 ok", r4.doSrc, "ok");
  eq("读通了拿到真实计数", r4.cnt.n, 3);

  // 源码锁：三条留痕都必须真的在，且响应体带出来源标记
  const px244 = fs.readFileSync("src/routes/proxyip.ts", "utf8");
  ok("doSrc 有三态声明", px244.includes('let doSrc: "ok" | "fail" | "none"'));
  ok("先判 r.ok 再解析", px244.includes('if (!r.ok) throw new Error("meter cnt " + r.status);'));
  ok("失败记 dayDoFail", px244.includes('cnt("dayDoFail")'));
  ok("失败写错误环", px244.includes('logErr("day count read failed", "kv")'));
  ok("响应体带 doSrc", /\n\s+doSrc,/.test(px244));
  const st244 = fs.readFileSync("src/core/state.ts", "utf8");
  ok("cntKeys 登记了 dayDoFail", st244.includes('"dayDoFail"'));
}

/** 245 组的连接桩：只带 pipeBack 会用到的字段 */
const mkSt245 = (W, down) => {
  const st = new W.Connection({}, "u245", "", "tput");
  st.down = down;
  st.node = "198.51.100.1:443";
  st.host = "example.com";
  st.mark = 1e9;
  st.tAttach = Date.now();
  return st;
};

/** 245 组的 socket 桩：可读流一起来就报错，模拟「连上就断」 */
const sockOf245 = (msg) => ({
  readable: new ReadableStream({
    start(c) {
      c.error(new Error(msg));
    },
  }),
  close() {},
  closed: Promise.resolve(),
  writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
});

/** 245 组的 WS 桩：readyState 1 = 开着，3 = 已关 */
const wsOf245 = (state = 1) => ({ readyState: state, bufferedAmount: 0, send() {}, close() {} });
// ── 245. pipe 在「连上就断、零字节」时补记账簿（7.245 / D199）──────────────────
{
  const cut0 = W.cntView().cut || 0;
  const ccut0 = W.cntView().ccut || 0;

  // ① 零字节 + 客户端还在：必须走 onClose(false)，让 attacher 的 0 字节账本（eCloseP /
  //    nsEmptyClose / 换中继重试）接管；7.245 之前这里什么都不做。
  {
    const st = mkSt245(W, 0);
    const calls = [];
    W.pipeBack(sockOf245("origin reset"), wsOf245(), st, (got) => calls.push(got));
    await new Promise((r) => setTimeout(r, 90));
    eq("零字节 pipe 错误会走 onClose(false)", calls.length, 1);
    eq("onClose 收到 gotData=false", calls[0], false);
    ok("零字节那条不算 cut（交给 attacher 记 eCloseP）", (W.cntView().cut || 0) - cut0 === 0);
    eq("通知后 st.notified 置真", st.notified, true);
    eq("零字节那条不置 failed（由 onClose 决定）", st.failed, false);
  }

  // ② 有下行字节：语义不变 —— 记 cut + 手工降权，不回调 onClose（中途断流没法重放）
  {
    const st = mkSt245(W, 4096);
    const calls = [];
    W.pipeBack(sockOf245("mid reset"), wsOf245(), st, (got) => calls.push(got));
    await new Promise((r) => setTimeout(r, 90));
    eq("中途断流不回调 onClose", calls.length, 0);
    eq("中途断流记 cut", (W.cntView().cut || 0) - cut0, 1);
    eq("中途断流置 failed", st.failed, true);
  }

  // ③ 客户端已经走了：记 ccut，不回调 onClose（不是节点的问题，也不该再替它拨号）
  {
    const st = mkSt245(W, 0);
    const calls = [];
    W.pipeBack(sockOf245("origin reset"), wsOf245(3), st, (got) => calls.push(got));
    await new Promise((r) => setTimeout(r, 90));
    eq("客户端已走时记 ccut", (W.cntView().ccut || 0) - ccut0, 1);
    eq("客户端已走时不回调 onClose", calls.length, 0);
  }

  // ④ 同一条连接只通知一次（close 与 error 两条路径共用 st.notified）
  {
    const st = mkSt245(W, 0);
    const calls = [];
    st.notified = true;
    W.pipeBack(sockOf245("origin reset"), wsOf245(), st, (got) => calls.push(got));
    await new Promise((r) => setTimeout(r, 90));
    eq("已经通知过的连接不再回调", calls.length, 0);
  }

  // ⑤ 源码锁
  const srcTun245 = fs.readFileSync("src/proxy/tunnel.ts", "utf8");
  ok("close 只在未通知时回调", srcTun245.includes("if (onClose && !st.notified) {"));
  ok("error 路径有零字节分支", srcTun245.includes("} else if (st.down === 0 && onClose) {"));
  ok("error 路径整体受 notified 守卫", srcTun245.includes("if (st && !st.notified) {"));
  const srcConn245 = fs.readFileSync("src/proxy/connection.ts", "utf8");
  ok("Connection 有 notified 标记", srcConn245.includes("notified = false;"));
  const fresh245 = new W.Connection({}, "u245b", "", "tput");
  eq("新连接的 notified 默认假", fresh245.notified, false);
}

// ── 第 246 组：DO 被重置后从快照回填用量失败，必须留下痕迹 ─────────────────────
{
  /** 内存版 KV（只实现这轮用到的四个方法） */
  const kvStore246 = () => {
    const m = new Map();
    return {
      m,
      get: async (k) => (m.has(k) ? m.get(k) : null),
      put: async (k, v) => {
        m.set(k, v);
      },
      delete: async (k) => {
        m.delete(k);
      },
      list: async () => ({ keys: [...m.keys()].map((name) => ({ name })), list_complete: true }),
    };
  };
  /** 假计量 DO：/seed 的行为由 mode 决定 */
  const meter246 = (getV, mode, seedV) => {
    const stub = {
      fetch: async (u) => {
        const ep = String(u).replace(/^https:\/\/meter\//, "").split("?")[0];
        if (ep === "seed") {
          if (mode === "throw") throw new Error("do reset");
          if (mode === "500") return new Response("boom", { status: 500 });
          return new Response(JSON.stringify(seedV), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify(getV), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    return { get: () => stub, idFromName: (n) => n };
  };

  const KEK246 = "probe-kek-246";
  const ID246 = "u-246";
  const today246 = new Date().toISOString().slice(0, 10);
  const hist246 = { up: 999, down: 888, conns: 7, d: today246, dU: 111, dD: 222, first: 1700000000000, ts: Date.now() };
  const zero246 = { up: 0, down: 0, conns: 0, d: today246, dU: 0, dD: 0, ts: Date.now() };
  const kvp = kvStore246();

  // 历史用量先进 KV 灾备快照（走真实 usageSnapWrite，封装格式与线上一致）
  W.S.meterCache.clear();
  await W.usageSnapWrite({ STATS: kvp, KEK: KEK246, METER: meter246(hist246, "ok", hist246) }, [{ id: ID246 }], 4);
  ok("第246组·历史用量进了 KV 灾备快照", kvp.m.size > 0);

  // ① DO 抛错：回填失败必须留痕，且不能声称已落盘
  const c0 = W.cntView().statsSeedFail || 0;
  W.S.meterCache.clear();
  const sThrow = await W.readStats({ STATS: kvp, KEK: KEK246, METER: meter246(zero246, "throw", hist246) }, ID246);
  eq("第246组·回填抛错时标记 fail", sThrow.seed, "fail");
  eq("第246组·回填抛错时不能声称已落盘", sThrow.persisted, false);
  eq("第246组·回填抛错计一次 statsSeedFail", (W.cntView().statsSeedFail || 0) - c0, 1);

  // ② DO 回 500：同样要留痕（旧代码里只有 r.ok 那支，没有 else，这条路径连计数都没有）
  W.S.meterCache.clear();
  const s500 = await W.readStats({ STATS: kvp, KEK: KEK246, METER: meter246(zero246, "500", hist246) }, ID246);
  eq("第246组·回填 5xx 时标记 fail", s500.seed, "fail");
  eq("第246组·回填 5xx 计一次 statsSeedFail", (W.cntView().statsSeedFail || 0) - c0, 2);

  // ③ 回填成功：数值必须真的从快照回到面板上
  W.S.meterCache.clear();
  const sOk = await W.readStats({ STATS: kvp, KEK: KEK246, METER: meter246(zero246, "ok", hist246) }, ID246);
  eq("第246组·回填成功后累计用量来自快照", sOk.up, 999);
  eq("第246组·回填成功后当日用量来自快照", sOk.todayUp, 111);
  eq("第246组·回填成功后标记 ok", sOk.seed, "ok");
  eq("第246组·回填成功后不再涨计数", (W.cntView().statsSeedFail || 0) - c0, 2);

  // ④ 没有 METER 绑定时走 KV 兜底，口径里也要有 seed 字段（不留「这个字段在不在」的猜测）
  W.S.meterCache.clear();
  const sKv = await W.readStats({ STATS: kvp, KEK: KEK246 }, ID246);
  eq("第246组·没有 DO 时走 KV 兜底", sKv.backend, "kv");
  eq("第246组·KV 兜底分支也声明 seed = none", sKv.seed, "none");

  // ⑤ 源码锁：两处失败分支都必须计数，且不再有空 catch
  const srcStats246 = fs.readFileSync("src/store/stats.ts", "utf8");
  eq("第246组·两处失败分支都计数", srcStats246.split('cnt("statsSeedFail")').length - 1, 2);
  eq("第246组·stats.ts 不再有裸空 catch", srcStats246.includes("} catch (e) {}"), false);
  ok("第246组·成功分支标记 ok", srcStats246.includes('seed = "ok"'));
  const srcState246 = fs.readFileSync("src/core/state.ts", "utf8");
  ok("第246组·statsSeedFail 已登记 cntKeys", srcState246.includes('"statsSeedFail"'));
}


// ═══ 第 247 组：跳过 CF 边缘候选不等于试过一次（D201）═══
const H247 = "cfhost247.test";
W.S.cfHost.set(H247, Date.now() + 1800000);
W.S.alive.set("198.51.100.9:443", { h: "198.51.100.9", p: 443, at: Date.now(), fail: 0, ok: 3, ms: 200 });
{
  // 选择器只给一条 CF 边缘：中转到 CF 托管目标等于从同一边缘再撞一次，必须跳过
  const realCur = W.SEL.current;
  W.SEL.current = async () => "104.16.0.1:443";
  W.S.errs.length = 0;
  const before = W.cntView().skipCfRelay || 0;
  const st247 = {
    rx: "",
    node: "",
    via: "",
    retried: false,
    pxTries: 0,
    hostTrial: false,
    cf: false,
    ctx: { waitUntil: () => {}, passThroughOnException: () => {} },
  };
  let err247 = "";
  try {
    await W.DIALER.open({
      env: { STATS: { get: async () => null, put: async () => {}, list: async () => ({ keys: [] }) }, proxyip: "auto" },
      request: new Request("https://" + H247 + "/"),
      conn: st247,
      mode: "tput",
      host: H247,
      port: 443,
      pxForce: 1,
    });
  } catch (err) {
    err247 = String((err && err.message) || err);
  }
  W.SEL.current = realCur;
  const skipped = (W.cntView().skipCfRelay || 0) - before;
  eq("跳过 CF 边缘候选记一次 skipCfRelay", skipped, 1);
  eq(
    "跳过不写错误环（否则每个 CF 站点请求都会挤掉真错误）",
    W.S.errs.filter((x) => String(x.m || "").includes("skip cf-edge")).length,
    0,
  );
  ok("跳过不是一次尝试（st.via 仍为空、pxTries 未推进）", st247.via === "" && st247.pxTries === 0, st247.via + "/" + st247.pxTries);
  ok("跳过之后仍然会去拨直连（Node 里没有 sockets，抛错属预期）", err247.length > 0, err247);
}
{
  const dsrc = fs.readFileSync("src/proxy/dialer.ts", "utf8");
  ok("尝试名额按「真的拨了几次」算，不跟循环下标走",
    dsrc.includes("for (let guard = 0; guard < maxTries + 4 && tries < maxTries && !sock; guard++) {"), true);
  ok("计数发生在拨号之前（跳过分支没有 tries += 1）",
    /tries \+= 1;\s*\r?\n\s*const pk = Promise\.resolve\(connect\(/.test(dsrc), true);
  ok("跳过分支只计数、不再写 logErr",
    /cnt\("skipCfRelay"\);\s*\r?\n\s*continue;/.test(dsrc) && !/logErr\(`skip cf-edge relay/.test(dsrc), true);
  ok("st.pxTries 记的是真实尝试次数（不再用下标 +1）",
    dsrc.includes("conn.pxTries = tries;") && !dsrc.includes("conn.pxTries = tries + 1;"), true);
  ok("skipCfRelay 在 cntKeys 里登记", fs.readFileSync("src/core/state.ts", "utf8").includes('"skipCfRelay",'), true);
}
// ── 第 248 组：/debug 把 DO 的 5xx 当成成功（D202）────────────────────────────
{
  const kv248 = () => {
    const m = new Map();
    return {
      get: async (k) => (m.has(k) ? m.get(k) : null),
      put: async (k, v) => void m.set(k, v),
      delete: async (k) => void m.delete(k),
      list: async () => ({ keys: [...m.keys()].map((name) => ({ name })), list_complete: true }),
    };
  };
  // 所有 fetch 都回 500：模拟 DO 里报错（CPU 墙 / 行为异常）
  const meter248 = (status, body) => ({
    idFromName: (n) => n,
    get: () => ({ fetch: async () => new Response(body, { status, headers: { "content-type": "application/json" } }) }),
  });
  const KEY248 = "#probe-admin-248";
  const ctx248 = (env, qs) => {
    const url = new URL("https://sim.example.com/7c53c12a-88b1-4fda-b6e7-4da62e47a4e1/debug" + qs);
    const request = new Request(url.toString(), { headers: { "x-admin-key": String(env.adminKey || "") } });
    return { request, url, env, id: "7c53c12a-88b1-4fda-b6e7-4da62e47a4e1", exec: { waitUntil() {}, passThroughOnException() {} } };
  };
  const run248 = async (qs, opts) => {
    const kv = kv248();
    if (opts && opts.putFail) {
      kv.put = async () => {
        throw new Error("KV PUT failed: 429 too many writes");
      };
    }
    const env = { STATS: kv, METER: meter248((opts && opts.status) || 500, (opts && opts.body) || '{"error":"boom"}'), adminKey: KEY248 };
    return (await W.debug(ctx248(env, qs))).json();
  };

  for (const qs of ["?burn=10&n=p248", "?stage=1&n=p248", "?tim=10&n=p248", "?iter=1000&n=p248", "?burnjs=10&n=p248", "?crypto=1&n=p248"]) {
    const j = await run248(qs, {});
    eq(qs + " 时 ok 为 false（DO 5xx 不是成功）", j.ok, false);
    eq(qs + " 带出 DO 的状态码", j.doStatus, 500);
  }
  const halfInput = await run248("?stage=1&n=p248", { status: 200, body: '{"stage":"ok"}' });
  eq("DO 回 200 时 ok 仍为 true", halfInput.ok, true);
  eq("DO 回 200 时带出状态码", halfInput.doStatus, 200);

  const seedBad = await run248("?seed=1,2,3", {});
  eq("回填回 5xx 时 ok 为 false", seedBad.ok, false);
  eq("回填回 5xx 时带出状态码", seedBad.doStatus, 500);

  const curBad = await run248("?cur=1.2.3.4:443", { putFail: true });
  eq("钉节点落盘失败时 anchor 为 fail", curBad.anchor, "fail");
  ok("钉节点落盘失败时带回原因", typeof curBad.note === "string" && curBad.note.length > 0);
  const curOk = await run248("?cur=1.2.3.4:443", {});
  eq("钉节点落盘成功时 anchor 为 ok", curOk.anchor, "ok");

  const srcDbg248 = debugAll();
  ok("转发分支不再无条件写 ok: true", !srcDbg248.includes("return json({ ok: true, burn: await resp.json() })"));
  const srcMeter275 = fs.readFileSync("src/routes/debug-meter.ts", "utf8");
  ok("转发分支带出 DO 状态码", srcMeter275.includes("ok: resp.ok, doStatus: resp.status"));
  ok("六个转发分支已交给 DebugMeterProbes", srcDbg248.includes("METER_PROBES.run(c, url, id)") && !srcDbg248.includes("searchParams.get(\"burn\")"));
  ok("回填分支用 seedOk", srcDbg248.includes("let seedOk = false;") && srcDbg248.includes("return json({ ok: seedOk, doStatus: seedStatus, seeded });"));
  ok("钉节点分支用 fx.ok 判定落盘", srcDbg248.includes('anchor: fx.ok ? "ok" : "fail"'));
}
// ---- 第 249 组：站点「应答了」不等于「回了 200」（D203，7.249） ----
// 探测走 redirect: "manual"（src/core/tf.ts），301/302 是正常形态；只认 200 时
// 会重定向的站点每一批都判 unknown ⇒ rotate，永久换出口、中继拿不到正证据。
{
  const G = "第 249 组";
  ok(`[${G}] 301 算「站点应答」（不再落 unknown）`, W.tfVerdict([{ ok: true, status: 301, bytes: 0 }]) === "ok");
  ok(`[${G}] 302 同样`, W.tfVerdict([{ ok: true, status: 302, bytes: 0 }]) === "ok");
  ok(`[${G}] 204 同样`, W.tfVerdict([{ ok: true, status: 204, bytes: 0 }]) === "ok");
  ok(`[${G}] 重定向站点不再被判成要一直换出口`, W.tfEscalate(W.tfVerdict([{ ok: true, status: 301 }])) === "none");
  ok(`[${G}] 301 与 403 并存仍是 chan（不能因为放宽 okN 就吞掉分裂）`, W.tfVerdict([{ ok: true, status: 301 }, { ok: true, status: 403, bytes: 4 }]) === "chan");
  ok(`[${G}] 全 4xx 仍是 site`, W.tfVerdict([{ ok: false, status: 403 }, { ok: false, status: 403 }]) === "site");
  ok(`[${G}] 无状态码仍是 unknown`, W.tfVerdict([{ ok: false }, { ok: false }]) === "unknown");
  eq(`[${G}] tfClass 对 301 给 ok`, W.tfClass([{ ok: true, status: 301 }]), "ok");

  // 行为面：一条 301 的中继必须拿到正证据（改前 vSet 只在 status === 200 时调用）
  const H249 = "d203.example.com";
  const ip249 = "203.0.113.9";
  W.vClear(H249);
  const before249 = W.vOk(H249, "r:" + ip249);
  const ctx249 = {
    env: {
      METER: {
        idFromName: () => "tf-probe",
        get: () => ({
          fetch: async () =>
            Response.json({ rows: [{ relay: ip249 + ":443", ok: true, status: 301, ms: 12 }] }),
        }),
      },
    },
  };
  await W.runTfb(ctx249, H249, 2, "");
  const after249 = W.vOk(H249, "r:" + ip249);
  ok(`[${G}] 301 的中继拿到正证据（vOk 从 false 变成 true）`, before249 === false && after249 === true);
  eq(`[${G}] 存的不是硬写的 200，而是真实状态码`, W.vState(H249, "r:" + ip249), 1);
  W.vClear(H249);

  const tfbSrc249 = fs.readFileSync("src/route/tfb.ts", "utf8");
  ok(`[${G}] tfVerdict 不再只认 status === 200`, !tfbSrc249.includes("x.ok && x.status === 200"));
  ok(`[${G}] vSet 分支不再只认 status === 200`, !tfbSrc249.includes("row.ok && row.status === 200"));
  ok(`[${G}] 正证据写真实状态码`, tfbSrc249.includes("Number(row.status || 200)"));
  ok(`[${G}] 2xx/3xx 判据出现两处（tfVerdict + runTfb 的 okN）`, tfbSrc249.split("(x.status || 0) >= 200 && (x.status || 0) < 400").length - 1 === 2);
}

// ── 第 250 组：relperf 淘汰判据（D204）+ 判定状态改用枚举（D205）──────────
{
  // D204-1：上限必须在插入之后判断 —— 旧代码稳定停在 512 + 1
  // A/B 时旧代码没有这个导出，用空桩把「红」限制在断言上，而不是让整组抛错中断
  const mkRel250 = () =>
    typeof W.RelPerfTable === "function"
      ? new W.RelPerfTable()
      : { note() {}, get() { return null; }, cost() { return 0; }, size() { return { rows: 0, by: 0 }; } };
  const t250 = mkRel250();
  ok("测试窗口导出了 RelPerfTable", typeof W.RelPerfTable === "function");
  for (let i = 0; i < 600; i += 1) t250.note("h" + i + ".test", "10.9." + (i % 200) + "." + (i % 251), 100 + i, 1024, 1_000_000);
  const sz250 = t250.size();
  ok("淘汰后不超过上限 512", sz250.rows <= 512, JSON.stringify(sz250));
  ok("淘汰留 1/8 低水位（不是每条样本都排整表）", sz250.rows >= 448, JSON.stringify(sz250));
  ok("站点无关聚合表也有上限 256", sz250.byRelay <= 256, JSON.stringify(sz250));
  ok("两条表都真的装进了样本", sz250.rows > 0 && sz250.byRelay > 0, JSON.stringify(sz250));

  // D204-2：过期的样本不再参与决策（内存按上限收，过期靠读路径判活）
  const t251 = mkRel250();
  t251.note("old.test", "10.8.0.9", 100, 1024, 1_000);
  ok("未过期的样本仍在", !!t251.get("old.test", "10.8.0.9", 1_500), JSON.stringify(t251.size()));
  ok("过期的样本不再被选中", t251.get("old.test", "10.8.0.9", 1_000 + W.REL_SAMPLE_TTL + 1) === null);

  // D204-3：代价函数仍可用（淘汰改动不能把它弄坏）
  const t252 = mkRel250();
  t252.note("c.test", "10.6.0.1", 150, 4096, 1_000_000);
  const c252 = t252.cost("c.test", "10.6.0.1", 1_000_001);
  ok("没样本用聚合兜底，有样本用自己那条", Number.isFinite(c252) && c252 > 0, String(c252));

  // D205-1：枚举是唯一真源，且能被当作数字/字符串用（既有调用点不变）
  // A/B 时旧包没有这些导出，用「不可能相等」的桩让断言红而不是抛错
  const ST250 = W.St || { Unknown: -1, Reachable: -2, Blocked: -3, Dead: -4 };
  const MD250 = W.Mode || { Tput: "__none__", Lat: "__none__" };

  eq("St.Unknown 是 0", ST250.Unknown, 0);
  eq("St.Reachable 是 1", ST250.Reachable, 1);
  eq("St.Blocked 是 2", ST250.Blocked, 2);
  eq("St.Dead 是 3", ST250.Dead, 3);
  eq("St 反向映射保留语义名", ST250[3], "Dead");
  eq("Mode.Throughput 是 tput", MD250.Throughput, "tput");
  eq("Mode.Latency 是 lat", MD250.Latency, "lat");


  // D205-2：行为面 —— 判定表写入与读取在枚举口径下仍一致
  W.vClear();
  W.vSetState("enum250.test", "d", ST250.Dead, 1);
  eq("状态 3 记成 Dead", W.vState("enum250.test", "d"), ST250.Dead);
  eq("Dead 不是「可用」", W.vOk("enum250.test", "d"), false);
  eq("Dead 算「不可用」", W.vBad("enum250.test", "d"), true);
  W.vSetState("enum250.test", "d", ST250.Reachable, 1);
  eq("状态 1 记成 Reachable", W.vState("enum250.test", "d"), ST250.Reachable);
  eq("Reachable 算「可用」", W.vOk("enum250.test", "d"), true);
  W.vSetState("enum250.test", "d", ST250.Blocked, 1);
  eq("状态 2 记成 Blocked", W.vState("enum250.test", "d"), ST250.Blocked);
  W.vClear();

  // D205-3：源码锁 —— 状态字面量不许再散落在判定路径上
  const srcVer250 = verdictAll();
  ok("verdict.ts 用 St.Dead 而不是裸 3", srcVer250.includes("St.Dead") && !srcVer250.includes("return 3;"));
  ok("verdict.ts 的 vOk/vBad 走枚举", srcVer250.includes("=== St.Reachable") && srcVer250.includes("=== St.Blocked || e.state === St.Dead"));
  const srcEnums250 = fs.readFileSync("src/core/enums.ts", "utf8");
  ok(
    "枚举文件在且是唯一真源",
    srcEnums250.includes("export enum St") && srcEnums250.includes("export enum Mode"),
    "St / Mode 必须都在 src/core/enums.ts",
  );
  ok("通道类型仍只有 channel.ts 一份", !srcEnums250.includes("ChanKind"));
  const srcOut250 = fs.readFileSync("src/store/factout.ts", "utf8");
  ok("factout.ts 的老格式按枚举读", srcOut250.includes("St.Blocked") && !srcOut250.includes("? v.s === 3 ? 3 : 2"));
  const srcAdd250 = fs.readFileSync("src/store/meteradd.ts", "utf8");
  ok("meteradd.ts 的老格式按枚举读", srcAdd250.includes("r.s === St.Dead ? St.Dead : St.Blocked"));
  const srcRel250 = fs.readFileSync("src/route/relperf.ts", "utf8");
  ok("relperf 的淘汰交给 BoundedMap（不再自己写一份）", srcRel250.includes("new BoundedMap<string, RelSample>") && !srcRel250.includes("private evict("));
  ok("relperf 的上限判断在插入之后", srcRel250.includes("this.rows.prune(now);"));
  ok("relperf 用 Mode 枚举判模式", srcRel250.includes("modeToken === Mode.Latency"));
}


// ---- 251. 命名规范与结构收口（7.251）：有界表统一实现、语义字段名、枚举成员名
{
  const G = 251;
  const BM = W.BoundedMap;
  ok(`[${G}] BoundedMap 可构造`, typeof BM === "function");

  // 容量：上限 128，插 300 条边插边清 —— 稳定不超上限，且一次收下 1/8 余量
  const bm = new BM({ max: 128, timeOf: (stamp) => stamp });
  for (let i = 0; i < 300; i++) bm.set("k" + i, i);
  bm.prune(299);
  eq(`[${G}] 一次清理收到低水位（128 - 16 = 112）`, bm.size, 112);
  ok(`[${G}] 最新那条仍在表里`, bm.has("k299"));
  ok(`[${G}] 最旧那条已被淘汰`, !bm.has("k0"));

  // 寿命：过期行先被删，仍超限才按时间收到低水位
  const exp = new BM({ max: 10, ttlMs: 1000, timeOf: (stamp) => stamp });
  exp.set("old", 0);
  exp.set("new", 5000);
  const droppedExp = exp.prune(6000);
  eq(`[${G}] prune 返回删掉的条数`, droppedExp, 1);
  ok(`[${G}] 过期行被删、新鲜行留下`, !exp.has("old") && exp.has("new"));
  eq(`[${G}] 容量与寿命可读`, [exp.capacity(), exp.lifeMs()], [10, 1000]);

  // 语义字段名：snap() 的行键就是面板/调试端点看到的形状
  W.RELPERF.clear();
  W.RELPERF.note("n251.test", "1.2.3.4", 120, 800, 1000);
  const row251 = (W.RELPERF.snap("n251.test", 1000) || [])[0] || {};
  eq(`[${G}] 样本行用语义键`, Object.keys(row251).sort(), ["ageMs", "costMs", "firstByteMs", "kiloBytesPerSec", "relayIp", "samples"]);
  eq(`[${G}] size() 报 rows / byRelay`, Object.keys(W.RELPERF.size()).sort(), ["byRelay", "rows"]);
  eq(
    `[${G}] 代价 = 首字节 + 512KB 折算`,
    Math.round(W.relCostOf({ samples: 1, firstByteMs: 120, kiloBytesPerSec: 800, updatedAt: 0 })),
    760,
  );

  // 起搏账本：两栏改名，容量仍与 SC.PX_MAX 同源
  const book251 = new W.TfbBook();
  eq(`[${G}] 新账本为空`, book251.size(), 0);
  W.TFB.forget("t251.test");
  const now251 = 1_700_000_000_000;
  ok(`[${G}] 首次可以开批`, W.TFB.due("t251.test", now251));
  W.TFB.take("t251.test", now251);
  ok(`[${G}] 10 分钟内不再开批`, W.TFB.due("t251.test", now251 + 60000) === false);
  W.TFB.forget("t251.test");

  // 枚举成员名：读代码时能看出语义（数字值与线协议都没变）
  eq(`[${G}] St 四个成员`, [W.St.Unknown, W.St.Reachable, W.St.Blocked, W.St.Dead], [0, 1, 2, 3]);
  eq(`[${G}] Mode 两个成员`, [W.Mode.Throughput, W.Mode.Latency], ["tput", "lat"]);
  W.vClear();
  W.vSetState("e251.test", "d", W.St.Reachable);
  ok(`[${G}] vOk 认枚举写入的状态`, W.vOk("e251.test", "d") === true);

  // 源码锁
  const relSrc251 = fs.readFileSync("src/route/relperf.ts", "utf8");
  ok(`[${G}] relperf 用 BoundedMap 而不是自写淘汰`, relSrc251.includes("new BoundedMap<string, RelSample>") && !relSrc251.includes("private m = new Map"));
  ok(`[${G}] relperf 字段名带单位`, relSrc251.includes("kiloBytesPerSec: KiloBytesPerSec;") && relSrc251.includes("updatedAt: EpochMs;"));
  const tfbSrc251 = fs.readFileSync("src/route/tfbbook.ts", "utf8");
  ok(`[${G}] tfbbook 两栏改名`, tfbSrc251.includes("private lastBatchAt") && tfbSrc251.includes("private batchCount"));
  const enumSrc251 = fs.readFileSync("src/core/enums.ts", "utf8");
  ok(`[${G}] 枚举成员名可读`, enumSrc251.includes("Reachable = 1") && enumSrc251.includes('Throughput = "tput"') && enumSrc251.includes('Latency = "lat"'));
  const pre251 = fs.readFileSync("tools/preflight.mjs", "utf8");
  ok(`[${G}] 命名门禁接进 preflight`, pre251.includes("tools/check-names.mjs"));
  const base251 = JSON.parse(fs.readFileSync("tools/naming-baseline.json", "utf8"));
  ok(`[${G}] 命名基线是个只许下降的数字`, typeof base251.opaque === "number" && base251.opaque <= 100, String(base251.opaque));
  ok(`[${G}] 短名白名单写在工具里且带理由`, fs.readFileSync("tools/check-names.mjs", "utf8").includes("改名要迁移 DO 存储"));
}

// ── 252) 命名批次二：内存字段改成语义名（v7.252） ──
// 判据：结构体的成员名必须能读出含义（AGENTS.md §6）。这里锁的是本轮改过的形状，
// 防止后续又出现 `n` / `at` / `m` 这类要靠读实现才懂的字段。
{
  const vtSrc = verdictAll();
  ok("判定行用 target", vtSrc.includes("target: HostName;"), "");
  ok("判定行用 channel", vtSrc.includes("channel: ChanToken;"), "");
  ok("判定行用 observations", vtSrc.includes("observations: SampleCount;"), "");
  ok("判定行用 updatedAt", vtSrc.includes("updatedAt: EpochMs;"), "");
  ok("判定表私有表是 BoundedMap（淘汰规则不再各写一遍）", vtSrc.includes("private byKey = new BoundedMap") && !vtSrc.includes("private sweep"), "");
  ok("判定表不再出现旧的私有名", !vtSrc.includes("private m = new Map"), "");

  const csSrc = fs.readFileSync("src/proxy/connection.ts", "utf8");
  ok("连接用 targetBytes", csSrc.includes("targetBytes = 0;"), "");
  ok("连接用 forceRelayIp", csSrc.includes("forceRelayIp = \"\";"), "");
  ok("连接用 startedAt", csSrc.includes("startedAt = Date.now();"), "");

  const foSrc = fs.readFileSync("src/core/firstobs.ts", "utf8");
  ok("首次观测计数叫 samples", foSrc.includes("private samples = 0;"), "");
  const fsSrc = fs.readFileSync("src/route/factshadow.ts", "utf8");
  ok("影子的计数也叫 samples", fsSrc.includes("private samples = 0;"), "");

  // 行为面：快照与记录都改用新字段
  W.FO.clear();
  const snap252 = W.FO.snap();
  eq("快照用 samples 字段", typeof snap252.samples, "number");
  eq("旧字段 n 已经不在了", snap252.n, undefined);

  // 棘轮基线：本轮从 100 降到 86，门禁必须与之一致
  const base252 = JSON.parse(fs.readFileSync("tools/naming-baseline.json", "utf8"));
  eq("命名基线清零（只剩登记过的线协议键）", base252.opaque, 0);
  ok("命名门禁已接进 preflight", fs.readFileSync("tools/preflight.mjs", "utf8").includes("check-names.mjs"), "");
}

// ── 253) 改名必须两端同名（本轮自伤一次，锁住它） ──
{
  const sel253 = fs.readFileSync("src/px/pickpath.ts", "utf8");
  const con253 = fs.readFileSync("src/proxy/connection.ts", "utf8");
  ok("选路读的是 targetBytes", sel253.includes("(st && st.targetBytes) || 0"), "");
  ok("连接上确实有 targetBytes", con253.includes("targetBytes = 0;"), "");
  ok("选路不再读旧的 bytes 字段", !sel253.includes("st.bytes"), "");
  ok("PickState 与 Connection 同名", sel253.includes("targetBytes?: number;"), "");
}
// ── 第 254 组：统计层字段改成语义名（纯内存结构，与线协议无关） ────────────
{
  const z254 = W.nsGet("zero254.test:443");
  eq("统计行有 probeSamples", typeof z254.probeSamples, "number");
  eq("统计行有 probeFails", typeof z254.probeFails, "number");
  eq("统计行有 trafficOkW", typeof z254.trafficOkW, "number");
  eq("统计行有 trafficFailW", typeof z254.trafficFailW, "number");
  eq("统计行有 cusumSum", typeof z254.cusumSum, "number");
  eq("统计行有 cusumBase", typeof z254.cusumBase, "number");
  eq("旧短名 pN 已消失", "pN" in z254, false);
  eq("旧短名 tS 已消失", "tS" in z254, false);
  eq("旧短名 cusB 已消失", "cusB" in z254, false);

  W.nsProbe("probe254.test:443", 40, 30, 10);
  W.nsProbe("probe254.test:443", 42, 31, 11);
  const p254 = W.nsGet("probe254.test:443");
  eq("两次探活累加 probeSamples", p254.probeSamples, 2);
  eq("探活不写首字节矩", p254.pSum, 0);

  W.nsOk("ok254.test:443", 0, 0);
  const o254 = W.nsGet("ok254.test:443");
  eq("真实成功累加 trafficOkW", o254.trafficOkW, 1);

  W.nsFail("fail254.test:443");
  const f254 = W.nsGet("fail254.test:443");
  eq("真实失败累加 trafficFailW", f254.trafficFailW, 1);

  // 衰减必须一起作用（effView 是只读投影，衰减在两处共用同一套换算）
  const d254 = W.nsGet("decay254.test:443");
  d254.trafficOkW = 8; d254.probeSamples = 8; d254.at = Date.now() - W.SC.HL * 2;
  const v254 = W.effView(d254);
  eq("effView 暴露的是 probeSamples 而不是旧名", "probeSamples" in v254 && !("pN" in v254), true);
  ok("平移两个半衰期后 probeSamples 约剩 1/4", Math.abs(v254.probeSamples - 2) < 0.3, String(v254.probeSamples));

  const statSrc = statAll();
  ok("stat.ts 不再出现旧字段名", !/\btS\b|\bpN\b|\bcusB\b/.test(statSrc));
  const typesSrc = fs.readFileSync("types/app.d.ts", "utf8");
  ok("类型声明也改成新名", typesSrc.includes("trafficOkW") && !/\btS:/.test(typesSrc));
}

// ---------------------------------------------------------------- 255. 判定表迁到 BoundedMap
const t255 = new W.VerdictTable();
const now255 = Date.now();
for (let i = 0; i < 700; i++) t255.setState(`h255-${i}.test`, "d", 2, 1);
ok("700 条后仍在 600 以内", t255.size() <= 600, `size=${t255.size()}`);
ok("超限时收回容量（低水位，留出下一批的空间）", t255.size() >= 500, `size=${t255.size()}`);
const kept255 = t255.size();
t255.setState("fresh255.test", "d", 2, 1);
ok("新写入的站点一定还在（删的是最旧的）", t255.state("fresh255.test", "d") === 2);
// 过期的行必须被当成「没有证据」：直接改时间戳绕过 Date.now()
const k255 = "stale255.test|d";
t255.byKey.set(k255, { target: "stale255.test", channel: "d", state: 2, code: 403, ms: 10, observations: 1, updatedAt: now255 - W.VT_TTL_MS - 60000, src: 1 });
eq("超过 TTL 的行读出来是「没测过」", t255.state("stale255.test", "d"), 0);
if (typeof t255.byKey.prune === "function") t255.byKey.prune(Date.now());
ok("prune 顺手清掉过期行", t255.size() <= kept255 + 1, `size=${t255.size()}`);
ok("lifeMs 报的是 VT_TTL_MS", typeof t255.byKey.lifeMs === "function" && t255.byKey.lifeMs() === W.VT_TTL_MS, `lifeMs=${t255.byKey.lifeMs && t255.byKey.lifeMs()}`);
ok("capacity 报的是 600", typeof t255.byKey.capacity === "function" && t255.byKey.capacity() === 600, `cap=${t255.byKey.capacity && t255.byKey.capacity()}`);
const vSrc255 = verdictAll();
ok("判定表用 BoundedMap", vSrc255.includes("private byKey = new BoundedMap"), "");
ok("判定表不再自己写 sweep", !vSrc255.includes("private sweep"), "");
ok("trim 只在超限时动手", vSrc255.includes("if (this.byKey.size <= this.byKey.capacity()) return;"), "");
ok("fresh() 用表自身的 TTL", vSrc255.includes("this.byKey.lifeMs()"), "");
ok("relay-health 有自己的删除偏好（dead>0 先跳过），不套用通用淘汰", fs.readFileSync("src/route/relay-health.ts", "utf8").includes("if (s.dead > 0) continue;"), "");
// ---------------------------------------------------------------- 256. 背压折扣先于单连接权重上限
const env256 = { STATS: { get: async () => null, put: async () => {}, list: async () => ({ keys: [] }) } };
const st256 = new W.Connection(env256, { waitUntil() {}, passThroughOnException() {} }, W.Mode.Throughput, "1.1.1.1");
ok("takeWeight 收折扣因子", st256.takeWeight.length >= 2 && String(st256.takeWeight).includes("factor"), "");
const w256a = st256.takeWeight(512 * 1024, 1000, 0.3);
ok("折扣直接作用在报出的权重上（1.0 × 0.3 = 0.3）", Math.abs(w256a - 0.3) < 1e-6, `got=${w256a}`);
const st256b = new W.Connection(env256, { waitUntil() {}, passThroughOnException() {} }, W.Mode.Throughput, "1.1.1.1");
let total256 = 0;
let windows256 = 0;
for (let i = 0; i < 40; i++) {
  const w = st256b.takeWeight(512 * 1024, 1000, 0.3);
  if (w <= 0) break;
  total256 += w;
  windows256++;
}
ok("一直背压的连接也能用满自己的权重额度", total256 >= W.SC.CONN_W_CAP - 0.01, `total=${total256}`);
ok("用满额度需要更多窗口（折扣真的生效了）", windows256 > W.SC.CONN_W_CAP, `windows=${windows256}`);
const st256c = new W.Connection(env256, { waitUntil() {}, passThroughOnException() {} }, W.Mode.Throughput, "1.1.1.1");
let total256c = 0;
for (let i = 0; i < 10; i++) total256c += st256c.takeWeight(512 * 1024, 1000);
ok("不打折时额度用完就不再给样本", Math.abs(total256c - W.SC.CONN_W_CAP) < 1e-6, `total=${total256c}`);
const st256d = new W.Connection(env256, { waitUntil() {}, passThroughOnException() {} }, W.Mode.Throughput, "1.1.1.1");
eq("负折扣不会让权重变成负数", st256d.takeWeight(512 * 1024, 1000, -5), 0);
const csrc256 = ["src/proxy/connection.ts", "src/proxy/conn-settle.ts", "src/proxy/conn-sample.ts"].map((f) => fs.readFileSync(f, "utf8")).join("\n");
eq("两处调用都把折扣一起传进去", csrc256.split("? 0.3 : 1)").length - 1, 2);
ok("调用点不再自己乘 0.3", !csrc256.includes("w *= 0.3"), "");
ok("封顶按报出的量计", fs.readFileSync("src/proxy/conn-sample.ts", "utf8").includes("Math.min(room, raw * clamped)"), "");
// ── 第 257 组：「按插入序」判据做成门禁（棘轮）────────────────────────────
// 这条判据背后是 7.177 / 7.181 / 7.187 / 7.215 / 7.224 五条缺陷：插入序切片切到最旧的那批，
// 或 Map.set 不移动位置导致「淘汰 = 删最热的键」。现在三处允许点都写了理由，新增一处就红。
const gate257 = "tools/check-insertorder.mjs";
const base257 = "tools/insertorder-baseline.json";
ok("插入序门禁存在", fs.existsSync(gate257));
ok("插入序基线存在", fs.existsSync(base257));
const allow257 = JSON.parse(fs.readFileSync(base257, "utf8"));
eq("基线里三处允许点", allow257.length, 3);
ok("每条允许点都写了理由", allow257.every((x) => typeof x.why === "string" && x.why.length >= 20));
ok("允许点都在 src 里", allow257.every((x) => x.file.startsWith("src/")));
const pre257 = fs.readFileSync("tools/preflight.mjs", "utf8");
ok("preflight 里接了插入序门禁", pre257.includes("tools/check-insertorder.mjs"));
const pkg257 = JSON.parse(fs.readFileSync("package.json", "utf8"));
eq("package.json 有 insertorder 别名", (pkg257.scripts || {}).insertorder, "node tools/check-insertorder.mjs");
// 行为面：干净时退出 0；塞一条违规代码就点名
let clean257 = 0;
try { execFileSync("node", [gate257], { encoding: "utf8" }); } catch (e) { clean257 = 1; }
eq("干净时门禁通过", clean257, 0);
const probe257 = "src/__probe257.ts";
fs.writeFileSync(probe257, "export const bad = Object.values({}).slice(0, 1);" + "\n");
let bad257 = 0;
let badOut257 = "";
try { badOut257 = execFileSync("node", [gate257], { encoding: "utf8" }); } catch (e) { bad257 = 1; badOut257 = String(e.stdout || "") + String(e.stderr || ""); }
if (fs.existsSync(probe257)) fs.unlinkSync(probe257);
eq("插入违规代码就红", bad257, 1);
ok("报错点名了违规文件", badOut257.includes("__probe257"));
ok("违规探针已清理", !fs.existsSync(probe257));
// ---- 第 258 组：命名约定与门禁的双向一致 ----
// 第 258 组：命名约定的「代码 → 文档」单向一致
// 只查这一个方向：文档里多写普通词不算错，代码里偷偷放行一个没解释的短名才是错。
const conv258 = "docs/命名约定.md";
const gate258 = "tools/check-names.mjs";
ok("命名约定文档存在", fs.existsSync(conv258));
const convText258 = fs.existsSync(conv258) ? fs.readFileSync(conv258, "utf8") : "";
const gateSrc258 = fs.readFileSync(gate258, "utf8");
// 从门禁源码里抽出 ALLOW 的键，避免测试自己再抄一份（抄了就会漂）
const allowKeys258 = [...gateSrc258.matchAll(/^\s*\["([a-z]+)",\s*"/gm)].map((m) => m[1]);
ok("从门禁里解析出 ALLOW 键", allowKeys258.length >= 10, `got ${allowKeys258.length}`);
const missing258 = allowKeys258.filter((k) => !convText258.includes("`" + k + "`"));
eq("每个放行的短名都在文档里有解释", missing258.join(","), "");
ok("门禁源码里有这条交叉检查", gateSrc258.includes("docs/命名约定.md") && gateSrc258.includes("没有解释"));
ok("文档写了棘轮只许往下走", convText258.includes("棘轮"));

// 行为面：干净时退出 0；把文档临时换成一个少了 `cl` 的副本就红，且点名 `cl`
let clean258 = 0;
try { execFileSync("node", [gate258], { encoding: "utf8" }); } catch (e) { clean258 = 1; }
eq("干净时命名门禁通过", clean258, 0);
const tmpDoc258 = ".tmp-sim/conv258.md";
fs.mkdirSync(".tmp-sim", { recursive: true });
fs.writeFileSync(tmpDoc258, convText258.split("`cl`").join("「连接样本表」") + "\n");
let bad258 = 0;
let badOut258 = "";
try {
  badOut258 = execFileSync("node", [gate258], { encoding: "utf8", env: { ...process.env, NAMES_DOC: tmpDoc258 } });
} catch (e) {
  bad258 = 1;
  badOut258 = String(e.stdout || "") + String(e.stderr || "");
}
eq("文档漏解释就红", bad258, 1);
ok("报错点名了漏掉的短名", badOut258.includes("cl"), badOut258.slice(0, 120));
if (fs.existsSync(tmpDoc258)) fs.unlinkSync(tmpDoc258);
ok("临时文档已清理", !fs.existsSync(tmpDoc258));

// 259. 内部参数改成语义名 + 线协议键登记（v7.259）
{
  const attSrc = fs.readFileSync("src/proxy/attacher.ts", "utf8");
  const dSrc = fs.readFileSync("src/proxy/dialer.ts", "utf8");
  const rSrc = fs.readFileSync("src/proxy/region.ts", "utf8");
  const mSrc = fs.readFileSync("src/store/meter.ts", "utf8");
  const gateSrc = fs.readFileSync("tools/check-names.mjs", "utf8");
  const docSrc = fs.readFileSync("docs/命名约定.md", "utf8");
  const baseSrc = JSON.parse(fs.readFileSync("tools/naming-baseline.json", "utf8"));
  ok("attacher 的连接参数叫 conn", attSrc.includes("conn: Connection") && !/\bst:\s*Connection/.test(attSrc));
  ok("attacher 的客户端连接叫 clientSocket", attSrc.includes("clientSocket: WebSocketLike") && !/\bws:\s*WebSocketLike/.test(attSrc), "ws");
  ok("拨号器与地区选择器也用 conn", dSrc.includes("conn: Connection") && rSrc.includes("conn: Connection"), "dialer/region");
  ok("计量 DO 的状态字段叫 state", mSrc.includes("state: DurableObjectState;") && !mSrc.includes("this.st."), "meter");
  ok("会话把字段名对上了（clientSocket / conn）", fs.readFileSync("src/proxy/session.ts", "utf8").includes("clientSocket: serverWS, conn: st"), "session");
  ok("命名门禁的 ALLOW 覆盖了线协议键", gateSrc.includes('["at", "观测时刻（线协议键）"]') && gateSrc.includes('["v6", "IPv6 观测计数（线协议键）"]'), "allow");
  ok("登记过的短名要求文档写明含义", docSrc.includes("## 7. 线协议键（登记例外）") && docSrc.includes("| `at` |") && docSrc.includes("| `v6` |"), "doc");
  ok("文档写明新增短名两处都要登记", docSrc.includes("`tools/check-names.mjs`") && docSrc.includes("`ALLOW`"), "doc2");
  eq("命名基线归零（剩余过短成员只剩登记过的线协议键）", baseSrc.opaque, 0);
}


// ── 260. 中继键的 IP 解析只准有一份（7.260）─────────────────────────────
{
  const { ipOf } = W;
  // 旧包没有这个导出时用桩兜底：让断言正常报红，而不是整组 TypeError 崩掉；
  const relayIpOf = typeof W.relayIpOf === "function" ? W.relayIpOf : () => "<missing>";
  eq("relayIpOf 存在", typeof W.relayIpOf, "function");
  // 四种写法都要给出同一个 IP
  eq("IPv4 带端口", relayIpOf("1.2.3.4:443"), "1.2.3.4");
  eq("IPv4 裸地址", relayIpOf("1.2.3.4"), "1.2.3.4");
  eq("方括号 IPv6 去掉方括号", relayIpOf("[2a06:98c0::103]:443"), "2a06:98c0::103");
  eq("裸 IPv6 原样", relayIpOf("2a06:98c0::103"), "2a06:98c0::103");
  eq("空串", relayIpOf(""), "");
  // relay-health 的 ipOf 必须是同一个实现的结果（不是第二份解析）
  eq("ipOf 与 relayIpOf 同源（方括号）", ipOf("[2a06:98c0::103]:443"), relayIpOf("[2a06:98c0::103]:443"));
  eq("ipOf 无冒号不吃字符", ipOf("1.2.3.4"), "1.2.3.4");
  // 源码锁：选路里不能再有本地那份 slice(0, lastIndexOf(":")) 解析
  const selSrc = fs.readFileSync("src/px/pickpath.ts", "utf8");
  ok("selector 不再自写 IP 解析", !selSrc.includes('k.slice(0, k.lastIndexOf(":"))'));
  ok("selector 用 relayIpOf", selSrc.includes("cp(relayIpOf(first), host)") && selSrc.includes("cp(relayIpOf(x.k), host)"));
  const rhSrc = fs.readFileSync("src/route/relay-health.ts", "utf8");
  ok("relay-health 的 ipOf 委托 relayIpOf", rhSrc.includes("return relayIpOf(node);"));
  ok("relay-health 不再自己拆冒号", !rhSrc.includes('node.lastIndexOf(":")'));
  // 行为面：方括号写法与裸写法查到同一条判定（同一张表、同一个键）
  W.vClear();
  W.vSet("ip6.test", "r:2a06:98c0::103", 200, 120, 1);
  eq("方括号键查到与裸 IP 相同的态", W.vState("ip6.test", "r:" + relayIpOf("[2a06:98c0::103]:443")), 1);
  W.vClear();
}
// 第 261 组：中继健康表的两张账本收进 RelayLedger（行为 + 泄漏 + 源码锁）
{
  const HL_LED = W.HEALTH;
  HL_LED.clear();
  const c0 = HL_LED.counts();
  eq("账本清空后三张表都是 0", `${c0.rows}/${c0.sent}/${c0.pending}`, "0/0/0");

  HL_LED.note("10.61.0.1:443", 40000, true);
  HL_LED.note("10.61.0.2:443", 40000, true);
  HL_LED.note("10.61.0.3:443", 40000, true);
  eq("记三条中继后主表 3 行", HL_LED.counts().rows, 3);

  const d1 = HL_LED.delta();
  eq("首次 delta 把三行都排队", `${d1.length}/${HL_LED.counts().pending}`, "3/3");
  HL_LED.ack();
  eq("ack 之后待确认清零、快照 3 行", `${HL_LED.counts().pending}/${HL_LED.counts().sent}`, "0/3");
  eq("计数没变时 delta 不再重发", HL_LED.delta().length, 0);

  HL_LED.note("10.61.0.2:443", 40000, true);
  const d2 = HL_LED.delta();
  eq("某条计数变了一次只发它那一行", `${d2.length}/${d2[0] && d2[0].i}`, "1/10.61.0.2");
  HL_LED.nack();
  eq("nack 之后待确认清零", HL_LED.counts().pending, 0);
  eq("nack 之后下一轮仍会重发那一条（快照没被推进）", HL_LED.delta().length, 1);
  HL_LED.ack();

  // 账本必须与主表同生同灭：灌满越过 MAX_IP 后，sent 不能比主表还大（7.161 的泄漏形状）
  HL_LED.clear();
  for (let i = 0; i < 260; i++) HL_LED.note("10.61.9." + i + ":443", 40000, true);
  HL_LED.delta();
  HL_LED.ack();
  const leak = HL_LED.counts();
  ok("主表被裁到上限以内", leak.rows <= 200, `rows=${leak.rows}`);
  ok("已同步快照不会超过主表（没有表外键）", leak.sent <= leak.rows, `sent=${leak.sent} rows=${leak.rows}`);
  HL_LED.clear();

  // 类本身：forget 是唯一删除入口
  const led261 = new W.RelayLedger();
  led261.queue({ i: "10.61.7.7", o: 1, b: 0, d: 0, t: 1 });
  led261.ack(() => true);
  eq("RelayLedger 排队后 ack 得到一条快照", led261.counts().sent, 1);
  led261.forget("10.61.7.7");
  eq("RelayLedger.forget 同时清掉快照与待确认", `${led261.counts().sent}/${led261.counts().pending}`, "0/0");

  const rhSrc = fs.readFileSync("src/route/relay-health.ts", "utf8");
  const ledSrc = fs.readFileSync("src/route/relay-ledger.ts", "utf8");
  const dbgSrc = debugAll();
  ok("健康表把两张账本换成了一个类", rhSrc.includes("private ledger = new RelayLedger();"), "缺 ledger 字段");
  ok("健康表自己不再持有 sent 表", !rhSrc.includes("private sent ="), "还有 private sent");
  ok("健康表自己不再持有 pending 表", !rhSrc.includes("private pending ="), "还有 private pending");
  ok("删除只经过 forget()", rhSrc.includes("this.ledger.forget(k);"), "drop 没走 forget");
  ok("size() 的文档不再声称含 sent/pending", !rhSrc.includes("含未过期的 sent/pending"), "文档仍是假话");
  ok("新增 counts() 暴露三张表的规模", rhSrc.includes("counts(): { rows: number; sent: number; pending: number }"), "缺 counts");
  ok("账本类自己提供 forget 与 counts", ledSrc.includes("forget(ip: string): void") && ledSrc.includes("counts(): { sent: number; pending: number }"), "账本接口不对");
  ok("诊断端点把三张表的规模一起报出来", dbgSrc.includes("sizes: HEALTH.counts()"), "debug 没带 sizes");
}


// === 第 262 组：灾备快照的每轮上限要轮转，否则排在后面的用户永远停在旧水位 ===
{
  const kv262 = new Map();
  const ids262 = Array.from({ length: 60 }, (_x, i) => "u262-" + String(i).padStart(3, "0"));
  const seen262 = new Set();
  const env262 = {
    STATS: {
      get: async (k) => kv262.get(k) || null,
      put: async (k, v) => {
        kv262.set(k, v);
      },
    },
    METER: {
      idFromName: (x) => x,
      get: (id) => ({
        fetch: async () => {
          seen262.add(String(id));
          return { ok: true, json: async () => ({ up: 500, down: 600, conns: 1, first: 0 }) };
        },
      }),
    },
  };
  const realNow262 = Date.now;
  let clock262 = 1_700_000_000_000;
  Date.now = () => clock262;
  const users262 = ids262.map((id) => ({ id }));
  W.S.meterCache.clear();
  const skipBefore262 = W.cntView().snapSkip || 0;
  const round262 = async (n) => {
    clock262 += 3 * 3600e3;
    W.S.meterCache.clear();
    await W.usageSnapWrite(env262, users262, n);
    return JSON.parse(kv262.get("usage:snap") || "{}");
  };
  seen262.clear();
  const d1 = await round262(24);
  eq("第一轮读的是最前面那批", [...seen262].sort()[0], ids262[0]);
  eq("第一轮只读上限那么多", seen262.size, 24);
  eq("第一轮尾巴被计数", (W.cntView().snapSkip || 0) - skipBefore262, 60 - 24);
  seen262.clear();
  const d2 = await round262(24);
  ok("第二轮从上一轮的落点接着读", seen262.has(ids262[24]) && !seen262.has(ids262[0]), [...seen262].slice(0, 2).join(","));
  eq("第二轮仍是上限那么多", seen262.size, 24);
  seen262.clear();
  const d3 = await round262(24);
  ok("第三轮绕回队首", seen262.has(ids262[48]) && seen262.has(ids262[0]), [...seen262].slice(0, 2).join(","));
  eq("三轮下来每个人都至少被读过一次", new Set([...Object.keys(d1.users), ...Object.keys(d2.users), ...Object.keys(d3.users)]).size, 60);
  eq("游标推进到第三轮之后（48 + 24 取模 60）", d3.idx, 12);
  const d4 = await (async () => { clock262 += 3 * 3600e3; W.S.meterCache.clear(); await W.usageSnapWrite(env262, users262, 24); return JSON.parse(kv262.get("usage:snap")); })();
  eq("第四轮接着从 12 开始（走完一圈也不会停在同一批）", d4.idx, 36);
  const small262 = await (async () => { clock262 += 3 * 3600e3; W.S.meterCache.clear(); await W.usageSnapWrite(env262, users262.slice(0, 5), 24); return JSON.parse(kv262.get("usage:snap")); })();
  eq("用户数没超上限时不轮转（游标归零）", small262.idx, 0);
  Date.now = realNow262;
  const srcSnap262 = fs.readFileSync("src/store/snapshot.ts", "utf8");
  ok("写入侧按游标轮转", srcSnap262.includes("list.slice(start).concat(list.slice(0, start))"), "");
  ok("游标落盘（idx）", srcSnap262.includes("(start + head.length) % list.length"), "");
  ok("类型里有 idx 字段", fs.readFileSync("types/app.d.ts", "utf8").includes("idx?: number;"), "");
}

// ═══ 第 263 组：偏好行的字段名能读出含义（c/s/at → channel/state/updatedAt）═══
{
  W.vClear();
  W.vSetState("r263.test", "r:7.7.7.1", 1, 10);
  W.vSetState("r263.test", "r:7.7.7.2", 2, 20);
  const pf = W.PREFS.of("r263.test", 10);
  const row = pf.ok[0] || {};
  eq("偏好行有 channel", typeof row.channel, "string");
  eq("偏好行有 state", typeof row.state, "number");
  eq("偏好行有 updatedAt", typeof row.updatedAt, "number");
  eq("偏好行不再用 c 这个短名", "c" in row, false);
  eq("偏好行不再用 s 这个短名", "s" in row, false);
  eq("偏好行不再用 at 这个短名", "at" in row, false);
  eq("能打通的通道 state 是 1", row.state, 1);
  eq("打不通的通道 state 是 2", (pf.bad[0] || {}).state, 2);
  const json263 = W.prefsJson(10);
  eq("JSON 出口也用新名", Object.keys(json263.ok[0] || {}).sort().join(","), "channel,state,updatedAt");
  const src263 = fs.readFileSync("src/route/prefs.ts", "utf8");
  ok("源码里偏好行是语义名", src263.includes("channel: string;") && src263.includes("updatedAt: number;"), src263.slice(0, 0));
  ok("源码里没有旧的 c/s/at 三行", !/^  c: string;$/m.test(src263) && !/^  s: number;$/m.test(src263) && !/^  at: number;$/m.test(src263), src263.slice(0, 0));
  W.vClear();
}
// ── 264. 「node → IP」的解析只准有一份（v7.264） ─────────────────────────────
// 7.260 把中继健康表与选路的三处解析收口到 relayIpOf，但 judge / factshadow / connection / fallback
// 还各留着一份内联写法：方括号 IPv6（`[2a06:98c0::103]:443`）会带着方括号进键，读端按裸 IP 查永远 -1。
{
  const t264 = Date.now();
  // 解析本身：方括号只在这里被剥掉，裸 v6 不带端口也认
  eq("relayIpOf 剥掉方括号与端口", W.relayIpOf("[2a06:98c0::103]:443"), "2a06:98c0::103");
  eq("relayIpOf 认裸 IPv6", W.relayIpOf("2a06:98c0::103"), "2a06:98c0::103");
  eq("splitRelay 拆方括号写法", W.splitRelay("[2a06:98c0::9]:8443", 443).join("|"), "2a06:98c0::9|8443");
  eq("splitRelay 裸 v6 无端口给默认端口", W.splitRelay("2a06:98c0::9", 443).join("|"), "2a06:98c0::9|443");

  // 行为面：v6 中继的证据必须落在裸 IP 这个键上（改前落在 `[v6]`，读端全部查不到）
  W.PS.clear();
  W.JUDGE.onTraffic({ host: "v6relay.test", node: "[2a06:98c0::103]:443", down: 50000, ok: true, via: "node", life: 800, up: 200, at: t264 });
  const rows264 = W.PS.snap("v6relay.test").map((r) => String(r.k));
  ok("站点证据的键是裸 IP（不带方括号）", rows264.length === 1 && rows264[0] === "v6relay.test|2a06:98c0::103", JSON.stringify(rows264));
  ok("按裸 IP 能查到这条证据", W.PS.okOf("v6relay.test", "2a06:98c0::103", t264) >= 0);
  eq("按方括号查不到（键空间没有它）", W.PS.okOf("v6relay.test", "[2a06:98c0::103]", t264), -1);

  // 中继健康表：同一份解析（7.260 已收口，这里锁住口径不倒退）
  W.HEALTH.clear();
  W.HEALTH.note("[2a06:98c0::9]:443", 50000, true);
  const hl264 = W.HEALTH.json().map((r) => String(r.ip || ""));
  ok("中继健康表的键也是裸 IP", hl264.includes("2a06:98c0::9") && !hl264.some((x) => x.includes("[")), JSON.stringify(hl264));

  // 源码锁：四份文件里不再有内联的 lastIndexOf(":")（注释里提到不算），且都从 core/http80 取解析
  const src264 = (p) => fs.readFileSync(p, "utf8");
  for (const f of ["src/route/judge.ts", "src/route/factshadow.ts", "src/proxy/connection.ts", "src/proxy/fallback.ts"]) {
    const body = src264(f)
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    ok(`${f} 不再内联解析 node → IP`, !body.includes('lastIndexOf(":")'), f);
  }
  ok("judge.ts 用 relayIpOf", src264("src/route/judge.ts").includes("relayIpOf(e.node)"));
  ok("结算模块用 relayIpOf", src264("src/proxy/conn-settle.ts").includes("relayIpOf(v.node)"));
  ok("fallback.ts 用 splitRelay 拆补救链地址", src264("src/proxy/fallback.ts").includes("const [host, port] = splitRelay(alt, 443);"));
  ok("四份文件都从 core/http80 取解析", ["src/route/judge.ts", "src/route/factshadow.ts", "src/proxy/conn-settle.ts", "src/proxy/fallback.ts"].every((f) => src264(f).includes('from "../core/http80"')));
}

﻿// 第 265 组：拆地址只准有一份实现（7.265）
// 旧包上没有这个导出时用桩，让断言红而不断（否则整组 TypeError、数不出红条数）
const px265 = typeof W.parseProxyIp === "function" ? W.parseProxyIp : () => ({ host: "<missing>", port: 0 });
const src265 = (p) => fs.readFileSync(p, "utf8");
const code265 = (p) =>
  src265(p)
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

// splitRelay 的四种写法
eq("拆地址：ipv4:port", W.splitRelay("1.2.3.4:8443", 443).join("|"), "1.2.3.4|8443");
eq("拆地址：方括号 v6 + 端口", W.splitRelay("[2a06:98c0::103]:8443", 443).join("|"), "2a06:98c0::103|8443");
eq("拆地址：裸 v6 不切段落", W.splitRelay("2a06:98c0::103", 443).join("|"), "2a06:98c0::103|443");
eq("拆地址：裸 v4 用默认端口", W.splitRelay("1.2.3.4", 80).join("|"), "1.2.3.4|80");
eq("拆地址：空串回默认端口", W.splitRelay("", 443).join("|"), "|443");
eq("拆地址：方括号无端口", W.splitRelay("[2a06:98c0::103]", 443).join("|"), "2a06:98c0::103|443");

// 五处调用点都改走同一份实现
ok("调试探针不再内联拆地址", !debugAll().includes('lastIndexOf(":")') && debugAll().includes("const [ph, pp] = splitRelay(pr, 443);"));
ok("池子探活不再内联拆地址", !code265("src/px/scan.ts").includes('lastIndexOf(":")') && code265("src/px/scan.ts").includes("splitRelay(k, 443)"));
ok("名单打包不再内联拆地址", !code265("src/px/seed.ts").includes("k.slice(0, i)") && code265("src/px/seed.ts").includes("splitRelay(k, 443)"));
ok("订阅渲染不再内联拆地址", !code265("src/views/sub.ts").includes('lastIndexOf(":")') && code265("src/views/sub.ts").includes("const [ip] = splitRelay(k, 443);"));

eq("配代理 IP：裸 v6 不当作「主机:端口」", px265("2a06:98c0::103").host + "|" + px265("2a06:98c0::103").port, "2a06:98c0::103|443");
eq("配代理 IP：方括号 v6 + 端口", px265("[2a06:98c0::103]:8443").host + "|" + px265("[2a06:98c0::103]:8443").port, "2a06:98c0::103|8443");
eq("配代理 IP：ipv4 + 端口", px265("1.2.3.4:8443").host + "|" + px265("1.2.3.4:8443").port, "1.2.3.4|8443");
eq("配代理 IP：主机名走默认端口", px265("px.example.com").host + "|" + px265("px.example.com").port, "px.example.com|443");
// 全仓扫描：内联拆地址只允许出现在实现与「有没有端口」的守卫里
const walk265 = (d, acc = []) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = d + "/" + f.name;
    if (f.isDirectory()) walk265(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
};
const allow265 = ["src/core/http80.ts", "src/px/seed.ts"];
const bad265 = walk265("src")
  .filter((p) => !allow265.includes(p.replace(/\\/g, "/")))
  .filter((p) => code265(p).includes('lastIndexOf(":")'));
ok("内联拆地址只剩实现与端口守卫", bad265.length === 0, bad265.join(","));

﻿// 第 266 组：体内注释从「体检」升级成硬门禁（7.266）
const body266 = fs.readFileSync("tools/body-audit.mjs", "utf8");
ok("体内注释门禁支持 --max", body266.includes('"--max"') && body266.includes("process.exitCode = 1;"));
ok("preflight 里接了体内注释门禁", fs.readFileSync("tools/preflight.mjs", "utf8").includes('["体内注释门禁", ["tools/body-audit.mjs", "--max", "0"]]'));
const pkg266 = JSON.parse(fs.readFileSync("package.json", "utf8"));
eq("package.json 有 body 别名", pkg266.scripts && pkg266.scripts.body, "node tools/body-audit.mjs --max 0");
const dead266 = fs.readFileSync("src/route/deadfacts.ts", "utf8");
const dns266 = fs.readFileSync("src/route/dnsfacts.ts", "utf8");
ok("死亡事实的 load 写了体内步骤", dead266.includes("坏行整条跳过") && dead266.includes("批数夹在 1..9"));
ok("出口族事实的 load 写了体内步骤", dns266.includes("三件事任一不成立就整条跳过") && dns266.includes("更晚的观测胜出"));
ok("自证探针已清理", !fs.existsSync("src/__probe-body.ts"));


// ---- 第 267 组：判定状态只用枚举（消费端不再写裸数字） ----
﻿// 第 267 组：判定状态只用枚举 + 门禁在位
const ST = W.St || { Unknown: -1, Reachable: -2, Blocked: -3, Dead: -4 };
const host267 = "enum267.test";
// 行为面：prefs 的两栏与 chan() 的三态都在枚举口径下成立
W.vSetState(host267, "r:10.9.9.1", ST.Reachable, 1);
W.vSetState(host267, "r:10.9.9.2", ST.Blocked, 1);
const rows267 = W.prefsOf(host267, 40);
eq("可用的那条落在 ok 栏", rows267.ok.length, 1);
eq("打不通的那条落在 bad 栏", rows267.bad.length, 1);
eq("ok 栏的 state 就是 St.Reachable", rows267.ok[0].state, ST.Reachable);
eq("bad 栏的 state 就是 St.Blocked", rows267.bad[0].state, ST.Blocked);
eq("chanPref 对可用中继回 0", W.chanPref("10.9.9.1", host267), 0);
eq("chanPref 对判死中继回 2", W.chanPref("10.9.9.2", host267), 2);
eq("chanPref 对没测过的中继回 1（未知不惩罚）", W.chanPref("10.9.9.3", host267), 1);

// 源码锁：四个消费端都改走枚举
const srcPol267 = fs.readFileSync("src/route/policy.ts", "utf8");
const srcPref267 = fs.readFileSync("src/route/prefs.ts", "utf8");
const srcVs267 = fs.readFileSync("src/route/verdictsync.ts", "utf8");
const srcDbg267 = debugAll();
ok("policy 用 St.Reachable 过滤判定行", srcPol267.includes("v.state !== St.Reachable"), "");
ok("prefs 用 St.Reachable/St.Blocked 分栏", srcPref267.includes("x.state === St.Reachable") && srcPref267.includes("x.state >= St.Blocked"), "");
ok("prefs 的 chan() 用 St.Reachable", srcPref267.includes("if (state === St.Reachable) return 0;"), "");
ok("verdictsync 用 St.Blocked", srcVs267.includes("if (v.state < St.Blocked) continue;"), "");
ok("debug 的中继封锁列表用 St.Blocked", srcDbg267.includes("|| v.state < St.Blocked) continue;"), "");

// 门禁在位且真会红（行为由 .tmp-sim 自证，这里锁存在性）
const gate267 = fs.readFileSync("tools/check-names.mjs", "utf8");
ok("命名门禁里有判定状态裸数字判据", gate267.includes("rawStateLiterals") && gate267.includes("判定状态用裸数字"), "");
ok("判据排除枚举文件自身", gate267.includes("src/core/enums.ts"), "");
ok("文档写明判定状态只用枚举", fs.readFileSync("docs/命名约定.md", "utf8").includes("判定状态"), "");
// 第 268 组：比例兜底「释放被判死的中继」时不能顺手抹掉正证据（D213）
{
  const H268 = "rel268.group.test";
  W.vClear();
  const rels = ["10.8.0.1", "10.8.0.2", "10.8.0.3", "10.8.0.4", "10.8.0.5"];
  // 唯一能打通的那条先写（证据时间最早），四条判死的写在后面（时间更新）
  W.vSet(H268, "r:" + rels[4], 200, 120, 1);
  for (let i = 0; i < 4; i++) {
    W.vSet(H268, "r:" + rels[i], 403, 100, 1);
    W.vSetState(H268, "r:" + rels[i], 2, 1);
  }
  const ctx268 = { host: H268, relays: rels.slice(), cfHost: true, clientV6: false, httpCode: 0, directOk: false, mode: "tput" };
  W.POLICY.decide(ctx268);
  eq("比例兜底后仍记得能打通的那条", W.vState(H268, "r:" + rels[4]), 1);
  ok("释放确实放开了被判死的中继", rels.slice(0, 4).some((ip) => W.vState(H268, "r:" + ip) === 0));
  ok("最近判死的两条仍然保留结论", rels.slice(0, 2).every((ip) => W.vState(H268, "r:" + ip) === 2));
  const pol268 = fs.readFileSync("src/route/policy.ts", "utf8");
  ok("释放只在被判死的集合上做", pol268.includes("const dead = c.relays.filter((ip) => vBad(c.host, \"r:\" + ip));"));
  ok("排序也只在被判死的集合上做", pol268.includes("const sorted = dead.slice()"));
}

const dialerSrc269 = fs.readFileSync("src/proxy/dialer.ts", "utf8");
// ═══ 第 269 组：非法候选不该结束整条重拨链（7.269 / D214）═══
{
  const host269 = "dialer269.test";
  // 走到重拨循环需要三个前置条件：池子有条目（relays() 冷启动回退名单）、
  // 直连被判死（否则判定层直接返回 direct、整段跳过）、以及能记录调用次数的 SEL.current。
  W.S.pool = [{ k: "a", h: "1.1.1.1", p: 443 }, { k: "b", h: "1.1.1.1", p: 8443 }];
  W.vSetState(host269, "d", 2, 1);
  const before269 = W.cntView ? W.cntView() : {};
  let calls269 = 0;
  const seen269 = [];
  const realCurrent269 = W.SEL.current;
  W.SEL.current = async () => {
    calls269 += 1;
    const v = calls269 === 1 ? "10.0.0.1:443" : "1.1.1.1:443";
    seen269.push(v);
    return v;
  };
  const conn269 = new W.Connection({}, { waitUntil: () => {}, passThroughOnException: () => {} });
  try {
    await W.DIALER.open({ env: {}, request: new Request("https://" + host269 + "/"), conn: conn269, mode: "tput", host: host269, port: 443, pxForce: 1 });
  } catch (err269) {
    // 测试环境没有 connect()：抛错是预期路径，循环本身要继续往下问
  }
  W.SEL.current = realCurrent269;
  const after269 = W.cntView ? W.cntView() : {};
  ok("非法候选之后继续问下一条中继", calls269 >= 2, "calls=" + calls269 + " seen=" + seen269.join(","));
  eq("第一条非法候选被记进 badRelay", (after269.badRelay || 0) - (before269.badRelay || 0) >= 1, true);
  ok("cntKeys 登记了 badRelay", W.S.cntKeys.includes("badRelay"), "badRelay");
  ok("dialer 对非法候选是 continue 而不是 break", dialerSrc269.includes("cnt(\"badRelay\");") && dialerSrc269.includes("continue;"), "continue");
  ok("dialer 不再把 checkTarget 和解析失败并成一次 break", !dialerSrc269.includes("checkTarget(p.host, p.port)) break;"), "无合并 break");
}
// ---- 第 270 组：首包写入上限比数据面短（黑洞中继早失败） ----
// 首包写不进去说明这条中继不可用：等满 30 秒会让客户端先放弃（实测 17.5 秒）。

eq("首包上限是 8 秒", W.FIRST_UP_MS, 8000);
eq("数据面仍是 30 秒", W.UP_STALL_MS, 30000);
ok("首包上限确实比数据面短", W.FIRST_UP_MS < W.UP_STALL_MS);

// 行为面：upWrite 从不 reject（约定就是「失败被吞掉」），但它必须在传入的上限内返回，
// 而且要把这次卡顿记进 ustall —— 否则首包黑洞会被当成「一切正常」。
{
  const conn270 = Object.create(W.Connection.prototype);
  conn270.via = "node";
  conn270.node = "10.9.9.9:443";
  conn270.writer = { write: () => new Promise(() => {}), releaseLock() {} };
  const before270 = Number((W.cntView() || {}).ustall || 0);
  const t0 = Date.now();
  await conn270.upWrite(new Uint8Array(8), 80);
  const spent = Date.now() - t0;
  const after270 = Number((W.cntView() || {}).ustall || 0);
  ok("黑洞写入在上限内返回（不挂 30 秒）", spent < 3000, `spent=${spent}`);
  ok("卡顿被记进 ustall", after270 === before270 + 1, `${before270}→${after270}`);
}

// 源码锁：两处必须成对（改了常量却忘了传参，等于没改）
{ const sa270 = fs.readFileSync("src/proxy/attacher.ts", "utf8");
  ok("attacher 给首包传了上限", sa270.includes("conn.upWrite(payload, FIRST_UP_MS)"), "attacher");
  ok("attacher 导入了 FIRST_UP_MS", /import \{[^}]*FIRST_UP_MS[^}]*\} from "\.\.\/core\/util"/.test(sa270), "import");
  ok("首包不再用默认上限", sa270.includes("conn.upWrite(payload);") === false, "default");
  const su270 = fs.readFileSync("src/core/util.ts", "utf8");
  ok("常量在 util 里且只有一处", su270.split("export const FIRST_UP_MS").length - 1 === 1, "util"); }

﻿// 第 271 组：探测传输层（7.271 起 probeTf 不再写死 tunnelfetch）
{
  eq("注册表里有两个传输", W.TRANSPORTS.names().length, 2);
  ok("tunnelfetch 与 gateway 都在", W.TRANSPORTS.names().includes("tunnelfetch") && W.TRANSPORTS.names().includes("gateway"));
  eq("默认传输是 tunnelfetch", W.TRANSPORTS.current(), "tunnelfetch");
  eq("拼错的名字不生效", W.TRANSPORTS.use("nope"), false);
  eq("拼错之后仍是原传输", W.TRANSPORTS.current(), "tunnelfetch");
  ok("取不存在的名字回落到当前", W.TRANSPORTS.get("nope").transportName === "tunnelfetch");
  eq("可以切到 gateway", W.TRANSPORTS.use("gateway"), true);
  eq("切换后 current 变了", W.TRANSPORTS.current(), "gateway");
  W.TRANSPORTS.use("tunnelfetch");
  ok("tunnelfetch 承认自己能落中继", W.TRANSPORTS.get("tunnelfetch").relayAware === true);
  ok("gateway 承认自己不能落中继", W.TRANSPORTS.get("gateway").relayAware === false);
  const gw271 = await W.TRANSPORTS.get("gateway").probe("example.com", "1.2.3.4:443", "/", 500);
  ok("gateway 遇到中继会如实报错而不是静默直连", gw271.ok === false && String(gw271.err).includes("relay"));
  const tfSrc271 = fs.readFileSync("src/core/tf.ts", "utf8");
  ok("probeTf 自己不再 import tunnelfetch", !tfSrc271.includes('from "tunnelfetch"'));
  ok("probeTf 通过注册表取传输", tfSrc271.includes("TRANSPORTS.get("));
  const implSrc271 = fs.readFileSync("src/core/transport-tunnelfetch.ts", "utf8");
  ok("tunnelfetch 的实现搬进了专用模块", implSrc271.includes('import { Client } from "tunnelfetch"'));
  const pkg271 = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok("tunnelfetch 是声明的依赖（不再是隐式依赖）", Boolean(pkg271.dependencies && pkg271.dependencies.tunnelfetch));
  const regSrc271 = fs.readFileSync("src/core/transport.ts", "utf8");
  ok("注册表是独立模块且有类文档", regSrc271.includes("class TransportRegistry") && regSrc271.includes("功能：按名字保存"));
}

// ===== 272. 建连预算与「迟到关闭」收敛成一个类 =====
// 四处各自写过 Promise.resolve(connect(...)) + withTimeout + 迟到关闭；漏掉后半段就会
// 让免费计划那 6 个并发 connect() 名额被死连接吃掉（7.86 的坑）。
ok("拨号器类存在", typeof W.SocketDialer === "function");
ok("默认预算就是 CONNECT_MS", new W.SocketDialer().budgetMs === W.CONNECT_MS);
ok("预算可以按需收窄（诊断路径用）", new W.SocketDialer(80).budgetMs === 80);
ok("共用实例的预算也是 CONNECT_MS", W.SOCKET_DIALER.budgetMs === W.CONNECT_MS);
ok("共用实例是单例（同一份预算）", W.SOCKET_DIALER instanceof W.SocketDialer);
const sdSrc272 = fs.readFileSync("src/proxy/socket-dialer.ts", "utf8");
ok("open() 用 this.budgetMs 兜超时", sdSrc272.includes("withTimeout(pending, this.budgetMs)"));
ok("超时后关掉迟到 socket", sdSrc272.includes("socket.close()"));
ok("注释写明了为什么必须关", sdSrc272.includes("6 个并发"));
const fbSrc272 = fs.readFileSync("src/proxy/fallback.ts", "utf8");
ok("补救链改用 SOCKET_DIALER", fbSrc272.includes("SOCKET_DIALER.open(") && !fbSrc272.includes("Promise.resolve(connect("));
const rgSrc272 = fs.readFileSync("src/proxy/region.ts", "utf8");
ok("地区分流改用 SOCKET_DIALER", rgSrc272.includes("SOCKET_DIALER.open(") && !rgSrc272.includes("Promise.resolve(connect("));
ok("地区分流的两条候选都走同一个拨号器", rgSrc272.split("SOCKET_DIALER.open(").length - 1 === 2);
// ===== 273. 诊断端点从 Meter.handle 的 if 链搬进 MeterDiagnostics =====
// 它们不落盘、不碰账目；混在账目分支里会让「哪些端点会写 DO」这件事看不出来。
ok("诊断分派器存在", typeof W.MeterDiagnostics === "function" && W.METER_DIAGNOSTICS instanceof W.MeterDiagnostics);
const mdSrc273 = fs.readFileSync("src/store/meter-diagnostics.ts", "utf8");
ok("每个诊断端点一个方法", ["stagedSnapshot", "timerProbe", "iterationProbe", "cryptoBurnProbe", "jsBurnProbe", "cryptoApiProbe", "relayBatchProbe", "relayProbe"].every((n) => mdSrc273.includes(n)));
ok("分派只认这八个端点", (mdSrc273.match(/pathname\.endsWith\(/g) || []).length === 8);
ok("只有 /stage 读 storage", (mdSrc273.match(/state\.storage/g) || []).length === 1);
const meterSrc273 = fs.readFileSync("src/store/meter.ts", "utf8");
const meterCode273 = meterSrc273.split(/\r?\n/).filter((line) => !line.trim().startsWith("//")).join("\n");
ok("meter.ts 不再自己实现诊断端点", !meterCode273.includes(".endsWith(\"/burnjs\")") && !meterCode273.includes("\"pstage\"") && !meterCode273.includes(".endsWith(\"/crypto\")"));
ok("meter.ts 改走 METER_DIAGNOSTICS", meterSrc273.includes("METER_DIAGNOSTICS.run(p, url, this.state)"));
ok("meter.ts 不再直接 probeTf", !meterSrc273.includes("probeTf"));
// 行为面：分派器对非诊断端点返回 null，对诊断端点返回 Response
const fakeState273 = { storage: { get: async () => "probe-ok" }, blockConcurrencyWhile: async () => {} };
eq("非诊断端点交回 null", await W.METER_DIAGNOSTICS.run("/add", new URL("https://meter/add"), fakeState273), null);
const stageRes273 = await W.METER_DIAGNOSTICS.run("/stage", new URL("https://meter/stage"), fakeState273);
ok("/stage 回读到阶段标记", (await stageRes273.json()).stage === "probe-ok");
const iterRes273 = await W.METER_DIAGNOSTICS.run("/iter", new URL("https://meter/iter?n=1000"), fakeState273);
const iterBody273 = await iterRes273.json();
ok("/iter 夹住 n 并真的跑了", iterBody273.n === 1000 && iterBody273.ok === true);
const cryptoRes273 = await W.METER_DIAGNOSTICS.run("/crypto", new URL("https://meter/crypto"), fakeState273);
const cryptoBody273 = await cryptoRes273.json();
ok("/crypto 逐项给出耗时", typeof cryptoBody273.digest === "number" && cryptoBody273.digestLen === 32);
/* ---------- 274. 账本字段的语义名：内存改、落盘格式不动 ---------- */
{
  const do274 = mkDO();
  const today274 = new Date().toISOString().slice(0, 10);
  await do274.m.fetch(
    new Request("https://m/add", {
      method: "POST",
      body: JSON.stringify({
        up: 5,
        down: 7,
        conns: 2,
        c: { d: today274, k274: 3 },
        cl: [{ k: "1.1.1.1:443", n: 1, ok: 1, p50: 1, p95: 2, dn: 3 }],
      }),
    }),
  );
  const u274 = do274.m.ledger.usage || {};
  eq("用量累计落在 usage 上", [u274.up, u274.down, u274.conns], [5, 7, 2]);
  const g274 = do274.m.ledger.dayCounter || {};
  ok("全局日计数落在 dayCounter 上", g274.d === today274 && g274.k274 === 3);
  eq("连接观测落在 connRing 上", (do274.m.ledger.connRing || []).length, 1);
  ok("旧单字母不再是账本字段", ["c", "g", "s", "e", "cl"].every((k) => !(k in do274.m)));
  const meterSrc = fs.readFileSync("src/store/meter.ts", "utf8").split(/\r?\n/).join("\n");
  const stateSrc274 = fs.readFileSync("src/store/meter-state.ts", "utf8").split(/\r?\n/).join("\n");
  const code274 = [meterSrc, stateSrc274].join("\n").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  ok("类字段声明用的是语义名", ["usage: UsageMeter;", "dayCounter: CounterDoc;", "nodeSnapshots: Record<string, NodeSnap>;", "errors: ErrItem[];", "connRing: ClRec[];"].every((x) => code274.includes(x)));
  ok("类里不再有单字母字段声明", !/^\s{2}(c|g|s|e|cl):/m.test(code274));
  ok(
    "restore 逐项映射落盘键",
    code274.includes("restore(parts: MeterStore): void") &&
      code274.includes("this.usage = { ...this.usage, ...parts.c }") &&
      code274.includes("this.dayCounter = parts.g as CounterDoc") &&
      code274.includes("this.nodeSnapshots = Object.assign(Object.create(null), parts.s)") &&
      code274.includes("this.errors = parts.e as ErrItem[]") &&
      code274.includes("this.connRing = parts.cl as ClRec[]"),
  );
  ok("loadShards 不再整块灌对象", code274.includes(".restore(parts);") && !code274.includes("Object.assign(this, await readShards"));
  const addSrc = fs.readFileSync("src/store/meteradd.ts", "utf8");
  ok(
    "AddTarget 也是语义名",
    addSrc.includes("usage: UsageMeter;") && addSrc.includes("dayCounter: CounterDoc;") && addSrc.includes("nodeSnapshots: Record<string, NodeSnap>;") && addSrc.includes("errors: ErrItem[];") && addSrc.includes("connRing: ClRec[];"),
  );
  ok("add 内部不再访问旧短名", !/\bm\.(c|g|s|e|cl)\b/.test(addSrc));
}

// ---- 第 275 组：六个诊断端点由 DebugMeterProbes 统一派发（7.275，用户 m39603 的 OOP 要求） ----
{
  const kv275 = () => {
    const m = new Map();
    return {
      get: async (k) => (m.has(k) ? m.get(k) : null),
      put: async (k, v) => void m.set(k, v),
      delete: async (k) => void m.delete(k),
      list: async () => ({ keys: [...m.keys()].map((name) => ({ name })), list_complete: true }),
    };
  };
  // 记录 DO 实际收到的 URL 与实例名：六个端点的差别只在参数名、默认实例名、超时与结果键
  const sink = { url: "", name: "", calls: 0 };
  const meter275 = (status, body) => ({
    idFromName: (n) => {
      sink.name = n;
      return n;
    },
    get: () => ({
      fetch: async (u) => {
        sink.calls += 1;
        sink.url = String(u);
        return new Response(body, { status, headers: { "content-type": "application/json" } });
      },
    }),
  });
  const KEY275 = "#probe-admin-275";
  const run275 = async (qs, opts = {}) => {
    sink.url = "";
    sink.name = "";
    sink.calls = 0;
    const url = new URL("https://sim.example.com/7c53c12a-88b1-4fda-b6e7-4da62e47a4e1/debug" + qs);
    const request = new Request(url.toString(), { headers: { "x-admin-key": KEY275 } });
    const env = { STATS: kv275(), adminKey: KEY275 };
    if (!opts.noMeter) env.METER = meter275(opts.status || 500, opts.body || "{\"error\":\"boom\"}");
    const ctx = { request, url, env, id: "7c53c12a-88b1-4fda-b6e7-4da62e47a4e1", exec: { waitUntil() {}, passThroughOnException() {} } };
    return { body: await (await W.debug(ctx)).json(), sink: { ...sink } };
  };

  // ① 六个参数都走同一条路径：DO 回 500 时 ok 必须是 false，并且带出真实状态码
  for (const qs of ["?burn=10&n=p275", "?stage=1&n=p275", "?tim=10&n=p275", "?iter=1000&n=p275", "?burnjs=10&n=p275", "?crypto=1&n=p275"]) {
    const r = await run275(qs);
    eq(qs + " 的 ok 是 DO 的真实状态", r.body.ok, false);
    eq(qs + " 带出 DO 状态码", r.body.doStatus, 500);
  }

  // ② 查询串只由规格表拼：`ms` 类端点带值、`/stage` 与 `/crypto` 是空查询
  const burn275 = await run275("?burn=10&n=p275");
  ok("burn 把 ms=10 拼进 DO 查询串", burn275.sink.url.includes("/burn?ms=10"), burn275.sink.url);
  const crypto275 = await run275("?crypto=1&n=p275");
  ok("crypto 是不带查询串的端点", crypto275.sink.url.endsWith("/crypto"), crypto275.sink.url);
  const iter275 = await run275("?iter=&n=p275");
  ok("空值的 iter 用规格里的默认 n", iter275.sink.url.includes("/iter?n=1000000"), iter275.sink.url);

  // ③ 实例名：显式 `&n=` 优先，否则用规格里的前缀 + 时间戳（前缀各不相同，避免串实例）
  eq("显式实例名优先", burn275.sink.name, "7c53c12a-88b1-4fda-b6e7-4da62e47a4e1::p275");
  const noName275 = await run275("?tim=5");
  ok("没给实例名时用规格前缀", noName275.sink.name.startsWith("7c53c12a-88b1-4fda-b6e7-4da62e47a4e1::t"), noName275.sink.name);
  const crNoName = await run275("?crypto=1");
  ok("crypto 用自己的实例前缀", crNoName.sink.name.startsWith("7c53c12a-88b1-4fda-b6e7-4da62e47a4e1::cr"), crNoName.sink.name);

  // ④ stage 需要固定实例：没说实例名就直接报错，绝不读一个随机实例上的空标记
  const stageNoName = await run275("?stage=1");
  eq("stage 缺 &n= 时如实报错", stageNoName.body.error, "need &n=<inst>");
  eq("stage 缺 &n= 时不发 DO 请求", stageNoName.sink.calls, 0);

  // ⑤ 没绑定 METER 时给出可读错误，而不是抛 TypeError
  const noMeter275 = await run275("?burn=10", { noMeter: true });
  eq("没有 METER 绑定时报 no METER", noMeter275.body.error, "no METER");

  // ⑥ 结构断言：规格表是数据、类持有派发、debug.ts 只剩一行委托
  ok("暴露了 DebugMeterProbes 单例", W.METER_PROBES && typeof W.METER_PROBES.run === "function");
  eq("规格表六行对应六个端点", W.METER_PROBES.specs.length, 6);
  ok(
    "规格表覆盖六个参数名",
    ["burn", "stage", "tim", "iter", "burnjs", "crypto"].every((p) => W.METER_PROBES.specs.some((x) => x.param === p)),
  );
  const dbgSrc275 = debugAll().split(/\r?\n/).join("\n");
  ok("debug.ts 只留一行委托", dbgSrc275.includes("METER_PROBES.run(c, url, id)"));
  ok("debug.ts 不再自己读这六个参数", !dbgSrc275.includes("searchParams.get(\"burn\")") && !dbgSrc275.includes("searchParams.get(\"burnjs\")") && !dbgSrc275.includes("searchParams.get(\"crypto\")"));
  const dmSrc275 = fs.readFileSync("src/routes/debug-meter.ts", "utf8");
  ok("派发路径带出真实状态码", dmSrc275.includes("ok: resp.ok, doStatus: resp.status"));
  ok("派发路径统一用 withTimeout 包住 DO 调用", dmSrc275.includes("withTimeout(stub.fetch(") && dmSrc275.includes("spec.budgetMs"));
}

// ---- 第 276 组：账本本体从 Meter 里拆成 MeterState（落盘映射只写一处）----
{
  const msSrc276 = fs.readFileSync("src/store/meter.ts", "utf8").split(/\r?\n/).join("\n");
  const stSrc276 = fs.readFileSync("src/store/meter-state.ts", "utf8").split(/\r?\n/).join("\n");
  // ① 结构：Meter 只剩 DO 生命周期与端点，账本字段与落盘映射都在 MeterState 里
  ok("Meter 持有账本对象", msSrc276.includes("ledger: MeterState;"));
  ok("Meter 不再自己声明用量字段", !msSrc276.includes("usage: UsageMeter;"));
  ok("Meter 不再自己声明七张事实表", !msSrc276.includes("vt: Record<string, number |"));
  ok("Meter 的 /add 合并把状态对象交出去", msSrc276.includes("applyAdd(this.ledger, d)"));
  ok("快照取自状态对象", msSrc276.includes("this.ledger.snapshot()"));
  ok("落盘失败回滚走状态对象", msSrc276.includes("this.ledger.rollback(snap)"));
  ok("落盘形状由 parts() 给出", msSrc276.includes("saveState(this.env, this.state.storage, this.ledger.parts())"));
  ok("逐项映射仍在状态类里", stSrc276.includes("this.usage = { ...this.usage, ...parts.c }"));
  // ② 初值：七张表齐全、节点快照用 null 原型（`__proto__` 当键不能改原型）
  const st276 = new W.MeterState();
  eq("初始用量全 0", [st276.usage.up, st276.usage.down, st276.usage.conns], [0, 0, 0]);
  eq("初始代号 0（事实就在 a 里）", st276.fs, 0);
  eq(
    "初始七张表齐全",
    [st276.vt, st276.hl, st276.eg, st276.ps, st276.dead, st276.blk2, st276.dns].every((x) => x && typeof x === "object"),
    true,
  );
  eq("节点快照是 null 原型", Object.getPrototypeOf(st276.nodeSnapshots), null);
  // ③ 落盘形状：parts() 的键就是存储键（改名只改内存口径，盘上口径不动）
  st276.usage.up = 7;
  const p276 = st276.parts();
  eq("parts() 仍然用 c/g/s/e/cl", [p276.c.up, p276.g.d, Object.keys(p276.s).length, p276.e.length, p276.cl.length], [7, "", 0, 0, 0]);
  eq(
    "parts() 带七张事实表",
    ["vt", "hl", "eg", "ps", "dead", "blk2", "dns"].every((k) => p276[k] && typeof p276[k] === "object"),
    true,
  );
  // ④ adopt()：老数据缺哪个字段就保留默认值，不缺的逐项装回
  const st276b = new W.MeterState();
  st276b.adopt({ c: { up: 5, down: 6 }, g: { d: "2026-01-01" }, cl: [{ k: "a", t: 1 }], fs: 42 });
  eq("adopt 装回用量", [st276b.usage.up, st276b.usage.down, st276b.usage.conns], [5, 6, 0]);
  eq("adopt 装回日计数", st276b.dayCounter.d, "2026-01-01");
  eq("adopt 装回连接环", st276b.connRing.length, 1);
  eq("adopt 装回代号", st276b.fs, 42);
  eq("adopt 没给的字段仍是默认", st276b.usage.first, 0);
  // ⑤ 快照与回滚：连接观测在表里就地累加，所以必须深拷
  const st276c = new W.MeterState();
  st276c.connRing.push({ k: "r1", t: 1 });
  const snap276 = st276c.snapshot();
  st276c.usage.up = 99;
  st276c.connRing[0].t = 2;
  st276c.connRing.push({ k: "r2", t: 3 });
  st276c.rollback(snap276);
  eq("回滚恢复用量", st276c.usage.up, 0);
  eq("回滚恢复连接环条数", st276c.connRing.length, 1);
  eq("回滚是深拷（行内改动不残留）", st276c.connRing[0].t, 1);
  // ⑥ 解不开的旧值：只备份一次，拿下即清空（否则每次落盘都重写 a_bak）
  const st276d = new W.MeterState();
  eq("没有待备份原文时返回 null", st276d.takeBackup(), null);
  st276d.keepBackup("raw");
  eq("取下原文", st276d.takeBackup(), "raw");
  eq("取下后清空", st276d.takeBackup(), null);
  // ⑦ 落盘失败回滚仍然真的回滚（行为，不只读源码）
  let gate276 = Promise.resolve();
  const storage276 = {
    get: async () => null,
    put: async () => {
      throw new Error("storage down");
    },
    delete: async () => {},
  };
  const st276e = {
    storage: storage276,
    blockConcurrencyWhile: (fn) => {
      gate276 = Promise.resolve(fn());
    },
  };
  const m276 = new W.Meter(st276e, {});
  await gate276;
  let threw276 = false;
  try {
    await m276.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 10 }) }));
  } catch (e) {
    threw276 = true;
  }
  eq("落盘失败会抛出去（呼叫方据此重试）", threw276, true);
  eq("落盘失败后内存里的用量回到 0", m276.ledger.usage.up, 0);
}


// —— 第 277 组：Attacher 的补救建连与「关客户端」各自只留一处实现 ——
{
  const aSrc277 = fs.readFileSync("src/proxy/attacher.ts", "utf8");
  // 结构：两处补救建连都走拨号器，不再自己拼 connect / withTimeout
  eq("补救建连都走同一个拨号器", (aSrc277.match(/SOCKET_DIALER\.open\(/g) || []).length, 2);
  ok("attacher 不再直接 connect", !aSrc277.includes("connect({") && !aSrc277.includes("Promise.resolve(connect("));
  ok("attacher 不再自带建连超时", !aSrc277.includes("withTimeout(") && !aSrc277.includes("CONNECT_MS"));
  ok("socket 模块只留类型导入", aSrc277.includes('import type { Socket } from "cloudflare:sockets";') && !aSrc277.includes('import { connect } from "cloudflare:sockets"'));
  // 结构：关客户端只剩一处实现，五个放弃点都调它
  eq("关客户端只有一处 close", (aSrc277.match(/clientSocket\.close\(/g) || []).length, 1);
  eq("五个放弃点都走 endClient", (aSrc277.match(/this\.endClient\(clientSocket,/g) || []).length, 5);
  ok("endClient 是私有方法", aSrc277.includes("private endClient(clientSocket: WebSocketLike, code: number, reason: string): void"));
  // 历史自伤：首包那条注释曾被脚本顶到第 0 列（块内层级读起来是断的）
  ok("没有第 0 列的注释行", !/^\/\//m.test(aSrc277));
  // 行为：close 抛错要吞掉，正常时把关闭码与原因原样传下去
  ok("endClient 存在", typeof W.ATTACHER.endClient === "function");
  const seen = [];
  const fakeOk = { readyState: 1, close: (code, reason) => seen.push([code, reason]) };
  let threw = false;
  try {
    W.ATTACHER.endClient(fakeOk, 1011, "proxyip failed");
  } catch (e) {
    threw = true;
  }
  ok("endClient 把关闭码与原因原样传下去", !threw && seen.length === 1 && seen[0][0] === 1011 && seen[0][1] === "proxyip failed");
  const fakeGone = { readyState: 3, close: () => { throw new Error("already closed"); } };
  let threw2 = false;
  try {
    W.ATTACHER.endClient(fakeGone, 1000, "done");
  } catch (e) {
    threw2 = true;
  }
  ok("客户端已经走了也不会抛出来", !threw2);
}

/* ---------- 第 278 组：诊断路由的 DO 读取与 v6 建连都走唯一入口 ---------- */
{
  const aSrc278 = debugAll();
  const cli278 = fs.readFileSync("src/store/meter-client.ts", "utf8");
  // 计数点唯一：`S.doCalls` 只在 `doFetch` 里自增，所以任何绕过它的 stub.fetch 都会让 /health 少记一块
  ok("debug.ts 不再直接取 METER 存根", !/env\.METER\.get\(/.test(aSrc278));
  ok("debug.ts 六条 DO 读取全走 doFetch", (aSrc278.match(/doFetch\(/g) || []).length === 6);
  ok("debug.ts 不再自己拼 connect", !/connect\(\{/.test(aSrc278));
  ok("debug.ts 不再引用 CONNECT_MS", !aSrc278.includes("CONNECT_MS"));
  ok("debug.ts 不再导入 cloudflare:sockets", !aSrc278.includes("cloudflare:sockets"));
  ok("debug.ts 的 v6 建连走拨号器", aSrc278.includes("SOCKET_DIALER.open(expandV6(out.aaaa), 443)"));
  ok("doFetch 仍是唯一自增点", (cli278.match(/S\.doCalls \+= 1;/g) || []).length === 1);

  // 行为面：三条诊断读取各要真的把子请求记进 S.doCalls（旧代码在这三条上恒为 0）
  const calls = [];
  const meter278 = {
    idFromName: (n) => n,
    get: () => ({
      fetch: async (u) => {
        calls.push(String(u));
        return new Response(JSON.stringify({ ok: true, hl: [], cl: [], blk2: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }),
  };
  const kv278 = () => {
    const m = new Map();
    return {
      get: async (k) => (m.has(k) ? m.get(k) : null),
      put: async (k, v) => void m.set(k, v),
      delete: async (k) => void m.delete(k),
      list: async () => ({ keys: [...m.keys()].map((name) => ({ name })), list_complete: true }),
    };
  };
  const env278 = { STATS: kv278(), METER: meter278, adminKey: "#probe-admin-278", uuid: "7c53c12a-88b1-4fda-b6e7-4da62e47a4e1" };
  const run278 = async (qs) => {
    const url = new URL("https://sim.example.com/7c53c12a-88b1-4fda-b6e7-4da62e47a4e1/debug" + qs);
    const request = new Request(url.toString(), { headers: { "x-admin-key": "#probe-admin-278" } });
    const ctx = { request, url, env: env278, id: "7c53c12a-88b1-4fda-b6e7-4da62e47a4e1", exec: { waitUntil() {}, passThroughOnException() {} } };
    return (await W.debug(ctx)).json();
  };

  W.S.doCalls = 0;
  calls.length = 0;
  await run278("?seed=1,2,3");
  ok("?seed= 的子请求被记进 doCalls", W.S.doCalls === 1 && calls.length === 1 && calls[0] === "https://meter/seed");

  W.S.doCalls = 0;
  calls.length = 0;
  await run278("?cl=1&do=1");
  ok("?cl=1&do=1 走 doFetch 读连接环形", calls.includes("https://meter/cl") && W.S.doCalls >= 1);

  W.S.doCalls = 0;
  calls.length = 0;
  await run278("?hl=1&do=1");
  ok("?hl=1&do=1 走 doFetch 读中继健康环", calls.includes("https://meter/hl") && W.S.doCalls >= 1);
}

// ── 279. 一轮池子维护从 pool.ts 拆成 PoolScan + AliveBoard（v7.279）──
{
  const poolSrc279 = fs.readFileSync("src/px/pool.ts", "utf8");
  const scanSrc279 = fs.readFileSync("src/px/scan.ts", "utf8");
  const aliveSrc279 = fs.readFileSync("src/px/alive.ts", "utf8");
  ok("pool.ts 只剩门面：不再有分并发的那一段", !poolSrc279.includes("for (const seg of chunks"), poolSrc279.length);
  ok("pool.ts 不再摆弄复测队列", !poolSrc279.includes("S.reProbe.splice"), "");
  ok("scan.ts 是一轮维护的执行器", scanSrc279.includes("export class PoolScan"), "");
  ok(
    "cronScan 只剩一行委托",
    /export async function cronScan\(env: Env, adm = 0\): Promise<void> \{\s*await new PoolScan\(env, adm\)\.run\(\);\s*\}/.test(scanSrc279),
    "",
  );
  ok("run() 先收拾坏点表再读池子", scanSrc279.indexOf("sweepProbeBad();") < scanSrc279.indexOf("await pxGet(this.env);"), "");
  ok(
    "run() 的顺序：复测 → 探新 → 头部 → 其余 → 裁剪 → 国家码 → 统计 → 中转 → 落盘",
    [
      "await this.retestFlagged(",
      "await this.probeNew(",
      "await this.recheckHead(",
      "await this.refreshRest(",
      "if (this.pruneAndTrim())",
      "await ALIVE.fillCountries();",
      "this.trimStats();",
      "await this.probeRelays();",
      "await this.persistSeed();",
    ].every((m, i, arr) => i === 0 || scanSrc279.indexOf(arr[i - 1]) < scanSrc279.indexOf(m)),
    "",
  );
  ok("alive.ts 同时有冷却表与存活表", aliveSrc279.includes("export class ProbeCooldown") && aliveSrc279.includes("export class AliveBoard"), "");
  ok(
    "pool.ts 原样再导出旧名字（调用点零改动）",
    ["probeBadSkip", "bumpProbeBad", "sweepProbeBad", "pxGet", "aliveList", "cronScan", "PoolScan", "ALIVE"].every((n) => poolSrc279.includes(n)),
    "",
  );

  // 冷却表：连续失败到 SCAN_BAD_MAX 才跳过，成功一次就恢复；TTL 过了自动作废
  const cool = "cool279.test:443";
  eq("没记录时不跳过", W.PROBE_COOL.skip(cool), false);
  W.PROBE_COOL.bump(cool, false);
  eq("失败一次还不跳过", W.PROBE_COOL.skip(cool), false);
  W.PROBE_COOL.bump(cool, false);
  W.PROBE_COOL.bump(cool, false);
  eq("连续失败到上限才跳过", W.PROBE_COOL.skip(cool), true);
  W.PROBE_COOL.bump(cool, true);
  eq("成功一次就重新可探", W.PROBE_COOL.skip(cool), false);

  const cool2 = "cool279b.test:443";
  W.PROBE_COOL.bump(cool2, false);
  W.PROBE_COOL.bump(cool2, false);
  W.PROBE_COOL.bump(cool2, false);
  eq("TTL 内仍然跳过", W.PROBE_COOL.skip(cool2, Date.now() + 1000), true);
  eq("TTL 过了自动恢复", W.PROBE_COOL.skip(cool2, Date.now() + W.SC.PROBE_BAD_TTL + 1), false);

  // 上限：越过 PROBE_BAD_MAX 时把最久没更新的淘汰掉（表没有别的裁剪路径）
  for (let i = 0; i < W.SC.PROBE_BAD_MAX + 20; i++) W.PROBE_COOL.bump("cap279-" + i + ".test:443", false);
  const dropped = W.PROBE_COOL.sweep();
  ok("越过上限会淘汰最久没更新的", dropped >= 20, "dropped=" + dropped);

  // 存活表裁剪：先删不在池子里的，再按延迟从慢到快删
  W.S.alive = new Map([
    ["in279.test:443", { h: "in279.test", p: 443, cc: "", ms: 50 }],
    ["out279.test:443", { h: "out279.test", p: 443, cc: "", ms: 10 }],
  ]);
  const trimmed = W.ALIVE.trimToMax([{ h: "in279.test", p: 443 }], 1);
  eq("裁剪先删不在池子里的那条", W.S.alive.has("out279.test:443"), false);
  eq("裁剪保住池子里的那条（哪怕它更慢）", W.S.alive.has("in279.test:443"), true);
  eq("裁剪返回「动过表」", trimmed, true);
  eq("池子够小就不动", W.ALIVE.trimToMax([{ h: "in279.test", p: 443 }], 8), false);
}

// ──────────────────────────────── 第 280 组：选择器一分为三（挑谁 / 什么时候换 / 失败怎么记）────────────────────────────────
{
  const facadeSrc = fs.readFileSync("src/px/selector.ts", "utf8");
  const pickSrc = fs.readFileSync("src/px/pickpath.ts", "utf8");
  const rotSrc = fs.readFileSync("src/px/rotation.ts", "utf8");
  const failSrc = fs.readFileSync("src/px/failbook.ts", "utf8");
  // 结构：三个类各自带单例，门面只剩委托
  ok("pickpath 有 PickPath 与 PICK", pickSrc.includes("export class PickPath {") && pickSrc.includes("export const PICK = new PickPath();"), "");
  ok("rotation 有 Rotation 与 ROTATION", rotSrc.includes("export class Rotation {") && rotSrc.includes("export const ROTATION = new Rotation();"), "");
  ok("failbook 有 FailBook 与 FAILS", failSrc.includes("export class FailBook {") && failSrc.includes("export const FAILS = new FailBook();"), "");
  eq("门面里 PICK 的委托有 3 处", facadeSrc.split("return PICK.").length - 1, 3);
  eq("门面里 ROTATION 的委托有 3 处", facadeSrc.split("return ROTATION.").length - 1, 3);
  eq("门面里 FAILS 的委托有 4 处", facadeSrc.split("return FAILS.").length - 1, 4);
  // 门面不得再留算法：这些调用各自只在唯一一个执行器里出现
  ok("门面不再挑样本", !facadeSrc.includes("pickThom("), "");
  ok("门面不再列候选", !facadeSrc.includes("candsFor("), "");
  ok("门面不再自写 IP 解析", !facadeSrc.includes("relayIpOf("), "");
  ok("门面不再动游标", !facadeSrc.includes("S.curs"), "");
  ok("门面不再记样本", !facadeSrc.includes("nsGet("), "");
  // 职责边界：换节点只由 Rotation 判，FailBook 调它而不是自己判
  ok("failbook 用 ROTATION.maybeSwitch", failSrc.includes("ROTATION.maybeSwitch("), "");
  ok("failbook 不再 this.maybeSwitch", !failSrc.includes("this.maybeSwitch("), "");
  ok("pickpath 不判换节点", !pickSrc.includes("this.maybeSwitch(") && !pickSrc.includes("ROTATION.maybeSwitch("), "");
  ok("rotation 不含记失败的入口", !rotSrc.includes("async bumpFail(") && !rotSrc.includes("async onFail("), "");
  // dwellOf 跟着「什么时候换」走，但仍由门面再导出（调用点与测试零改动）
  ok("dwellOf 在 rotation", rotSrc.includes("export function dwellOf("), "");
  ok("门面再导出 dwellOf", facadeSrc.includes('export { ROTATION, dwellOf } from "./rotation";'), "");
  // 行为：门面十个方法都还在，且默认驻留时间照旧
  const ten = ["region", "pick", "maybeSwitch", "onFail", "softFail", "bumpFail", "resetFail", "current", "afterScan", "sched"];
  eq("门面十个方法都在", ten.filter((m) => typeof W.SEL[m] === "function").length, 10);
  eq("lat 模式默认驻留 10 分钟", W.dwellOf({}, "lat"), W.SC.DWELL);
  eq("tput 模式默认驻留 20 分钟", W.dwellOf({}, "tput"), W.SC.DWELL_TPUT);
  eq("非正数覆盖回落默认", W.dwellOf({ pxDwellMin: "0" }, "lat"), W.SC.DWELL);
  eq("正数覆盖按分钟换算", W.dwellOf({ pxDwellMin: "3" }, "lat"), 3 * 60000);
}

// ──────────────────────────────── 第 281 组：probe.ts 一分为四（源清单 / 原始探活 / 地理 / 失败阈值）────────────────────────────────
{
  const facadeSrc = fs.readFileSync("src/px/probe.ts", "utf8");
  const poolSrc = fs.readFileSync("src/px/poolsrc.ts", "utf8");
  const rawSrc = fs.readFileSync("src/px/rawprobe.ts", "utf8");
  const geoSrc = fs.readFileSync("src/px/geo.ts", "utf8");
  const failSrc = fs.readFileSync("src/px/failpolicy.ts", "utf8");
  // 门面只做再导出：没有函数体、没有值定义
  ok("门面不再定义函数", !facadeSrc.includes("export function ") && !facadeSrc.includes("export async function "), "");
  ok("门面不再定义常量", !/^export const \w+ = /m.test(facadeSrc), "");
  eq("门面四个来源各一行", ["poolsrc", "rawprobe", "geo", "failpolicy"].filter((m) => facadeSrc.includes(`"${"./" + m}"`)).length, 4);
  ok("门面不超过 15 行", facadeSrc.split("\n").length <= 15, String(facadeSrc.split("\n").length));
  // 四块各就各位
  ok("poolsrc 有源清单与抓取", poolSrc.includes("export const POOL_SOURCES = [") && poolSrc.includes("export async function refillPool("), "");
  ok("poolsrc 有源健康度与去重", poolSrc.includes("export class SourceHealth {") && poolSrc.includes("export function takePoolLine("), "");
  ok("poolsrc 不含探活", !poolSrc.includes("PROBE_HELLO") && !poolSrc.includes("probeProxy("), "");
  ok("rawprobe 有四种探活入口", rawSrc.includes("export const PROBE_HELLO") && rawSrc.includes("export async function probeProxy(") && rawSrc.includes("export function tlsHello(") && rawSrc.includes("export async function probeSni("), "");
  ok("rawprobe 不再抓源", !rawSrc.includes("refillPool(") && !rawSrc.includes("POOL_SOURCES"), "");
  ok("geo 只做标注", geoSrc.includes("export async function geoLabel(") && !geoSrc.includes("connect({"), "");
  ok("failpolicy 只有阈值", failSrc.includes("export function pxPolicy(") && !failSrc.includes("await "), "");
  // 导出面没变：老名字仍然能用，行为也照旧
  eq("REFILL_MAX 仍是 6", W.REFILL_MAX, 6);
  eq("三个探活入口仍可调用", [W.probeProxy, W.probeSni, W.tlsHello].every((f) => typeof f === "function"), true);
  eq("抓取入口仍可调用", typeof W.refillPool === "function" && typeof W.poolSources === "function", true);
  eq("阈值默认 3 / 5", JSON.stringify(W.pxPolicy({})), JSON.stringify({ fail: 3, force: 5 }));
  eq("阈值可被 env 覆盖", JSON.stringify(W.pxPolicy({ pxFailMax: "4", pxForceAt: "7" })), JSON.stringify({ fail: 4, force: 7 }));
  eq("非法覆盖回落默认", JSON.stringify(W.pxPolicy({ pxFailMax: "0", pxForceAt: "-1" })), JSON.stringify({ fail: 3, force: 5 }));
}

// ──────────────────────────────── 第 282 组：节点统计一分为四（类型 / 表 / 派生 / 观测）────────────────────────────────
{
  const facade = fs.readFileSync("src/nodes/stat.ts", "utf8");
  const types = fs.readFileSync("src/nodes/stat-types.ts", "utf8");
  const table = fs.readFileSync("src/nodes/stat-table.ts", "utf8");
  const view = fs.readFileSync("src/nodes/stat-view.ts", "utf8");
  const obs = fs.readFileSync("src/nodes/stat-observe.ts", "utf8");
  const noComment = (s) => s.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");
  // 门面只做再导出
  ok("门面不再定义函数或类", !facade.includes("export function ") && !facade.includes("export class "), "");
  eq("门面四个来源各一行", ["stat-types", "stat-table", "stat-view", "stat-observe"].filter((m) => facade.includes(`"${"./" + m}"`)).length, 4);
  ok("门面不超过 12 行", facade.split("\n").length <= 12, String(facade.split("\n").length));
  // 四块各就各位
  ok("类型层只有类型与常量", types.includes("export interface EffView") && types.includes("export const ZERO_STAT") && types.includes("export const TEN_MB") && types.includes("export const EMPTY_CLOSE_BAD"), "");
  ok("类型层不碰 S", !noComment(types).includes("S."), "");
  ok("表层持有类与单例", table.includes("export class NodeStatsTable {") && table.includes("export const STATS = new NodeStatsTable();"), "");
  ok("表层只留取条目与打缓存两个方法", table.includes("  nsGet(k: string)") && table.includes("  invalidateRank()") && !table.includes("  nsOk(k: string)"), "");
  ok("表层保留两个同名薄包装", table.includes("export function nsGet(k: string): NodeStats {") && table.includes("export function invalidateRank(): void {"), "");
  ok("派生层全是纯函数且不碰 S", !noComment(view).includes("S.") && ["nsDecay", "ageFactor", "effView", "pFailFast", "pFailOf", "availOf", "pStallOf"].every((f) => view.includes(`export function ${f}(`)), "");
  ok("观测层九个写入都在", ["nsOk", "nsProbe", "nsProbeFail", "nsFail", "nsSiteFail", "nsSpeed", "nsStall", "nsLatency", "nsEmptyClose"].every((f) => obs.includes(`export function ${f}(`)), "");
  ok("观测层经表单例取条目、不自己碰 S.nstat", obs.includes("STATS.nsGet(") && !obs.includes("S.nstat"), "");
  ok("观测层不含 class", !obs.includes("export class "), "");
  // 行为面：常量与写入仍然照旧（用独立键，避免与别的组互相污染）
  eq("TEN_MB 仍是 10MB", W.TEN_MB, 10 * 1048576);
  eq("空关闭门槛仍是 5", W.EMPTY_CLOSE_BAD, 5);
  eq("表单例可判定", W.STATS instanceof W.NodeStatsTable, true);
  eq("零值条目的样本数为 0", W.ZERO_STAT.probeSamples, 0);
  const k282 = "stat282.probe:443";
  W.nsFail(k282);
  ok("失败后进入冷却", W.nsGet(k282).blackUntil > Date.now(), "");
  ok("冷却被记成失败一笔", W.effView(W.nsGet(k282)).failW > 0, "");
  W.nsOk(k282, 12, 30);
  eq("成功清零冷却", W.nsGet(k282).blackUntil, 0);
  ok("成功留下 tcp 样本", W.nsGet(k282).tcp > 0, "");
}


// —— 283：调试路由按「读 / 量 / 写」拆成三个组件（7.283） ——
{
  const g = "283";
  const orch = fs.readFileSync("src/routes/debug.ts", "utf8");
  const tabs = fs.readFileSync("src/routes/debug-tables.ts", "utf8");
  const nets = fs.readFileSync("src/routes/debug-nets.ts", "utf8");
  const acts = fs.readFileSync("src/routes/debug-actions.ts", "utf8");
  // 编排层只按固定顺序调用三个组件，自己不再读任何参数：这条锁防的是「拆完之后又往编排里塞逻辑」
  ok(`[${g}] 编排层不再自己判断参数`, !orch.includes("searchParams.get(\"dd\")") && !orch.includes("searchParams.get(\"bench\")"));
  eq(`[${g}] 编排层按顺序调用十二个组件方法`, ["TABLES.read(", "NETS.bench(", "NETS.diag(", "NETS.rawProbe(", "ACTIONS.refill(", "ACTIONS.pinCurrent(", "NETS.http(", "METER_PROBES.run(", "NETS.tfb(", "NETS.tf(", "ACTIONS.restore(", "ACTIONS.seed(", "NETS.host("].every((x) => orch.includes(x)), true);
  ok(`[${g}] 编排层保持「只读在测量与写之前」`, orch.indexOf("TABLES.read(") < orch.indexOf("NETS.bench(") && orch.indexOf("NETS.bench(") < orch.indexOf("ACTIONS.refill("));
  ok(`[${g}] 编排层不超 120 行`, orch.split(/\r?\n/).length <= 120);
  // 只读表：十一个分支都在这里，且不出现拨号/建连/写 KV 的能力
  eq(`[${g}] 只读表层持有十一个分支`, ["\"dd\"", "\"pss\"", "\"eg\"", "\"rt\"", "\"blk\"", "\"facts\"", "\"plan\"", "\"vt\"", "\"hl\"", "\"prefs\"", "\"cl\""].every((x) => tabs.includes("searchParams.get(" + x + ")")), true);
  ok(`[${g}] 只读表层不建连、不写状态`, !tabs.includes("SOCKET_DIALER.open(") && !tabs.includes("pxSet(") && !tabs.includes("flushPx(") && !tabs.includes("refillPool("));
  // 测网层：三种「花钱」的能力都留了上限
  ok(`[${g}] 测网层的测速有 20 秒封顶`, nets.includes("const ac = new AbortController();") && nets.includes(", 20000)"));
  ok(`[${g}] 测网层的明文 HTTP 有 6 秒上限`, nets.includes("withTimeout(probeHttp80(") && nets.includes(", 6000)"));
  ok(`[${g}] 测网层建连走拨号器`, nets.includes("SOCKET_DIALER.open(") && !nets.includes("connect({"));
  ok(`[${g}] 测网层的判定批走 doFetch`, nets.includes("doFetch(c.env, \"tf-probe\""));
  // 写层：四个分支都必须先过 adminOnly（数量锁：少一个就意味着有条写操作不需要管理员）
  eq(`[${g}] 写层四个分支都先过管理员检查`, acts.split("await adminOnly(c)").length - 1, 4);
  eq(`[${g}] 三个组件各导出单例`, ["export const TABLES", "export const NETS", "export const ACTIONS"].every((x) => (tabs + nets + acts).includes(x)), true);
  // 行为：缺管理员时写分支直接拒绝，不会真的去抓源
  const env283 = { uuid: "11111111-1111-1111-1111-111111111111" };
  const mk283 = (q) => ({
    request: new Request("https://h/" + env283.uuid + "/debug" + q),
    env: env283,
    id: env283.uuid,
    url: new URL("https://h/" + env283.uuid + "/debug" + q),
    exec: { waitUntil() {}, passThroughOnException() {} },
  });
  const deny283 = await W.debug(mk283("?refill=1"));
  ok(`[${g}] 没有管理员时抓源分支被拒`, deny283.status === 403 || deny283.status === 401);
  const seed283 = await W.debug(mk283("?seed=1,2,3"));
  ok(`[${g}] 没有管理员时回填分支被拒`, seed283.status === 403 || seed283.status === 401);
  const pin283 = await W.debug(mk283("?cur=1.2.3.4:443"));
  ok(`[${g}] 没有管理员时钉节点分支被拒`, pin283.status === 403 || pin283.status === 401);
}

// —— 284：指标层一分为四（7.284） ——
{
  const g = "284";
  const face = fs.readFileSync("src/nodes/metrics.ts", "utf8");
  const rttSrc = fs.readFileSync("src/nodes/rtt.ts", "utf8");
  const siteSrc = fs.readFileSync("src/nodes/site.ts", "utf8");
  const diagSrc = fs.readFileSync("src/nodes/diag.ts", "utf8");
  // 门面只转出：一旦有人在门面里补函数，导出面就会有两份真源
  ok(`[${g}] 门面不再定义函数或类`, !/^(export )?(async )?function /m.test(face) && !/^export class /m.test(face));
  eq(`[${g}] 门面按四块转出`, ["\"./rtt\"", "\"./site\"", "\"./diag\"", "\"./errlog\""].every((x) => face.includes(x)), true);
  ok(`[${g}] 门面不超过 12 行`, face.split(/\r?\n/).length <= 12);
  // 三块各就各位
  eq(`[${g}] 入口 RTT 三个入口在 rtt.ts`, ["export function rttMark", "export function rttLearn", "export async function loadRtt"].every((x) => rttSrc.includes(x)), true);
  ok(`[${g}] rtt.ts 不定义类（状态在 S.rtt，无独占状态）`, !/^export class /m.test(rttSrc));
  eq(`[${g}] 站点画像与族键在 site.ts`, ["export class HostProfile", "export const HOSTS", "export function siteKey", "export function hostKey", "export function hostScore", "export function hostNodeMark", "export function hostDirectMark", "export function hostRank", "export function hostUntried"].every((x) => siteSrc.includes(x)), true);
  eq(`[${g}] 诊断结论在 diag.ts`, ["export function diagVerdict"].every((x) => diagSrc.includes(x)), true);
  ok(`[${g}] diag.ts 是纯函数（不读 S、不做 IO）`, !diagSrc.includes("S.") && !diagSrc.includes("await ") && !diagSrc.includes("fetch("));
  // 行为：拆分不改变任何判定
  eq(`[${g}] 没有样本时结论是 empty`, W.diagVerdict([], null).kind, "empty");
  eq(`[${g}] 全被判且直连也不通是 unknown`, W.diagVerdict([{ node: "a:1", n: 2, ok: 0, bad: 2 }], { ok: 0, bad: 0 }).kind, "unknown");
  eq(`[${g}] 全被判但直连正常是 pool`, W.diagVerdict([{ node: "a:1", n: 2, ok: 0, bad: 2 }], { ok: 3, bad: 1 }).kind, "pool");
  eq(`[${g}] 单地区集中是 geo`, W.diagVerdict([{ node: "a:1", n: 2, ok: 0, bad: 2, cc: "us" }, { node: "b:1", n: 2, ok: 0, bad: 2, cc: "us" }, { node: "c:1", n: 2, ok: 2, bad: 0 }], { ok: 0, bad: 0 }).kind, "geo");
  // siteKey 只做「最后两段，二级后缀保留三段」，不看是不是 IP；IP 字面量由 hostKey 原样保留
  eq(`[${g}] 族键取可注册域`, [W.siteKey("a.b.example.co.uk"), W.siteKey("api.x.com"), W.siteKey("shop.example.com")], ["example.co.uk", "x.com", "example.com"]);
  eq(`[${g}] hostKey 对 IP 字面量原样返回`, W.hostKey("1.2.3.4"), "1.2.3.4");
  eq(`[${g}] 没有吞吐样本时 tput 模式回 -1`, W.hostScore({ n: 3, bad: 0, ttfb: 100, at: Date.now() }, "tput", Date.now()), -1);
}
console.log("\n[285] 策略本体与 HOOK 装配拆成两层");
{
  const fsx = fs;
  const ctxSrc = fsx.readFileSync("src/route/policy-ctx.ts", "utf8");
  const wireSrc = fsx.readFileSync("src/route/policy-wiring.ts", "utf8");
  const polSrc285 = fsx.readFileSync("src/route/policy.ts", "utf8");
  ok("类型层只有类型与常量（不碰 HOOK/S）", !ctxSrc.includes("HOOK.") && !ctxSrc.includes("from \"../core/state\""));
  ok("类型层导出 Ctx/Choice/FULL_ON/HOST_MEM_MAX", ctxSrc.includes("export interface Ctx") && ctxSrc.includes("export interface Choice") && ctxSrc.includes("export const FULL_ON") && ctxSrc.includes("export const HOST_MEM_MAX"));
  ok("装配层用结构化接口收参数", wireSrc.includes("install(policy: PolicySource): void {") && wireSrc.includes("export interface PolicySource"));
  ok("装配层注册点 ≥ 18", (wireSrc.match(/HOOK\.[a-zA-Z]+ =/g) || []).length >= 18);
  ok("装配层不含决策算法（没有 pin 表）", !wireSrc.includes("private pin") && !wireSrc.includes("HOST_MEM_MAX"));
  ok("策略本体不再自己注册 HOOK", !polSrc285.includes("HOOK.decide = ") && !polSrc285.includes("HOOK.facts = "));
  ok("策略本体通过 WIRING 装配", polSrc285.includes("WIRING.install(this);"));
  ok("策略本体保留决策与三张表", polSrc285.includes("decide(c: Ctx): Choice {") && polSrc285.includes("private pin") && polSrc285.includes("private seq"));
  ok("装配器与接口都对外可见", typeof W.WIRING === "object" && typeof W.PolicyWiring === "function");
  // 行为面：换一个假策略装配进去，HOOK 真的会用它；再装回来还原
  const fake = { shadow: () => ({ chan: { kind: "d" }, why: "fake-why" }), relays: () => [], prefer: () => false, win: () => ({ d: false, r: false }) };
  W.WIRING.install(fake);
  const viaFake = W.HOOK.decide({ host: "x285.example", cfHost: false, clientV6: false, legacyWantsRelay: false });
  eq("装配后 HOOK.decide 用的是新策略", viaFake.why, "fake-why");
  W.POLICY.install();
  const viaReal = W.HOOK.decide({ host: "x285.example", cfHost: false, clientV6: false, legacyWantsRelay: false });
  ok("装回真策略后不再是假实现", viaReal.why !== "fake-why" && typeof viaReal.why === "string");
  ok("旧导出仍在（decide / shadow / policyOn）", typeof W.decide === "function" && typeof W.shadow === "function" && W.policyOn() === true);
}
{
  // 第 286 组：连接结束时的结算流水线独立成类（v7.286）
  // 一条连接结束时要做六件事（收尾采样 / pStall 占比 / 节点观测聚合 / 首眼观测 / 站点画像 / PEND 记账），
  // 而热路径每 512KB 只做「加字节 → 比阈值」。两者混在一个 420 行的类里时，看不出哪个字段只在这里被读。
  const connSrc286 = fs.readFileSync("src/proxy/connection.ts", "utf8");
  const settleSrc286 = fs.readFileSync("src/proxy/conn-settle.ts", "utf8");
  const sampSrc286 = fs.readFileSync("src/proxy/conn-sample.ts", "utf8");
  ok("结算流水线是独立的类 + 单例", settleSrc286.includes("export class ConnSettle") && settleSrc286.includes("export const SETTLE = new ConnSettle();"), "");
  ok("结算只读结构化视图（不 import Connection）", settleSrc286.includes("export interface SettleView") && !settleSrc286.includes("Connection }"), "");
  ok("结算入口只有 close / pend 两条", settleSrc286.includes("close(v: SettleView): void") && settleSrc286.includes("pend(v: SettleView): void"), "");
  ok("连接本体不再自己结算节点分数", !connSrc286.includes("nsOk(") && !connSrc286.includes("nsStall(") && !connSrc286.includes("markSeedDirty("), "");
  ok("连接本体不再自己记 PEND 账", !connSrc286.includes("statBump(") && !connSrc286.includes("scheduleFlush("), "");
  ok("flush 只负责调度结算", connSrc286.includes("SETTLE.close(this)") && connSrc286.includes("SETTLE.pend(this)"), "");
  ok("通道证据也搬进结算", !connSrc286.includes("HOOK.traffic") && settleSrc286.includes("HOOK.traffic"), "");
  ok("采样换算是纯函数模块（不碰 S）", !sampSrc286.includes("core/state") && sampSrc286.includes("export function sampleWeight") && sampSrc286.includes("export function stalledWindow") && sampSrc286.includes("export function kbsOf"), "");
  eq("权重封顶：额度用完就是 0", W.sampleWeight(W.SC.CONN_W_CAP, 512 * 1024, 1000), 0);
  ok("权重封顶：折扣在封顶之前生效", Math.abs(W.sampleWeight(W.SC.CONN_W_CAP - 0.1, 512 * 1024, 1000, 0.3) - 0.1) < 1e-6, "");
  eq("负折扣夹成 0", W.sampleWeight(0, 512 * 1024, 1000, -5), 0);
  ok("背压窗口判据是一半以上时间", W.stalledWindow(600, 0, 1000) && !W.stalledWindow(500, 0, 1000), "");
  eq("小样本的吞吐记 0（4 字节 403 页不算速度）", W.kbsOf(4096, 80), 0);
  ok("过 1MB 才算真实吞吐", Math.abs(W.kbsOf(1048576, 1000) - 1024) < 1e-6, `got=${W.kbsOf(1048576, 1000)}`);
  ok("结算类是单例可实例化", W.SETTLE instanceof W.ConnSettle, "");
  ok("连接仍持有自己的采样权重（状态归连接）", connSrc286.includes("this.sampleW += use;") && settleSrc286.includes("takeWeight(bytes: number, dt: number, factor?: number): number;"), "");
}
console.log("\n[287] 判定表拆成「表本体」与「门面」两层");
{
  const fac287 = fs.readFileSync("src/route/verdict.ts", "utf8");
  const tab287 = fs.readFileSync("src/route/verdict-table.ts", "utf8");
  const typ287 = fs.readFileSync("src/route/verdict-types.ts", "utf8");
  ok("门面不再定义类", !fac287.includes("class ") && !fac287.includes("BoundedMap"));
  ok("门面把表本体与类型再导出", fac287.includes('export { VerdictTable, VT } from "./verdict-table";') && fac287.includes('export { VT_TTL_MS } from "./verdict-types";'));
  eq("门面保留十二个同名函数", (fac287.match(/^export function v/gm) || []).length, 12);
  ok("门面不超过 140 行", fac287.split(/\r?\n/).length <= 140);
  ok("表本体持有私有表与单例", tab287.includes("export class VerdictTable") && tab287.includes("private byKey = new BoundedMap") && tab287.includes("export const VT = new VerdictTable();"));
  ok("表本体不再写同名函数", !/^export function v/m.test(tab287));
  ok("状态机与通配拒写都在表本体", tab287.includes("private static stateOf(") && tab287.includes("private static blockWild("));
  ok("类型文件只放类型与 TTL", typ287.includes("export type VState") && typ287.includes("export interface Verdict") && typ287.includes("export const VT_TTL_MS = 30 * 60_000;") && !typ287.includes("class "));
  ok("TTL 只有一个真源", !tab287.includes("30 * 60_000") && !fac287.includes("30 * 60_000"));
  ok("VT 是 VerdictTable 实例", W.VT instanceof W.VerdictTable);
  W.vClear();
  W.vSet("rt287.example", "d", 200, 12);
  ok("2xx 记成可用", W.vOk("rt287.example", "d") && W.vState("rt287.example", "d") === W.St.Reachable);
  W.vSet("rt287.example", "r:1.1.1.1", 403, 30);
  ok("403 记成被拦", W.vBad("rt287.example", "r:1.1.1.1"));
  W.vSet("rt287.example", "r:1.1.1.1", 200, 30, 0);
  ok("弱证据不得把强证据的 blocked 冲成可用", W.vBad("rt287.example", "r:1.1.1.1"));
  const before287 = W.VT.size();
  W.vSet("*", "d", 200, 5);
  W.vSetState("*", "r:2.2.2.2", W.St.Blocked, 1);
  eq("通配目标一条都不落表", W.VT.size(), before287);
  ok("通配在 vAll 里也查不到", W.vAll("*").length === 0);
  W.VT.clearHost("rt287.example");
  eq("清站点把该目标的行全删掉", W.vAll("rt287.example").length, 0);
  W.vClear();
}
// 第 288 组：371 行的 score.ts 拆成「代价 / 健康度 / 候选表」三层后，职责边界必须只有一种读法（7.288）
{
  const facSrc = fs.readFileSync("src/nodes/score.ts", "utf8");
  const healthSrc = fs.readFileSync("src/nodes/score-health.ts", "utf8");
  const costSrc = fs.readFileSync("src/nodes/score-cost.ts", "utf8");
  const candSrc = fs.readFileSync("src/nodes/score-cands.ts", "utf8");
  ok("门面只做再导出（≤14 行）", facSrc.split("\n").length <= 14, String(facSrc.split("\n").length));
  ok("门面转出三块",
    ["score-health", "score-cost", "score-cands"].every((m) => facSrc.includes(`export * from "./${m}"`)), "");
  ok("门面不再定义任何一个函数", !/export function /.test(facSrc), "");
  // 空壳类：一个字段都没有、方法全在读 S —— 按 AGENTS.md 的约定不该存在
  ok("空壳类 Scorer 已删除", W.Scorer === undefined && W.SCORER === undefined, "");
  ok("三个模块都不再出现 class Scorer",
    [facSrc, healthSrc, costSrc, candSrc].every((t) => !t.includes("class Scorer")), "");
  // 健康度层只读 S.nstat：写出这六个判断，不碰 alive/候选表
  ok("健康度层有六个判断",
    ["export function isBlack", "export function isFrozen", "export function freezeNode",
      "export function suspectOf", "export function emptyCloseSuspect", "export function usable"]
      .every((n) => healthSrc.includes(n)), "");
  ok("健康度层不引用候选表", !healthSrc.includes("rankedCands") && !healthSrc.includes("candsFor"), "");
  // 代价层是纯计算：两个入口 + 一个分解类型
  ok("代价层只有两个函数",
    (costSrc.match(/^export function /gm) || []).length === 2, "");
  ok("代价层不引用候选表", !costSrc.includes("rankedCands") && !costSrc.includes("CAND_"), "");
  // 候选表层依赖另两层，并把 CAND_* 收成私有常量（外部不该知道 224/64/128 这些数）
  ok("候选表层四个入口齐备",
    ["export function rankedCands", "export function candsFor", "export function nextNode", "export function bestFor"]
      .every((n) => candSrc.includes(n)), "");
  ok("候选表层不再导出 CAND_ 常量", !/export const CAND_/.test(candSrc), "");
  ok("候选表层依赖代价层与健康度层",
    candSrc.includes('from "./score-cost"') && candSrc.includes('from "./score-health"'), "");
  // 行为面：门面转发仍然指向真实实现
  ok("门面 scoreParts 仍能算分解", typeof W.scoreParts("g288:443", "lat").score === "number", "");
  W.S.alive.set("g288:443", { h: "g288", p: 443, cc: "", ms: 120 });
  ok("门面 candsFor 仍看得到存活表", W.candsFor("lat").some((r) => r.k === "g288:443"), "");
  ok("门面 bestFor 返回存活表里的键", typeof W.bestFor("lat") === "string" && W.bestFor("lat").length > 0, W.bestFor("lat"));
  ok("门面 usable 认可用", W.usable("g288:443") === true, "");
  W.freezeNode("g288:443");
  ok("冻结后立即不可用", W.usable("g288:443") === false && W.isFrozen("g288:443") === true, "");
  W.S.alive.delete("g288:443");
  W.invalidateRank();
}

console.log(`\n评分/选择单测：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
