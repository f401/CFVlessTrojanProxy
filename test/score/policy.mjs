/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case034({ W, eq }) {
  W.VT.clear();
  eq("没测过的通道不降权（未知 = 1）", W.Prefs.chan("9.9.9.1", "a.com"), 1);
  eq("不传站点一律「未知」：通配行已经不存在", W.Prefs.chan("9.9.9.1"), 1);
  W.VT.setState("a.com", "r:9.9.9.2", 1, 1);
  eq("实测能打通的通道 = 0", W.Prefs.chan("9.9.9.2", "a.com"), 0);
  eq("别的站点看不到这条证据", W.Prefs.chan("9.9.9.2", "b.com"), 1);
  W.VT.setState("a.com", "r:9.9.9.3", 2, 1);
  eq("实测打不通的通道 = 2", W.Prefs.chan("9.9.9.3", "a.com"), 2);
  const pf = W.Prefs.json(20);
  eq("偏好表能打通一栏含该通道", pf.ok.some((x) => x.channel === "r:9.9.9.2"), true);
  eq("偏好表打不通一栏含该通道", pf.bad.some((x) => x.channel === "r:9.9.9.3"), true);
  W.VT.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case035({ W, eq }) {
  W.VT.clear();
  const ch = { kind: "r", ip: "9.9.9.7" };
  W.recordBlock({ target: "x.com", chan: ch, down: 700, ok: false });
  eq("小响应立刻判该通道被拒", W.Prefs.chan("9.9.9.7", "x.com"), 2);
  eq("别的站点不受牵连", W.Prefs.chan("9.9.9.7", "y.com"), 1);
  W.recordPass({ target: "x.com", chan: ch, down: 40000, ok: true });
  eq("大响应回来就解除", W.Prefs.chan("9.9.9.7", "x.com"), 0);
  W.VT.clear();
  const ch2 = { kind: "r", ip: "9.9.9.8" };
  W.VT.set("x.com", "r:9.9.9.8", 200, 40, 1);
  W.recordBlock({ target: "x.com", chan: ch2, down: 700, ok: false });
  eq("probe 确认过能通的通道不被小响应当掉", W.Prefs.chan("9.9.9.8", "x.com"), 0);
  W.VT.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case036({ W, ok }) {
  const rndBak = Math.random;
  const c53 = { host: "x.com", cfHost: true, clientV6: false, relays: ["9.9.9.1", "9.9.9.2"], legacyWantsRelay: true };
  W.VT.clear();
  W.VT.setState("x.com", "r:9.9.9.1", 2, 1);
  Math.random = () => 0.01; // 命中 5% 复检
  const d1 = W.POLICY.decide(c53);
  ok("被判死的通道会被 5% 概率复检", d1.why === "explore" && d1.chan.ip === "9.9.9.1", d1.why);
  Math.random = () => 0.9; // 不命中
  const d2 = W.POLICY.decide(c53);
  ok("不在复检时仍避开被判死的通道", d2.why !== "explore" && d2.chan.ip === "9.9.9.2", d2.why);
  // 复检成功后应恢复正常（探测级 ok）
  W.VT.setState("x.com", "r:9.9.9.1", 1, 1);
  const d3 = W.POLICY.decide(c53);
  ok("复检成功即解除封禁", W.VT.state("x.com", "r:9.9.9.1") === 1 && d3.why !== "explore", d3.why);
  // 成功只代表「当时能通」：再次出现差分证据应能重新判死（否则一旦通过就再也不学）
  W.VT.clear(); // 换一个干净场景：只有流量级的弱 ok
  W.VT.setState("x.com", "r:9.9.9.1", 1, 0); // 流量级 ok（弱证据）
  W.VT.setState("x.com", "r:9.9.9.2", 1, 1);
  W.recordBlock({ target: "x.com", chan: { kind: "r", ip: "9.9.9.1" }, down: 800, ok: false });
  ok("流量级的 ok 可被差分证据推翻", W.VT.state("x.com", "r:9.9.9.1") === 2, String(W.VT.state("x.com", "r:9.9.9.1")));
  Math.random = rndBak;
  W.VT.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case037({ W, ok }) {
  W.VT.clear();
  const relays = ["7.7.7.1", "7.7.7.2", "7.7.7.3", "7.7.7.4"];
  for (const ip of relays) W.VT.setState("x.com", "r:" + ip, 2, 1);
  const d = W.POLICY.decide({ host: "x.com", cfHost: true, clientV6: false, relays, legacyWantsRelay: true });
  ok("整池判死时仍有可用通道", d.chan.kind !== "d" && relays.includes(d.chan.ip), d.why);
  ok("只保留最近两条判死，其余被解除", relays.filter((ip) => W.VT.state("x.com", "r:" + ip) === 2).length <= 2, relays.map((ip) => W.VT.state("x.com", "r:" + ip)).join(","));
  W.VT.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case046({ W, eq, ok }) {
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
  W.VT.set("ack.example.com", "r:203.0.113.7", 403, 120);
  W.VT.setState("ack.example.com", "r:203.0.113.7", 2, 1);
  const vd1 = W.vtDelta().filter((x) => x.k.includes("ack.example.com"));
  ok("强证据进入增量", vd1.length === 1, String(vd1.length));
  const vd2 = W.vtDelta().filter((x) => x.k.includes("ack.example.com"));
  eq("未 ack 前重复调用仍在增量里", String(vd2.length), "1");
  W.vtAck();
  eq("vtAck 之后不再重复上报", String(W.vtDelta().filter((x) => x.k.includes("ack.example.com")).length), "0");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case049({ W, eq }) {
  const ev = (o) => ({ host: "shop.example.com", cf: true, ok: true, down: 0, up: 0, life: 100, via: "node", node: "198.51.100.9:443", ...o });
  W.VT.clear();
  W.JUDGE.onTraffic(ev({ host: "api.example.com", down: 265 }));
  eq("业务 403 不写站点级封锁", W.VT.bad("api.example.com", "r:198.51.100.9"), false);
  eq("业务 403 不写通配封锁", W.VT.bad("*", "r:198.51.100.9"), false);
  W.JUDGE.onTraffic(ev({ host: "www.example.com", down: 30000, node: "203.0.113.7:443" }));
  W.JUDGE.onTraffic(ev({ host: "www.example.com", down: 260, node: "198.51.100.9:443" }));
  eq("差分成立也只做软降权（不写通配）", W.VT.bad("*", "r:198.51.100.9"), false);
  eq("差分成立时软降权生效", W.JUDGE.negOn("www.example.com", "198.51.100.9"), true);
  eq("软降权 10 分钟后失效", W.JUDGE.negOn("www.example.com", "198.51.100.9", Date.now() + 601000), false);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case050({ W, eq }) {
  const host = "shop.example.com";
  const a = "198.51.100.11";
  const b = "198.51.100.12";
  const t0 = Date.now();
  W.VT.clear();
  W.JUDGE.markPos(host, b, t0);
  eq("正记忆写入后命中", W.JUDGE.posOn(host, b, t0 + 1000), true);
  eq("正记忆 10 分钟后失效", W.JUDGE.posOn(host, b, t0 + 601000), false);
  W.JUDGE.markPos(host, b, Date.now());
  // 故意让「另一条」的证据更新：只按证据时间排序会选 a，只有正记忆能把 b 顶到队首
  W.VT.setState(host, "r:" + b, 1, 1);
  W.VT.setState(host, "r:" + a, 1, 1);
  const ctx = { host, cfHost: true, clientV6: false, relays: [a, b], legacyWantsRelay: true };
  eq("站点级选择优先正记忆中继", W.POLICY.decide(ctx).chan.ip, b);
  eq("普通目标不受正记忆影响", W.POLICY.decide({ ...ctx, cfHost: false }).chan.kind, "d");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case051({ W, eq }) {
  W.RELPERF.clear();
  W.relNote("a.example.com", "203.0.113.7", 200, 1600);
  W.relNote("a.example.com", "203.0.113.9", 400, 300);
  eq("快中继代价更低", W.RELPERF.cost("a.example.com", "203.0.113.7") < W.RELPERF.cost("a.example.com", "203.0.113.9"), true);
  eq("没量过的中继代价是 1e6", W.RELPERF.cost("a.example.com", "203.0.113.99"), 1e6);
  eq("样本按站点分开存", W.RELPERF.cost("b.example.com", "203.0.113.7"), 1e6);
  // 两条中继都能通时，选代价更低的那条（健康度都未知 → 由站点 × 中继决定）
  const ctxR = { host: "a.example.com", cfHost: true, clientV6: false, relays: ["203.0.113.9", "203.0.113.7"], legacyWantsRelay: true };
  eq("按站点 × 中继选更快的那条", W.POLICY.decide(ctxR).chan.ip, "203.0.113.7");
  eq("调试快照按代价升序", W.RELPERF.snap("a.example.com")[0].relayIp, "203.0.113.7");
  W.RELPERF.clear();
  eq("清空后代价回到未知", W.RELPERF.cost("a.example.com", "203.0.113.7"), 1e6);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case052({ W, eq }) {
  W.RELPERF.clear();
  // 甲：首字节 150ms、只有 100 KB/s；乙：首字节 400ms、2500 KB/s
  W.relNote("c.example.com", "203.0.113.11", 150, 100);
  W.relNote("c.example.com", "203.0.113.12", 400, 2500);
  eq("delay 模式选首字节更快的那条", W.POLICY.decide({ host: "c.example.com", cfHost: true, clientV6: false, relays: ["203.0.113.12", "203.0.113.11"], legacyWantsRelay: true, mode: "lat" }).chan.ip, "203.0.113.11");
  eq("tput 模式选拉 1MB 更快的那条", W.POLICY.decide({ host: "c.example.com", cfHost: true, clientV6: false, relays: ["203.0.113.11", "203.0.113.12"], legacyWantsRelay: true, mode: "tput" }).chan.ip, "203.0.113.12");
  // 新站点没量过这条中继时，用它在别处学到的容量兜底（+200ms 罚），不该退回 1e6 重学一遍
  eq("新站点沿用跨站点学到的中继容量", W.RELPERF.costFor("tput", "d.example.com", "203.0.113.12") < 1e6, true);
  eq("本站点亲测比跨站点兜底更便宜", W.RELPERF.costFor("tput", "c.example.com", "203.0.113.12") < W.RELPERF.costFor("tput", "d.example.com", "203.0.113.12"), true);
  // 小响应（4 字节 403 页 / 只量到首字节）不能被当成「小带宽」重罚：
  // 否则 45KB 的正常首页（2.5 秒 = 18KB/s）会比 403 页（4 字节 = 46KB/s）更贵，排序反向。
  W.relNote("h.example.com", "203.0.113.30", 80, 0);
  W.relNote("h.example.com", "203.0.113.32", 300, 100);
  eq("没量到吞吐的样本按首字节+固定罚计", Math.round(W.RELPERF.costFor("tput", "h.example.com", "203.0.113.30")), 2080);
  eq("没量到吞吐的样本比实测很慢的中继更便宜", W.RELPERF.costFor("tput", "h.example.com", "203.0.113.30") < W.RELPERF.costFor("tput", "h.example.com", "203.0.113.32"), true);
  W.RELPERF.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case053({ W, eq }) {
  W.RELPERF.clear();
  const relays = ["203.0.113.21", "203.0.113.22", "203.0.113.23"];
  // 先量过其中一条：轮换只在「有锚样本」之后做，避免冷站点一上来就试坏机器
  W.relNote("g.example.com", "203.0.113.21", 200, 1000);
  const picked = [];
  for (let i = 0; i < 2; i++) {
    const d = W.POLICY.decide({ host: "g.example.com", cfHost: true, clientV6: false, relays, legacyWantsRelay: true, mode: "tput" });
    picked.push(d.chan.ip);
    eq("吞吐模式给未量过的中继采样机会（why）", d.why, "rel-rot");
  }
  eq("轮换不会重复落在已量过的那条上", picked.every((ip) => ip !== "203.0.113.21"), true);
  eq("两条未量过的中继各被轮到一次", new Set(picked).size, 2);
  W.RELPERF.clear();
  // 延迟模式仍按老办法钉住：首字节场景下「先量三条」的代价比吞吐模式高
  const dl = W.POLICY.decide({ host: "f.example.com", cfHost: true, clientV6: false, relays, legacyWantsRelay: true, mode: "lat" });
  eq("延迟模式不轮换", dl.why, "cold-pin");
  W.RELPERF.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case054({ W, eq, ok }) {
  const T = new W.EgFacts();
  const t0 = 1750000000000;
  T.note("203.0.113.7", 4, t0);
  eq("记下 v4 出口", T.famOf("203.0.113.7", t0 + 1000), 4);
  eq("v4 出口的代价乘数是 0.95（只做同分打破）", T.bias("203.0.113.7", false, t0 + 1000), 0.95);
  T.note("2001:db8::1", 6, t0);
  eq("v6 出口的代价乘数是 1.05", T.bias("2001:db8::1", false, t0 + 1000), 1.05);
  eq("没观测过的中继不做偏置", T.bias("198.51.100.9", false, t0 + 1000), 1);
  // 冷 isolate：W.NODE_MEMORY.alive 还没探出来（relays 为空）时，用事实里的 v4 出口兜底，而不是直连
  W.EG.clear();
  W.EG.note("203.0.113.7", 4, Date.now());
  const pin = W.POLICY.decide({ host: "x.example.com", cfHost: true, clientV6: false, relays: [], legacyWantsRelay: true });
  eq("冷启动无存活中继时用 eg 里的 v4 出口", pin.why, "eg-pin");
  eq("冷启动兜底选的是那条 v4", pin.chan.ip, "203.0.113.7");
  W.EG.clear();
  const none = W.POLICY.decide({ host: "x.example.com", cfHost: true, clientV6: false, relays: [], legacyWantsRelay: true });
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
  eq("没有样本时 ps 因子为 1", W.PS.factor("neg.example.com", "198.51.100.7"), 1);
  W.PS.note("neg.example.com", "198.51.100.7", false, Date.now());
  ok("一次失败就让 ps 变贵（>1）", W.PS.factor("neg.example.com", "198.51.100.7") > 1);
  W.PS.note("neg.example.com", "198.51.100.7", true, Date.now());
  W.PS.note("neg.example.com", "198.51.100.7", true, Date.now());
  ok("连续成功把 ps 拉回（< 3）", W.PS.factor("neg.example.com", "198.51.100.7") < 3);
  // eg-pin 不能挑一条刚判死的中继
  W.EG.clear(); W.DEAD.clear();
  // 客户端 v6 + CF 站点：只要本站点有新鲜的直连成功证据，仍然选直连（族不传递）
  W.VT.setState("v6c.example.com", "d", 1, 1);
  eq("v6 客户端 + CF 站点有直连证据 → direct-ok", W.POLICY.decide({ host: "v6c.example.com", cfHost: true, clientV6: true, relays: ["203.0.113.21"], legacyWantsRelay: true }).why, "direct-ok");
  W.VT.clear();
  W.EG.note("198.51.100.8", 4, Date.now());
  W.DEAD.note("198.51.100.8", false, Date.now());
  W.DEAD.note("198.51.100.8", false, Date.now());
  eq("eg-pin 跳过已判死的 v4 出口（无存活中继时退直连）", W.POLICY.decide({ host: "dead.example.com", cfHost: true, clientV6: false, relays: [], legacyWantsRelay: true }).why, "direct");
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
  const egPick = W.POLICY.decide({ host: "eg.example", cfHost: true, clientV6: false, relays: ["203.0.113.9", "203.0.113.11"], legacyWantsRelay: true });
  eq("实测代价相同时优先 v4 出口", egPick.chan && egPick.chan.ip, "203.0.113.11");
  W.EG.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case055({ W, eq }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case057({ W, eq }) {
  W.FACT.clear();
  W.SHADOW_TABLE.peers.clear();
  W.SHADOW_TABLE.bigTypical.clear();
  const H = "cmp.example";
  const ev = (x) => ({ host: H, via: "node", node: "45.136.117.194:443", down: 0, ok: true, life: 900, up: 0, ...x });
  const A = "45.136.117.194:443";
  const B = "91.215.153.143:443";
  const t0 = 1_700_000_000_000;
  eq("整页先入对照环形 → 本会写 ps", W.FACT.observe(ev({ node: A, down: 45290, ok: true }), t0), "ok");
  eq("另一条中继的 tiny + 有整页对照 → B 级证据", W.FACT.observe(ev({ node: B, down: 737, ok: false, life: 80 }), t0 + 1000), "R_TINY_PEER");
  eq("同一中继 ≥60s 后再来仍是 B 级（不写事实）", W.FACT.observe(ev({ node: B, down: 737, ok: false, life: 80 }), t0 + 70000), "R_TINY_PEER");
  eq("本会写封锁的仍然是 0 条（封锁只由 BLK.note 三批投票写）", W.FACT.snap().would.blk || 0, 0);
  eq("bigTypical 取见过的最大响应", W.SHADOW_TABLE.bigTypical.get(H), 45290);
  eq("737B 对 45KB 的典型页算 tiny", W.isTiny({ kind: "relay", host: H, relay: "1.2.3.4", at: t0, down: 737, status: 403 }, 45290), true);
  eq("1277B 对自身同尺寸的典型页不算 tiny", W.isTiny({ kind: "relay", host: H, relay: "1.2.3.4", at: t0, down: 1277, status: 415 }, 1277), false);
  const C = "contra.example";
  W.FACT.clear();
  W.SHADOW_TABLE.peers.clear();
  W.SHADOW_TABLE.bigTypical.clear();
  W.JUDGE.memory.bigByHost.set(C, t0);
  const cev = (x) => ({ host: C, via: "node", node: A, down: 0, ok: true, life: 900, up: 0, ...x });
  eq("先喂一条整页当对照", W.FACT.observe(cev({ node: B, down: 30000, ok: true }), t0), "ok");
  eq("同通道 tiny + 有对照 → B 级证据", W.FACT.observe(cev({ down: 737, ok: false }), t0 + 1000), "R_TINY_PEER");
  eq("同通道 3 分钟内出过整页：commitFact 仍只给 B 级，反向证据由 BLK.note 判", W.FACT.observe(cev({ down: 737, ok: false }), t0 + 62000), "R_TINY_PEER");
  W.FACT.clear();
  W.SHADOW_TABLE.peers.clear();
  W.SHADOW_TABLE.bigTypical.clear();
  W.JUDGE.memory.bigByHost.delete(C);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case058({ W, eq }) {
  const H = "ps.example";
  // 用真实时间：ps 表的读取按 Date.now() 判过期，注入过去的固定时间戳会让行立刻过期
  const t0 = Date.now();
  W.PS.clear();
  eq("没有样本时因子恒为 1", W.PS.factor(H, "203.0.113.9", t0), 1);
  eq("没有样本时 pOf 是 NaN", Number.isNaN(W.PS.pOf(H, "203.0.113.9", t0)), true);
  W.PS.note(H, "203.0.113.9", false, t0);
  W.PS.note(H, "203.0.113.9", false, t0 + 1000);
  eq("两次失败后变贵（因子 > 1）", W.PS.factor(H, "203.0.113.9", t0 + 1000) > 1, true);
  W.PS.note(H, "203.0.113.7", true, t0);
  W.PS.note(H, "203.0.113.7", true, t0 + 1000);
  eq("两次成功后变便宜（因子 < 1）", W.PS.factor(H, "203.0.113.7", t0 + 1000) < 1, true);
  eq("按站点分开：别的站点没有样本", W.PS.factor("other.example", "203.0.113.9", t0 + 1000), 1);
  eq("45 分钟后当作没有样本", W.PS.factor(H, "203.0.113.9", t0 + 46 * 60000), 1);
  for (let i = 0; i < 40; i++) W.PS.note(H, "203.0.113.11", false, t0 + i * 10);
  const fw = W.PS.factor(H, "203.0.113.11", t0 + 400);
  eq("折价因子不低于 0.5", fw >= 0.5, true);
  eq("折价因子不高于 2", fw <= 2, true);
  W.PS.clear();
  eq("首次合并 1 行", W.PS.load([{ k: H + "|203.0.113.20", q: 10, n: 4, at: t0 }]), 1);
  eq("更旧的观测被忽略", W.PS.load([{ k: H + "|203.0.113.20", q: 250, n: 9, at: t0 - 5 }]), 0);
  eq("更新的观测覆盖", W.PS.load([{ k: H + "|203.0.113.20", q: 250, n: 9, at: t0 + 5 }]), 1);
  W.PS.clear();
  W.PS.note(H, "203.0.113.30", true, t0);
  eq("增量里有 1 行", W.PS.delta().length, 1);
  W.PS.ack();
  eq("ack 后增量清空", W.PS.delta().length, 0);
  W.PS.nack();
  eq("nack 不会清掉已经记下的事实", Number.isFinite(W.PS.pOf(H, "203.0.113.30", t0)), true);
  // 选路：同样的实测代价下，成功率历史更好的那条排前面（且坏的那条仍在候选里）
  W.PS.clear();
  W.relNote(H, "203.0.113.5", 100, 0, t0);
  W.relNote(H, "203.0.113.6", 100, 0, t0);
  W.PS.note(H, "203.0.113.5", true, t0);
  W.PS.note(H, "203.0.113.5", true, t0 + 1);
  W.PS.note(H, "203.0.113.6", false, t0);
  W.PS.note(H, "203.0.113.6", false, t0 + 1);
  const d = W.POLICY.decide({ host: H, cfHost: true, clientV6: false, relays: ["203.0.113.6", "203.0.113.5"], legacyWantsRelay: true, mode: "tput" });
  eq("按站点的成功率历史选更靠前的那条", d.chan.ip, "203.0.113.5");
  const d2 = W.POLICY.decide({ host: H, cfHost: true, clientV6: false, relays: ["203.0.113.11"], legacyWantsRelay: true, mode: "tput" });
  eq("历史很差的通道仍然是候选（只折价不剔除）", d2.chan.ip, "203.0.113.11");
  W.PS.clear();
  W.SHADOW_TABLE.peers.clear();
  W.SHADOW_TABLE.bigTypical.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case059({ W, eq }) {
  const now = Date.now();
  W.DEAD.clear();
  eq("一次失败不算死", W.DEAD.isDead("203.0.113.61", now), false);
  W.DEAD.note("203.0.113.61", false, now);
  eq("一次失败后仍不算死", W.DEAD.isDead("203.0.113.61", now), false);
  W.DEAD.note("203.0.113.61", false, now + 1000);
  eq("连续两次失败 → 判死", W.DEAD.isDead("203.0.113.61", now + 1000), true);
  eq("30 分钟后再给机会", W.DEAD.isDead("203.0.113.61", now + 31 * 60000), false);
  W.DEAD.note("203.0.113.62", false, now);
  W.DEAD.note("203.0.113.62", false, now + 1000);
  W.DEAD.note("203.0.113.62", true, now + 2000);
  eq("连上一次就复活（清零）", W.DEAD.isDead("203.0.113.62", now + 2000), false);
  W.DEAD.clear();
  eq("合并只收判死行（n<2 被丢）", W.DEAD.load([{ i: "203.0.113.63", n: 1, at: now }]), 1);
  eq("合并后仍不算死（n=1）", W.DEAD.isDead("203.0.113.63", now), false);
  eq("更新的判死行会覆盖", W.DEAD.load([{ i: "203.0.113.63", n: 2, at: now + 5 }]), 1);
  eq("合并后判死", W.DEAD.isDead("203.0.113.63", now + 5), true);
  eq("更旧的行被忽略", W.DEAD.load([{ i: "203.0.113.63", n: 9, at: now }]), 0);
  W.DEAD.clear();
  W.DEAD.note("203.0.113.64", false, now);
  eq("增量里有 1 行", W.DEAD.delta().length, 1);
  W.DEAD.ack();
  eq("ack 后增量清空", W.DEAD.delta().length, 0);
  // 选路：判死的中继挪到队尾，但全池判死时仍要选出东西
  const H = "dead.example";
  W.DEAD.clear();
  W.PS.clear();
  W.relNote(H, "203.0.113.71", 200, 0, now);
  W.relNote(H, "203.0.113.72", 200, 0, now);
  const d1 = W.POLICY.decide({ host: H, cfHost: true, clientV6: false, relays: ["203.0.113.72", "203.0.113.71"], legacyWantsRelay: true, mode: "tput" });
  eq("两条都健康时按排序取第一条", d1.chan.ip, "203.0.113.72");
  W.DEAD.note("203.0.113.72", false, now);
  W.DEAD.note("203.0.113.72", false, now + 1);
  const d2 = W.POLICY.decide({ host: H, cfHost: true, clientV6: false, relays: ["203.0.113.72", "203.0.113.71"], legacyWantsRelay: true, mode: "tput" });
  eq("判死的挪到队尾，换另一条", d2.chan.ip, "203.0.113.71");
  W.DEAD.note("203.0.113.71", false, now + 2);
  W.DEAD.note("203.0.113.71", false, now + 3);
  const d3 = W.POLICY.decide({ host: H, cfHost: true, clientV6: false, relays: ["203.0.113.72", "203.0.113.71"], legacyWantsRelay: true, mode: "tput" });
  eq("全池判死时仍返回候选（不返回空）", ["203.0.113.71", "203.0.113.72"].includes(d3.chan.ip), true);
  W.DEAD.clear();
  W.SHADOW_TABLE.peers.clear();
  W.SHADOW_TABLE.bigTypical.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case061({ W, eq }) {
  const t0 = Date.now();
  W.BLK.clear();
  const feed = (host, ip, base) => { for (let b = 0; b < 3; b += 1) for (let k = 0; k < 3; k += 1) W.BLK.note({ host, ip, down: 737, peerBig: true, at: base + b * 61000 + k * 1000 }); };
  eq("默认代价倍数是 1", W.BLK.penOf("x.example", "203.0.113.81", t0), 1);
  eq("没有整页对照时不投票", W.BLK.note({ host: "x.example", ip: "203.0.113.81", down: 737, peerBig: false, at: t0 }), false);
  eq("无对照仍不算封锁", W.BLK.penOf("x.example", "203.0.113.81", t0), 1);
  // 一批只喂 2 次：这一批作废，不足以确认
  for (let k = 0; k < 2; k += 1) W.BLK.note({ host: "x.example", ip: "203.0.113.81", down: 737, peerBig: true, at: t0 + k * 1000 });
  W.BLK.note({ host: "x.example", ip: "203.0.113.81", down: 737, peerBig: true, at: t0 + 61000 });
  eq("每批不足 3 次不算票", W.BLK.penOf("x.example", "203.0.113.81", t0 + 61000), 1);
  W.BLK.clear();
  feed("x.example", "203.0.113.81", t0);
  eq("三批 × 每批 3 次后代价 ×6", W.BLK.penOf("x.example", "203.0.113.81", t0 + 122000), W.BLK_PEN);
  eq("换个站点不受影响", W.BLK.penOf("y.example", "203.0.113.81", t0 + 122000), 1);
  eq("换个出口不受影响", W.BLK.penOf("x.example", "203.0.113.82", t0 + 122000), 1);
  eq("90 分钟后自动恢复", W.BLK.penOf("x.example", "203.0.113.81", t0 + 122000 + 91 * 60000), 1);
  // 反向证据：同通道刚出过整页就清零进度
  W.BLK.clear();
  feed("z.example", "203.0.113.83", t0);
  W.BLK.contra("z.example", "203.0.113.83");
  eq("反向证据清掉了已确认的行", W.BLK.penOf("z.example", "203.0.113.83", t0 + 122000), 1);
  // 站点级自愈 + 静默
  W.BLK.clear();
  const cands = ["203.0.113.91", "203.0.113.92"];
  for (const ip of cands) feed("s.example", ip, t0);
  eq("两条候选都被判封锁", [W.BLK.penOf("s.example", cands[0], t0 + 122000), W.BLK.penOf("s.example", cands[1], t0 + 122000)], [W.BLK_PEN, W.BLK_PEN]);
  eq("整池被写满触发自愈", W.BLK.sweep("s.example", cands, t0 + 130000), true);
  eq("自愈后代价回到 1", W.BLK.penOf("s.example", cands[0], t0 + 130000), 1);
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
  const d1 = W.POLICY.decide({ host: H2, cfHost: true, clientV6: false, relays: ["203.0.113.94", "203.0.113.95"], legacyWantsRelay: true, mode: "tput" });
  eq("被判封锁的那条排到后面（原本它最快）", d1.chan.ip, "203.0.113.94");
  const d2 = W.POLICY.decide({ host: H2, cfHost: true, clientV6: false, relays: ["203.0.113.95"], legacyWantsRelay: true, mode: "tput" });
  eq("只剩被判封锁的一条时仍然用它（永不剔候选）", d2.chan.ip, "203.0.113.95");
  W.BLK.clear();
  W.SHADOW_TABLE.peers.clear();
  W.SHADOW_TABLE.bigTypical.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case063({ W, eq }) {
  W.PS.clear();
  W.RELPERF.clear();
  const host = "rehab.example.com";
  const A = "203.0.113.31", B = "203.0.113.32", C = "203.0.113.33";
  // B 历史上有过整页（成功率 1.0），但现在被排到最后（代价极高）
  for (let i = 0; i < 6; i++) W.PS.note(host, B, true);
  W.relNote(host, A, 200, 2000);
  W.relNote(host, C, 220, 1900);
  W.relNote(host, B, 9000, 20);
  eq("历史成功率能读到", W.PS.okOf(host, B) > 0.9, true);
  eq("没样本返回 -1", W.PS.okOf(host, A), -1);
  const C2 = { host, cfHost: true, clientV6: false, relays: [A, B, C], legacyWantsRelay: true, mode: "tput" };
  let last = null;
  let hit = null;
  for (let i = 1; i <= 40; i++) {
    const d = W.POLICY.decide(C2);
    if (d.why === "rehab") { if (!hit) hit = { i, ip: d.chan.ip }; }
    last = d;
  }
  eq("第 20 条触发康复", hit && hit.i, 20);
  eq("康复选的是历史成过的那条", hit && hit.ip, B);
  eq("第 40 条也触发", last.why, "rehab");
  eq("康复不会永远抢第一（前 19 条不是 rehab）", hit && hit.i > 1, true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case064({ W, eq }) {
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
  eq("中继腿拿到整页 → 写入 ps", W.PS.okOf(host, ip) > 0.6, true);
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
  eq("直连腿不写站点×中继成功率", W.PS.okOf(host, "d"), -1);
  eq("两个事件各裁决一次（cfObs +2）", (W.cntView().cfObs || 0) - obs0, 2);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case065({ W, eq }) {
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
  eq("负样本真的进了 ps（不是只记了计数）", W.PS.okOf(host, "198.51.100.21") < 0.6, true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case067({ W, eq }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case073({ W, eq }) {
  const H = "gate.example.com";
  const IP = "203.0.113.77";
  W.FactsStore.clear();
  eq("清空后没有增量", Object.keys(W.FactsStore.delta()).length, 0);
  W.PS.note(H, IP, true);
  W.EG.note(IP, 4);
  W.DEAD.note("203.0.113.78", false);
  W.DEAD.note("203.0.113.78", false);
  const d1 = W.FactsStore.delta();
  eq("增量里 ps 有 1 行", (d1.ps || []).length, 1);
  eq("增量里 eg 有 1 行", (d1.eg || []).length, 1);
  eq("增量里 dead 有 1 行（连续两次失败）", (d1.dead || []).length, 1);
  W.DNS.note(H, false, Date.now());
  eq("增量里 dns 有 1 行", (W.FactsStore.delta().dns || []).length, 1);
  eq("未 ack 前再取仍然是同一批", (W.FactsStore.delta().ps || []).length, 1);
  W.FactsStore.ack();
  eq("ack 后增量清空", (W.FactsStore.delta().ps || []).length, 0);
  eq("ack 后 dns 增量也清空（门面必须点名五张表）", (W.FactsStore.delta().dns || []).length, 0);
  eq("快照里有 dns 一类", W.FactsStore.snap().dns !== undefined, true);
  W.FactsStore.clear();
  const n = W.FactsStore.load({ eg: [{ i: "203.0.113.9", f: 4, at: Date.now() }], ps: [{ k: H + "|203.0.113.9", q: 128, n: 8, at: Date.now() }], dead: [{ i: "203.0.113.10", n: 3, at: Date.now() }], blk2: [{ k: H + "|203.0.113.9", n: 3, at: Date.now() }] });
  eq("load 四类都并入", [n.eg, n.ps, n.dead, n.blk2].join(","), "1,1,1,1");
  eq("并入后 ps 能查到", W.PS.factor(H, "203.0.113.9") > 1, true);
  W.FactsStore.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case078({ W, eq }) {
  W.PS.clear();
  W.DNS.clear();
  const rh = "hist.example.com";
  const rip = "198.51.100.9";
  eq("没样本时 psBest 返回 -1", W.PS.bestOf(rh, rip), -1);
  W.PS.note(rh, rip, true, Date.now());
  eq("成过一次 → 历史最好是 100%", W.PS.bestOf(rh, rip) > 0.99, true);
  for (let i = 0; i < 6; i++) W.PS.note(rh, rip, false, Date.now());
  eq("连败之后当前均值掉到 0.6 以下", W.PS.okOf(rh, rip) < 0.6, true);
  // 本轮核心：康复通道给的是「再试一次」的机会，闸门必须问「曾经行过吗」，
  // 不是「现在还好吗」—— 后者恰恰是被降权那批通道最不可能满足的条件。
  eq("但历史最好仍是 100%（康复通道还认它）", W.PS.bestOf(rh, rip) > 0.99, true);
  // 7.143 起 sent 又回来了，但这次它**有读端**：ack() 靠它只清这一批真正发出去的行
  // （delta 有上限，一次清空整个 pending 会把超限的行丢掉）。这里锁住「发完即清」这个不变量。
  W.PS.clear();
  W.PS.note("sent.example", "203.0.113.90", true, Date.now());
  // 待发队列拆成 PsOutbox 之后（7.289），`PS.sent` 这张内部表不再对外：锁改成可观察语义 ——
  // 交出去的那条在 ack 之后不会重发；没交出去的行照样留着（重发即重试）。
  const sent1 = W.PS.delta();
  eq("delta 交出的行里含刚记的那条", sent1.some((r) => r.k.startsWith("sent.example")), true);
  W.PS.ack();
  eq("ack 之后同一行不再重发（待发已清）", W.PS.delta().some((r) => r.k.startsWith("sent.example")), false);
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case079({ W, eq }) {
  W.FactsStore.clear();
  eq("门面登记了全部五张表（新增一类必须登记，否则 interface 报错）", W.FactsStore.kinds().join(","), "eg,ps,dead,blk2,dns");
  eq("快照按同一份登记表生成", Object.keys(W.FactsStore.snap()).length, 5);
  // 站点名来自客户端请求、不是有限集合：两张按站点的表必须被压回上限
  W.POLICY.trim(0);
  for (let i = 0; i < 600; i++) {
    W.POLICY.decide({ host: `h${i}.cap.example.com`, cfHost: false, clientV6: false, relays: [], legacyWantsRelay: false });
  }
  eq("决策序号表有上限（站点名不是有限集合）", W.POLICY.seqSize() <= 512, true);
  eq("冷启动钉住表有上限", W.POLICY.pinSize() <= 512, true);
  // 过期钉住会被清掉：先钉一条，再把时间推到 61 秒后
  W.POLICY.decide({ host: "pin.example.com", cfHost: true, clientV6: false, relays: ["198.51.100.44"], legacyWantsRelay: false });
  const pinBefore = W.POLICY.pinSize();
  eq("冷启动确实钉住了一条（否则下面的过期断言是空断言）", pinBefore >= 1, true);
  W.POLICY.trim(Date.now() + 61_000);
  eq("过期钉住被清掉（trim 传未来时间）", W.POLICY.pinSize(), 0);
  W.FactsStore.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case082({ W, eq }) {
  W.FactsStore.clear();
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
  W.FactsStore.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case083({ W, eq }) {
  const H = "sweep.example";
  W.FactsStore.clear();
  const rel = [
    "203.0.113.101", "203.0.113.102", "203.0.113.103", "203.0.113.104",
    "203.0.113.105", "203.0.113.106", "203.0.113.107", "203.0.113.108",
  ];
  const t0 = Date.now();
  // 六条中继各有一条已确认的封锁行（等效于三批投票的结果，这里按上报格式直接灌表）
  W.BLK.load(rel.slice(0, 6).map((ip) => ({ k: H + "|" + ip, n: 3, at: t0 })));
  // 同一批中继在判定表里也已是「封锁」⇒ 它们从 usable 里消失，正是旧口径的病根
  for (const ip of rel.slice(0, 6)) W.VT.setState(H, "r:" + ip, 2, 1);
  W.POLICY.decide({ host: H, cfHost: false, clientV6: false, relays: rel, legacyWantsRelay: false });
  eq("整池 75% 有封锁行 ⇒ 触发站点级自愈", W.BLK.muted(H), true);
  eq("自愈把封锁行清掉：代价倍数回到 1", W.BLK.penOf(H, rel[0]), 1);
  // 反例：5/8 = 62.5% 不到 75%，不该自愈
  const H2 = "sweep2.example";
  W.BLK.load(rel.slice(0, 5).map((ip) => ({ k: H2 + "|" + ip, n: 3, at: t0 })));
  for (const ip of rel.slice(0, 5)) W.VT.setState(H2, "r:" + ip, 2, 1);
  W.POLICY.decide({ host: H2, cfHost: false, clientV6: false, relays: rel, legacyWantsRelay: false });
  eq("只到 5/8 不触发自愈", W.BLK.muted(H2), false);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case088({ W, eq }) {
  const g = "113";
  const H = "sweep3.example";
  W.FactsStore.clear();
  const rel = ["203.0.113.111", "203.0.113.112", "203.0.113.113", "203.0.113.114", "203.0.113.115", "203.0.113.116", "203.0.113.117", "203.0.113.118"];
  const t0 = Date.now();
  W.BLK.load(rel.slice(0, 6).map((ip) => ({ k: H + "|" + ip, n: 3, at: t0 })));
  for (const ip of rel.slice(0, 6)) W.VT.setState(H, "r:" + ip, 2, 1);
  // 把随机数钉成 0，强制走「探索」那条早返回（Math.random() < 0.05 必然成立）
  const rnd = Math.random;
  Math.random = () => 0;
  let ch;
  try {
    ch = W.POLICY.decide({ host: H, cfHost: false, clientV6: false, relays: rel, legacyWantsRelay: false });
  } finally {
    Math.random = rnd;
  }
  eq(`[${g}] 早返回走的是 5% 复检`, ch.why, "explore");
  eq(`[${g}] 复检早返回时自愈仍然做了`, W.BLK.muted(H), true);
  eq(`[${g}] 自愈清掉了封锁行`, W.BLK.penOf(H, rel[0]), 1);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case095({ W, ok }) {
  const T = "d.test", IP = "r:9.9.9.9";
  W.VT.clear();
  W.VT_SYNC.pending.clear();
  W.VT_SYNC.sent.clear();
  // state=3 是 dead（硬排除），比 blocked 更强：重试时必须原样带出去
  W.VT.setState(T, IP, 3, 1);
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
  ok("ack 之后这条已经登记成「已上报」", (W.VT_SYNC.sent.get(T + "|" + IP) || 0) > Date.now());
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case096({ W, ok }) {
  // 每批严格 ≤60 行：以前上限判断写在 push 之后，pending 满 60 时会返回 61 行
  W.VT.clear();
  W.VT_SYNC.pending.clear();
  W.VT_SYNC.sent.clear();
  for (let i = 0; i < 100; i++) W.VT.setState("cap" + i + ".test", "r:198.51.100.7", 2, 1);
  ok("一批最多 60 行判定证据", W.vtDelta().length === 60);
  ok("pending 已满时再要一批也不会多出一行", W.vtDelta().length === 60);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case122({ W, eq, ok, storeSrc, debugAll }) {
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
  ok("诊断默认分支的建连接去拨号器", dbgSrc177.includes("SOCKET_DIALER.open(expandV6(out.aaaa), 443, gate)"), "debug.ts");
  ok("诊断默认分支不再自己包 connect", !dbgSrc177.includes("Promise.resolve(connect("), "debug.ts");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case123({ storeSrc, ok, debugAll, policyAll, eq, W }) {
  const mS = storeSrc();
  ok("计量表里不再有旧封锁表字段", !/this\.blk\b/.test(mS), "meter.ts");
  ok("计量表不再提供 /blk 端点", mS.indexOf('endsWith("/blk")') < 0, "meter.ts");
  ok("七张事实表的出站仍走 factsOut", mS.indexOf("Response.json(factsOut(this.ledger))") >= 0, "meter.ts");
  const dS = debugAll();
  ok("诊断的跨 isolate 封锁改读 /vt 的 blk2", dS.indexOf('doFetch(env, id, "https://meter/vt")') >= 0 && dS.indexOf("jj.blk2") >= 0, "debug.ts");
  ok("诊断用 blk2 的 at 与 BLK_TTL 算剩余寿命", dS.indexOf("r.at + BLK_TTL - now2") >= 0, "debug.ts");
  const pS = policyAll();
  eq("决策里同一张实测表只扫一遍", pS.split("RELPERF.snap(c.host)").length - 1, 1);
  ok("冷启动闸门复用同一个计数", pS.indexOf("fresh === 0") >= 0, "policy.ts");
  // 行为面：量过的那条照旧进表，样本数只累加不重置
  W.RELPERF.clear();
  W.RELPERF.note("rel188.example", "203.0.113.21", 300, 900);
  eq("量过的那条被记进站点 × 中继表", W.RELPERF.snap("rel188.example").length, 1);
  W.RELPERF.note("rel188.example", "203.0.113.21", 320, 950);
  eq("样本数照样累加（只增不重置）", W.RELPERF.snap("rel188.example")[0].samples, 2);
  W.RELPERF.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case165({ W, eq, ok }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case202({ fs, ok, W, eq }) {
  const fsx = fs;
  const ctxSrc = fsx.readFileSync("src/route/policy-wiring.ts", "utf8");
  const wireSrc = fsx.readFileSync("src/route/policy-wiring.ts", "utf8");
  const polSrc285 = fsx.readFileSync("src/route/policy.ts", "utf8");
  // 7.299 起 Ctx/Choice 这两个端口类型住在装配层（策略单向依赖它，反向会成环）；
  // 两个常量仍留在策略本体里。
  ok("端口类型住在装配层", ctxSrc.includes("export interface Ctx") && ctxSrc.includes("export interface Choice"));
  ok("常量仍在策略本体", polSrc285.includes("export const FULL_ON") && polSrc285.includes("export const HOST_MEM_MAX"));
  ok("装配层用结构化接口收参数", wireSrc.includes("install(policy: PolicySource): void {") && wireSrc.includes("export interface PolicySource"));
  ok("装配层只注册 decide 一个槽位", (wireSrc.match(/HOOK\.[a-zA-Z]+ =/g) || []).length === 1);
  ok("装配层不含决策算法（没有 pin 表）", !wireSrc.includes("private pin") && !wireSrc.includes("HOST_MEM_MAX"));
  ok("策略本体不再自己注册 HOOK", !polSrc285.includes("HOOK.decide = ") && !polSrc285.includes("HOOK.facts = "));
  ok("策略本体通过自己的装配器接槽位", polSrc285.includes("this.wiring.install(this);"));
  ok("策略本体保留决策与三张表", polSrc285.includes("decide(c: Ctx): Choice {") && polSrc285.includes("private pin") && polSrc285.includes("private seq"));
  ok("装配器对外可见、模块级单例已撤", W.WIRING === undefined && typeof W.PolicyWiring === "function");
  // 行为面：换一个假策略装配进去，HOOK 真的会用它；再装回来还原
  const fake = { shadow: () => ({ chan: { kind: "d" }, why: "fake-why" }), relays: () => [], prefer: () => false, win: () => ({ d: false, r: false }) };
  new W.PolicyWiring().install(fake);
  const viaFake = W.HOOK.decide({ host: "x285.example", cfHost: false, clientV6: false, legacyWantsRelay: false });
  eq("装配后 HOOK.decide 用的是新策略", viaFake.why, "fake-why");
  W.POLICY.install();
  const viaReal = W.HOOK.decide({ host: "x285.example", cfHost: false, clientV6: false, legacyWantsRelay: false });
  ok("装回真策略后不再是假实现", viaReal.why !== "fake-why" && typeof viaReal.why === "string");
// 7.301：三个转发函数已删——能力本身还在（单例上的方法与只读属性），入口不再多一层。
ok("三个转发函数都已删除", [W.decide, W.shadow, W.policyOn].every((f) => f === undefined));
ok("能力改挂在策略单例上", typeof W.POLICY.decide === "function" && typeof W.POLICY.shadow === "function");
eq("策略是否生效是只读属性", W.POLICY.enabled, W.SC.POLICY > 0);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case248({ debugAll, ok, eq, W }) {
  const g = 340;
  const dbg = debugAll();
  // read 的编排段：从签名到第一个分支方法之前
  const readBody = (() => {
    const i = dbg.indexOf("async read(");
    const j = dbg.indexOf("return this.connRows(c, q);") + "return this.connRows(c, q);".length;
    return i >= 0 && j > i ? dbg.slice(i, j) : "";
  })();
  ok(
    `[${g}] read 只按固定顺序委托十一个分支`,
    [
      "this.deadRows(",
      "this.siteFacts(",
      "this.egRows(",
      "this.relayRows(",
      "this.blockRows(",
      "this.factsAll(",
      "this.planRows(",
      "this.verdictRows(",
      "this.healthRows(",
      "this.prefsRows(",
      "this.connRows(",
    ].every((x) => readBody.includes(x))
  );
  // 编排层再出现参数判断，就意味着有人又往它里面塞逻辑
  ok(`[${g}] read 自己不再读任何参数`, !readBody.includes('q.get("'));
  ok(`[${g}] read 不超过 25 行`, readBody.length > 0 && readBody.split(/\r?\n/).length <= 25);
  eq(
    `[${g}] 十一个分支各是一个方法`,
    ["deadRows", "siteFacts", "egRows", "relayRows", "blockRows", "factsAll", "planRows", "verdictRows", "healthRows", "prefsRows", "connRows"].every(
      (x) => dbg.includes("private " + x + "(") || dbg.includes("private async " + x + "(")
    ),
    true
  );
  // 分支各自读自己的参数键：漏一个就会静默落到下一个分支
  eq(
    `[${g}] 每个分支只认自己那个参数键`,
    ["\"dd\"", "\"pss\"", "\"eg\"", "\"rt\"", "\"blk\"", "\"facts\"", "\"plan\"", "\"vt\"", "\"hl\"", "\"prefs\"", "\"cl\""].every((x) => dbg.includes("q.get(" + x + ")")),
    true
  );
  ok(`[${g}] 只有两个分支可能打 DO`, dbg.split('q.get("do") === "1"').length - 1 === 2);
  ok(`[${g}] 两个 DO 分支各自吞掉读失败`, dbg.split("ring = [];").length - 1 === 2);

  // 行为：编排顺序与「没有只读参数就返回 null」是这套拆法的契约
  const env340 = { uuid: "11111111-1111-1111-1111-111111111111" };
  const tables340 = W.DEBUG.tables;
  const call340 = (qs) => tables340.read({ env: env340, id: env340.uuid }, new URL("https://dbg340.test/x" + qs));
  ok(`[${g}] 没有只读参数时返回 null（交给测量/写分支）`, (await call340("")) === null);
  ok(`[${g}] 未知参数同样返回 null`, (await call340("?nope=1")) === null);
  const dd340 = await call340("?dd=1");
  ok(`[${g}] ?dd=1 给出 rows 数组`, (await dd340.json()).rows.length >= 0);
  const pss340 = await call340("?pss=a340.example.com");
  eq(`[${g}] ?pss= 回显站点名`, (await pss340.json()).host, "a340.example.com");
  const plan340 = await call340("?plan=1");
  ok(`[${g}] ?plan=1 给出预算与计数`, Boolean((await plan340.json()).plan));
  W.BLK.clear();
  W.BLK.load([
    { k: "b340.example.com|10.7.0.1", n: 3, at: Date.now() },
    { k: "b340.example.com|10.7.0.2", n: 1, at: Date.now() },
    { k: "other340.example.com|10.7.0.3", n: 3, at: Date.now() },
  ]);
  const blk340 = await (await call340("?blk=b340.example.com")).json();
  eq(`[${g}] ?blk= 只回该站点前缀的行`, blk340.rows.length, 2);
  const hl340 = await (await call340("?hl=1")).json();
  eq(`[${g}] ?hl=1 不带 &do=1 时不打 DO`, hl340.ring.length, 0);
  ok(`[${g}] ?hl=1 仍返回本地表`, Array.isArray(hl340.local) && typeof hl340.sizes === "object");
  W.BLK.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case269({ W, ok, eq }) {
  const H363 = "reg363.test";
  const rels363 = ["10.1.0.1", "10.1.0.2", "10.1.0.3", "10.1.0.4", "10.1.0.5"];
  W.VT.clear();
  W.BLK.clear?.();
  // ① 比例兜底：5 条里判死 4 条（>3/4）、可用 1 条（<2）⇒ 只保留最近 2 条判死，其余解除。
  for (const ip of rels363.slice(0, 4)) W.VT.setState(H363, "r:" + ip, 2, 1);
  // 让第 3、4 条"最近"判死（updatedAt 更大）：setState 会刷新时间戳，按顺序后写更新。
  W.VT.setState(H363, "r:" + rels363[2], 2, 1);
  W.VT.setState(H363, "r:" + rels363[3], 2, 1);
  const eff363 = W.FactRegistry.housekeep(H363, rels363);
  ok("[363] 比例兜底返回 reset 动作", eff363.some((e) => e.kind === "verdict" && e.action === "reset"), JSON.stringify(eff363));
  const dead363 = rels363.filter((ip) => W.VT.bad(H363, "r:" + ip));
  // 只断言"留 2 条判死、放 3 条"这一语义 —— 具体留哪两条取决于 updatedAt 排序，
  // 同一毫秒内 setState 的时间戳会并列（真实请求跨毫秒不会），不测这个细节。
  eq("[363] 比例兜底只留两条判死", dead363.length, 2);
  // ② 全死自愈：只有当候选 ≤2 条时 slice(2) 空、比例兜底放不开，才轮到 clearHost。
  //    5 条全死时比例兜底会先放开 3 条（原 rankOf 也是这个顺序），不会走 clearHost。
  W.VT.clear();
  const two = rels363.slice(0, 2);
  for (const ip of two) W.VT.setState(H363, "r:" + ip, 2, 1);
  const effAllDead = W.FactRegistry.housekeep(H363, two);
  ok("[363] 两条全死返回 clearHost 动作", effAllDead.some((e) => e.kind === "verdict" && e.action === "clearHost"), JSON.stringify(effAllDead));
  eq("[363] 全死后判定表清空该站", W.VT.state(H363, "r:" + two[0]), 0);
  // ③ 常态：没有任何判死时 housekeep 是纯 no-op。
  W.VT.clear();
  const effNone = W.FactRegistry.housekeep(H363, rels363);
  eq("[363] 常态无写动作", effNone.filter((e) => e.kind === "verdict").length, 0);
  // ④ rankOf 现在只读：调用它不改变判定表。
  W.VT.setState("rkro363.test", "r:" + rels363[0], 2, 1);
  const beforeAt = W.VT.at("rkro363.test", "r:" + rels363[0]);
  W.rankOf({ host: "rkro363.test", cfHost: false, clientV6: false, relays: rels363.slice(), legacyWantsRelay: false, mode: "tput" });
  eq("[363] rankOf 不写判定表", W.VT.at("rkro363.test", "r:" + rels363[0]), beforeAt);
  W.VT.clear();
  W.BLK.clear?.();
}
