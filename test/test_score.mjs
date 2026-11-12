import * as W from "./_bundle.mjs";
import { webcrypto } from "node:crypto";

// Node 18 没有全局 crypto（Workers 有），补一个给 tlsHello() 用
if (!globalThis.crypto) globalThis.crypto = webcrypto;

let pass = 0,
  fail = 0;
const eq = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
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
W.SC.LAT_TS = 0; // 单测确定性：关闭 TS
W.SC.ROUTE_T_LAT = 0; // 单测默认确定行为：关闭抽签，走粘滞游标
W.SC.ROUTE_T_TPUT = 0;
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

// seed 只作为先验：置信度封顶 0.25，过期即回落
reset();
node("seed:443", { tcp: 50 });
const sSeed = W.S.nstat.get("seed:443");
sSeed.seedBps = 20 * 1048576;
sSeed.seedAt = Date.now();
const pSeed = W.scoreParts("seed:443", "tput");
eq("seed 先验来源", pSeed.priorSource, "seed");
ok("seed 把先验拉到约 1.5s", pSeed.e10Ms > 1000 && pSeed.e10Ms < 2200, String(pSeed.e10Ms));
sSeed.seedAt = Date.now() - 48 * 3600e3;
eq("seed 过期回落默认先验", W.scoreParts("seed:443", "tput").priorSource, "prior");
// 到期前后不能跳变：24h 整那一刻置信度应该已经衰减到 0，而不是 0.125 → 0
{
  sSeed.seedAt = Date.now() - 23.9 * 3600e3;
  const eA = W.scoreParts("seed:443", "tput").e10Ms;
  sSeed.seedAt = Date.now() - 24.1 * 3600e3;
  const eB = W.scoreParts("seed:443", "tput").e10Ms;
  ok("seed 到期平滑回落（跳变 < 1s）", Math.abs(eA - eB) < 1000, `${Math.round(eA)} vs ${Math.round(eB)}`);
  // 一条短样本不该抹掉 8MB/s 的 seed 先验；够 3 个有效窗口才作废
  {
    reset();
    node("sp:443", {});
    const sp = W.nsGet("sp:443");
    sp.seedBps = 8 * 1048576;
    sp.seedAt = Date.now();
    W.nsSpeed("sp:443", 512 * 1024, 512 * 1024, {}, 1);
    eq("单条本地样本保留 seed", sp.seedBps, 8 * 1048576);
    W.nsSpeed("sp:443", 512 * 1024, 512 * 1024, {}, 1);
    W.nsSpeed("sp:443", 512 * 1024, 512 * 1024, {}, 1);
    eq("3 个有效窗口后 seed 作废", sp.seedBps, 0);
  }
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
node("e:443", { tS: 0, eCloseP: 6, tcp: 50 });
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

// 成功连接要给节点记 ok/tS，否则面板永远显示 0、可用性门槛永远不生效
reset();
const c6 = new W.Connection({}, {}, "tput", "");
c6.id = "u3";
c6.node = "ok2:443";
c6.down = 2048;
c6.flush(true);
eq("成功连接记一次 ok", (W.S.nstat.get("ok2:443") || {}).okW, 1);
eq("成功连接进入可用性样本", (W.S.nstat.get("ok2:443") || {}).tS, 1);

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
const rnd0 = Math.random;
Math.random = () => 0; // 强制走探索分支
const p2 = W.SEL.pick({ pxShadow: 0.05 }, "tput", st2);
Math.random = rnd0;
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
eq("游标失效 → 选当前最优", W.SEL.pick({ pxShadow: 0 }, "lat", null), "v1:443");
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
eq("两次样本就能比较出快慢", W.SEL.pick({ pxShadow: 0 }, "tput", st3), "p:443");

/* ---------- 10. 站点族 / 保质期 / 缓存 ---------- */
eq("api.x.com → x.com", W.hostKey("api.x.com"), "x.com");
eq("pbs.twimg.com → x.com", W.hostKey("pbs.twimg.com"), "x.com");
eq("www.example.co.uk 保留三段", W.hostKey("www.example.co.uk"), "example.co.uk");
eq("a.b.example.com → example.com", W.hostKey("a.b.example.com"), "example.com");
eq("IP 原样", W.hostKey("1.2.3.4"), "1.2.3.4");

// 同族共享一张表
reset();
node("f1:443", { tcp: 50 });
node("f2:443", { tcp: 60 });
W.hostNodeMark("api.x.com", "f1:443", { ok: true, bad: false, bytes: 100, ttfb: 70 });
W.hostNodeMark("pbs.twimg.com", "f2:443", { ok: true, bad: false, bytes: 100, ttfb: 200 });
eq("同族两个域名共用一张表", W.S.hostNode.get("x.com").size, 2);
eq("族内按首字节排序", W.hostRank("x.com", "lat")[0].k, "f1:443");

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

/* ---------- 11. v2.1：风险先验 / seed 伪计数 / 自适应探索 ---------- */
reset();
eq("无样本 pFailRisk = 0.1（不加不确定性溢价）", W.pFailOf(W.nsGet("fresh:443")), 0.1);

{
  const s = W.nsGet("seedrel:443");
  s.seedN = 10;
  s.seedFail = 5;
  s.seedAt = Date.now();
  const p = W.pFailOf(s);
  ok("seed 只修正先验均值（≈0.167）", p > 0.15 && p < 0.18, String(p));
  s.seedAt = Date.now() - 48 * 3600e3;
  eq("seed 过期回落到 0.1", W.pFailOf(s), 0.1);
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
const explored1 = stE.trial === true || stE.hostTrial === true;
ok("样本不足时 7% 也会探索", explored1, `picked=${picked1}`);

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
eq("样本够了 7% 不再探索", picked2, "f1:443");
eq("没有标记试探", stF.trial === true, false);

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

// 站点倾向要能跨 isolate：hp 必须把 bps 一起写进 seed，否则换个实例只剩 ttfb
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
  const row = doc.byColo.TST.hp.find((x) => x.h === "site-seed.test" && x.k === "hpb:443");
  eq("seed 的站点偏好带上了 bps", Math.round((row && row.bps) || 0), 2 * 1048576);
  // 模拟另一个 isolate 冷启动
  W.S.hostNode.clear();
  W.S.seedAt = 0;
  W.S.seed = { v: 0, ts: 0, poolGen: 0, poolN: 0, builtAt: 0, byColo: {} };
  await W.SEEDS.read(env);
  const back = W.S.hostNode.get("site-seed.test").get("hpb:443");
  eq("别的 isolate 能读到站点级 bps", Math.round((back && back.bps) || 0), 2 * 1048576);
}

// 跨 isolate 快照按流量挑前 16 个，而不是 Map 的前 16 个
reset();
for (let i = 0; i < 20; i++) {
  node(`sn${i}:443`, {});
  W.nsGet(`sn${i}:443`).bytesDown = i * 1024 * 1024;
  W.nsGet(`sn${i}:443`).tS = i + 1;
}
const snapN = W.spdSnapshot();
ok("快照包含流量最大的节点", !!snapN["sn19:443"], Object.keys(snapN).join(","));
eq("快照最多 16 个", Object.keys(snapN).length, 16);

reset();
node("ln:443", { tcp: 50, pN: 4, okW: 4 });
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
  eq("DO 落盘失败回滚内存", m.c.up, 0);
  fail = false;
  await m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 10, down: 20, conns: 1 }) }));
  eq("恢复后只记一次", m.c.up, 10);
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
  eq("spd 容器是 null 原型", Object.getPrototypeOf(doP.m.s), null);
  eq("__proto__ 不作为自有键写入", Object.prototype.hasOwnProperty.call(doP.m.s, "__proto__"), false);
  ok("正常节点仍保留", !!doP.m.s["ok:443"]);
}

/* ---------- 探活不能灌水面板成功率 ---------- */
{
  const s = W.nsGet("probe-only:443");
  W.nsProbe("probe-only:443", 50, 40, 10);
  eq("探活不增加 ok", s.ok, 0);
  eq("探活仍记延迟样本", s.pN, 1);
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
node("rde1:443", { tcp: 60, tls: 10, okW: 5, failW: 0, tS: 5, eCloseP: 6 });
node("rde2:443", { tcp: 180, tls: 20, okW: 20, failW: 1, tS: 20, eCloseP: 0 });
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
node("rjp1:443", { tcp: 60, tls: 10, okW: 20, failW: 1, tS: 20 });
node("rjp2:443", { tcp: 70, tls: 10, okW: 20, failW: 1, tS: 20 });
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

// 加权抽签：T=0 退化成一个确定的最优；T>0 时按分数分布抽
reset();
node("ra:443", { tcp: 60, okW: 20 });
node("rb:443", { tcp: 80, okW: 20 });
W.SC.ROUTE_T_LAT = 0;
eq("T=0 走粘滞游标（等价选第一）", W.SEL.pick({ pxShadow: 0 }, "lat", { host: "" }), "ra:443");
W.SC.ROUTE_T_LAT = 20;
let na = 0, nb = 0;
for (let i = 0; i < 600; i++) {
  const k = W.SEL.pick({ pxShadow: 0 }, "lat", { host: "" });
  if (k === "ra:443") na++;
  else if (k === "rb:443") nb++;
}
ok("T=20 两个候选都抽得到", na > 0 && nb > 0, `${na}/${nb}`);
ok("T=20 更快的抽得更多", na > nb * 1.5, `${na}/${nb}`);
W.SC.ROUTE_T_LAT = 0;

console.log(`\n评分/选择单测：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
