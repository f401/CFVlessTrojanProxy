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
const pickI = W.SEL.pick(envS, "lat", { host: "", sz: W.SC.SZ_I });
const pickB = W.SEL.pick(envS, "lat", { host: "", sz: W.SC.SZ_B });
Math.random = rndSZ;
ok("pick 会把 sz 传进打分", pickI === "za:443" && pickB === "zb:443", `${pickI} / ${pickB}`);

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
W.recordProbe({ target: tg, chan: chR2, code: 403, ms: 90 });
eq("probe 403 记为 blocked", W.vState(tg, "r:185.253.117.147"), 2);
ok("blocked 通道被判坏", W.vBad(tg, "r:185.253.117.147"));
W.vSetState(tg, "r:185.253.117.147", 1, 0);
eq("弱证据不能冲掉强证据的 blocked", W.vState(tg, "r:185.253.117.147"), 2);
W.recordProbe({ target: tg, chan: chR, code: 0, ms: 800 });
eq("probe 连不上记为 dead", W.vState(tg, "r:45.136.117.194"), 3);
W.recordProbe({ target: "*", chan: chR2, code: 200, ms: 60 });
ok("精确键优先于通配", !W.vOk(tg, "r:185.253.117.147"));
W.recordProbe({ target: "*", chan: chR, code: 200, ms: 55 });
ok("通配键可作回退", W.vOk("1.2.3.4", "r:45.136.117.194"));
ok("probe 同时写入池子统计", (W.nsGet("45.136.117.194:443").pN || 0) > 0);
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
ok("预算不超过子请求硬上限", pl.adm + pl.vt + pl.edge <= pl.cap, JSON.stringify(pl));
ok("池子很饿时优先给准入", pl.adm >= 4, JSON.stringify(pl));
ok("策略默认只放开硬规则（level 1）", W.SC.POLICY === 1);
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
W.recordProbe({ target: "x.com", chan: { kind: "r", ip: "45.136.117.194" }, code: 403, ms: 70 });
ok("被判 blocked 的中继被 veto", W.HOOK.veto("x.com", "45.136.117.194") === true);
ok("同站点未判过的中继不被 veto", W.HOOK.veto("x.com", "89.22.227.132") === false);
ok("站点级判定不外溢到别的站点", W.HOOK.veto("y.com", "45.136.117.194") === false);
W.recordProbe({ target: "*", chan: { kind: "r", ip: "89.22.227.132" }, code: 0, ms: 900 });
ok("中继级（通配）判定对所有站点生效", W.HOOK.veto("y.com", "89.22.227.132") === true);
W.vClear();
ok("清空后不再 veto", W.HOOK.veto("x.com", "45.136.117.194") === false);
// 第 34 组：连接证据钩子（traffic，差分判据）
W.vClear(); W.S.needPx.clear(); W.S.smCnt.clear(); W.S.bigByHost.clear(); W.S.vtQ = [];
W.HOOK.traffic({ host: "x.com", via: "node", node: "45.136.117.194:443", down: 900, ok: false, life: 800, up: 0 });
eq("只有小响应时不判死（可能只是业务层 403）", W.vState("x.com", "r:45.136.117.194"), 0);
ok("小响应只入复核队列", W.queueLen() > 0);
W.HOOK.traffic({ host: "x.com", via: "node", node: "89.22.227.132:443", down: 90000, ok: true, life: 4000, up: 900 });
eq("同一站点别的通道能打通 → 记为 ok", W.vState("x.com", "r:89.22.227.132"), 1);
W.HOOK.traffic({ host: "x.com", via: "node", node: "45.136.117.194:443", down: 900, ok: false, life: 800, up: 0 });
eq("有别的通道能打通 + 本通道两次小响应 → 判该通道被封", W.vState("x.com", "r:45.136.117.194"), 2);
ok("判被封后设 needPx（下次优先中转）", (W.S.needPx.get("x.com") || 0) > Date.now());
W.HOOK.traffic({ host: "x.com", via: "node", node: "45.136.117.194:443", down: 90000, ok: true, life: 4000, up: 900 });
eq("之后拿到大响应 → 解除误判", W.vState("x.com", "r:45.136.117.194"), 1);

// 第 35 组：判定表跨 isolate 同步（只同步强证据）
W.vClear(); W.S.vtSent.clear();
W.recordProbe({ target: "x.com", chan: { kind: "r", ip: "45.136.117.194" }, code: 403, ms: 60 });
const dl = W.HOOK.vtDelta();
eq("强证据进增量", dl.length, 1);
eq("增量键是 target|chan", dl[0].k, "x.com|r:45.136.117.194");
eq("增量里是 blocked", dl[0].s, 2);
eq("同一证据不重复上报", W.HOOK.vtDelta().length, 0);
W.vClear();
eq("清空后本地为空", W.vAll().length, 0);
W.vImport(dl);
eq("远端强证据可导入", W.vState("x.com", "r:45.136.117.194"), 2);
ok("导入后 veto 生效", W.HOOK.veto("x.com", "45.136.117.194") === true);
W.recordProbe({ target: "y.com", chan: { kind: "r", ip: "1.1.1.1" }, code: 200, ms: 40 });
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
// 第 37 组：一轮 cron 的判定侧编排（预算 → 挑站点）
W.vClear(); W.S.needPx.clear();
eq("无信号时没有要扫的站", W.pickHosts(3).length, 0);
W.S.needPx.set("x.com", Date.now() + 3600000);
eq("needPx 未过期的排第一", W.pickHosts(3)[0], "x.com");
W.S.needPx.set("old.com", Date.now() - 1000);
eq("过期的 needPx 不算信号", W.pickHosts(3).length, 1);
W.S.needPx.clear();
W.vSetState("api.x.com", "r:1.1.1.1", 2, 1);
eq("刚记下的 blocked 不复核", W.pickHosts(3).length, 0);
const vrow = W.vAll()[0]; vrow.at = Date.now() - 1200000;
eq("过了 15 分钟的 blocked 要复核", W.pickHosts(3)[0], "api.x.com");
eq("预算 8 只够扫 2 个站", Math.floor(8 / W.SWEEP_COST), 2);
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
  const yx = W.renderClash(envS, new URL("https://example.com/x?x=1"), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "example.com");
  eq("?x=1 才发 x 组（按 x.com 实测）", yx.includes("url: https://x.com/"), true);
  eq("?x=1 时 x 规则排在 GEOIP 之前", yx.indexOf("DOMAIN-SUFFIX,x.com") >= 0 && yx.indexOf("DOMAIN-SUFFIX,x.com") < yx.indexOf("GEOIP,CN,DIRECT"), true);
  const y0 = W.renderClash(envS, new URL("https://example.com/x?e=0"), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "example.com");
  eq("?e=0 时不发边缘条目", (y0.match(/name: "e-/g) || []).length, 0);
  eq("?e=0 时不发 x 组", y0.includes("🛰 x 优选"), false);
}

// 第 39 组：节点偏好表（站点 × 通道的「能通 / 打不通」两栏）
{
  W.vClear();
  eq("没测过的通道不降权（未知 = 1）", W.chanPref("9.9.9.1"), 1);
  W.vSetState("*", "r:9.9.9.2", 1, 1);
  eq("实测能打通的通道 = 0", W.chanPref("9.9.9.2"), 0);
  W.vSetState("*", "r:9.9.9.3", 2, 1);
  eq("实测打不通的通道 = 2", W.chanPref("9.9.9.3"), 2);
  const pf = W.prefsJson(20);
  eq("偏好表能打通一栏含该通道", pf.ok.some((x) => x.c === "r:9.9.9.2"), true);
  eq("偏好表打不通一栏含该通道", pf.bad.some((x) => x.c === "r:9.9.9.3"), true);
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
// 第 41 组：复核判定矩阵（同站点 × 两条通道的实测差分）
W.vClear();
eq("可疑通道 403 + 参照 200 → 通道级", W.judge(403, 200), "chan");
eq("两条都 403 → 站点级（不冤枉中继）", W.judge(403, 403), "site");
eq("可疑通道 200 → 是误判，记 ok", W.judge(200, 403), "ok");
eq("可疑通道连握手都过不去 + 参照 200 → 通道级", W.judge(0, 200), "chan");
eq("两边都连不上 → 不下结论", W.judge(0, 0), "unknown");
eq("301 视为可通（不算被封）", W.judge(301, 200), "ok");
W.S.vtQ = [];
W.queueVerify("a.com", { kind: "r", ip: "1.1.1.1" });
W.queueVerify("a.com", { kind: "r", ip: "1.1.1.1" });
eq("同一组合重复入队只留一条", W.queueLen(), 1);
await W.runVerify();
eq("没有参照通道时不做判定（队列被取走、判定不变）", W.vState("a.com", "r:1.1.1.1"), 0);
// 第 42 组：HTTP 状态码判据接进决策（状态码级证据，1 个请求即可学会）
W.vClear(); W.S.cfHttp.clear();
W.S.cfHttp.set("x.com", { code: 403, colo: "SOF", t: Date.now() });
const d403 = W.decide({ host: "x.com", cfHost: true, clientV6: false, relays: ["104.16.0.5"], legacyWantsRelay: false });
ok("本出口 403 → 决策绕中继", d403.chan.kind === "r" && d403.why === "http403");
W.S.cfHttp.set("x.com", { code: 200, colo: "VIE", t: Date.now() });
const d200 = W.decide({ host: "x.com", cfHost: true, clientV6: false, relays: ["104.16.0.5"], legacyWantsRelay: true });
eq("本出口 200 → 决策直连（少一跳）", d200.chan.kind, "d");
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
console.log(`\n评分/选择单测：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
