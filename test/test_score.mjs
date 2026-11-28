import * as selection from "./score/selection.mjs";
import * as views from "./score/views.mjs";
import * as store from "./score/store.mjs";
import * as policy from "./score/policy.mjs";
import * as contracts from "./score/contracts.mjs";
import * as transport from "./score/transport.mjs";
import fs from "node:fs";
import { readView, regionsSource } from "./helpers/view-source.mjs";
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
/**
 * 节点统计这一层的源码：类型、表本体、派生视图、九类观测现在都在 `src/nodes/stat.ts` 一个文件里
 * （v7.297 把 7.282 拆出去的四段合了回来 —— 它们没有各自独立的生命周期）。
 * @returns {string} 这一层的源码
 */
const statAll = () => fs.readFileSync("src/nodes/stat.ts", "utf8");

/**
 * 诊断路由的源码拼在一起：`debug.ts`（编排 + 只读表 + 会改状态的写 + 计量 DO 诊断）/ `debug-nets.ts`（会拨号的测量）。
 * v7.283 把原来 450 行的一条 if 链按「读 / 量 / 写」拆开，源码锁改成「在整个诊断模块里存在」。
 * @returns {string} 四段源码
 */
/**
 * 指标层四段源码拼在一起：`metrics.ts`（门面）/ `rtt.ts`（入口 RTT 学习）/ `site.ts`（站点画像与族键）/ `diag.ts`（诊断结论）。
 * v7.284 把 430 行的 `metrics.ts` 拆成四块，源码锁改成「在整个指标模块里存在」。
 * @returns {string} 四段源码
 */
const metricsAll = () =>
  ["src/nodes/metrics.ts"]
    .map((p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""))
    .join("\n");

/**
 * 会拨号的诊断分支五段源码拼在一起：`debug-nets.ts`（门面）/ `debug-net-bench.ts`（出口测速）/
 * `debug-net-diag.ts`（站点诊断）/ `debug-net-probe.ts`（三个直接拨号的探针）/ `debug-net-tf.ts`（借 DO 跑 tunnelfetch）。
 * v7.294 把 344 行的 `debug-nets.ts` 按「花哪种预算」拆开，源码锁改成「在整个测网模块里存在」。
 * @returns {string} 五段源码
 */
/**
 * 会拨号的诊断分支：门面、测速、站点诊断、三个探针、判定批与真握手五个类现在都在
 * `src/routes/debug-nets.ts` 一个文件里（v7.297 合回）。
 * @returns {string} 这一层的源码
 */
const netsAll = () => fs.readFileSync("src/routes/debug-nets.ts", "utf8");

/**
 * 整条调试路由的源码：编排（`debug.ts`）+ 只读表 + 会拨号的测量（`debug-nets.ts`）+ 会改状态的写。
 * @returns {string} 四段源码
 */
const debugAll = () =>
  ["src/routes/debug.ts", "src/routes/debug-nets.ts"]
    .map((f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""))
    .join("\n");
import * as W from "./_bundle.mjs";
import { webcrypto } from "node:crypto";
import { execFileSync } from "node:child_process";

// Node 18 没有全局 crypto（Workers 有），补一个给 tlsHello() 用
if (!globalThis.crypto) globalThis.crypto = webcrypto;

let pass = 0,
  fail = 0;
/** 功能：读判定表的源码文本（合并成一个文件之后只剩这一份，源码锁读它）。 */
const verdictAll = () => fs.readFileSync("src/route/verdict.ts", "utf8");
/** 功能：把「站点 × 中继」成功率事实的五个文件合成一段文本（源码锁读它）。 */
const psAll = () => fs.readFileSync("src/route/psfacts.ts", "utf8");
/** 功能：把一轮池子维护的编排层与三个执行器的源码合并成一段文本（源码锁读它）。 */
const scanAll = () =>
  ["src/px/scan.ts"]
    .map((f) => fs.readFileSync(f, "utf8")).join("\n");
/** 功能：把决策本体、候选排序与 CF 分支树三份源码合并成一段文本（源码锁读它）。 */
const policyAll = () => fs.readFileSync("src/route/policy.ts", "utf8");

/** 功能：把挑路的源码合并成一段文本，源码锁读它（四个类现在同在一个文件里）。 */
const pickAll = () => fs.readFileSync("src/px/pickpath.ts", "utf8");
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

const reset = () => {
  W.NODE_MEMORY.alive.clear();
  W.NODE_MEMORY.stats.clear();
  W.HOSTS.nodes.clear();
  W.HOSTS.direct.clear();
  W.NODE_MEMORY.rankCache.clear();
  W.SELECTION_MEMORY.current = { lat: "", tput: "" };
  W.SELECTION_MEMORY.previous = { lat: "", tput: "" };
  W.SELECTION_MEMORY.switchedAt = { lat: 0, tput: 0 };
  W.SELECTION_MEMORY.switches = { lat: [], tput: [] };
  // 模拟「新 isolate」：排行表也一起清（生产里池子换代同样会清）
  W.CANDS.reset();
};
const node = (k, patch = {}) => {
  const i = k.lastIndexOf(":");
  W.NODE_MEMORY.alive.set(k, { h: k.slice(0, i), p: Number(k.slice(i + 1)) || 443, cc: "", ms: 100 });
  Object.assign(W.NodeStatsTable.nsGet(k), patch);
};

/* ---------- 1. 直方图分位 ---------- */
reset();
eq("空直方图 p50", W.pcts(W.NodeStatsTable.nsGet("x:1")).p50, 0);
eq("空直方图 p90", W.pcts(W.NodeStatsTable.nsGet("x:1")).p90, 0);

const s1 = W.NodeStatsTable.nsGet("h1:443");
s1.hist[7] = 10; // 2 MB/s 桶
const q1 = W.pcts(s1);
ok("单桶 p50 落在 2MB 附近", q1.p50 > 1.4e6 && q1.p50 < 2.9e6, q1.p50);
ok("单桶 cap ≤ p50*2.5", q1.cap <= q1.p50 * 2.5 + 1, `${q1.cap} vs ${q1.p50}`);

const s2 = W.NodeStatsTable.nsGet("h2:443");
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
const st2n = W.NODE_MEMORY.stats.get("t2:443");
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
const sc = W.NODE_MEMORY.stats.get("cum:443");
sc.bytesDown = 200 * 1048576;
sc.hist[7] = 5;
eq("旧累计字节不通过吞吐准入", W.scoreParts("cum:443", "tput").confB, 0);

// 读时衰减：不产生新事件，旧样本自己变旧
reset();
node("age:443", { tcp: 50, okW: 10 });
const sa = W.NODE_MEMORY.stats.get("age:443");
const beforeW = W.effView(sa).okW;
sa.at = Date.now() - 6 * 3600e3;
ok("6 小时后有效权重减半", Math.abs(W.effView(sa).okW - beforeW / 2) < 0.01, `${beforeW} → ${W.effView(sa).okW}`);
ok("老化后分数变差", W.costOf("age:443", "lat") > 0);

// 吞吐置信度看"有效窗口数"，不看连接数
reset();
node("one:443", { tcp: 50 });
node("many:443", { tcp: 50 });
const sOne = W.NODE_MEMORY.stats.get("one:443");
sOne.hist[7] = 4;
sOne.sumW = 4;
sOne.sumW2 = 16;
sOne.recentBytesW = 8 * 1048576;
sOne.lastSampleAt = Date.now();
const sMany = W.NODE_MEMORY.stats.get("many:443");
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
const sL = W.NODE_MEMORY.stats.get("lucky:443");
sL.hist[11] = 1;
sL.sumW = 1;
sL.sumW2 = 1;
sL.recentBytesW = 1048576;
sL.lastSampleAt = Date.now();
node("steady:443", { tcp: 50 });
const sS = W.NODE_MEMORY.stats.get("steady:443");
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
await selection.case001({ W, ok, eq });

/* ---------- 3. 门槛与过滤 ---------- */
reset();
eq("无样本 avail = 0.5", W.availOf(W.NodeStatsTable.nsGet("z:443")), 0.5);
await selection.case002({ W, ok });
reset();
node("u:443", { okW: 2, failW: 8, tcp: 50 });
eq(
  "长期低可用被排除",
  W.CANDS.list("lat").some((x) => x.k === "u:443"),
  false,
);

reset();
node("small:443", { okW: 0, failW: 1, tcp: 50 });
ok(
  "小样本失败只软惩罚，不出局",
  W.CANDS.list("lat").some((x) => x.k === "small:443"),
  true,
);

reset();
node("e:443", { trafficOkW: 0, eCloseP: 6, tcp: 50 });
eq("中转后大量空关闭 → 可疑", W.emptyCloseSuspect("e:443"), true);
eq(
  "可疑节点被排除",
  W.CANDS.list("lat").some((x) => x.k === "e:443"),
  false,
);
// 空关闭计数必须跟着半衰期衰减，否则老账永远赖着，节点一旦攒够 5 次就被永久排除
await selection.case003({ W, ok, eq });

/* ---------- 4. Selector（地区硬要求） ---------- */
await selection.case004({ reset, node, W, eq });

/* ---------- 4b. Selector ---------- */
reset();
W.SELECTION_MEMORY.switchedAt = { lat: 0, tput: 0 };
node("cur:443", { tcp: 400, tls: 60, okW: 20 });
node("new:443", { tcp: 50, tls: 60, okW: 20 });
W.SELECTION_MEMORY.current.lat = "cur:443";
const switched = W.SEL.maybeSwitch({ pxDwellMin: 0 }, "lat");
eq("明显更优 → 切换", switched, true);
eq("切换后 CUR 指向新节点", W.SELECTION_MEMORY.current.lat, "new:443");

reset();
W.SELECTION_MEMORY.switchedAt = { lat: 0, tput: 0 };
node("c1:443", { tcp: 100, tls: 60, okW: 20 });
node("c2:443", { tcp: 105, tls: 60, okW: 20 });
W.SELECTION_MEMORY.current.lat = "c1:443";
eq("差距小于滞回 → 不切", W.SEL.maybeSwitch({ pxDwellMin: 0 }, "lat"), false);

reset();
node("d1:443", { tcp: 300, tls: 60, okW: 20 });
node("d2:443", { tcp: 50, tls: 60, okW: 20 });
W.SELECTION_MEMORY.current.lat = "d1:443";
W.SELECTION_MEMORY.switchedAt.lat = Date.now(); // 刚切过 → 驻留期内
eq("驻留期内不切", W.SEL.maybeSwitch({ pxDwellMin: 0 }, "lat"), false);

// 驻留配置必须真的生效：pxDwellMin=30 且刚切过 30 分钟 → 默认 10 分钟已过，但 30 分钟还没到
eq("dwell 默认 lat 10 分钟", W.dwellOf({}, "lat"), 10 * 60000);
eq("dwell 默认 tput 20 分钟", W.dwellOf({}, "tput"), 20 * 60000);
eq("dwell 接受正数覆盖", W.dwellOf({ pxDwellMin: "30" }, "lat"), 30 * 60000);
eq("dwell 0 回落默认", W.dwellOf({ pxDwellMin: "0" }, "lat"), 10 * 60000);
reset();
node("w1:443", { tcp: 300, tls: 60, okW: 20 });
node("w2:443", { tcp: 50, tls: 60, okW: 20 });
W.SELECTION_MEMORY.current.lat = "w1:443";
W.SELECTION_MEMORY.switchedAt.lat = Date.now() - 30 * 60000;
eq("pxDwellMin=60 覆盖默认 10 分钟", W.SEL.maybeSwitch({ pxDwellMin: "60" }, "lat"), false);
eq("未设置时按默认 10 分钟切换", W.SEL.maybeSwitch({}, "lat"), true);

reset();
node("f1:443", { tcp: 100, okW: 10 });
node("f2:443", { tcp: 200, okW: 10 });
W.SELECTION_MEMORY.current.lat = "f1:443";
W.SELECTION_MEMORY.previous.lat = "f2:443";
W.SELECTION_MEMORY.switchedAt.lat = Date.now();
W.SEL.onFail({}, "lat", "f1:443", false);
eq("切换后 60s 内失败 → 回滚", W.SELECTION_MEMORY.current.lat, "f2:443");

// 回滚目标自己已经冻结/冷却时，不能把游标送回坏节点
reset();
node("g1:443", { tcp: 100, okW: 10 });
node("g2:443", { tcp: 200, okW: 10 });
W.SELECTION_MEMORY.current.lat = "g1:443";
W.SELECTION_MEMORY.previous.lat = "g2:443";
W.SELECTION_MEMORY.switchedAt.lat = Date.now();
W.freezeNode("g2:443");
W.SEL.onFail({}, "lat", "g1:443", false);
ok("不回滚到已冻结的 prev", W.SELECTION_MEMORY.current.lat !== "g2:443", W.SELECTION_MEMORY.current.lat);

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
c.win.begin(Date.now() - 2000, 0, 0);
c.down = 2 * 1024 * 1024;
const keep = await c.tick(fakeWs);
eq("tick 返回 true（未触发背压）", keep, true);
ok("tick 后节点有吞吐样本", (W.NODE_MEMORY.stats.get("n:443").bytesDown || 0) > 0, JSON.stringify(W.NODE_MEMORY.stats.get("n:443")));
eq("tick 推进了水位", c.mark > c.down, true);

// 直连（node 为空）不应产生样本
reset();
const c2 = new W.Connection({}, {}, "lat", "");
c2.down = 2 * 1024 * 1024;
c2.win.begin(Date.now() - 2000, 0, 0);
await c2.tick(fakeWs);
eq("直连不产生吞吐样本", W.NODE_MEMORY.stats.size, 0);

// flush 在没有 id 时静默返回
c2.flush();
eq("无 id 时 flush 不改状态", c2.reportedUp, 0);

/* ---------- 6. 本轮优化的回归 ---------- */
// 鉴权成功但零字节的连接（探测/被客户端立刻取消）也要落 node/direct 计数
reset();
const c3 = new W.Connection({}, {}, "tput", "");
c3.id = "u-test";
c3.node = "n9:443";
const nBefore = W.COUNTER.values.node || 0;
c3.flush(true);
eq("零字节收尾也计入 node", W.COUNTER.values.node, nBefore + 1);

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
const e0 = W.ERROR_MEMORY.rows.length;
W.logErr("dup-msg-for-test");
W.logErr("dup-msg-for-test");
eq("5 秒内同一错误只记一次", W.ERROR_MEMORY.rows.length, e0 + 1);

// 成功连接要给节点记 ok/trafficOkW，否则面板永远显示 0、可用性门槛永远不生效
reset();
const c6 = new W.Connection({}, {}, "tput", "");
c6.id = "u3";
c6.node = "ok2:443";
c6.down = 2048;
c6.flush(true);
eq("成功连接记一次 ok", (W.NODE_MEMORY.stats.get("ok2:443") || {}).okW, 1);
eq("成功连接进入可用性样本", (W.NODE_MEMORY.stats.get("ok2:443") || {}).trafficOkW, 1);

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
eq("长连接收尾不覆盖站点 bps", (W.HOSTS.nodes.get("stream.test").get("sc:443") || {}).bps, undefined);

// resetFail 只清计数：成功样本由 flush 统一记一次，不能在这里重复 +1
reset();
node("rf:443", {});
W.SELECTION_MEMORY.failSeen = 1;
W.SELECTION_MEMORY.failCount = 2;
await W.SEL.resetFail({}, "rf:443");
eq("resetFail 不重复记成功", W.NodeStatsTable.nsGet("rf:443").okW, 0);
eq("resetFail 清零记忆", W.SELECTION_MEMORY.failCount, 0);

reset();
const c7 = new W.Connection({}, {}, "tput", "");
c7.id = "u4";
c7.node = "bad2:443";
c7.down = 2048;
c7.failed = true;
c7.flush(true);
eq("断流的连接不记 ok", (W.NODE_MEMORY.stats.get("bad2:443") || {}).okW || 0, 0);

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
const hnStat = W.HOSTS.nodes.get("t.example").get("n1:443");
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
await selection.case005({ mkDO, eq });

// 节点快照不能随池子换代无限增长
await selection.case006({ mkDO, eq, ok });

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
eq("站点排行：快的在前", W.HOSTS.rank("site.test", "lat")[0].k, "fast:443");

const st1 = { host: "site.test" };
eq("按站点选节点", W.SEL.pick({ pxShadow: 0 }, "tput", st1), "fast:443");
eq("命中偏好不算试探", st1.hostTrial, false);

// 冻结的节点不能出现在站点排行里
W.freezeNode("fast:443");
eq("冻结节点被跳过", W.HOSTS.rank("site.test", "tput")[0].k, "slow:443");
W.NodeStatsTable.nsGet("fast:443").freeUntil = 0;

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
eq("未试节点 = 全局最优且没在这个站出现过", W.HOSTS.untried("untried.test", "lat"), "u2:443");

// 游标指向上一代候选池的节点：pick 必须自愈，而不是继续拨死地址
reset();
node("v1:443", { tcp: 50 });
node("v2:443", { tcp: 80 });
W.SELECTION_MEMORY.current.lat = "gone:443";
const rndV = Math.random;
Math.random = () => 0.5; // 抽样器带噪声：固定随机数只验"游标自愈 + 选到分更低的"
const pv = W.SEL.pick({ pxShadow: 0 }, "lat", null);
Math.random = rndV;
eq("游标失效 → 选当前最优", pv, "v1:443");
eq("游标自愈写回", W.SELECTION_MEMORY.current.lat, "v1:443");

// 一个候选都没有：返回空，并把游标清掉（不能一直显示已经不存在的节点）
reset();
W.SELECTION_MEMORY.current.lat = "gone:443";
eq("无候选时返回空", W.SEL.pick({ pxShadow: 0 }, "lat", null), "");
eq("无候选时清空游标", W.SELECTION_MEMORY.current.lat, "");

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
eq("同族两个域名共用一张表", W.HOSTS.nodes.get("example.com").size, 2);
eq("族内按首字节排序", W.HOSTS.rank("example.com", "lat")[0].k, "f1:443");

// 保质期：7 小时前的样本降权 300ms
reset();
node("old:443", { tcp: 50 });
node("new:443", { tcp: 50 });
W.hostNodeMark("stale.test", "old:443", { ok: true, bad: false, bytes: 1, ttfb: 100 });
W.hostNodeMark("stale.test", "new:443", { ok: true, bad: false, bytes: 1, ttfb: 300 });
W.HOSTS.nodes.get("stale.test").get("old:443").at = Date.now() - 7 * 3600e3;
W.NODE_MEMORY.rankCache.clear();
eq("过期样本被降权", W.HOSTS.rank("stale.test", "lat")[0].k, "new:443");

// 新样本要让缓存失效
W.hostNodeMark("stale.test", "old:443", { ok: true, bad: false, bytes: 1, ttfb: 50 });
eq("新样本刷新排行", W.HOSTS.rank("stale.test", "lat")[0].k, "old:443");

// 站点级 lat 与 tput 可以选出不同节点（TTFB 快 ≠ 带宽大）
reset();
node("fast-ttfb:443", { tcp: 50 });
node("fat-pipe:443", { tcp: 300 });
W.hostNodeMark("speed.test", "fast-ttfb:443", { ok: 1, bad: 0, bytes: 100, ttfb: 50, bps: 1048576 });
W.hostNodeMark("speed.test", "fat-pipe:443", { ok: 1, bad: 0, bytes: 100, ttfb: 300, bps: 8 * 1048576 });
eq("站点 lat：首字节快的优先", W.HOSTS.rank("speed.test", "lat")[0].k, "fast-ttfb:443");
eq("站点 tput：带宽大的优先", W.HOSTS.rank("speed.test", "tput")[0].k, "fat-pipe:443");

// 域名族：写入用 api.x.com，读取用 x.com 也要命中同一张表
reset();
node("g1:443", { tcp: 50 });
W.hostNodeMark("api.github.com", "g1:443", { ok: 1, bad: 0, bytes: 100, ttfb: 60 });
eq("族键读写一致", W.HOSTS.rank("github.com", "lat")[0].k, "g1:443");
const stFam = { host: "api.github.com" };
eq("别名域名按族选节点", W.SEL.pick({ pxShadow: 0 }, "lat", stFam), "g1:443");

/* ---------- 11. 跨 isolate 节点快照 ---------- */
await selection.case007({ W, eq });

// 面板渲染：KB/s 带样本数；没有样本显示"未用"
await views.case008({ W, ok });

/* ---------- 11. v2.1：风险先验 / 不跨 isolate / 自适应探索 ---------- */
reset();
eq("无样本 pFailRisk = 0.1（不加不确定性溢价）", W.pFailOf(W.NodeStatsTable.nsGet("fresh:443")), 0.1);

await selection.case009({ W, ok, eq });

await selection.case010({ W, ok });

reset();
node("e1:443", { tcp: 50 });
node("e2:443", { tcp: 60 });
W.SELECTION_MEMORY.current.tput = "e1:443";
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
const sf = W.NODE_MEMORY.stats.get("f1:443");
sf.hist[7] = 4;
sf.sumW = 4;
sf.sumW2 = 4;
sf.recentBytesW = 8 * 1048576;
sf.lastSampleAt = Date.now();
W.SELECTION_MEMORY.current.tput = "f1:443";
const stF = { host: "steady.test" };
const picked2 = W.SEL.pick({ pxShadow: 0.05 }, "tput", stF);
Math.random = rnd1;
// f1 有带宽样本（σ 小），f2 一条样本都没有：乐观面会把流量先给 f2 —— 这正是"没有探索率也能探索"
ok("单层抽样器仍会去探未测节点", picked2 === "f2:443", picked2);
eq("没有标记站点试探", stF.hostTrial === true, false);

reset();
node("c1:443", { tcp: 50 });
node("c2:443", { tcp: 60 });
W.CANDS.list("lat");
eq("候选数被记录（观测用）", W.NODE_MEMORY.candidateCount, 2);

/* ---------- 12. 排行缓存 / 站点中途采样 / latN ---------- */
reset();
for (let i = 0; i < 30; i++) node(`m${i}:443`, { tcp: 50 + i, okW: 10 });
const c30 = W.CANDS.list("lat");
eq("30 个候选全部返回", c30.length, 30);
ok("大规模下启用了排行缓存", (W.CANDS.cache.at.lat || 0) > 0);
// 排行缓存按模式各算各的：曾经两模式共用 t，tput 重算会给 lat 续命（实际有效期 40 s）
W.NodeStatsTable.invalidateRank();
eq("缓存起点：30 个候选", W.CANDS.list("lat").length, 30);
W.CANDS.cache.t = Date.now(); // 全局戳是新的……
W.CANDS.cache.at = { lat: Date.now() - 25000, tput: Date.now() }; // ……但 lat 那条是 25 秒前算的
node("pm-new:443", { tcp: 90, okW: 10 });
eq("lat 缓存过期就重算（不被 tput 续命）", W.CANDS.list("lat").length, 31);
W.CANDS.cache.at = { lat: Date.now(), tput: Date.now() - 25000 };
node("pm-new2:443", { tcp: 91, okW: 10 });
eq("lat 缓存新鲜就复用（不白算）", W.CANDS.list("lat").length, 31);

// 线上 alive 实测就是 18 个：低于 CAND_CACHE_MIN(24)，排行全程现算
reset();
for (let i = 0; i < 18; i++) node(`n18-${i}:443`, { tcp: 60 + i, okW: 10 });
W.NodeStatsTable.invalidateRank();
eq("18 个候选全部返回", W.CANDS.list("lat").length, 18);
eq("18 个节点（线上实测值）不启用排行缓存", W.CANDS.cache.at.lat || 0, 0);

/* 探活失败要分原因：err 可能是地区/线路，notTls/noCf 是节点事实 */
W.POOL_MEMORY.probeWhy = {};
W.noteProbe(null);
W.noteProbe({ bad: "not-tls" });
W.noteProbe({ bad: "no-cf-cert" });
W.noteProbe({ ms: 12, tcp: 5, tls: 7 });
eq("探活结果按原因分类", W.POOL_MEMORY.probeWhy, { err: 1, notTls: 1, noCf: 1, ok: 1 });

/* 延迟模式必须能看见带宽：同延迟下 1MB/s 的节点分数要明显更高 */
reset();
node("wide:443", { tcp: 60, okW: 10 });
node("narrow:443", { tcp: 60, okW: 10 });
W.NodeStatsTable.nsSpeed("wide:443", 20 * 1048576, 1048576, {}, 1);
W.NodeStatsTable.nsSpeed("narrow:443", 1 * 1048576, 1048576, {}, 1);
ok(
  "lat：同延迟下窄带宽节点分数更高",
  W.costOf("wide:443", "lat") + 50 < W.costOf("narrow:443", "lat"),
  `${Math.round(W.costOf("wide:443", "lat"))} vs ${Math.round(W.costOf("narrow:443", "lat"))}`,
);

/* 探活高估（420ms）要能被真实样本（80ms）纠正，否则这种节点永远翻不了身 */
reset();
node("shy2:443", { tcp: 420, okW: 10 });
W.NodeStatsTable.nsLatency("shy2:443", 80);
ok("lat：探活高估被真实样本纠正", W.scoreParts("shy2:443", "lat").latencyMs < 200, Math.round(W.scoreParts("shy2:443", "lat").latencyMs));
W.NodeStatsTable.nsGet(c30[0].k).blackUntil = Date.now() + 60000;
eq(
  "缓存之外仍会过滤黑名单",
  W.CANDS.list("lat").some((x) => x.k === c30[0].k),
  false,
);

reset();
node("bs:443", {});
W.hostNodeMark("site-bps.test", "bs:443", { ok: 1, bad: 0, ttfb: 50 });
W.hostNodeMark("site-bps.test", "bs:443", { bps: 1048576 });
const hs = W.HOSTS.nodes.get("site-bps.test").get("bs:443");
eq("中途吞吐采样不算连接样本", hs.n, 1);
ok("站点 bps 记录下来了", hs.bps > 0, String(hs.bps));
W.hostNodeMark("neutral.test", "n0:443", { ok: 0, bad: 0, bytes: 100, ttfb: 100 });
eq("0 字节 0 失败不算站点样本", W.HOSTS.nodes.get("neutral.test").get("n0:443").n, 0);

// 跨 isolate 不再共享品质结论：seed 只留候选名单（k/h/p/cc），
// 延迟/吞吐/成功率/站点偏好一律由本 isolate 自己估
reset();
node("hpb:443", { tcp: 50 });
for (let i = 0; i < 3; i++) W.hostNodeMark("site-seed.test", "hpb:443", { ok: 1, bad: 0, bytes: 1024, ttfb: 80 });
W.hostNodeMark("site-seed.test", "hpb:443", { bps: 2 * 1048576 });
await selection.case011({ W, eq });

// 跨 isolate 快照按流量挑前 16 个，而不是 Map 的前 16 个
reset();
for (let i = 0; i < 20; i++) {
  node(`sn${i}:443`, {});
  W.NodeStatsTable.nsGet(`sn${i}:443`).bytesDown = i * 1024 * 1024;
  W.NodeStatsTable.nsGet(`sn${i}:443`).trafficOkW = i + 1;
}
const snapN = W.spdSnapshot();
ok("快照包含流量最大的节点", !!snapN["sn19:443"], Object.keys(snapN).join(","));
eq("快照最多 16 个", Object.keys(snapN).length, 16);

reset();
node("ln:443", { tcp: 50, probeSamples: 4, okW: 4 });
eq("latN = 探活 + 成功连接", W.scoreParts("ln:443", "lat").latN, 8);

/* ---------- 13. 归因 / 负载 / 快速窗口 / 站点门槛 ---------- */
reset();
await selection.case012({ W, ok, eq });

reset();
node("fk:443", {});
const sfk = W.NodeStatsTable.nsGet("fk:443");
W.NodeStatsTable.nsOk("fk:443", 0, 0);
W.NodeStatsTable.nsFail("fk:443");
W.NodeStatsTable.nsFail("fk:443");
ok("10 分钟窗口内 2 次失败会抬高近期风险", W.pFailFast(sfk) > 0.15, String(W.pFailFast(sfk)));
ok("总分用 max(慢, 快)", W.scoreParts("fk:443", "lat").pFailRisk >= W.pFailFast(sfk));

reset();
await selection.case013({ W, ok });

reset();
const cIn = new W.Connection({}, {}, "tput", "");
cIn.node = "load:443";
cIn.syncInflight();
eq("attach 记在途", W.NODE_MEMORY.inflight.get("load:443"), 1);
cIn.node = "load2:443";
cIn.syncInflight();
eq("换节点迁移在途", [W.NODE_MEMORY.inflight.get("load:443") || 0, W.NODE_MEMORY.inflight.get("load2:443")], [0, 1]);
cIn.clearInflight();
eq("收尾清在途", W.NODE_MEMORY.inflight.get("load2:443") || 0, 0);

reset();
node("busy:443", { tcp: 50, okW: 10 });
node("idle:443", { tcp: 60, okW: 10 });
W.SELECTION_MEMORY.current.tput = "busy:443";
W.NODE_MEMORY.inflight.set("busy:443", 3);
const stLoad = { host: "" };
eq("当前节点过载时溢出到空闲候选", W.SEL.pick({ pxShadow: 0 }, "tput", stLoad), "idle:443");
W.NODE_MEMORY.inflight.clear();

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
for (const row of W.HOSTS.nodes.get("thr.test").values()) row.at = Date.now() - 3 * 3600e3;
W.NODE_MEMORY.rankCache.clear();
eq("站点样本过期 → 退回全局", W.SEL.pick({ pxShadow: 0 }, "lat", { host: "thr.test" }), "g1:443");

// rtt 老键不存在时只读一次 KV：订阅轮询不能每次都打一次
await selection.case014({ W, eq, ok });

// 全局闸门命中时不能每条连接都读一次 KV：一次检查后本地基线要推进
await selection.case015({ W, eq });

// 日计数批次失败要能退回基线，否则这批连接数永久丢
await selection.case016({ W, eq });

// 真实成功要解除冻结，否则一个 30 分钟冻结只有等它自己过期
await selection.case017({ reset, node, W, eq });

// 影子/站点试探失败只罚节点，不推进全局失败记忆
reset();
node("tr:443", { tcp: 50 });
W.SELECTION_MEMORY.failCount = 0;
W.SELECTION_MEMORY.failSeen = 0;
await W.SEL.bumpFail({}, "tput", "tr:443", true);
eq("影子失败不进全局失败记忆", W.SELECTION_MEMORY.failCount, 0);
eq("影子失败不置失败标志", W.SELECTION_MEMORY.failSeen, 0);
eq("影子失败仍记节点失败", W.NodeStatsTable.nsGet("tr:443").failW >= 1, true);
eq("影子失败冻结节点", W.isFrozen("tr:443"), true);

// 灾备快照不能用 |0：>2^31 的用量会溢出成负数/0
await selection.case018({ W, eq });

// 新失败不能把已有的长冷却缩短
reset();
await selection.case019({ W, ok });
// DO 落盘失败要回滚内存，否则 pendFlush 重发同一批会双计
await store.case020({ W, eq });

// DO 请求串行化：并发 /add 不能交错写坏内存/storage
await selection.case021({ mkDO, eq });

/* ---------- 8d. /add 收到 null / 数组 body 不能把 DO 打 500 ---------- */
await selection.case022({ mkDO, eq });

/* ---------- 8e. /seed 回填历史时也要带回当日字段 ---------- */
await selection.case023({ mkDO, eq });

/* ---------- 9. 影子概率：选择器 / 控制页 / /proxyip 同源 ---------- */
eq("pxShadow 未设置 → 5%", W.shadowRate({}), 0.05);
eq('pxShadow="0" → 关闭探索', W.shadowRate({ pxShadow: "0" }), 0);
eq("pxShadow=0.2 原样", W.shadowRate({ pxShadow: "0.2" }), 0.2);
eq("pxShadow 非法 → 回落 5%", W.shadowRate({ pxShadow: "abc" }), 0.05);
eq("pxShadow 负数 → 回落 5%", W.shadowRate({ pxShadow: "-1" }), 0.05);
eq("pxShadow 封顶 1", W.shadowRate({ pxShadow: "3" }), 1);

/* ---------- 10. 今日用量按 DO 的日期判断 ---------- */
await selection.case024({ W, eq });

/* ---------- 11. /set 恢复累计不能抹掉今日 ---------- */
await selection.case025({ mkDO, eq, ok });

/* ---------- 恢复历史：同日 dU/dD 取较大值，旧日快照不覆盖今天 ---------- */
await selection.case026({ mkDO, eq });

/* ---------- 灾备快照带当日字段，且只合并同一天 ---------- */
await selection.case027({ W, eq });

/* ---------- 12. 并发闸：不漏任务、不超上限 ---------- */
await selection.case028({ W, eq, ok });

/* ---------- 节点快照的 key 不能污染原型 ---------- */
await selection.case029({ mkDO, eq, ok });

/* ---------- 探活不能灌水面板成功率 ---------- */
await selection.case030({ W, eq });

/* ---------- 14. 评分 v2.1：滞回主项 / 地区排除 / 快失败窗口 / 站点衰减 ---------- */
// 滞回按"主项"算：250ms → 60ms 必须切得动（旧实现门槛 0.15×总分=210ms，永远切不动）
reset();
node("hz1:443", { tcp: 250, tls: 60, okW: 20, failW: 2 });
node("hz2:443", { tcp: 60, tls: 60, okW: 20, failW: 2 });
W.SELECTION_MEMORY.current.lat = "hz1:443";
eq("lat 滞回按延迟分量：250ms → 60ms 会切", W.SEL.maybeSwitch({ pxDwellMin: 0 }, "lat"), true);
// 5ms 的差异仍然不切：改的是门槛基准，不是把门槛拿掉
reset();
node("hz3:443", { tcp: 100, tls: 60, okW: 20, failW: 2 });
node("hz4:443", { tcp: 105, tls: 60, okW: 20, failW: 2 });
W.SELECTION_MEMORY.current.lat = "hz3:443";
eq("lat 滞回仍挡住 5ms 抖动", W.SEL.maybeSwitch({ pxDwellMin: 0 }, "lat"), false);

// 地区选路必须和全局候选表共用排除规则
reset();
W.NODE_MEMORY.inflight.clear();
node("rde1:443", { tcp: 60, tls: 10, okW: 5, failW: 0, trafficOkW: 5, eCloseP: 6 });
node("rde2:443", { tcp: 180, tls: 20, okW: 20, failW: 1, trafficOkW: 20, eCloseP: 0 });
W.NODE_MEMORY.alive.get("rde1:443").cc = "DE";
W.NODE_MEMORY.alive.get("rde2:443").cc = "DE";
eq("可疑节点进不了全局候选", W.CANDS.list("lat").some((x) => x.k === "rde1:443"), false);
const rOk = await W.SEL.region({}, "DE", "lat");
eq("地区选路跳过可疑节点", rOk && rOk.h + ":" + rOk.p, "rde2:443");
W.NodeStatsTable.nsFail("rde2:443"); // 冷却 → 硬排除
const rLast = await W.SEL.region({}, "DE", "lat");
eq("地区只剩可疑节点时仍返回（硬要求，不返回 null）", rLast && rLast.h + ":" + rLast.p, "rde1:443");

// 地区选路的负载感知：全国流量不能全压在第一名
reset();
W.NODE_MEMORY.inflight.clear();
node("rjp1:443", { tcp: 60, tls: 10, okW: 20, failW: 1, trafficOkW: 20 });
node("rjp2:443", { tcp: 70, tls: 10, okW: 20, failW: 1, trafficOkW: 20 });
W.NODE_MEMORY.alive.get("rjp1:443").cc = "JP";
W.NODE_MEMORY.alive.get("rjp2:443").cc = "JP";
W.NODE_MEMORY.inflight.set("rjp1:443", 4);
const rLb = await W.SEL.region({}, "JP", "lat");
eq("地区选路避开在途堆积", rLb && rLb.h + ":" + rLb.p, "rjp2:443");
W.NODE_MEMORY.inflight.clear();

// 快失败窗口：9 分钟前的 4 次成功不能把刚刚的 3 次失败稀释成"健康"
reset();
const ffx = W.NodeStatsTable.nsGet("ffx:443");
for (let i = 0; i < 4; i++) W.NodeStatsTable.nsOk("ffx:443", 50, 10);
ffx.winAt -= 9 * 60000;
ffx.at -= 9 * 60000;
for (let i = 0; i < 3; i++) W.NodeStatsTable.nsFail("ffx:443");
ok("旧成功不按次数稀释新失败", W.pFailFast(ffx) > 0.27, String(W.pFailFast(ffx)));
ok("旧成功同时被时间权重压掉", ffx.winOk < 1, String(ffx.winOk));

// 站点画像：一次封禁不是判决书
reset();
W.hostNodeMark("decay.test", "n1:443", { ok: false, bad: true, ttfb: 0 });
W.hostNodeMark("decay.test", "n1:443", { ok: false, bad: true, ttfb: 0 });
const dRec = W.HOSTS.nodes.get("decay.test").get("n1:443");
const dBefore = W.hostScore(dRec, "lat", Date.now());
dRec.at -= 7 * 3600e3;
W.hostNodeMark("decay.test", "n1:443", { ok: true, bad: false, ttfb: 100 });
eq("站点坏样本空闲 7 小时后减半", dRec.bad, 1);
ok("站点分随之回升", W.hostScore(dRec, "lat", Date.now()) < dBefore, `${Math.round(dBefore)}ms`);

// 冷启动不做 6h 轮换：否则第一条 cron 就把第 1 名换成第 2 名
reset();
node("sc1:443", { tcp: 60, okW: 20 });
node("sc2:443", { tcp: 70, okW: 20 });
W.SELECTION_MEMORY.current.lat = "sc1:443";
W.SELECTION_MEMORY.switchedAt = { lat: 0, tput: 0 };
W.SEL.sched({ pxSchedH: 6 });
eq("冷启动不轮换", W.SELECTION_MEMORY.current.lat, "sc1:443");
W.SELECTION_MEMORY.switchedAt = { lat: Date.now() - 7 * 3600e3, tput: 0 };
W.SEL.sched({ pxSchedH: 6 });
eq("6 小时没切换才轮换", W.SELECTION_MEMORY.current.lat, "sc2:443");

// 真实首字节回流：探活快、实际慢的节点不能按探活算延迟
reset();
node("liar:443", { tcp: 25, tls: 40, okW: 5 });
W.NodeStatsTable.nsLatency("liar:443", 420);
ok("真实首字节远慢于探活 → 按真实值算", W.scoreParts("liar:443", "lat").latencyMs > 300, String(W.scoreParts("liar:443", "lat").latencyMs));
reset();
node("honest:443", { tcp: 60, tls: 40, okW: 5 });
W.NodeStatsTable.nsLatency("honest:443", 130);
ok("真实首字节与探活接近 → 不触发", W.scoreParts("honest:443", "lat").latencyMs < 200, String(W.scoreParts("honest:443", "lat").latencyMs));

// —— 单层抽样：未测节点被抽到，测过且差的节点退场 ——
reset();
W.NodeStatsTable.invalidateRank();
node("k1:443", { tcp: 60, okW: 40 });
node("k2:443", { tcp: 400, okW: 40 });
node("k3:443", { tcp: 70 });
await selection.case031({ W, ok });

// —— 回归：pStall 的分母必须是"全部连接的总时长" ——
// 早先只在"这条连接卡过"时才累加 runMs：100 条 30 秒健康连接 + 1 条 5 秒连接卡 2 秒，
// 算出来 pStall=0.34（真实占比 0.0007），单次卡顿白送 800+ ms，还会踩中 +400 的重罚档。
reset();
node("ps:443", { tcp: 100 });
for (let i = 0; i < 100; i++) W.NodeStatsTable.nsStall("ps:443", 0, 30000);
W.NodeStatsTable.nsStall("ps:443", 2000, 5000);
const psV = W.scoreParts("ps:443", "lat").pStall;
ok("pStall 按连接总时长稀释", psV < 0.01, psV.toFixed(5));
ok("pStall 没被抹平（2 秒卡顿还在）", psV > 0.0001, psV.toFixed(5));

// —— 回归：延迟模式的 xferMs 要按样本新鲜度混合先验 ——
// 早先直读 s.capBps，而直方图衰减是等比缩放（分位不变）→ 一周前测到的 16MB/s 永久少算 70ms。
reset();
node("xf:443", { tcp: 100, okW: 20 });
const xf = W.NodeStatsTable.nsGet("xf:443");
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
W.NodeStatsTable.invalidateRank();
node("ex1:443", { tcp: 60, okW: 200 });
node("ex2:443", { tcp: 70 });
node("ex3:443", { tcp: 80 });
const exHit = new Set();
for (let i = 0; i < 400; i++) {
  const k = W.SEL.pick({ pxShadow: 0.5 }, "lat", { host: "" });
  exHit.add(k);
  W.NodeStatsTable.nsOk(k, 0, 0); // 真实连接成功 → 样本 +1，乐观面随样本收缩
}
ok("延迟模式影子采样可达", exHit.size > 1, [...exHit].join(","));
ok("延迟模式大多数请求仍走王者", exHit.has("ex1:443"), [...exHit].join(","));

// —— 回归：吞吐模式也走同一套抽样，不再"粘滞游标" ——
reset();
W.NodeStatsTable.invalidateRank();
node("tp1:443", { tcp: 60, okW: 20 });
node("tp2:443", { tcp: 80, okW: 20 });
const tpHit = new Set();
for (let i = 0; i < 400; i++) tpHit.add(W.SEL.pick({ pxShadow: 0 }, "tput", { host: "" }));
ok("吞吐模式两个候选都抽得到", tpHit.size > 1, [...tpHit].join(","));


// —— CUSUM 变点：一条怪样本不动，连续两条大跳立刻冻结 ——
reset();
node("cu1:443", { tcp: 100, pSum: 100, msLocal: 100 });
W.NodeStatsTable.nsLatency("cu1:443", 400);
ok("延迟变点：单条慢样本不冻结", !W.NodeStatsTable.nsGet("cu1:443").freeUntil, String(W.NodeStatsTable.nsGet("cu1:443").freeUntil || 0));
W.NodeStatsTable.nsLatency("cu1:443", 400);
ok("延迟变点：连续两条大跳立刻冻结", W.NodeStatsTable.nsGet("cu1:443").freeUntil > Date.now(), String(W.NodeStatsTable.nsGet("cu1:443").freeUntil - Date.now()));

// —— CUSUM 吞吐：带宽崩塌后 cap 立刻掉下来，老直方图不再拖一周 ——
reset();
node("cb1:443", { tcp: 60 });
for (let i = 0; i < 3; i++) W.NodeStatsTable.nsSpeed("cb1:443", 8 * 1048576, 512 * 1024, {});
const capBoom = W.NodeStatsTable.nsGet("cb1:443").capBps;
W.NodeStatsTable.nsSpeed("cb1:443", 512 * 1024, 512 * 1024, {});
const capBust = W.NodeStatsTable.nsGet("cb1:443").capBps;
ok("吞吐变点：崩塌样本立刻改写 capBps", capBoom > 4 * 1048576 && capBust < 1048576, `${capBoom} -> ${capBust}`);

// —— 稳健抖动：一条 5 秒的怪连接不该把抖动抬到秒级（MAD，不是方差）——
reset();
node("jt1:443", { tcp: 100 });
for (let i = 0; i < 5; i++) W.NodeStatsTable.nsLatency("jt1:443", 100);
const jit0 = W.scoreParts("jt1:443", "lat").jitMs;
W.NodeStatsTable.nsLatency("jt1:443", 5000);
const jit1 = W.scoreParts("jt1:443", "lat").jitMs;
ok("抖动对单条离群连接不敏感", jit1 < 400, `${jit0.toFixed(1)} -> ${jit1.toFixed(1)}`);

// —— S 参数化：小对象看延迟，批量看带宽 ——
reset();
W.NodeStatsTable.invalidateRank();
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
W.NodeStatsTable.invalidateRank();
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
W.NodeStatsTable.nsFail("sm0:443");
const blSmall = W.NodeStatsTable.nsGet("sm0:443").blackUntil - Date.now();
ok("小池子失败首档 ≈10 秒", blSmall > 8000 && blSmall < 12000, blSmall);
reset();
for (let i = 0; i < 20; i++) node("bg" + i + ":443", { tcp: 100 });
W.NodeStatsTable.nsFail("bg0:443");
const blBig = W.NodeStatsTable.nsGet("bg0:443").blackUntil - Date.now();
ok("大池子失败首档 ≈60 秒", blBig > 55000 && blBig < 65000, blBig);

// 连接观测按节点聚合（n/ok/p50/p95），不再是一条连接一行
reset();
W.TRAFFIC_MEMORY.aggregates.clear();
W.TRAFFIC_MEMORY.aggregates.set("x:443", { n: 3, ok: 2, dn: 4096, v: [100, 200, 300] });
const cl = W.PEND.clSnap(10);
ok("连接观测按节点聚合", cl.length === 1 && cl[0].k === "x:443" && cl[0].n === 3 && cl[0].ok === 2 && cl[0].p50 === 200, JSON.stringify(cl));
ok("聚合后的下行字节累加", cl.length === 1 && cl[0].dn === 4096, cl.length ? cl[0].dn : -1);


/* ---------- 28. 大池分片重建（2000 候选不再有 4 ms 尖峰） ---------- */
reset();
for (let i = 0; i < 1300; i++) node(`b${i}:443`, { tcp: 50 + i, okW: 10 });
W.NodeStatsTable.invalidateRank();
const br1 = W.CANDS.list("lat");
ok("大池分片：首片就能给出候选", br1.length > 0 && br1.length <= 128, String(br1.length));
eq("大池分片：每片只推进 128 个", W.CANDS.cache.step.lat.pos, 128);
ok("大池分片：首片只覆盖前 128 个", !br1.some((r) => r.k === "b200:443"), String(br1.length));
for (let i = 0; i < 12 && W.CANDS.cache.step.lat; i++) W.CANDS.list("lat");
eq("大池分片：一轮算完清掉进度", W.CANDS.cache.step.lat, undefined);
eq("大池分片：一轮之后全局最优在榜首", W.CANDS.list("lat")[0].k, "b0:443");
ok("大池分片：表里仍有 CAND_KEEP 名", W.CANDS.list("lat").length >= 224, String(W.CANDS.list("lat").length));
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
W.VT.clear();
const tg = "162.159.140.229";
const chR = { kind: "r", ip: "45.136.117.194" };
const chR2 = { kind: "r", ip: "185.253.117.147" };
eq("直连通道的键是 d", W.chanKey(W.DIRECT), "d");
eq("中继通道键带 IP", W.chanKey(chR), "r:45.136.117.194");
eq("初始是 unknown", W.VT.state(tg, "d"), 0);
W.recordTraffic({ target: tg, chan: W.DIRECT, down: 4096, ok: true });
eq("流量成功只产生弱 ok", W.VT.state(tg, "d"), 1);
W.recordTraffic({ target: tg, chan: W.DIRECT, down: 0, ok: false });
eq("流量失败不得把弱 ok 降级", W.VT.state(tg, "d"), 1);
W.VT.set(tg, "r:185.253.117.147", 403, 90, 1);
eq("probe 403 记为 blocked", W.VT.state(tg, "r:185.253.117.147"), 2);
ok("blocked 通道被判坏", W.VT.bad(tg, "r:185.253.117.147"));
W.VT.setState(tg, "r:185.253.117.147", 1, 0);
eq("弱证据不能冲掉强证据的 blocked", W.VT.state(tg, "r:185.253.117.147"), 2);
W.VT.set(tg, "r:45.136.117.194", 0, 800, 1);
eq("probe 连不上记为 dead", W.VT.state(tg, "r:45.136.117.194"), 3);
  W.VT.set("*", "r:185.253.117.147", 200, 60, 1);
  ok("通配目标不落表", W.VT.all().every((r) => r.target !== "*") && !W.VT.ok(tg, "r:185.253.117.147"));
  const cw = W.cntView();
  ok("通配写入被计数（vwild）", (cw.vwild || 0) >= 1, String(cw.vwild));
  W.VT.set("*", "r:45.136.117.194", 200, 55, 1);
  ok("没有通配回退：别的站点照旧是未知", !W.VT.ok("1.2.3.4", "r:45.136.117.194"));
eq("probe 级证据入口已删除（探测链 7.69 整体移除）", W.recordProbe, undefined);
eq("客户端回流入口已删除（订阅只有 url-test，客户端从不回传状态码）", W.recordClient, undefined);
W.VT.clear();
eq("清空后表为空", W.VT.all().length, 0);
// 第 31 组：通道策略（影子）与子请求预算
const rCtx = { host: "x.com", cfHost: true, clientV6: false, relays: ["104.16.0.5", "45.136.117.194"], legacyWantsRelay: true };
eq("cf 目标优先挑可用的中继", W.POLICY.decide(rCtx).chan.kind, "r");
eq("v6 客户端 + cf 目标只走非 CF 中继", W.POLICY.decide({ ...rCtx, clientV6: true }).chan.ip, "45.136.117.194");
eq("普通目标走直连", W.POLICY.decide({ ...rCtx, cfHost: false }).chan.kind, "d");
W.VT.clear(); W.POLICY.same = 0; W.POLICY.different = 0; W.POLICY.reasons = {};
W.POLICY.shadow(rCtx);
eq("影子模式统计一致", W.POLICY.same, 1);
W.POLICY.shadow({ ...rCtx, legacyWantsRelay: false });
eq("影子模式统计不一致", W.POLICY.different, 1);
const pl = W.planRound(1600, 8);
ok("预算不超过子请求硬上限", pl.adm <= W.SC.SCAN_SUB, JSON.stringify(pl));
ok("池子很饿时优先给准入", pl.adm >= 4, JSON.stringify(pl));
// 7.62 起策略全生效（level 2）：判定层已有 660+ 条断言与线上实测背书，
// 且「隧道直连成功证据 / 中继软降权」这些判据只有全生效时才真正影响选路。
ok("策略默认全生效（level 2）", W.SC.POLICY === 2);
ok("policyOn 在 level>=1 时为真", W.POLICY.enabled === true);
// 第 32 组：决策注入（core HOOK）与影子一致率
ok("策略实现已注册到 HOOK", typeof W.HOOK.decide === "function");
W.POLICY.same = 0; W.POLICY.different = 0;
W.NODE_MEMORY.alive.set("45.136.117.194:443", { h: "45.136.117.194", p: 443, cc: "XX", ms: 80 });
const req6 = new Request("https://example.com/", { headers: { "cf-connecting-ip": "2001:db8::5" } });
const req4 = new Request("https://example.com/", { headers: { "cf-connecting-ip": "1.2.3.4" } });
eq("影子期不改变现状", W.pxDecision(req6, "x.com", true, false, false), false);
eq("生效后 v6+CF 目标走中继", W.pxDecision(req6, "x.com", true, false, true), true);
eq("生效后 v4 客户端不被硬规则改写", W.pxDecision(req4, "example.com", false, false, true), false);
ok("影子统计有累计", W.POLICY.same + W.POLICY.different >= 3, String(W.POLICY.same + W.POLICY.different));
ok("原因分布有键", Object.keys(W.POLICY.reasons).length > 0, JSON.stringify(W.POLICY.reasons));
// 第 33 组：判定表接入选路（veto）
W.VT.clear();
W.VT.set("x.com", "r:" + "45.136.117.194", 403, 70, 1);
ok("被判 blocked 的中继被 veto", W.HOOK.veto("x.com", "45.136.117.194") === true);
ok("同站点未判过的中继不被 veto", W.HOOK.veto("x.com", "89.22.227.132") === false);
ok("站点级判定不外溢到别的站点", W.HOOK.veto("y.com", "45.136.117.194") === false);
W.VT.set("*", "r:" + "89.22.227.132", 0, 900, 1);
ok("通配判定不再生效：写不进表，也不会外溢到别的站点", W.HOOK.veto("y.com", "89.22.227.132") === false);
W.VT.clear();
ok("清空后不再 veto", W.HOOK.veto("x.com", "45.136.117.194") === false);
// 第 34 组：连接证据钩子（traffic，差分判据）
W.VT.clear(); W.RELAY_DEMAND.clear(); W.JUDGE.memory.smCnt.clear(); W.JUDGE.memory.bigByHost.clear();
W.HOOK.traffic({ host: "x.com", via: "node", node: "45.136.117.194:443", down: 900, ok: false, life: 800, up: 0 });
eq("只有小响应时不判死（可能只是业务层 403）", W.VT.state("x.com", "r:45.136.117.194"), 0);
ok("小响应按通道记进 smCnt（不再有复核队列，这条计数是它唯一的下游）", (W.JUDGE.memory.smCnt.get("x.com|r:45.136.117.194") || 0) >= 1);
W.HOOK.traffic({ host: "x.com", via: "node", node: "89.22.227.132:443", down: 90000, ok: true, life: 4000, up: 900 });
eq("同一站点别的通道能打通 → 记为 ok", W.VT.state("x.com", "r:89.22.227.132"), 1);
W.HOOK.traffic({ host: "x.com", via: "node", node: "45.136.117.194:443", down: 900, ok: false, life: 800, up: 0 });
eq("有别的通道能打通 + 本通道两次小响应 → 判该通道被封", W.VT.state("x.com", "r:45.136.117.194"), 2);
ok("判被封后设 needPx（下次优先中转）", (W.RELAY_DEMAND.get("x.com") || 0) > Date.now());
W.HOOK.traffic({ host: "x.com", via: "node", node: "45.136.117.194:443", down: 90000, ok: true, life: 4000, up: 900 });
eq("之后拿到大响应 → 解除误判", W.VT.state("x.com", "r:45.136.117.194"), 1);

// 第 35 组：判定表跨 isolate 同步（只同步强证据）
W.VT.clear(); W.VT_SYNC.sent.clear();
W.VT.set("x.com", "r:" + "45.136.117.194", 403, 60, 1);
const dl = W.HOOK.vtDelta();
eq("强证据进增量", dl.length, 1);
eq("增量键是 target|chan", dl[0].k, "x.com|r:45.136.117.194");
eq("增量里是 blocked", dl[0].s, 2);
W.vtAck();
eq("ack 之后同一证据不重复上报", W.HOOK.vtDelta().length, 0);
W.VT.clear();
eq("清空后本地为空", W.VT.all().length, 0);
W.VT.import(dl);
eq("远端强证据可导入", W.VT.state("x.com", "r:45.136.117.194"), 2);
ok("导入后 veto 生效", W.HOOK.veto("x.com", "45.136.117.194") === true);
W.VT.set("y.com", "r:" + "1.1.1.1", 200, 40, 1);
ok("ok 证据不进增量", W.HOOK.vtDelta().every((r) => r.k !== "y.com|r:1.1.1.1"));
W.VT.clear(); W.VT_SYNC.sent.clear();
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
W.VT.clear();

// 第 38 组：订阅侧入口条目与「按边缘实测 x」的组（客户端实测）
await selection.case032({ W, eq });

// 第 38b 组：中继组已删除（r- 节点的 IP 是假标签，交服务端 policy 动态选路）
await selection.case033({ W, eq });

// 第 39 组：节点偏好表（站点 × 通道的「能通 / 打不通」两栏）
await policy.case034({ W, eq });

// 第 40 组：拿到 403 就学（不等 probe 确认）
await policy.case035({ W, eq });
// 第 41 组：差分复核链路已删除（Worker 请求路径跑不动 userland TLS，实测 1102；DO 里单发 tunnelfetch 可以）
// 它在 7.69 删掉 subtls 时就只剩空壳：两个探测开关（PROBE_REQ / PROBE_RND）恒为 0 ⇒ 入队闸门恒假、
// 预算里 vt 份额恒为 0、runRound 立即返回 ⇒ 队列只进不出，?vtq=1 永远显示一份没人处理的积压。
ok("两个探测开关已随复核链路一起删除（7.153：零读取点的假旋钮）", W.SC.PROBE_REQ === undefined && W.SC.PROBE_RND === undefined);
eq("没有复核判定函数（封锁判定只走 tbf 的两批共识）", W.judge, undefined);
eq("没有复核队列", W.queueLen, undefined);
eq("HOOK 不再有 verify 槽位", W.HOOK.verify, undefined);
eq("状态里不再有复核队列", W.S?.vtQ, undefined);
eq("状态里不再有「最近一次复核结果」", W.S?.vtLast, undefined);

// 第 42 组：HTTP 状态码判据接进决策（状态码级证据，1 个请求即可学会）
W.VT.clear(); W.CF_HTTP.cache.clear();
W.CF_HTTP.cache.set("x.com", { code: 403, colo: "SOF", t: Date.now() });
const d403 = W.POLICY.decide({ host: "x.com", cfHost: true, clientV6: false, relays: ["104.16.0.5"], legacyWantsRelay: false });
ok("本出口 403 → 决策绕中继", d403.chan.kind === "r" && d403.why === "http403");
W.CF_HTTP.cache.set("x.com", { code: 200, colo: "VIE", t: Date.now() });
const d200 = W.POLICY.decide({ host: "x.com", cfHost: true, clientV6: false, relays: ["104.16.0.5"], legacyWantsRelay: true });
// 本出口 fetch 的 200 只代表 CF 自己出得去，不代表隧道直连出得去（实测同一时刻 200 → 隧道 403），
// 所以只有隧道直连自己有过成功证据时才省这一跳。
eq("本出口 200 但隧道直连无证据 → 仍走已知可用中继", d200.chan.kind, "r");
W.VT.setState("x.com", "d", 1, 1);
const d200b = W.POLICY.decide({ host: "x.com", cfHost: true, clientV6: false, relays: ["104.16.0.5"], legacyWantsRelay: false });
ok("隧道直连有过成功证据 → 才省这一跳（direct-ok）", d200b.chan.kind === "d" && d200b.why === "direct-ok");
W.CF_HTTP.cache.clear();
ok("没有状态码证据时不会强行推翻池子判断", W.POLICY.decide({ host: "x.com", cfHost: true, clientV6: false, relays: [], legacyWantsRelay: false }).chan.kind === "d");
// 第 43 组：差分判据 —— 保护「正常的业务 403」
W.VT.clear();
W.RELAY_DEMAND.clear();
W.JUDGE.memory.smCnt.clear();
W.JUDGE.memory.bigByHost.clear();
W.JUDGE.memory.bigChan.clear();
// 1) 没有基线时，小响应不判死任何通道（业务 403 与封锁页在此不可区分）
W.HOOK.traffic({ host: "api.biz.com", via: "node", node: "9.9.9.9:443", down: 4000, ok: false, life: 900, up: 300 });
W.HOOK.traffic({ host: "api.biz.com", via: "node", node: "9.9.9.9:443", down: 4000, ok: false, life: 900, up: 300 });
eq("无基线的小响应不写判定（两次也不判）", W.VT.bad("api.biz.com", "r:9.9.9.9"), false);
ok("无基线时只学「下次优先中转」", (W.RELAY_DEMAND.get("api.biz.com") || 0) > Date.now());
// 2) A 通道拿到整页 → B 通道的小响应才判被封
W.HOOK.traffic({ host: "x.com", via: "node", node: "45.136.117.194:443", down: 60000, ok: true, life: 3000, up: 900 });
eq("大响应建立基线", W.VT.state("x.com", "r:45.136.117.194"), 1);
W.HOOK.traffic({ host: "x.com", via: "node", node: "185.253.117.147:443", down: 4200, ok: false, life: 900, up: 300 });
eq("差分成立 → 判该中继被封", W.VT.bad("x.com", "r:185.253.117.147"), true);
eq("拿到整页的通道不受牵连", W.VT.bad("x.com", "r:45.136.117.194"), false);
// 3) 同一通道「先整页、后小响应」不算差分（可能是站点自身行为变化）
W.VT.clear();
W.JUDGE.memory.smCnt.clear();
W.JUDGE.memory.bigByHost.clear();
W.JUDGE.memory.bigChan.clear();
W.HOOK.traffic({ host: "y.com", via: "node", node: "7.7.7.7:443", down: 60000, ok: true, life: 3000, up: 900 });
W.HOOK.traffic({ host: "y.com", via: "node", node: "7.7.7.7:443", down: 4000, ok: false, life: 900, up: 300 });
eq("同通道先大后小不判死", W.VT.bad("y.com", "r:7.7.7.7"), false);
// 4) 中继假 200（nginx 默认页）攒够 3 次才判
W.VT.clear();
W.JUDGE.memory.smCnt.clear();
for (let i = 0; i < 3; i++) W.HOOK.traffic({ host: "z.com", via: "node", node: "6.6.6.6:443", down: 4300, ok: true, life: 900, up: 200 });
eq("假 200 攒 3 次判该中继不可用", W.VT.bad("z.com", "r:6.6.6.6"), true);
// 第 44 组：1 次请求感知 + 站点自愈（判定只改路由，永不断路）
W.VT.clear(); W.RELAY_DEMAND.clear(); W.JUDGE.memory.smCnt.clear(); W.JUDGE.memory.bigByHost.clear(); W.JUDGE.memory.bigChan.clear(); W.CF_HTTP.cache.clear();
// 1) 本出口 fetch 200 不再是判死旁证：没有另一通道整页差分，业务 403/小响应绝不判死
W.CF_HTTP.cache.set("x.com", { code: 200, colo: "VIE", t: Date.now() });
W.HOOK.traffic({ host: "x.com", via: "node", node: "5.5.5.5:443", down: 4200, ok: false, life: 900, up: 300 });
eq("无整页差分时即使本出口 fetch 200 也不判死（业务 403 不误伤）", W.VT.bad("x.com", "r:5.5.5.5"), false);
// 2) 站点自愈：所有中继都被判死时，决策仍给出中继，且该站点的结论被清空
W.VT.clear();
W.CF_HTTP.cache.clear();
W.VT.setState("y.com", "r:1.1.1.1", 2, 1);
W.VT.setState("y.com", "d", 2, 1);
const dHeal = W.POLICY.decide({ host: "y.com", cfHost: true, clientV6: false, relays: ["1.1.1.1"], legacyWantsRelay: true });
eq("没有通道可走时仍然给出中继（不断路）", dHeal.chan.kind, "r");
eq("自愈后该站点的封禁结论被清掉", W.VT.bad("y.com", "r:1.1.1.1"), false);
// 3) 业务 403（站点根路径本身就不是 200）不会被单次判死
W.VT.clear();
W.JUDGE.memory.smCnt.clear();
W.CF_HTTP.cache.set("api.biz.com", { code: 403, colo: "AMS", t: Date.now() });
W.HOOK.traffic({ host: "api.biz.com", via: "node", node: "8.8.8.8:443", down: 4200, ok: false, life: 900, up: 300 });
eq("业务 403 站点不被单次判死", W.VT.bad("api.biz.com", "r:8.8.8.8"), false);
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
W.VT.clear();
W.VT.setState("z.com", "r:5.5.5.5", 1, 1);
const pj = W.Prefs.json(10);
ok("Prefs 类能给出两栏视图", Array.isArray(pj.ok) && Array.isArray(pj.bad) && pj.n >= 1, JSON.stringify(pj));
eq("Prefs 能看到实测能打通的通道", W.Prefs.chan("5.5.5.5", "z.com"), 0);
eq("Prefs 对完全没测过的通道返回 1（未知）", W.Prefs.chan("4.4.4.4", "z.com"), 1);
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
eq("主 uuid 由待上报账本给出（小写、取第一个）", W.PEND.id({ uuid: "AA,BB" }), "aa");
ok("观测快照由待上报账本给出", Array.isArray(W.PEND.clSnap(5)), "conns");
// ═══ 第 47 组：Pool 类化（P4）═══
ok("Pool 门面已退场（7.360 删掉 Pool 类），抓取/探活/准入都在模块函数上", W.Pool === undefined && typeof W.cronScan === "function" && typeof W.pxGet === "function", "POOL");
ok("准入巡检仍在模块函数上（Pool 门面已删）", typeof W.ensurePool === "function" && typeof W.commitPool === "function", "ensure/commit");
ok("读视图仍在模块函数上（Pool 门面已删）", typeof W.pxGet === "function" && typeof W.aliveList === "function", "pxGet/alive");
eq("nsOf 空列表返回空表", Object.keys(W.nsOf([], 5)).length, 0);
// ═══ 第 48 组：Dialer（P5）═══
ok("Dialer 是类实例且有 open()", typeof W.DIALER === "object" && typeof W.DIALER.open === "function", "DIALER");
ok("Dialer 与 Connection 解耦（不持有 session 状态）", typeof W.Dialer === "function", "Dialer");
// ═══ 第 49 组：RegionPicker（P5-2）═══
ok("RegionPicker 已是会话持有的组件（模块级实例 7.346 起消失）", W.REGION === undefined && typeof W.RegionPicker.prototype.open === "function", "REGION");
ok("RegionPicker 可构造", typeof W.RegionPicker === "function", "RegionPicker");
// ═══ 第 50 组：Attacher（P5-4）═══
ok("Attacher 是类实例且可 run()", typeof W.Attacher === "function" && typeof W.Attacher.prototype.run === "function" && W.ATTACHER === undefined, "ATTACHER 单例已退场（7.354）");
ok("Attacher 可构造", typeof W.Attacher === "function", "Attacher");
// ═══ 第 51 组：SubscriptionView（P6-1）═══
ok("SubscriptionView 是类实例且可 render()", typeof W.SubscriptionView === "function" && typeof W.SubscriptionView.prototype.render === "function" && W.SUBVIEW === undefined, "SUBVIEW");
ok("SubscriptionView 可构造", typeof W.SubscriptionView === "function", "SubscriptionView");
// ═══ 第 52 组：路由表（P6-2）═══
ok("RouteTable 注册了五条用户级路由", W.RouteTable.names().join(",") === "subscription,logs,proxyip,debug,regions", W.RouteTable.names().join(","));
ok("cl 命中 subscription 且需要 RTT/统计", W.RouteTable.route("cl")?.name === "subscription" && W.RouteTable.needsRtt("cl") && W.RouteTable.needsStats("cl"), "cl");
ok("裸 /<uuid> 也命中 subscription", W.RouteTable.route("")?.name === "subscription", "empty");
ok("logs 命中但不需要 RTT", W.RouteTable.route("logs")?.name === "logs" && !W.RouteTable.needsRtt("logs"), "logs");
ok("未知子路径返回 undefined（404）", W.RouteTable.route("nope") === undefined, "nope");
// ═══ 第 53 组：判死通道的复检（P6-3）═══
await policy.case036({ W, ok });
// ═══ 第 54 组：PageView（P6-3）═══
ok("面板与统计使用纯渲染入口", typeof W.renderHtml === "function" && typeof W.renderStatsHtml === "function" && W.PAGES === undefined, "无状态包装不再必要");
ok("登录页与管理页的三个渲染入口搬到 admin.ts", ["renderLogin", "renderAdmin", "renderAdminHint"].every((k) => typeof W[k] === "function"), "admin html");
ok("PageView 无状态包装已移除", W.PageView === undefined, "PageView");
// ═══ 第 55 组：整池被判死时的比例兜底（P6-4）═══
await policy.case037({ W, ok });

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
  W.VT.setState("pf.test", "r:pa", 2, 1);
  ok("探过的排到后面", W.pickFresh("pf.test", ["pa", "pb", "pc"], 2).join(",") === "pb,pc");
  ok("已探过的不会被挤出上限外时仍可用", W.pickFresh("pf.test", ["pa"], 2).join(",") === "pa");
  
  // 第 60 组：无状态码（连不上/RST）必须归 unknown，不能落到 ipfam
  ok("全失败无状态码 → unknown", W.tfClass([{ ok: false }, { ok: false }]) === "unknown");
  ok("有状态码但全 4xx 仍按字节分层", W.tfClass([{ ok: false, status: 403, bytes: 4 }]) === "ipfam");
  
  // 第 61 组：穷举各种采样组合，验证「业务 4xx 永不写封禁」这条不变量
  await selection.case038({ W, ok });
  
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
await selection.case039({ eq, W });

// 64) 错误分类直方图（/health 的 errsByKind）
console.log("\n64) 错误分类直方图");
await selection.case040({ eq, W, ok });

// 65) 子请求预算：两项之和不得超过 cap（入口那一份已随「入口偏好表」一起删除）
console.log("\n65) 子请求预算");
await selection.case041({ W, ok, eq });

// 66) 入口偏好不在服务端做：整条探测链（EDGE_AUTO / edgeScan / edge:pref）已删除，
// 订阅里的入口只来自客户端 url-test 与内置种子 IP。
console.log("\n66) 入口偏好整条服务端链路已删除");
await selection.case042({ eq, W, ok });

// 67) 探测全关时，判定扫描不占额度
console.log("\n67) 探测全关时的预算");
await selection.case043({ ok, W, eq });

// 68) 探活并发上限
console.log("\n68) 探活分段");
await selection.case044({ ok, W, eq });
// 69) 中继健康表的有界性与键解析
console.log("\n69) 中继健康表");
await selection.case045({ W, ok, eq });

// 70) 增量上报的 ack/nack 语义
console.log("\n70) 增量上报");
await policy.case046({ W, eq, ok });

// 71) 错误日志：限流与表满
console.log("\n71) 错误日志限流");
await selection.case047({ W, ok, eq });

// 72) 探活失败记录的时效
console.log("\n72) 探活失败过期");
await selection.case048({ ok, W });

console.log("\n73) 业务 4xx 不被误升级成封锁");
await policy.case049({ W, eq });

// 74) 正记忆：刚出过整页的中继优先复用
console.log("\n75) 正记忆优先复用");
await policy.case050({ W, eq });

// 第 38c 组：站点 × 中继的实测性能记忆（同一中继对不同站点快慢不同）
await policy.case051({ W, eq });

// 第 38d 组：两种模式对「快」的定义不同
await policy.case052({ W, eq });

// 第 38e 组：吞吐模式给「本站点还没量过」的中继采样机会（否则永远只有一条中继有样本）
await policy.case053({ W, eq });

console.log("\n76) 出口族事实（v8 的 eg）");
await policy.case054({ W, eq, ok });

console.log("\n77) 事实写入决策器（v8 的 commitFact）");
await policy.case055({ W, eq });

console.log("\n78) 写入决策器的影子统计");
await selection.case056({ W, eq });


console.log("\n79) 同窗口对照与 bigTypical（影子从此能算出「本会写封锁」）");
await policy.case057({ W, eq });


console.log("\n80) 站点 × 中继成功率（ps）：只折价、不剔候选");
await policy.case058({ W, eq });


console.log("\n81) 中继「连不上」（dead）：唯一允许挪到队尾的事实");
await policy.case059({ W, eq });


console.log("\n82) 冷启动口径：firstTry / firstPage / 灰带");
await selection.case060({ W, eq });


console.log("\n83) 单 IP 封锁（blk）：三批 × 每批 3 次、只折价、永不剔候选");
await policy.case061({ W, eq });

console.log("\n84) 订阅的客户端链：实测组优先、域名入口兜底");
await selection.case062({ W, eq });

console.log("\n85) 康复通道（v8 D12）");
await policy.case063({ W, eq });


console.log("\n86) commitFact 单一裁决：ps 由 judge 写入");
await policy.case064({ W, eq });


console.log("\n86b) 密集 tiny 只留一条负样本（节流在判据里，不在调用方）");
await policy.case065({ W, eq });


console.log("\n87) 延迟观测：p95all / p95ok / good3s");
await selection.case066({ W, eq });


console.log("\n88) dns 事实：确证纯 v4 才降权 v6 出口");
await policy.case067({ W, eq });


console.log("\n89) 出口族预算：几条 v4 出口决定探测名额");
await selection.case068({ W, eq });


console.log("\n90) 吞吐容量噪声门：只记比值，两次不一致就不记");
await selection.case069({ W, eq });


console.log("\n91) 活跃池目标：只作判据（加码函数已删）");
await contracts.case070({ eq, W, ok, fs });


console.log("\n92) 远端事实读取：并发只读一次 + colo 缓存命中");
await selection.case071({ W, eq });


console.log("\n93) 事实开关：五类乘数可单独回滚");
await selection.case072({ W, eq });


console.log("\n94) 五类事实门面：一次取齐增量，ack 后清空");
await policy.case073({ W, eq });


// 95) 出口族从响应推导（不再用主动探测：探测器会连到自己的出口，见清单 §I）
await selection.case074({ W, eq });

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
eq("FactsStore.clear 一并清 dns", (W.FactsStore.clear(), W.DNS.v6Of("a.example.com", 3000)), -1);


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
W.VT_SYNC.loaded = false; W.VT_SYNC.coolUntil = 0; W.VT_SYNC.flight = null;
let factsCalls = 0;
const badEnv = { uuid: "00000000-0000-0000-0000-000000000000", METER: { idFromName: () => "id", get: () => { factsCalls++; return { fetch: async () => { throw new Error("boom"); } }; } } };
await W.vtLoad(badEnv);
eq("读失败不置 vtLoaded", W.VT_SYNC.loaded, false);
eq("读失败开启 60 秒冷却", W.VT_SYNC.coolUntil > Date.now(), true);
await W.vtLoad(badEnv);
eq("冷却期内不再重试", factsCalls, 1);
W.VT_SYNC.coolUntil = 0;
await W.vtLoad(badEnv);
eq("冷却过后允许重试", factsCalls, 2);

// 98) 用量恢复必须受子请求预算约束（每次恢复 = 1 个 DO 子请求，一轮只有 50 个）
eq("用户数没超上限时全部恢复", W.restorePick(["a", "b", "c"], 12, 0).join(","), "a,b,c");
eq("超过上限时只取一批", W.restorePick(["a", "b", "c", "d"], 2, 0).length, 2);
eq("超出上限时按小时轮转起点", W.restorePick(["a", "b", "c", "d"], 2, 3600000).join(","), "b,c");
eq("轮转不产生重复", new Set(W.restorePick(Array.from({ length: 30 }, (_x, i) => "u" + i), 12, 7200000)).size, 12);
eq("空列表返回空", W.restorePick([], 12, 0).length, 0);
// 99) 候选池代际必须跨 isolate 单调：本地号落后时不能用旧号覆盖别人的池子
await selection.case075({ W, eq });


// 第 101 组：管理端 Bearer 头（前缀是用 /^Bearer\s+/ 剥的，别写成 s+）
await selection.case076({ ok, W });


/* ---------- 102. 统计读路径：flush 前后不倒退（v7.135 删掉 60 秒读缓存） ---------- */
await store.case077({ mkDO, W, eq });

/* ---------- 103. 康复闸门看「历史最好」；只写不读的 sent 表删除（v7.138） ---------- */
await policy.case078({ W, eq });


console.log("\n104) 事实门面是表驱动的：五张表都在，按站点表有上限");
await policy.case079({ W, eq });
/** 第 97 组（v7.142）：门面不再提供「永远不写」的快照入口 + 管理面板的子请求预算 */
await selection.case080({ ok, W, eq });


// 105) DO 的 /add 必须无条件吸收事实/vt/hl/blk：同一批没有连接观测（cl）时也不能丢
// 为什么专门测这个：这一段曾经被整块嵌在 if (d.cl) 里，只有带 cl 的那批才进表，
// 而发送侧不看返回值就 syncAck —— 事实增量会静默蒸发。
await selection.case081({ mkDO, eq });


// 106) 增量有上限，ack 只能清「真正发出去的那一批」
// 为什么测这个：delta() 有行数上限（eg 16 / 其余 60），而 ack() 过去一次清空整个 pending ——
// 超出上限的行既没发出去、也不会再重发，等于每条 flush 都在丢证据，且没有任何报错。
await policy.case082({ W, eq });

// 107) 站点级自愈（BLK.sweep）：覆盖率的分母必须是整池，不是过滤后的 usable
// 背景：一条中继被判「封锁」的同一刻就离开了 usable，而它的 blk2 封锁行要三批（≥3 分钟）才写成 ——
// 旧口径拿 usable 当分母时，分子恰好被同一个事件剔掉，覆盖率恒接近 0，这条自愈在生产上永不触发。
await policy.case083({ W, eq });

// 108) 落盘失败必须回滚连接观测（cl 是加法合并，重发同一批会把 n/ok/dn 加两遍）
// 背景：pendFlush 只在 DO 回 200 后才清 W.TRAFFIC_MEMORY.aggregates，save() 失败时 DO 回 500 ⇒ 下一轮回放同一批 cl。
// 旧代码只回滚 c/g/s/e 四个结构，cl 的计数留在内存里 ⇒ 被加两遍（面板的 n 与可用率因此偏移）。
await selection.case084({ mkDO, eq });
await selection.case085({ W, eq });
await selection.case086({ W, eq });



/* ---------- 111. 死字段与孤儿文档（v7.151） ---------- */
eq("Thompson 的成员表缓存字段已删除（v6.42 删采样器时留下的死字段）", W.S?.tsMem, undefined);
ok("状态表里不再有 tsMem 的键", W.S === undefined);

/* ---------- 112. 假字段与魔数（第 54–56 条） ---------- */
await contracts.case087({ eq, W, fs, ok });


// 113) 站点级自愈必须在所有早返回之前（否则 5% 复检命中时这一轮就不自愈）
// 背景：sweep 原来排在「5% 复检」与「直连被判死」两条 return 之后 ⇒ 每次请求有 5% 概率跳过自愈，
//       单测因此偶发失败（同一份代码 4 次跑 1 次红）。
await policy.case088({ W, eq });

// —— 144：状态码可见性与文档残留 ——
await contracts.case089({ fs, debugAll, ok });


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
ok(`[${g}] v8 映射表用的是落地名 FactsStore.ack()`, v8.includes("`FactsStore.ack()`"));
ok(`[${g}] 设计阶段的临时名只在「更正」那句里出现`, !v8.includes("`factsAck()`"));

// 146. 连接观测的上报确认：按发出去的数量相减，而不是整表清空（v7.157）
await store.case090({ W, eq, ok });

// 147. 按站点表的内存上限：站点名是客户端给的，必须有裁剪（v7.158）
await contracts.case091({ W, eq, ok, fs });


// ---- 148. smCnt 必须有上限：键是「站点|通道」，两个维度都会涨 ----
for (let i = 0; i < 700; i += 1) {
  W.JUDGE.onTraffic({ host: "sm" + i + ".test", via: "node", node: "198.51.100.9:443", down: 737, ok: true, life: 80, up: 400, cf: false, at: 1700000000000 + i });
}
ok("700 个「站点|通道」之后 smCnt 仍被压在上限内", W.JUDGE.memory.smCnt.size <= W.SC.SM_CNT_MAX);
ok("上限就是 512", W.SC.SM_CNT_MAX === 512);
// 计数大的行必须活下来：真在刷垃圾页的通道计数会涨上去，判死要看 n>=3
W.JUDGE.memory.smCnt.clear();
W.JUDGE.memory.smCnt.set("keep.test|r:198.51.100.9", 50);
for (let i = 0; i < 700; i += 1) W.JUDGE.memory.smCnt.set("flood" + i + ".test|r:198.51.100.9", 1);
W.trimAged(W.JUDGE.memory.smCnt, W.SC.SM_CNT_MAX);
eq("裁剪后正好等于上限", W.JUDGE.memory.smCnt.size, 512);
ok("计数大的那行还在（这张表留大删小）", W.JUDGE.memory.smCnt.has("keep.test|r:198.51.100.9"));
ok("计数最小的那些先被删", !W.JUDGE.memory.smCnt.has("flood0.test|r:198.51.100.9"));
const judgeSrc = fs.readFileSync("src/route/judge.ts", "utf8");
ok("judge 写入 smCnt 后就地裁剪（源码断言，防止被悄悄删掉）", judgeSrc.includes("trimAged(this.smCnt"));
W.JUDGE.memory.smCnt.clear();


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
await selection.case092({ W, ok });
await selection.case093({ W, ok });
await contracts.case094({ fs, ok, W });

console.log("\n-- 判定表增量：待发项保留状态、每批严格 ≤60 行（v7.162）");
await policy.case095({ W, ok });
await policy.case096({ W, ok });
await contracts.case097({ fs, ok });

// 153. 「历史最好」必须跨 isolate 活着：只发当前均值的话，康复通道在每个新 isolate 里都要重新攒
await contracts.case098({ W, eq, mkDO, ok, fs });
// 154. DO 必须把判定表的状态一起存下来：只存到期时间的话，dead（硬排除）读回来变成 blocked（软降权）
await contracts.case099({ mkDO, eq, ok, storeSrc });
// ── 第 155 组：空关闭的门槛只该在「跨过那一条」上生效 ──
await selection.case100({ W, ok });
// 探活只累加样本数与 tcp/tls 的 EWMA，不写真实首字节的矩
await selection.case101({ W, eq, ok, statAll });
// 拨号重试必须换一条：选择器的确定性路径在同一秒内两次返回同一条
await selection.case102({ W, eq, ok });
// 拨号器把试过的键传下去，并且钉住 ?rx= 时只试一次
await contracts.case103({ fs, ok });

await contracts.case104({ W, ok, fs });
await contracts.case105({ fs, ok });
await contracts.case106({ fs, ok });
await contracts.case107({ fs, eq, ok, W });

// 第 161 组：会话层补救链的拨号超时与地区口径（v7.171）
// Dialer 抛错后那条「临时取一条中继直连」是最后一跳，漏了超时就会把客户端拖到放弃。
const ss2 = fs.readFileSync("src/proxy/session.ts", "utf8");
const at2 = fs.readFileSync("src/proxy/attacher.ts", "utf8");
ok("会话层补救链的 connect 也加了 2.5 秒上限", /withTimeout\(pk0, CONNECT_MS\)/.test(fs.readFileSync("src/proxy/fallback.ts", "utf8")));
ok("会话层不再有裸 connect（迟到成功的 socket 必须有人关）", !/await connect\(\{ hostname: px0\.host/.test(ss2));
ok("超时之后迟到成功的 socket 会被关掉", /void pk0\s*\n\s*\.then\(\(s\) => \{ try \{ s\.close\(\); \}/.test(fs.readFileSync("src/proxy/fallback.ts", "utf8")));
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
await selection.case108({ W, eq });

// 面板：没读到用量与「用量为 0」必须能看出来
await views.case109({ W, ok });

// 第 166 组：/meter/set 的恢复门槛（第 98 条）
// 旧门槛只看 up+down，导致「只建过连接、没有可计量流量」的用户整条恢复被跳过；
// 同时 conns 直接赋值会让落后几小时的快照把更大的连接数改小。
const dset = (m, body) => m.fetch(new Request("https://meter/set", { method: "POST", body: JSON.stringify(body) }));
await selection.case110({ mkDO, dset, eq });
await selection.case111({ mkDO, dset, eq });
const mSrc166 = storeSrc();
ok("恢复门槛含连接数（与 /seed 口径一致）", mSrc166.includes("wantN > curN"));
ok("conns 用 max 合并，快照落后也不回退", mSrc166.includes("Math.max(wantN, curN)"));
// 第 167 组：挂在主批次上的增量只能由那一批确认（第 99 条）
// 旧代码对每个用户批次都跑 clAck/syncAck/syncNack，而增量只挂在主 uuid 的请求体里：
// 多个用户同时成功会把连接观测重复相减，任一用户失败会把主批次刚确认的增量退回/清空。
await store.case112({ W, eq });
const pSrc167 = fs.readFileSync("src/store/pend.ts", "utf8");
ok("确认只发生在挂增量的那一批", pSrc167.includes("=== carry.owner"));
ok("挂增量时记下是哪一批", pSrc167.includes("carry.owner = String(id).toLowerCase();"));
// 168) 增量上报的批次上限与轮转
await contracts.case113({ fs, eq, W, ok });
// 169) UDP/DNS 分帧：拆在两条消息里的包不能被丢
await contracts.case114({ fs, ok, W, eq });
// ── 170. 探测路径的三个边界（7.180）────────────────────────────────────────
await contracts.case115({ W, eq, ok, fs, psAll });


/* ── 第 171 组：上限与合并口径（v7.181）────────────────────────────────────
 * 四条：判定表的上限真正生效（以前 set 只清过期行、setState/import 连调用都没有）；
 * DO 的 hl 不再把两段不同时刻的证据逐字段拼成一条；hl 裁剪留最新而不是留最旧；
 * /set 只让触发的那一维变大，另一维不再被快照写小。 */
await contracts.case116({ W, ok, mkDO, eq, verdictAll });

// 172. 站点记忆表的上限只在一条路上执行；限流表被撑爆就整体清空（v7.182）
await contracts.case117({ W, eq, ok, fs });

await contracts.case118({ W, ok, eq, fs });
// 第 174 组：事实寿命的唯一真源 + 错误分类键的上限 + 中继地址的 IPv6 拆分
await contracts.case119({ W, eq, ok, fs });

/* 175：探活 RTT 不能写进真实首字节的矩；冷却中的源要真的跳过（7.185） */
await selection.case120({ scanAll, eq, ok, W });

// 176) 预算账本与续回边界（7.186）
// 这里同时记一个「排除了的疑点」：withTimeout 超时后那一半仍在跑，它若最终 reject，
// 并不会变成未捕获的 rejection —— Promise.race 挂上去的那一刻已经给 p 同时挂了 resolve/reject
// 处理器，晚到的失败只是被丢弃（A/B 实测：退回旧版 util.ts，行为断言两边全绿）。真正会造出
// 未捕获 rejection 的是 `.then(完成分支)` 这种只挂一半的新链，dialer/region/session 那几处
// 都显式跟了 .catch。所以这里不锁「util.ts 有没有多挂一个丢弃器」，只锁账本。
console.log("\n176) 预算账本与续回边界");
await selection.case121({ W, eq, ok });
// ---- 第 177 组：出站事实切片必须按新鲜度（v7.187 D125）；诊断建连必须有超时（D126）----
await policy.case122({ W, eq, ok, storeSrc, debugAll });


/** 第 178 组（v7.188）：没有生产者的旧封锁表删净、热路径一张表只扫一遍 */
await policy.case123({ storeSrc, ok, debugAll, policyAll, eq, W });
/* ── 179. 吞吐容量表：上限与寿命必须落在插入路径上；残槽 HOOK.psNote 不该存在 ── */
await contracts.case124({ fs, eq, W, ok });

// 第 180 组：订阅参数（?ei= 入口数 / ?r=0 关中继块 / ?tu= 成员必须是中继条目）
await selection.case125({ eq, W, ok });


// 191a) 站点失败只有一条记账路径（attacher 的 if/else 两条分支曾分别调 softFail 与 bumpFail(…, "site")）
console.log("\n191a) 站点失败的记账路径");
await contracts.case126({ reset, node, W, eq, ok, fs });

// 191b) 中继健康表 merge：条数相等时较新的观测整体胜出，不把两份观测拼成一条
console.log("\n191b) 中继健康表的 merge 口径");
await selection.case127({ W, ok });

// 第 192 组：缩水守卫要比「最大已知规模」；读失败必须留证据（7.192）
await selection.case128({ W, eq, ok });

// 第 193 组：判定层与 pxDecision 闸门的口径（7.193）
// 缺陷：pxDecision 对「CF 托管目标」无条件 return true，把判定层的 direct-ok 一起盖掉。
await contracts.case129({ W, eq, ok, fs });

// ── 第 194 组：死导出与线协议类型的单一来源（7.195） ──
await contracts.case130({ verdictAll, eq, W, statAll, ok, fs });
// 第 196 组：页面尺寸判据只有一个真源；文档不再被 import 挤开
await contracts.case131({ fs, ok, eq, W });
// 第 197 组：订阅开关各管各的块（?e=0 不该把中继块一起删掉）；地区条目端口有兜底
await contracts.case132({ W, eq, ok, fs });
// 第 198 组：?p= 协议开关（v8 §7 里写的是 ?p=vless|tj|both，而代码原先只读 ?proto=，且不认 tj / both）
await contracts.case133({ W, ok, eq, fs });

// 第 199 组：env.adminHash 是只进签名的影子字段（配了也永远进不去，已删除）
await contracts.case134({ W, eq, fs });

// 第 200 组：sing-box 的本地直连口径（tun + auto_route 接管整机流量，private 网段与局域网 DNS 必须放直连）
await contracts.case135({ W, eq, fs });
// 第 201 组：tfb 起搏记账收类（原先是 cron.ts 顶层两张 Map，只被一条移除路径清）
await contracts.case136({ W, ok, eq, fs });

// 第 202 组：force 落盘必须真的落盘；信誉表类型里不许留没人写也没人读的字段
await contracts.case137({ W, eq, fs });
// —— 第 203 组：计数器账本（登记了就必须有人写）——
await contracts.case138({ fs, ok, W, eq });
// —— 第 204 组：池子锚点必须单调（本地旧池子不能把共享代际改小）——
await contracts.case139({ W, eq, fs, ok });
// 第 205 组：按站点内存表的淘汰序（7.204）

// 旧口径：`Map.set` 对已存在的键不移动位置，所以 trim 删的是「最早插进来的」——
// 而最早插进来的往往正是最热的站点（每个请求都会 set 一次），于是它第一个被删、
// 康复计数器反复归零，真正陈旧的站点反而留着。修法是写入端先 delete 再 set。
await contracts.case140({ W, eq, fs, ok });

// 第 206 组：面板数据的每个字段都必须有渲染点（7.205）

// 旧形状：`subscription.ts` 在打开控制页时 `Promise.all` 里多取了一次池子的当前中继
// （`pxGet` 是一次 KV/DO 往返），还顺手塞了 `cntView()`，而 `panel.ts` 从来没渲染这两个字段。
await views.case141({ fs, ok, eq, W });

// 第 207 组：快照读失败不能缓存成「空快照」，也不能被记成「没有旧键」（7.206）
await contracts.case142({ W, eq, fs, ok, metricsAll });

// ── 208. 绑定名必须在类型里声明（v7.207：Env 的索引签名让拼错也能编译通过）──
await contracts.case143({ fs, ok, eq, W });
/* ===== 第 209 组：直连拨号也必须有时限（7.208 D164） ===== */
await contracts.case144({ W, ok, fs });
/* ===== 第 210 组：探活的三处 connect 惰性建连必须有时限（7.209 D165） ===== */
await contracts.case145({ W, ok, fs });
// ---- 211: 数据面上游写必须有上限（黑洞中继接了连接却不读，write 永不返回） ----
console.log("");
const srcUtil211 = fs.readFileSync("src/core/util.ts", "utf8");
const srcState211 = fs.readFileSync("src/core/counter.ts", "utf8");
const srcConn211 = fs.readFileSync("src/proxy/connection.ts", "utf8");
const srcSess211 = fs.readFileSync("src/proxy/session.ts", "utf8");
const srcAtt211 = fs.readFileSync("src/proxy/attacher.ts", "utf8");
ok("上游写上限常量是 30 秒", srcUtil211.includes("export const UP_STALL_MS = 30000;"));
ok("ustall 已登记（否则计数会被静默丢掉）", srcState211.includes('"ustall",'));
// 泵（现在是 ProxySession.feed）里仍走 upWrite；chunk 类型收窄后要显式转成 Uint8Array 再交给它。
ok("泵里改调 upWrite", srcSess211.includes("st.upWrite(chunk instanceof Uint8Array ? chunk : toU8(chunk))"));
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
    const before = Number(W.COUNTER.values.ustall || 0);
    const t0 = Date.now();
    await c.upWrite(new Uint8Array(16), 40);
    const ms = Date.now() - t0;
    ok("黑洞出口不会永远挂着", ms < 400, String(ms));
    eq("超时记 ustall", Number(W.COUNTER.values.ustall || 0) - before, 1);
    eq("超时关掉 socket", sock.closed, 1);
    ok("超时后不再往死连接写", c.dead === true);
    ok("超时归因到中继节点", Number(W.NodeStatsTable.nsGet("203.0.113.211:443").failW || 0) > 0);
  }
  // 直连黑洞：没有节点可罚，计数与断开照做
  {
    const c = mkConn211("203.0.113.212:443", "direct");
    const sock = mkSock211();
    c.sock = sock;
    c.writer = { write: () => new Promise(() => {}) };
    const fw = Number(W.NodeStatsTable.nsGet("203.0.113.212:443").failW || 0);
    await c.upWrite(new Uint8Array(16), 40);
    eq("直连黑洞也关 socket", sock.closed, 1);
    eq("直连黑洞不罚池子里的节点", Number(W.NodeStatsTable.nsGet("203.0.113.212:443").failW || 0), fw);
  }
  // 正常写：不计 ustall、不关 socket
  {
    const c = mkConn211("203.0.113.213:443", "node");
    const sock = mkSock211();
    c.sock = sock;
    c.writer = { write: async () => {} };
    const before = Number(W.COUNTER.values.ustall || 0);
    await c.upWrite(new Uint8Array(16), 40);
    eq("正常写不记 ustall", Number(W.COUNTER.values.ustall || 0), before);
    eq("正常写不关 socket", sock.closed, 0);
  }
  // 普通写失败：只关 socket（与改造前一致），不算黑洞
  {
    const c = mkConn211("203.0.113.214:443", "node");
    const sock = mkSock211();
    c.sock = sock;
    c.writer = { write: async () => { throw new Error("broken pipe"); } };
    const before = Number(W.COUNTER.values.ustall || 0);
    await c.upWrite(new Uint8Array(16), 40);
    eq("写失败不记 ustall", Number(W.COUNTER.values.ustall || 0), before);
    eq("写失败关 socket", sock.closed, 1);
  }
} catch (e) {
  ok("上游写上限的行为段可执行（旧代码没有 upWrite）", false, String((e && e.message) || e));
}

// 第 212 组：大池分片重建期间，W.NODE_MEMORY.candidateCount 只反映「已经扫过的那一段」——它不能被当成池子大小（7.211）
await contracts.case146({ W, eq, ok, fs });

// ---- 第 213 组：站点冷启动的影子试探（lastTry 只写不读）+ 节点统计里的僵尸字段 ----
await contracts.case147({ W, ok, eq, statAll, fs, metricsAll, pickAll });

/* ===== 第 214 组：SC 里的僵尸常量（有人声明、注释描述了一个不存在的机制、没人读） ===== */
await contracts.case148({ fs, ok, eq, W });
// ===== 第 215 组：远端事实读取失败不能被当成「没有事实」（D171） =====
await contracts.case149({ W, ok, eq, fs });
// 连接观测表的淘汰按「最近更新时间」而不是插入序（v7.215）
await contracts.case150({ mkDO, eq, ok, storeSrc, fs });

// 中继健康表出站按证据时间切片（v7.216）
await selection.case151({ mkDO, eq, ok, storeSrc });

// 远端 ps 合并：时间与「历史最好」是两件事（v7.217）
await contracts.case152({ W, ok, eq, fs });

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
const before221 = W.COUNTER.values.doBad || 0;
const badM = mkMeter(badStore, KEK221);
await badM.fetch(new Request("https://m/get"));
eq("解不开的账本会计数 doBad", (W.COUNTER.values.doBad || 0) - before221, 1);
const badAdd = await badM.fetch(new Request("https://m/add", addBody));
eq("解不开也要能继续记账（不 5xx）", badAdd.status, 200);
eq("覆盖前把原文备份到 a_bak", badStore.get("a_bak"), GARBAGE);
ok("新值已写回 a", typeof badStore.get("a") === "string" && badStore.get("a") !== GARBAGE);
// 能解开的旧值：不计数、不留底（防误伤）
const goodStore = new Map();
const g1 = mkMeter(goodStore, KEK221);
await g1.fetch(new Request("https://m/add", addBody));
const before222 = W.COUNTER.values.doBad || 0;
const g2 = mkMeter(goodStore, KEK221);
await g2.fetch(new Request("https://m/get"));
eq("能解开就不计 doBad", (W.COUNTER.values.doBad || 0) - before222, 0);
ok("能解开就不留底", goodStore.get("a_bak") === undefined);
// 源码锁：这条链的三个关键点都得在
const meterSrc221 = storeSrc();
ok("配置里登记了 doBad", fs.readFileSync("src/core/counter.ts", "utf8").includes("\"doBad\","));
ok("构造函数里有 else 分支", meterSrc221.includes("cnt(\"doBad\");"));
ok("留底带着原值", meterSrc221.includes("this.ledger.keepBackup(all);"));
ok("落盘前备份 a_bak", meterSrc221.includes("const bak = this.ledger.takeBackup();") && meterSrc221.includes("await this.state.storage.put(\"a_bak\", bak);"));

// ---- 第 222 组：站点级自愈（sweep → mute）不能被别处回传的封锁事实撤销（v7.221）----
const blkSrc = () => fs.readFileSync("src/route/blkfacts.ts", "utf8");
await contracts.case153({ W, eq, blkSrc, fs });

// ---------- 第 223 组：文档写了但代码没有的调试端点（v7.222） ----------
await contracts.case154({ debugAll, ok, W, eq, fs });
/* ---------- 第 224 组：cron 闸门要有截止时间 ---------- */
await contracts.case155({ W, ok, eq, fs });
/* ---------- 第 225 组：判定标签表的淘汰序 ---------- */
await contracts.case156({ W, eq, ok, fs });
/* ---------- 第 226 组：探活「暂时跳过」表 ---------- */
await contracts.case157({ W, eq, ok, scanAll, fs });
// ---------- 第 227 组：W.RELAY_DEMAND 的窗口只有一个真源（7.226） ----------
await contracts.case158({ fs, eq, W, ok });

// ===== 第 228 组：负面/正记忆表必须压回上限（7.227 D184）=====
await contracts.case159({ fs, ok, W });


// ===== 第 229 组：分片恢复失败不能静默（7.228 D185）=====
await contracts.case160({ fs, ok, W });


// ── 第 230 组：连接观测的分位索引（p50/p95 用 nearest-rank，不能用 floor(p*n)） ──
const clPut = (k, v) => W.TRAFFIC_MEMORY.aggregates.set(k, { n: v.length, ok: v.length, dn: 0, v });
W.TRAFFIC_MEMORY.aggregates.clear();
clPut("p230.two", [100, 900]);
clPut("p230.ten", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
clPut("p230.big", Array.from({ length: 64 }, (_, i) => (i + 1) * 10));
const clRows = W.PEND.clSnap(40);
const clBy = Object.fromEntries(clRows.map((r) => [r.k, r]));
eq("两个样本时 p50 是较小那个（不是最大值）", clBy["p230.two"].p50, 100);
eq("两个样本时 p95 才是最大值", clBy["p230.two"].p95, 900);
eq("十个样本时 p50 是第 5 小", clBy["p230.ten"].p50, 5);
eq("十个样本时 p95 是最大值", clBy["p230.ten"].p95, 10);
eq("64 个样本时 p50 是第 32 个", clBy["p230.big"].p50, 320);
W.TRAFFIC_MEMORY.aggregates.delete("p230.zero");
W.TRAFFIC_MEMORY.aggregates.set("p230.zero", { n: 0, ok: 0, dn: 0, v: [] });
eq("没有样本的行不会进快照", W.PEND.clSnap(40).some((r) => r.k === "p230.zero"), false);
W.TRAFFIC_MEMORY.aggregates.clear();
const pendSrc = fs.readFileSync("src/store/pend.ts", "utf8");
ok("分位索引用 nearest-rank", pendSrc.includes("Math.ceil(p * v.length) - 1"));
ok("分位索引不再用 floor(p*n)", !pendSrc.includes("Math.floor(p * v.length)"));
ok("索引下限夹到 0（p 很小时不能取负）", pendSrc.includes("Math.max(0, Math.ceil(p * v.length) - 1)"));


/* ---------- 第 231 组：静默表的容量（v7.230 D187） ---------- */
await contracts.case161({ fs, ok, W, eq });

/* ---------- 第 232 组：连接超时只有一个真源（v7.231 D188） ---------- */
await contracts.case162({ fs, ok, eq, W });

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
const c233 = W.METER_CLIENT.calls | 0;
if (typeof W.doFetch === "function") {
  await W.doFetch(mkEnv233(), "u233", "x");
  eq("一次 doFetch 记一次", (W.METER_CLIENT.calls | 0) - c233, 1);
  const bad233 = { METER: { idFromName: (x) => x, get: () => ({ fetch: async () => { throw new Error("boom"); } }) } };
  let threw233 = false;
  try { await W.doFetch(bad233, "u233", "x"); } catch { threw233 = true; }
  ok("失败的 DO 请求也记（额度按发出算）", threw233 && (W.METER_CLIENT.calls | 0) - c233 === 2);
  W.METER_CLIENT.cache.clear();
  await W.meterGet(mkEnv233(), "u233");
  eq("meterGet 也走同一个入口", (W.METER_CLIENT.calls | 0) - c233, 3);
} else {
  ok("一次 doFetch 记一次", false, "doFetch 不存在");
  ok("失败的 DO 请求也记（额度按发出算）", false, "doFetch 不存在");
  ok("meterGet 也走同一个入口", false, "doFetch 不存在");
}
ok("计数点只有一处（meter-client 的 doFetch）", (mc233.split("METER_CLIENT.calls += 1;").length - 1) === 1 && (pd233.split("METER_CLIENT.calls += 1;").length - 1) === 0);
ok("pend 的用量批次改走 doFetch", pd233.includes("doFetch(env, id, \"https://meter/add\"") && !pd233.includes("idFromName(id)).fetch"));
ok("stats 的读用量与回填都走 doFetch", st233.includes("doFetch(env, PEND.id(env) || id, \"https://meter/cnt\")") && st233.includes("doFetch(env, id, \"https://meter/seed\""));
ok("snapshot 的回填走 doFetch", sn233.includes("doFetch(env, id, \"https://meter/set\""));
ok("verdictsync 的读事实走 doFetch", vs233.includes("doFetch(env, raw, \"https://meter/vt\")"));

// ── 234. /logs 读不到跨 isolate 那份时必须留痕（v7.233：fromDo:0 既可能是「没有错误」也可能是「没读到」）──
await views.case163({ W, eq, fs, ok });
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
await contracts.case164({ fs, ok, eq, W });
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
  ok("index.ts 的 ISOLATE.site 回到六个空格", idxSrc.includes("\n      ISOLATE.capture(host, cf.colo);"));
  const polSrc = fs.readFileSync("src/route/policy-wiring.ts", "utf8");
  ok("policy-wiring.ts 的 HOOK 注册回到四个空格", polSrc.includes("\n    HOOK.syncAck = "));
  const tfbSrc = fs.readFileSync("src/route/tfb.ts", "utf8");
  ok("tfb.ts 的 splitRelay 行回到四个空格", tfbSrc.includes("\n    const ip = splitRelay(row.relay, 443)[0];"));
  const fmSrc = fs.readFileSync("src/store/factmerge.ts", "utf8");
  ok("factmerge 的 eg 过期判断落在 egRows 里并引用 FACT_TTL.eg", fmSrc.indexOf("private egRows(") < fmSrc.indexOf("if (r.at <= Date.now() - FACT_TTL.eg) continue;") && fmSrc.indexOf("if (r.at <= Date.now() - FACT_TTL.eg) continue;") < fmSrc.indexOf("private psRows("));
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
W.POOL_MEMORY.rows = [];
W.NODE_MEMORY.alive.clear();
try { await W.refillPool({ poolSrc: many240.join(",") }, 0); } finally { globalThis.fetch = realFetch240; }
ok("抓取次数等于源列表长度", hits240 === srcs240.length, hits240 + " vs " + srcs240.length);
ok("抓取次数不超过上界", hits240 <= cap240 && hits240 > 0, hits240);
const probeSrc240 = fs.readFileSync("src/px/probe.ts", "utf8");
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
await policy.case165({ W, eq, ok });
const budSrc241 = fs.readFileSync("src/route/budget.ts", "utf8");
const cronSrc241 = fs.readFileSync("src/routes/cron.ts", "utf8");
ok("budget.ts 导出 TFB_CALLS", budSrc241.includes("export const TFB_CALLS = 2;"));
ok("budget.ts 的 tfb 一笔由常量推导", budSrc241.includes("tfb: TFB_CALLS,"));
ok("budget.ts 不再写死 tfb: 1", !budSrc241.includes("tfb: 1,"));
ok("dnsRound 文档按真实服务数表述", cronSrc241.includes("每个站点最多 DOH_ENDPOINTS.length 次 DoH"));
ok("dnsRound 不再声称每个 1 次 DoH", !cronSrc241.includes("每个 1 次 DoH 子请求"));

// ===== 第 242 组：一轮 cron 的子请求账本（固定支出 + 三批「每人一次往返」的分账） =====
await contracts.case166({ W, eq, ok, fs });
// ---- 第 243 组：定时持久化的失败必须可见（7.243 / D197） ----
await contracts.case167({ W, ok, fs });
/* ---------- 244. /proxyip?day=1 的读失败不能伪装成「今天零用量」 ---------- */
await contracts.case168({ W, eq, ok, fs });

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
await contracts.case169({ W, mkSt245, sockOf245, wsOf245, eq, ok, fs });

// ── 第 246 组：DO 被重置后从快照回填用量失败，必须留下痕迹 ─────────────────────
await contracts.case170({ W, ok, eq, fs });


// ═══ 第 247 组：跳过 CF 边缘候选不等于试过一次（D201）═══
const H247 = "cfhost247.test";
W.DIALER.cfHost.set(H247, Date.now() + 1800000);
W.NODE_MEMORY.alive.set("198.51.100.9:443", { h: "198.51.100.9", p: 443, at: Date.now(), fail: 0, ok: 3, ms: 200 });
await selection.case171({ W, H247, eq, ok });
await contracts.case172({ fs, ok });
// ── 第 248 组：/debug 把 DO 的 5xx 当成成功（D202）────────────────────────────
await contracts.case173({ W, eq, ok, debugAll, fs });
// ---- 第 249 组：站点「应答了」不等于「回了 200」（D203，7.249） ----
// 探测走 redirect: "manual"（src/core/tf.ts），301/302 是正常形态；只认 200 时
// 会重定向的站点每一批都判 unknown ⇒ rotate，永久换出口、中继拿不到正证据。
await contracts.case174({ ok, W, eq, fs });

// ── 第 250 组：relperf 淘汰判据（D204）+ 判定状态改用枚举（D205）──────────
await contracts.case175({ W, ok, eq, verdictAll, fs });


// ---- 251. 命名规范与结构收口（7.251）：有界表统一实现、语义字段名、枚举成员名
await contracts.case176({ W, ok, eq, fs });

// ── 252) 命名批次二：内存字段改成语义名（v7.252） ──
// 判据：结构体的成员名必须能读出含义（AGENTS.md §6）。这里锁的是本轮改过的形状，
// 防止后续又出现 `n` / `at` / `m` 这类要靠读实现才懂的字段。
await contracts.case177({ verdictAll, ok, fs, W, eq });

// ── 253) 改名必须两端同名（本轮自伤一次，锁住它） ──
await contracts.case178({ pickAll, fs, ok });
// ── 第 254 组：统计层字段改成语义名（纯内存结构，与线协议无关） ────────────
await contracts.case179({ W, eq, ok, statAll, fs });

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
const csrc256 = ["src/proxy/connection.ts", "src/proxy/conn-settle.ts"].map((f) => fs.readFileSync(f, "utf8")).join("\n");
eq("两处调用都把折扣一起传进去", csrc256.split("? 0.3 : 1)").length - 1, 2);
ok("调用点不再自己乘 0.3", !csrc256.includes("w *= 0.3"), "");
ok("封顶按报出的量计", fs.readFileSync("src/proxy/conn-settle.ts", "utf8").includes("Math.min(room, raw * clamped)"), "");
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
await contracts.case180({ fs, ok, eq });


// ── 260. 中继键的 IP 解析只准有一份（7.260）─────────────────────────────
await contracts.case181({ W, eq, pickAll, ok, fs });
// 第 261 组：中继健康表的两张账本收进 RelayLedger（行为 + 泄漏 + 源码锁）
await contracts.case182({ W, eq, ok, fs, debugAll });


// === 第 262 组：灾备快照的每轮上限要轮转，否则排在后面的用户永远停在旧水位 ===
await contracts.case183({ W, eq, ok, fs });

// ═══ 第 263 组：偏好行的字段名能读出含义（c/s/at → channel/state/updatedAt）═══
await contracts.case184({ W, eq, fs, ok });
// ── 264. 「node → IP」的解析只准有一份（v7.264） ─────────────────────────────
// 7.260 把中继健康表与选路的三处解析收口到 relayIpOf，但 judge / factshadow / connection / fallback
// 还各留着一份内联写法：方括号 IPv6（`[2a06:98c0::103]:443`）会带着方括号进键，读端按裸 IP 查永远 -1。
await contracts.case185({ eq, W, ok, fs });

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
ok("调试探针不再内联拆地址", !netsAll().includes('lastIndexOf(":")') && netsAll().includes("const [ph, pp] = splitRelay(pr, 443);"));
ok("池子探活不再内联拆地址", !scanAll().includes('lastIndexOf(":")') && scanAll().includes("splitRelay(key, 443)"));
ok("名单打包不再内联拆地址", !code265("src/px/seed.ts").includes("k.slice(0, i)") && code265("src/px/seed.ts").includes("splitRelay(k, 443)"));
ok("订阅渲染不再内联拆地址", !code265("src/views/sub.ts").includes('lastIndexOf(":")'));

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
const allow265 = ["src/core/relay-addr.ts", "src/px/seed.ts"];
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
const base266 = fs.readFileSync("src/route/fact-table.ts", "utf8");
ok("死亡事实的 load 写了体内步骤", dead266.includes("坏行整条跳过") && dead266.includes("批数夹在 1..9"));
ok("出口族事实的 load 写了体内步骤", base266.includes("三件事任一不成立就整条跳过") && base266.includes("更晚的观测胜出"));
ok("两张表都不再自己实现 load/ack/nack", !dead266.includes("  load(") && !dns266.includes("  load("));
ok("自证探针已清理", !fs.existsSync("src/__probe-body.ts"));


// ---- 第 267 组：判定状态只用枚举（消费端不再写裸数字） ----
﻿// 第 267 组：判定状态只用枚举 + 门禁在位
const ST = W.St || { Unknown: -1, Reachable: -2, Blocked: -3, Dead: -4 };
const host267 = "enum267.test";
// 行为面：prefs 的两栏与 chan() 的三态都在枚举口径下成立
W.VT.setState(host267, "r:10.9.9.1", ST.Reachable, 1);
W.VT.setState(host267, "r:10.9.9.2", ST.Blocked, 1);
const rows267 = W.Prefs.of(host267, 40);
eq("可用的那条落在 ok 栏", rows267.ok.length, 1);
eq("打不通的那条落在 bad 栏", rows267.bad.length, 1);
eq("ok 栏的 state 就是 St.Reachable", rows267.ok[0].state, ST.Reachable);
eq("bad 栏的 state 就是 St.Blocked", rows267.bad[0].state, ST.Blocked);
eq("chanPref 对可用中继回 0", W.Prefs.chan("10.9.9.1", host267), 0);
eq("chanPref 对判死中继回 2", W.Prefs.chan("10.9.9.2", host267), 2);
eq("chanPref 对没测过的中继回 1（未知不惩罚）", W.Prefs.chan("10.9.9.3", host267), 1);

// 源码锁：四个消费端都改走枚举
const srcPol267 = fs.readFileSync("src/route/policy.ts", "utf8");
const srcPref267 = fs.readFileSync("src/route/prefs.ts", "utf8");
const srcVs267 = fs.readFileSync("src/route/verdictsync.ts", "utf8");
const srcDbg267 = debugAll();
ok("policy 用 St.Reachable 过滤判定行", srcPol267.includes("v.state !== St.Reachable"), "");
ok("prefs 用 St.Reachable/St.Blocked 分栏", srcPref267.includes("x.state === St.Reachable") && srcPref267.includes("x.state >= St.Blocked"), "");
ok("prefs 的 chan() 用 St.Reachable", srcPref267.includes("if (state === St.Reachable) return 0;"), "");
ok("verdictsync 用 St.Blocked", srcVs267.includes("if (v.state < St.Blocked) continue;"), "");
ok("debug 的中继封锁列表用 St.Blocked", netsAll().includes("|| v.state < St.Blocked) continue;"), "");

// 门禁在位且真会红（行为由 .tmp-sim 自证，这里锁存在性）
const gate267 = fs.readFileSync("tools/check-names.mjs", "utf8");
ok("命名门禁里有判定状态裸数字判据", gate267.includes("rawStateLiterals") && gate267.includes("判定状态用裸数字"), "");
ok("判据排除枚举文件自身", gate267.includes("src/core/enums.ts"), "");
ok("文档写明判定状态只用枚举", fs.readFileSync("docs/命名约定.md", "utf8").includes("判定状态"), "");
// 第 268 组：比例兜底「释放被判死的中继」时不能顺手抹掉正证据（D213）
await contracts.case186({ W, eq, ok, fs });

const dialerSrc269 = fs.readFileSync("src/proxy/dialer.ts", "utf8");
// ═══ 第 269 组：非法候选不该结束整条重拨链（7.269 / D214）═══
await transport.case187({ W, ok, eq, dialerSrc269 });
// ---- 第 270 组：首包写入上限比数据面短（黑洞中继早失败） ----
// 首包写不进去说明这条中继不可用：等满 30 秒会让客户端先放弃（实测 17.5 秒）。

eq("首包上限是 8 秒", W.FIRST_UP_MS, 8000);
eq("数据面仍是 30 秒", W.UP_STALL_MS, 30000);
ok("首包上限确实比数据面短", W.FIRST_UP_MS < W.UP_STALL_MS);

// 行为面：upWrite 从不 reject（约定就是「失败被吞掉」），但它必须在传入的上限内返回，
// 而且要把这次卡顿记进 ustall —— 否则首包黑洞会被当成「一切正常」。
await selection.case188({ W, ok });

// 源码锁：两处必须成对（改了常量却忘了传参，等于没改）
await contracts.case189({ fs, ok });

﻿// 第 271 组：探测传输层（7.271 起 probeTf 不再写死 tunnelfetch）
await contracts.case190({ eq, W, ok, fs });

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
ok("地区分流与钉节点都走同一个拨号器", rgSrc272.split("SOCKET_DIALER.open(").length - 1 === 3);
// ===== 273. 诊断端点从 Meter.handle 的 if 链搬进 MeterDiagnostics =====
// 它们不落盘、不碰账目；混在账目分支里会让「哪些端点会写 DO」这件事看不出来。
ok("诊断分派器存在、模块级单例已撤", typeof W.MeterDiagnostics === "function" && W.METER_DIAGNOSTICS === undefined);
const mdSrc273 = fs.readFileSync("src/store/meter-diagnostics.ts", "utf8");
ok("每个诊断端点一个方法", ["stagedSnapshot", "timerProbe", "iterationProbe", "cryptoBurnProbe", "jsBurnProbe", "cryptoApiProbe", "relayBatchProbe", "relayProbe"].every((n) => mdSrc273.includes(n)));
ok("分派只认这八个端点", (mdSrc273.match(/pathname\.endsWith\(/g) || []).length === 8);
ok("只有 /stage 读 storage", (mdSrc273.match(/state\.storage/g) || []).length === 1);
const meterSrc273 = fs.readFileSync("src/store/meter.ts", "utf8");
const meterCode273 = meterSrc273.split(/\r?\n/).filter((line) => !line.trim().startsWith("//")).join("\n");
ok("meter.ts 不再自己实现诊断端点", !meterCode273.includes(".endsWith(\"/burnjs\")") && !meterCode273.includes("\"pstage\"") && !meterCode273.includes(".endsWith(\"/crypto\")"));
ok("meter.ts 由端点对象自己分派诊断", meterSrc273.includes("this.diagnostics.run(p, url, this.state)") && !meterSrc273.includes("METER_DIAGNOSTICS.run("));
ok("meter.ts 不再直接 probeTf", !meterSrc273.includes("probeTf"));
// 行为面：分派器对非诊断端点返回 null，对诊断端点返回 Response
const fakeState273 = { storage: { get: async () => "probe-ok" }, blockConcurrencyWhile: async () => {} };
eq("非诊断端点交回 null", await new W.MeterDiagnostics().run("/add", new URL("https://meter/add"), fakeState273), null);
const stageRes273 = await new W.MeterDiagnostics().run("/stage", new URL("https://meter/stage"), fakeState273);
ok("/stage 回读到阶段标记", (await stageRes273.json()).stage === "probe-ok");
const iterRes273 = await new W.MeterDiagnostics().run("/iter", new URL("https://meter/iter?n=1000"), fakeState273);
const iterBody273 = await iterRes273.json();
ok("/iter 夹住 n 并真的跑了", iterBody273.n === 1000 && iterBody273.ok === true);
const cryptoRes273 = await new W.MeterDiagnostics().run("/crypto", new URL("https://meter/crypto"), fakeState273);
const cryptoBody273 = await cryptoRes273.json();
ok("/crypto 逐项给出耗时", typeof cryptoBody273.digest === "number" && cryptoBody273.digestLen === 32);
/* ---------- 274. 账本字段的语义名：内存改、落盘格式不动 ---------- */
await contracts.case191({ mkDO, eq, ok, fs });

// ---- 第 275 组：六个诊断端点由 DebugMeterProbes 统一派发（7.275，用户 m39603 的 OOP 要求） ----
await contracts.case192({ W, eq, ok, debugAll, fs });

// ---- 第 276 组：账本本体从 Meter 里拆成 MeterState（落盘映射只写一处）----
await contracts.case193({ fs, ok, W, eq });


// —— 第 277 组：Attacher 的补救建连与「关客户端」各自只留一处实现 ——
await contracts.case194({ fs, eq, ok, W });

/* ---------- 第 278 组：诊断路由的 DO 读取与 v6 建连都走唯一入口 ---------- */
await contracts.case195({ debugAll, netsAll, fs, ok, W });

// ── 279. 一轮池子维护从 pool.ts 拆成 PoolScan + AliveBoard（v7.279）──
await contracts.case196({ fs, scanAll, ok, eq, W });

// ──────────────────────────────── 第 280 组：选择器一分为三（挑谁 / 什么时候换 / 失败怎么记）────────────────────────────────
await contracts.case197({ fs, ok, eq, W });

// ──────────────────────────────── 第 281 组：probe.ts 一分为四（源清单 / 原始探活 / 地理 / 失败阈值）────────────────────────────────
await contracts.case198({ fs, ok, eq, W });

// ──────────────────────────────── 第 282 组：节点统计这一层的四件事都在一个文件里（v7.297 合回）────────────────────────────────
await contracts.case199({ fs, ok, eq, W });


// —— 283：调试路由按「读 / 量 / 写」拆成三个组件（7.283） ——
await contracts.case200({ fs, netsAll, ok, eq, W });

// —— 284：指标层一分为四（7.284） ——
await contracts.case201({ fs, ok, eq, W });
console.log("\n[285] 策略本体与 HOOK 装配拆成两层");
await policy.case202({ fs, ok, W, eq });
await contracts.case203({ fs, ok, eq, W });
console.log("\n[287] 判定表只有一个文件：类型、表本体、单例都在 verdict.ts");
await contracts.case204({ fs, ok, eq, W });
// 第 288 组：评分这一层的三层（代价 / 健康度 / 候选表）都在一个文件里，且没有空壳类（7.288 拆分 → 7.297 合回）
await contracts.case205({ fs, ok, W });

// 第 289 组：「站点 × 中继」成功率事实按「形状 / 先验 / 待发队列 / 表本体 / 门面」拆开（7.289）
await contracts.case206({ fs, ok, W, eq });

// ---------------------------------------------------------------------------
// 第 290 组：core/util.ts（339 行杂物抽屉）拆成八个按用途命名的文件
// ---------------------------------------------------------------------------
await contracts.case207({ fs, ok, eq, W });

// ---------- 第 291 组：一轮池子维护按「探新 / 复测 / 收尾」拆成三个执行器（7.291） ----------
await contracts.case208({ fs, eq, W });
//
// [292] 决策本体 / 候选排序 / CF 分支树三层分开
//
await contracts.case209({ fs, ok, eq, W });
/* ---------- 第 293 组：封锁事实的形状、上报队列与状态机分家（v7.293；v7.306 起队列归基类） ---------- */
await contracts.case210({ fs, ok, W, eq });
/* ---------- 第 294 组：会拨号的诊断分支按「花哪种预算」分成五个类，但都在一个文件里（v7.297 合回） ---------- */
await contracts.case211({ fs, ok, eq, W });


/* ---------- 295. 连接把「采样窗口」与「客户端背压」拆成两个类 ---------- */
await contracts.case212({ fs, ok, W, eq });


// ---- [296] 挑路的四段生命周期收在同一个文件里：编排 / 池子就绪 / 站点画像 / 偏好过滤 ----
console.log("\n[296] 挑路的四件事在同一个文件里，四个类各自负责一段");
await contracts.case213({ fs, eq, ok, W });

// [301] 薄包装与「只为测试存在的入口」已经收掉：调用点直接调单例
await contracts.case214({ fs, ok, eq, W });

/* 302：九个写入挂在 NodeStatsTable 上，十一个同名转发全删（7.302） */
await contracts.case215({ fs, ok, eq, W });



/* ---------- 第 303 组：十三个薄包装退场，能力挂在单例上 ---------- */
await contracts.case216({ ok, W, eq, fs });

// 第 305 组：事实表的待上报队列只有一份实现（继承 FactTable），不再各抄一遍
await contracts.case217({ fs, ok, W, eq });
/* ---------- 第 306 组：五张事实表共用一个基类（v7.306） ---------- */
await contracts.case218({ fs, ok, W, eq });
// 第 308 组：三种订阅格式并到 sub-common（原来 links / singbox 各自一个文件）
await views.case219({ fs, eq, ok, W });

// ===== 309. 三个家族并回单文件：传输层 / 面板 / 调试路由 =====
// 7.271–7.308 那段「按体积把函数搬进新文件」的做法把文件数从 158 涨到 177，类只多 7 个。
// 用户的口径是「减少文件数、增加类的数量」，于是从 7.297 起改成两件事：① 同段生命周期提基类；
// ② 拆过头的同族合回去。本轮合掉三个家族，锁的是「合完之后能力还在、边界仍可分辨」。
await views.case220({ eq, fs, ok, W });

/* ---------- 310. 连接的采样窗口与背压两类住进 connection.ts ---------- */
await contracts.case221({ fs, ok, W, eq });

  // 第 311 组：三族合并（观测汇总 / 结算与换算 / 订阅视图分派）——文件更少、能力一位不少
  await contracts.case222({ fs, eq, ok, W });

// ═══ 第 312 组：源健康度自报概览、视图页壳并入面板（7.312）═══
await views.case223({ fs, ok, eq, W });

// ═══ 第 313 组：远端事实的合并规则成了一个类（7.313）═══
await contracts.case224({ fs, ok, W });


await contracts.case225({ fs, ok, eq, W });

// 第 315 组：候选表成为一个对象（缓存与分片游标不再是 S 上的全局变量）
await contracts.case226({ fs, ok, W, eq });

/* ---------- 316. /proxyip 的五个分支各占一个方法（视图对象） ---------- */
await contracts.case227({ fs, ok });

/* ---------- 317. /admin 的四个分支各占一个方法（视图对象） ---------- */
await contracts.case228({ fs, ok, W });

/* ---------- 318. 数据面会话是一个对象：握手 / 首帧解析 / 拨号 / 收尾各一个方法 ---------- */
await contracts.case229({ fs, ok, W, eq });


// [319] /add 的合并器：八段口径各一个方法，模块级单例消失
// 判据：这八件事的合并口径完全不同（有的相加、有的「一条证据整体胜出」、有的取更严格的状态），
// 以前全写在一个 145 行的函数体里；改一段必须通读八段才知道会不会动到邻居。
await contracts.case230({ fs, ok, W, eq });

/**
 * 第 320 组：计量 DO 的端点实现从 `Meter` 里拆成一个类（同一个文件里）
 *
 * 为什么这么断言：这一组要证的不是「代码搬家了」，而是「搬完之后每个人都还只干自己的事」——
 * `Meter` 只剩串行化与落盘，端点类拿的是账本 + DO 状态 + 落盘回调三样，
 * 而 `MeterEndpoints` 是同一个文件里的第二个类（用户要求「减少文件数、增加类的数量」）。
 */
await contracts.case231({ fs, ok, mkDO, eq });

/* ---------- 321. 池子报表：行视图 / 解释 / 组装 各成一法 ---------- */
await contracts.case232({ fs, ok, eq, W });

// ═══ 第 322 组：拨号器把「判定 / 中转 / 直连」拆成三段 ═══
await contracts.case233({ fs, ok, eq, W });
// ---- [323] 判定的四段：事实写入 / 整页记账 / 小响应判定各自成方法 ----
await contracts.case234({ fs, ok, W, eq });

// 第 324 组：面板页按「一个类六个分区」组织（7.324）

await views.case235({ fs, ok, readView, eq, W });

await transport.case236({ debugAll, eq, W, ok });
  // ═══ 第 326 组：Attacher 的五段各有边界（7.326）═══
  await contracts.case237({ fs, ok, eq, W });

// 327. 待上报账本的 99 行 flush 拆成「摘批 / 拼体 / 发 / 确认 / 退回 / 退避」（v7.327）
await contracts.case238({ fs, ok, W, eq });

// ── 328 用户表装配是"四张互相引用的结构 + 两条来源顺序"，收进 UserIndex ──
await contracts.case239({ fs, ok, W, eq });

// ── 329 单层抽样的七个前置量与「算臂 / 挑臂」分成方法 ──
await contracts.case240({ fs, ok, W, eq });

/* ---------- 330. 挑路的五段各成一个方法（7.330） ---------- */
await contracts.case241({ fs, ok, W, reset, node, eq });

// —— 第 331 组：快照落盘的 89 行拆成六步，用量/延迟/错误各自合并 ——
await contracts.case242({ fs, ok, W, eq });

// —— 第 332 组：用量视图的 82 行拆成「回填 / DO 视图 / KV 兜底」三块 ——
await contracts.case243({ fs, ok, eq, W });

// —— 第 333 组：控制页与订阅的 81 行 switch 变成 SubscriptionRoutes 类 ——
await views.case244({ fs, ok, eq, W });

// —— 第 334 组：用量灾备快照的 78 行拆成「读旧值 / 轮转切批 / 逐用户合并 / 搬旧值 / 落盘」——
await contracts.case245({ fs, ok, W, eq });

// ---- 第 335 组：评分过程成为 ScoreModel（一次评分一个对象，四项各成方法） ----
await contracts.case246({ fs, ok, W, eq });
/* ---------- 第 336 组：CF 分支树按代价四段各自成函数（v7.336） ---------- */
// 原来一条 70 行函数里排着四段判据：v6 客户端（零证据）、冷启动采样与钉住（写表）、
// 分类与状态码收口（零成本）、事实层兜底（读另一张表）。它们的代价差两个数量级，
// 却共用同一串局部变量，读代码时无法确认「这一行属于哪一段」。
await contracts.case247({ fs, ok, eq, W });


/**
 * 第 337 组：原始探测会话收进 RawProbe（开放反代探测与 SNI 探测只保留「首段字节怎么判」）。
 */
const srcProbe337 = fs.readFileSync("src/px/probe.ts", "utf8").replace(/\r\n/g, "\n");
const clsProbe337 = (() => {
  // 取类体：从 `export class RawProbe {` 到其收尾的整行 `}`
  const i = srcProbe337.indexOf("export class RawProbe {");
  if (i < 0) return "";
  const j = srcProbe337.indexOf("\n}\n", i);
  return j < 0 ? "" : srcProbe337.slice(i, j);
})();
const seg337 = (from, to) => {
  const i = srcProbe337.indexOf(from);
  if (i < 0) return "";
  const j = srcProbe337.indexOf(to, i);
  return j < 0 ? srcProbe337.slice(i) : srcProbe337.slice(i, j);
};
const proxySeg337 = seg337("export async function probeProxy(", "export function tlsHello(");
const sniSeg337 = seg337("export async function probeSni(", "// ---- 并入自 geo.ts ----");

ok("第337组·探测会话是导出类", srcProbe337.includes("export class RawProbe {"));
ok("第337组·五个成员齐备", ["async open(", "async send(", "async peek(", "close(): void", "get tcpMs(", "get elapsedMs("].every((x) => clsProbe337.includes(x)));
ok("第337组·建连只在会话里（含 sslip.io 回退）", clsProbe337.includes("await this.gate.openSocket(this.host, this.port)") && clsProbe337.split(".sslip.io").length - 1 === 1);
ok("第337组·写报文用 finally 释放写锁", clsProbe337.includes('.finally(() => w.releaseLock())'));
ok("第337组·收字节有上限、预算与等待下限", clsProbe337.includes("buf.length < maxBytes") && clsProbe337.includes("const deadline = Date.now() + budgetMs") && clsProbe337.includes("Math.max(waitFloorMs, deadline - Date.now())"));
ok("第337组·提前判据参与循环条件", clsProbe337.includes("!(done && done(buf))"));
ok("第337组·关闭时把引用清空", clsProbe337.includes("this.sock = null;"));
ok("第337组·反代探测改用会话且自己不再建连", proxySeg337.includes("new RawProbe(h, p, gate)") && !proxySeg337.includes("connect({"));
ok("第337组·反代探测的预算与上限只写一处", proxySeg337.includes("probe.peek(8192, 4000, 200,") && proxySeg337.includes("probe.send(PROBE_HELLO, CONNECT_MS)"));
ok("第337组·SNI 探测改用会话且自己不再建连", sniSeg337.includes("new RawProbe(nodeHost, nodePort, gate)") && !sniSeg337.includes("connect({"));
ok("第337组·SNI 探测只收 8 字节", sniSeg337.includes("probe.peek(8, ms, 150,") && sniSeg337.includes("probe.send(tlsHello(sni), ms)"));
ok("第337组·两处都只用一条关闭路径", proxySeg337.includes("probe.close();") && sniSeg337.includes("probe.close();") && !proxySeg337.includes("sock.close()") && !sniSeg337.includes("sock.close()"));
const probe337 = new W.RawProbe("probe337.example", 443);
eq("第337组·未建连时建连耗时为 0", probe337.tcpMs, 0);
ok("第337组·未建连时总耗时非负", probe337.elapsedMs >= 0);
const empty337 = await probe337.peek(8, 20, 5);
eq("第337组·未建连时收字节得到空", empty337.length, 0);
probe337.close();
probe337.close();
ok("第337组·重复关闭不抛错", true);
const denied337 = await W.probeSni("127.0.0.1", 443, "probe337.example");
eq("第337组·SNI 探测拒绝内网目标", denied337.err, "denied");
const proxyDenied337 = await W.probeProxy("127.0.0.1", 443);
eq("第337组·反代探测拒绝内网目标", proxyDenied337, null);
const proxyDenied337b = await W.probeProxy("10.1.2.3", 443);
eq("第337组·反代探测拒绝私网目标", proxyDenied337b, null);
const hello337 = W.tlsHello("probe337.example");
eq("第337组·ClientHello 仍是 handshake 记录", hello337[0], 0x16);
ok("第337组·ClientHello 带 SNI 长度且不是空记录", hello337.length > 40);


/**
 * 第 338 组：SHA-224 的补位 / 展开 / 压缩三步各自成函数（摘要是纯计算，保持自由函数）。
 */
const srcUtil338 = fs.readFileSync("src/core/util.ts", "utf8").replace(/\r\n/g, "\n");
const segUtil338 = (from, to) => {
  const i = srcUtil338.indexOf(from);
  if (i < 0) return "";
  const j = srcUtil338.indexOf(to, i + 1);
  return j < 0 ? srcUtil338.slice(i) : srcUtil338.slice(i, j);
};
const pad338 = segUtil338("export function sha224Pad(", "export function sha224Words(");
const words338 = segUtil338("export function sha224Words(", "export function sha224Mix(");
const mix338 = segUtil338("export function sha224Mix(", "export function sha224Bytes(");
const bytes338 = segUtil338("export function sha224Bytes(", "// ---- 并入自 ws.ts ----");
const bodyLines338 = (seg) => seg.split("\n").filter((l) => l.trim().length > 0).length;

ok("第338组·补位是独立导出函数", srcUtil338.includes("export function sha224Pad(") && pad338.includes("buf[len] = 0x80;"));
ok("第338组·补位写 64 位大端比特长度", pad338.includes("dv.setUint32(total - 8, Math.floor(bits / 4294967296));") && pad338.includes("dv.setUint32(total - 4, bits >>> 0);"));
ok("第338组·补位长度向上取整到 64", pad338.includes("const total = (((len + 8) >> 6) + 1) << 6;"));
ok("第338组·展开是独立导出函数", srcUtil338.includes("export function sha224Words(") && words338.includes("words[i] = view.getUint32(off + i * 4);"));
ok("第338组·展开只递推后 48 字", words338.includes("for (let i = 16; i < 64; i++)") && words338.includes("words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;"));
ok("第338组·压缩是独立导出函数", srcUtil338.includes("export function sha224Mix(") && mix338.includes("SHA_K[i] + words[i]"));
ok("第338组·压缩跑满 64 轮并按加法并入状态", mix338.includes("for (let i = 0; i < 64; i++)") && mix338.split(">>> 0;").length - 1 >= 8);
ok("第338组·入口只剩滚动与截断", bodyLines338(bytes338) <= 20 && bytes338.includes("sha224Pad(toU8(data))") && bytes338.includes("sha224Words(view, off, words);") && bytes338.includes("sha224Mix(state, words);"));
ok("第338组·状态按初值复制，不污染常量", bytes338.includes("const state = SHA_H224.slice();") && !bytes338.includes("SHA_H224["));
ok("第338组·三步按「补位 → 展开 → 压缩」顺序调用", bytes338.indexOf("sha224Pad(") < bytes338.indexOf("sha224Words(") && bytes338.indexOf("sha224Words(") < bytes338.indexOf("sha224Mix("));
const hex338 = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
eq("第338组·空串摘要与参考实现一致", hex338(W.sha224Bytes(new Uint8Array(0))), "d14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f");
eq("第338组·abc 摘要与参考实现一致", hex338(W.sha224Bytes(W.enc.encode("abc"))), "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7");
eq("第338组·test123 摘要与参考实现一致", hex338(W.sha224Bytes(W.enc.encode("test123"))), "4f555b1bb8bc729a665b8892df73119e2ef2eb50dffaf0d5c546cf23");
eq("第338组·1000 字节跨多块摘要一致", hex338(W.sha224Bytes(W.enc.encode("a".repeat(1000)))), "4e8f0ce90b64661a2b5e84be6d93a7d9b76871062f1814433d04a03d");
const padded338 = W.sha224Pad(W.enc.encode("abc"));
eq("第338组·补位后长度是 64 的倍数", padded338.length % 64, 0);
ok("第338组·补位尾部是 0x80 与比特长度", padded338[3] === 0x80 && padded338[padded338.length - 1] === 24);
const arrBuf338 = W.enc.encode("abc").buffer;
eq("第338组·ArrayBuffer 输入与字节数组一致", hex338(W.sha224Bytes(arrBuf338)), "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7");
const state338 = W.SHA_H224.slice();
const work338 = new Uint32Array(64);
const view338 = new DataView(new ArrayBuffer(64));
W.sha224Words(view338, 0, work338);
eq("第338组·全零块展开后首尾都是 0", work338[0] + work338[63], 0);
W.sha224Mix(state338, work338);
ok("第338组·压缩会改写状态", state338[0] !== W.SHA_H224[0] || state338[7] !== W.SHA_H224[7]);
eq("第338组·常量表没被压缩污染", W.SHA_H224[0], 0xc1059ed8);

// ---------- 第 340 组：只读诊断表按分支各成一方法（v7.340） ----------
await policy.case248({ debugAll, ok, eq, W });

// ---------- 第 341 组：站点画像的记账按失败代价拆成七段（v7.341） ----------
await contracts.case249({ fs, ok, eq, W });

// ---- 第 342 组：上行字节流是一个对象，三种收尾各自一个方法 ----
await contracts.case250({ fs, ok, W, eq });


/* ---------- 344. 诊断组件的四个模块级单例改由门面持有 ---------- */
await contracts.case251({ fs, eq, ok, W });

// ---- 第 345 组：pick 家族的三个模块级单例收成一个（门面自己持有 site / paths） ----
await contracts.case252({ fs, ok, W });
  // ═══ 第 346 组：地区挑选器由会话自己持有（7.346）═══
  await contracts.case253({ fs, ok, W, eq });
/* ---------- 第 347 组：失败记账器收进选择门面（v7.347） ---------- */
await contracts.case254({ fs, ok, W, eq });


  // ---- 第 348 组：结算流水线由连接自己持有（7.348）----
  await contracts.case255({ fs, ok, eq, W });

  // ---- 第 349 组：偏好视图的三个薄包装退场（7.349） ----
  // 判据：`prefsOf`/`chanPref`/`prefsJson` 与 7.300–7.303 删掉的那批是同一个形状 ——
  // 一行转发到 `PREFS` 的同名方法，读代码时要跳一次才知道「偏好」到底是谁在算。
  await contracts.case256({ fs, ok, eq, W });


// ──────────────────────────────── 第 350 组：存活表读写器由收尾执行器自己持有（模块级 ALIVE 退场）────────────────────────────────
await contracts.case257({ fs, eq, W, ok });

// 7.351：策略自己持有装配器 —— 模块级 WIRING 退场，槽位注册仍由 PolicyWiring 负责。
await contracts.case258({ fs, ok, W, eq });
// 7.352：诊断分派器由端点对象自己持有 —— 模块级 METER_DIAGNOSTICS 退场。
await contracts.case259({ fs, ok, eq, W });
await views.case260({ fs, ok, W });

await contracts.case261({ fs, ok, W });

await contracts.case262({ fs, ok, W });


// ---- 第 356 组：换节点判定器由门面持有并注入记账器（ROTATION 单例退场）----
await contracts.case263({ fs, ok, eq, W });

// ═══ 第 357 组：store 门面退场 ═══
await contracts.case264({ fs, ok, eq, W });
// ---------- 第 358 组：订阅渲染器由路由类自己持有（v7.358）----------
await views.case265({ fs, ok, eq, W });

// ===== 第 359 组：两张「标记时刻」表共用一份有界实现（7.359）=====
await contracts.case266({ fs, ok, W });


/* ===== 第 360 组：额度账本与花钱的出口（7.363 拆分后） ===== */
await contracts.case267({ W, eq, ok, fs });

/* ===== 第 361 组：会话变薄（7.362） ===== */
await contracts.case268({ fs, ok, W });

/* ---------- 第 363 组：事实写入注册表把 rankOf 的三条写动作收口（7.363） ---------- */
await policy.case269({ W, ok, eq });

// ===== 第 365 组：Judge 的软记忆收进 JudgeMemory，三个 S 字段迁出 AppState（7.365）=====
await contracts.case270({ fs, ok, W });

// 第 366 组（审查修复）：VT 导入不续期 + BudgetExhausted 不被吞 + 状态门禁覆盖 TS 写法
await contracts.case271({ fs, ok, W });

// ── 367 新增用户订阅：用户表不能用「只含 env 变量的 sig」做正向缓存 ──
await contracts.case272({ fs, ok, W, eq });

console.log("\n368) 审查 D2/D3：事实快照形状与上报批次不并发");
await contracts.case273({ fs, ok, W, eq });

// ---- 第 369 组：HTML 模板抽取 + 预算额度传递（审查修复）----
await contracts.case274({ W, eq, fs, ok });

// ── 370. debug ?do=1 写回判定证据后 ack/nack，pending 不重复上报 ──
await contracts.case275({ fs, ok, W });

// ── 第 371 组：地区节点质量层（枚举 / 6 源归一 / 合并 / 覆盖 / 连通性 / seed 传播）──
await views.case276({ ok, W, eq });

// 第 372 组：地区节点浏览器 /regions + ?node= 硬钉住（地区/质量重设计）
await views.case277({ W, ok, eq, fs });
// 第 373 组：订阅按用户地区配置生成 ?node= 条目（地区/质量重设计）
await views.case278({ W, fs, ok, eq });
// 第 374 组：面板用户地区配置（op=config）+ env 用户转托管
await views.case279({ fs, ok, readView, W, eq });
// 第 375 组：面板地区/连通性入口 + 连通性观测写入路径
await views.case280({ readView, fs, ok, W, eq });
// 第 376 组：HTML 模板经混淆链后必须保留真实换行，不能被压成字面 \n 文本。
const SRC = [
  "obf/pre.js",
  "src/views/html/panel.html",
  "src/views/html/stats.html",
  "src/views/html/admin.html",
  "src/views/html/login.html",
  "src/views/html/admin-hint.html",
];
const rd = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

// 结构：unescapeLiteral 存在且在编码前被调用
const pre = rd("obf/pre.js");
ok("[376] obf/pre.js 有 unescapeLiteral", pre.includes("function unescapeLiteral("));
ok("[376] 字符串编码前先还原转义", pre.includes("b64(unescapeLiteral(body, q))"));
ok("[376] 还原 \\n", pre.includes('c === "n"') && pre.includes('out += "\\n"'));
ok("[376] 还原 \\r", pre.includes('c === "r"'));
ok("[376] 还原 \\t", pre.includes('c === "t"'));

// 结构：所有 .html 模板文件都是 LF（不依赖 core.autocrlf 翻回 CRLF）
for (const name of ["panel", "stats", "admin", "login", "admin-hint"]) {
  const raw = fs.readFileSync(`src/views/html/${name}.html`, "utf8");
  ok(`[376] ${name}.html 无 CRLF`, !raw.includes("\r\n"));
}
ok("[376] .gitattributes 固定 *.html 为 LF", fs.readFileSync(".gitattributes", "utf8").includes("*.html text eol=lf"));

// 行为：如果 _worker_v3.mid.js 存在（混淆链已跑），解码其中所有 base64 字符串，
// 找出 HTML 模板，确认它们含真实换行而非字面 "\n" 文本。
const midPath = "_worker_v3.mid.js";
if (fs.existsSync(midPath)) {
  const s = rd(midPath);
  const cands = s.match(/[A-Za-z0-9+/]{40,}={0,2}/g) || [];
  let templates = 0;
  for (const c of cands) {
    let d;
    try { d = Buffer.from(c, "base64").toString("utf8"); } catch { continue; }
    if (!/<!doctype html>|<style>|class="badge"/.test(d)) continue;
    templates++;
    const lit = (d.match(/\\r\\n/g) || []).length + (d.match(/\\n/g) || []).length;
    ok(`[376] 混淆后模板#${templates} 无字面换行文本`, lit === 0);
    ok(`[376] 混淆后模板#${templates} 含真实换行`, d.includes("\n"));
  }
  // 混淆产物里模板能否解出、解出几个，取决于 obf 的字符串分块（带随机性），
  // 且 test_score 排在混淆步骤之前，读到的可能是上一轮遗留的 mid 包。
  // 修复正确性已由上面的结构断言（unescapeLiteral 存在 + 编码前调用 + \n\r\t 还原）证明，
  // 这里只做 best-effort 的性质检查，不把「恰好解出一个」当硬门禁，避免随机红。
  if (templates === 0) console.log("[376] 提示：本次 mid 包未解出 HTML 模板，跳过行为断言（结构断言仍生效）");
}

// 第 377 组：地区选择自助面板 —— 展示映射 / 分组 / HTML / JSON 兼容 / POST 写回
await views.case281({ readView, ok, fs, regionsSource, W, eq });

// 第 378 组：节点界面增强 —— 全量节点/已探优先分组、事实列、指定网站探测、质量重探、限流
await views.case282({ regionsSource, readView, fs, ok, eq, W });

// 第 379 组回归：/regions 冷 isolate 必须按需载入 seed（不能只读空内存）
await views.case283({ W, eq, ok });

// 7.381：架构低风险收敛——决策理由封闭类型 + 节点快照合并去重。
await contracts.case284({ fs, ok, W, eq });

// 7.382：架构第二批——cfHost 缓存收进 Dialer 实例 + seed.ts 文档乱码修复。
await contracts.case285({ fs, ok, W });

// 7.383：架构第三批——七张事实表行形状抽单一真源 FactTables（metershard.ts）。
await contracts.case286({ fs, eq, ok });


  // 384. 单例准入门禁（7.384）：命名约定.md 的清单与实际导出实例一一对应。
  await contracts.case287({ fs, ok, execFileSync, eq });

// ── 386. 首字节看门狗：黑洞出口无下行主动关 socket 启动补救链 ─────────────
await contracts.case288({ fs, ok, W, eq });


// 第 387 组：默认 url-test 探测目标改 CF 站点（?pu= 可覆盖），v6 出口通道在测速阶段即被淘汰
await contracts.case289({ W, ok, eq, fs });


  // 388. famfacts：站点×出口族实测定价（取代 CF 目标 v6 一刀切 ×40）
  await contracts.case290({ fs, ok, W, eq });


// 第 389 组：面板勾选具体节点（pinnedNodes）—— 数据层归一化 + 面板勾选框 + 订阅独立分组
await views.case291({ fs, regionsSource, ok, W, eq });


// 第 390 组：节点连通测试 —— 对指定节点测用户输入的网站，诊断连通与被 ban
await views.case292({ regionsSource, readView, ok, W, eq });

// ---- 第 391 组：地区面板 UI 优化（出站 IP 列 / 国家已知徽章 / 探测不跳转 + 探对节点） ----
await views.case293({ readView, regionsSource, ok, W });

// 第 392 组：修探测按钮 NetworkError + 探测结果文本格式（冒号粘连/悬空分隔符）
await views.case294({ regionsSource, readView, ok });

// 第 393 组：冷 isolate 事实加载与 DoH 并行修复（修偶发 IPv6 403）
// 结构锁读源码；行为验证用纯 JS 复刻 classify 的「先启动、后 await」竞态语义。


const dialSrc393 = fs.readFileSync("src/proxy/dialer.ts", "utf8");
const dial393 = dialSrc393.replace(/\r\n/g, "\n");

// 结构锁
ok("[393] factLoad 在 DoH 判定之前启动",
  dial393.indexOf("const factLoad = HOOK.vtLoad") < dial393.indexOf("if (needDoh) cfHost = await this.dohCf("));
ok("[393] factLoad 吞掉加载异常", dial393.includes("HOOK.vtLoad(env).catch(() => {})"));
ok("[393] DoH 后 await 已启动的 promise", dial393.includes("Promise.race([factLoad, new Promise"));
ok("[393] 不再串行重启 vtLoad", !dial393.includes("await Promise.race([HOOK.vtLoad(env)"));
ok("[393] 注释记载 403 根因", dial393.includes("v6 排前就 100% 撞 737B IPv6 403"));

// 行为：复刻 classify 的新旧两种时序，证明「并行启动」让事实在 DoH 期间就绪。
// 旧时序：先 await DoH(50ms)，再启动 factLoad(40ms) ⇒ 90ms 后事实才就绪。
// 新时序：同时启动 factLoad(40ms) 与 DoH(50ms) ⇒ 50ms 时事实已就绪。
await selection.case295({ ok });
// ── 第 394 组：管理面板 CSP 允许同源 fetch（Firefox NetworkError 根因）──
await contracts.case296({ W, ok, fs });
// ── 第 395 组：地区面板探测结果显示国家 + 已知节点按国家分组 ──
await views.case297({ regionsSource, ok, W, eq });
  // ---- 第 396 组：地区面板探测交互（重探回填 / 勾选节点探测 / 状态码+延迟） ----
  await views.case298({ fs, regionsSource, readView, ok, W });
  // ---- 第 397 组：探测结果显示节点国家码（POST 路径惰性载入 alive/seed） ----
  await views.case299({ regionsSource, ok, eq, W });

// ---- 第 398 组：地区面板表格加国家列 + 连通测试框 placeholder 不再触发混淆 ----
await views.case300({ regionsSource, readView, ok, W });


// ---- 第 399 组：真实 ISO 国家码（展示层，与选路用的 CF 机场码分开） ----
await views.case301({ regionsSource, fs, ok, W, eq });


// 第 400 组：地区面板分页 / 折叠 / 全池节点 / 延迟按探测站点
await views.case302({ regionsSource, readView, ok, W, eq });


// 402) 质量探测顺带回填国家码 + EG 门槛从 20KB 降到 EG_TINY（问题①③）
await views.case303({ W, ok, eq });

// 403) 四问题批量修复：有界表不会随操作次数无界增长 + 自选/地区节点 server 走 CF 边缘（问题②④）
await views.case304({ W, ok, fs });

// 404) 问题④：探测端口与真实拨号端口一致（relayAddr 保留显式端口，pickFresh 按裸 IP 查判定表）
await contracts.case305({ fs, ok, W });

// 405) 问题②：ISO 查询负缓存 + prune 只在超容量时调用（1102 累积效应根治）
await views.case306({ W, eq, fs, ok, regionsSource });


// 406) 问题②：rows() 结果缓存——重建 1600 行在 CF 上超 10ms CPU 即 1102；TTL 30 秒且命中只看寿命，后台 churn 不触发重建
await views.case307({ ok, W, regionsSource });
// ---- 第 407 组：探测同时判可用性 + IP 组织展示（黑洞根因修复） ----
await views.case308({ fs, regionsSource, readView, ok, W, eq });
// 第 408 组：探测必须真走中继（forceTunnel）+ Clash MATCH 指向手动组，自选节点才生效
await views.case309({ fs, ok, W });
await contracts.case310({ fs, ok, W });
// [410] 钉节点按目标分流：中继只到得了 CF 托管站点，无条件硬钉会让 google/github 全挂
await contracts.case311({ W, ok, fs });

// ---- 411) 地区分流：国家码采集 + 按目标分流（7.414）----
await contracts.case312({ W, ok, eq, fs });


// ---- 412) ?rebuild=1 强制重建候选池（7.415）----
await contracts.case313({ fs, ok });



// ---- 第 413 组：地区面板 UI 改版（搜索筛选 / 吸底保存 / 横向滚动 / 折叠 / 浮层提示） ----
await views.case314({ readView, regionsSource, ok, W });


// ---- 第 414 组：大文件断流的可观测性（safeSend 布尔 / client gone 落盘 / ?limit= / 文档同步） ----
await views.case315({ fs, regionsSource, ok, eq, W });
// ── 416. 断流证据必须挂 waitUntil（7.421）────────────────────────────────────
await contracts.case316({ W, sockOf245, wsOf245, ok, fs, eq });

// ---- [417] ?format=json 序列化结果缓存（1600 行 650 KB，重复 stringify 吃满免费版 CPU）----
await views.case317({ ok, W, regionsSource });
// ---- [418] 覆盖站点提示 + 面板可信度（本轮自举：展示 ISO 码与路由机场码分离的前提修正）----
await views.case318({ readView, regionsSource, ok });

// ===== [418] 公共 SOCKS5 出口（?s5=）：通用出口，与只转 CF 托管站点的 proxyip 中继是两回事 =====
await views.case319({ W, ok, eq, fs, regionsSource });
await views.case320({ readView, ok });
console.log(`\n评分/选择单测：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);

