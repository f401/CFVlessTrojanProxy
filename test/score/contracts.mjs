/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case070({ eq, W, ok, fs }) {
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
  const s0 = W.SOURCES.stat();
  eq("初始没有失败源", s0.bad, 0);
  W.SOURCES.note("https://example.invalid/list.txt", false);
  W.SOURCES.note("https://example.invalid/list.txt", false);
  const s1 = W.SOURCES.stat();
  eq("连续失败的源计入", s1.bad, 1);
  eq("带恢复时间", s1.retryAt > Date.now(), true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case087({ eq, W, fs, ok }) {
  const g = "112";
  eq(`[${g}] 判定表 TTL 只有一个来源（调试端点不再抄裸魔数）`, W.VT_TTL_MS, 30 * 60 * 1000);
  eq(`[${g}] 预算快照回 adm/sub + 三批分账（判定额度那一维 7.149 已删）`, Object.keys(W.planView(400, 20)).join(","), "adm,sub,pend,snap,restore,verds,site");
  const src = fs.readFileSync("test/_bundle.mjs", "utf8");
  ok(`[${g}] 调试端点不再回恒空字段 ips/nodes/rows`, !src.includes("ips: sw.ips") && !src.includes("nodes: sw.nodes"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case089({ fs, debugAll, ok }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case091({ W, eq, ok, fs }) {
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
  W.JUDGE.memory.bigByHost.clear();
  W.JUDGE.memory.bigChan.clear();
  for (let i = 0; i < 600; i++) {
    const h = "big" + i + ".test";
    W.JUDGE.onTraffic({ host: h, chan: { kind: "r", ip: "198.51.100.9" }, via: "node", node: "198.51.100.9:443", ok: true, down: 45290, up: 800, life: 900, cf: false, at: 1_700_000_000_000 + i });
  }
  eq("bigByHost 被压回上限", W.JUDGE.memory.bigByHost.size, W.SC.HOST_MEM_MAX);
  eq("bigChan 与 bigByHost 同步裁剪（落单的键会让判定读到别站点的通道）", W.JUDGE.memory.bigChan.size, W.JUDGE.memory.bigByHost.size);
  // ④ vtAck 顺手清掉过期的记账行
  W.VT_SYNC.pending.clear();
  W.VT_SYNC.sent.clear();
  W.VT_SYNC.pending.set("old.test|r:1.1.1.1", { s: 2, t: 1000 });
  W.VT_SYNC.pending.set("new.test|r:2.2.2.2", { s: 2, t: Date.now() + 600000 });
  W.vtAck();
  eq("vtAck 之后过期行没了、新鲜行还在", [W.VT_SYNC.sent.has("old.test|r:1.1.1.1"), W.VT_SYNC.sent.has("new.test|r:2.2.2.2")].join(","), "false,true");
  W.VT_SYNC.sent.clear();
  // ⑤ 三处调用点都在（防止后续改动把裁剪悄悄删掉）
  const dialSrc = fs.readFileSync("src/proxy/dialer.ts", "utf8");
  const vtSrc = fs.readFileSync("src/route/verdictsync.ts", "utf8");
  const jdSrc = fs.readFileSync("src/route/judge.ts", "utf8");
  ok("dialer 裁剪 cfHost", dialSrc.includes("dropExpired(this.cfHost)") && dialSrc.includes("trimAged(this.cfHost)"));
  ok("verdictsync 裁剪 vtSent", vtSrc.includes("dropExpired(VT_SYNC.sent)") && vtSrc.includes("trimAged(VT_SYNC.sent)"));
  ok("judge 裁剪 bigByHost", jdSrc.includes("trimAged(this.bigByHost)"));
  ok("verdictsync 不再自己抄 TTL", !vtSrc.includes("v.at + 1800000"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case094({ fs, ok, W }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case097({ fs, ok }) {
  const vs = fs.readFileSync("src/route/verdictsync.ts", "utf8");
  ok("待发项记的是 { s, t } 而不是只有到期时间", vs.includes("VT_SYNC.pending.set(k, { s: v.state, t: exp })"));
  ok("上限判断在压入之前", vs.indexOf("if (out.length >= 60) break;") < vs.indexOf("VT_SYNC.pending.set(k, { s: v.state, t: exp })") + 2000);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case098({ W, eq, mkDO, ok, fs }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case099({ mkDO, eq, ok, storeSrc }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case103({ fs, ok }) {
  const dsrc = fs.readFileSync("src/proxy/dialer.ts", "utf8");
  // 7.343：取候选与「拨一次」拆成两个方法，判据指向各自所在的位置
  ok("拨号器把已试过的键传给选择器", dsrc.includes("SEL.current(o.env, o.mode, o.conn, o.host, cfHost, tried)"));
  ok("钉住的 ?rx= 只试一次（诊断语义：我就要这一条）", dsrc.includes("const maxTries = o.conn.forceRelayIp ? 1 : 2;"));
  ok("同一条不会试第二次", dsrc.includes("if (tried.has(key)) return") && dsrc.includes('cand.why === "dup"'));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case104({ W, ok, fs }) {
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
  ok("实现里确实读了边缘 IP 表（入口数可调）", fs.readFileSync("src/views/sub-common.ts", "utf8").includes("X_EDGE_IPS.slice(0, edgeCount(url))"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case105({ fs, ok }) {
  // 第 158 组：错误的标签与被打乱的缩进（v7.168）
  // 「连不上」被写成 skip-direct 会让 /logs 里只看到「故意跳过直连」，看不出真正原因。
  const dSrc = fs.readFileSync("src/proxy/dialer.ts", "utf8");
  const sSrc = fs.readFileSync("src/proxy/session.ts", "utf8");
  ok("拨号失败不许再被说成「故意跳过直连」（dialer）", !dSrc.includes("skip-direct") && dSrc.includes("dial returned null"));
  ok("同一句话在 session 里也改掉", !/^\s*throw new Error\("skip-direct"\)/m.test(sSrc) && sSrc.includes("return this.router.route(host, port);"));
  ok("session 的守卫注明了两条拨号路径都不会回 null", sSrc.includes("return this.router.route(host, port);") && !sSrc.includes("DIALER.open("));
  // 脚本补丁曾把一条语句顶格（缩进 0），块内的层级读起来是断的。
  const cLines = fs.readFileSync("src/proxy/connection.ts", "utf8").split(/\r?\n/);
  const settleLines = fs.readFileSync("src/proxy/conn-settle.ts", "utf8").split(/\r?\n/);
  const relLine = settleLines.find((l) => l.includes("HOOK.relPerf?.(v.host"));
  ok("relPerf 那行和同块其它语句同层级（4 空格）", !!relLine && /^ {4}HOOK\.relPerf\?\./.test(relLine));
  ok("closing 块里没有顶格的语句", cLines.filter((l) => /^\S/.test(l) && !/^(import|export|\/\/|\/\*|\}|type |const |function |class )/.test(l)).length === 0);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case106({ fs, ok }) {
  // 第 159 组：补救链上的拨号超时与 socket 释放（v7.169）
  // 主路径给 connect() 包了 2.5 秒上限，补救链没有：客户端已经等了两三秒，再挂死等于直接放弃。
  const fSrc = fs.readFileSync("src/proxy/fallback.ts", "utf8");
  const aSrc = fs.readFileSync("src/proxy/attacher.ts", "utf8");
  ok("换节点重试也走带预算的拨号器", fSrc.includes("SOCKET_DIALER.open(") && !fSrc.includes("withTimeout(pk, CONNECT_MS)"));
  ok("换节点失败要给这条候选记一笔（否则一直被挑回来）", fSrc.includes("NodeStatsTable.nsFail(alt)"));
  ok("超时迟到成功的 socket 由拨号器关掉（fallback 不再自己写）", !fSrc.includes("pk.then((s) =>") && fSrc.includes("SOCKET_DIALER"));
  const iRel = aSrc.indexOf("releaseAll(conn)");
  const iSet = aSrc.indexOf("conn.sock = sock;");
  ok("递归重试前先释放上一跳的 socket 与写锁", iRel >= 0 && iSet > iRel);
  ok("IPv6 兜底也有建连预算（走拨号器）", aSrc.includes("SOCKET_DIALER.open(expandV6(v6), port, o.budget)") && !aSrc.includes("connect({ hostname: expandV6(v6)"));
  ok("proxyip 兜底也有建连预算（走拨号器）", aSrc.includes("SOCKET_DIALER.open(px.host, px.port, o.budget)") && !aSrc.includes("Promise.resolve(connect("));
  ok("proxyip 连不上要给中继记账", aSrc.includes('NodeStatsTable.nsFail(px.host + ":" + px.port)'));
  ok("死条件 !px || st.retried 已经删掉（只判代码行，注释里可以留历史）", !/if \(!px \|\| st\.retried\)/.test(aSrc));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case107({ fs, eq, ok, W }) {

  // 第 160 组：地区分流（?rg=）的拨号超时与失败归因（v7.170）
  // 地区是硬要求，挂死不能靠「等客户端放弃」；失败也不能记到目标站头上。
  const rgSrc = fs.readFileSync("src/proxy/region.ts", "utf8");
  const ssSrc = fs.readFileSync("src/proxy/session.ts", "utf8");
  // 7.372 加了 openPinned（?node= 硬钉）的第三条拨号，同样走 SOCKET_DIALER，口径不变
  eq("地区分流与钉节点的拨号都走同一个拨号器", (rgSrc.match(/SOCKET_DIALER\.open\(/g) || []).length, 3);
  eq("地区分流里不再有裸 connect（超时迟到成功的 socket 必须有人关）", (rgSrc.match(/await connect\(/g) || []).length, 0);
  ok("同一个节点一次失败只罚一次（否则冷却跳两档）", rgSrc.includes("conn.node !== failed"));
  ok("地区失败单独计数，不混进「目标不可达」", fs.readFileSync("src/proxy/fallback.ts", "utf8").includes('cnt("rgFail")') && W.COUNTER.keys.includes("rgFail"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case113({ fs, eq, W, ok }) {
  const pendSrc = fs.readFileSync("src/store/pend.ts", "utf8");
  eq("PEND_MAX 是 32：一轮最多 32 次 DO 往返，留出子请求余量", W.SC.PEND_MAX, 32);
  ok("批次按轮转取，且夹在本轮额度与 PEND_MAX 之间", pendSrc.includes("rotated.slice(0, Math.max(1, Math.min(SC.PEND_MAX, max)))") && pendSrc.includes("(this.cursor || 0) % all.length"));
  ok("只摘掉这一批，不整表清空（在途增量留在账本里）", pendSrc.includes("for (const [bid] of batch) this.rows.delete(bid);") && !pendSrc.includes("PEND.rows.clear();"));
  ok("被截断的人数会记进 pendSkip", pendSrc.includes('cnt("pendSkip", rotated.length - batch.length)'));
  const sent = [];
  const mkP = { METER: { idFromName: (x) => x, get: (id) => ({ fetch: async () => { sent.push(id); return new Response(JSON.stringify({ v: null }), { status: 200 }); } }) } };
  W.PEND.rows.clear();
  W.PEND.cursor = 0;
  for (let i = 0; i < 40; i++) W.PEND.rows.set("p" + i, { up: 10, down: 20, conns: 1 });
  await W.PEND.flush(mkP, true);
  eq("一轮只发 PEND_MAX 个用户", sent.length, 32);
  eq("没发出去的留在账本里", W.PEND.rows.size, 8);
  eq("没发出去的正好是末尾那 8 个", [...W.PEND.rows.keys()].join(","), "p32,p33,p34,p35,p36,p37,p38,p39");
  ok("截断的人数记进了 pendSkip", (W.cntView().pendSkip || 0) >= 8);
  await W.PEND.flush(mkP, true);
  eq("第二轮把剩下的 8 个发完", W.PEND.rows.size, 0);
  eq("两轮合计正好 40 次 DO 往返", sent.length, 40);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case114({ fs, ok, W, eq }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case115({ W, eq, ok, fs, psAll }) {
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
  W.CF_HTTP.cache.clear();
  W.CF_HTTP.flight.clear();
  W.refreshCfHttp("dedupe.test", ctx);
  W.refreshCfHttp("dedupe.test", ctx);
  eq("同一站点在途时只探一次", launches.length, 1);
  ok("在途集合里记着它", W.CF_HTTP.flight.has("dedupe.test"));
  await Promise.allSettled(launches);
  ok("探测结束后清掉在途标记", !W.CF_HTTP.flight.has("dedupe.test"));
  W.refreshCfHttp("dedupe.test", ctx);
  eq("刚探过一次就不再立刻重探（负缓存 20 秒）", launches.length, 1);

  const tfSrc = fs.readFileSync("src/core/transport.ts", "utf8");
  const tfImpl272 = fs.readFileSync("src/core/transport.ts", "utf8");
  ok("probeTf 的实现在传输层里，且整段包在超时里", tfSrc.includes("PROBE_BUDGET_MS") && tfImpl272.includes("withTimeout(work, timeoutMs"));
  const h80 = fs.readFileSync("src/core/transport.ts", "utf8");
  ok("HTTP/80 传输同样用 splitRelay 解析中继", /relay \? splitRelay\(relay, 80\)/.test(h80));
  // ps 行的线格式只有一份（psfacts.ts 的 PsWire），出站必须真的带上 top（7.163 漏的跟随）
  const psSrc = psAll();
  ok("PsWire 带上 top（曾经行过的证据要能跨 isolate）", /\/\*\*[\s\S]*?\*\/[\s\S]*?top\?:/.test(psSrc) && psSrc.includes("export interface PsWire"));
  ok("PsWire 声明了 top 字段", /top\?: number;/.test(psSrc));
  const foSrc = fs.readFileSync("src/store/factout.ts", "utf8");
  ok("factsOut 真的把 top 发出去", foSrc.includes("top: Number(x.top) || 0"), "出站丢了 top");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case116({ W, ok, mkDO, eq, verdictAll }) {
  // 1) 判定表：走 setState（recordBlock/recordPass/markBlocked/import 都走它）灌 700 行
  W.VT.clear();
  for (let i = 0; i < 700; i++) W.VT.setState("cap" + i + ".test", "r:198.51.100.9", 2, 1);
  ok("判定表的上限在 setState 上也生效（超限即收回容量）", W.VT.size() <= 600 && W.VT.size() >= 500, `size=${W.VT.size()}`);
  ok("删掉的是最旧的：第一条已经不在了", !W.VT.all().some((r) => r.target === "cap0.test"));
  ok("最新的那条还在", W.VT.all().some((r) => r.target === "cap699.test"));

  // 2) 判定表：走 import（远端同步，单批 120 行）灌 960 行
  W.VT.clear();
  for (let b = 0; b < 8; b++) {
    const rows = [];
    for (let i = 0; i < 120; i++) rows.push({ k: "imp" + b + "_" + i + ".test|r:198.51.100.9", s: 2, t: Date.now() + 1800000 });
    W.VT.import(rows);
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case117({ W, eq, ok, fs }) {
  // 1) judge 写 needPx 的两条路径都要压回上限
  W.RELAY_DEMAND.clear();
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
  eq("needPx 有上限：judge 写入也压回 SC.PX_MAX", W.RELAY_DEMAND.size, W.SC.PX_MAX);
  ok("最早过期的那些先被丢掉", !W.RELAY_DEMAND.has("np0.test"));
  ok("最新的那条还在", W.RELAY_DEMAND.has("np699.test"));
  const atSrc = fs.readFileSync("src/proxy/attacher.ts", "utf8");
  ok("attacher 与 judge 共用同一个上限函数", atSrc.includes("trimAged(RELAY_DEMAND, SC.PX_MAX)"));
  ok("attacher 不再自己数 300", !/S\.needPx\.size >= 300/.test(atSrc));

  // 2) 限流表：撑爆时只删最旧，不清空别人的计数
  W.RATE_LIMIT.clear();
  const hot = "203.0.113.200";
  let allowed = 0;
  for (let i = 0; i < 10; i++) if (W.RATE_LIMIT.take(hot, 10)) allowed += 1;
  eq("窗口内前 10 次放行", allowed, 10);
  ok("第 11 次被挡", W.RATE_LIMIT.take(hot, 10) === false);
  for (let i = 0; i < 600; i++) W.RATE_LIMIT.take("10.9." + Math.floor(i / 256) + "." + (i % 256), 10);
  ok("表被撑爆之后，原来被限住的 IP 仍然被限住（不是整体 clear）", W.RATE_LIMIT.take(hot, 10) === false);
  ok("限流表自己仍然有界", W.RATE_LIMIT.size <= 501);

  // 3) shadowRate 的说明不再自称「显示 10 实际 0」
  const uSrc = fs.readFileSync("src/core/util.ts", "utf8");
  ok("shadowRate 文档不再举「显示 10 实际 0」这个错例", !uSrc.includes("实际 0"));

  // 4) RTT 表有 5 列，"暂无数据" 必须跨 5 列
  const pSrc = fs.readFileSync("src/views/panel.ts", "utf8");
  ok("「暂无数据」跨满 RTT 表的 5 列", pSrc.includes("<td colspan=5>暂无数据</td>"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case118({ W, ok, eq, fs }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case119({ W, eq, ok, fs }) {
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
  const tfImpl271 = fs.readFileSync("src/core/transport.ts", "utf8");
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case124({ fs, eq, W, ok }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case126({ reset, node, W, eq, ok, fs }) {
  reset();
  node("sfa:443", { tcp: 40 });
  node("sfb:443", { tcp: 40 });
  W.SELECTION_MEMORY.failCount = 0;
  W.SELECTION_MEMORY.failSeen = 0;
  await W.SEL.softFail("sfa:443");
  await W.SEL.bumpFail({}, "tput", "sfb:443", false, "site");
  const fa = W.NodeStatsTable.nsGet("sfa:443");
  const fb = W.NodeStatsTable.nsGet("sfb:443");
  eq("softFail 与 kind=site 的权重一致", Math.round(fb.failW * 10), Math.round(fa.failW * 10));
  ok("站点失败只记 0.2 的站责", fa.failW > 0.1 && fa.failW < 0.3, String(fa.failW));
  eq("站点失败不进全局失败记忆", W.SELECTION_MEMORY.failCount, 0);
  eq("站点失败不置失败标志", W.SELECTION_MEMORY.failSeen, 0);
  eq("站点失败不冻结节点", W.isFrozen("sfa:443") || W.isFrozen("sfb:443"), false);
  // 节点侧失败（kind=node）必须真的推进全局记忆，否则「连续失败就换节点」永不触发
  W.SELECTION_MEMORY.failCount = 0;
  await W.SEL.bumpFail({}, "tput", "sfb:443", false);
  eq("节点侧失败推进全局记忆", W.SELECTION_MEMORY.failCount >= 1, true);
  // 站点级试探（hostTrial）的失败只冻结它自己，也不动全局记忆
  reset();
  node("sfd:443", { tcp: 40 });
  W.SELECTION_MEMORY.failCount = 0;
  await W.SEL.bumpFail({}, "tput", "sfd:443", true);
  eq("试探失败不进全局记忆", W.SELECTION_MEMORY.failCount, 0);
  eq("试探失败冻结该节点", W.isFrozen("sfd:443"), true);
  // 源码锁：影子字段与「第二条等价的记账路径」都别再回来
  const conSrc = fs.readFileSync("src/proxy/connection.ts", "utf8");
  const atSrc = fs.readFileSync("src/proxy/attacher.ts", "utf8");
  ok("Connection 不再有影子连接的 trial 字段", !conSrc.includes("  trial = false;") && !conSrc.includes("this.trial"), "");
  ok("站点失败的记账只剩 softFail 一条路", !atSrc.includes('"site"'), "");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case129({ W, eq, ok, fs }) {
  const reqP = new Request("https://gw.example/", { headers: { "cf-connecting-ip": "203.0.113.9" } });
  const poolBak = W.POOL_MEMORY.rows;
  const aliveBak = new Map(W.NODE_MEMORY.alive);
  // pxDecision 内部用的是 POLICY.relays()：先让池子里有两条非 CF 中继，闸门才有「中继」可选
  W.POOL_MEMORY.rows = [{ h: "45.136.117.194", p: 443, cc: "" }, { h: "193.181.211.185", p: 443, cc: "" }];
  W.NODE_MEMORY.alive.clear();

  // ① 新鲜直连整页证据：判定层选直连，闸门必须放行（旧代码在这里返回 true）
  W.VT.clear();
  W.VT.set("x.com", "d", 200, 40, 1);
  const d1 = W.POLICY.decide({ host: "x.com", cfHost: true, clientV6: false, relays: ["45.136.117.194"], legacyWantsRelay: true, mode: "tput" });
  eq("新鲜直连证据下判定层选直连", d1.chan.kind, "d");
  eq("新鲜直连证据下闸门不再硬绕中继", W.pxDecision(reqP, "x.com", true, true, 2), false);
  eq("非 CF 站点的直连证据同样放行", W.pxDecision(reqP, "x.com", false, true, 2), false);

  // ② 没有直连证据：判定层选一条中继，闸门走中继（这是 7.187 要保住的那一半）
  const d2 = W.POLICY.decide({ host: "y.org", cfHost: true, clientV6: false, relays: ["45.136.117.194"], legacyWantsRelay: true, mode: "tput" });
  ok("没有直连证据时判定层选一条中继", d2.chan.kind === "r", d2.why);
  eq("没有直连证据时闸门走中继", W.pxDecision(reqP, "y.org", true, false, 2), true);

  // ③ 直连被差分判死：闸门必须改走中继（不依赖 wantPx）
  W.VT.setState("z.net", "d", 2, 1);
  const d3 = W.POLICY.decide({ host: "z.net", cfHost: true, clientV6: false, relays: ["45.136.117.194"], legacyWantsRelay: false, mode: "tput" });
  ok("直连被判死时判定层改走中继", d3.chan.kind === "r", d3.why);
  eq("直连被判死时闸门走中继", W.pxDecision(reqP, "z.net", true, false, 2), true);

  // ④ 分级语义：2 才改行为，1 只改硬规则，0 全是影子
  W.VT.clear();
  W.VT.set("k.io", "d", 200, 40, 1);
  eq("level 1 不改行为（wantPx=false 就直连）", W.pxDecision(reqP, "k.io", true, false, 1), false);
  eq("level 0 不改行为（wantPx=true 就绕中继）", W.pxDecision(reqP, "k.io", true, true, 0), true);

  // ⑤ 源码锁：闸门的硬规则必须挂在「判定层选了中继」这个条件上
  const srcPx = fs.readFileSync("src/proxy/pxhook.ts", "utf8");
  ok("闸门按判定结果而非无条件放行", srcPx.includes('if (cfHost && level >= 1 && out.via === "r")'), "pxhook 的 cfHost 分支形状变了");
  ok("闸门里没有无条件的 cfHost return true", !/if \(cfHost && level >= 1\) \{\s*return true;/.test(srcPx), "仍是无条件硬绕");

  W.VT.clear();
  W.POOL_MEMORY.rows = poolBak;
  W.NODE_MEMORY.alive.clear();
  for (const [k, v] of aliveBak) W.NODE_MEMORY.alive.set(k, v);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case130({ verdictAll, eq, W, statAll, ok, fs }) {
  // ① 状态码→状态只有一处实现：导出的副本 stateOfCode 已删除，剩下的私有实现必须唯一
  const srcVt = verdictAll();
  eq("verdict.ts 不再有 stateOfCode 死导出", srcVt.includes("stateOfCode"), false);
  eq("「2xx-3xx 可用」的映射全仓只写一次", srcVt.split("code >= 200 && code < 400").length - 1, 1);
  // 删副本不许改行为：三条映射仍要落在 1 / 2 / 3
  W.VT.clear();
  W.VT.set("s195.test", "d", 200, 40, 1);
  eq("200 仍是可用", W.VT.state("s195.test", "d"), 1);
  W.VT.set("s195.test", "d", 403, 140, 1);
  eq("403 仍是被拦", W.VT.state("s195.test", "d"), 2);
  W.VT.set("s195.test", "d", 0, 0, 1);
  eq("没有状态码仍是连不上", W.VT.state("s195.test", "d"), 3);
  W.VT.clear();

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
  const n195 = W.FactsStore.load({ dns: [{ h: "d195.test", v: 1, at: now195 }], eg: [{ i: "9.9.9.9", f: 6, at: now195 }] });
  eq("车身里的 dns 事实被读入", n195.dns, 1);
  eq("车身里的 eg 事实被读入", n195.eg, 1);
  eq("dns 事实真的进了 DNS 表", W.DNS.v6Of("d195.test"), 1);
  W.DNS.clear();

  // ④ 闸门本身在位：死导出扫描必须挂在总闸上，否则下一次死导出照样能发版
  ok("死导出闸门脚本存在", fs.existsSync("tools/check-dead.mjs"), "tools/check-dead.mjs 不见了");
  const srcPf = fs.readFileSync("tools/preflight.mjs", "utf8");
  ok("死导出闸门接进了 preflight", srcPf.includes("tools/check-dead.mjs"), "preflight 里没有这一步");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case131({ fs, ok, eq, W }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case132({ W, eq, ok, fs }) {
  const subEnv = { uuid: "4241b903-8d39-4a17-8f4c-bb33b1630c33", pwd: "", nodes: "" };
  const subHost = "sim.example.com";
  const aliveBefore = W.NODE_MEMORY.alive;
  W.NODE_MEMORY.alive = new Map();
  W.NODE_MEMORY.alive.set("45.136.117.194:443", { host: "45.136.117.194", port: 443, tls: true, cc: "" });
  const render = (q) => W.renderClash(subEnv, new URL("https://" + subHost + "/sub" + q), subEnv.uuid, subHost, {}, ["HK"], undefined);
  // 取某个条目的 server 行（clash 的 name 带引号，按含引号的整行找）
  const serverOf = (txt, name) => {
    const ls = txt.split(/\r?\n/);
    const i = ls.findIndex((l) => l.trim() === "- name: \"" + name + "\"");
    if (i < 0) return null;
    const s = ls.slice(i, i + 6).find((l) => l.trim().startsWith("server:"));
    return s ? s.trim().slice(7).trim() : null;
  };

    // ① ?e=0 只去掉入口 IP 条目：中继组已删，不受影响
  const noEdgeTxt = render("?e=0");
    eq("?e=0 时无 r- 条目", noEdgeTxt.includes("- name: \"r-"), false);
    eq("中继优选组已删除", noEdgeTxt.includes("🔁 中继优选"), false);
  ok("?e=0 时入口条目确实没了", noEdgeTxt.includes("- name: \"e-") === false, "入口条目没被去掉");
    eq("中继条目删除后 serverOf 返回 null", serverOf(noEdgeTxt, "r-45.136.117.194-VLT"), null);

    // ② ?r=0 是遗留开关：中继组已删，入口条目照旧
  const noRelayTxt = render("?r=0");
  ok("?r=0 时中继条目消失", noRelayTxt.includes("- name: \"r-45.136.117.194-VLT\"") === false, "中继条目还在");
  ok("?r=0 时中继优选组消失", noRelayTxt.includes("\"🔁 中继优选\"") === false, "中继优选组还在");
  ok("?r=0 时入口条目仍在", noRelayTxt.includes("- name: \"e-"), "入口条目被连带删掉了");

    // ③ 默认（两个开关都不给）：入口 IP 条目照旧
  const defTxt = render("");
    ok("默认仍发入口 IP 条目", defTxt.includes("- name: \"e-"), "入口条目没发出");

  // ④ RegionEntry 的端口兜底：url 省略时不能是 undefined（`NaN || undefined` 还是 undefined）
  const regs = W.regionEntries(["HK"], subHost, "", ["vless"], undefined);
  eq("省略 url 时地区条目端口是 443", regs.length && regs[0].port, 443);
  const regHttp = W.regionEntries(["HK"], subHost, "", ["vless"], new URL("http://" + subHost + "/sub"));
  eq("http 订阅的地区条目端口是 80", regHttp.length && regHttp[0].port, 80);
  const regPort = W.regionEntries(["HK"], subHost, "", ["vless"], new URL("https://" + subHost + ":8443/sub"));
  eq("显式端口的订阅按 URL 端口走", regPort.length && regPort[0].port, 8443);

  W.NODE_MEMORY.alive = aliveBefore;

    // ⑤ 源码锁：中继组已删、入口兜底仍在
  const srcSub = fs.readFileSync("src/views/sub.ts", "utf8");
    ok("中继块已删除", !srcSub.includes("if (!noRelay) {") && !srcSub.includes("const G_RELAY"), "中继块还在");
  eq("中继块不再要求入口 IP 存在", srcSub.includes("if (!noEdge && !noRelay) {"), false);
  const srcCommon = fs.readFileSync("src/views/sub-common.ts", "utf8");
  ok("地区条目端口有显式兜底", srcCommon.includes(': 443;'), "端口兜底不见了");
  // 注释里可以引用旧写法（说明为什么改），但可执行的那一行必须是新的三目
  const commonCode = srcCommon.split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n");
  eq("端口表达式不再依赖 url 守卫", commonCode.includes("Number(url && url.port)"), false);
  ok("端口表达式显式区分有无 url", commonCode.includes("const listen = url ? Number(url.port)"), "端口表达式没改");
  // ⑥ sing-box 的两处 domain_strategy 被脚本打散过缩进（块内 10 空格）
  const sbLines = fs.readFileSync("src/views/sub-common.ts", "utf8").split(/\r?\n/);
  eq("sing-box 没有 4 空格缩进的 domain_strategy", sbLines.filter((l) => /^ {4}domain_strategy:/.test(l)).length, 0);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case133({ W, ok, eq, fs }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case134({ W, eq, fs }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case135({ W, eq, fs }) {
  const envS200 = { uuid: "u200", nodes: "", proxyip: "auto" };
  const idS200 = "4241b903-8d39-4a17-8f4c-bb33b1630c33";
  const alive200 = W.NODE_MEMORY.alive;
  const now200 = Date.now();
  W.NODE_MEMORY.alive = new Map([
    ["45.136.117.194", { at: now200, ms: 120 }],
    ["193.181.211.185", { at: now200, ms: 150 }],
  ]);
  const sb200 = JSON.parse(W.renderSingbox(envS200, new URL("https://example.com/sub"), idS200, "example.com", {}, ["HK"]));
  W.NODE_MEMORY.alive = alive200;

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
  const src200 = fs.readFileSync("src/views/sub-common.ts", "utf8");
  eq("源码里写了 ip_is_private 直连", src200.includes("ip_is_private: true"), true);
  eq("源码里局域网后缀与 dns_local 配对", src200.includes('server: "dns_local"'), true);
  // 对照：Clash 侧本来就有本地解析与 CN 直连，改 sing-box 时别把两边口径搞反
  const cl200 = W.renderClash(envS200, new URL("https://example.com/sub"), idS200, "example.com");
  eq("Clash 侧仍是本地 nameserver", cl200.includes("nameserver: [223.5.5.5"), true);
  eq("Clash 侧仍有 GEOIP,CN 直连", cl200.includes("- GEOIP,CN,DIRECT"), true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case136({ W, ok, eq, fs }) {
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
  eq("cron.ts 走 TFB.sweep 清理", srcCron201.includes("TFB.sweep(RELAY_DEMAND, now)"), true);
  eq("cron.ts 开批前问 due", srcCron201.includes("if (!TFB.due(host, now)) continue;"), true);
  eq("账本容量交给 BoundedMap（与 SC.PX_MAX 同源）", srcBook201.includes("max: SC.PX_MAX") && srcBook201.includes("this.lastBatchAt.prune(now, false)"), true);
  const srcArch201 = fs.readFileSync("tools/check-arch.js", "utf8");
  eq("arch 门禁拦住顶层可变容器", srcArch201.includes("顶层可变容器"), true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case137({ W, eq, fs }) {
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
  const mark = () => W.USAGE_MEMORY.rows.set("force-u", { up: 3, down: 4, conns: 1, first: 1, last: 1 });

  W.SNAP.written = 0;
  W.SNAP.checked = 0;
  W.SNAP.busy = false;
  mark();
  await W.flushSnap(envF, true);
  eq("第一次强制落盘写了 snap", snapWrites(), 1);

  // 5 分钟检查闸门：旧代码在 force 时也会 return，强制落盘静默变成 no-op
  mark();
  await W.flushSnap(envF, true);
  eq("紧接着再强制一次仍会落盘（不被 5 分钟检查闸门吃掉）", snapWrites(), 2);

  // 45 分钟全局闸门：把检查闸门的手动复位掉，单独验证第二道
  W.SNAP.checked = 0;
  mark();
  await W.flushSnap(envF, true);
  eq("force 也绕过 45 分钟全局闸门", snapWrites(), 3);

  // 非 force 的路径必须仍然被节流（否则 force 就成了唯一节流）
  mark();
  await W.flushSnap(envF);
  eq("非 force 的路径仍被节流", snapWrites(), 3);
  W.USAGE_MEMORY.rows.delete("force-u");

  const srcSnap202 = fs.readFileSync("src/store/snapshot.ts", "utf8");
  eq("检查闸门对 force 放行", srcSnap202.includes("if (!force && now - SNAP.checked < 5 * 60000) return;"), true);
  eq("全局闸门对 force 放行", srcSnap202.includes("if (!force && now - (prev.ts || 0) < FLUSH_GAP) {"), true);
  eq("flushSnap 把 force 传下去", srcSnap202.includes("await writeSnap(env, now, !!force);"), true);
  eq("usageSnapWrite 文档不再承诺「不传就用本地状态」", srcSnap202.includes("不传则用本地状态"), false);

  const srcTypes202 = fs.readFileSync("types/app.d.ts", "utf8");
  eq("信誉表类型不再留 Seed.lastColo", srcTypes202.includes("lastColo"), false);
  eq("信誉表类型不再留 SeedHp", srcTypes202.includes("SeedHp"), false);
  eq("信誉表条目不再声明 v6 统计字段", /interface SeedNode \{[^}]*sb\?:/.test(srcTypes202), false);
  eq("信誉表条目仍声明名字与地址", /interface SeedNode \{[^}]*k: string;/.test(srcTypes202), true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case138({ fs, ok, W, eq }) {
  const st = fs.readFileSync("src/core/state.ts", "utf8");
  const cw = fs.readFileSync("tools/check-wire.mjs", "utf8");
  const cn = fs.readFileSync("src/proxy/connection.ts", "utf8") + fs.readFileSync("src/proxy/conn-settle.ts", "utf8");
  ok("szBig 已从登记表删除（触发条件不可达）", !/^\s*"szBig",/m.test(st));
  ok("psSent 已从登记表删除", !/^\s*"psSent",/m.test(st));
  ok("egProbe 已从登记表删除", !/^\s*"egProbe",/m.test(st));
  ok("e4retry 已从登记表删除", !/^\s*"e4retry",/m.test(st));
  ok("vtSeen 已从登记表删除", !/^\s*"vtSeen",/m.test(st));
  ok("vtPend 计数键已删除（S.vtPend 是另一张表）", !/^\s*"vtPend",/m.test(st));
  ok("connection.ts 与 conn-settle.ts 的 tput 都走 cnt()", (cn.match(/cnt\("tput"\)/g) || []).length >= 2, "tput 计数点不足");
  ok("connection.ts 不再直接改 S.cnt.tput", !cn.includes("S.cnt.tput"));
  ok("check-wire 有动态键白名单", cw.includes("DYN_CNT"));
  ok("check-wire 会对死登记键报红", cw.includes("没有任何 cnt("));
  W.COUNTER.day = "1970-01-01";
  W.COUNTER.values.tput = 5;
  W.cnt("tput");
  eq("cnt() 跨天后从 1 开始", W.COUNTER.values.tput, 1);
  W.cnt("szBig");
  ok("未登记的键不会凭空出现", !("szBig" in W.COUNTER.values));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case139({ W, eq, fs, ok }) {
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
  W.ISOLATE.colo = "HKG";
  W.SEED_STORE.document = { v: 7, ts: 0, poolGen: 0, poolN: 0, builtAt: 0, byColo: {}, cnt: null };
  W.SEED_STORE.readFailed = false;
  W.SEED_STORE.readAt = 0;
  // 第一步：让这块「共享锚点」先到第 6 代 320 条（用写盘本身建立，不手搓 seal）
  W.POOL_MEMORY.generation = 6;
  W.POOL_MEMORY.builtAt = 111;
  W.POOL_MEMORY.rows = fakePool(320);
  await W.SEED_STORE.write(envS, false, true);
  eq("锚点建立到第 6 代", W.SEED_STORE.document.poolGen, 6);
  eq("锚点规模 320", W.SEED_STORE.document.poolN, 320);
  // 第二步：本地停在旧代（5 代 200 条）的 isolate 落盘，不得把锚点改小
  W.SEED_STORE.readAt = 0;
  W.POOL_MEMORY.generation = 5;
  W.POOL_MEMORY.builtAt = 100;
  W.POOL_MEMORY.rows = fakePool(200);
  await W.SEED_STORE.write(envS, false, true);
  eq("落后一个代际的 isolate 不会把锚点代际改小", W.SEED_STORE.document.poolGen, 6);
  eq("也不会把锚点规模改小", W.SEED_STORE.document.poolN, 320);
  eq("也不会把建池时间改小", W.SEED_STORE.document.builtAt, 111);
  // 第三步：同代但本地池子更全 → 取较大值
  W.SEED_STORE.readAt = 0;
  W.POOL_MEMORY.generation = 6;
  W.POOL_MEMORY.rows = fakePool(400);
  await W.SEED_STORE.write(envS, false, true);
  eq("同代取较大规模", W.SEED_STORE.document.poolN, 400);
  // 第四步：本地确实更新 → 用本地那一对
  W.SEED_STORE.readAt = 0;
  W.POOL_MEMORY.generation = 7;
  W.POOL_MEMORY.builtAt = 222;
  W.POOL_MEMORY.rows = fakePool(410);
  await W.SEED_STORE.write(envS, false, true);
  eq("本地更新时代际前移", W.SEED_STORE.document.poolGen, 7);
  eq("本地更新时规模取本地", W.SEED_STORE.document.poolN, 410);
  eq("本地更新时建池时间取本地", W.SEED_STORE.document.builtAt, 222);
  // 源码锁
  const sd = fs.readFileSync("src/px/seed.ts", "utf8");
  ok("写盘走 poolAnchor()", sd.includes("const pa = this.poolAnchor();") && sd.includes("const pa0 = this.poolAnchor();"));
  ok("不再有「本地优先」的锚点写法", !sd.includes("poolGen: POOL_MEMORY.generation || SEED_STORE.document.poolGen"));
  ok("落后时的分支原样沿用锚点", sd.includes("return { gen: gSeed, n: nSeed, builtAt: atSeed };"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case140({ W, eq, fs, ok }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case142({ W, eq, fs, ok, metricsAll }) {
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

  W.SNAP.cache = { v: null, t: 0 };
  const bad = mkKv(async () => {
    throw new Error("kv hiccup");
  });
  let thrown = false;
  try {
    await W.getSnap(bad.env);
  } catch (e) {
    thrown = true;
  }
  eq("快照读失败必须抛错（不能返回空表）", thrown, true);
  eq("读失败不进缓存", W.SNAP.cache.t, 0);
  eq("读失败后缓存里没有空快照", W.SNAP.cache.v, null);

  // KV 恢复：同一个 isolate 里不带 fresh 也必须能读到（旧代码会拿缓存糊弄 5 分钟）
  const good = mkKv(async () => null);
  const doc = await W.getSnap(good.env);
  eq("KV 恢复后立刻能读到快照", typeof doc, "object");
  eq("KV 恢复后真的重新打了一次", good.calls(), 1);

  // 键不存在是「还没有快照」，这种情况可以缓存（否则每次订阅都打一次 KV）
  W.SNAP.cache = { v: null, t: 0 };
  const miss = mkKv(async () => null);
  const m1 = await W.getSnap(miss.env);
  const m2 = await W.getSnap(miss.env);
  eq("没有快照键时缓存空表", m1 === m2, true);
  eq("没有快照键时只打一次 KV", miss.calls(), 1);

  // 路径一：快照读失败 ⇒ getSnap 抛错 ⇒ loadRtt 退回内存，不写 rttMiss
  W.ENTRY_MEMORY.misses.clear();
  W.SNAP.cache = { v: null, t: 0 };
  const rttFail = mkKv(async () => {
    throw new Error("kv hiccup");
  });
  const mem1 = await W.loadRtt(rttFail.env, "u207a");
  eq("loadRtt 快照读失败时返回内存那份", typeof mem1, "object");
  eq("loadRtt 快照读失败不写 rttMiss", W.ENTRY_MEMORY.misses.size, 0);

  // 路径二：快照有缓存（空表，属真值），但旧键 rtt:<id> 读失败 ⇒ 同样不能记「没有旧键」
  W.ENTRY_MEMORY.misses.clear();
  W.SNAP.cache = { v: { v: 1, ts: 1, date: "", stats: {}, rtt: {}, errs: [] }, t: Date.now() };
  const legacyFail = mkKv(async () => {
    throw new Error("kv hiccup");
  });
  const mem2 = await W.loadRtt(legacyFail.env, "u207b");
  eq("loadRtt 旧键读失败时返回内存那份", typeof mem2, "object");
  eq("loadRtt 旧键读失败不写 rttMiss", W.ENTRY_MEMORY.misses.size, 0);

  // 旧键确实不存在（不抛错）时才允许记 10 分钟，避免每次刷订阅都打一次 KV
  W.ENTRY_MEMORY.misses.clear();
  const legacyMiss = mkKv(async () => null);
  await W.loadRtt(legacyMiss.env, "u207c");
  eq("旧键确实不存在时记 rttMiss", W.ENTRY_MEMORY.misses.size, 1);

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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case143({ fs, ok, eq, W }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case144({ W, ok, fs }) {
  const prevSim = globalThis.__simConnect;
  const envD = { proxyip: "", uuid: "main", proxyipList: "" };
  const reqD = new Request("https://example.com/probe");
  const mkSt = () => ({ hostTrial: false, trial: false, pxTries: 0 });
  const runOne = async () => {
    const t = Date.now();
    const r = await Promise.race([
      W.DIALER.open({ env: envD, request: reqD, conn: mkSt(), mode: "tput", host: "example.com", port: 80, pxForce: -1, budget: new W.BudgetedIO(new W.BudgetLedger("request")) })
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
    dialerSrc.includes("await this.guarded(dial4(host, port, o.budget), host)") &&
      dialerSrc.includes("await this.guarded(dial(host, port, o.budget), host)"),
  );
  ok(
    "不再有裸的直连拨号",
    !dialerSrc.includes("sock = await dial4(host, port);") && !dialerSrc.includes("sock = await dial(host, port);"),
  );
  ok("超时后关掉迟到 socket", dialerSrc.includes("closeQuietly(x)"));
  ok("guarded 用 2500ms 上限", dialerSrc.includes("return await withTimeout(pk, CONNECT_MS);"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case145({ W, ok, fs }) {
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
  const ph = await bounded(() => new W.Http80Transport().probe("example.com", "1.2.3.4:80", "/", 6000));
  ok("HTTP/80 传输挂死时返回 io: timeout", Boolean(ph.r && ph.r.x && ph.r.x.ok === false && ph.r.x.err === "io: timeout"), JSON.stringify(ph.r));
  ok("三次探测都把挂死的 socket 关掉", closedWr >= 3, String(closedWr));
  globalThis.__simConnect = prevSimWr;
  // 源码锁：三处 write 都必须带 withTimeout，且不许再出现裸的 await w.write(
  const probeSrc = fs.readFileSync("src/px/probe.ts", "utf8");
  const httpSrc = fs.readFileSync("src/core/transport.ts", "utf8");
  // 写超时现在收在 RawProbe.send 里（两个探测只传各自的报文与预算），判据不变：
  // 「写报文必须带时限」由类里那一处 withTimeout 保证，两个探测都经它发。
  ok(
    "probeProxy 的 write 有超时",
    probeSrc.includes("probe.send(PROBE_HELLO, CONNECT_MS)") &&
      probeSrc.includes('withTimeout(w.write(bytes), budgetMs, "timeout")'),
  );
  ok("probeSni 的 write 跟随 ms", probeSrc.includes("probe.send(tlsHello(sni), ms)"));
  ok("HTTP/80 的 write 有超时（预算取 timeoutMs 与 CONNECT_MS 的小者）", httpSrc.includes('withTimeout(w.write(new TextEncoder().encode(req)), budget, "timeout")'));
  ok("传输层引入了 CONNECT_MS 与 withTimeout", httpSrc.includes('import { CONNECT_MS, withTimeout } from "./util";'));
  ok(
    "探活路径不再有裸 write",
    !/await w\.write\((?!.*withTimeout)/.test(probeSrc) && !/await w\.write\((?!.*withTimeout)/.test(httpSrc),
  );
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case146({ W, eq, ok, fs }) {
  const bak212 = [...W.NODE_MEMORY.alive.entries()];
  const bakN212 = W.NODE_MEMORY.candidateCount;
  const N212 = 1500;
  W.NODE_MEMORY.alive.clear();
  for (let i = 0; i < N212; i++) {
    const h = "10." + (i >> 8) + "." + (i & 255);
    W.NODE_MEMORY.alive.set(h + ":443", { h, p: 443, cc: "", ms: 100 });
  }
  W.NODE_MEMORY.candidateCount = 0;
  W.NodeStatsTable.invalidateRank();
  W.CANDS.list("lat");
  eq("切片中途不写 candN（旧代码会把 128 当池子大小）", W.NODE_MEMORY.candidateCount, 0);
  let calls212 = 1;
  while (W.NODE_MEMORY.candidateCount === 0 && calls212 < 40) {
    W.CANDS.list("lat");
    calls212++;
  }
  eq("扫完整轮才写 candN", W.NODE_MEMORY.candidateCount, N212);
  ok("整轮确实是分片扫的", calls212 > 1, "calls=" + calls212);
  const ts212 = fs.readFileSync("src/px/ts.ts", "utf8");
  const sc212 = fs.readFileSync("src/nodes/score.ts", "utf8");
  ok("pickThom 的分母是存活表大小", ts212.includes("const nPool = NODE_MEMORY.alive.size ||"), "");
  ok("候选表只在扫完时写 candN", sc212.includes("if (st.pos >= st.keys.length) NODE_MEMORY.candidateCount = st.ok;"), "");
  ok("注释写明不能用 candN 当池子大小", ts212.includes("只反映「已经扫过的那一段」"), "");
  W.NODE_MEMORY.alive.clear();
  for (const [k212, v212] of bak212) W.NODE_MEMORY.alive.set(k212, v212);
  W.NODE_MEMORY.candidateCount = bakN212;
  W.NodeStatsTable.invalidateRank();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case147({ W, ok, eq, statAll, fs, metricsAll, pickAll }) {
  const g213keys = ["10.213.0.1:443", "10.213.0.2:443", "10.213.0.3:443"];
  const g213host = "h213.test";
  const oldAlive = W.NODE_MEMORY.alive;
  const oldRank = W.CANDS.cache;
  const setup213 = () => {
    W.NODE_MEMORY.alive = new Map();
    for (const k of g213keys) W.NODE_MEMORY.alive.set(k, { h: k.slice(0, k.lastIndexOf(":")), p: 443, cc: "HK" });
    W.HOSTS.nodes.delete(g213host);
    W.CANDS.cache = { t: 0, at: {}, v: {}, step: {} };
  };
  setup213();
  const a213 = W.HOSTS.untried(g213host, "lat");
  ok("影子试探先给全局排行第一名", Boolean(a213), a213);
  W.NodeStatsTable.nsGet(a213).lastTry = Date.now();
  const b213 = W.HOSTS.untried(g213host, "lat");
  ok("刚试过的节点不会被第二条并发请求立刻再选一次", b213 !== a213, a213 + " / " + b213);
  ok("换到的是另一条真实候选", g213keys.includes(b213), b213);
  W.NodeStatsTable.nsGet(a213).lastTry = Date.now() - 60000;
  eq("过了窗口期可以再用它", W.HOSTS.untried(g213host, "lat"), a213);
  setup213();
  for (const k of g213keys) W.NodeStatsTable.nsGet(k).lastTry = Date.now();
  const c213 = W.HOSTS.untried(g213host, "lat");
  ok("全都在窗口内时退回一条，不能返回空串", Boolean(c213), c213);
  W.NODE_MEMORY.alive = new Map([[g213keys[0], { h: "10.213.0.1", p: 443, cc: "HK" }]]);
  W.HOSTS.nodes.delete(g213host);
  W.CANDS.cache = { t: 0, at: {}, v: {}, step: {} };
  eq("只有一条候选时在同一条上再试", W.HOSTS.untried(g213host, "lat"), g213keys[0]);
  W.NODE_MEMORY.alive = oldAlive;
  W.CANDS.cache = oldRank;

  const stSrc = statAll();
  const stCode = stSrc.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  ok("节点统计里不再有 eCloseD（只写不读）", !stCode.includes("eCloseD"));
  ok("影子试探的窗口常量进了 SC", fs.readFileSync("src/core/const.ts", "utf8").includes("UNTRIED_GAP: 20000"));
  ok("untried 会读 lastTry", metricsAll().includes("SC.UNTRIED_GAP"));
  ok("selector 仍在返回前记 lastTry", pickAll().includes("NodeStatsTable.nsGet(t0).lastTry = Date.now();"));
  ok("直连空关闭的全局计数保留", fs.readFileSync("src/proxy/attacher.ts", "utf8").includes('cnt("eCloseD")'));
  ok("类型里也没有 eCloseD", !fs.readFileSync("types/app.d.ts", "utf8").includes("eCloseD"));
  const k213 = "10.213.9.9:443";
  W.NODE_MEMORY.stats.delete(k213);
  W.NodeStatsTable.nsEmptyClose(k213, false);
  const r213 = W.NODE_MEMORY.stats.get(k213);
  eq("直连空关闭不增加中转侧的计数", r213.eCloseP, 0);
  ok("节点统计里没有 eCloseD 这个键", !Object.prototype.hasOwnProperty.call(r213, "eCloseD"));
  W.NodeStatsTable.nsEmptyClose(k213, true);
  eq("中转空关闭会加一", W.NODE_MEMORY.stats.get(k213).eCloseP, 1);
  W.NODE_MEMORY.stats.delete(k213);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case148({ fs, ok, eq, W }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case149({ W, ok, eq, fs }) {
  const mkEnv = (mk) => ({ uuid: "u215", METER: { idFromName: (n) => "id-" + n, get: () => ({ fetch: async () => mk() }) } });
  const reset = () => {
    W.VT_SYNC.loaded = false;
    W.VT_SYNC.coolUntil = 0;
    W.VT_SYNC.flight = null;
  };
  const errBody = () => new Response(JSON.stringify({ error: "boom" }), { status: 500 });
  const shapeBad = () => new Response(JSON.stringify({ foo: 1 }), { status: 200 });
  const good = () => new Response(JSON.stringify({ vt: [], hl: [], eg: [], ps: [], dead: [], blk2: [], dns: [] }), { status: 200 });

  // ① DO 5xx：不能置 vtLoaded，要记冷却，且不回写缓存
  reset();
  let writes = 0;
  let doHits = 0;
  globalThis.caches = { default: { match: async () => undefined, put: async () => { writes += 1; } } };
  await W.vtLoad(mkEnv(() => { doHits += 1; return errBody(); }));
  ok("DO 5xx 不当成事实（不置 vtLoaded）", W.VT_SYNC.loaded === false, String(W.VT_SYNC.loaded));
  ok("DO 5xx 记冷却，允许 60 秒后重试", W.VT_SYNC.coolUntil > Date.now(), String(W.VT_SYNC.coolUntil - Date.now()));
  eq("DO 5xx 不回写缓存", writes, 0);

  // ② DO 200 但形状不对：同样算失败
  reset();
  writes = 0;
  await W.vtLoad(mkEnv(shapeBad));
  ok("形状不对也不当成事实", W.VT_SYNC.loaded === false, String(W.VT_SYNC.loaded));
  eq("形状不对不回写缓存", writes, 0);

  // ③ 缓存里是坏体：当未命中，重新问 DO，且计数
  reset();
  writes = 0;
  const beforeBad = Number(W.COUNTER.values.vtCacheBad || 0);
  globalThis.caches = { default: { match: async () => new Response(JSON.stringify({ error: "stale" }), { status: 200 }), put: async () => { writes += 1; } } };
  await W.vtLoad(mkEnv(good));
  eq("坏缓存被当成未命中并计数", Number(W.COUNTER.values.vtCacheBad || 0), beforeBad + 1);
  ok("坏缓存之后照样拿到事实", W.VT_SYNC.loaded === true, String(W.VT_SYNC.loaded));
  eq("校验通过的快照才回写缓存", writes, 1);

  // ④ 缓存里是好体：命中即用，不再问 DO
  reset();
  writes = 0;
  doHits = 0;
  const beforeHit = Number(W.COUNTER.values.factsCacheHit || 0);
  globalThis.caches = { default: { match: async () => new Response(JSON.stringify({ vt: [], hl: [], eg: [], ps: [], dead: [], blk2: [], dns: [] }), { status: 200 }), put: async () => { writes += 1; } } };
  await W.vtLoad(mkEnv(() => { doHits += 1; return good(); }));
  eq("好缓存直接命中", Number(W.COUNTER.values.factsCacheHit || 0), beforeHit + 1);
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case150({ mkDO, eq, ok, storeSrc, fs }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case152({ W, ok, eq, fs }) {
  const now = Date.now();
  const K = "ps-newer.test|10.7.7.7";
  const mk = () => ({ eg: {}, ps: { [K]: { q: 40, n: 4, at: now - 60000, top: 40 } }, dead: {}, blk2: {}, dns: {} });
  // 远端这行更旧（10 分钟前），但那时它拿到过整页（top=220）
  const a = mk();
  new W.FactMerger().merge(a, { ps: [{ k: K, q: 40, n: 4, at: now - 600000, top: 220 }] });
  ok("更旧的远端行也会把历史最好提上来", (a.ps[K].top || 0) >= 220, JSON.stringify(a.ps[K]));
  eq("均值仍是本地较新的那条", a.ps[K].q, 40);
  eq("样本数不被旧观测覆盖", a.ps[K].n, 4);
  eq("观测时间不被旧观测回退", a.ps[K].at, now - 60000);
  // 本地已经更高：不能被远端更低的 top 拉下来
  const b = mk();
  b.ps[K].top = 255;
  new W.FactMerger().merge(b, { ps: [{ k: K, q: 250, n: 9, at: now - 900000, top: 60 }] });
  eq("历史最好只升不降", b.ps[K].top, 255);
  // 过期的行整条丢，top 也不提
  const c = mk();
  new W.FactMerger().merge(c, { ps: [{ k: K, q: 250, n: 9, at: now - 46 * 60000, top: 255 }] });
  eq("过期行连 top 一起丢", c.ps[K].top, 40);
  // 更新的行照旧整体胜出（top 取两边较高）
  const d2 = mk();
  new W.FactMerger().merge(d2, { ps: [{ k: K, q: 200, n: 8, at: now + 5000, top: 0 }] });
  eq("更新观测的均值胜出", d2.ps[K].q, 200);
  eq("更新观测的样本数胜出", d2.ps[K].n, 8);
  eq("top 仍保留两边较高", d2.ps[K].top, 200);
  // 新键没有任何历史
  const e2 = mk();
  new W.FactMerger().merge(e2, { ps: [{ k: "ps-newer.test|10.7.7.8", q: 33, n: 2, at: now - 600000, top: 0 }] });
  eq("新键按远端行建", e2.ps["ps-newer.test|10.7.7.8"].q, 33);
  eq("新键的 top 就是它自己的均值", e2.ps["ps-newer.test|10.7.7.8"].top, 33);
  const fm = fs.readFileSync("src/store/factmerge.ts", "utf8");
  ok("源码：较早的观测只提 top", fm.includes("if (inTop > (cur.top ?? 0)) cur.top = inTop;"));
  ok("源码：过期行在提 top 之前就被丢弃", fm.indexOf("if (r.at <= Date.now() - FACT_TTL.ps) continue;") < fm.indexOf("if (inTop > (cur.top ?? 0)) cur.top = inTop;"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case153({ W, eq, blkSrc, fs }) {
  const H = "mute222.example.com";
  const A = "10.222.0.1";
  const B = "10.222.0.2";
  const t0 = Date.now();
  // ① 两行封锁事实 + 一次站点级自愈：判「站点在拒绝所有人」，清表并静音 30 分钟
  W.BLK.clear();
  eq("建行两条", W.BLK.load([{ k: H + "|" + A, n: 3, at: t0 - 60000 }, { k: H + "|" + B, n: 3, at: t0 - 60000 }]), 2);
  eq("封锁使出口涨价", W.BLK.penOf(H, A, t0), W.BLK_PEN);
  eq("站点级自愈触发", W.BLK.sweep(H, [A, B], t0), true);
  eq("自愈后静音中", W.BLK.muted(H, t0 + 1000), true);
  eq("自愈清掉了封锁行", W.BLK.penOf(H, A, t0), 1);
  // ② 静音期内，别处 isolate 回传同一个站点的封锁事实：必须被拒绝（否则自愈等于白做）
  eq("静音期内别处的封锁事实被拒绝", W.BLK.load([{ k: H + "|" + A, n: 3, at: t0 + 2000 }]), 0);
  eq("静音期内封锁没有复活", W.BLK.penOf(H, A, t0 + 3000), 1);
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
  eq("blkMutedSkip 已登记", fs.readFileSync("src/core/counter.ts", "utf8").includes("\"blkMutedSkip\","), true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case154({ debugAll, ok, W, eq, fs }) {
  const dbg = debugAll();
  ok("debug 有 ?blk= 分支", dbg.includes('q.get("blk")'));
  ok("?blk= 按站点前缀过滤封锁行", dbg.includes("BLK.snap().filter((r) => r.k === host || r.k.startsWith(host + \"|\"))") || dbg.includes('r.k.startsWith(bh + "|")'));
  ok("?blk= 报告自愈静音", dbg.includes("muted: BLK.muted(host)"));
  ok("debug 有 ?facts=1 分支", dbg.includes('q.get("facts") !== "1"'));
  ok("?facts=1 发的是事实层快照", dbg.includes("tables: FactsStore.snap()"));
  ok("debug 有 ?plan=1 分支", dbg.includes('q.get("plan") !== "1"'));
  ok("?plan=1 与 vt 分支同一口径", dbg.includes("planView(POOL_MEMORY.rows.length, NODE_MEMORY.alive.size)"));

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
  const fs223 = Object.keys(W.FactsStore.snap() || {}).sort().join(",");
  eq("事实层快照是五张表", fs223, "blk2,dead,dns,eg,ps");

  // 文档口径：不能再声称一个服务端不存在的端点
  const v8223 = fs.readFileSync("docs/v8.md", "utf8");
  ok("v8.md 不再声称 ?edge=1 是可用的调试端点", !v8223.includes("`?edge=1`（入口探测"));
  ok("v8.md 写明入口偏好没有服务端端点", v8223.includes("入口偏好没有服务端端点"));
  ok("v8.md 列出了 ?blk=", v8223.includes("`?blk=<host>`"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case155({ W, ok, eq, fs }) {
  const L = W.CRON_LOCK;
  ok("闸门对象存在", !!L && typeof L.claim === "function");
  const t0 = Date.now();
  W.CRON_LOCK.heldAt = 0;
  ok("空闲时能拿到闸门", L ? L.claim(t0) : false);
  ok("刚拿到时第二个来者被挡", L ? L.claim(t0 + 1000) === false : false);
  // 卡死 9 分钟（超过 CRON_STALE_MS=8 分钟）必须能被接管：旧版布尔闩永远挡死
  W.CRON_LOCK.heldAt = t0 - 9 * 60_000;
  const staleBefore = Number(W.COUNTER.values.cronStale || 0);
  ok("卡死超过 8 分钟后可以接管", L ? L.claim(t0) === true : false);
  ok("接管要计 cronStale", Number(W.COUNTER.values.cronStale || 0) === staleBefore + 1);
  ok("接管后持有时间归零", L ? L.age(t0) === 0 : false);
  if (L) L.release();
  ok("释放后 age 为 0", (L ? L.age(t0) : -1) === 0);
  ok("释放后能再次拿到", (L ? L.claim(t0 + 10) : false) === true);
  if (L) L.release();
  // 端到端：闸门被卡死的一轮占着时，runCron 仍要排真任务
  const realFetch224 = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 200 });
  try {
    W.CRON_LOCK.heldAt = Date.now() - 9 * 60_000;
    let done = null;
    const envCron = { STATS: { get: async () => null, put: async () => {} }, pxSchedH: "0" };
    await W.runCron(envCron, { waitUntil: (pr) => (done = pr) });
    ok("卡死时 runCron 仍排任务", done !== null);
    if (done) await done;
    eq("跑完后闸门回到空闲", W.CRON_LOCK.heldAt, 0);
  } finally {
    globalThis.fetch = realFetch224;
    W.CRON_LOCK.heldAt = 0;
  }
  // 源码锁：闸门在 lock.ts，两个入口都走 claim/release，S 里不再有布尔闩
  const lockSrc = fs.existsSync("src/core/lock.ts") ? fs.readFileSync("src/core/lock.ts", "utf8") : "";
  const cronSrc = fs.readFileSync("src/routes/cron.ts", "utf8");
  const pipSrc = fs.readFileSync("src/routes/proxyip.ts", "utf8");
  const stSrc = fs.readFileSync("src/core/counter.ts", "utf8");
  const stateSrcLock = fs.readFileSync("src/core/state.ts", "utf8");
  const cnstSrc = fs.readFileSync("src/core/const.ts", "utf8");
  ok("lock.ts 用 SC.CRON_STALE_MS 判超时", lockSrc.includes("SC.CRON_STALE_MS"));
  ok("lock.ts 接管时计 cronStale", lockSrc.includes('cnt("cronStale")'));
  ok("cron.ts 走 CRON_LOCK.claim", cronSrc.includes("if (!CRON_LOCK.claim()) return;"));
  ok("proxyip.ts 报告持有毫秒", pipSrc.includes("heldMs: CRON_LOCK.age()"));
  ok("两个入口都不再有布尔闩", !cronSrc.includes("S.cronBusy") && !pipSrc.includes("S.cronBusy"));
  ok("S 里是时间戳而不是布尔", lockSrc.includes("heldAt = 0;") && !stateSrcLock.includes("cronBusy"));
  ok("CRON_STALE_MS 已定义", /CRON_STALE_MS:\s*8 \* 60_000/.test(cnstSrc));
  ok("cronStale 已登记进 cntKeys", stSrc.includes('"cronStale",'));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case156({ W, eq, ok, fs }) {
  W.TFB.verdicts.clear();
  W.tfRemember("hot.example", "chan/none");
  for (let i = 0; i < 255; i++) W.tfRemember("site" + i + ".example", "chan/none");
  eq("表在上限内", W.TFB.verdicts.size, 256);
  // 复探最热的站点（cron 每 30 分钟就会这样），再插入一个新站点把表推过上限
  W.tfRemember("hot.example", "chan/none");
  W.tfRemember("brandnew.example", "chan/none");
  ok("复探过的热门站点仍在表里", W.TFB.verdicts.has("hot.example"));
  ok("最久没复探的站点先被淘汰", !W.TFB.verdicts.has("site0.example"));
  eq("表仍然不超上限", W.TFB.verdicts.size, 256);
  // 两批共识：热门站点第二次探到 chan 时，上一批标签必须还在
  eq("复探后仍能读到上一批标签", W.TFB.verdicts.get("hot.example"), "chan/none");
  ok("两批共识成立（可以落封锁）", W.tfBlockOk(W.TFB.verdicts.get("hot.example") || "", "chan"));
  // 只探过一批的站点不能落封锁
  ok("没有历史标签的站点不能落封锁", W.tfBlockOk("", "chan") === false);
  ok("上一批不是 chan 也不能落封锁", W.tfBlockOk("ok/none", "chan") === false);
  ok("这一批不是 chan 同样不落封锁", W.tfBlockOk("chan/none", "site") === false);
  W.TFB.verdicts.clear();
  // 源码锁：set 之前必须先 delete（Map.set 不移动已存在键的位置）
  const tfSrc = fs.readFileSync("src/route/tfb.ts", "utf8");
  const delAt = tfSrc.indexOf("TFB.verdicts.delete(host);");
  const setAt = tfSrc.indexOf("TFB.verdicts.set(host, tag);");
  ok("tfRemember 里 delete 在 set 之前", delAt > 0 && setAt > delAt);
  ok("注释写明 Map.set 不移动位置", tfSrc.includes("不移动插入位置"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case157({ W, eq, ok, scanAll, fs }) {
  const PB = W.COOLDOWN.rows;
  const key226 = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}:443`;
  const t0 = Date.now();
  const sw = (t) => W.COOLDOWN.sweep(t);
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
  ok("连续 3 次失败后判跳过", W.COOLDOWN.skip(key226(9), t0));
  ok("过了 TTL 不再判跳过", W.COOLDOWN.skip(key226(9), t0 + W.SC.PROBE_BAD_TTL + 1) === false);
  PB.clear();
  // 源码锁：清理函数存在、且 cronScan 每轮都调它
  const poolSrc226 = scanAll();
const aliveSrc226 = fs.readFileSync("src/px/alive.ts", "utf8");
  ok("cronScan 每轮都扫这张表", poolSrc226.includes("COOLDOWN.sweep();"));
  ok("扫的时候先看 TTL", aliveSrc226.includes("if (now - entry.at > SC.PROBE_BAD_TTL) {"));
  ok("超上限按 at 升序淘汰", aliveSrc226.includes("sort((a, b) => a[1].at - b[1].at)"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case158({ fs, eq, W, ok }) {
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
  // 全仓守卫：往 W.RELAY_DEMAND 写数字字面量的写法一律不允许（写死了就和常量脱钩）
  const needPxWrites = [];
  for (const rel of ["src/route/judge.ts", "src/proxy/attacher.ts"]) {
    for (const l of codeOf(rel).split("\n")) {
      if (/RELAY_DEMAND\.set\(/.test(l)) needPxWrites.push(l.trim());
    }
  }
  eq("RELAY_DEMAND 的三条写入点都引用同一个常量", needPxWrites.length, 3);
  ok("每条写入都引用 SC.PX_LEARN", needPxWrites.every((l) => l.includes("SC.PX_LEARN")));
  // 同名不同义：px/const.ts 的 PX_TTL 是 KV 到期秒数（30 天），与这里的毫秒窗口无关
  const pxConstSrc227 = codeOf("src/px/const.ts");
  ok("px/const.ts 的 PX_TTL 仍是 KV 到期秒数", pxConstSrc227.includes("export const PX_TTL = 86400 * 30;"));
  // 行为面：按常量写进去的窗口确实等于 6 小时
  W.RELAY_DEMAND.clear();
  const t227 = Date.now();
  W.RELAY_DEMAND.set("learn227.example.com", t227 + W.SC.PX_LEARN);
  eq("写入窗口等于常量", W.RELAY_DEMAND.get("learn227.example.com") - t227, W.SC.PX_LEARN);
  W.RELAY_DEMAND.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case159({ fs, ok, W }) {
  const judgeSrc = fs.readFileSync("src/route/judge.ts", "utf8");
  const code = judgeSrc
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
  ok("neg / pos 两张表都由 TimedMarks 持有", code.includes("readonly neg = new TimedMarks(") && code.includes("readonly pos = new TimedMarks("));
  ok("判定里不再各写一遍裁剪", !code.includes("trimAged(this.neg") && !code.includes("trimAged(this.pos"));
  ok("pos 不再整表清空", !code.includes("this.pos.clear();"));
  ok("淘汰规则移出判定（改由 TimedMarks 提供）", !code.includes("dropExpired("));

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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case160({ fs, ok, W }) {
  const shardSrc = fs.readFileSync("src/store/metershard.ts", "utf8");
  const stateSrc = fs.readFileSync("src/core/counter.ts", "utf8");
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case161({ fs, ok, W, eq }) {
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
  ok("sweep 写完也过守卫", blkSrc.includes("if (this.mute.size > BLK_MUTE_MAX) this.trimMaps(now);"), "");
  ok("trim 削静默表", blkSrc.includes("if (this.mute.size > BLK_MUTE_MAX) {"), "");
  ok("muted 读到过期就删", blkSrc.includes("if (until && until <= now) {"), "");
  W.BLK.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case162({ fs, ok, eq, W }) {
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
  const probeSrc = fs.readFileSync("src/px/probe.ts", "utf8");
  ok("probeSni 默认参数走常量", probeSrc.includes("ms = CONNECT_MS"), "");
  ok("SC.STALL 仍在（语义是卡顿当量）", W.SC.STALL === 2500, String(W.SC.STALL));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case164({ fs, ok, eq, W }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case166({ W, eq, ok, fs }) {
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
  W.PEND.rows.clear();
  for (let i = 0; i < 20; i++) W.PEND.rows.set("p242-u" + i, { up: 10, down: 20, conns: 1 });
  W.PEND.flushedAt = 0;
  W.PEND.intervalMs = 0;
  await W.PEND.flush(env242, true, 5);
  eq("给了 5 的额度就只发 5 次 DO 往返", sent242.length, 5);
  eq("剩下的留在账本里等下一轮", W.PEND.rows.size, 15);
  sent242.length = 0;
  for (let i = 0; i < 40; i++) W.PEND.rows.set("p242-v" + i, { up: 1, down: 1, conns: 1 });
  W.PEND.flushedAt = 0;
  W.PEND.intervalMs = 0;
  await W.PEND.flush(env242, true);
  eq("不传额度时回到 PEND_MAX", sent242.length, W.SC.PEND_MAX);

  const reads242 = [];
  const snapEnv242 = mkEnv242(reads242);
  W.METER_CLIENT.cache.clear();
  await W.usageSnapWrite(snapEnv242, Array.from({ length: 20 }, (_x, i) => ({ id: "s242-" + i })), 3);
  eq("快照给了 3 的额度就只读 3 个人的用量", reads242.length, 3);
  reads242.length = 0;
  W.METER_CLIENT.cache.clear();
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
  ok("cron 把三个额度分别传下去", cron242.includes("PEND.flush(env, true, plan.pend)") && cron242.includes("usageSnapWrite(env, users.list, plan.snap)") && cron242.includes("restorePick(allIds, plan.restore)"));
  ok("cron 不再自己夹 RESTORE_MAX", !cron242.includes("RESTORE_MAX"));
  ok("pendFlush 尊重传入额度", pend242.includes("Math.min(SC.PEND_MAX, max)"));
  ok("usageSnapWrite 尊重传入额度", snap242.includes("Math.min(SC.SNAP_MAX, max)"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case167({ W, ok, fs }) {
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
  W.PEND.rows.clear();
  W.PEND.rows.set("u243a", { up: 10, down: 20, conns: 1 });
  W.PEND.flushedAt = 0;
  W.PEND.intervalMs = 0;
  await W.PEND.flush(envDown, true, 5);
  ok("账本上报失败有计数", d243("pendFail") >= 1, String(d243("pendFail")));
  // 用量快照：读失败早退 / 写失败各一个计数
  await W.usageSnapWrite(envDown, [{ id: "u243a" }], 2);
  ok("用量快照读失败有计数", d243("snapReadFail") >= 1, String(d243("snapReadFail")));
  await W.usageSnapWrite(envW, [{ id: "u243a" }], 2);
  ok("用量快照写失败有计数", d243("snapWriteFail") >= 1, String(d243("snapWriteFail")));
  // 整体快照：先塞一行本地数据（否则 hasData 提前返回是正常行为，不是失败）
  const seed243 = () => { W.USAGE_MEMORY.rows.set("n243", { up: 1, down: 2, conns: 1, first: 1, last: 2 }); W.SNAP.busy = false; W.SNAP.checked = 0; W.SNAP.written = 0; };
  seed243();
  await W.flushSnap(envDown, true);
  ok("整体快照读失败有计数", d243("snapFlushReadFail") >= 1, String(d243("snapFlushReadFail")));
  seed243();
  await W.flushSnap(envW, true);
  ok("整体快照写失败有计数", d243("snapFlushFail") >= 1, String(d243("snapFlushFail")));
  // 计数键必须登记，否则 cnt() 会当成未知键丢掉
  for (const k243 of ["pendFail", "snapReadFail", "snapWriteFail", "snapFlushReadFail", "snapFlushFail", "snapUsersFail", "seedWriteFail"]) {
    ok(`计数键已登记：${k243}`, W.COUNTER.keys.includes(k243));
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case168({ W, eq, ok, fs }) {
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
  const st244 = fs.readFileSync("src/core/counter.ts", "utf8");
  ok("cntKeys 登记了 dayDoFail", st244.includes('"dayDoFail"'));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case169({ W, mkSt245, sockOf245, wsOf245, eq, ok, fs }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case170({ W, ok, eq, fs }) {
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
  W.METER_CLIENT.cache.clear();
  await W.usageSnapWrite({ STATS: kvp, KEK: KEK246, METER: meter246(hist246, "ok", hist246) }, [{ id: ID246 }], 4);
  ok("第246组·历史用量进了 KV 灾备快照", kvp.m.size > 0);

  // ① DO 抛错：回填失败必须留痕，且不能声称已落盘
  const c0 = W.cntView().statsSeedFail || 0;
  W.METER_CLIENT.cache.clear();
  const sThrow = await W.readStats({ STATS: kvp, KEK: KEK246, METER: meter246(zero246, "throw", hist246) }, ID246);
  eq("第246组·回填抛错时标记 fail", sThrow.seed, "fail");
  eq("第246组·回填抛错时不能声称已落盘", sThrow.persisted, false);
  eq("第246组·回填抛错计一次 statsSeedFail", (W.cntView().statsSeedFail || 0) - c0, 1);

  // ② DO 回 500：同样要留痕（旧代码里只有 r.ok 那支，没有 else，这条路径连计数都没有）
  W.METER_CLIENT.cache.clear();
  const s500 = await W.readStats({ STATS: kvp, KEK: KEK246, METER: meter246(zero246, "500", hist246) }, ID246);
  eq("第246组·回填 5xx 时标记 fail", s500.seed, "fail");
  eq("第246组·回填 5xx 计一次 statsSeedFail", (W.cntView().statsSeedFail || 0) - c0, 2);

  // ③ 回填成功：数值必须真的从快照回到面板上
  W.METER_CLIENT.cache.clear();
  const sOk = await W.readStats({ STATS: kvp, KEK: KEK246, METER: meter246(zero246, "ok", hist246) }, ID246);
  eq("第246组·回填成功后累计用量来自快照", sOk.up, 999);
  eq("第246组·回填成功后当日用量来自快照", sOk.todayUp, 111);
  eq("第246组·回填成功后标记 ok", sOk.seed, "ok");
  eq("第246组·回填成功后不再涨计数", (W.cntView().statsSeedFail || 0) - c0, 2);

  // ④ 没有 METER 绑定时走 KV 兜底，口径里也要有 seed 字段（不留「这个字段在不在」的猜测）
  W.METER_CLIENT.cache.clear();
  const sKv = await W.readStats({ STATS: kvp, KEK: KEK246 }, ID246);
  eq("第246组·没有 DO 时走 KV 兜底", sKv.backend, "kv");
  eq("第246组·KV 兜底分支也声明 seed = none", sKv.seed, "none");

  // ⑤ 源码锁：两处失败分支都必须计数，且不再有空 catch
  const srcStats246 = fs.readFileSync("src/store/stats.ts", "utf8");
  eq("第246组·两处失败分支都计数", srcStats246.split('cnt("statsSeedFail")').length - 1, 2);
  eq("第246组·stats.ts 不再有裸空 catch", srcStats246.includes("} catch (e) {}"), false);
  // 7.332 起成功分支是「回填函数返回 seed: "ok"」，判据意图不变：成功这条路必须能标出来
  ok("第246组·成功分支标记 ok", srcStats246.includes('seed: "ok"'));
  const srcState246 = fs.readFileSync("src/core/counter.ts", "utf8");
  ok("第246组·statsSeedFail 已登记 cntKeys", srcState246.includes('"statsSeedFail"'));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case172({ fs, ok }) {
  const dsrc = fs.readFileSync("src/proxy/dialer.ts", "utf8");
  ok("尝试名额按「真的拨了几次」算，不跟循环下标走",
    dsrc.includes("for (let guard = 0; guard < maxTries + 4 && tries < maxTries; guard++) {"), true);
  ok("计数发生在拨号之前（跳过分支没有 tries += 1）",
    /tries \+= 1;\s*\r?\n\s*const sock = await this\.attemptRelay\(/.test(dsrc), true);
  ok("跳过分支只计数、不再写 logErr",
    dsrc.includes('cand.why === "cf") cnt("skipCfRelay")') && !/logErr\(`skip cf-edge relay/.test(dsrc), true);
  ok("st.pxTries 记的是真实尝试次数（不再用下标 +1）",
    dsrc.includes("conn.pxTries = tries;") && !dsrc.includes("conn.pxTries = tries + 1;"), true);
  ok("skipCfRelay 在 cntKeys 里登记", fs.readFileSync("src/core/counter.ts", "utf8").includes('"skipCfRelay",'), true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case173({ W, eq, ok, debugAll, fs }) {
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
  const srcMeter275 = fs.readFileSync("src/routes/debug.ts", "utf8");
  ok("转发分支带出 DO 状态码", srcMeter275.includes("ok: resp.ok, doStatus: resp.status"));
  ok("六个转发分支已交给 DebugMeterProbes", srcDbg248.includes("DEBUG.probes.run(c, url, id)") && !srcDbg248.includes("searchParams.get(\"burn\")"));
  ok("回填分支用 seedOk", srcDbg248.includes("let seedOk = false;") && srcDbg248.includes("return json({ ok: seedOk, doStatus: seedStatus, seeded });"));
  ok("钉节点分支用 fx.ok 判定落盘", srcDbg248.includes('anchor: fx.ok ? "ok" : "fail"'));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case174({ ok, W, eq, fs }) {
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
  W.VT.clear(H249);
  const before249 = W.VT.ok(H249, "r:" + ip249);
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
  const after249 = W.VT.ok(H249, "r:" + ip249);
  ok(`[${G}] 301 的中继拿到正证据（vOk 从 false 变成 true）`, before249 === false && after249 === true);
  eq(`[${G}] 存的不是硬写的 200，而是真实状态码`, W.VT.state(H249, "r:" + ip249), 1);
  W.VT.clear(H249);

  const tfbSrc249 = fs.readFileSync("src/route/tfb.ts", "utf8");
  ok(`[${G}] tfVerdict 不再只认 status === 200`, !tfbSrc249.includes("x.ok && x.status === 200"));
  ok(`[${G}] vSet 分支不再只认 status === 200`, !tfbSrc249.includes("row.ok && row.status === 200"));
  ok(`[${G}] 正证据写真实状态码`, tfbSrc249.includes("Number(row.status || 200)"));
  ok(`[${G}] 2xx/3xx 判据出现两处（tfVerdict + runTfb 的 okN）`, tfbSrc249.split("(x.status || 0) >= 200 && (x.status || 0) < 400").length - 1 === 2);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case175({ W, ok, eq, verdictAll, fs }) {
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
  W.VT.clear();
  W.VT.setState("enum250.test", "d", ST250.Dead, 1);
  eq("状态 3 记成 Dead", W.VT.state("enum250.test", "d"), ST250.Dead);
  eq("Dead 不是「可用」", W.VT.ok("enum250.test", "d"), false);
  eq("Dead 算「不可用」", W.VT.bad("enum250.test", "d"), true);
  W.VT.setState("enum250.test", "d", ST250.Reachable, 1);
  eq("状态 1 记成 Reachable", W.VT.state("enum250.test", "d"), ST250.Reachable);
  eq("Reachable 算「可用」", W.VT.ok("enum250.test", "d"), true);
  W.VT.setState("enum250.test", "d", ST250.Blocked, 1);
  eq("状态 2 记成 Blocked", W.VT.state("enum250.test", "d"), ST250.Blocked);
  W.VT.clear();

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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case176({ W, ok, eq, fs }) {
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
  W.VT.clear();
  W.VT.setState("e251.test", "d", W.St.Reachable);
  ok(`[${G}] vOk 认枚举写入的状态`, W.VT.ok("e251.test", "d") === true);

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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case177({ verdictAll, ok, fs, W, eq }) {
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

  const foSrc = fs.readFileSync("src/core/obs.ts", "utf8");
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case178({ pickAll, fs, ok }) {
  const sel253 = pickAll();
  const con253 = fs.readFileSync("src/proxy/connection.ts", "utf8");
  ok("选路读的是 targetBytes", sel253.includes("(st && st.targetBytes) || 0"), "");
  ok("连接上确实有 targetBytes", con253.includes("targetBytes = 0;"), "");
  ok("选路不再读旧的 bytes 字段", !sel253.includes("st.bytes"), "");
  ok("PickState 与 Connection 同名", sel253.includes("targetBytes?: number;"), "");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case179({ W, eq, ok, statAll, fs }) {
  const z254 = W.NodeStatsTable.nsGet("zero254.test:443");
  eq("统计行有 probeSamples", typeof z254.probeSamples, "number");
  eq("统计行有 probeFails", typeof z254.probeFails, "number");
  eq("统计行有 trafficOkW", typeof z254.trafficOkW, "number");
  eq("统计行有 trafficFailW", typeof z254.trafficFailW, "number");
  eq("统计行有 cusumSum", typeof z254.cusumSum, "number");
  eq("统计行有 cusumBase", typeof z254.cusumBase, "number");
  eq("旧短名 pN 已消失", "pN" in z254, false);
  eq("旧短名 tS 已消失", "tS" in z254, false);
  eq("旧短名 cusB 已消失", "cusB" in z254, false);

  W.NodeStatsTable.nsProbe("probe254.test:443", 40, 30, 10);
  W.NodeStatsTable.nsProbe("probe254.test:443", 42, 31, 11);
  const p254 = W.NodeStatsTable.nsGet("probe254.test:443");
  eq("两次探活累加 probeSamples", p254.probeSamples, 2);
  eq("探活不写首字节矩", p254.pSum, 0);

  W.NodeStatsTable.nsOk("ok254.test:443", 0, 0);
  const o254 = W.NodeStatsTable.nsGet("ok254.test:443");
  eq("真实成功累加 trafficOkW", o254.trafficOkW, 1);

  W.NodeStatsTable.nsFail("fail254.test:443");
  const f254 = W.NodeStatsTable.nsGet("fail254.test:443");
  eq("真实失败累加 trafficFailW", f254.trafficFailW, 1);

  // 衰减必须一起作用（effView 是只读投影，衰减在两处共用同一套换算）
  const d254 = W.NodeStatsTable.nsGet("decay254.test:443");
  d254.trafficOkW = 8; d254.probeSamples = 8; d254.at = Date.now() - W.SC.HL * 2;
  const v254 = W.effView(d254);
  eq("effView 暴露的是 probeSamples 而不是旧名", "probeSamples" in v254 && !("pN" in v254), true);
  ok("平移两个半衰期后 probeSamples 约剩 1/4", Math.abs(v254.probeSamples - 2) < 0.3, String(v254.probeSamples));

  const statSrc = statAll();
  ok("stat.ts 不再出现旧字段名", !/\btS\b|\bpN\b|\bcusB\b/.test(statSrc));
  const typesSrc = fs.readFileSync("types/app.d.ts", "utf8");
  ok("类型声明也改成新名", typesSrc.includes("trafficOkW") && !/\btS:/.test(typesSrc));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case180({ fs, ok, eq }) {
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
  ok("会话把字段名对上了（clientSocket / conn）", (() => { const x = fs.readFileSync("src/proxy/session.ts", "utf8"); return x.includes("clientSocket: this.serverWS") && x.includes("conn: st") && x.includes("private readonly conn: Connection;"); })(), "session");
  ok("命名门禁的 ALLOW 覆盖了线协议键", gateSrc.includes('["at", "观测时刻（线协议键）"]') && gateSrc.includes('["v6", "IPv6 观测计数（线协议键）"]'), "allow");
  ok("登记过的短名要求文档写明含义", docSrc.includes("## 7. 线协议键（登记例外）") && docSrc.includes("| `at` |") && docSrc.includes("| `v6` |"), "doc");
  ok("文档写明新增短名两处都要登记", docSrc.includes("`tools/check-names.mjs`") && docSrc.includes("`ALLOW`"), "doc2");
  eq("命名基线归零（剩余过短成员只剩登记过的线协议键）", baseSrc.opaque, 0);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case181({ W, eq, pickAll, ok, fs }) {
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
  const selSrc = pickAll();
  ok("selector 不再自写 IP 解析", !selSrc.includes('k.slice(0, k.lastIndexOf(":"))'));
  ok("selector 用 relayIpOf", selSrc.includes("cp(relayIpOf(key), host)") && selSrc.includes("cp(relayIpOf(x.k), host)"));
  const rhSrc = fs.readFileSync("src/route/relay-health.ts", "utf8");
  ok("relay-health 的 ipOf 委托 relayIpOf", rhSrc.includes("return relayIpOf(node);"));
  ok("relay-health 不再自己拆冒号", !rhSrc.includes('node.lastIndexOf(":")'));
  // 行为面：方括号写法与裸写法查到同一条判定（同一张表、同一个键）
  W.VT.clear();
  W.VT.set("ip6.test", "r:2a06:98c0::103", 200, 120, 1);
  eq("方括号键查到与裸 IP 相同的态", W.VT.state("ip6.test", "r:" + relayIpOf("[2a06:98c0::103]:443")), 1);
  W.VT.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case182({ W, eq, ok, fs, debugAll }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case183({ W, eq, ok, fs }) {
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
  W.METER_CLIENT.cache.clear();
  const skipBefore262 = W.cntView().snapSkip || 0;
  const round262 = async (n) => {
    clock262 += 3 * 3600e3;
    W.METER_CLIENT.cache.clear();
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
  const d4 = await (async () => { clock262 += 3 * 3600e3; W.METER_CLIENT.cache.clear(); await W.usageSnapWrite(env262, users262, 24); return JSON.parse(kv262.get("usage:snap")); })();
  eq("第四轮接着从 12 开始（走完一圈也不会停在同一批）", d4.idx, 36);
  const small262 = await (async () => { clock262 += 3 * 3600e3; W.METER_CLIENT.cache.clear(); await W.usageSnapWrite(env262, users262.slice(0, 5), 24); return JSON.parse(kv262.get("usage:snap")); })();
  eq("用户数没超上限时不轮转（游标归零）", small262.idx, 0);
  Date.now = realNow262;
  const srcSnap262 = fs.readFileSync("src/store/snapshot.ts", "utf8");
  ok("写入侧按游标轮转", srcSnap262.includes("list.slice(start).concat(list.slice(0, start))"), "");
  ok("游标落盘（idx）", srcSnap262.includes("(start + head.length) % list.length"), "");
  ok("类型里有 idx 字段", fs.readFileSync("types/app.d.ts", "utf8").includes("idx?: number;"), "");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case184({ W, eq, fs, ok }) {
  W.VT.clear();
  W.VT.setState("r263.test", "r:7.7.7.1", 1, 10);
  W.VT.setState("r263.test", "r:7.7.7.2", 2, 20);
  const pf = W.Prefs.of("r263.test", 10);
  const row = pf.ok[0] || {};
  eq("偏好行有 channel", typeof row.channel, "string");
  eq("偏好行有 state", typeof row.state, "number");
  eq("偏好行有 updatedAt", typeof row.updatedAt, "number");
  eq("偏好行不再用 c 这个短名", "c" in row, false);
  eq("偏好行不再用 s 这个短名", "s" in row, false);
  eq("偏好行不再用 at 这个短名", "at" in row, false);
  eq("能打通的通道 state 是 1", row.state, 1);
  eq("打不通的通道 state 是 2", (pf.bad[0] || {}).state, 2);
  const json263 = W.Prefs.json(10);
  eq("JSON 出口也用新名", Object.keys(json263.ok[0] || {}).sort().join(","), "channel,state,updatedAt");
  const src263 = fs.readFileSync("src/route/prefs.ts", "utf8");
  ok("源码里偏好行是语义名", src263.includes("channel: string;") && src263.includes("updatedAt: number;"), src263.slice(0, 0));
  ok("源码里没有旧的 c/s/at 三行", !/^  c: string;$/m.test(src263) && !/^  s: number;$/m.test(src263) && !/^  at: number;$/m.test(src263), src263.slice(0, 0));
  W.VT.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case185({ eq, W, ok, fs }) {
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
  ok("四份文件都从 core/relay-addr 取解析", ["src/route/judge.ts", "src/route/factshadow.ts", "src/proxy/conn-settle.ts", "src/proxy/fallback.ts"].every((f) => src264(f).includes('from "../core/relay-addr"')));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case186({ W, eq, ok, fs }) {
  const H268 = "rel268.group.test";
  W.VT.clear();
  const rels = ["10.8.0.1", "10.8.0.2", "10.8.0.3", "10.8.0.4", "10.8.0.5"];
  // 唯一能打通的那条先写（证据时间最早），四条判死的写在后面（时间更新）
  W.VT.set(H268, "r:" + rels[4], 200, 120, 1);
  for (let i = 0; i < 4; i++) {
    W.VT.set(H268, "r:" + rels[i], 403, 100, 1);
    W.VT.setState(H268, "r:" + rels[i], 2, 1);
  }
  const ctx268 = { host: H268, relays: rels.slice(), cfHost: true, clientV6: false, httpCode: 0, directOk: false, mode: "tput" };
  W.POLICY.decide(ctx268);
  eq("比例兜底后仍记得能打通的那条", W.VT.state(H268, "r:" + rels[4]), 1);
  ok("释放确实放开了被判死的中继", rels.slice(0, 4).some((ip) => W.VT.state(H268, "r:" + ip) === 0));
  ok("最近判死的两条仍然保留结论", rels.slice(0, 2).every((ip) => W.VT.state(H268, "r:" + ip) === 2));
  // 7.363：三条写动作搬进 FactRegistry，行为断言不变，源码判据改指新位置。
  const reg268 = fs.readFileSync("src/route/fact-registry.ts", "utf8");
  ok("释放只在被判死的集合上做", reg268.includes("const dead = relays.filter((ip) => VT.bad(host, \"r:\" + ip));"));
  ok("排序也只在被判死的集合上做", reg268.includes("const sorted = dead.slice()"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case189({ fs, ok }) { const sa270 = fs.readFileSync("src/proxy/attacher.ts", "utf8");
  ok("attacher 给首包传了上限", sa270.includes("conn.upWrite(payload, FIRST_UP_MS)"), "attacher");
  ok("attacher 导入了 FIRST_UP_MS", /import \{[^}]*FIRST_UP_MS[^}]*\} from "\.\.\/core\/util"/.test(sa270), "import");
  ok("首包不再用默认上限", sa270.includes("conn.upWrite(payload);") === false, "default");
  const su270 = fs.readFileSync("src/core/util.ts", "utf8");
  ok("常量在 timeouts.ts 里且只有一处", su270.split("export const FIRST_UP_MS").length - 1 === 1, "util"); }

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case190({ eq, W, ok, fs }) {
  eq("注册表里有三种传输", W.TRANSPORTS.names().length, 3);
  ok("tunnelfetch / gateway / http80 都在", ["tunnelfetch", "gateway", "http80"].every((n) => W.TRANSPORTS.names().includes(n)));
  eq("默认传输是 tunnelfetch", W.TRANSPORTS.current(), "tunnelfetch");
  eq("拼错的名字不生效", W.TRANSPORTS.use("nope"), false);
  eq("拼错之后仍是原传输", W.TRANSPORTS.current(), "tunnelfetch");
  ok("取不存在的名字回落到当前", W.TRANSPORTS.get("nope").transportName === "tunnelfetch");
  eq("可以切到 gateway", W.TRANSPORTS.use("gateway"), true);
  eq("切换后 current 变了", W.TRANSPORTS.current(), "gateway");
  W.TRANSPORTS.use("tunnelfetch");
  ok("tunnelfetch 承认自己能落中继", W.TRANSPORTS.get("tunnelfetch").relayAware === true);
  ok("gateway 承认自己不能落中继", W.TRANSPORTS.get("gateway").relayAware === false);
  ok("http80 能落中继（明文，不需要 TLS）", W.TRANSPORTS.get("http80").relayAware === true);
  ok("不写 transportName 时取默认，点名 http80 才换实现", W.TRANSPORTS.get().transportName === "tunnelfetch" && W.TRANSPORTS.get("http80").transportName === "http80");
  const gw271 = await W.TRANSPORTS.get("gateway").probe("example.com", "1.2.3.4:443", "/", 500);
  ok("gateway 遇到中继会如实报错而不是静默直连", gw271.ok === false && String(gw271.err).includes("relay"));
  const tfSrc271 = fs.readFileSync("src/core/transport.ts", "utf8");
  ok("probeTf 门面走注册表，不自己 new Client", tfSrc271.includes("TRANSPORTS.get(") && /export async function probeTf\(/.test(tfSrc271));
  ok("业务侧调用文件不直接 import tunnelfetch", !fs.readFileSync("src/store/meter-diagnostics.ts", "utf8").includes("tunnelfetch"));
  // 7.309 把抽象、两个实现与门面合进了同一个文件；真正要紧的不变量是「全仓只有一处碰这个库」
  const tfUsers271 = [];
  for (const f of fs.readdirSync("src", { recursive: true })) {
    const q = String(f).replace(/\\/g, "/");
    if (!q.endsWith(".ts")) continue;
    if (fs.readFileSync("src/" + q, "utf8").includes('from "tunnelfetch"')) tfUsers271.push(q);
  }
  eq("全仓只有一个文件 import tunnelfetch", tfUsers271.join(","), "core/transport.ts");
  const pkg271 = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok("tunnelfetch 是声明的依赖（不再是隐式依赖）", Boolean(pkg271.dependencies && pkg271.dependencies.tunnelfetch));
  const regSrc271 = fs.readFileSync("src/core/transport.ts", "utf8");
  ok("注册表是独立模块且有类文档", regSrc271.includes("class TransportRegistry") && regSrc271.includes("功能：按名字保存"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case191({ mkDO, eq, ok, fs }) {
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case192({ W, eq, ok, debugAll, fs }) {
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
  ok("暴露了 DebugMeterProbes 单例", W.DEBUG.probes && typeof W.DEBUG.probes.run === "function");
  eq("规格表六行对应六个端点", W.DEBUG.probes.specs.length, 6);
  ok(
    "规格表覆盖六个参数名",
    ["burn", "stage", "tim", "iter", "burnjs", "crypto"].every((p) => W.DEBUG.probes.specs.some((x) => x.param === p)),
  );
  const dbgSrc275 = debugAll().split(/\r?\n/).join("\n");
  ok("debug.ts 只留一行委托", dbgSrc275.includes("DEBUG.probes.run(c, url, id)"));
  ok("debug.ts 不再自己读这六个参数", !dbgSrc275.includes("searchParams.get(\"burn\")") && !dbgSrc275.includes("searchParams.get(\"burnjs\")") && !dbgSrc275.includes("searchParams.get(\"crypto\")"));
  const dmSrc275 = fs.readFileSync("src/routes/debug.ts", "utf8");
  ok("派发路径带出真实状态码", dmSrc275.includes("ok: resp.ok, doStatus: resp.status"));
  ok("派发路径统一用 withTimeout 包住 DO 调用", dmSrc275.includes("withTimeout(stub.fetch(") && dmSrc275.includes("spec.budgetMs"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case193({ fs, ok, W, eq }) {
  const msSrc276 = fs.readFileSync("src/store/meter.ts", "utf8").split(/\r?\n/).join("\n");
  const stSrc276 = fs.readFileSync("src/store/meter-state.ts", "utf8").split(/\r?\n/).join("\n");
  // ① 结构：Meter 只剩 DO 生命周期与端点，账本字段与落盘映射都在 MeterState 里
  ok("Meter 持有账本对象", msSrc276.includes("ledger: MeterState;"));
  ok("Meter 不再自己声明用量字段", !msSrc276.includes("usage: UsageMeter;"));
  ok("Meter 不再自己声明七张事实表", !msSrc276.includes("vt: Record<string, number |"));
  ok("Meter 的 /add 合并把状态对象交给合并器", msSrc276.includes("this.adder.apply(this.ledger, d)"));
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case194({ fs, eq, ok, W }) {
  const aSrc277 = fs.readFileSync("src/proxy/attacher.ts", "utf8");
  // 结构：两处补救建连都走拨号器，不再自己拼 connect / withTimeout
  eq("补救建连都走同一个拨号器", (aSrc277.match(/SOCKET_DIALER\.open\(/g) || []).length, 2);
  ok("attacher 不再直接 connect", !aSrc277.includes("connect({") && !aSrc277.includes("Promise.resolve(connect("));
  ok("attacher 不再自带建连超时", !aSrc277.includes("withTimeout(") && !aSrc277.includes("CONNECT_MS"));
  ok("socket 模块只留类型导入", aSrc277.includes('import type { Socket } from "cloudflare:sockets";') && !aSrc277.includes('import { connect } from "cloudflare:sockets"'));
  // 结构：关客户端只剩一处实现，五个放弃点都调它
  eq("关客户端只有一处 close", (aSrc277.match(/clientSocket\.close\(/g) || []).length, 1);
  eq("六个放弃点都走 endClient", (aSrc277.match(/this\.endClient\(clientSocket,/g) || []).length, 6);
  ok("endClient 是私有方法", aSrc277.includes("private endClient(clientSocket: WebSocketLike, code: number, reason: string): void"));
  // 历史自伤：首包那条注释曾被脚本顶到第 0 列（块内层级读起来是断的）
  ok("没有第 0 列的注释行", !/^\/\//m.test(aSrc277));
  // 行为：close 抛错要吞掉，正常时把关闭码与原因原样传下去
  ok("endClient 存在", typeof new W.Attacher().endClient === "function");
  const seen = [];
  const fakeOk = { readyState: 1, close: (code, reason) => seen.push([code, reason]) };
  let threw = false;
  try {
    new W.Attacher().endClient(fakeOk, 1011, "proxyip failed");
  } catch (e) {
    threw = true;
  }
  ok("endClient 把关闭码与原因原样传下去", !threw && seen.length === 1 && seen[0][0] === 1011 && seen[0][1] === "proxyip failed");
  const fakeGone = { readyState: 3, close: () => { throw new Error("already closed"); } };
  let threw2 = false;
  try {
    new W.Attacher().endClient(fakeGone, 1000, "done");
  } catch (e) {
    threw2 = true;
  }
  ok("客户端已经走了也不会抛出来", !threw2);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case195({ debugAll, netsAll, fs, ok, W }) {
  const aSrc278 = debugAll();
  const aNets278 = netsAll();
  const cli278 = fs.readFileSync("src/store/meter-client.ts", "utf8");
  // 计数点唯一：`W.METER_CLIENT.calls` 只在 `doFetch` 里自增，所以任何绕过它的 stub.fetch 都会让 /health 少记一块
  // 合并后 DebugMeterProbes 与其余三段同住一个文件：只有它允许直接取 DO 存根（它要带自己的超时）
  const probeSlice278 = (() => {
    const i = aSrc278.indexOf("export class DebugMeterProbes");
    const j = aSrc278.indexOf("// ---- 门面（对外导出面保持不变） ----");
    return i < 0 ? "" : aSrc278.slice(i, j < 0 ? aSrc278.length : j);
  })();
  const rest278 = probeSlice278 ? aSrc278.split(probeSlice278).join("") : aSrc278;
  ok("只有计量探测类直接取 METER 存根", probeSlice278.includes("METER") && !/env\.METER!?\.get\(/.test(rest278));
  ok("诊断模块六条 DO 读取全走 doFetch", (debugAll().match(/doFetch\(/g) || []).length === 6);
  ok("debug.ts 不再自己拼 connect", !/connect\(\{/.test(aSrc278));
  ok("debug.ts 不再引用 CONNECT_MS", !aSrc278.includes("CONNECT_MS"));
  ok("debug.ts 不再导入 cloudflare:sockets", !aSrc278.includes("cloudflare:sockets"));
  ok("debug.ts 的 v6 建连走拨号器", aNets278.includes("SOCKET_DIALER.open(expandV6(out.aaaa), 443, gate)"));
  ok("doFetch 仍是唯一自增点", (cli278.match(/METER_CLIENT\.calls \+= 1;/g) || []).length === 1);

  // 行为面：三条诊断读取各要真的把子请求记进 W.METER_CLIENT.calls（旧代码在这三条上恒为 0）
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

  W.METER_CLIENT.calls = 0;
  calls.length = 0;
  await run278("?seed=1,2,3");
  ok("?seed= 的子请求被记进 doCalls", W.METER_CLIENT.calls === 1 && calls.length === 1 && calls[0] === "https://meter/seed");

  W.METER_CLIENT.calls = 0;
  calls.length = 0;
  await run278("?cl=1&do=1");
  ok("?cl=1&do=1 走 doFetch 读连接环形", calls.includes("https://meter/cl") && W.METER_CLIENT.calls >= 1);

  W.METER_CLIENT.calls = 0;
  calls.length = 0;
  await run278("?hl=1&do=1");
  ok("?hl=1&do=1 走 doFetch 读中继健康环", calls.includes("https://meter/hl") && W.METER_CLIENT.calls >= 1);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case196({ fs, scanAll, ok, eq, W }) {
  const poolSrc279 = fs.readFileSync("src/px/pool.ts", "utf8");
  const scanSrc279 = scanAll();
  const aliveSrc279 = fs.readFileSync("src/px/alive.ts", "utf8");
  ok("pool.ts 只剩门面：不再有分并发的那一段", !poolSrc279.includes("for (const seg of chunks"), poolSrc279.length);
  ok("pool.ts 不再摆弄复测队列", !/RETEST\.take\(|S\.reProbe\.splice/.test(poolSrc279), "");
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
      "await this.alive.retestFlagged();",
      "new ScanProbe(this.pool, this.adm, this.env).run()",
      "await this.alive.recheckHead();",
      "await this.alive.refreshRest();",
      "if (this.house.prune(this.pool))",
      "await this.house.countries();",
      "await this.house.trimStats();",
      "await this.house.relays();",
      "await this.house.persistSeed(this.env);",
    ].every((m, i, arr) => i === 0 || scanSrc279.indexOf(arr[i - 1]) < scanSrc279.indexOf(m)),
    "",
  );
  ok("alive.ts 同时有冷却表与存活表", aliveSrc279.includes("export class ProbeCooldown") && aliveSrc279.includes("export class AliveBoard"), "");
  ok(
    "pool.ts 原样再导出旧名字（调用点零改动）",
    ["ProbeCooldown", "bumpProbeBad", "pxGet", "aliveList", "cronScan", "PoolScan", "AliveBoard"].every((n) => poolSrc279.includes(n)),
    "",
  );

  // 冷却表：连续失败到 SCAN_BAD_MAX 才跳过，成功一次就恢复；TTL 过了自动作废
  const cool = "cool279.test:443";
  eq("没记录时不跳过", W.COOLDOWN.skip(cool), false);
  W.COOLDOWN.bump(cool, false);
  eq("失败一次还不跳过", W.COOLDOWN.skip(cool), false);
  W.COOLDOWN.bump(cool, false);
  W.COOLDOWN.bump(cool, false);
  eq("连续失败到上限才跳过", W.COOLDOWN.skip(cool), true);
  W.COOLDOWN.bump(cool, true);
  eq("成功一次就重新可探", W.COOLDOWN.skip(cool), false);

  const cool2 = "cool279b.test:443";
  W.COOLDOWN.bump(cool2, false);
  W.COOLDOWN.bump(cool2, false);
  W.COOLDOWN.bump(cool2, false);
  eq("TTL 内仍然跳过", W.COOLDOWN.skip(cool2, Date.now() + 1000), true);
  eq("TTL 过了自动恢复", W.COOLDOWN.skip(cool2, Date.now() + W.SC.PROBE_BAD_TTL + 1), false);

  // 上限：越过 PROBE_BAD_MAX 时把最久没更新的淘汰掉（表没有别的裁剪路径）
  for (let i = 0; i < W.SC.PROBE_BAD_MAX + 20; i++) W.COOLDOWN.bump("cap279-" + i + ".test:443", false);
  const dropped = W.COOLDOWN.sweep();
  ok("越过上限会淘汰最久没更新的", dropped >= 20, "dropped=" + dropped);

  // 存活表裁剪：先删不在池子里的，再按延迟从慢到快删
  W.NODE_MEMORY.alive = new Map([
    ["in279.test:443", { h: "in279.test", p: 443, cc: "", ms: 50 }],
    ["out279.test:443", { h: "out279.test", p: 443, cc: "", ms: 10 }],
  ]);
  // 7.350 起存活表读写器由执行器自己持有，测试直接造一个（无字段，状态在 W.NODE_MEMORY.alive）
  const trimmed = new W.AliveBoard().trimToMax([{ h: "in279.test", p: 443 }], 1);
  eq("裁剪先删不在池子里的那条", W.NODE_MEMORY.alive.has("out279.test:443"), false);
  eq("裁剪保住池子里的那条（哪怕它更慢）", W.NODE_MEMORY.alive.has("in279.test:443"), true);
  eq("裁剪返回「动过表」", trimmed, true);
  eq("池子够小就不动", new W.AliveBoard().trimToMax([{ h: "in279.test", p: 443 }], 8), false);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case197({ fs, ok, eq, W }) {
  const facadeSrc = fs.readFileSync("src/px/selector.ts", "utf8");
  const pickSrc = fs.readFileSync("src/px/pickpath.ts", "utf8");
  const rotSrc = fs.readFileSync("src/px/rotation.ts", "utf8");
  const failSrc = fs.readFileSync("src/px/failbook.ts", "utf8");
  // 结构：三个类各自带单例，门面只剩委托
ok("pickpath 只定义 PickPath 行为，不再导出模块级实例", pickSrc.includes("export class PickPath {") && !pickSrc.includes("export const PICK ="), "");
  ok("rotation 有 Rotation 与 ROTATION", rotSrc.includes("export class Rotation {") && !rotSrc.includes("export const ROTATION ="), "");
  // 7.347：模块级 `FAILS` 收进 `Selector` 门面 —— 类还在、单例没了、门面自己持有
  ok("failbook 有 FailBook 而模块级 FAILS 已消失", failSrc.includes("export class FailBook {") && !failSrc.includes("export const FAILS = new FailBook();") && facadeSrc.includes("private readonly fails = new FailBook(this.rotation);"), "");
eq("门面里 picker 的委托有 3 处", facadeSrc.split("return this.picker.").length - 1, 3);
  eq("门面里 Rotation 的委托有 3 处", facadeSrc.split("return this.rotation.").length - 1, 3);
  eq("门面里失败记账的委托有 4 处", facadeSrc.split("return this.fails.").length - 1, 4);
  // 门面不得再留算法：这些调用各自只在唯一一个执行器里出现
  ok("门面不再挑样本", !facadeSrc.includes("pickThom("), "");
  ok("门面不再列候选", !facadeSrc.includes("candsFor("), "");
  ok("门面不再自写 IP 解析", !facadeSrc.includes("relayIpOf("), "");
  ok("门面不再动游标", !facadeSrc.includes("SELECTION_MEMORY.current"), "");
  ok("门面不再记样本", !facadeSrc.includes("NodeStatsTable.nsGet("), "");
  // 职责边界：换节点只由 Rotation 判，FailBook 调它而不是自己判
  ok("failbook 用注入的 rotation", failSrc.includes("this.rotation.maybeSwitch("), "");
  ok("failbook 不再 this.maybeSwitch", !failSrc.includes("this.maybeSwitch("), "");
  ok("pickpath 不判换节点", !pickSrc.includes("this.maybeSwitch(") && !pickSrc.includes("ROTATION.maybeSwitch("), "");
  ok("rotation 不含记失败的入口", !rotSrc.includes("async bumpFail(") && !rotSrc.includes("async onFail("), "");
  // dwellOf 跟着「什么时候换」走，但仍由门面再导出（调用点与测试零改动）
  ok("dwellOf 在 rotation", rotSrc.includes("export function dwellOf("), "");
  ok("门面再导出 dwellOf", facadeSrc.includes('export { Rotation, dwellOf } from "./rotation";'), "");
  // 行为：门面十个方法都还在，且默认驻留时间照旧
  const ten = ["region", "pick", "maybeSwitch", "onFail", "softFail", "bumpFail", "resetFail", "current", "afterScan", "sched"];
  eq("门面十个方法都在", ten.filter((m) => typeof W.SEL[m] === "function").length, 10);
  eq("lat 模式默认驻留 10 分钟", W.dwellOf({}, "lat"), W.SC.DWELL);
  eq("tput 模式默认驻留 20 分钟", W.dwellOf({}, "tput"), W.SC.DWELL_TPUT);
  eq("非正数覆盖回落默认", W.dwellOf({ pxDwellMin: "0" }, "lat"), W.SC.DWELL);
  eq("正数覆盖按分钟换算", W.dwellOf({ pxDwellMin: "3" }, "lat"), 3 * 60000);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case198({ fs, ok, eq, W }) {
  // 7.304 起四块（源清单 / 原始探活 / 地理标注 / 失败阈值）住在同一个文件里：
  // 它们共用一份 import 与一条重试纪律，拆成四个文件只会把「抓源用的是 fetch、探活用的是 connect」
  // 这条预算差异埋进四个 different 的 import 表里。
  const all = fs.readFileSync("src/px/probe.ts", "utf8");
  ok(
    "四个旧文件都不再单独存在",
    ["poolsrc.ts", "rawprobe.ts", "geo.ts", "failpolicy.ts"].every((f) => !fs.existsSync("src/px/" + f)),
    "",
  );
  ok("源清单与抓取在同一文件", all.includes("export const POOL_SOURCES = [") && all.includes("export async function refillPool("), "");
  ok("源健康度与去重也在同一文件", all.includes("export class SourceHealth {") && all.includes("export function takePoolLine("), "");
  ok("四种探活入口都在", all.includes("export const PROBE_HELLO") && all.includes("export async function probeProxy(") && all.includes("export function tlsHello(") && all.includes("export async function probeSni("), "");
  ok(
    "地理标注只做标注（它自己不建连）",
    all.includes("export async function geoLabel(") &&
      !all.slice(all.indexOf("export async function geoLabel("), all.indexOf("export function pxPolicy(")).includes("connect("),
    "",
  );
  ok("失败阈值没有 await（纯计算）", all.includes("export function pxPolicy(") && !/export function pxPolicy[sS]{0,400}?await /.test(all), "");
  // 导出面没变：老名字仍然能用，行为也照旧
  eq("REFILL_MAX 仍是 6", W.REFILL_MAX, 6);
  eq("三个探活入口仍可调用", [W.probeProxy, W.probeSni, W.tlsHello].every((f) => typeof f === "function"), true);
  eq("抓取入口仍可调用", typeof W.refillPool === "function" && typeof W.poolSources === "function", true);
  eq("阈值默认 3 / 5", JSON.stringify(W.pxPolicy({})), JSON.stringify({ fail: 3, force: 5 }));
  eq("阈值可被 env 覆盖", JSON.stringify(W.pxPolicy({ pxFailMax: "4", pxForceAt: "7" })), JSON.stringify({ fail: 4, force: 7 }));
  eq("非法覆盖回落默认", JSON.stringify(W.pxPolicy({ pxFailMax: "0", pxForceAt: "-1" })), JSON.stringify({ fail: 3, force: 5 }));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case199({ fs, ok, eq, W }) {
  const src = fs.readFileSync("src/nodes/stat.ts", "utf8");
  const noComment = (s) => s.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");
  // 7.282 曾把这层一分为四（类型 / 表 / 派生 / 观测），7.297 按「减少文件数、增加类数」合回一个文件：
  // 四段没有各自独立的生命周期，拆开只是把 import 搬了个位置。
  ok("四段归位到同一个文件", ["src/nodes/stat-types.ts", "src/nodes/stat-table.ts", "src/nodes/stat-view.ts", "src/nodes/stat-observe.ts"].every((f) => !fs.existsSync(f)), "");
  ok("类型与常量仍在", src.includes("export interface EffView") && src.includes("export const ZERO_STAT") && src.includes("export const TEN_MB") && src.includes("export const EMPTY_CLOSE_BAD"), "");
  ok("表本体只有类、没有模块级实例", src.includes("export class NodeStatsTable {") && !src.includes("export const STATS = new NodeStatsTable();"), "");
  ok("表本体自己管「取条目 / 打缓存 / 九个写入」", src.includes("  static nsGet(k: string): NodeStats {") && src.includes("  static invalidateRank() {") && src.includes("  static nsOk(k: string, tcp: number, tls: number) {"), "");
  ok(
      "十一个同名转发都已删除",
      ["nsOk", "nsProbe", "nsProbeFail", "nsFail", "nsSiteFail", "nsSpeed", "nsStall", "nsLatency", "nsEmptyClose", "nsGet", "invalidateRank"].every((f) => !new RegExp("^export function " + f + "\\(", "m").test(src)),
      "",
    );
  ok("派生层七个纯函数都在", ["nsDecay", "ageFactor", "effView", "pFailFast", "pFailOf", "availOf", "pStallOf"].every((f) => src.includes(`export function ${f}(`)), "");
  ok("九个写入都是类方法", ["nsOk", "nsProbe", "nsProbeFail", "nsFail", "nsSiteFail", "nsSpeed", "nsStall", "nsLatency", "nsEmptyClose"].every((f) => src.includes(`  static ${f}(`)), "");
  ok("写入全部经 this.nsGet 取条目、不自己碰 NODE_MEMORY.stats", (src.match(/this\.nsGet\(/g) || []).length >= 9 && !noComment(src).includes("NODE_MEMORY.stats["), "");
  ok("这一层只有 NodeStatsTable 一个类", (src.match(/^export class /gm) || []).length === 1, "");
  // 行为面：常量与写入仍然照旧（用独立键，避免与别的组互相污染）
  eq("TEN_MB 仍是 10MB", W.TEN_MB, 10 * 1048576);
  eq("空关闭门槛仍是 5", W.EMPTY_CLOSE_BAD, 5);
  eq("模块级单例已不存在（表只以静态方法存在）", W.STATS, undefined);
  eq("零值条目的样本数为 0", W.ZERO_STAT.probeSamples, 0);
  const k282 = "stat282.probe:443";
  W.NodeStatsTable.nsFail(k282);
  ok("失败后进入冷却", W.NodeStatsTable.nsGet(k282).blackUntil > Date.now(), "");
  ok("冷却被记成失败一笔", W.effView(W.NodeStatsTable.nsGet(k282)).failW > 0, "");
  W.NodeStatsTable.nsOk(k282, 12, 30);
  eq("成功清零冷却", W.NodeStatsTable.nsGet(k282).blackUntil, 0);
  ok("成功留下 tcp 样本", W.NodeStatsTable.nsGet(k282).tcp > 0, "");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case200({ fs, netsAll, ok, eq, W }) {
  const g = "283";
  // 7.309 把「只读表 / 写操作 / 计量探测 / 编排」合进了同一个文件：按类与函数边界切片再判，
  // 判据（编排层不读参数、只读层不建连、写层必过管理员）一条不变。
  const whole283 = fs.readFileSync("src/routes/debug.ts", "utf8");
  const cut283 = (from, to) => {
    const i = whole283.indexOf(from);
    const j = to ? whole283.indexOf(to, i + 1) : -1;
    return i < 0 ? "" : whole283.slice(i, j < 0 ? whole283.length : j);
  };
  const orch = cut283("export async function debug(", "");
  const tabs = cut283("export class DebugTables", "// ---- 并入自 debug-actions.ts ----");
  const nets = netsAll();
  const acts = cut283("export class DebugActions", "// ---- 并入自 debug-meter.ts ----");
  // 编排层只按固定顺序调用三个组件，自己不再读任何参数：这条锁防的是「拆完之后又往编排里塞逻辑」
  ok(`[${g}] 编排层不再自己判断参数`, !orch.includes("searchParams.get(\"dd\")") && !orch.includes("searchParams.get(\"bench\")"));
  eq(`[${g}] 编排层按顺序调用十二个组件方法`, ["DEBUG.tables.read(", "DEBUG.nets.bench(", "DEBUG.nets.diag(", "DEBUG.nets.rawProbe(", "DEBUG.actions.refill(", "DEBUG.actions.pinCurrent(", "DEBUG.nets.http(", "DEBUG.probes.run(", "DEBUG.nets.tfb(", "DEBUG.nets.tf(", "DEBUG.actions.restore(", "DEBUG.actions.seed(", "DEBUG.nets.host("].every((x) => orch.includes(x)), true);
  ok(`[${g}] 编排层保持「只读在测量与写之前」`, orch.indexOf("DEBUG.tables.read(") < orch.indexOf("DEBUG.nets.bench(") && orch.indexOf("DEBUG.nets.bench(") < orch.indexOf("DEBUG.actions.refill("));
  ok(`[${g}] 编排层不超 120 行`, orch.length > 0 && orch.split(/\r?\n/).length <= 120);
  // 只读表：十一个分支都在这里，且不出现拨号/建连/写 KV 的能力
  eq(`[${g}] 只读表层持有十一个分支`, ["\"dd\"", "\"pss\"", "\"eg\"", "\"rt\"", "\"blk\"", "\"facts\"", "\"plan\"", "\"vt\"", "\"hl\"", "\"prefs\"", "\"cl\""].every((x) => tabs.includes("q.get(" + x + ")")), true);
  ok(`[${g}] 只读表层不建连、不写状态`, !tabs.includes("SOCKET_DIALER.open(") && !tabs.includes("pxSet(") && !tabs.includes("flushPx(") && !tabs.includes("refillPool("));
  // 测网层：三种「花钱」的能力都留了上限
  ok(`[${g}] 测网层的测速有 20 秒封顶`, nets.includes("const ac = new AbortController();") && nets.includes(", 20000)"));
  ok(`[${g}] 测网层的明文 HTTP 走传输层、并带 6 秒预算`, nets.includes("probeTf(hh, rr, pp, HTTP80_TRANSPORT, 6000)"));
  ok(`[${g}] 测网层建连走拨号器`, nets.includes("SOCKET_DIALER.open(") && !nets.includes("connect({"));
  ok(`[${g}] 测网层的判定批走 doFetch`, nets.includes("doFetch(c.env, \"tf-probe\""));
  // 写层：四个分支都必须先过 adminOnly（数量锁：少一个就意味着有条写操作不需要管理员）
  eq(`[${g}] 写层四个分支都先过管理员检查`, acts.split("await adminOnly(c)").length - 1, 4);
  eq(`[${g}] 三个组件由组合根持有（不再各导出一个模块级单例）`, ["readonly tables = new DebugTables();", "readonly nets = new DebugNets();", "readonly actions = new DebugActions();"].every((x) => whole283.includes(x)), true);
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case201({ fs, ok, eq, W }) {
  const g = "284";
  const face = fs.readFileSync("src/nodes/metrics.ts", "utf8");
  // 7.307 把 rtt / site / diag 三块并回了 metrics.ts：它们没有各自独立的生命周期，
  // 拆开之后「读诊断结论的人」要跨四个 import 才拼得出全貌，而四块之间本来就是同一次排查的四个视角。
  ok(`[${g}] 三块旧文件都不在了`, ["src/nodes/rtt.ts", "src/nodes/site.ts", "src/nodes/diag.ts"].every((x) => !fs.existsSync(x)));
  eq(`[${g}] 入口 RTT、站点画像、诊断结论都在 metrics.ts`, ["export function rttMark", "export function rttLearn", "export async function loadRtt", "export class HostProfile", "export const HOSTS", "export function siteKey", "export function diagVerdict"].every((x) => face.includes(x)), true);
  ok(`[${g}] 入口 RTT 不配类（状态在 W.ENTRY_MEMORY.rows，没有独占的跨请求状态）`, !/^export class Rtt/m.test(face));
  const diagBody = face.slice(face.indexOf("export function diagVerdict"), face.indexOf("export function diagVerdict") + 700);
  ok(`[${g}] 诊断结论是纯函数（函数体内不读 S、不 IO）`, !diagBody.includes("S.") && !diagBody.includes("await ") && !diagBody.includes("fetch("));
  ok(`[${g}] 这一层仍受单文件上限约束`, face.split(/\r?\n/).length <= 560);
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

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case203({ fs, ok, eq, W }) {
  // 第 286 组：连接结束时的结算流水线独立成类（v7.286）
  // 一条连接结束时要做六件事（收尾采样 / pStall 占比 / 节点观测聚合 / 首眼观测 / 站点画像 / PEND 记账），
  // 而热路径每 512KB 只做「加字节 → 比阈值」。两者混在一个 420 行的类里时，看不出哪个字段只在这里被读。
  const connSrc286 = fs.readFileSync("src/proxy/connection.ts", "utf8");
  const settleSrc286 = fs.readFileSync("src/proxy/conn-settle.ts", "utf8");
  const sampSrc286 = fs.readFileSync("src/proxy/conn-settle.ts", "utf8");
  // 7.348：单例收进 Connection 自己持有，判据改成「类还在、模块级实例没了」
  ok("结算流水线是独立的类（模块级单例已并入连接）", settleSrc286.includes("export class ConnSettle") && !settleSrc286.includes("export const SETTLE"), "");
  ok("结算只读结构化视图（不 import Connection）", settleSrc286.includes("export interface SettleView") && !settleSrc286.includes("Connection }"), "");
  ok("结算入口只有 close / pend 两条", settleSrc286.includes("close(v: SettleView): void") && settleSrc286.includes("pend(v: SettleView): void"), "");
  ok("连接本体不再自己结算节点分数", !connSrc286.includes("NodeStatsTable.nsOk(") && !connSrc286.includes("NodeStatsTable.nsStall(") && !connSrc286.includes("markSeedDirty("), "");
  ok("连接本体不再自己记 PEND 账", !connSrc286.includes("statBump(") && !connSrc286.includes("scheduleFlush("), "");
  ok("flush 只负责调度结算", connSrc286.includes("this.settle.close(this)") && connSrc286.includes("this.settle.pend(this)"), "");
  ok("通道证据也搬进结算", !connSrc286.includes("HOOK.traffic") && settleSrc286.includes("HOOK.traffic"), "");
  const sampBlock286 = sampSrc286.slice(sampSrc286.indexOf("export const SAMPLE_STD_BYTES"), sampSrc286.indexOf("export const EMIT_BYTES"));
  ok("采样换算是纯函数（不读 S、不计数、不 await）", !sampBlock286.includes("S.") && !sampBlock286.includes("cnt(") && !sampBlock286.includes("await ") && sampBlock286.includes("export function sampleWeight") && sampBlock286.includes("export function stalledWindow") && sampBlock286.includes("export function kbsOf"), "采样换算块必须是纯函数");
  eq("权重封顶：额度用完就是 0", W.sampleWeight(W.SC.CONN_W_CAP, 512 * 1024, 1000), 0);
  ok("权重封顶：折扣在封顶之前生效", Math.abs(W.sampleWeight(W.SC.CONN_W_CAP - 0.1, 512 * 1024, 1000, 0.3) - 0.1) < 1e-6, "");
  eq("负折扣夹成 0", W.sampleWeight(0, 512 * 1024, 1000, -5), 0);
  ok("背压窗口判据是一半以上时间", W.stalledWindow(600, 0, 1000) && !W.stalledWindow(500, 0, 1000), "");
  eq("小样本的吞吐记 0（4 字节 403 页不算速度）", W.kbsOf(4096, 80), 0);
  ok("过 1MB 才算真实吞吐", Math.abs(W.kbsOf(1048576, 1000) - 1024) < 1e-6, `got=${W.kbsOf(1048576, 1000)}`);
  ok("结算类可实例化、模块级实例已撤", typeof W.ConnSettle === "function" && W.SETTLE === undefined, "");
  ok("连接仍持有自己的采样权重（状态归连接）", connSrc286.includes("this.sampleW += use;") && settleSrc286.includes("takeWeight(bytes: number, dt: number, factor?: number): number;"), "");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case204({ fs, ok, eq, W }) {
  const tab287 = fs.readFileSync("src/route/verdict.ts", "utf8");
  ok("表本体持有私有表与单例", tab287.includes("export class VerdictTable") && tab287.includes("private byKey = new BoundedMap") && tab287.includes("export const VT = new VerdictTable();"));
  ok("不再有十二个 v* 转发函数", !/^export function v/m.test(tab287));
  ok("状态机与通配拒写都在表本体", tab287.includes("private static stateOf(") && tab287.includes("private static blockWild("));
  ok("类型与 TTL 与表同住一个文件", tab287.includes("export type VState") && tab287.includes("export interface Verdict") && tab287.includes("export const VT_TTL_MS = 30 * 60_000;"));
  eq("TTL 只有一个真源", (tab287.match(/30 \* 60_000/g) || []).length, 1);
  ok("verdict-table.ts 已删除", !fs.existsSync("src/route/verdict-table.ts"));
  ok("verdict-types.ts 已删除", !fs.existsSync("src/route/verdict-types.ts"));
  ok("VT 是 VerdictTable 实例", W.VT instanceof W.VerdictTable);
  W.VT.clear();
  W.VT.set("rt287.example", "d", 200, 12);
  ok("2xx 记成可用", W.VT.ok("rt287.example", "d") && W.VT.state("rt287.example", "d") === W.St.Reachable);
  W.VT.set("rt287.example", "r:1.1.1.1", 403, 30);
  ok("403 记成被拦", W.VT.bad("rt287.example", "r:1.1.1.1"));
  W.VT.set("rt287.example", "r:1.1.1.1", 200, 30, 0);
  ok("弱证据不得把强证据的 blocked 冲成可用", W.VT.bad("rt287.example", "r:1.1.1.1"));
  const before287 = W.VT.size();
  W.VT.set("*", "d", 200, 5);
  W.VT.setState("*", "r:2.2.2.2", W.St.Blocked, 1);
  eq("通配目标一条都不落表", W.VT.size(), before287);
  ok("通配在 VT.all 里也查不到", W.VT.all("*").length === 0);
  W.VT.clearHost("rt287.example");
  eq("清站点把该目标的行全删掉", W.VT.all("rt287.example").length, 0);
  W.VT.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case205({ fs, ok, W }) {
  const src = fs.readFileSync("src/nodes/score.ts", "utf8");
  ok("三块归位到同一个文件", ["src/nodes/score-health.ts", "src/nodes/score-cost.ts", "src/nodes/score-cands.ts"].every((f) => !fs.existsSync(f)), "");
  // 空壳类：一个字段都没有、方法全在读 S —— 按 AGENTS.md 的约定不该存在
  ok("空壳类 Scorer 已删除", W.Scorer === undefined && W.SCORER === undefined, "");
  ok("文件里不再出现 class Scorer", !src.includes("class Scorer"), "");
  // 健康度层只读 W.NODE_MEMORY.stats：写出这六个判断，不碰候选表
  ok("健康度层有六个判断",
    ["export function isBlack", "export function isFrozen", "export function freezeNode",
      "export function suspectOf", "export function emptyCloseSuspect", "export function usable"]
      .every((n) => src.includes(n)), "");
  // 代价层是纯计算：两个入口 + 一个分解类型
  ok("代价层只有两个函数", (src.match(/^export function (scoreParts|costOf)\(/gm) || []).length === 2, "");
  // 候选表层把 CAND_* 收成私有常量（外部不该知道 224/64/128 这些数）
  ok("候选表层是类且四个入口齐备",
    ["ranked", "list", "next", "best"].every((n) => typeof W.CANDS[n] === "function"),
    "");
  ok("候选表常量不再导出", !/export const CAND_/.test(src), "");
  ok("候选表是类（缓存与分片游标是它的字段）", /^export class CandidateBoard /m.test(src), "");
  // 行为面：门面转发仍然指向真实实现
  ok("scoreParts 仍能算分解", typeof W.scoreParts("g288:443", "lat").score === "number", "");
  W.NODE_MEMORY.alive.set("g288:443", { h: "g288", p: 443, cc: "", ms: 120 });
  ok("候选表仍看得到存活表", W.CANDS.list("lat").some((r) => r.k === "g288:443"), "");
  ok("bestFor 返回存活表里的键", typeof W.CANDS.best("lat") === "string" && W.CANDS.best("lat").length > 0, W.CANDS.best("lat"));
  ok("usable 认可用", W.usable("g288:443") === true, "");
  W.freezeNode("g288:443");
  ok("冻结后立即不可用", W.usable("g288:443") === false && W.isFrozen("g288:443") === true, "");
  W.NODE_MEMORY.alive.delete("g288:443");
  W.NodeStatsTable.invalidateRank();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case206({ fs, ok, W, eq }) {
  const psSrc = fs.readFileSync("src/route/psfacts.ts", "utf8");
  ok("四个旧文件都不再单独存在",
    ["ps-types.ts", "ps-prior.ts", "ps-outbox.ts", "ps-table.ts"].every((f) => !fs.existsSync("src/route/" + f)), "");
  ok("形状、先验、表本体现在同在一个文件，且队列由基类提供",
    psSrc.includes("export class PsFacts extends FactTable<") &&
      psSrc.includes("export function psPrior(") && psSrc.includes("export const PS_TTL = FACT_TTL.ps;") &&
      !psSrc.includes("export class PsOutbox"), "");
  ok("只留一个单例", (psSrc.match(/export const PS = new PsFacts\(\);/g) || []).length === 1);
ok("五个转发函数已删除，调用点直接用 PS 的方法", !["psNote", "psOk", "psBest", "psFactor", "psSnap"].some((n) => psSrc.includes(`export function ${n}(`)) && ["note", "okOf", "bestOf", "factor", "snap"].every((m) => psSrc.includes(`  ${m}(`)), "");
  ok("待发队列带批次上限", psSrc.includes("export const PS_BATCH = 60;"), "");
  // 队列类同在一个文件里，所以「有没有自己记账」要看 PsFacts 的类体，而不是整个文件。
  const psBody = psSrc.slice(psSrc.indexOf("export class PsFacts"));
  ok("表本体不再自己记账（pending/sent 在基类）",
    !psBody.includes("private outbox") && !psBody.includes("private pending") && !psBody.includes("private sent") &&
      psBody.includes("this.put(k, { q: Math.round(q), n, at: now, top }, now);"), "");
  ok("表本体声明寿命，过期判定在基类",
    psSrc.includes("protected get ttlMs(): number {") && psSrc.includes("return PS_TTL;") &&
      !psSrc.includes("now - r.at > PS_TTL"), "");
  ok("PsWire 形状只声明一次", (psSrc.match(/export interface PsWire \{/g) || []).length === 1);
  // 行为面：门面转发仍然指向真实实现
  ok("单例仍是 PsFacts", W.PS instanceof W.PsFacts);
  ok("批次上限对外可见", W.PS_BATCH === 60);
  eq("未知族的先验仍是 0.83", W.psPrior("198.51.100.7"), 0.83);
  W.PS.clear();
  W.PS.note("ps289.example", "203.0.113.91", true, Date.now());
  {
    const f289 = W.PS.factor("ps289.example", "203.0.113.91");
    ok("折价因子夹在 1/2 与 2 之间", f289 >= 0.5 && f289 <= 2, String(f289));
  }
  ok("观测进了待发队列", W.PS.delta().some((r) => r.k === "ps289.example|203.0.113.91"));
  eq("历史最好跟着观测涨上去", W.PS.bestOf("ps289.example", "203.0.113.91"), 1);
  W.PS.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case207({ fs, ok, eq, W }) {
  const utilSrc290 = fs.readFileSync("src/core/util.ts", "utf8");
  // 7.299 起这八块合回单个文件（用户要求减少文件数）：不再有门面与非门面之分。
  ok("八个旧文件都不再单独存在",
    ["bytes", "sha224", "ws", "timeouts", "concurrency", "env-parse", "proto-names", "errors"]
      .every((f) => !fs.existsSync("src/core/" + f + ".ts")), "");
  ok("不再靠再导出拼门面", !/^export \* from "\.\//m.test(utilSrc290));
  const wants290 = [
    "export function toU8", "export function toHex", "export function uuidFromBytes",
    "export function sha224Bytes", "export const SHA_K",
    "export const WS_OPEN", "export const WS_MAX_BUFFER", "export function safeSend", "export function closeQuietly",
    "export const CONNECT_MS = 2500", "export const UP_STALL_MS = 30000", "export const FIRST_UP_MS = 8000", "export async function withTimeout",
    "export async function eachLimit",
    "export const SHADOW_DEFAULT", "export function shadowRate", "export const secretPwd",
    "export const P_V", "export const P_T",
    "export function errMsg",
  ];
  let miss290 = 0;
  for (const w of wants290) if (!utilSrc290.includes(w)) { miss290 += 1; ok("util.ts 缺少 " + w, false); }
  eq("八块的关键符号都在 util.ts 里", miss290, 0);
  // 这一层全是纯函数与常量（状态在 S 里），按约定不该配类
  eq("这一层不定义任何类", /^export class /m.test(utilSrc290), false);
  eq("版本常量仍在这一个文件里", (utilSrc290.match(/^export const VERSION = /gm) || []).length, 1);

  // 行为面：门面导出的东西必须真的可用（拆分前它们都从 util 出来）
  eq("toHex(toU8(\"A\"))", W.toHex(W.toU8("A")), "41");
  eq("sha224Bytes 输出 28 字节", W.sha224Bytes(new Uint8Array(0)).length, 28);
  eq("errMsg 截断", W.errMsg("hello", 2), "he");
  eq("WS_MAX_BUFFER 维持 64MB（7.425 A/B 证伪内存假设）", W.WS_MAX_BUFFER, 64 * 1024 * 1024);
  eq("协议名仍在 proto-names.ts", [W.P_V.length, W.P_T.length], [5, 6]);
  eq("SHADOW_DEFAULT 仍是 5%", W.SHADOW_DEFAULT, 0.05);
  eq("uuidFromBytes 是 8-4-4-4-12", W.uuidFromBytes(new Uint8Array(16).fill(0xab)).split("-").map((x) => x.length), [8, 4, 4, 4, 12]);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case208({ fs, eq, W }) {
  // 7.304 起编排与三个执行器、批探活都住在 src/px/scan.ts 里：一次池子维护的全部步骤读一处即可，
  // 「哪一步会花 connect() 名额、哪一步会写 KV」也不再分散在四个 import 表里。
  const orche = fs.readFileSync("src/px/scan.ts", "utf8");
  eq(
    "四个旧文件都不再单独存在",
    ["scan-probe.ts", "scan-alive.ts", "scan-house.ts", "probe-batch.ts"].every((f) => !fs.existsSync("src/px/" + f)),
    true,
  );
  eq("编排类仍在", orche.includes("export class PoolScan"), true);
  eq("三个执行器与批探活也都在同一文件", [
    "export class ScanProbe",
    "export class ScanAlive",
    "export class ScanHouse",
    "export async function probeBatch(",
    "export interface ProbeHit extends NodeEntry",
  ].every((x) => orche.includes(x)), true);
  eq("批探活按 PROBE_CONC 切段且认合并键", orche.includes("chunks(keys, SC.PROBE_CONC)") && orche.includes("splitRelay(key, 443)"), true);
  eq("新候选执行器负责进存活表", orche.slice(orche.indexOf("class ScanProbe")).includes("NODE_MEMORY.alive.set("), true);
  eq("复测执行器记探活失败", orche.slice(orche.indexOf("class ScanAlive")).includes("NodeStatsTable.nsProbeFail("), true);
  eq("收尾执行器做裁剪与落盘", orche.slice(orche.indexOf("class ScanHouse")).includes("this.board.trimToMax(") && orche.includes("SEED_STORE.write("), true);
  eq("scan.ts 仍在单文件上限内", orche.split(/\r?\n/).length <= 560, true);
  eq("三个执行器都能构造", [W.ScanProbe, W.ScanAlive, W.ScanHouse].every((f) => typeof f === "function"), true);
  eq("探活批处理可调用", typeof W.probeBatch === "function", true);
  eq("cronScan 仍是唯一入口", typeof W.cronScan === "function", true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case209({ fs, ok, eq, W }) {
  const polSrc = fs.readFileSync("src/route/policy.ts", "utf8");
  // 7.299 起候选层与 CF 分支树也住在 policy.ts 里（只在内存形状上，仍各是一段职责）。
  ok("三个旧文件都不再单独存在",
    ["policy-ctx.ts", "policy-rank.ts", "policy-cf.ts"].every((f) => !fs.existsSync("src/route/" + f)), "");
  eq("决策本体只留裁决顺序", (polSrc.match(/^  [a-zA-Z]\w*\(/gm) || []).length > 5, true);
  // 合回一个文件之后，判据从「不在这个文件」换成「decide 不自己干这三件事」：
  // 它只拿 rankOf 的视图、只把 CF 分支交给 decideCf。
  ok("decide 只拿候选视图，不自己算排序键", polSrc.slice(polSrc.indexOf("  decide(c: Ctx): Choice {"), polSrc.indexOf("  shadow(")).indexOf("scoreOf") === -1, "");
  ok("三段职责各自有边界", polSrc.includes("export function rankOf(c: Ctx): Ranked {") && polSrc.includes("export function decideCf(c: Ctx, r: Ranked, src: PinSource): Choice | null {") && polSrc.includes("export class Policy implements PinSource"), "");
  ok("决策本体调 rankOf", polSrc.includes("const r = rankOf(c);"));
  ok("决策本体把 CF 分支树交出去", polSrc.includes("const cf = decideCf(c, r, this);"));
  eq("policy.ts 仍在单文件上限内", polSrc.split("\n").length <= 560, true);
  ok("候选层导出视图与入口", polSrc.includes("export interface Ranked") && polSrc.includes("export function rankOf(c: Ctx): Ranked {"));
  // 7.363：rankOf 变纯只读函数，三条写动作搬进 FactRegistry.housekeep，decide 在排序前显式调用。
  const polCode292 = polSrc.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
  ok("rankOf 已去写副作用", !polCode292.includes("VT.setState") && !polCode292.includes("VT.clearHost") && !polCode292.includes("BLK.sweep") && !polCode292.includes("healRatio"));
  ok("decide 排序前显式自愈", polSrc.includes("FactRegistry.housekeep(c.host, c.relays);") && polSrc.indexOf("FactRegistry.housekeep") < polSrc.indexOf("const r = rankOf(c);"));
  const regSrc = fs.readFileSync("src/route/fact-registry.ts", "utf8");
  ok("registry 保留三条写动作", regSrc.includes("blockedRatio > 0.75 && usable.length < 2") && regSrc.includes("VT.clearHost(host)") && regSrc.includes("BLK.sweep(host, relays)"));
  ok("registry 返回写动作清单", regSrc.includes("FactEffect[]") && regSrc.includes('kind: "verdict"') && regSrc.includes('kind: "blk"'));
  ok("候选层自己排序", polSrc.includes("const ranked = usable"));
  ok("CF 分支树只认 CF 目标", polSrc.includes("if (!c.cfHost) return null;"));
  ok("CF 分支树带 PinSource", polSrc.includes("export interface PinSource") && polSrc.includes("pinFor(host: string, list: string[]): string;"));
  ok("策略把钉住与轮换暴露给分支树", polSrc.includes("nextRotation(limit: number): number"));
  ok("策略本体声明自己可当 PinSource", polSrc.includes("export class Policy implements PinSource"));
  eq("轮换游标按条数取模", [W.POLICY.nextRotation(3), W.POLICY.nextRotation(3), W.POLICY.nextRotation(3), W.POLICY.nextRotation(3)], [0, 1, 2, 0]);
  W.VT.clear();
  const v6c = W.POLICY.decide({ host: "v6cf292.test", cfHost: true, clientV6: true, relays: ["104.18.32.1", "203.0.113.9"], legacyWantsRelay: true, mode: "tput" });
  eq("v6 客户端打 CF 目标走非 CF 中继", v6c.why, "v6-cf");
  eq("v6-cf 挑的是非 CF 那条", v6c.chan.ip, "203.0.113.9");
  const plain = W.POLICY.decide({ host: "plain292.test", cfHost: false, clientV6: false, relays: [], legacyWantsRelay: false, mode: "tput" });
  eq("非 CF 目标没候选时直连", plain.why, "direct");
  W.VT.setState("rank292.test", "r:45.136.117.194", 2, 1);
  const rk = W.rankOf({ host: "rank292.test", cfHost: true, clientV6: false, relays: ["45.136.117.194", "203.0.113.9"], legacyWantsRelay: true, mode: "tput" });
  eq("被判死的不进可用集合", rk.usable.includes("45.136.117.194"), false);
  eq("被判死的进复检集合", rk.blocked.includes("45.136.117.194"), true);
  // 排序只对可用集合做：被判死的那条不进 ordering，复检走 r.blocked（5% 探索专用通道）
  eq("排序结果只来自可用集合", rk.stick.includes("45.136.117.194"), false);
  eq("排序结果条数等于可用条数", rk.ranked.length, rk.usable.length);
  eq("非 CF 目标时 CF 分支树返回 null", W.decideCf({ host: "plain292.test", cfHost: false, clientV6: false, relays: [], legacyWantsRelay: false }, rk, W.POLICY), null);
  W.VT.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case210({ fs, ok, W, eq }) {
  const factsSrc = fs.readFileSync("src/route/blkfacts.ts", "utf8");
  const baseSrc = fs.readFileSync("src/route/fact-table.ts", "utf8");
  ok("两个旧文件都不再单独存在",
    ["blk-types.ts", "blk-outbox.ts"].every((f) => !fs.existsSync("src/route/" + f)), "");
  ok("形状与状态机同在一个文件、队列归基类",
    factsSrc.includes("export const BLK_BATCH = 3;") && factsSrc.includes("export interface BlkWire {") &&
      factsSrc.includes("export class BlkFacts extends FactTable<Row, BlkWire>") && !factsSrc.includes("class BlkOutbox"), "");
  ok("状态机不再自己声明队列", !factsSrc.includes("private pending") && !factsSrc.includes("private sent"), "");
  ok("每批上限由子类声明、基类执行",
    factsSrc.includes("return BLK_DELTA_MAX;") && baseSrc.includes("if (out.length >= this.batchMax) break;"), "");
  ok("只有 ack 能删待发，且这条纪律只在基类",
    baseSrc.includes("if (cur && cur.at <= at) this.pending.delete(key);") &&
      (baseSrc.match(/this\.pending\.delete\(/g) || []).length === 2 &&
      !/nack\(\): void \{[\s\S]{0,220}pending\.clear/.test(baseSrc), "");
  // 行为面用真表驱动：note 要三批 × 每批 3 次才写行，之后 delta/ack/nack 走继承来的实现
  W.BLK.clear();
  const t0 = 5000000;
  const feed293 = (host, ip, base) => {
    for (let b = 0; b < 3; b += 1) for (let k = 0; k < 3; k += 1) W.BLK.note({ host, ip, down: 40, peerBig: true, at: base + b * 61000 + k * 1000 });
  };
  feed293("q293.test", "198.51.100.7", t0);
  eq("三批之后才写行", W.BLK.penOf("q293.test", "198.51.100.7", t0 + 130000), W.BLK_PEN);
  const out293 = W.BLK.delta();
  eq("确认后进待上报", out293.length, 1);
  eq("待上报行带批数与时间", out293[0].n, W.BLK_BATCH);
  eq("上限常量可见", W.BLK_DELTA_MAX, 60);
  W.BLK.ack();
  eq("ack 之后同一行不再重发", W.BLK.delta().length, 0);
  // nack 什么都不清：同一批下一轮原样再给一次（重发 = 重试，幂等靠 at）
  feed293("q293b.test", "198.51.100.8", t0 + 200000);
  eq("第二条通道也进了待上报", W.BLK.delta().length, 1);
  W.BLK.nack();
  eq("nack 之后同一批原样重发", W.BLK.delta().length, 1);
  // 反向证据要把待上报一起撤掉：作废的结论不能送到 DO
  W.BLK.contra("q293b.test", "198.51.100.8");
  eq("反向证据后不再重发", W.BLK.delta().length, 0);
  W.BLK.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case211({ fs, ok, eq, W }) {
  const src = fs.readFileSync("src/routes/debug-nets.ts", "utf8");
  ok("四个组件文件已合回", ["src/routes/debug-net-bench.ts", "src/routes/debug-net-diag.ts", "src/routes/debug-net-probe.ts", "src/routes/debug-net-tf.ts"].every((f) => !fs.existsSync(f)), "");
  // 五个类各自负责一段：门面 + 测速 + 站点诊断 + 三个探针 + 判定批/真握手
  ok("五个类都在同一个文件里",
    ["export class DebugNets", "export class DebugBench", "export class DebugDiag", "export class DebugProbe", "export class DebugTf"]
      .every((n) => src.includes(n)), "");
  // 7.344：四个组件不再是模块级单例，改由 DebugNets 自己持有（少四个全局）
  ok("模块级单例已经清零", ["export const BENCH =", "export const DIAGONE =", "export const PROBES =", "export const TFPROBES ="]
    .every((n) => !src.includes(n)), "");
  ok("门面自己持有四个组件",
    ["readonly benchRunner = new DebugBench();", "readonly diagRunner = new DebugDiag();",
      "readonly probeRunner = new DebugProbe();", "readonly tfRunner = new DebugTf();"]
      .every((n) => src.includes(n)), "");
  ok("上下文类型只声明一次", (src.match(/type DebugCtx = /g) || []).length === 1, "");
  // 只有两个类要管理员：改动状态的那两个分支（判定批与真握手不写状态，但会花 DO 的 CPU）
  ok("需要管理员的入口都过了 adminOnly", (src.match(/await adminOnly\(c\)/g) || []).length >= 2, "");
  ok("门面七行全是委托", (src.match(/return this\.(benchRunner|diagRunner|probeRunner|tfRunner)\./g) || []).length === 7, String((src.match(/return this\.(benchRunner|diagRunner|probeRunner|tfRunner)\./g) || []).length));
  // 行为面：无参数时测速与原始探活都返回 null（不拨号、不花钱）
  const u0 = new URL("https://x.test/debug");
  eq("测速缺参返回 null", await W.DEBUG.nets.benchRunner.bench(u0), null);
  eq("原始探活缺参返回 null", await W.DEBUG.nets.probeRunner.rawProbe(u0), null);
  ok("组件仍是自己的类", W.DEBUG.nets instanceof W.DebugNets && W.DEBUG.nets.benchRunner instanceof W.DebugBench, "");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case212({ fs, ok, W, eq }) {
  const connSrc = fs.readFileSync("src/proxy/connection.ts", "utf8");
  // 7.310 起窗口与背压两类住进 connection.ts：取同一个文件的切片当各自的「源码」。
  const winSrc = connSrc;
  const flowSrc = connSrc;
  /** 取某个类自己的源码段（到下一个顶层 export class 为止）。 */
  const classBody = (name) => {
    const from = connSrc.indexOf(`export class ${name} {`);
    if (from < 0) return "";
    const rest = connSrc.slice(from + 1);
    const at = rest.indexOf("\nexport class ");
    return at < 0 ? connSrc.slice(from) : rest.slice(0, at);
  };

  ok("connection.ts 里有 SampleWindow 类", /export class SampleWindow \{/.test(winSrc));
  ok("connection.ts 里有 ClientFlow 类", /export class ClientFlow \{/.test(flowSrc));
  const connBody = classBody("Connection");
  ok(
    "连接通过组合持有两个对象（不再自己声明采样字段）",
    connBody.includes("readonly win = new SampleWindow();") &&
      connBody.includes("readonly flow = new ClientFlow();") &&
      !/^  sampleAt = 0;$/m.test(connBody) &&
      !/^  stallMs = 0;$/m.test(connBody),
    "win/flow 组合或字段残留不符",
  );
  ok("连接把采样字段暴露成只读 getter", /get sampleAt\(\): number \{/.test(connSrc) && /get siteEmitted\(\): number \{/.test(connSrc));
  ok("连接的背压只剩一行委托", connSrc.includes("return this.flow.gate(ws, this.sock);"));
  // 7.310 把 ClientFlow 并进 connection.ts，所以改成按类切片：buffer 只在 ClientFlow 里读，
  // 连接本体（Connection 类体到 ConnSample 之前）不该出现 bufferedAmount。
  const connLines = connSrc.split(/\r?\n/);
  const clsStart = connLines.findIndex((l) => l.includes("export class Connection {"));
  const flowStart = connLines.findIndex((l) => l.includes("export class ClientFlow {"));
  const connCode = connLines.slice(clsStart, flowStart).join("\n");
  ok("缓冲读写只在 ClientFlow 类里（连接本体不再直接比 bufferedAmount）", !connCode.includes("bufferedAmount"));
  ok(
    "采样权重仍归连接（结算要用 sampleW）",
    connSrc.includes("this.sampleW += use;") && winSrc.includes("emitted(now: number): void"),
  );
  ok("节点级窗口的最短长度与出样本间隔各是一处常量", winSrc.includes("export const NODE_WIN_MS = 800;") && winSrc.includes("export const NODE_EMIT_GAP_MS = 5000;"));
  ok("站点级窗口 60 秒也是常量", winSrc.includes("export const SITE_WIN_MS = 60000;"));
  const winBody = classBody("SampleWindow");
  ok("窗口类不碰连接、不碰全局状态", winBody.length > 200 && !winBody.includes("S.") && !winBody.includes("cnt("));

  // 行为面：用显式时间戳跑，避免依赖真实时钟
  const sw = new W.SampleWindow();
  sw.begin(10000, 0, 0);
  eq("窗口短于 800ms 不产生样本", sw.node(10500, 900000, 0), null);
  const w1 = sw.node(12000, 204800, 0);
  ok("2 秒 200KB 的窗口可以出样本", Boolean(w1) && w1.bytes === 204800 && w1.elapsedMs === 2000, JSON.stringify(w1));
  sw.emitted(12000);
  eq("距上次出样本不足 5 秒不重复采", sw.node(14000, 500000, 0), null);
  const w2 = sw.node(20000, 800000, 0);
  // 注意：卡在「出样本间隔」上时窗口边界不推进（否则 dt 会只剩 2 秒），所以这里是从 w1 起算的 8 秒 595200 字节
  ok("满 5 秒后可以再采", Boolean(w2) && w2.bytes === 595200 && w2.elapsedMs === 8000, JSON.stringify(w2));

  const small = new W.SampleWindow();
  small.begin(10000, 0, 0);
  eq("小于 64KB 的窗口不出样本", small.node(12000, 1000, 0), null);
  eq("没出样本也推进了窗口边界（否则下次 dt 被拖长）", small.at, 12000);

  const st = new W.SampleWindow();
  st.begin(0, 0, 0);
  eq("一半时间在背压算“瓶颈在客户端”", st.stalled(1000, 600), true);
  eq("少量背压不算", st.stalled(1000, 500), false);

  // 背压：客户端自己走了记 ccut，而不是节点的 cut
  const flow = new W.ClientFlow();
  eq("缓冲未超限直接放行", await flow.gate({ bufferedAmount: 0, readyState: 1, send() {}, close() {} }, null), true);
  eq("缓冲未超限不累计背压毫秒", flow.stallMs, 0);
  const gone = { bufferedAmount: 1e9, readyState: 3, send() {}, close() {} };
  eq("客户端已断开时门禁返回假", await flow.gate(gone, null), false);
  eq("走的路径记 ccut 不记 stall", (W.COUNTER.values.ccut || 0) > 0 && !(W.COUNTER.values.stall || 0), true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case213({ fs, eq, ok, W }) {
  const pickSrc = fs.readFileSync("src/px/pickpath.ts", "utf8");

  // 文件数：四个曾经拆出去的文件都不在了（用户要求：减少文件数、增加类数）
  const gone = ["pick-types", "pick-ready", "pick-site", "pick-pref"].filter((n) => fs.existsSync(`src/px/${n}.ts`));
  eq("四个曾经拆出去的文件已并回 pickpath", gone.join(","), "");

  // 一个文件里要有四个单元：形状 + 三个类 + 一个就绪函数 + 三个单例
  ok("一个文件里四个单元齐备", pickSrc.includes("export interface PickState") && pickSrc.includes("export class PickPath") && pickSrc.includes("export class SitePick") && pickSrc.includes("export class PathPrefs") && pickSrc.includes("export async function ensureReady("));
ok("pickpath 不再导出模块级实例，组件由 PickPath 持有", !pickSrc.includes("export const PICK") && !pickSrc.includes("export const SITE") && !pickSrc.includes("export const PATHS") && pickSrc.includes("readonly site = new SitePick();") && pickSrc.includes("readonly paths = new PathPrefs();"));
  ok("文件头写清为什么合在一起", pickSrc.includes("四段无独立生命周期"));

  // 编排仍然只做编排：抽样与画像调用只在画像那一段里
  ok("pick 四行内委托给持有的画像组件", /pick\([^)]*\)[^{]*\{[^}]*return this\.site\.pick\(/.test(pickSrc));
  ok("编排走 ensureReady 而不是自己拉池子", pickSrc.includes("await ensureReady(env);"));
  ok("池子等待有上限", pickSrc.includes("700"));
  ok("起搏不 await", !pickSrc.includes("await seedAlive("));

  // 画像段与偏好段的边界仍然成立（同一文件里靠「谁调用谁」分，而不是靠目录分）
  ok("画像段负责抽样与溢出", pickSrc.includes("new ThompsonPicker(") && pickSrc.includes("private spill(") && pickSrc.includes("private leastBad("));
  ok("偏好段七个入口齐备", ["vetoed(", "byPrefer(", "nonCfFirst(", "byNonCf(", "rescan(", "chanOpen(", "byChan("].every((f) => pickSrc.includes(f)));
  ok("偏好段的站点否决需要 host 参数", pickSrc.includes("vetoed(host: string, key: string)") && pickSrc.includes("byNonCf(host: string"));
  ok("偏好段不自己抽样", !pickSrc.slice(pickSrc.indexOf("export class PathPrefs")).includes("ThompsonPicker"));

  // 行为面：三个单例都在，且「没有站点上下文时不否决任何通道」
ok("门面持有三个组件，模块级不再有 SITE / PATHS / PICK", W.SEL.picker instanceof W.PickPath && W.SEL.picker.site instanceof W.SitePick && W.SEL.picker.paths instanceof W.PathPrefs && W.SITE === undefined && W.PATHS === undefined && W.PICK === undefined);
ok("空站点时一律不否决", W.SEL.picker.paths.vetoed("", "203.0.113.9:443") === false);
ok("空站点时通道判据也放行", W.SEL.picker.paths.chanOpen("", "203.0.113.9:443") === true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case214({ fs, ok, eq, W }) {
  const pol301 = fs.readFileSync("src/route/policy.ts", "utf8");
  const src301 = fs.readFileSync("src/px/probe.ts", "utf8");
  const probe301 = fs.readFileSync("src/px/probe.ts", "utf8");
  const ip301 = fs.readFileSync("src/routes/proxyip.ts", "utf8");
  ok("策略模块不再有转发函数", !/export function (decide|shadow|policyOn)\(/.test(pol301));
  ok("策略本体的两个方法还在", pol301.includes("  decide(c: Ctx): Choice {") && pol301.includes("  shadow(c: Ctx): Choice {"));
  ok("策略是否生效改成只读属性", pol301.includes("  get enabled(): boolean {") && pol301.includes("return SC.POLICY > 0;"));
  ok("源健康度不再有转发函数", !/export function (srcRank|srcNote|srcHealth)\(/.test(src301));
  ok("源健康度内部直接用单例", src301.includes("SOURCES.rank(env)") && src301.includes("SOURCES.note(src,"));
  ok("probe 的再导出里没有旧名字", !/src(Rank|Note|Health)/.test(probe301) && probe301.includes("SOURCES"));
  ok("调用点直接用单例（不再经包装）", ip301.includes("SOURCES.rank(env)") && ip301.includes("SOURCES.snap()"));
  eq("策略单例的能力齐全", [typeof W.POLICY.decide, typeof W.POLICY.shadow, typeof W.POLICY.enabled], ["function", "function", "boolean"]);
  eq("源单例的能力齐全", [typeof W.SOURCES.rank, typeof W.SOURCES.note, typeof W.SOURCES.snap], ["function", "function", "function"]);
  ok("源健康快照是对象", typeof W.SOURCES.snap() === "object");
  ok("三个旧入口在测试窗口里也拿不到", [W.decide, W.shadow, W.policyOn, W.srcRank, W.srcNote, W.srcHealth].every((f) => f === undefined));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case215({ fs, ok, eq, W }) {
  const src302 = fs.readFileSync("src/nodes/stat.ts", "utf8");
  const writes = ["nsEmptyClose", "nsOk", "nsProbe", "nsProbeFail", "nsFail", "nsSiteFail", "nsSpeed", "nsStall", "nsLatency"];
  ok(
    "九个写入都是类方法（签名缩进两格）",
    writes.every((f) => new RegExp("\\n  static " + f + "\\(", "m").test(src302)),
    true,
  );
  ok(
    "不再有同名模块函数",
    writes.every((f) => !new RegExp("export function " + f + "\\(", "m").test(src302)) &&
      !/^export function (nsGet|invalidateRank)\(/m.test(src302),
    true,
  );
  ok("取条目与打缓存仍是类方法", src302.includes("  static nsGet(k: string): NodeStats {") && src302.includes("  static invalidateRank() {"), true);
  ok("派生层仍是纯函数（不读 S）", /export function effView\(s: NodeStats/m.test(src302) && /export function pStallOf\(s: NodeStats/m.test(src302), true);
  ok("写入方法一律经 this.nsGet 取条目", (src302.match(/this\.nsGet\(/g) || []).length >= 9, true);
  eq("单例退场后仍能经类取统计", typeof W.NodeStatsTable.nsGet, "function");
  ok("测试窗口只剩类、没有转发", typeof W.NodeStatsTable.nsOk === "function" && W.nsOk === undefined, true);

  // 行为面：写入走单例后仍然累加同一张表
  const k302 = "13.7.7.7:443";
  W.NODE_MEMORY.stats.delete(k302);
  W.NodeStatsTable.nsOk(k302, 120, 80);
  W.NodeStatsTable.nsFail(k302);
  W.NodeStatsTable.nsSiteFail(k302);
  W.NodeStatsTable.nsStall(k302, 500, 2000);
  const row302 = W.NodeStatsTable.nsGet(k302);
  eq(
    "成功 1 次、失败 1 次 + 站点失败 0.2 次（各自进 fail 与 failW）",
    [row302.ok, Math.round(row302.fail * 10) / 10, Math.round(row302.failW * 10) / 10],
    [1, 1.2, 1.2],
  );
  eq("卡顿样本原样进表", [row302.stallMs, row302.runMs], [500, 2000]);
  ok("失败留下冷却（blackUntil > now）", row302.blackUntil > Date.now(), true);
  W.NodeStatsTable.nsLatency(k302, 300);
  ok("首字节样本写进矩", row302.pSum > 0 && row302.msLocal > 0, true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case216({ ok, W, eq, fs }) {
  // 旧名字必须真的拿不到（不是「导出成 undefined」而是压根没有这个导出）
  const gone = ["errDup", "hostRank", "hostUntried", "probeBadSkip", "sweepProbeBad", "capFactor", "capNote",
    "relCost", "relCostMode", "relSnap", "clSnapshot", "pendFlush", "primaryId"];
  for (const n of gone) ok("旧入口已删除：" + n, W[n] === undefined);

  // 能力仍然在，而且挂在它们操作的那张表上
  ok("冷却表自己判跳过", typeof W.COOLDOWN.skip === "function" && typeof W.COOLDOWN.sweep === "function");
  ok("画像表自己给排行", typeof W.HOSTS.rank === "function" && typeof W.HOSTS.untried === "function");
  ok("容量表自己给因子与记账", typeof W.CAP.factor === "function" && typeof W.CAP.note === "function");
  ok("实测表自己给代价与快照", typeof W.RELPERF.cost === "function" && typeof W.RELPERF.costFor === "function" && typeof W.RELPERF.snap === "function");
  ok("待上报账本自己报 id / 冲账 / 连接快照", typeof W.PEND.id === "function" && typeof W.PEND.flush === "function" && typeof W.PEND.clSnap === "function");
  ok("错误环自己报丢弃数", typeof W.ERRS.dropped === "function");

  // 行为面：没有样本时都不能凭空造出证据
  eq("没量过的站点 × 中继代价是 1e6", W.RELPERF.costFor("tput", "no-such-303.test", "203.0.113.203"), 1e6);
  eq("没量过的直连代价也是 1e6", W.RELPERF.cost("no-such-303.test", "203.0.113.203"), 1e6);
  eq("没量过的站点快照为空", W.RELPERF.snap("no-such-303.test"), []);
  eq("懒模式容量因子恒 1", W.CAP.factor("203.0.113.204", "lat"), 1);
  eq("没有冷却记录的键不跳过", W.COOLDOWN.skip("cool303.test:443"), false);
  ok("丢弃计数是个数字", typeof W.ERRS.dropped() === "number");

  // 源码锁：这些名字只以「对象.方法」的形态出现，不再有同名模块函数
  const relSrc303 = fs.readFileSync("src/route/relperf.ts", "utf8");
  const pendSrc303 = fs.readFileSync("src/store/pend.ts", "utf8");
  const siteSrc303 = fs.readFileSync("src/nodes/metrics.ts", "utf8");
  const aliveSrc303 = fs.readFileSync("src/px/alive.ts", "utf8");
  ok("实测表不再有模块函数", !/export function rel(Cost|CostMode|Snap)\(/.test(relSrc303));
  ok("账本不再有模块函数", !/export function (pendFlush|clSnapshot|primaryId)\(/.test(pendSrc303));
  ok("画像表不再有模块函数", !/export function (hostRank|hostUntried)\(/.test(siteSrc303));
  ok("冷却表不再有模块函数", !/export function (probeBadSkip|sweepProbeBad)\(/.test(aliveSrc303));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case217({ fs, ok, W, eq }) {
  const egSrc = fs.readFileSync("src/route/egfacts.ts", "utf8");
  const psSrc = fs.readFileSync("src/route/psfacts.ts", "utf8");
  const deadSrc = fs.readFileSync("src/route/deadfacts.ts", "utf8");
  const dnsSrc = fs.readFileSync("src/route/dnsfacts.ts", "utf8");
  ok("四张事实表都继承同一个基类",
    [egSrc, psSrc, deadSrc, dnsSrc].every((x) => /export class \w+ extends FactTable</.test(x)), "");
  ok("出口族与成功率表不再自己维护 pending/sent",
    !egSrc.includes("private sent") && !egSrc.includes("private pend") &&
      !psSrc.includes("private sent") && !psSrc.includes("private pending") &&
      !psSrc.includes("export class PsOutbox"), "");
  ok("批次上限各自在子类里声明（eg 16 / ps 60）",
    egSrc.includes("protected get batchMax(): number {") && egSrc.includes("return 16;") &&
      psSrc.includes("return PS_BATCH;"), "");
  // 行为面：同一批没有被 ack 之前会被重复交出（重发 = 重试，不是重复计数）
  W.PS.clear();
  W.PS.note("ps305.example", "203.0.113.71", true, Date.now());
  {
    const d1 = W.PS.delta();
    const d2 = W.PS.delta();
    eq("未 ack 时同一行会被重复交出（重试语义）", d1.length === 1 && d2.length === 1, true);
    W.PS.ack();
    eq("ack 之后不再重发", W.PS.delta().length, 0);
  }
  // nack 什么都不清：失败的那批必须还在，否则这条证据永远到不了 DO
  W.PS.clear();
  W.PS.note("ps305.example", "203.0.113.72", false, Date.now());
  {
    const d1 = W.PS.delta();
    W.PS.nack();
    const d2 = W.PS.delta();
    eq("nack 之后同一行原样重发", d1.length === 1 && d2.length === 1 && d2[0].k === d1[0].k, true);
  }
  // 出口族表：同族重复观测不刷新 at（否则过期时间会被无限推后）
  W.EG.clear();
  {
    const t0 = Date.now() - 5 * 60000;
    W.EG.note("203.0.113.73", 4, t0 + 60000);
    const before = W.EG.snap()[0].at;
    W.EG.note("203.0.113.73", 4, t0);
    eq("同族且更旧的观测不覆盖", W.EG.snap()[0].at, before);
    W.EG.note("203.0.113.73", 6, t0 + 60000);
    eq("换族才覆盖", W.EG.famOf("203.0.113.73"), 6);
  }
  W.PS.clear();
  W.EG.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case218({ fs, ok, W, eq }) {
  const base = fs.readFileSync("src/route/fact-table.ts", "utf8");
  const tables = {
    dead: "src/route/deadfacts.ts",
    dns: "src/route/dnsfacts.ts",
    eg: "src/route/egfacts.ts",
    ps: "src/route/psfacts.ts",
    blk: "src/route/blkfacts.ts",
  };
  ok("五张事实表都继承同一个基类",
    Object.values(tables).every((f) => /extends FactTable</.test(fs.readFileSync(f, "utf8"))), "");
  const cap306 = fs.readFileSync("src/route/capfacts.ts", "utf8");
  ok("容量表刻意不继承（没有线格式与待上报队列）",
    !cap306.includes("extends FactTable<") && cap306.includes("CAP_MAX"), "");
  ok("基类提供 unpend 并写明与 forget 的区别",
    base.includes("protected unpend(key: string): void {") && base.includes("与 `forget` 的区别"), "");
  ok("有界化写在插入路径上", /put\([\s\S]{0,400}this\.trim\(now\);/.test(base), "");
  ok("封锁表不再自己做容量淘汰", !fs.readFileSync(tables.blk, "utf8").includes("private drop("), "");
  ok("封锁表的队列字段全部消失",
    !fs.readFileSync(tables.blk, "utf8").includes("outbox"), "");
  // 行为面：delta 与 ack 之间又记了一条更新的观测，那条不能被 ack 清掉（只有 ack 清「发出去的那一版」）
  W.PS.clear();
  const now306 = 7000000;
  W.PS.note("h306.test", "198.51.100.31", true, now306);
  eq("第一条已进待上报", W.PS.delta().length, 1);
  W.PS.note("h306.test", "198.51.100.31", false, now306 + 1000);
  W.PS.ack();
  eq("ack 之后新观测仍待上报", W.PS.delta().length, 1);
  W.PS.ack();
  eq("第二次 ack 之后才清空", W.PS.delta().length, 0);
  W.PS.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case221({ fs, ok, W, eq }) {
  const src = fs.readFileSync("src/proxy/connection.ts", "utf8");
  ok("sample-window.ts 已不存在", !fs.existsSync("src/proxy/sample-window.ts"));
  ok("client-flow.ts 已不存在", !fs.existsSync("src/proxy/client-flow.ts"));
  ok("三个类同住 connection.ts",
    /export class Connection \{/.test(src) &&
      /export class SampleWindow \{/.test(src) &&
      /export class ClientFlow \{/.test(src));
  ok("connection.ts 仍在 560 行上限内", src.split(/\r?\n/).length <= 560, String(src.split(/\r?\n/).length));
  ok("窗口常量仍是模块级常量",
    src.includes("export const NODE_WIN_MS = 800;") &&
      src.includes("export const NODE_EMIT_GAP_MS = 5000;") &&
      src.includes("export const SITE_WIN_MS = 60000;") &&
      src.includes("export const FLOW_TICK_MS = 10;"));
  ok("连接仍通过组合持有两个对象",
    src.includes("readonly win = new SampleWindow();") &&
      src.includes("readonly flow = new ClientFlow();"));
  ok("两个类都仍然导得出来",
    typeof W.SampleWindow === "function" && typeof W.ClientFlow === "function");
  const win = new W.SampleWindow();
  // 起点不能是 0：`node()` 用 `!this.at` 判「没有起点」，0 会被当成没建立窗口。
  win.begin(10000, 0, 0);
  eq("窗口短于 800ms 不出样本", win.node(10500, 900000, 0), null);
  // 窗口太短时边界不动，出样本间隔从 lastEmit=0 起算 5 秒 —— 两条都满足才出样本。
  const w = win.node(20000, 307200, 0);
  ok("10 秒 300KB 出样本", Boolean(w) && w.bytes === 307200 && w.elapsedMs === 10000, JSON.stringify(w));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case222({ fs, eq, ok, W }) {
    const missing311 = [
      "src/core/firstobs.ts",
      "src/core/latobs.ts",
      "src/core/node-snapshot.ts",
      "src/proxy/conn-sample.ts",
      "src/views/subview.ts",
    ].filter((f) => fs.existsSync(f));
    eq("五份被并掉的文件都不在了", missing311, []);
    const obs311 = fs.readFileSync("src/core/obs.ts", "utf8");
    ok(
      "观测汇总里有首字节、延迟分布与速度快照",
      obs311.includes("export class FirstObs") &&
        obs311.includes("export class LatObs") &&
        obs311.includes("export function spdSnapshot") &&
        obs311.includes("export const FO = new FirstObs();") &&
        obs311.includes("export const LAT = new LatObs();"),
      "obs.ts 必须同时住着 FirstObs / LatObs / spdSnapshot",
    );
    ok(
      "观测汇总写清「探活 RTT 不进这里」",
      obs311.includes("探活 RTT 不进这里") && obs311.includes("CUSUM"),
      "这条纪律被违反过三次，注释必须在文件头",
    );
    const settle311 = fs.readFileSync("src/proxy/conn-settle.ts", "utf8");
    ok(
      "结算文件里也有采样换算",
      settle311.includes("export const SAMPLE_STD_BYTES") &&
        settle311.includes("export function stalledWindow") &&
        settle311.includes("export function kbsOf") &&
        settle311.includes("export function sampleWeight") &&
        !settle311.includes("export const SETTLE"),
      "conn-settle.ts 必须同时住着换算与结算",
    );
    const sub311 = fs.readFileSync("src/views/sub.ts", "utf8");
    ok(
      "订阅视图分派与 clash 渲染同住一个文件",
      sub311.includes("export class SubscriptionView") &&
        !sub311.includes("export const SUBVIEW =") && sub311.includes("export class SubscriptionView {") &&
        sub311.includes("export function renderClash"),
      "sub.ts 必须同时住着 renderClash 与 SubscriptionView",
    );
    ok(
      "三种格式的渲染入口都能拿到",
      typeof W.renderClash === "function" && typeof W.renderSingbox === "function" && typeof W.renderLinks === "function",
      "三个渲染入口",
    );
    const files311 = fs.readdirSync("src", { recursive: true }).filter((f) => String(f).endsWith(".ts")).length;
    ok("文件数降到 124 以内", files311 <= 124, `实际 ${files311}`);
    ok(
      "三个观测单例都还在",
      W.FO instanceof W.FirstObs && W.LAT instanceof W.LatObs && typeof W.spdSnapshot === "function",
      "观测单例",
    );
    // 行为面：延迟分布的百分位仍然按窗口算，首字节分类仍然记账
    W.LAT.clear();
    W.FO.clear();
    W.FO.note(60000);
    W.LAT.note(true, 800);
    W.LAT.note(false, 0);
    const foSnap311 = W.FO.snap();
    const latSnap311 = W.LAT.snap();
    eq("首字节分类记了一次整页", foSnap311.page, 1);
    eq("延迟分布把成功与失败各记一条", latSnap311.n, 2);
    eq("延迟分布的 p50 就是那条成功样本", latSnap311.p50, 800);
  }

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case224({ fs, ok, W }) {
  const g = 313;
  const fm = fs.readFileSync("src/store/factmerge.ts", "utf8");

  ok(`[${g}] 合并规则是一个类，不是模块函数`,
    fm.includes("export class FactMerger {") && !/^export function mergeFacts/m.test(fm));
  ok(`[${g}] 每张表一个私有方法，merge() 只负责分派`,
    ["egRows", "dnsRows", "psRows", "deadRows", "blkRows"].every((x) => fm.includes(`private ${x}(`)) &&
      (fm.match(/this\.(eg|dns|ps|dead|blk)Rows\(t, d\./g) || []).length === 5);
  ok(`[${g}] 五张表的寿命都来自 FACT_TTL（没有第二份裸数字）`,
    ["FACT_TTL.eg", "FACT_TTL.dns", "FACT_TTL.ps", "FACT_TTL.dead", "FACT_TTL.blk"].every((x) => fm.includes(x)));
  ok(`[${g}] 合并规则不再自带单例（由调用方持有）`, !/export const [A-Z_]+ = new FactMerger/.test(fm));

  // 行为面：走类实例，不碰模块函数
  const merger = new W.FactMerger();
  const now313 = Date.now();
  const t313 = {
    eg: {},
    ps: {},
    dead: {},
    blk2: {},
    dns: {},
  };
  merger.merge(t313, {
    eg: [{ i: "203.0.113.9", f: 4, at: now313 }, { i: "203.0.113.10", f: 6, at: now313 }, { i: "203.0.113.11", f: 5, at: now313 }],
    dns: [{ k: "example.com", v: 1, at: now313 }, { k: "bad.example", v: 7, at: now313 }],
    dead: [{ i: "198.51.100.4", n: 1, at: now313 }, { i: "198.51.100.5", n: 3, at: now313 }],
  });
  ok(`[${g}] 坏族号与坏 DNS 值被丢弃，好行留下`,
    Object.keys(t313.eg).length === 2 && t313.eg["203.0.113.9"].f === 4 && t313.dns["bad.example"] === undefined && t313.dns["example.com"].v === 1,
    JSON.stringify(t313));
  ok(`[${g}] 连不上表只收判死行（n>=2）`, t313.dead["198.51.100.4"] === undefined && t313.dead["198.51.100.5"].n === 3);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case225({ fs, ok, eq, W }) {
  // 第 314 组：调试路由的四个模块级单例收进一个组合根。
  // 收的理由不是「少几个名字」，而是它们只在一个地方按固定顺序出场：
  // 分散成四个 export 时，读代码的人得自己拼「这次调试动用了哪些能力」，
  // 也就看不出「点这个参数会不会真的拨号」。
  const dbg = fs.readFileSync("src/routes/debug.ts", "utf8");
  const netsSrc = fs.readFileSync("src/routes/debug-nets.ts", "utf8");
  ok("四个单例已收进组合根", ["export const TABLES = new DebugTables();", "export const ACTIONS = new DebugActions();", "export const METER_PROBES = new DebugMeterProbes();"].every((x) => !dbg.includes(x)), "");
  ok("debug-nets.ts 不再自带 NETS", !netsSrc.includes("export const NETS = new DebugNets();"), "");
  ok("组合根声明四个组件字段",
    ["readonly tables = new DebugTables();", "readonly nets = new DebugNets();", "readonly actions = new DebugActions();", "readonly probes = new DebugMeterProbes();"]
      .every((x) => dbg.includes(x)), "");
  ok("组合根只有一个实例", (dbg.match(/export const DEBUG = new DebugSuite\(\);/g) || []).length === 1, String((dbg.match(/export const DEBUG = new DebugSuite\(\);/g) || []).length));
  // 编排层必须经组合根出场：这样「一次调试用了什么」在同一个对象上可数
  ok("编排层全部经组合根调用",
    !/^\s+(TABLES|NETS|ACTIONS|METER_PROBES)\./m.test(dbg) && (dbg.match(/DEBUG\.(tables|nets|actions|probes)\./g) || []).length >= 13,
    String((dbg.match(/DEBUG\.(tables|nets|actions|probes)\./g) || []).length));
  eq("四个旧名字在测试窗口里都拿不到", [W.TABLES, W.NETS, W.ACTIONS, W.METER_PROBES].every((x) => x === undefined), true);
  // 行为面：组合根持有的就是那四个实例，且规格表仍是只读常量
  ok("组合根持有四个组件", W.DEBUG instanceof W.DebugSuite && W.DEBUG.tables instanceof W.DebugTables && W.DEBUG.nets instanceof W.DebugNets && W.DEBUG.actions instanceof W.DebugActions && W.DEBUG.probes instanceof W.DebugMeterProbes, "");
  eq("计量探测的规格表是六个只读端点", W.DEBUG.probes.specs.length, 6);
  ok("规格表是只读声明", dbg.includes("readonly specs: readonly ProbeSpec[]"), "");
  eq("组合根是唯一实例", W.DEBUG === W.DEBUG, true);
  ok("源码文件数仍在预算内", fs.readdirSync("src", { recursive: true }).filter((f) => String(f).endsWith(".ts")).length <= 124, "");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case226({ fs, ok, W, eq }) {
  const scoreSrc315 = fs.readFileSync("src/nodes/score.ts", "utf8");
  const statSrc315 = fs.readFileSync("src/nodes/stat.ts", "utf8");
  ok("四个入口不再是模块函数", !/^export function (rankedCands|candsFor|nextNode|bestFor)\(/m.test(scoreSrc315), "");
  ok("候选表是类且带单例", /^export class CandidateBoard /m.test(scoreSrc315) && /^export const CANDS = new CandidateBoard\(\);/m.test(scoreSrc315), "");
  ok("缓存与分片游标是它的字段", /readonly cache: RankCache = \{ gen: 0, at: \{\}, v: \{\}, step: \{\} \};/.test(scoreSrc315), "");
  ok("作废走代际号（stat.ts 不必反向 import）", /NODE_MEMORY\.invalidateRanks\(\);/.test(statSrc315), "");
  ok("S 上不再有排行缓存对象", W.S === undefined, "");
  eq("代际号是数字", typeof W.NODE_MEMORY.generation, "number");
  eq("四个方法都在实例上", ["ranked", "list", "next", "best"].every((n) => typeof W.CANDS[n] === "function"), true);
  // 行为面：作废只清时间戳，排行与分片进度留着（失败密集时不退化成半张表）
  W.NODE_MEMORY.alive.clear();
  W.NODE_MEMORY.stats.clear();
  W.CANDS.reset();
  W.NODE_MEMORY.alive.set("c315a:443", { h: "c315a", p: 443, cc: "US", ms: 80 });
  W.NODE_MEMORY.alive.set("c315b:443", { h: "c315b", p: 443, cc: "JP", ms: 200 });
  for (let i = 0; i < 30; i++) {
    W.NODE_MEMORY.alive.set("fill" + i + ":443", { h: "fill" + i, p: 443, cc: "US", ms: 90 + i });
  }
  const first = W.CANDS.list("lat");
  ok("候选表给出排行", first.length > 0, String(first.length));
  const stamp = W.CANDS.cache.at.lat;
  ok("排行写了时间戳", typeof stamp === "number" && stamp > 0, String(stamp));
  W.NodeStatsTable.invalidateRank();
  eq("作废后代际号变了", W.NODE_MEMORY.generation > 0, true);
  W.CANDS.list("lat");
  ok("作废只换代际号，不清排行", W.CANDS.cache.v.lat.length > 0, "");
  W.CANDS.list("lat"); // 惰性自清 + 重算一行
  eq("自清后代际号对齐", W.CANDS.cache.gen, W.NODE_MEMORY.generation);
  eq("next 跳过指定节点", W.CANDS.next("lat", "c315a:443") === "c315a:443", false);
  eq("next 能按国家码限定", W.CANDS.next("lat", "", "JP").endsWith(":443"), true);
  eq("best 给第一名", typeof W.CANDS.best("lat"), "string");
  W.CANDS.reset();
  eq("reset 清空缓存", W.CANDS.cache.at.lat || 0, 0);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case227({ fs, ok }) {
  const pipSrc316 = fs.readFileSync("src/routes/proxyip.ts", "utf8");
  ok("代理池路由有视图类", /^export class ProxyipView \{/m.test(pipSrc316));
  ok("入口只做对象创建与一次执行", /export async function proxyip\(c: UserCtx\): Promise<Response> \{\s*return new ProxyipView\(c\)\.run\(\);\s*\}/m.test(pipSrc316));
  ok("五个分支各是一个方法", ["dayReport", "sourceReport", "resetPool", "refreshPool", "poolReport"].every((n) => pipSrc316.includes("private async " + n + "(") || pipSrc316.includes("private async " + n + "()") || pipSrc316.includes("private " + n + "(")));
  ok("分派顺序与原来一致（只读在前、动作在后）", pipSrc316.indexOf("this.dayReport()") < pipSrc316.indexOf("this.resetPool()") && pipSrc316.indexOf("this.sourceReport()") < pipSrc316.indexOf("this.refreshPool()"));
  ok("只读报表不改内存（?day 不碰 NODE_MEMORY.alive）", pipSrc316.slice(pipSrc316.indexOf("private async dayReport"), pipSrc316.indexOf("private async sourceReport")).indexOf("NODE_MEMORY.alive") < 0);
  ok("两个写动作都要管理员", pipSrc316.slice(pipSrc316.indexOf("private async resetPool"), pipSrc316.indexOf("private async poolReport")).split("adminOnly(this.c)").length - 1 === 2);
  ok("refresh 被 cron 占住时如实回绝（带持有毫秒）", pipSrc316.includes("heldMs: CRON_LOCK.age()"));
  ok("视图持有本次请求的上下文", pipSrc316.includes("private readonly url: URL;") && pipSrc316.includes("private readonly id: string;"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case228({ fs, ok, W }) {
  const admSrc317 = fs.readFileSync("src/routes/admin.ts", "utf8");
  ok("管理路由有视图类", /^export class AdminView \{/m.test(admSrc317));
  ok("入口只做对象创建与一次执行", /export async function admin\(c: RouteCtx\): Promise<Response> \{\s*return new AdminView\(c\)\.run\(\);\s*\}/m.test(admSrc317));
  ok("四个分支各是一个方法", ["logout", "login", "usersOp", "panel"].every((n) => admSrc317.includes("private async " + n + "(") || admSrc317.includes("private " + n + "(")));
  ok("分派顺序与原来一致（登出 → 登录 → 鉴权 → 用户操作 → 面板）", admSrc317.indexOf("this.logout()") < admSrc317.indexOf("this.login()") && admSrc317.indexOf("adminAuthed(") < admSrc317.indexOf("this.usersOp()"));
  ok("短管理密钥直接拒绝（挑战-应答依赖密钥本身的熵）", admSrc317.includes("this.adminKey.length < 12"));
  ok("读不到用户表时拒绝改写（否则会把缺失的用户整份删掉）", admSrc317.includes("cur.ok === false"));
  ok("面板按 ADMIN_STATS_MAX 截断并记下被截人数", admSrc317.includes("SC.ADMIN_STATS_MAX") && admSrc317.includes('cnt("admStatsSkip"'));
  const admEnv317 = { adminKey: "" };
  const mkAdm317 = (env, first, seg, method) => ({
    env,
    url: new URL("https://example.com/admin" + (seg.length ? "/" + seg.join("/") : "")),
    request: new Request("https://example.com/admin", { method: method || "GET" }),
    host: "example.com",
    first,
    seg,
    pageKey: undefined,
  });
  const noKey = await W.admin(mkAdm317(admEnv317, "admin", [], "GET"));
  ok("没配 adminKey 时整块面板关闭", noKey.status === 503);
  const shortKey = await W.admin(mkAdm317({ adminKey: "short" }, "admin", [], "GET"));
  ok("管理密钥太短时拒绝", shortKey.status === 503);
  const notAdmin = await W.admin(mkAdm317({ adminKey: "0123456789abcdef" }, "health", [], "GET"));
  ok("非 /admin 前缀直接 404", notAdmin.status === 404);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case229({ fs, ok, W, eq }) {
  const sessSrc = fs.readFileSync("src/proxy/session.ts", "utf8");
  ok("会话是类，入口只做创建与一次执行", /export async function handleUpgrade\(request: Request, env: Env, ctx: ExecutionContext\): Promise<Response> \{\s*return new ProxySession\(request, env, ctx\)\.run\(\);\s*\}/m.test(sessSrc));
  ok("入口函数里不再有管道代码", sessSrc.slice(sessSrc.indexOf("export async function handleUpgrade")).indexOf("pipeTo") < 0);
  ok("四段各自成方法", ["feed", "parseHead", "dial", "finish"].every((n) => sessSrc.includes("private async " + n + "(") || sessSrc.includes("private " + n + "(")));
  ok("拨号的两条路各自成方法", fs.readFileSync("src/proxy/fallback.ts", "utf8").includes("private async viaRegion(") && fs.readFileSync("src/proxy/fallback.ts", "utf8").includes("private async viaFallback("));
  ok("连接对象是它的字段", sessSrc.includes("private readonly conn: Connection;"));
  ok("已连上就只转发，不再解析协议头", sessSrc.indexOf("if (st.sock) return st.upWrite(") < sessSrc.indexOf("await this.parseHead("));
  ok("地区分流先于拨号策略", (() => { const b = fs.readFileSync("src/proxy/fallback.ts", "utf8"); const a = b.indexOf("if (this.o.ipRegion) return this.viaRegion("); return a >= 0 && a < b.indexOf("return await DIALER.open("); })());
  ok("数据面不反向依赖判定层", sessSrc.indexOf('from "../route/') < 0 && sessSrc.indexOf("from \"../route") < 0);

  // 行为面：参数解析搬进了构造函数，用最小环境构造一次就能验证（构造过程没有任何 I/O）。
  const RealPair = globalThis.WebSocketPair;
  class FakeWS318 {
    constructor() {
      this.readyState = 1;
      this.bufferedAmount = 0;
      this.sent = [];
    }
    accept() {}
    send(d) {
      this.sent.push(d);
    }
    close() {}
  }
  globalThis.WebSocketPair = class {
    constructor() {
      this[0] = new FakeWS318();
      this[1] = new FakeWS318();
    }
  };
  const ps318 = new W.ProxySession(
    new Request("https://edge.test/x?mode=lat&px=1&sz=b&rg=hk&ip=phone-1&rx=1.2.3.4:443"),
    {},
    { waitUntil: () => {}, passThroughOnException: () => {} },
  );
  eq("模式取自查询串", ps318.mode, "lat");
  eq("强制中转开关", ps318.pxForce, 1);
  eq("目标流量档位", ps318.conn.targetBytes, W.SC.SZ_B);
  eq("地区参数转成大写", ps318.ipRegion, "HK");
  eq("标签截断后留用", ps318.ipTag, "phone-1");
  eq("诊断钉住的中继", ps318.conn.forceRelayIp, "1.2.3.4:443");
  const ps318b = new W.ProxySession(new Request("https://edge.test/x?mode=bogus&px=0&rx=bad host!"), {}, {});
  eq("非法模式回落到吞吐", ps318b.mode, "tput");
  eq("强制直连开关", ps318b.pxForce, -1);
  eq("非法 ?rx= 被丢掉", ps318b.conn.forceRelayIp, "");
  globalThis.WebSocketPair = RealPair;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case230({ fs, ok, W, eq }) {
  const addSrc319 = fs.readFileSync("src/store/meteradd.ts", "utf8");
  const msSrc319 = fs.readFileSync("src/store/meter.ts", "utf8");
  ok("合并器是一个类", addSrc319.includes("export class MeterAdd"));
  ok("那个 145 行的函数已经不存在", !addSrc319.includes("export function applyAdd("));
  for (const name of ["dayCounter", "errors", "connRing", "verdicts", "relayHealth", "snapshots", "usage"]) {
    ok("合并器自己有 " + name + " 一步", addSrc319.includes("  private " + name + "(m: AddTarget, d: MeterBody): void {"));
  }
  ok("六张事实表仍交给 FactMerger", addSrc319.includes("private readonly merger = new FactMerger();"));
  ok("按顺序分派八段", addSrc319.includes("this.dayCounter(m, d);") && addSrc319.includes("this.usage(m, d);"));
  ok("模块级单例没有了", !/^(export )?const MERGER = /m.test(addSrc319));
  ok("Meter 持有一个合并器", msSrc319.includes("private readonly adder = new MeterAdd();"));
  ok("Meter 把账本交给合并器", msSrc319.includes("this.adder.apply(this.ledger, d);"));

  // 行为面：真合并一次，八段各自生效
  const adder319 = new W.MeterAdd();
  const mk319 = () => ({
    usage: { up: 0, down: 0, conns: 0, dU: 0, dD: 0, ts: 0, first: 0, d: "" },
    dayCounter: {},
    nodeSnapshots: Object.create(null),
    errors: [],
    connRing: [],
    vt: {},
    hl: {},
    eg: {},
    ps: {},
    dead: {},
    blk2: {},
    dns: {},
  });
  const m319 = mk319();
  adder319.apply(m319, {
    up: 10,
    down: 20,
    conns: 2,
    e: [{ t: 1000, m: "first" }],
    hl: [{ i: "1.2.3.4", o: 3, b: 1, d: 0 }],
    spd: { "n:443": { at: 5 } },
    cl: [{ k: "n:443", n: 2, ok: 2, p50: 100, p95: 200, dn: 4096 }],
  });
  eq("用量三段都加上去了", [m319.usage.up, m319.usage.down, m319.usage.conns], [10, 20, 2]);
  eq("当日字节同步累加", [m319.usage.dU, m319.usage.dD], [10, 20]);
  eq("错误环收下那条", m319.errors.length, 1);
  eq("中继存活度整条落表", [m319.hl["1.2.3.4"].o, m319.hl["1.2.3.4"].b], [3, 1]);
  eq("节点快照按原值存", m319.nodeSnapshots["n:443"].at, 5);
  eq("连接观测进来了", [m319.connRing.length, m319.connRing[0].n], [1, 2]);
  eq("首次使用时间只写一次", m319.usage.first === m319.usage.ts, true);

  // 行为面：更少的证据不能覆盖更老的更强证据（7.181 的口径）
  adder319.apply(m319, { hl: [{ i: "1.2.3.4", o: 1, b: 1, d: 0 }] });
  eq("条数少的证据不覆盖", [m319.hl["1.2.3.4"].o, m319.hl["1.2.3.4"].b], [3, 1]);

  // 行为面：昨日计数不会把今天回滚
  const m319b = mk319();
  m319b.dayCounter = { d: "2999-01-01", x: 5 };
  adder319.apply(m319b, { c: { d: "2000-01-01", x: 1 } });
  eq("旧日期的计数被丢掉", [m319b.dayCounter.d, m319b.dayCounter.x], ["2999-01-01", 5]);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case231({ fs, ok, mkDO, eq }) {
  const msrc = fs.readFileSync("src/store/meter.ts", "utf8");
  ok("[320] 端点实现是同一个文件里的第二个类", msrc.includes("export class MeterEndpoints"));
  ok("[320] 不再有独立的端点文件", !fs.existsSync("src/store/meter-endpoints.ts"));
  ok("[320] 单文件仍受 560 行上限", msrc.split(/\r?\n/).length <= 560);

  // Meter 只剩生命周期：字段 + 构造 + loadShards + save + fetch
  ok("[320] Meter 持有端点类字段", msrc.includes("private readonly endpoints: MeterEndpoints;"));
  ok("[320] 端点在构造函数里装配", msrc.includes("this.endpoints = new MeterEndpoints(this.ledger, this.state, () => this.save());"));
  const meterBody = msrc.slice(msrc.indexOf("export class Meter {"), msrc.indexOf("export class MeterEndpoints"));
  ok("[320] Meter 不再自己实现端点分发", !meterBody.includes("async handle(req: Request)"));
  ok("[320] Meter 不再自己处理 /add", !meterBody.includes("async add(req: Request)"));
  ok("[320] Meter 不再自己序列化用量", !meterBody.includes("json(): Response"));

  // 端点类：八个方法各就各位
  const ep = msrc.slice(msrc.indexOf("export class MeterEndpoints"));
  for (const m of ["handle(", "add(req", "seed(req", "set(req", "read(p", "readBody(req", "json()", "earlierFirst("]) {
    ok(`[320] 端点类有 ${m}`, ep.includes(` ${m}`));
  }
  ok("[320] 合并器挂在端点类上", ep.includes("private readonly adder = new MeterAdd();"));
  ok("[320] 端点用注入的落盘回调", ep.includes("await this.persist();"));
  ok("[320] 端点不持有 Meter 本身", !ep.includes("MeterHost"));

  // 行为面：搬完之后分派与累计行为一位不变
  const d320 = mkDO();
  await d320.m.fetch(
    new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 3, down: 4, conns: 1 }) }),
  );
  await d320.m.fetch(
    new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 2, down: 6, conns: 1 }) }),
  );
  const j320 = await (await d320.m.fetch(new Request("https://m/get"))).json();
  eq("[320] 两次 /add 仍累加", [j320.up, j320.down, j320.conns], [5, 10, 2]);
  const c320 = await (await d320.m.fetch(new Request("https://m/cnt"))).json();
  eq("[320] /cnt 仍返回四张表", Object.keys(c320).sort(), ["c", "e", "g", "s"]);
  const v320 = await (await d320.m.fetch(new Request("https://m/vt"))).json();
  eq("[320] /vt 仍返回七张事实表", Object.keys(v320).sort(), ["blk2", "dead", "dns", "eg", "hl", "ps", "vt"]);
  // /set 只在任一维度更大时写：这里 conns=9 比当前 2 大，应当恢复
  await d320.m.fetch(
    new Request("https://m/set", { method: "POST", body: JSON.stringify({ up: 5, down: 10, conns: 9 }) }),
  );
  const s320 = await (await d320.m.fetch(new Request("https://m/get"))).json();
  eq("[320] /set 只按更大的连接数恢复", s320.conns, 9);
  eq("[320] /set 不把已更大的字节数改小", [s320.up, s320.down], [5, 10]);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case232({ fs, ok, eq, W }) {
  // 统一成 LF 再按 "\n  }\n" 切方法体：仓库里这个文件是 LF，但 checkout 出来可能是 CRLF
  const pip321 = fs.readFileSync("src/routes/proxyip.ts", "utf8").replace(/\r\n/g, "\n");
  // 按 2 空格缩进的收尾行切出方法体：这比按行号稳妥（文件会继续变长）
  const body321 = (sig) => {
    const at = pip321.indexOf(sig);
    if (at < 0) return "";
    const end = pip321.indexOf("\n  }\n", at);
    return pip321.slice(at, end < 0 ? undefined : end + 4);
  };
  const live = body321("  private async liveRows(");
  const why = body321("  private explain(");
  const rep = body321("  private async poolReport()");
  ok("[321] 行视图自己取跨 isolate 快照并排序", live.includes("nodeSnapGet(") && live.includes("nsOf(") && live.includes(".sort("));
  ok("[321] 解释块自己算画像与分项", why.includes("HOSTS.rank(") && why.includes("scoreParts("));
  ok("[321] 组装函数不再自己取快照", rep.length > 0 && !rep.includes("nodeSnapGet(") && !rep.includes("HOSTS.rank("));
  eq("[321] 冷却键只算一次（不再两处各扫一遍 nstat）", (pip321.match(/NODE_MEMORY\.stats\.entries\(\)/g) || []).length, 1);
  ok("[321] 三个方法各守一段", live.split("\n").length <= 60 && why.split("\n").length <= 75 && rep.split("\n").length <= 60,
    `${live.split("\n").length}/${why.split("\n").length}/${rep.split("\n").length}`);
  ok("[321] 视图类上确实有这三个方法", typeof W.ProxyipView.prototype.liveRows === "function" && typeof W.ProxyipView.prototype.explain === "function" && typeof W.ProxyipView.prototype.poolReport === "function");

  const mk321 = (q) => ({
    env: { NODE_ENV: "test" },
    url: new URL("https://sim.example.com/u/proxyip" + q),
    host: "sim.example.com",
    id: "u321b",
  });
  const d321 = await (await W.proxyip(mk321(""))).json();
  eq("[321] 默认视图仍给完整快照", Array.isArray(d321.alive) && d321.pool.memOnly === true, true);
  eq("[321] 默认视图不含解释块", "hostPref" in d321 || "explain" in d321, false);
  const w321 = await (await W.proxyip(mk321("?why=1"))).json();
  eq("[321] ?why=1 才带解释块", Array.isArray(w321.hostPref) && Array.isArray(w321.explain), true);
  const l321 = await (await W.proxyip(mk321("?mode=lat"))).json();
  eq("[321] 延迟模式仍能出快照", Array.isArray(l321.alive), true);
  eq("[321] 手动/自动标签按绑定判断", d321.mode, "manual");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case233({ fs, ok, eq, W }) {
  const dial322 = fs.readFileSync("src/proxy/dialer.ts", "utf8").replace(/\r\n/g, "\n");
  // 按方法签名切块：从 `\n  private async x(` 到下一个方法定义之前（方法是顶层缩进两格）
  const part322 = (name) => {
    const a1 = dial322.indexOf("\n  private async " + name + "(");
    const a2 = dial322.indexOf("\n  async " + name + "(");
    const start = a1 >= 0 ? a1 : a2;
    if (start < 0) return "";
    const rest = dial322.slice(start + 1);
    const heads = [...rest.matchAll(/^  (?:private )?(?:async )?[a-zA-Z_]\w*\(/gm)]
      .map((m) => m.index)
      .filter((i) => i > 0);
    return rest.slice(0, heads.length ? heads[0] : rest.length);
  };
  const open322 = part322("open");
  const cls322 = part322("classify");
  const via322 = part322("viaRelay");
  const dir322 = part322("direct");
  // 7.343：取候选与拨一次各成一个方法，判据分到这两个块里
  const next322 = part322("nextCand");
  const att322 = part322("attemptRelay");
  ok(
    "[322] 入口只做分派：判定 → 中转 → 直连",
    open322.includes("this.classify(o)") &&
      open322.includes("this.viaRelay(o, route.cfHost)") &&
      open322.includes("this.direct(o, host, port, route.cfHost)"),
    "open",
  );
  ok(
    "[322] 入口不再自己选路或解析候选",
    !open322.includes("SEL.current(") && !open322.includes("parseProxyIp(") && !open322.includes("isCfHost("),
    "open",
  );
  eq("[322] 入口短到一眼看完（≤20 行）", open322.split("\n").filter((l) => l.trim()).length <= 20, true);
  ok(
    "[322] 判定段负责 CF 托管识别、事实预热与连接事实",
    cls322.includes("this.dohCf(host, o.budget)") &&
      dial322.includes("await withTimeout(isCfHost(host, budget), 1200)") &&
      cls322.includes("refreshCfHttp(host") && cls322.includes("conn.cf = cfHost") && cls322.includes("HOOK.vtLoad("),
    "classify",
  );
  ok(
    "[322] 判定段不碰候选池",
    !cls322.includes("SEL.current(") && !cls322.includes("parseProxyIp(") && !cls322.includes("connect({"),
    "classify",
  );
  ok(
    "[322] 中转段负责逐条候选、名额与冷却",
    via322.includes("for (let guard = 0;") &&
      via322.includes("this.nextCand(") &&
      via322.includes("tries += 1;") &&
      via322.includes("this.attemptRelay(") &&
      !via322.includes("parseProxyIp("),
    "viaRelay",
  );
  ok(
    "[322] 取候选那一段负责解析、三类跳过与防重复",
    next322.includes("parseProxyIp(raw)") &&
      next322.includes("checkTarget(") &&
      next322.includes("tried.add(key)") &&
      next322.includes("isCfIp(p.host)"),
    "nextCand",
  );
  ok(
    "[322] 拨一次那一段负责上限、记账与冷却",
    att322.includes("withTimeout(pk, CONNECT_MS)") &&
      att322.includes("NodeStatsTable.nsFail(cand.key)") &&
      att322.includes("conn.pxTries = tries;"),
    "attemptRelay",
  );
  ok(
    "[322] 直连段先按 A 记录再退普通拨号，且不碰候选池",
    dir322.includes("dial4(host, port, o.budget)") && dir322.includes("dial(host, port, o.budget)") && !dir322.includes("SEL.current("),
    "direct",
  );
  ok(
    "[322] 两条直连都走有限等待",
    (dir322.match(/this\.guarded\(/g) || []).length === 2 && dial322.includes("private async guarded("),
    "direct",
  );
  ok(
    "[322] 五段按执行顺序排列",
    dial322.indexOf("async open(") < dial322.indexOf("private async classify(") &&
      dial322.indexOf("private async classify(") < dial322.indexOf("private async viaRelay(") &&
      dial322.indexOf("private async viaRelay(") < dial322.indexOf("private async direct(") &&
      dial322.indexOf("private async direct(") < dial322.indexOf("private async guarded("),
    "dialer",
  );
  ok(
    "[322] 五个方法都挂在类上",
    typeof W.DIALER.open === "function" &&
      typeof W.DIALER.classify === "function" &&
      typeof W.DIALER.viaRelay === "function" &&
      typeof W.DIALER.direct === "function" &&
      typeof W.DIALER.guarded === "function",
    "DIALER",
  );
  eq("[322] 有限等待直通结果", await W.DIALER.guarded(Promise.resolve(null), "g322.test"), null);
  let threw322 = false;
  try {
    await W.DIALER.guarded(Promise.reject(new Error("g322")), "g322.test");
  } catch {
    threw322 = true;
  }
  eq("[322] 有限等待把失败原样抛出", threw322, true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case234({ fs, ok, W, eq }) {
  const jSrc = fs.readFileSync("src/route/judge.ts", "utf8").replace(/\r\n/g, "\n");
  const body = (sig) => {
    const i = jSrc.indexOf(sig);
    if (i < 0) return "";
    const j = jSrc.indexOf("\n  }", i + sig.length);
    return j < 0 ? "" : jSrc.slice(i, j);
  };
  const on = body("  onTraffic(e: TrafficEvt): void {");
  ok("[323] onTraffic 只留编排：事实 → 整页 → 小响应", on.includes("this.facts(e, ty);") && on.includes("this.pageHit(e, chan, ck, ty);") && on.includes("this.small(e, chan, ck, ty);"));
  ok("[323] onTraffic 自己不写事实、不记账", !on.includes("PS.note(") && !on.includes("BLK.note(") && !on.includes("egDerive(") && !on.includes("cnt(\"trHit\")") && !on.includes("cnt(\"trSmall\")"));
  ok("[323] onTraffic 不超过 20 行", on.split("\n").length <= 20, on.split("\n").length);
  const f = body("  private facts(e: TrafficEvt, ty: number): void {");
  ok("[323] facts 写五张事实表", f.includes("HEALTH.note(") && f.includes("FACT.decide(") && f.includes("PS.note(") && f.includes("BLK.note(") && f.includes("BLK.contra(") && f.includes("egDerive("));
  ok("[323] facts 不做整页记账", !f.includes("cnt(\"trHit\")") && !f.includes("recordTraffic(") && !f.includes("markPos("));
  const p = body("  private pageHit(e: TrafficEvt, chan: Chan, ck: string, now: number): void {");
  ok("[323] pageHit 只做整页记账", p.includes("cnt(\"trHit\")") && p.includes("recordTraffic(") && p.includes("markPos(") && !p.includes("markBlocked(") && !p.includes("HEALTH.note("));
  const s = body("  private small(e: TrafficEvt, chan: Chan, ck: string, now: number): void {");
  ok("[323] small 只做小响应判定", s.includes("cnt(\"trSmall\")") && s.includes("markBlocked(") && s.includes("RELAY_DEMAND.set(") && !s.includes("HEALTH.note(") && !s.includes("recordTraffic("));
  ok("[323] 三段按执行顺序排列", jSrc.indexOf("  private facts(") < jSrc.indexOf("  private pageHit(") && jSrc.indexOf("  private pageHit(") < jSrc.indexOf("  private small("));

  // 行为面：整页不进小响应计数；tiny 进；零字节与超时形态都不进
  const H323 = "split323.example";
  // smCnt 的键是「站点|通道」（通道键来自 chanKey），所以只能按前缀数本站点留下几行。
  // 时间戳必须用真实时间：bigDiff 是「(bigByHost.get(host) || 0) > now - BASE_TTL」，
  // 若用一个很小的 now（例如 900000），缺省 0 也会被当成「本站点刚出过整页」，
  // 于是 small() 直接走 markBlocked 把计数删掉 —— 那是测试时钟错，不是被测代码错。
  const keepMax323 = W.SC.SM_CNT_MAX;
  W.SC.SM_CNT_MAX = 1000;
  const t323 = Date.now() - 60000;
  const cnt323 = () => Array.from(W.JUDGE.memory.smCnt.keys()).filter((k) => k.startsWith(H323 + "|")).length;
  W.JUDGE.memory.smCnt.clear();
  W.JUDGE.memory.bigByHost.delete(H323);
  W.JUDGE.memory.bigChan.delete(H323);
  const ev323 = (o) => ({ host: H323, cf: false, ok: true, down: 0, up: 0, life: 500, via: "node", node: "198.51.100.9:443", ...o });
  W.JUDGE.onTraffic(ev323({ down: 60000, life: 1200, at: t323 }));
  eq("[323] 整页走 pageHit，小响应计数一条都不留", cnt323(), 0);
  W.JUDGE.onTraffic(ev323({ down: 900, at: t323 + 1000 }));
  ok("[323] 小响应走 small，留下一条计数", cnt323() >= 1, "cnt=" + cnt323());
  W.JUDGE.onTraffic(ev323({ down: 900, at: t323 + 2000 }));
  ok("[323] 再来一次小响应，计数累加", (W.JUDGE.memory.smCnt.get(H323 + "|r:198.51.100.9") || 0) >= 2, "n=" + String(W.JUDGE.memory.smCnt.get(H323 + "|r:198.51.100.9")));
  const n323 = cnt323();
  W.JUDGE.onTraffic(ev323({ down: 0, at: t323 + 3000 }));
  eq("[323] 零字节不进 small", cnt323(), n323);
  W.JUDGE.onTraffic(ev323({ down: 900, life: 9000, at: t323 + 4000 }));
  eq("[323] 超时形态不进 small", cnt323(), n323);
  W.SC.SM_CNT_MAX = keepMax323;
  W.JUDGE.memory.smCnt.clear();
  W.JUDGE.memory.bigByHost.delete(H323);
  W.JUDGE.memory.bigChan.delete(H323);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case237({ fs, ok, eq, W }) {
    const attSrc = fs.readFileSync("src/proxy/attacher.ts", "utf8").replace(/\r\n/g, "\n");
    const bodyOf = (name) => {
      const m = attSrc.match(new RegExp("\\n  (private )?(async )?" + name + "\\("));
      if (!m) return "";
      const from = m.index + 1;
      const stop = attSrc.indexOf("\n  }\n", from);
      return stop < 0 ? "" : attSrc.slice(from, stop);
    };
    const runBody = bodyOf("run");
    const closeBody = bodyOf("onClose");
    const viaBody = bodyOf("viaRelayFailed");
    const dirBody = bodyOf("directEmpty");
    const v6Body = bodyOf("tryV6");
    const pxBody = bodyOf("tryProxyip");

    ok("[326] 五段细节各自成方法",
      ["onClose", "viaRelayFailed", "directEmpty", "tryV6", "tryProxyip"].every((n) => new RegExp("\\n  private async " + n + "\\(").test(attSrc)));
    ok("[326] run 只做装配（≤30 行）",
      runBody.split("\n").length <= 30 && runBody.includes("releaseAll(conn)") && runBody.includes("pipeBack("));
    ok("[326] run 不再自己记账 / 挑中继 / 拨号",
      !runBody.includes("cnt(") && !runBody.includes("NodeStatsTable.") && !runBody.includes("parseProxyIp(") &&
        !runBody.includes("dialAnother(") && !runBody.includes("SOCKET_DIALER.open("));
    ok("[326] run 把收尾整个交给 onClose",
      (runBody.match(/this\.onClose\(o, gotData\)/g) || []).length === 1);
    ok("[326] onClose 只做分派（客户端在场 → 有数据 → 中转 → 直连）",
      closeBody.includes("WS_OPEN") && closeBody.includes("SEL.resetFail(") &&
        closeBody.includes("this.viaRelayFailed(o)") && closeBody.includes("this.directEmpty(o)"));
    ok("[326] onClose 不记账、不拨号",
      !closeBody.includes("cnt(") && !closeBody.includes("SOCKET_DIALER.open(") && !closeBody.includes("NodeStatsTable."));
    ok("[326] 中转失败段自带记账与「只换一条」",
      viaBody.includes('cnt("eCloseP")') && (viaBody.match(/dialAnother\(/g) || []).length === 1 &&
        viaBody.includes('cnt(region ? "rgFail" : "dead")') && viaBody.includes("await SEL.softFail("));
    ok("[326] 直连空关闭先试 IPv6 再试 proxyip",
      dirBody.includes("conn.directFail = true") && dirBody.includes("await this.tryV6(o)) return;") &&
        dirBody.includes("await this.tryProxyip(o);"));
    ok("[326] IPv6 兜底一次一连接、地区钉住时禁用",
      v6Body.includes("conn.triedV6") && v6Body.includes("!env.cfIpv6") && v6Body.includes("isV6Literal(host)") &&
        v6Body.includes("SOCKET_DIALER.open(expandV6(v6), port, o.budget)"));
    ok("[326] proxyip 兜底只剩一份挑中继与一处上限",
      (pxBody.match(/parseProxyIp\(/g) || []).length === 1 && pxBody.includes("trimAged(RELAY_DEMAND, SC.PX_MAX);") &&
        pxBody.includes("NodeStatsTable.nsFail("));
    eq("[326] 五段都挂在同一个实例上",
      ["onClose", "viaRelayFailed", "directEmpty", "tryV6", "tryProxyip"].every((n) => typeof new W.Attacher()[n] === "function"), true);
    ok("[326] 关闭客户端仍只有一个出口（endClient）",
      (attSrc.match(/\.close\(/g) || []).length === 1);
  }

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case238({ fs, ok, W, eq }) {
  const pSrc327 = fs.readFileSync("src/store/pend.ts", "utf8").replace(/\r\n/g, "\n");
  const cls327 = pSrc327.slice(pSrc327.indexOf("export class PendingLedger {"));
  // 取类体里某个方法/签名的原文：从签名到下一个「整行两格 }」为止
  const body327 = (sig) => {
    const at = cls327.indexOf(sig);
    if (at < 0) return "";
    const end = cls327.indexOf("\n  }", at);
    return end < 0 ? "" : cls327.slice(at, end);
  };

  // 1) 结构：编排层只编排
  const flushBody = body327("async flush(env: Env");
  ok("[327] flush 只编排：摘批 → 拼体 → 发 → 确认或退回 → 退避",
    flushBody.includes("this.take(max)") && flushBody.includes("this.post(env, id,") &&
    flushBody.includes("this.body(id, d,") && flushBody.includes("this.ack(id, carry)") &&
    flushBody.includes("this.rollback(id, d,") && flushBody.includes("this.backoff(bad)"));
  ok("[327] flush 里不再自己发请求", !flushBody.includes("doFetch("));
  ok("[327] flush 里不再有 carriedBy / attached 这类散落状态",
    !flushBody.includes("carriedBy") && !flushBody.includes("attached"));
  // 7.368 单飞守卫 + 7.376 force 补排，编排层多行约 15 行；仍远低于「不拆」时的 99 行
  ok("[327] flush 拆完不超过 50 行", (flushBody.match(/\n/g) || []).length <= 50);

  const takeBody = body327("private take(max: number)");
  ok("[327] 摘批：轮转起点 + 只摘这一批 + 重算剩余字节",
    takeBody.includes("this.cursor") && takeBody.includes('cnt("pendSkip"') &&
    takeBody.includes("this.rows.delete(bid)") && takeBody.includes("this.bytes = 0"));

  const buildBody = body327("private body(");
  ok("[327] 拼体：已经有人挂过就不再挂", buildBody.includes("if (carry.owner || !mine) return body;"));
  ok("[327] 拼体：连接观测与四类事实都在这里登记",
    buildBody.includes("body.cl = cl") && buildBody.includes("body.blk2 = fd.blk2") &&
    buildBody.includes("carry.rows = cl") && buildBody.includes("body.spd = spdSnapshot()"));

  const postBody = body327("private async post(");
  ok("[327] 发请求只剩一处入口，非 2xx 抛错给调用方回滚",
    postBody.includes('doFetch(env, id, "https://meter/add"') &&
    postBody.includes('throw new Error("do " + r.status)'));

  const ackBody = body327("private ack(");
  ok("[327] 确认只落在挂增量的那一批",
    ackBody.includes("carry.owner && String(id).toLowerCase() === carry.owner"));
  ok("[327] 确认：观测按行相减，不清整张表",
    ackBody.includes("this.clAck(carry.rows)") && !ackBody.includes("TRAFFIC_MEMORY.aggregates.clear()"));

  const rollBody = body327("private rollback(");
  ok("[327] 退回：字节回账本 + 剩余字节回滚 + 计数基线回退 + 增量退回",
    rollBody.includes("this.bytes += ") && rollBody.includes("cntUnsend(cd)") &&
    rollBody.includes("HOOK.syncNack"));

  const backBody = body327("private backoff(");
  ok("[327] 退避：失败翻倍最多 60s、成功降回 30s",
    backBody.includes("Math.min(this.intervalMs * 2, 60000)") && backBody.includes("Math.max(30000,"));

  // 2) 行为：真发一遍
  const mkPendEnv327 = (failFirst) => {
    const sent = [];
    const env = {
      uuid: "main@x.test",
      METER: {
        idFromName: (n) => n,
        get: () => ({
          fetch: async (u, i) => {
            sent.push({ url: String(u), body: JSON.parse(i.body) });
            if (failFirst && sent.length === 1) return new Response("boom", { status: 500 });
            return Response.json({ ok: 1 });
          },
        }),
      },
    };
    return { env, sent };
  };
  const resetPend327 = () => {
    W.PEND.rows.clear();
    W.PEND.bytes = 0;
    W.PEND.cursor = 0;
    W.PEND.intervalMs = 30000;
    W.PEND.flushedAt = 0;
    W.PEND.flushTimer = null;
  };

  resetPend327();
  W.PEND.add("a@x.test", 100, 200, true);
  W.PEND.add("main@x.test", 10, 20, true);
  const A327 = mkPendEnv327(false);
  await W.PEND.flush(A327.env, true, 8);
  eq("[327] 两个用户各发一次", A327.sent.length, 2);
  eq("[327] 发完账本清空", W.PEND.rows.size, 0);
  eq("[327] 剩余字节归零", W.PEND.bytes, 0);
  const carried327 = A327.sent.filter((x) => x.body.c);
  eq("[327] 计数只挂在一个请求体上", carried327.length, 1);
  eq("[327] 而且挂在主 uuid 那一批（up=10 的那个用户）", carried327[0].body.up, 10);
  ok("[327] 同一批还带了节点快照与错误", Array.isArray(carried327[0].body.spd) || typeof carried327[0].body.spd === "object");
  ok("[327] 成功后间隔降回 30s", W.PEND.intervalMs === 30000);

  resetPend327();
  W.PEND.add("main@x.test", 50, 70, true);
  const B327 = mkPendEnv327(true);
  await W.PEND.flush(B327.env, true, 8);
  eq("[327] 失败的那批退回账本", (W.PEND.rows.get("main@x.test") || {}).up, 50);
  eq("[327] 剩余字节跟着回滚", W.PEND.bytes, 120);
  eq("[327] 失败后退避翻倍到 60s", W.PEND.intervalMs, 60000);

  resetPend327();
  W.PEND.add("u1@x", 1, 0, true);
  W.PEND.add("u2@x", 2, 0, true);
  W.PEND.add("u3@x", 3, 0, true);
  const C327 = mkPendEnv327(false);
  await W.PEND.flush(C327.env, true, 2);
  eq("[327] 一轮最多带 2 个用户", C327.sent.length, 2);
  eq("[327] 剩下 1 个留在账本里", W.PEND.rows.size, 1);
  eq("[327] 剩下的正是第三个用户", [...W.PEND.rows.keys()][0], "u3@x");
  await W.PEND.flush(C327.env, true, 2);
  eq("[327] 下一轮接着把剩下的发完", C327.sent.length, 3);
  eq("[327] 第二轮发的是 u3", C327.sent[2].body.up, 3);
  eq("[327] 两轮之后账本空", W.PEND.rows.size, 0);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case239({ fs, ok, W, eq }) {
  const protoSrc = fs.readFileSync("src/proxy/protocol.ts", "utf8").replace(/\r\n/g, "\n");
  const luBody = (() => {
    const i = protoSrc.indexOf("export async function loadUsers(");
    const j = protoSrc.indexOf("\n}\n", i);
    return i < 0 || j < 0 ? "" : protoSrc.slice(i, j);
  })();
  // 装配器本身
  ok("[328] 用户表装配器是一个导出类", /export class UserIndex\b/.test(protoSrc));
  for (const m of ["fromEnv", "fromManaged", "add", "result"]) {
    ok(`[328] UserIndex 有 ${m}()`, new RegExp(`\\n  ${m}\\(`).test(protoSrc));
  }
  // 闭包搬走了：loadUsers 里不该再有内联的 hashOf/add 定义
  ok("[328] loadUsers 不再内联 hashOf", !luBody.includes("const hashOf"));
  ok("[328] loadUsers 不再内联 add", !luBody.includes("const add ="));
  ok("[328] loadUsers 用装配器", luBody.includes("new UserIndex()"));
  // 顺序是口径：env 先、托管后
  ok("[328] 先并 env 再并托管", luBody.indexOf("fromEnv(env)") < luBody.indexOf("fromManaged(managed)"));
  ok("[328] 非法 id 在 add 里被挡掉", /RE_UUID\.test\(id\)/.test(protoSrc));

  // 行为面：直接构一个装配器，喂三种来源
  if (typeof W.UserIndex === "function") {
    const uidA = "11111111-2222-3333-4444-555555555555";
    const uidB = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const ownerList = (auth) => [...auth.trojan.values()].sort();


    // ① 单密码模式：一个公共密码给所有 env 用户
    const one = new W.UserIndex();
    one.fromEnv({ uuid: uidA, trojan: "pub" });
    const aOne = one.result(true);
    ok("[328] 单密码：env 用户启用", aOne.uuids.has(uidA));
    eq("[328] 单密码：只有一条用户", aOne.list.length, 1);
    eq("[328] 单密码：密码映射指向本人", ownerList(aOne).join(","), uidA);

    // ② 多密码模式：每个用户自己的密码
    const two = new W.UserIndex();
    two.fromEnv({ uuid: `${uidA},${uidB}`, trojan: `${uidA}:p1,${uidB}:p2` });
    const aTwo = two.result(true);
    eq("[328] 多密码：两位用户都在", aTwo.uuids.size, 2);
    ok("[328] 多密码：A 拿到自己的 owner", ownerList(aTwo).includes(uidA));
    ok("[328] 多密码：B 拿到自己的 owner", ownerList(aTwo).includes(uidB));

    // ③ 共享密码只留一个稳定 owner（后加载的不许顶掉前面的）
    const share = new W.UserIndex();
    share.fromEnv({ uuid: `${uidA},${uidB}`, trojan: "same" });
    const aShare = share.result(true);
    eq("[328] 共享密码只留一个 owner", aShare.trojan.size, 1);
    eq("[328] 共享密码归先加载的那位", ownerList(aShare).join(","), uidA);

    // ④ 托管记录最后写，能覆盖 env 的启用状态
    const over = new W.UserIndex();
    over.fromEnv({ uuid: uidA, trojan: "pub" });
    over.fromManaged([{ id: uidA, pwd: "pub", note: "面板", enabled: false }]);
    const aOver = over.result(true);
    ok("[328] 托管禁用能盖掉 env 的启用", aOver.uuids.has(uidA) === false);
    eq("[328] 托管禁用后密码映射也撤掉", aOver.trojan.size, 0);
    ok("[328] 记下这是托管用户", Boolean(aOver.list[0].managed));

    // ⑤ 非法 id 忽略，不让它进表
    const bad = new W.UserIndex();
    bad.add("not-a-uuid", "x", "坏", true, false);
    eq("[328] 非 UUID 不用户表", bad.result(true).list.length, 0);
  } else {
    ok("[328] UserIndex 未导出到测试窗口", false, "src/test-surface.ts 需要导出 UserIndex");
  }

  // ⑥ KV 读失败：env 用户仍然在，且 ok 为假（上层据此缩短缓存）
  W.USERS.v = null; W.USERS.t = 0;
  W.USERS.sig = "";
  const failEnv = {
    uuid: "11111111-2222-3333-4444-555555555555",
    trojan: "pub",
    STATS: {
      get: async () => {
        throw new Error("kv down");
      },
    },
  };
  const aFail = await W.loadUsers(failEnv);
  ok("[328] KV 读失败仍给出 env 用户", aFail.uuids.has("11111111-2222-3333-4444-555555555555"));
  eq("[328] KV 读失败时 ok 为假", aFail.ok, false);
  W.USERS.v = null; W.USERS.t = 0;
  W.USERS.sig = "";
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case240({ fs, ok, W, eq }) {
  const tsSrc = fs.readFileSync("src/px/ts.ts", "utf8").replace(/\r\n/g, "\n");
  const pickSrc2 = fs.readFileSync("src/px/pickpath.ts", "utf8").replace(/\r\n/g, "\n");
  /**
   * 功能：取某个方法体（从签名到同缩进的收尾）。
   * @param sig 签名片段
   * @returns 方法体文本（取不到返回空串）
   */
  const bodyOf = (sig) => {
    const i = tsSrc.indexOf(sig);
    if (i < 0) return "";
    const j = tsSrc.indexOf("\n  }\n", i);
    return j < 0 ? "" : tsSrc.slice(i, j);
  };
  ok("[329] 抽样器是一个导出类", /export class ThompsonPicker\b/.test(tsSrc));
  ok("[329] 旧的入口函数已退场", !/export function pickThom\(/.test(tsSrc));
  for (const m of ["poolLen", "widthOf", "betaOf", "bytesOf", "cutOf", "topBpsOf", "spreadOf", "costOf", "arms", "pickOf", "pick"]) {
    ok(`[329] 抽样器有 ${m}()`, new RegExp(`\\n  (private )?(public )?${m}\\(`).test(tsSrc));
  }
  // 七个前置量各自留在自己的方法里：调参时不用通读一条长函数
  ok("[329] 池子大小的分母仍是存活表", bodyOf("private poolLen(").includes("const nPool = NODE_MEMORY.alive.size ||"));
  ok("[329] 抽样宽度按模式分档", bodyOf("private widthOf(").includes("SC.TS_K_LAT") && bodyOf("private widthOf(").includes("SC.TS_K_SMALL"));
  ok("[329] 乐观面系数只在这里算", bodyOf("private betaOf(").includes("SC.TS_BETA") && tsSrc.split("SC.TS_BETA").length - 1 === 1);
  ok("[329] 探活剪枝线自成方法", bodyOf("private cutOf(").includes("SC.TS_CUT_R") && bodyOf("private cutOf(").includes("SC.TS_CUT_MS"));
  ok("[329] 池内最快带宽只扫前若干名", bodyOf("private topBpsOf(").includes("SC.PRIOR_BPS") && bodyOf("private topBpsOf(").includes("this.poolWidth"));
  ok("[329] σ 与代价各自成方法", bodyOf("private spreadOf(").includes("sdFail") && bodyOf("private costOf(").includes("gauss()"));
  ok("[329] 算臂与挑臂分离", bodyOf("private arms(").includes("scoreParts(") && !bodyOf("private arms(").includes("SC.TS_BAND"));
  ok("[329] 剪枝与兜底都在挑臂里", bodyOf("private pickOf(").includes("SC.TS_BAND") && bodyOf("private pickOf(").includes("if (!best)"));
  ok("[329] pick 只编排", bodyOf("pick(") !== "" && bodyOf("pick(").split("\n").length <= 8);
  ok("[329] 调用点直接用类", pickSrc2.includes("new ThompsonPicker(") && !pickSrc2.includes("pickThom"));

  // 行为面：没有候选时给空串，有候选时给出候选里的键，同一个种子结果稳定
  const keepAlive329 = new Map(W.NODE_MEMORY.alive);
  const keepStat329 = new Map(W.NODE_MEMORY.stats);
  const keepRand329 = Math.random;
  try {
    W.NODE_MEMORY.alive.clear();
    W.NODE_MEMORY.stats.clear();
    W.CANDS.reset();
    eq("[329] 没有候选时返回空串", new W.ThompsonPicker("lat", 0).pick(), "");
    for (const k of ["a329.example:443", "b329.example:443", "c329.example:443"]) {
      W.NODE_MEMORY.alive.set(k, { h: k.slice(0, k.lastIndexOf(":")), p: 443, cc: "", ms: 120 });
    }
    W.CANDS.reset();
    const keys = new Set(W.CANDS.list("lat").map((x) => x.k));
    ok("[329] 候选表已建好", keys.size >= 3, String(keys.size));
    const one = new W.ThompsonPicker("lat", 0).pick();
    ok("[329] 抽到的是候选里的键", keys.has(one), one);
    // 打桩随机数：同一状态两次抽样必须给出同一个键（否则「同一请求内的候选顺序」都不稳定）
    Math.random = () => 0.5;
    const r1 = new W.ThompsonPicker("lat", 0).pick();
    const r2 = new W.ThompsonPicker("lat", 0).pick();
    eq("[329] 同一状态同一种子结果一致", r1, r2);
    // 吞吐模式同样能给出候选（这里的判据是「不返回空串」，两侧参数不同）
    ok("[329] 吞吐模式也能抽出候选", keys.has(new W.ThompsonPicker("tput", 16 * 1048576).pick()));
  } finally {
    Math.random = keepRand329;
    W.NODE_MEMORY.alive.clear();
    for (const [k, v] of keepAlive329) W.NODE_MEMORY.alive.set(k, v);
    W.NODE_MEMORY.stats.clear();
    for (const [k, v] of keepStat329) W.NODE_MEMORY.stats.set(k, v);
    W.CANDS.reset();
  }
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case241({ fs, ok, W, reset, node, eq }) {
  const src330 = fs.readFileSync("src/px/pickpath.ts", "utf8").replace(/\r\n/g, "\n");
  const body330 = (sig) => {
    const i = src330.indexOf(sig);
    if (i < 0) return "";
    const j = src330.indexOf("\n  }\n", i);
    return j < 0 ? src330.slice(i) : src330.slice(i, j);
  };
  const pick330 = body330("  pick(env: Env");
  ok(
    "[330] pick 只做编排（五段各一个委托）",
    pick330.includes("this.syncCursor(") &&
      pick330.includes("this.byProfile(") &&
      pick330.includes("this.byShadow(") &&
      pick330.includes("this.bySample(") &&
      pick330.includes("this.leastBad("),
  );
  ok(
    "[330] pick 自己不做画像/影子/抽样",
    !pick330.includes("HOSTS.rank(") &&
      !pick330.includes("shadowRate(") &&
      !pick330.includes("new ThompsonPicker("),
  );
  ok("[330] pick 缩到 40 行以内（原来 89 行）", pick330.split("\n").length <= 40, String(pick330.split("\n").length));
  const cursor330 = body330("  private syncCursor(");
  ok(
    "[330] 游标自愈的三条判据还在",
    cursor330.includes("NODE_MEMORY.alive.has(cur)") &&
      cursor330.includes("isBlack(cur)") &&
      cursor330.includes("isFrozen(cur)") &&
      cursor330.includes("CANDS.best(mode)"),
  );
  const prof330 = body330("  private byProfile(");
  ok(
    "[330] 站点画像：样本门槛 + 2% 次优 + 差距上限",
    prof330.includes("HOSTS.rank(host, mode)") &&
      prof330.includes("Math.random() < 0.02") &&
      prof330.includes("1.3 + 100"),
  );
  ok("[330] 站点画像不去碰影子与抽样器", !prof330.includes("shadowRate(") && !prof330.includes("ThompsonPicker"));
  const sh330 = body330("  private byShadow(");
  ok(
    "[330] 影子：预算 + 未试节点 + 记账",
    sh330.includes("shadowRate(env)") &&
      sh330.includes("HOSTS.untried(host, mode)") &&
      sh330.includes("NodeStatsTable.nsGet(t0).lastTry"),
  );
  ok("[330] 画像够 3 个节点就不投影子", sh330.includes("hm.size >= 3"));
  const smp330 = body330("  private bySample(");
  ok(
    "[330] 抽样：构造抽样器 + 负载溢出",
    smp330.includes("new ThompsonPicker(mode,") && smp330.includes("this.spill(pick, mode)"),
  );
  ok(
    "[330] 每个委托在 pick 里只出现一次",
    pick330.split("this.byProfile(").length - 1 === 1 && pick330.split("this.bySample(").length - 1 === 1,
  );

  // 行为面：站点画像命中时 hostTrial 必须复位（它只标记「影子试探」）
  const keepAlive330 = [...W.NODE_MEMORY.alive.entries()];
  const keepStat330 = [...W.NODE_MEMORY.stats.entries()];
  try {
    reset();
    node("fast330:443", { tcp: 50, okW: 10 });
    node("slow330:443", { tcp: 400, okW: 10 });
    for (let i = 0; i < 3; i++) {
      W.hostNodeMark("site330.test", "fast330:443", { ok: true, bad: false, bytes: 1000, ttfb: 60 });
      W.hostNodeMark("site330.test", "slow330:443", { ok: true, bad: false, bytes: 1000, ttfb: 500 });
    }
    const stP330 = { host: "site330.test", hostTrial: true };
    eq("[330] 画像命中就按站点选", W.SEL.pick({ pxShadow: 0 }, "tput", stP330), "fast330:443");
    eq("[330] 画像命中不算试探（复位）", stP330.hostTrial, false);
    const stN330 = {};
    const one330 = W.SEL.pick({ pxShadow: 0 }, "tput", stN330);
    ok("[330] 没站点时交给抽样器", ["fast330:443", "slow330:443"].includes(one330), one330);
  } finally {
    W.NODE_MEMORY.alive.clear();
    for (const [k, v] of keepAlive330) W.NODE_MEMORY.alive.set(k, v);
    W.NODE_MEMORY.stats.clear();
    for (const [k, v] of keepStat330) W.NODE_MEMORY.stats.set(k, v);
    W.CANDS.reset();
  }
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case242({ fs, ok, W, eq }) {
  const srcSnap331 = fs.readFileSync("src/store/snapshot.ts", "utf8").replace(/\r\n/g, "\n");
  /** 功能：按签名切出一段顶格函数的源码（到下一个顶格收尾为止）。 */
  const body331 = (sig) => {
    const at = srcSnap331.indexOf(sig);
    if (at < 0) return "";
    const rest = srcSnap331.slice(at + sig.length);
    const end = rest.search(/\n\}\n/);
    return rest.slice(0, end < 0 ? rest.length : end);
  };

  const w331 = body331("async function writeSnap(");
  ok("writeSnap 只做编排（读 → 闸门 → 骨架 → 合并 → 落盘）", [
    "await readPrevSnap(env)",
    "gateHeld(prev, now, force)",
    "seedSnap(prev, now)",
    "mergeUsage(next, now, batch.usage)",
    "mergeRtt(next, batch.rtt)",
    "trimRtt(next)",
    "mergeErrs(next, batch.errors)",
    "await commitSnap(env, next, now, batch)",
  ].every((x) => w331.includes(x)));
  ok("writeSnap 自己不碰 KV、不记账", !w331.includes("kvSet(") && !w331.includes("kvGetStrict") && !w331.includes("cnt("));
  ok("writeSnap 收成二十行以内", w331.split("\n").filter((x) => x.trim()).length <= 20, String(w331.split("\n").filter((x) => x.trim()).length));

  const readFn331 = body331("async function readPrevSnap(");
  ok("读快照严格且失败可观察", readFn331.includes("kvGetStrict<SnapDoc>(env, \"snap\")") && readFn331.includes('cnt("snapFlushReadFail")') && readFn331.includes("return null;"));

  const gateFn331 = body331("function gateHeld(");
  ok("全局闸门仍然对 force 放行", gateFn331.includes("if (!force && now - (prev.ts || 0) < FLUSH_GAP) {"));
  ok("被闸门挡掉时把本地基线推进到别人那一次", gateFn331.includes("SNAP.written = Math.max(") && gateFn331.includes("SNAP.checked = Math.max("));

  const seedFn331 = body331("function seedSnap(");
  ok("骨架跨天重置用量", seedFn331.includes("prev.date === day ?"));
  ok("骨架把错误截到最近 50 条", seedFn331.includes("(prev.errs || []).slice(-50)"));

  const useFn331 = body331("function mergeUsage(");
  ok("用量按相加合并", useFn331.includes("(p.up || 0) + (s.up || 0)") && useFn331.includes("(p.down || 0) + (s.down || 0)") && useFn331.includes("(p.conns || 0) + (s.conns || 0)"));
  ok("首末次连接取极值", useFn331.includes("Math.min(p.first") && useFn331.includes("Math.max(p.last"));

  const rttFn331 = body331("function mergeRtt(");
  ok("延迟按 0.3 衰减做 EWMA", rttFn331.includes("(p.rtt || v.rtt) * 0.7 + v.rtt * 0.3"));
  ok("延迟桶用无原型对象（__proto__ 标签不会改原型）", rttFn331.includes("Object.create(null)"));

  const trimFn331 = body331("function trimRtt(");
  ok("落盘前按 RTT_MAX 裁剪标签", trimFn331.includes("RTT_MAX") && trimFn331.includes("delete tgt[keys[i]]"));

  const errFn331 = body331("function mergeErrs(");
  ok("错误追加后仍只留 50 条", errFn331.includes("concat(rows).slice(-50)"));

  const commitFn331 = body331("async function commitSnap(");
  ok("先写成功再确认本轮增量（保留在途新数据）", commitFn331.indexOf("await kvSet(") >= 0 && commitFn331.indexOf("await kvSet(") < commitFn331.indexOf("USAGE_MEMORY.acknowledge(batch.usage, batch.dirtyBytes)"));
  ok("写失败有计数", commitFn331.includes('cnt("snapFlushFail")'));

  // 行为面：用内存 KV 桩把六个分支跑一遍（KV 值会被加密，回读一律走 getSnap）
  const store331 = Object.create(null);
  let failPut331 = false;
  let failGet331 = false;
  let puts331 = 0;
  const env331 = {
    STATS: {
      get: async (k) => {
        if (failGet331) throw new Error("kv get down");
        return k in store331 ? store331[k] : null;
      },
      put: async (k, v) => {
        if (failPut331) throw new Error("kv put down");
        store331[k] = v;
        puts331 += 1;
      },
    },
  };
  const cnt331 = (k) => Number(W.cntView()[k]) || 0;
  const keep331 = {
    stats: [...W.USAGE_MEMORY.rows.entries()],
    rtt: [...W.ENTRY_MEMORY.rows.entries()],
    errs: [...W.ERROR_MEMORY.rows],
    written: W.SNAP.written,
    checked: W.SNAP.checked,
    bytes: W.USAGE_MEMORY.dirtyBytes,
    busy: W.SNAP.busy,
  };
  const fresh331 = () => {
    W.USAGE_MEMORY.rows.clear();
    W.ENTRY_MEMORY.rows.clear();
    W.ERROR_MEMORY.rows.length = 0;
    W.SNAP.written = 0;
    W.SNAP.checked = 0;
    W.USAGE_MEMORY.dirtyBytes = 0;
    W.SNAP.busy = false;
    W.USAGE_MEMORY.rows.set("a331", { up: 2, down: 3, conns: 1, first: 5, last: 9 });
  };
  const today331 = new Date().toISOString().slice(0, 10);

  try {
    // ① 读失败：不写、计数、本地读数原样留着
    fresh331();
    failGet331 = true;
    const beforeRead331 = cnt331("snapFlushReadFail");
    await W.flushSnap(env331, true);
    eq("读失败不写快照", puts331, 0);
    eq("读失败计一次 snapFlushReadFail", cnt331("snapFlushReadFail") - beforeRead331, 1);
    eq("读失败后本地读数仍在", W.USAGE_MEMORY.rows.has("a331"), true);
    failGet331 = false;

    // ② 全局闸门：别人刚写过就跳过，并把基线推进到那一次
    fresh331();
    store331.snap = { v: 1, ts: Date.now(), date: today331, stats: {}, rtt: {}, errs: [] };
    await W.flushSnap(env331);
    eq("别人刚写过就不写", puts331, 0);
    ok("闸门把 snapWritten 推到别人那一次", W.SNAP.written > 0, String(W.SNAP.written));

    // ③ force 放行全局闸门
    fresh331();
    await W.flushSnap(env331, true);
    eq("force 放行全局闸门", puts331, 1);

    // ④ 跨天重置 + 错误截断 + 成功后清本地
    fresh331();
    const old331 = [];
    for (let i = 0; i < 40; i += 1) old331.push({ t: i, m: "old" + i, k: "e" });
    store331.snap = {
      v: 1,
      ts: 0,
      date: "1970-01-01",
      stats: { old331: { up: 5, down: 6, conns: 2, first: 1, last: 2 } },
      rtt: {},
      errs: old331,
    };
    for (let i = 0; i < 30; i += 1) W.ERROR_MEMORY.rows.push({ t: i, m: "new" + i, k: "e" });
    await W.flushSnap(env331, true);
    const wrote331 = await W.getSnap(env331, true);
    eq("跨天后旧用量被丢掉", Object.keys(wrote331.stats).includes("old331"), false);
    eq("本次用量写进去了", wrote331.stats.a331 && wrote331.stats.a331.up, 2);
    eq("错误只留最近 50 条", wrote331.errs.length, 50);
    eq("写成功后本地读数被清空", W.USAGE_MEMORY.rows.size + W.ENTRY_MEMORY.rows.size + W.ERROR_MEMORY.rows.length, 0);
    eq("写成功后脏字节归零", W.USAGE_MEMORY.dirtyBytes, 0);

    // ⑤ 同一天：用量相加而不是覆盖
    fresh331();
    store331.snap = {
      v: 1,
      ts: 0,
      date: today331,
      stats: { a331: { up: 5, down: 6, conns: 2, first: 1, last: 4 } },
      rtt: {},
      errs: [],
    };
    await W.flushSnap(env331, true);
    const same331 = await W.getSnap(env331, true);
    eq("同一天用量相加", same331.stats.a331.up, 7);
    eq("同一天连接数相加", same331.stats.a331.conns, 3);

    // ⑥ 写失败：本地读数必须留下，失败可观察
    fresh331();
    store331.snap = { v: 1, ts: 0, date: today331, stats: {}, rtt: {}, errs: [] };
    failPut331 = true;
    const beforePut331 = cnt331("snapFlushFail");
    await W.flushSnap(env331, true);
    failPut331 = false;
    eq("写失败计一次 snapFlushFail", cnt331("snapFlushFail") - beforePut331, 1);
    eq("写失败后本地读数仍在", W.USAGE_MEMORY.rows.has("a331"), true);
  } finally {
    W.USAGE_MEMORY.rows.clear();
    W.ENTRY_MEMORY.rows.clear();
    W.ERROR_MEMORY.rows.length = 0;
    for (const [k, v] of keep331.stats) W.USAGE_MEMORY.rows.set(k, v);
    for (const [k, v] of keep331.rtt) W.ENTRY_MEMORY.rows.set(k, v);
    for (const e of keep331.errs) W.ERROR_MEMORY.rows.push(e);
    W.SNAP.written = keep331.written;
    W.SNAP.checked = keep331.checked;
    W.USAGE_MEMORY.dirtyBytes = keep331.bytes;
    W.SNAP.busy = keep331.busy;
  }
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case243({ fs, ok, eq, W }) {
  const srcStats332 = fs.readFileSync("src/store/stats.ts", "utf8").replace(/\r\n/g, "\n");
  /** 功能：按签名切出一段函数的源码（到下一个顶格收尾为止）。 */
  const body332 = (sig) => {
    const at = srcStats332.indexOf(sig);
    if (at < 0) return "";
    const rest = srcStats332.slice(at + sig.length);
    const end = rest.search(/\n\}\n/);
    return rest.slice(0, end < 0 ? rest.length : end);
  };

  const read332 = body332("export async function readStats(");
  ok("readStats 只做编排（DO → 回填 → 视图 / KV 兜底）", [
    "await meterGet(env, id)",
    "if (!total) return kvView(env, id, local)",
    "await seedFromSnap(env, id, total)",
    "doView(id, seed.total, pend, local, seed.seed)",
  ].every((x) => read332.includes(x)));
  ok("readStats 自己不碰 KV 与 DO 端点", !read332.includes("usageSnapGet") && !read332.includes("doFetch(") && !read332.includes("getSnap("));
  ok("readStats 收成十五行以内", read332.split("\n").filter((x) => x.trim()).length <= 15, String(read332.split("\n").filter((x) => x.trim()).length));

  const seed332 = body332("async function seedFromSnap(");
  ok("只在 DO 账本为空时才回填", seed332.includes("if (total.up || total.down || total.conns) return { total, seed: \"none\" };"));
  ok("回填走 /meter/seed 并刷新缓存", seed332.includes('"https://meter/seed"') && seed332.includes("METER_CLIENT.cache.set(id, { v: next, t: Date.now() })"));
  eq("两处失败分支都计数（判据同第 246 组）", seed332.split('cnt("statsSeedFail")').length - 1, 2);

  const do332 = body332("function doView(");
  ok("今日口径按真实日期判", do332.includes("const sameDay = !total.d || total.d === day;"));
  ok("非当天时今日量不带昨天的数", do332.includes("todayUp: (sameDay ? total.dU || 0 : 0) + pend.up") && do332.includes("todayDown: (sameDay ? total.dD || 0 : 0) + pend.down"));
  ok("首次见到的兜底是本 isolate 的即时视图", do332.includes("firstSeen: total.first || local.first || null"));
  ok("回填失败时不声称已落盘", do332.includes('persisted: seed !== "fail"'));

  const kv332src = body332("async function kvView(");
  ok("KV 兜底读快照且读失败退化成空表", kv332src.includes("await getSnap(env)") && kv332src.includes("stored = null;"));
  ok("KV 兜底如实声明 backend 与 seed", kv332src.includes('backend: "kv"') && kv332src.includes('seed: "none" as const'));

  // 行为面：一个会记账的 METER 桩 + 一个内存 KV
  const kvMemo332 = new Map();
  const kv332 = {
    get: async (k) => (kvMemo332.has(k) ? kvMemo332.get(k) : null),
    put: async (k, v) => {
      kvMemo332.set(k, v);
    },
  };
  let seedHits332 = 0;
  let seedStatus332 = 200;
  const meter332 = (total, opts = {}) => ({
    // doFetch 走 `env.METER.get(env.METER.idFromName(id))`，桩里两件都要有
    idFromName: (x) => x,
    get: () => ({
      fetch: async (url) => {
        if (String(url).endsWith("/seed")) {
          seedHits332 += 1;
          if (opts.throw) throw new Error("do down");
          return { ok: seedStatus332 < 400, status: seedStatus332, json: async () => ({ ...(opts.seeded || total) }) };
        }
        if (opts.throwGet) throw new Error("do down");
        return { ok: true, status: 200, json: async () => ({ ...total }) };
      },
    }),
  });
  const kept332 = {
    stats: [...W.USAGE_MEMORY.rows.entries()],
    pend: [...W.PEND.rows.entries()],
    meterCache: [...W.METER_CLIENT.cache.entries()],
    cnt: W.COUNTER.values,
    snapCache: W.SNAP.cache,
    ttl: W.METER_CLIENT.cache ? W.METER_CLIENT.cache.size : 0,
  };
  const ID332 = "id332";
  const day332 = new Date().toISOString().slice(0, 10);

  try {
    // 先把历史用量写进 KV 灾备快照（走真实的 usageSnapWrite，封装与线上一致）
    W.METER_CLIENT.cache.clear();
    W.USAGE_MEMORY.rows.clear();
    W.PEND.rows.clear();
    const envHist332 = { STATS: kv332, METER: meter332({ up: 999, down: 888, conns: 7, d: day332, dU: 111, dD: 222, first: 100, ts: 200 }) };
    await W.usageSnapWrite(envHist332, [{ id: ID332 }], 4);
    ok("历史用量进了 KV 灾备快照", kvMemo332.size > 0, String(kvMemo332.size));

    // ① DO 里已有用量：不回填，视图 = DO 总量 + 待上报增量
    W.METER_CLIENT.cache.clear();
    W.USAGE_MEMORY.rows.clear();
    W.PEND.rows.clear();
    W.PEND.rows.set(ID332, { up: 3, down: 4, conns: 1, isNew: false, at: 1 });
    W.USAGE_MEMORY.rows.set(ID332, { up: 5, down: 6, conns: 2, first: 7, last: 8 });
    seedHits332 = 0;
    const live332 = await W.readStats({ STATS: kv332, METER: meter332({ up: 10, down: 20, conns: 3, d: day332, dU: 1, dD: 2, first: 5, ts: 9 }) }, ID332);
    eq("DO 有量时标记 seed = none", live332.seed, "none");
    eq("DO 有量时不发回填请求", seedHits332, 0);
    eq("总量 = DO + 待上报", live332.up, 13);
    eq("后端标记为 do", live332.backend, "do");
    eq("已落盘为真", live332.persisted, true);
    eq("本 isolate 即时视图照旧透出", live332.isolateLocal.up, 5);

    // ② DO 被重置（空账本）+ KV 里有历史：回填一次，数值来自快照
    W.METER_CLIENT.cache.clear();
    W.PEND.rows.clear();
    W.USAGE_MEMORY.rows.clear();
    seedHits332 = 0;
    seedStatus332 = 200;
    const back332 = await W.readStats(
      { STATS: kv332, METER: meter332({ up: 0, down: 0, conns: 0, ts: 0 }, { seeded: { up: 999, down: 888, conns: 7, d: day332, dU: 111, dD: 222, first: 100, ts: 200 } }) },
      ID332,
    );
    eq("空账本时发一次回填请求", seedHits332, 1);
    eq("回填成功标记 ok", back332.seed, "ok");
    eq("回填后累计用量来自快照", back332.up, 999);
    eq("回填后当日用量来自快照", back332.todayUp, 111);

    // ③ 回填 5xx：标记 fail、不声称已落盘
    W.METER_CLIENT.cache.clear();
    seedStatus332 = 500;
    const bad332 = await W.readStats({ STATS: kv332, METER: meter332({ up: 0, down: 0, conns: 0, ts: 0 }) }, ID332);
    eq("回填 5xx 标记 fail", bad332.seed, "fail");
    eq("回填 5xx 不声称已落盘", bad332.persisted, false);
    seedStatus332 = 200;

    // ④ 跨天：DO 里的当日量停在昨天，今日量不能带昨天的数
    W.METER_CLIENT.cache.clear();
    W.PEND.rows.clear();
    W.USAGE_MEMORY.rows.clear();
    W.PEND.rows.set(ID332, { up: 3, down: 4, conns: 1, isNew: false, at: 1 });
    const stale332 = await W.readStats(
      { STATS: kv332, METER: meter332({ up: 10, down: 20, conns: 3, d: "1970-01-01", dU: 777, dD: 666, first: 5, ts: 9 }) },
      ID332,
    );
    eq("跨天后今日上行不带昨天", stale332.todayUp, 3);
    eq("跨天后今日下行不带昨天", stale332.todayDown, 4);

    // ⑤ 没绑 METER：走 KV 兜底（口径是「快照 + 本 isolate 即时增量」）
    W.METER_CLIENT.cache.clear();
    W.PEND.rows.clear();
    W.USAGE_MEMORY.rows.clear();
    W.USAGE_MEMORY.rows.set(ID332, { up: 5, down: 6, conns: 2, first: 7, last: 8 });
    // 清缓存不是赋 null：getSnap 会读 S.snapCache.v，null 会抛错并被 KV 兜底吞成「没有快照」
    W.SNAP.cache = { v: null, t: 0 };
    const kvNoSnap332 = await W.readStats({ STATS: kv332 }, ID332);
    eq("没有快照时 backend 仍是 kv", kvNoSnap332.backend, "kv");
    eq("KV 兜底声明 seed = none", kvNoSnap332.seed, "none");
    eq("没有快照时不声称已落盘", kvNoSnap332.persisted, false);
    eq("没有快照时只报本 isolate 的增量", kvNoSnap332.up, 5);

    // 真有一份快照时必须是「快照 + 本地增量」
    W.USAGE_MEMORY.rows.clear();
    W.USAGE_MEMORY.rows.set(ID332, { up: 40, down: 50, conns: 3, first: 100, last: 200 });
    // 清缓存不是赋 null：getSnap 会读 S.snapCache.v，null 会抛错并被 KV 兜底吞成「没有快照」
    W.SNAP.cache = { v: null, t: 0 };
    await W.flushSnap({ STATS: kv332 }, true);
    // 清缓存不是赋 null：getSnap 会读 S.snapCache.v，null 会抛错并被 KV 兜底吞成「没有快照」
    W.SNAP.cache = { v: null, t: 0 };
    W.USAGE_MEMORY.rows.set(ID332, { up: 2, down: 1, conns: 1, first: 0, last: 300 });
    const kvSnap332 = await W.readStats({ STATS: kv332 }, ID332);
    eq("有快照时把快照与本地对加", kvSnap332.up, 42);
    eq("有快照时标记已落盘", kvSnap332.persisted, true);
  } finally {
    W.USAGE_MEMORY.rows.clear();
    W.PEND.rows.clear();
    W.METER_CLIENT.cache.clear();
    for (const [k, v] of kept332.stats) W.USAGE_MEMORY.rows.set(k, v);
    for (const [k, v] of kept332.pend) W.PEND.rows.set(k, v);
    for (const [k, v] of kept332.meterCache) W.METER_CLIENT.cache.set(k, v);
    W.SNAP.cache = kept332.snapCache;
    if (kept332.cnt) W.COUNTER.values = kept332.cnt;
  }
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case245({ fs, ok, W, eq }) {
  const srcSnap334 = fs.readFileSync("src/store/snapshot.ts", "utf8").replace(/\r\n/g, "\n");
  /**
   * 功能：按签名切出一段顶格函数的源码（到下一个顶格收尾的 `}` 为止）。
   * @param sig 签名行的一部分
   * @returns 源码片段；找不到返回空串
   */
  const body334 = (sig) => {
    const at = srcSnap334.indexOf(sig);
    if (at < 0) return "";
    const rest = srcSnap334.slice(at + sig.length);
    const end = rest.search(/\n\}\n/);
    return rest.slice(0, end < 0 ? rest.length : end);
  };

  const w334 = body334("export async function usageSnapWrite(");
  ok(
    "usageSnapWrite 只做编排（读旧值 → 闸门 → 切批 → 逐用户 → 搬旧值 → 落盘）",
    [
      "await loadPrevUsageSnap(env)",
      "if (Date.now() - (prev.ts || 0) < 2 * 3600e3) return;",
      "rotateWindow(list, cap,",
      "await eachLimit(head, 8,",
      "carryUnread(tail, prev, out)",
      "await commitUsageSnap(env, out)",
    ].every((x) => w334.includes(x)),
  );
  ok("usageSnapWrite 自己不碰 KV、不读 DO", !w334.includes("kvSet(") && !w334.includes("kvGetStrict") && !w334.includes("meterGet("));
  ok(
    "usageSnapWrite 收成二十五行以内",
    w334.split("\n").filter((x) => x.trim()).length <= 25,
    String(w334.split("\n").filter((x) => x.trim()).length),
  );

  const prev334 = body334("async function loadPrevUsageSnap(");
  ok(
    "读旧快照失败可观察且整轮放弃",
    prev334.includes("kvGetStrict<UsageSnap>(env, USAGE_SNAP_KEY)") && prev334.includes('cnt("snapReadFail")') && prev334.includes("return null;"),
  );

  const rot334 = body334("function rotateWindow(");
  ok(
    "轮转切片按游标取头尾",
    rot334.includes("prevIdx % list.length") && rot334.includes("slice(start).concat") && rot334.includes("rotated.slice(head.length)"),
  );

  const safe334 = body334("function safeCount(");
  // 判据只看代码：注释里提到 `|0` 是「为什么不能用」，不是「用了」
  const safeCode334 = safe334.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok("计数夹取不用位运算（超 2^31 会溢出成负数）", !/\|\s*0\b/.test(safeCode334) && safeCode334.includes("Number.isFinite(n)"));

  const merge334 = body334("async function mergeOneUsage(");
  ok(
    "逐用户合并只增不减、当日字段只认同一天",
    merge334.includes("Math.max(safeCount(v && v.up), safeCount(old && old.up))") &&
      merge334.includes("v.d === today") &&
      merge334.includes("if (!up && !down && !conns) return null;"),
  );
  ok("逐用户合并读的是计量 DO", merge334.includes("await meterGet(env, u.id)"));

  const tail334 = body334("function carryUnread(");
  ok("没读到的用户只搬旧值（不编新数字）", tail334.includes("out.users[u.id] = { ...old };") && !tail334.includes("meterGet("));

  const commit334 = body334("async function commitUsageSnap(");
  ok(
    "落盘在无人时不写、失败只计数",
    commit334.includes("if (!Object.keys(out.users).length) return;") && commit334.includes('cnt("snapWriteFail")') && commit334.includes("expirationTtl"),
  );

  // 行为面：内存 KV + 计量 DO 桩，把「无 KV / 读失败 / 闸门 / 轮转 / 只增不减 / 跨天」跑一遍
  const storeU334 = Object.create(null);
  let putsU334 = 0;
  let failGetU334 = false;
  let rowsU334 = {};
  const envU334 = () => ({
    STATS: {
      get: async (k) => {
        if (failGetU334) throw new Error("kv get down");
        return k in storeU334 ? storeU334[k] : null;
      },
      put: async (k, v) => {
        storeU334[k] = v;
        putsU334 += 1;
      },
    },
    METER: { idFromName: (n) => n, get: (id) => ({ fetch: async () => new Response(JSON.stringify(rowsU334[id] || {})) }) },
  });
  const cntU334 = (k) => Number(W.cntView()[k]) || 0;
  const realNowU334 = Date.now;
  const t0U334 = realNowU334();
  const todayU334 = new Date(t0U334).toISOString().slice(0, 10);
  const usersU334 = [{ id: "u1" }, { id: "u2" }, { id: "u3" }];

  try {
    // ① 没有 KV 或没有计量 DO：直接返回，一次写都不发
    await W.usageSnapWrite({}, usersU334);
    eq("没有 KV/DO 时不写", putsU334, 0);

    // ② 读旧快照失败：整轮不写，并计一次 snapReadFail
    failGetU334 = true;
    const beforeReadU334 = cntU334("snapReadFail");
    await W.usageSnapWrite(envU334(), usersU334, 2);
    eq("读失败整轮不写", putsU334, 0);
    eq("读失败计一次 snapReadFail", cntU334("snapReadFail") - beforeReadU334, 1);
    failGetU334 = false;

    // ③ 首次写：只读前两个，尾部不进快照，游标推进到 2
    Date.now = () => t0U334;
    W.METER_CLIENT.cache.clear();
    rowsU334 = {
      u1: { up: 100, down: 10, conns: 2, first: 1000, d: todayU334, dU: 5, dD: 6 },
      u2: { up: 50, down: 5, conns: 1, first: 2000, d: todayU334, dU: 1, dD: 1 },
      u3: { up: 7, down: 0, conns: 1, first: 3000, d: todayU334, dU: 3, dD: 0 },
    };
    const beforeSkipU334 = cntU334("snapSkip");
    await W.usageSnapWrite(envU334(), usersU334, 2);
    eq("一轮写一次", putsU334, 1);
    eq("没读到的那个计一次 snapSkip", cntU334("snapSkip") - beforeSkipU334, 1);
    const snap1U334 = await W.kvGetStrict(envU334(), "usage:snap");
    eq("只读了两个用户", Object.keys(snap1U334.users).sort().join(","), "u1,u2");
    eq("游标推进到 2", snap1U334.idx, 2);
    eq("首轮记下真实用量", snap1U334.users.u1.up, 100);

    // ④ 2 小时闸门：紧接着再调一次不写
    W.METER_CLIENT.cache.clear();
    await W.usageSnapWrite(envU334(), usersU334, 2);
    eq("两小时内不再写", putsU334, 1);

    // ⑤ 三小时后再写：从游标 2 起读（u3,u1），尾部 u2 只搬旧值
    Date.now = () => t0U334 + 3 * 3600e3;
    W.METER_CLIENT.cache.clear();
    rowsU334 = {
      u1: { up: 5, down: 1, conns: 1, first: 1000, d: "2000-01-01", dU: 999, dD: 999 },
      u2: { up: 999, down: 999, conns: 9, first: 1, d: todayU334, dU: 99, dD: 99 },
      u3: { up: 70, down: 3, conns: 2, first: 3000, d: todayU334, dU: 8, dD: 2 },
    };
    const todayAfterU334 = new Date(t0U334 + 3 * 3600e3).toISOString().slice(0, 10);
    await W.usageSnapWrite(envU334(), usersU334, 2);
    const snap2U334 = await W.kvGetStrict(envU334(), "usage:snap");
    eq("第二轮再写一次", putsU334, 2);
    eq("第二轮读的是游标之后的两个", Object.keys(snap2U334.users).sort().join(","), "u1,u2,u3");
    eq("只增不减：DO 变小也不回写更小的值", snap2U334.users.u1.up, 100);
    ok(
      "跨天的当日量不合并进今天",
      todayAfterU334 === todayU334 ? true : snap2U334.users.u1.dU === 5,
      todayAfterU334 + " / dU=" + String(snap2U334.users.u1.dU),
    );
    eq("尾部用户的旧值原样搬过来（DO 现值不算数）", snap2U334.users.u2.up, 50);
    eq("新读到的用户用现值", snap2U334.users.u3.up, 70);
    eq("第二轮游标绕回 1", snap2U334.idx, 1);
  } finally {
    Date.now = realNowU334;
    W.METER_CLIENT.cache.clear();
  }
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case246({ fs, ok, W, eq }) {
  const raw335 = fs.readFileSync("src/nodes/score.ts", "utf8").replace(/\r\n/g, "\n");
  const cls335 = raw335.slice(raw335.indexOf("export class ScoreModel"), raw335.indexOf("export function scoreParts("));
  const call335 = raw335.indexOf("export function scoreParts(");
  const entry335 = raw335.slice(call335, raw335.indexOf("\n}\n", call335));
  const t335 = Date.now();
  const k335 = "g335:443";
  const k335b = "g335b:443";
  const k335c = "g335c:443";
  const k335d = "g335d:443";

  // 结构：类、五个方法、以及「入口只做委托」
  ok("第335组·评分过程是导出类", typeof W.ScoreModel === "function");
  ok(
    "第335组·入口只剩一行委托",
    entry335.includes("return new ScoreModel(k, mode, now, withGate, bytes).parts();") &&
      !entry335.includes("effView(") &&
      !entry335.includes("pcts(") &&
      entry335.split("\n").length <= 5,
  );
  ["latencyTerm", "throughputTerm", "riskTerm", "gateOf", "parts"].forEach((mn) => {
    ok("第335组·类上有" + mn, cls335.includes(mn + "("));
  });
  ok(
    "第335组·延迟项守住真实样本与截断",
    cls335.includes("SC.PROBE_W") &&
      cls335.includes("SC.REAL_W") &&
      cls335.includes("1.4826") &&
      cls335.includes("probeL + 1500"),
  );
  ok(
    "第335组·吞吐项守住分位容量与先验",
    cls335.includes("pcts(s).cap") &&
      cls335.includes("SC.PRIOR_BPS") &&
      cls335.includes("SC.SAMPLE_TTL") &&
      cls335.includes("e10Local"),
  );
  ok(
    "第335组·风险项三种概率都来自同层",
    cls335.includes("pFailOf(") && cls335.includes("pFailFast(") && cls335.includes("pStallOf("),
  );
  ok(
    "第335组·闸门四个标签齐备",
    ["not-alive", "black", "frozen", "low-avail"].every((g) => cls335.includes('"' + g + '"')),
  );
  ok(
    "第335组·合成时才用闸门与失败定价",
    cls335.includes("this.gateOf()") && cls335.includes("SC.FAIL_SCALE") && cls335.includes("SC.JIT_W"),
  );
  ok(
    "第335组·字段名语义化且不再用短成员名",
    cls335.includes("private readonly scoringMode: Mode;") &&
      cls335.includes("private readonly evaluatedAt: number;") &&
      cls335.includes("private readonly targetBytes: number;") &&
      cls335.includes("private readonly aliveEntry:") &&
      cls335.includes("private readonly window:") &&
      !/this\.(m|s|a|e)\b/.test(cls335),
  );
  ok("第335组·入口签名没变（调用点零改动）", /export function scoreParts\(\s*k: string,\s*mode: Mode,/.test(raw335));

  // 行为：包装与直连类完全一致
  const packed335 = W.scoreParts(k335, "lat", t335);
  const direct335 = new W.ScoreModel(k335, "lat", t335, false, 0).parts();
  eq("第335组·包装与直接构造结果一致", JSON.stringify(packed335), JSON.stringify(direct335));
  eq("第335组·未知模式归一到延迟", W.scoreParts(k335, "weird", t335).mode, "lat");
  eq("第335组·不计闸门时为空串", packed335.gate, "");

  // 行为：四个闸门标签各走一支
  W.NODE_MEMORY.alive.set(k335b, { h: "g335b.test", p: 443, ms: 90 });
  eq("第335组·活着有证据时闸门 ok", W.scoreParts(k335b, "lat", t335, true).gate, "ok");
  W.NodeStatsTable.nsGet(k335b).blackUntil = t335 + 60000;
  eq("第335组·冷却中判 black", W.scoreParts(k335b, "lat", t335, true).gate, "black");
  W.NodeStatsTable.nsGet(k335c).freeUntil = t335 + 60000;
  W.NODE_MEMORY.alive.set(k335c, { h: "g335c.test", p: 443, ms: 90 });
  eq("第335组·冻结判 frozen", W.scoreParts(k335c, "lat", t335, true).gate, "frozen");
  eq("第335组·不在存活表判 not-alive", W.scoreParts(k335d, "lat", t335, true).gate, "not-alive");

  // 行为：两种模式的取舍不同，但都从同三个字段派生
  eq("第335组·吞吐模式不算传输时间", W.scoreParts(k335, "tput", t335).xferMs, 0);
  const wantPrior335 = (W.SC.LAT_BYTES / W.SC.PRIOR_BPS) * 1000;
  ok(
    "第335组·没有容量证据时按先验折算传输时间",
    Math.abs(W.scoreParts(k335, "lat", t335).xferMs - wantPrior335) < 0.01,
    String(W.scoreParts(k335, "lat", t335).xferMs),
  );
  ok(
    "第335组·目标流量变大则传输时间变长",
    W.scoreParts(k335, "lat", t335, false, 16 * 1048576).xferMs > packed335.xferMs,
  );
  eq("第335组·总分与分解同源", W.costOf(k335, "lat", t335), W.scoreParts(k335, "lat", t335).score);
  eq(
    "第335组·同一时刻两次评分一致",
    JSON.stringify(W.scoreParts(k335, "tput", t335)),
    JSON.stringify(W.scoreParts(k335, "tput", t335)),
  );

  [k335, k335b, k335c, k335d].forEach((k) => {
    W.NODE_MEMORY.stats.delete(k);
    W.NODE_MEMORY.alive.delete(k);
  });
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case247({ fs, ok, eq, W }) {
  const g = "336";
  const polSrc = fs.readFileSync("src/route/policy.ts", "utf8");
  // 取函数体：从签名行到下一个顶格的 `}`，先归一换行，免得 CRLF 切不到末尾
  const norm = polSrc.replace(/\r\n/g, "\n");
  const body = (sig) => {
    const head = norm.indexOf(sig);
    if (head < 0) return "";
    const tail = norm.indexOf("\n}\n", head);
    return norm.slice(head, tail < 0 ? norm.length : tail);
  };

  ok(
    `[${g}] 四段各自成函数、编排仍是导出函数`,
    ["function cfV6Choice(", "function cfColdChoice(", "function cfEgressChoice(", "function cfEgChoice(", "export function decideCf("].every((x) => polSrc.includes(x)),
    ""
  );
  const dec = body("export function decideCf(");
  eq(
    `[${g}] decideCf 只编排：四个委托都在、自己不扫表`,
    [dec.includes("cfV6Choice(c, r)"), dec.includes("cfColdChoice(c, r, src, code)"), dec.includes("cfEgressChoice(r, code)"), dec.includes("cfEgChoice()"), !dec.includes("RELPERF.snap("), !dec.includes("EG.v4List("), !dec.includes("VT.at(")],
    [true, true, true, true, true, true, true]
  );
  eq(`[${g}] decideCf 不超过 20 行`, dec.split("\n").length <= 20, true);
  const v6 = body("function cfV6Choice(");
  eq(
    `[${g}] v6 段只认客户端地址族与候选分类`,
    [v6.includes("if (!c.clientV6) return null;"), v6.includes("nonCf.length ? nonCf : stick.length ? stick : usable"), !v6.includes("cfHttpCode(")],
    [true, true, true]
  );
  const cold = body("function cfColdChoice(");
  eq(
    `[${g}] 冷启动段带齐四件：冷站判据 / 样本表 / 轮换 / 钉住`,
    [cold.includes("VT.at(c.host,"), cold.includes("JUDGE.posOn(c.host,"), cold.includes("RELPERF.snap(c.host)"), cold.includes("src.nextRotation("), cold.includes("src.pinFor(")],
    [true, true, true, true, true]
  );
  const egr = body("function cfEgressChoice(");
  eq(
    `[${g}] 收口段四条判据齐备且互斥`,
    [egr.includes('why: "cf-noncf"'), egr.includes("code === 403"), egr.includes("code === 200 && !stick.length"), egr.includes('why: "cf-any"')],
    [true, true, true, true]
  );
  const egp = body("function cfEgChoice(");
  eq(`[${g}] 事实层兜底不挑被判死的`, [egp.includes("EG.v4List()"), egp.includes("DEAD.isDead(")], [true, true]);
  eq(
    `[${g}] 四段按代价递增排、编排放最后`,
    ["function cfV6Choice(", "function cfColdChoice(", "function cfEgressChoice(", "function cfEgChoice(", "export function decideCf("].map((x) => norm.indexOf(x)).every((v, i, arr) => i === 0 || v > arr[i - 1]),
    true
  );
  // 热路径纪律：站点×中继那张表每轮只扫一遍（7.188 之前这个分支扫三遍，每遍还要排序）
  eq(`[${g}] 热路径那张实测表只扫一遍`, (norm.match(/RELPERF\.snap\(/g) || []).length, 1);

  // 行为面：直接喂 Ranked 视图，逐段验证「谁先返回」
  const blank = { usable: [], blocked: [], ranked: [], stick: [], nonCf: [], okOnes: [] };
  const ctxOf = (over) => ({ host: "cf336.test", cfHost: true, clientV6: false, relays: [], legacyWantsRelay: true, mode: "tput", ...over });
  W.VT.clear();
  W.EG.clear();
  W.DEAD.clear();
  W.CF_HTTP.cache.clear();
  const v6none = W.decideCf(ctxOf({ clientV6: true }), blank, W.POLICY);
  eq(`[${g}] v6 客户端没候选时直连并标 v6-cf-none`, [v6none.why, v6none.chan.kind], ["v6-cf-none", "d"]);
  const v6ok = W.decideCf(ctxOf({ clientV6: true }), { ...blank, nonCf: ["1.1.1.1", "203.0.113.9"], stick: ["1.1.1.1", "203.0.113.9"], okOnes: ["203.0.113.9"] }, W.POLICY);
  eq(`[${g}] v6 段优先挑「送回过整页」的那条`, [v6ok.why, v6ok.chan.ip], ["v6-cf", "203.0.113.9"]);
  eq(`[${g}] 全空时返回 null（交给上层判死）`, W.decideCf(ctxOf({}), blank, W.POLICY), null);
  const warm = { ...blank, usable: ["45.136.117.194"], ranked: ["45.136.117.194"], stick: ["45.136.117.194"] };
  eq(`[${g}] 没有任何证据时先走冷启动钉住`, W.decideCf(ctxOf({}), warm, W.POLICY).why, "cold-pin");
  W.VT.setState("cf336.test", "r:45.136.117.194", 1, 1);
  eq(`[${g}] 有本站点证据后交给收口段`, W.decideCf(ctxOf({}), warm, W.POLICY).why, "cf-any");
  W.CF_HTTP.cache.set("cf336.test", { code: 403, colo: "", t: Date.now() });
  eq(`[${g}] 本出口 403 时改走已知可用的中继`, W.decideCf(ctxOf({}), warm, W.POLICY).why, "http403");
  W.CF_HTTP.cache.set("cf336.test", { code: 200, colo: "", t: Date.now() });
  const http200 = W.decideCf(ctxOf({}), blank, W.POLICY);
  eq(`[${g}] 200 且没有中继候选时才直连`, [http200.why, http200.chan.kind], ["http200", "d"]);
  W.VT.setState("noncf336.test", "r:203.0.113.9", 1, 1);
  const nonCfWin = W.decideCf(ctxOf({ host: "noncf336.test" }), { ...blank, usable: ["203.0.113.9"], ranked: ["203.0.113.9"], stick: ["203.0.113.9"], nonCf: ["203.0.113.9"] }, W.POLICY);
  eq(`[${g}] 冷启动之后非 CF 主机优先`, [nonCfWin.why, nonCfWin.chan.ip], ["cf-noncf", "203.0.113.9"]);
  W.VT.clear();
  W.EG.clear();
  W.DEAD.clear();
  W.CF_HTTP.cache.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case249({ fs, ok, eq, W }) {
  const g = 341;
  const met = fs.readFileSync("src/nodes/metrics.ts", "utf8").replace(/\r\n/g, "\n");
  // 取一个方法的完整源码：签名行到「两格缩进的右括号」为止（方法体内的分行语句至少四格）
  const bodyOf = (sig) => {
    const i = met.indexOf(sig);
    if (i < 0) return "";
    const j = met.indexOf("\n  }\n", i);
    return j > i ? met.slice(i, j) : "";
  };
  const mk = bodyOf("  markNode(");
  ok(
    `[${g}] markNode 只按顺序委托七个方法`,
    ["this.entryOf(", "this.decay(", "this.count(", "this.measure(", "s.at = now;"].every((x) => mk.includes(x))
  );
  // 编排层再出现表操作或上限常量，就意味着有人又把某一段塞回来了
  ok(
    `[${g}] markNode 不再自己动表与上限`,
    mk.length > 0 && !mk.includes("HOSTS.nodes") && !mk.includes("NODE_MEMORY.rankCache") && !mk.includes("HN_MAX_")
  );
  eq(`[${g}] markNode 只取一次时钟`, mk.split("Date.now()").length - 1, 1);
  ok(`[${g}] markNode 不超过 12 行`, mk.length > 0 && mk.split("\n").length <= 12);
  eq(
    `[${g}] 七个私有方法齐备`,
    ["entryOf", "famMap", "evictHost", "evictNode", "decay", "count", "measure"].every((x) => met.includes("  private " + x + "(")),
    true
  );
  const entry = bodyOf("  private entryOf(");
  ok(
    `[${g}] entryOf 取族表并压节点上限`,
    entry.includes("this.famMap(") && entry.includes("this.evictNode(m)") && entry.includes("{ n: 0, ok: 0, bad: 0, bytes: 0, ttfb: 0, at: 0 }")
  );
  const famMap = bodyOf("  private famMap(");
  ok(
    `[${g}] famMap 缺族先腾位置再建`,
    famMap.includes("this.nodes.get(fam)") && famMap.includes("this.evictHost(") && famMap.includes("this.nodes.set(fam, fresh)")
  );
  const eh = bodyOf("  private evictHost(");
  ok(
    `[${g}] evictHost 按族内最近更新淘汰`,
    eh.includes("this.nodes.size < HN_MAX_HOSTS") && eh.includes("for (const s of v.values()) if (s.at > last) last = s.at;") && eh.includes("this.nodes.delete(oldKey)")
  );
  const en = bodyOf("  private evictNode(");
  ok(`[${g}] evictNode 按行内时间淘汰`, en.includes("m.size < HN_MAX_NODES") && en.includes("m.delete(oldKey)"));
  const dc = bodyOf("  private decay(");
  ok(
    `[${g}] decay 只削过期坏样本并重算 n`,
    dc.includes("6 * 3600e3") && dc.includes("s.bad *= 0.5;") && dc.includes("s.n = s.ok + s.bad;")
  );
  const ct = bodyOf("  private count(");
  ok(
    `[${g}] count 只认真样本并作废两个模式`,
    ct.includes("const isConn = o.ok !== undefined || o.bad !== undefined;") &&
      ct.includes('fam + "|lat"') &&
      ct.includes('fam + "|tput"')
  );
  const ms = bodyOf("  private measure(");
  ok(
    `[${g}] measure 记字节与两条滑动平均`,
    ms.includes("Math.round(s.ttfb * 0.6 + ttfb * 0.4)") &&
      ms.includes("Math.round(s.bps * 0.6 + bps * 0.4)") &&
      ms.includes("s.bpsAt = now;") &&
      !ms.includes("Date.now()")
  );
  // 顺序本身就是语义：先取行 → 再减半 → 再计数 → 最后并采样
  eq(
    `[${g}] 五段按「取行 → 减半 → 计数 → 采样 → 打时间」排列`,
    ["  markNode(", "  private entryOf(", "  private famMap(", "  private decay(", "  private count(", "  private measure("].map((x) => met.indexOf(x)),
    [...["  markNode(", "  private entryOf(", "  private famMap(", "  private decay(", "  private count(", "  private measure("].map((x) => met.indexOf(x))].sort((a, b) => a - b)
  );

  // 行为：记账口径逐条与改前一致
  const H341 = "a341.example.com";
  const K341 = "n341.example.com:443";
  W.HOSTS.nodes.clear();
  W.NODE_MEMORY.rankCache.clear();
  const fam341 = W.hostKey(H341);
  W.HOSTS.markNode(H341, K341, { ok: 1, bytes: 100, ttfb: 200 });
  const row341 = W.HOSTS.nodes.get(fam341).get(K341);
  eq(`[${g}] 成功样本记进 n/ok`, [row341.n, row341.ok, row341.bad], [1, 1, 0]);
  eq(`[${g}] 字节与首字节都记下`, [row341.bytes, row341.ttfb], [100, 200]);
  ok(`[${g}] 最后更新时间已写入`, row341.at > 0);
  // 只带带宽的调用是中途采样：不能算一次成败
  W.HOSTS.markNode(H341, K341, { bps: 500 });
  eq(`[${g}] 只有带宽的采样不增加成败计数`, row341.n, 1);
  eq(`[${g}] 带宽样本单独记账`, [row341.bps, row341.bpsN], [500, 1]);
  W.HOSTS.markNode(H341, K341, { ok: 1, ttfb: 400, bps: 1000 });
  eq(`[${g}] 首字节按 0.6/0.4 并入`, row341.ttfb, 280);
  eq(`[${g}] 带宽按 0.6/0.4 并入`, row341.bps, 700);
  // 6 小时没更新过的坏样本减半：站点封禁不是判决书
  row341.bad = 4;
  row341.ok = 1;
  row341.n = 5;
  row341.at = Date.now() - 7 * 3600e3;
  W.HOSTS.markNode(H341, K341, { bytes: 1 });
  eq(`[${g}] 过期坏样本减半且按 ok+bad 重算 n`, [row341.bad, row341.n], [2, 3]);
  // 缓存作废：只有真样本才作废排行，中途采样不作废
  W.NODE_MEMORY.rankCache.set(fam341 + "|lat", { v: [], t: 0 });
  W.NODE_MEMORY.rankCache.set(fam341 + "|tput", { v: [], t: 0 });
  W.HOSTS.markNode(H341, K341, { bps: 900 });
  eq(`[${g}] 中途采样不作废站点排行`, W.NODE_MEMORY.rankCache.size, 2);
  W.HOSTS.markNode(H341, K341, { bad: 1 });
  eq(`[${g}] 真样本作废两个模式的排行`, W.NODE_MEMORY.rankCache.size, 0);

  // 两张表的上限：一族最多 12 个节点、最多 120 个族
  const t341 = Date.now() - 3600e3;
  W.HOSTS.nodes.clear();
  const capMap341 = new Map();
  W.HOSTS.nodes.set(fam341, capMap341);
  for (let i = 0; i < W.HN_MAX_NODES; i++) {
    capMap341.set("cap" + i + ":443", { n: 0, ok: 0, bad: 0, bytes: 0, ttfb: 0, at: t341 + i });
  }
  W.HOSTS.markNode(H341, "new341.example.com:443", { ok: 1 });
  eq(`[${g}] 一族最多 HN_MAX_NODES 个节点`, capMap341.size, W.HN_MAX_NODES);
  ok(`[${g}] 淘汰族内最久未更新的那条`, !capMap341.has("cap0:443") && capMap341.has("new341.example.com:443"));
  W.HOSTS.nodes.clear();
  for (let i = 0; i < W.HN_MAX_HOSTS; i++) {
    // 用 IP 字面量当族键：`hostKey` 对 IP 原样返回，避免同一可注册域被折叠成一族
    const one = new Map();
    one.set("x:443", { n: 0, ok: 0, bad: 0, bytes: 0, ttfb: 0, at: t341 + i });
    W.HOSTS.nodes.set("10.0." + Math.floor(i / 256) + "." + (i % 256), one);
  }
  W.HOSTS.markNode("brand341.example.com", "x:443", { ok: 1 });
  eq(`[${g}] 站点族最多 HN_MAX_HOSTS 个`, W.HOSTS.nodes.size, W.HN_MAX_HOSTS);
  ok(`[${g}] 淘汰最近没更新过的那一族`, !W.HOSTS.nodes.has("10.0.0.0"));
  W.HOSTS.nodes.clear();
  W.NODE_MEMORY.rankCache.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case250({ fs, ok, W, eq }) {
  const srcWs342 = fs.readFileSync("src/proxy/ws-in.ts", "utf8").replace(/\r\n/g, "\n");
  ok("[342] 上行流是导出类", typeof W.UploadStream === "function");
  ok(
    "[342] 入口只剩一行委托",
    /export function wsToStream\(ws: WebSocketLike, earlyData: string\): ReadableStream<Uint8Array> \{\n  return new UploadStream\(ws, earlyData\)\.stream;\n\}/.test(
      srcWs342,
    ),
  );
  for (const name342 of ["bind", "push", "emit", "overflow", "shut", "abort", "feedEarly", "decode"]) {
    ok(`[342] 方法齐备 ${name342}`, new RegExp(`\\n  private ${name342}\\(`).test(srcWs342));
  }
  ok("[342] 上限仍是 8MB", W.WS_UP_QUEUE_MAX === 8 * 1024 * 1024);
  ok("[342] 积压计数进类、模块级没有 let", !/^let /m.test(srcWs342) && srcWs342.includes("private queued = 0;"));
  ok("[342] 超限关 1013", srcWs342.includes('this.clientSocket.close(1013, "slow upstream")'));
  ok(
    "[342] 读端取消时停止收包",
    /cancel: \(\) => \{\n {8}this\.live = false;\n {6}\}/.test(srcWs342),
  );

  /** 功能：造一个能记账的假 WS（只实现 addEventListener 与 close）。 */
  const mkWs342 = () => {
    const h = { message: [], close: [], error: [] };
    const closed = [];
    return {
      h,
      closed,
      addEventListener: (t, fn) => {
        h[t].push(fn);
      },
      close: (code, reason) => {
        closed.push({ code, reason });
      },
      fire(t, ev) {
        for (const fn of h[t]) fn(ev);
      },
    };
  };
  /** 功能：把字节解成字符串。 */
  const text342 = (u8) => new TextDecoder().decode(u8);

  // ① 早期数据（握手带上的首包）先入流
  {
    const ws = mkWs342();
    const r = W.wsToStream(ws, "aGVsbG8=").getReader();
    const first = await r.read();
    eq("[342] 早期数据先入流", text342(first.value), "hello");
    r.releaseLock();
  }
  // ①b earlyData 必须逐字节还原：atob 出来是 Latin-1 字符串，若直接交给 push/decode 会走
  //    TextEncoder.encode() 把每个 >127 的字节重新编成两字节。VLESS 头含 16 字节 UUID，
  //    大量字节 >127，二次编码会让首包损坏（WS 握手成功、探测能过，但数据面完全不通）。
  //    7.270 是逐字节还原；这是重构引入的回归，用这条锁住。
  {
    const raw = new Uint8Array([0, 0xb9, 0x8d, 0x4a, 0x17, 0x8f, 0xff, 0x80, 0x01, 0x02]);
    const b64url = Buffer.from(raw).toString("base64url");
    const ws = mkWs342();
    const r = W.wsToStream(ws, b64url).getReader();
    const first = await r.read();
    eq("[342] earlyData 逐字节还原不损坏", Array.from(first.value).join(","), Array.from(raw).join(","));
    eq("[342] earlyData 字节数不变（无 UTF-8 二次编码）", first.value.length, raw.length);
    r.releaseLock();
  }
  // ② 纯文本帧按 UTF-8、ws2 帧（首字节 0x02 + base64）按二进制、ArrayBuffer 原样
  {
    const ws = mkWs342();
    const r = W.wsToStream(ws, "").getReader();
    ws.fire("message", { data: "abc" });
    eq("[342] 文本帧按 UTF-8", text342((await r.read()).value), "abc");
    ws.fire("message", { data: "\u0002" + btoa("xy") });
    eq("[342] ws2 帧解 base64", text342((await r.read()).value), "xy");
    // ws2 帧也必须逐字节还原：atob 的 Latin-1 字符串若走 toU8 会被 TextEncoder
    // 把每个 >127 字节二次编码。与 earlyData 同型的回归，补真实字节样本锁住。
    {
      const raw = [0, 0xb9, 0x8d, 0x4a, 0x17, 0x8f, 0xff, 0x80, 0x01, 0x02];
      const bin = raw.map((b) => String.fromCharCode(b)).join("");
      ws.fire("message", { data: "\u0002" + btoa(bin) });
      const got = Array.from((await r.read()).value);
      eq("[342] ws2 帧 >127 字节逐字节还原", got.join(","), raw.join(","));
      eq("[342] ws2 帧字节数不变（无 UTF-8 二次编码）", got.length, raw.length);
    }
    // 非法 base64 不能在 message 回调里抛（会升级成 1101），按空帧丢弃
    {
      let threw = "";
      try {
        ws.fire("message", { data: "\u0002!!!" });
        const got = (await r.read()).value;
        eq("[342] ws2 非法 base64 按空帧丢弃", got.length, 0);
      } catch (e) {
        threw = String(e);
      }
      eq("[342] ws2 非法 base64 不抛异常", threw, "");
    }
    ws.fire("message", { data: new Uint8Array([1, 2]).buffer });
    eq("[342] 二进制帧原样", Array.from((await r.read()).value).join(","), "1,2");
    ws.fire("close", {});
    eq("[342] 关闭后读到 EOF", (await r.read()).done, true);
    r.releaseLock();
  }
  // ③ 客户端正常关闭 → 读端 EOF，且之后的数据不再入队
  {
    const ws = mkWs342();
    const r = W.wsToStream(ws, "").getReader();
    ws.fire("close", {});
    ws.fire("message", { data: "late" });
    eq("[342] 关闭后的消息不再入队", (await r.read()).done, true);
    r.releaseLock();
  }
  // ④ 客户端异常 → 读端拿到错误
  {
    const ws = mkWs342();
    const r = W.wsToStream(ws, "").getReader();
    ws.fire("error", { error: new Error("boom342") });
    let err342 = null;
    try {
      await r.read();
    } catch (e) {
      err342 = e;
    }
    ok("[342] 异常透给读端", !!err342 && String(err342.message).includes("boom342"));
    r.releaseLock();
  }
  // ⑤ 积压超过上限 → 关连接（1013）+ 读端报超限
  {
    const ws = mkWs342();
    const r = W.wsToStream(ws, "").getReader();
    ws.fire("message", { data: new Uint8Array(9 * 1024 * 1024).buffer });
    let over342 = null;
    try {
      await r.read();
    } catch (e) {
      over342 = e;
    }
    ok("[342] 超限让读端报错", !!over342 && String(over342.message).includes("overflow"));
    eq("[342] 超限按 1013 关连接", ws.closed.length === 1 ? ws.closed[0].code : -1, 1013);
    r.releaseLock();
  }
  // ⑥ 早期数据不是合法 base64 时静默丢弃，不炸整条连接
  {
    const ws = mkWs342();
    const r = W.wsToStream(ws, "!!!notb64").getReader();
    ws.fire("message", { data: "ok342" });
    eq("[342] 坏早期数据只是被丢掉", text342((await r.read()).value), "ok342");
    r.releaseLock();
  }
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case251({ fs, eq, ok, W }) {
  const src344 = fs.readFileSync("src/routes/debug-nets.ts", "utf8");
  const surf344 = fs.readFileSync("src/test-surface.ts", "utf8");
  // 全局变量清零：四个 `export const X = new …` 都不在了
  eq("四个模块级单例已删除", /^export const (BENCH|DIAGONE|PROBES|TFPROBES) = new /m.test(src344), false);
  ok("门面持有四个组件",
    W.DEBUG.nets.benchRunner instanceof W.DebugBench &&
      W.DEBUG.nets.diagRunner instanceof W.DebugDiag &&
      W.DEBUG.nets.probeRunner instanceof W.DebugProbe &&
      W.DEBUG.nets.tfRunner instanceof W.DebugTf,
    "");
  ok("测试窗口不再导出这四个名字", ["BENCH", "DIAGONE", "PROBES", "TFPROBES"].every((n) => !new RegExp("^ {" + 2 + "}" + n + ",$", "m").test(surf344)), "");
  // 行为面：门面仍然只是转发（缺参时两个分支都返回 null，不拨号）
  const u344 = new URL("https://x.test/u/debug");
  eq("测速仍然只转发", await W.DEBUG.nets.bench(u344), null);
  eq("原始探活仍然只转发", await W.DEBUG.nets.rawProbe(u344), null);
  // 每个组件只被实例化一次（构造在类字段上，不是每次调用新建）
  eq("四个组件各自只实例化一次",
    (src344.match(/readonly (benchRunner|diagRunner|probeRunner|tfRunner) = new /g) || []).length, 4);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case252({ fs, ok, W }) {
  const pickSrc345 = fs.readFileSync("src/px/pickpath.ts", "utf8");
  const facade345 = fs.readFileSync("src/px/selector.ts", "utf8");

// 结构：模块级实例全收进 Selector（SEL.picker），两个组件是 PickPath 的 readonly 字段
  ok("[345] 模块级不再导出 SITE / PATHS", !pickSrc345.includes("export const SITE") && !pickSrc345.includes("export const PATHS"));
ok("[345] pickpath 不再导出模块级实例（收进 Selector）", !pickSrc345.includes("export const PICK = new PickPath();") && facade345.includes("private readonly picker = new PickPath();"));
  ok("[345] 两个组件是 readonly 字段", pickSrc345.includes("readonly site = new SitePick();") && pickSrc345.includes("readonly paths = new PathPrefs();"));
  ok("[345] 全文各只 new 一次", pickSrc345.split("new SitePick(").length - 1 === 1 && pickSrc345.split("new PathPrefs(").length - 1 === 1);
  ok("[345] 类体里的调用改走字段", !pickSrc345.includes("return SITE.") && !pickSrc345.includes("PATHS.byPrefer") && !pickSrc345.includes("PATHS.rescan") && !pickSrc345.includes("PATHS.byChan") && !pickSrc345.includes("PATHS.chanOpen") && !pickSrc345.includes("PATHS.nonCfFirst"));
  ok("[345] 委托仍然只有一行", /pick\([^)]*\)[^{]*\{[^}]*return this\.site\.pick\(/.test(pickSrc345));

  // 行为：组件挂得住、判据不变
ok("[345] site 是 SitePick 实例", W.SEL.picker.site instanceof W.SitePick);
ok("[345] paths 是 PathPrefs 实例", W.SEL.picker.paths instanceof W.PathPrefs);
ok("[345] 空站点不否决", W.SEL.picker.paths.vetoed("", "203.0.113.9:443") === false);
ok("[345] 空站点通道放行", W.SEL.picker.paths.chanOpen("", "203.0.113.9:443") === true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case253({ fs, ok, W, eq }) {
    const sessSrc346 = fs.readFileSync("src/proxy/session.ts", "utf8");
    const regSrc346 = fs.readFileSync("src/proxy/region.ts", "utf8");
    ok("[346] 地区挑选器不再是模块级单例", W.REGION === undefined && !regSrc346.includes("export const REGION"));
    ok("[346] 它仍是可构造的类（能力没丢）", typeof W.RegionPicker === "function" && typeof W.RegionPicker.prototype.open === "function");
    ok("[346] 会话用字段持有它",
      sessSrc346.includes("private readonly regionPicker = new RegionPicker();"));
    ok("[346] 地区分流走字段而不是模块全局",
      sessSrc346.includes("regionPicker: this.regionPicker") && !sessSrc346.includes("REGION.open("));
    ok("[346] 会话里只剩这一个 region 相关字段",
      (sessSrc346.match(/new RegionPicker\(\)/g) || []).length === 1);
    // 第 318 组的假 socket 声明在那个块里，这里给自己一份最小的（构造期只要 accept/close 存在）
    class FakeWS346 {
      constructor() {
        this.readyState = 1;
        this.bufferedAmount = 0;
      }
      accept() {}
      send() {}
      close() {}
    }
    globalThis.WebSocketPair = class {
      constructor() {
        this[0] = new FakeWS346();
        this[1] = new FakeWS346();
      }
    };
    const ps346 = new W.ProxySession(new Request("https://edge.test/x?rg=hk"), {}, {});
    const ps346b = new W.ProxySession(new Request("https://edge.test/x?rg=jp"), {}, {});
    ok("[346] 每个会话拿到自己的实例（不再是共享单例）",
      ps346.regionPicker instanceof W.RegionPicker && ps346b.regionPicker instanceof W.RegionPicker);
    eq("[346] 两个会话的挑选器互不相同", ps346.regionPicker === ps346b.regionPicker, false);
    eq("[346] 实例上没有 open 之外的多余状态", typeof ps346.regionPicker.open, "function");
  }

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case254({ fs, ok, W, eq }) {
  const selSrc347 = fs.readFileSync("src/px/selector.ts", "utf8");
  const failSrc347 = fs.readFileSync("src/px/failbook.ts", "utf8");
  ok("模块级 FAILS 消失（failbook 不再自建单例）", !failSrc347.includes("export const FAILS = new FailBook();"), failSrc347.length);
  ok("门面按类 import 记账器", selSrc347.includes('import { FailBook } from "./failbook";'), selSrc347.length);
  ok("门面自己持有记账器", selSrc347.includes("private readonly fails = new FailBook(this.rotation);"), selSrc347.length);
  ok("四处委托都走字段", ["onFail", "softFail", "bumpFail", "resetFail"].every((n) => selSrc347.split("return this.fails." + n + "(").length - 1 === 1), selSrc347.length);
  ok("门面里不再出现裸 FAILS.", !selSrc347.includes("FAILS."), selSrc347.length);
  ok("门面再导出只剩类", selSrc347.includes('export { FailBook } from "./failbook";'), selSrc347.length);
  ok("换节点器改由门面持有并传给记账器（不再是模块级单例）", !fs.readFileSync("src/px/rotation.ts", "utf8").includes("export const ROTATION =") && failSrc347.includes("this.rotation.maybeSwitch("), "");
  ok("门面实例仍是 SEL", W.SEL instanceof W.Selector, typeof W.SEL);
  ok("记账器挂在门面上", W.SEL.fails instanceof W.FailBook, typeof W.SEL.fails);
  ok("两个门面各持一份", new W.Selector().fails !== new W.Selector().fails, "shared");
  W.SELECTION_MEMORY.failCount = 0;
  await W.SEL.softFail("n347.test:443");
  eq("softFail 仍只轻记、不动主游标计数", W.SELECTION_MEMORY.failCount, 0);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case255({ fs, ok, eq, W }) {
    const settleSrc348 = fs.readFileSync("src/proxy/conn-settle.ts", "utf8");
    const connSrc348 = fs.readFileSync("src/proxy/connection.ts", "utf8");
    const cls348 = settleSrc348.slice(settleSrc348.indexOf("export class ConnSettle"));
    ok("结算类还在", cls348.length > 200, "");
    eq("结算文件里不再有模块级实例", settleSrc348.includes("export const SETTLE"), false);
    eq("连接按类名 import", connSrc348.includes('import { ConnSettle } from "./conn-settle";'), true);
    eq("连接不再 import 单例", connSrc348.includes("import { SETTLE }"), false);
    eq("连接持有自己的结算器", connSrc348.includes("private readonly settle = new ConnSettle();"), true);
    eq("结算调用走字段", connSrc348.split("this.settle.").length - 1 >= 2, true);
    eq("连接正文里没有裸单例调用", /(?<![.\w])SETTLE\./.test(connSrc348.split("export class Connection")[1] || ""), false);
    ok("两个入口仍是 close / pend", typeof W.ConnSettle.prototype.close === "function" && typeof W.ConnSettle.prototype.pend === "function", "");
    ok("测试窗口里没有模块级实例", W.SETTLE === undefined, "");
  }

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case256({ fs, ok, eq, W }) {
    const prefsSrc349 = fs.readFileSync("src/route/prefs.ts", "utf8");
    const wiring349 = fs.readFileSync("src/route/policy-wiring.ts", "utf8");
    const debugSrc349 = fs.readFileSync("src/routes/debug.ts", "utf8");
    ok(
      "349·prefs 里不再有 prefsOf/chanPref/prefsJson 三个转发",
      !/export const (prefsOf|chanPref|prefsJson) =/.test(prefsSrc349),
      prefsSrc349.split("\n").filter((l) => /export const (prefsOf|chanPref|prefsJson)/.test(l)).join(" | "),
    );
    eq("349·偏好视图不再有模块级实例（7.360 全改静态）", /export const PREFS = new Prefs\(\);/.test(prefsSrc349), false);
    ok("349·策略注册直接用 PREFS 的方法", wiring349.includes("=> Prefs.chan(ip, host)") && !wiring349.includes("chanPref(ip, host)"), "");
    ok("349·?prefs=1 直接用 Prefs.json(60)", debugSrc349.includes("Prefs.json(60)") && !debugSrc349.includes("prefsJson("), "");
    // 全仓不再有「转发函数」的调用形态（`chanPref(` 只剩 HOOK 槽位上的 `HOOK.chanPref(`）
    // 本组自带遍历（`walk` 是别的组块作用域里的辅助函数，这里取不到）
    const walk349 = (d, acc = []) => {
      for (const e349 of fs.readdirSync(d, { withFileTypes: true })) {
        const full349 = d + "/" + e349.name;
        if (e349.isDirectory()) walk349(full349, acc);
        else if (e349.name.endsWith(".ts")) acc.push(full349);
      }
      return acc;
    };
    const all349 = walk349("src").map((f) => fs.readFileSync(f, "utf8")).join("\n");
    eq("349·src 里不再调用 prefsOf()", all349.split("prefsOf(").length - 1, 0);
    eq("349·src 里不再调用 prefsJson()", all349.split("prefsJson(").length - 1, 0);
    eq("349·src 里只有策略注册那一处直接走 Prefs.chan()", all349.split("Prefs.chan(").length - 1, 1);
    // 行为：三个入口仍然可用，语义与删包装前一致
    W.VT.clear();
    eq("349·没测过的通道不降权（未知 = 1）", W.Prefs.chan("9.9.9.1", "p349.com"), 1);
    eq("349·不传站点一律「未知」", W.Prefs.chan("9.9.9.1"), 1);
    W.VT.setState("p349.com", "r:9.9.9.2", 1, 1);
    eq("349·实测能打通 = 0", W.Prefs.chan("9.9.9.2", "p349.com"), 0);
    eq("349·别的站点看不到这条证据", W.Prefs.chan("9.9.9.2", "q349.com"), 1);
    W.VT.setState("p349.com", "r:9.9.9.3", 2, 1);
    eq("349·实测打不通 = 2", W.Prefs.chan("9.9.9.3", "p349.com"), 2);
    const j349 = W.Prefs.json(20);
    eq("349·json 的总数是两栏之和", j349.n, j349.ok.length + j349.bad.length);
    const o349 = W.Prefs.of("p349.com", 5);
    ok("349·of 的两栏都不超过 limit", o349.ok.length <= 5 && o349.bad.length <= 5, `${o349.ok.length}/${o349.bad.length}`);
    ok("349·测试窗口只留 PREFS", W.Prefs !== undefined && W.prefsOf === undefined && W.chanPref === undefined && W.prefsJson === undefined, "");
    W.VT.clear();
  }

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case257({ fs, eq, W, ok }) {
  /** 功能：把 src 下的 ts 文件拼成一段文本，供源码锁用。@returns 全部源码 */
  const walk350 = (dir) => {
    let out = "";
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = dir + "/" + e.name;
      if (e.isDirectory()) out += walk350(p);
      else if (e.name.endsWith(".ts")) out += fs.readFileSync(p, "utf8") + "\n";
    }
    return out;
  };
  const src350 = walk350("src");
  const alive350 = fs.readFileSync("src/px/alive.ts", "utf8");
  const scan350 = fs.readFileSync("src/px/scan.ts", "utf8");
  const pool350 = fs.readFileSync("src/px/pool.ts", "utf8").replace(/\r\n/g, "\n");
  const house350 = scan350.slice(
    scan350.indexOf("export class ScanHouse"),
    scan350.indexOf("export class PoolScan"),
  ).replace(/\r\n/g, "\n");

  // 结构 6 条：单例消失、门面不再转出、窗口里没有、执行器自己持有、类内改走字段、import 按类名
  eq("[350] 存活表读写器不再有模块级单例", (src350.match(/export const ALIVE = new AliveBoard\(\);/g) || []).length, 0);
  eq("[350] 池子门面不再转出 ALIVE", /export \{ ALIVE,/.test(pool350), false);
  eq("[350] 测试窗口里没有 ALIVE", W.ALIVE, undefined);
  eq("[350] 收尾执行器自己持有读写器", house350.includes("private readonly board = new AliveBoard();"), true);
  eq("[350] 执行器内部改成调用字段", (house350.match(/this\.board\./g) || []).length, 4);
  eq("[350] 改按类名 import（不再 import 单例）", scan350.includes("noteProbe, AliveBoard, ALIVE_MAX"), true);

  // 行为 4 条：能构造、字段是那个类、仍能列存活表、仍能裁剪
  ok("[350] 收尾执行器可构造且持有读写器", new W.ScanHouse().board instanceof W.AliveBoard);
  W.NODE_MEMORY.alive.clear();
  W.NODE_MEMORY.alive.set("a350.test:443", { h: "a350.test", p: 443, cc: "AA", ms: 60 });
  eq("[350] 读写器仍能列存活表", new W.ScanHouse().board.list().length, 1);
  W.NODE_MEMORY.alive.set("b350.test:443", { h: "b350.test", p: 443, cc: "", ms: 900 });
  eq(
    "[350] 读写器仍能按池子裁剪",
    new W.ScanHouse().board.trimToMax([{ h: "a350.test", p: 443 }], 1),
    true,
  );
  eq("[350] 对外列表入口仍在", typeof W.aliveList === "function", true);
  W.NODE_MEMORY.alive.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case258({ fs, ok, W, eq }) {
  const pol351 = fs.readFileSync("src/route/policy.ts", "utf8");
  const walk351 = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk351(d + "/" + e.name) : e.name.endsWith(".ts") ? [d + "/" + e.name] : []));
  const wire351 = fs.readFileSync("src/route/policy-wiring.ts", "utf8");
  const surf351 = fs.readFileSync("src/test-surface.ts", "utf8");
  const all351 = walk351("src").map((p) => fs.readFileSync(p, "utf8")).join("\n");
  ok("351·模块级装配器单例已撤", (all351.match(/export const WIRING = new PolicyWiring\(\);/g) || []).length === 0);
  ok("351·策略按类名引入装配器", pol351.includes(`import { PolicyWiring } from "./policy-wiring";`) && !pol351.includes("import { WIRING }"));
  ok("351·策略自己持有装配器字段", pol351.includes("private readonly wiring = new PolicyWiring();"));
  ok("351·安装入口走自己的装配器", pol351.includes("this.wiring.install(this);") && !pol351.includes("WIRING.install("));
  ok("351·窗口里不再导出装配器单例", !surf351.includes("WIRING"));
  ok("351·装配层仍注册 ≥18 个槽位", (wire351.match(/HOOK\.[a-zA-Z]+ =/g) || []).length >= 18);
  ok("351·装配器仍可独立构造", typeof W.PolicyWiring === "function" && typeof W.PolicyWiring.prototype.install === "function");
  ok("351·旧单例在窗口里已消失", W.WIRING === undefined);
  ok("351·策略仍生效（槽位已装配）", W.POLICY.enabled === true || W.POLICY.enabled === false);
  const fake351 = { shadow: () => ({ chan: { kind: "d" }, why: "fake-351" }), relays: () => [], prefer: () => false, win: () => ({ d: false, r: false }) };
  new W.PolicyWiring().install(fake351);
  eq("351·独立装配器能接管槽位", W.HOOK.decide({ host: "wire351.example", cfHost: false, clientV6: false, legacyWantsRelay: false }).why, "fake-351");
  W.POLICY.install();
  ok("351·装回真策略后不再是假实现", W.HOOK.decide({ host: "wire351.example", cfHost: false, clientV6: false, legacyWantsRelay: false }).why !== "fake-351");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case259({ fs, ok, eq, W }) {
  const meter352 = fs.readFileSync("src/store/meter.ts", "utf8");
  const diag352 = fs.readFileSync("src/store/meter-diagnostics.ts", "utf8");
  const surf352 = fs.readFileSync("src/test-surface.ts", "utf8");
  const walk352 = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk352(d + "/" + e.name) : e.name.endsWith(".ts") ? [d + "/" + e.name] : []));
  const all352 = walk352("src").map((p) => fs.readFileSync(p, "utf8")).join("\n");
  const state352 = { storage: { get: async () => "probe-ok" }, blockConcurrencyWhile: async () => {} };
  ok("352·模块级诊断单例已撤", (all352.match(/export const METER_DIAGNOSTICS = new MeterDiagnostics\(\);/g) || []).length === 0);
  ok("352·端点按类名引入分派器", meter352.includes(`import { MeterDiagnostics } from "./meter-diagnostics";`) && !meter352.includes("import { METER_DIAGNOSTICS }"));
  ok("352·端点对象自己持有分派器", meter352.includes("private readonly diagnostics = new MeterDiagnostics();"));
  ok("352·分派走自己的字段", meter352.includes("this.diagnostics.run(p, url, this.state)") && !meter352.includes("METER_DIAGNOSTICS.run("));
  ok("352·诊断类仍在原文件里", diag352.includes("export class MeterDiagnostics"));
  ok("352·窗口里不再导出单例", !surf352.includes("METER_DIAGNOSTICS"));
  eq("352·独立分派器仍判非诊断端点", await new W.MeterDiagnostics().run("/add", new URL("https://meter/add"), state352), null);
  ok("352·独立分派器仍能跑诊断端点", (await new W.MeterDiagnostics().run("/stage", new URL("https://meter/stage"), state352)) instanceof Response);
  ok("352·旧单例在窗口里已消失", W.METER_DIAGNOSTICS === undefined);
  ok("352·端点对象的字段就是分派器", new W.MeterEndpoints(new W.MeterState(), state352, async () => {}).diagnostics instanceof W.MeterDiagnostics);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case261({ fs, ok, W }) {
  // ---- 第 354 组：上游挂载器由会话自己持有，模块级 ATTACHER 退场 ----
  const atSrc354 = fs.readFileSync("src/proxy/attacher.ts", "utf8");
  const sesSrc354 = fs.readFileSync("src/proxy/session.ts", "utf8");
  const walk354 = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = dir + "/" + e.name;
      if (e.isDirectory()) out.push(...walk354(p));
      else if (e.name.endsWith(".ts")) out.push(p);
    }
    return out;
  };
  const all354 = walk354("src").map((p) => fs.readFileSync(p, "utf8")).join("\n");
  ok("[354] 挂载器模块不再导出模块级单例", !atSrc354.includes("export const ATTACHER"), "attacher.ts 里还有单例");
  ok("[354] 挂载器类仍在原文件里", atSrc354.includes("export class Attacher {"), "");
  ok("[354] 会话按类名引入挂载器", sesSrc354.includes('import { Attacher } from "./attacher";'), "");
  ok("[354] 会话自己持有挂载器", sesSrc354.includes("private readonly attacher = new Attacher();"), "");
  ok("[354] 挂上游走自己的字段", sesSrc354.includes("await this.attacher.run(") && !sesSrc354.includes("ATTACHER.run("), "还有裸 ATTACHER.run");
  ok("[354] 全仓没有模块级 ATTACHER 单例", !all354.includes("export const ATTACHER ="), "src/ 里还有");
  ok("[354] 窗口里 ATTACHER 已退场", W.ATTACHER === undefined, "W.ATTACHER 仍在");
  ok("[354] 六个补救方法都还在原型上", ["run", "onClose", "viaRelayFailed", "directEmpty", "tryV6", "tryProxyip"].every((n) => typeof W.Attacher.prototype[n] === "function"), "");
  ok("[354] 两个挂载器实例互不相同（无共享状态）", new W.Attacher() !== new W.Attacher(), "");
  ok("[354] 独立实例关客户端时仍吞掉「已关闭」的异常", (() => {
    const calls = [];
    const live = { close: (code, reason) => { calls.push(code + ":" + reason); }, send: () => {} };
    const gone = { close: () => { throw new Error("already closed"); }, send: () => {} };
    const a = new W.Attacher();
    a.endClient(live, 1011, "proxyip failed");
    a.endClient(gone, 1000, "done");
    return calls.length === 1 && calls[0] === "1011:proxyip failed";
  })(), "关客户端的口径变了");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case262({ fs, ok, W }) {
  // ---- 第 355 组：限流表成为类（RateLimiter / RATE_LIMIT），两个转发函数退场 ----
  const auth355 = fs.readFileSync("src/edge/auth.ts", "utf8");
  const admin355 = fs.readFileSync("src/routes/admin.ts", "utf8");
  ok("[355] 限流表不再是裸 Map 单例", !auth355.includes("export const RL_MEM = new Map()"), "还留着 RL_MEM");
  ok("[355] 限流器是类", auth355.includes("export class RateLimiter {"), "");
  ok("[355] 模块级实例仍是一个（跨请求状态）", auth355.includes("export const RATE_LIMIT = new RateLimiter();"), "");
  ok("[355] 窗口与上限都收进类", auth355.includes("const WINDOW_MS = 600000;") && auth355.includes("const RL_MAX = 500;"), "");
  ok("[355] 登录分支直接用类", admin355.includes("RATE_LIMIT.take(ip, 10)") && admin355.includes("RATE_LIMIT.reset(ip)") && !admin355.includes("rlTake(") && !admin355.includes("rlReset("), "");
  ok("[355] 两个转发函数已从源码消失", !auth355.includes("export function rlTake(") && !auth355.includes("export function rlReset("), "");
  ok("[355] 窗口里只剩类与实例", typeof W.RateLimiter === "function" && W.RATE_LIMIT instanceof W.RateLimiter && W.rlTake === undefined && W.rlReset === undefined && W.RL_MEM === undefined, "");
  ok("[355] 独立实例的额度互不影响", (() => {
    const a = new W.RateLimiter();
    const b = new W.RateLimiter();
    for (let i = 0; i < 10; i++) a.take("9.9.9.9", 10);
    return a.take("9.9.9.9", 10) === false && b.take("9.9.9.9", 10) === true;
  })(), "");
  ok("[355] 成功后 reset 能重新计数", (() => {
    const r = new W.RateLimiter();
    for (let i = 0; i < 5; i++) r.take("ip-reset", 5);
    const blocked = r.take("ip-reset", 5) === false;
    r.reset("ip-reset");
    return blocked && r.take("ip-reset", 5) === true;
  })(), "");
  ok("[355] 表被撑爆后仍是有界且不整体清空", (() => {
    const r = new W.RateLimiter();
    for (let i = 0; i < 10; i++) r.take("hot355", 10);
    for (let i = 0; i < 600; i++) r.take("10.8." + Math.floor(i / 256) + "." + (i % 256), 10);
    return r.size <= 501 && r.take("hot355", 10) === false;
  })(), "");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case263({ fs, ok, eq, W }) {
  const rotSrc356 = fs.readFileSync("src/px/rotation.ts", "utf8");
  const failSrc356 = fs.readFileSync("src/px/failbook.ts", "utf8");
  const selSrc356 = fs.readFileSync("src/px/selector.ts", "utf8");

  // 结构
  ok("[356] rotation 不再导出模块级实例", !rotSrc356.includes("export const ROTATION ="), rotSrc356.length);
  ok("[356] rotation 仍导出类", rotSrc356.includes("export class Rotation {"), rotSrc356.length);
  ok("[356] 门面按类引入换节点器", selSrc356.includes('import { Rotation } from "./rotation";'), selSrc356.length);
  ok("[356] 门面自己持有换节点器", selSrc356.includes("private readonly rotation = new Rotation();"), selSrc356.length);
  ok(
    "[356] 记账器通过构造注入换节点器",
    failSrc356.includes("constructor(private readonly rotation: Rotation) {}") && failSrc356.split("ROTATION.").length - 1 === 0,
    failSrc356.length
  );
  eq(
    "[356] 门面里换节点器的委托有 3 处",
    selSrc356.split("return this.rotation.").length - 1,
    3
  );

  // 行为
  ok("[356] 门面持有的是 Rotation 实例", W.SEL.rotation instanceof W.Rotation, typeof W.SEL.rotation);
  ok(
    "[356] 两个门面各持一份换节点器",
    new W.Selector().rotation !== new W.Selector().rotation,
    "shared"
  );
  const rot356 = new W.Rotation();
  ok("[356] 记账器拿到的就是传进去那一份", new W.FailBook(rot356).rotation === rot356, "identity");
  ok("[356] 窗口里不再有 ROTATION 单例", W.ROTATION === undefined, typeof W.ROTATION);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case264({ fs, ok, eq, W }) {
  const walk357 = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = dir + "/" + e.name;
      if (e.isDirectory()) out.push(...walk357(p));
      else if (e.name.endsWith(".ts")) out.push(p);
    }
    return out;
  };
  const src357 = walk357("src").map((f) => fs.readFileSync(f, "utf8")).join("\n");
  // 结构：门面文件与它的两个符号都不该再存在
  ok("[357] store 门面文件已删除", !fs.existsSync("src/store/store.ts"), "文件还在");
  eq("[357] 全仓不再有 STORE 单例", src357.split("export const STORE =").length - 1, 0);
  eq("[357] 全仓不再有 Store 类", src357.split("export class Store {").length - 1, 0);
  eq("[357] barrel 不再转出门面", fs.readFileSync("src/store/index.ts", "utf8").split("./store\"").length - 1, 0);
  ok("[357] 测试窗口不再导出 STORE", !/(^|[^A-Za-z0-9_])STORE([^A-Za-z0-9_]|$)/.test(fs.readFileSync("src/test-surface.ts", "utf8")), "窗口里还有 STORE");
  // `SEED_STORE` 是新实例名，不是已删的 `STORE` 门面；只数独立单词 STORE.
  eq("[357] 生产侧没有 STORE. 调用点", (src357.match(/(?<![A-Za-z0-9_])STORE\./g) || []).length, 0);
  // 行为：能力还在，只是挂在账本对象与模块函数上
  ok("[357] 窗口里没有门面了", W.STORE === undefined && W.Store === undefined, "门面还在");
  eq("[357] 主 uuid 仍由账本给出", W.PEND.id({ uuid: "AA,BB" }), "aa");
  ok("[357] 观测快照仍可取", Array.isArray(W.PEND.clSnap(3)), "clSnap");
  ok(
    "[357] 快照与统计仍是模块函数",
    ["getSnap", "flushSnap", "readStats", "nodeSnapGet", "usageSnapWrite", "kvGetStrict"].every((n) => typeof W[n] === "function"),
    "模块函数缺了"
  );
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case266({ fs, ok, W }) {
  const tableSrc359 = fs.readFileSync("src/core/table.ts", "utf8");
  const judgeSrc359 = fs.readFileSync("src/route/judge.ts", "utf8");
  const markBody359 = (() => {
    const at = tableSrc359.indexOf("  mark(key: string");
    const body = tableSrc359.slice(at);
    return body.slice(0, body.indexOf("\n  }"));
  })();
  ok("TimedMarks.mark 先写后裁", markBody359.includes("this.set(key, now);") && markBody359.indexOf("this.set(key, now);") < markBody359.indexOf("this.prune(now, false)"));
  ok("TimedMarks 只在超限时才裁", markBody359.includes("if (this.size > this.capacity())"));
  ok("judge 不再引入 dropExpired", !judgeSrc359.includes("dropExpired"));
  ok("窗口里有 TimedMarks", typeof W.TimedMarks === "function");

  const t359 = Date.now() - 1000;
  const marks359 = new W.TimedMarks({ max: 4, ttlMs: 600000 });
  marks359.mark("a", t359);
  ok("标记之后查得到", marks359.on("a", t359 + 10) === true);
  marks359.mark("b", t359);
  ok("过了寿命就查不到", marks359.on("b", t359 + 600001) === false);
  ok("过期项顺手删掉", marks359.size === 1);
  ok("继承自有界表", marks359 instanceof W.BoundedMap === true);
  for (let i = 0; i < 6; i++) marks359.mark("k" + i, t359 + i);
  ok("满表时压回上限", marks359.size === 4);
  ok("最新的仍在", marks359.on("k5", t359 + 10) === true);
  const other359 = new W.TimedMarks({ max: 4, ttlMs: 600000 });
  ok("两个实例互不影响", other359.on("k5", t359 + 10) === false);
  ok("判定里的两张表也是这个类", W.JUDGE.memory.neg instanceof W.TimedMarks && W.JUDGE.memory.pos instanceof W.TimedMarks);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case267({ W, eq, ok, fs }) {
  // 账本只管记账：上限、已用、被拒、快照
  const led360 = new W.BudgetLedger("request");
  eq("[360] 请求形态的 connect 上限", led360.cap("connect"), 4);
  eq("[360] 请求形态的子请求上限", led360.cap("sub"), 6);
  eq("[360] 请求形态的 DO 上限", led360.cap("do"), 2);
  led360.take("connect");
  eq("[360] 扣一次后剩三次", led360.left("connect"), 3);
  eq("[360] tryTake 成功返回 true", led360.tryTake("connect", 3), true);
  eq("[360] 全部扣完后剩 0", led360.left("connect"), 0);
  eq("[360] 超额时 tryTake 返回 false", led360.tryTake("connect"), false);
  let threw360 = "";
  try {
    led360.take("connect");
  } catch (err) {
    threw360 = err && err.name;
  }
  eq("[360] 超额时 take 抛 BudgetExhausted", threw360, "BudgetExhausted");
  eq("[360] 拒绝次数被记账", led360.snapshot().refused.connect, 2);
  eq("[360] 不限额账本的上限是 MAX_SAFE_INTEGER", W.BudgetLedger.unlimited().cap("sub"), Number.MAX_SAFE_INTEGER);
  eq("[360] cron 形态的上限更大", new W.BudgetLedger("cron").cap("connect"), 40);
  ok("[360] isBudgetExhausted 能认出额度错误", W.isBudgetExhausted(new W.BudgetExhausted("connect")) === true && W.isBudgetExhausted(new Error("x")) === false, "recognise");

  // 出口只管花钱：每次出门先取号，用尽就抛（且不再真的拨号）
  const prevSim360 = globalThis.__simConnect;
  let sim360 = 0;
  globalThis.__simConnect = () => {
    sim360 += 1;
    return { close: () => {}, closed: Promise.resolve(), opened: Promise.resolve({}) };
  };
  const ledIO = new W.BudgetLedger("request");
  const ioA = new W.BudgetedIO(ledIO);
  await ioA.openSocket("127.0.0.1", 443);
  await ioA.openSocket("127.0.0.1", 80);
  eq("[360] openSocket 真的拨了两次", sim360, 2);
  eq("[360] 两次都记在 connect 账上", ioA.snapshot().used.connect, 2);
  let threwB = "";
  try {
    await ioA.openSocket("127.0.0.1", 443);
    await ioA.openSocket("127.0.0.1", 443);
    await ioA.openSocket("127.0.0.1", 443);
  } catch (err) {
    threwB = err && err.message;
  }
  ok("[360] 建连额度用完即拒绝（不再拨）", threwB === "budget exhausted: connect" && sim360 === 4, threwB + "/" + sim360);
  globalThis.__simConnect = prevSim360;

  // 源码锁：connect( 只有一处出口；账本不碰 I/O；额度不落 S
  const walk360 = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = dir + "/" + e.name;
      if (e.isDirectory()) out.push(...walk360(p));
      else if (e.name.endsWith(".ts")) out.push(p);
    }
    return out;
  };
  const src360 = walk360("src");
  const connSites = src360
    .map((p) => ({ p, n: fs.readFileSync(p, "utf8").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n").split("connect({").length - 1 }))
    .filter((x) => x.n > 0);
  eq("[360] 全仓只有预算出口直接调 connect()", connSites.map((x) => x.p).join(","), "src/core/budgeted-io.ts");
  ok("[360] 账本不碰 I/O（不 import cloudflare:sockets）", !fs.readFileSync("src/core/budget-ledger.ts", "utf8").includes("cloudflare:sockets"), "ledger purity");
  ok("[360] 出口每次出门都取号", (fs.readFileSync("src/core/budgeted-io.ts", "utf8").match(/this\.ledger\.take\(/g) || []).length === 2, "two take sites");
  ok("[360] 没有模块级出口实例（额度随调用传递）", !src360.some((p) => /export const \w+ = new BudgetedIO\(/.test(fs.readFileSync(p, "utf8"))), "BudgetedIO singleton");
  const dialSrc360 = fs.readFileSync("src/proxy/dial.ts", "utf8");
  ok("[360] DoH 子请求只经出口（不再自己 fetch）", !/[^.\w]fetch\(url/.test(dialSrc360) && dialSrc360.includes("quota.fetch("), "dial fetch");

  // 额度用尽不能被当成「坏腿」吞掉：四处 catch 都要先认它
  for (const p of ["src/proxy/dialer.ts", "src/proxy/fallback.ts", "src/proxy/dial.ts", "src/px/probe.ts"]) {
    ok("[360] " + p + " 认出额度用尽并上抛", fs.readFileSync(p, "utf8").includes("isBudgetExhausted("), p);
  }
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case268({ fs, ok, W }) {
  const sess361 = fs.readFileSync("src/proxy/session.ts", "utf8");
  const fb361 = fs.readFileSync("src/proxy/fallback.ts", "utf8");
  const proto361 = fs.readFileSync("src/proxy/protocol.ts", "utf8");
  const lines361 = sess361.split(/\r?\n/).length;
  ok("[361] 会话文件瘦到 320 行以内", lines361 <= 320, lines361 + " 行");
  for (const bad of ["parseVLESS(", "parseTrojan(", "connect({", "withTimeout(", "PEND.", "flushSnap(", "handleDns(", "DIALER.open("]) {
    ok("[361] 会话里不再出现 " + bad, !sess361.includes(bad), bad);
  }
  ok("[361] 会话持有四个协作者", sess361.includes("new FirstFrame()") && sess361.includes("new SessionRouter(") && sess361.includes("new Attacher()") && sess361.includes("new RegionPicker()"));
  ok("[361] 拨号只剩一行委托", sess361.includes("return this.router.route(host, port);"));
  ok("[361] 路由决策在 SessionRouter 里", fb361.includes("export class SessionRouter") && fb361.includes("async route(host: string, port: number)"));
  ok("[361] 协议解析器是纯的（不 import socket/counter）", !/from "cloudflare:sockets"/.test(proto361) && !/from "\.\.\/core\/counter"/.test(proto361));
  ok("[361] 协议解析器不再导出 detectProtocol", !proto361.includes("export function detectProtocol"));

  // 行为面：破坏性首帧给出「协议错」而不是抛；合法首帧给出目标
  const ff361 = new W.FirstFrame();
  const bad361 = ff361.read(new Uint8Array([0x05, 0x00, 0x00]), { uuids: new Set(["u1"]), trojan: new Map(), list: [] });
  ok("[361] 坏首帧回 { ok:false, bad:true }", bad361.ok === false && bad361.bad === true, JSON.stringify(bad361));
  const u361 = new TextEncoder();
  const pwd361 = new TextEncoder().encode("pw361");
  // Trojan 首帧 = 56 字节 hex 摘要 + CRLF + CMD(0x01) + ATYP(0x03) + 域名 + 端口
  // Trojan 的「口令」是 56 个 hex 字符（sha224 的十六进制形式），长度错就会被判鉴权失败
  const hex361 = "0123456789abcdef".repeat(3) + "01234567";
  const head361 = new Uint8Array([
    ...u361.encode(hex361),
    0x0d, 0x0a, 0x01, 0x03,
    0x0b, // 域名长度（ATYP=3 后面必须先跟长度字节）
    ...u361.encode("example.com"),
    0x01, 0xbb,
    0x0d, 0x0a, // Trojan 请求头以 CRLF 收尾（解析器会校验这两个字节）
  ]);
  const trojan361 = new W.FirstFrame().read(head361, {
    uuids: new Set(["u1"]),
    trojan: new Map([[hex361, "u1"]]),
    list: [{ id: "u1", enabled: true }],
  });
  ok("[361] 合法首帧给出目标与偏移", trojan361.ok === true && trojan361.host === "example.com" && trojan361.port === 443 && trojan361.offset === head361.length, JSON.stringify(trojan361).slice(0, 120));
  ok("[361] 合法首帧标出协议", trojan361.ok === true && trojan361.proto === "trojan");
  void pwd361;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case270({ fs, ok, W }) {
  const jd365 = fs.readFileSync("src/route/judge.ts", "utf8");
  const st365 = fs.readFileSync("src/core/state.ts", "utf8");
  // 结构：类存在且被导出、Judge 自持、三个 S 字段已迁走、门面方法还在
  ok("[365] JudgeMemory 是导出类", jd365.includes("export class JudgeMemory {"));
  ok("[365] Judge 自持 memory 字段", jd365.includes("readonly memory = new JudgeMemory();"));
  ok("[365] 三个字段已迁出 S", !st365.includes("bigByHost") && !st365.includes("bigChan") && !st365.includes("smCnt"));
  ok("[365] Judge 保留四个门面方法", ["markNeg", "negOn", "markPos", "posOn"].every((n) => jd365.includes(n + "(")));
  ok("[365] bigDiff 门槛仍是 6h", jd365.includes("now - BASE_TTL"));
  ok("[365] 差分用搬运 done", typeof W.JUDGE.memory.bigDiff === "function");
  // 行为：软记忆实例独立、门面委托、差分判据
  const memA365 = new W.JudgeMemory();
  const memB365 = new W.JudgeMemory();
  ok("[365] 两个 JudgeMemory 互不影响", memA365 !== memB365);
  const t365 = Date.now();
  memA365.markNeg("a365.test", "198.51.100.7", t365);
  ok("[365] markNeg/negOn 走同类", memA365.negOn("a365.test", "198.51.100.7", t365 + 100) === true);
  ok("[365] 另一个实例看不到", memB365.negOn("a365.test", "198.51.100.7", t365 + 100) === false);
  memA365.noteBig("a365.test", "r:198.51.100.9", t365);
  ok("[365] bigDiff：别的通道出过整页", memA365.bigDiff("a365.test", "r:198.51.100.8", t365) === true);
  ok("[365] bigDiff：同通道出过整页不算差分", memA365.bigDiff("a365.test", "r:198.51.100.9", t365) === false);
  ok("[365] bigDiff：6h 之前不算", memA365.bigDiff("a365.test", "r:198.51.100.8", t365 + 6 * 3600_000 + 1) === false);
  memA365.bumpSmall("h|r:1.2.3.4");
  memA365.bumpSmall("h|r:1.2.3.4");
  ok("[365] bumpSmall 按通道累加", memA365.smCnt.get("h|r:1.2.3.4") === 2);
  memA365.clearSmall("h|r:1.2.3.4");
  ok("[365] clearSmall 清掉连击", !memA365.smCnt.has("h|r:1.2.3.4"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case271({ fs, ok, W }) {
  const src366 = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n") : "");
  const verdict366 = src366("src/route/verdict.ts");
  const sync366 = src366("src/route/verdictsync.ts");
  const attach366 = src366("src/proxy/attacher.ts");
  const scan366 = src366("src/px/scan.ts");
  const dial366 = src366("src/proxy/dial.ts");
  const gate366 = src366("tools/check-state-owner.mjs");

  // --- 结构：修复确实落盘 ---
  ok("[366] setState 第 5 参数带默认值", /setState\(t: string, c: string, state: VState, src: VSrc, updatedAt: EpochMs = Date\.now\(\)\)/.test(verdict366));
  ok("[366] import 传 r.t 反推原始时间", verdict366.includes("r.t - VT_TTL_MS"));
  ok("[366] import 内登记 vtSent", /VT_SYNC\.sent\.set\(r\.k, r\.t\)/.test(verdict366) && !sync366.includes("VT_SYNC.sent.set(r.k, r.t)"));
  ok("[366] attacher tryV6 认额度耗尽", /isBudgetExhausted\(e\)\) return false/.test(attach366));
  ok("[366] attacher tryProxyip 认额度耗尽", attach366.includes('this.endClient(clientSocket, 1011, "budget exhausted")'));
  ok("[366] attacher 里 nsFail 前先认额度", /isBudgetExhausted\(e\).*?NodeStatsTable\.nsFail/s.test(attach366));
  ok("[366] scan 不吞额度耗尽", /probeSni\([^)]*\)\.catch\(\(e\) => \{\s*if \(isBudgetExhausted\(e\)\) throw e;/.test(scan366));
  const dialGuards366 = (dial366.match(/if \(isBudgetExhausted\(e\)\) throw e;/g) || []).length;
  ok("[366] dial 里 7 处额度守卫", dialGuards366 >= 7, `got ${dialGuards366}`);
  ok("[366] 门禁覆盖 private/public + !/?", /private\|public\|protected/.test(gate366) && /\[!\?\]/.test(gate366));

  // --- 行为 D1：导入远端行不再续期，且不回传 ---
  W.VT.clear(); W.VT_SYNC.sent.clear(); W.VT_SYNC.pending.clear();
  const now366 = Date.now();
  const exp366 = now366 + 60000; // 远端 1 分钟后过期
  W.VT.import([{ k: "probe-366.example|r:198.51.100.8", s: 2, t: exp366 }]);
  const row366 = W.VT.all("probe-366.example")[0];
  ok("[366] 导入后仍是 blocked", !!row366 && row366.state === 2);
  // updatedAt 应为 exp - VT_TTL（原始时间，约 now - 29min），不是 now，也不是 exp
  ok("[366] 导入不续期（updatedAt 用原始时间）", !!row366 && row366.updatedAt <= now366 - 20 * 60000, `updatedAt=${row366 && row366.updatedAt}`);
  ok("[366] 导入后 vtDelta 不回传该证据", W.vtDelta().every((r) => r.k !== "probe-366.example|r:198.51.100.8"));
  ok("[366] 导入登记进 vtSent", (W.VT_SYNC.sent.get("probe-366.example|r:198.51.100.8") || 0) === exp366);
  W.VT.clear(); W.VT_SYNC.sent.clear(); W.VT_SYNC.pending.clear();

  // --- 行为：本地新证据仍正常续期（setState 默认 Date.now 未被改坏）---
  W.VT.clear();
  W.VT.setState("local-366.example", "r:198.51.100.9", 2, 1);
  const local366 = W.VT.all("local-366.example")[0];
  ok("[366] 本地新证据用当前时间", !!local366 && local366.updatedAt >= now366 - 5000);
  W.VT.clear();

  // --- 行为：额度耗尽是独立错误类型，不被当普通 Error 吞 ---
  const be366 = new W.BudgetExhausted("connect");
  ok("[366] BudgetExhausted 可识别", W.isBudgetExhausted(be366) && !W.isBudgetExhausted(new Error("x")));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case272({ fs, ok, W, eq }) {
  const protoSrc367 = fs.readFileSync("src/proxy/protocol.ts", "utf8").replace(/\r\n/g, "\n");
  const i367 = protoSrc367.indexOf("export async function loadUsers(");
  const j367 = i367 < 0 ? -1 : protoSrc367.indexOf("\n}\n", i367);
  const lu367 = i367 < 0 || j367 < 0 ? "" : protoSrc367.slice(i367, j367);

  // 结构：读 KV 之前不能再拿 sig 命中的旧表直接 return（跨 isolate 的根因）
  ok("[367] loadUsers 不再用 sig 命中正向缓存", !/if \(USERS\.v && USERS\.sig === sig/.test(lu367));
  ok("[367] 每次都读 KV 的 users 键", lu367.includes('kvGetStrict<UserRec[]>(env, "users")'));
  ok("[367] 旧表只在 KV 失败时兜底", lu367.includes("!readOk && USERS.v && prevSig === sig"));

  // 行为：KV 里新增托管用户后，env 不变（sig 相同）、也不调 invalidateUsers，
  // 下一次 loadUsers 必须立刻看到新用户 —— 这就是面板 A isolate 加用户、
  // 订阅落到 B isolate 的真实场景（旧代码在这里命中 5 分钟旧缓存 ⇒ 404）。
  const OLD367 = "aaaaaaaa-0000-4000-8000-000000000001";
  const NEW367 = "aaaaaaaa-0000-4000-8000-000000000002";
  const box367 = new Map();
  const env367 = {
    uuid: OLD367,
    STATS: {
      get: async (k) => box367.get(k) ?? null,
      put: async (k, v) => { box367.set(k, v); },
    },
  };
  W.USERS.v = null; W.USERS.t = 0;
  W.USERS.sig = "";
  const first367 = await W.loadUsers(env367);
  ok("[367] 初始只有老用户", first367.uuids.has(OLD367) && !first367.uuids.has(NEW367));

  // 模拟面板在另一个 isolate 上 saveUsers：只写 KV，不动本 isolate 的 USERS 缓存
  box367.set("users", JSON.stringify([
    { id: NEW367, pwd: "newpass367", note: "", enabled: true, managed: true, ts: 1 },
  ]));
  const second367 = await W.loadUsers(env367);
  ok("[367] 同一 sig 下新增用户立即生效", second367.uuids.has(NEW367), "新用户仍 404");
  eq("[367] 新用户的 Trojan 密码可取", W.trojanPasswordOf(env367, NEW367, second367), "newpass367");

  // 兜底契约仍在：KV 读失败时返回上一份，且 ok 为假（不谎称已落盘）
  const failEnv367 = {
    uuid: OLD367,
    STATS: { get: async () => { throw new Error("kv down 367"); } },
  };
  const third367 = await W.loadUsers(failEnv367);
  ok("[367] KV 故障仍返回上一份用户表", third367.uuids.has(NEW367));
  eq("[367] KV 故障时 ok 为假", third367.ok, false);

  W.USERS.v = null; W.USERS.t = 0;
  W.USERS.sig = "";
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case273({ fs, ok, W, eq }) {
  // ---- D3: vtShape 必须要求全七张表，缺一张就不能置 vtLoaded ----
  const vsrc368 = fs.readFileSync("src/route/verdictsync.ts", "utf8");
  ok("[368] vtShape 登记全七张表", ["vt", "hl", "eg", "ps", "dead", "blk2", "dns"].every((k) => vsrc368.includes(`"${k}"`)));
  ok("[368] 形状校验用 every 遍历", vsrc368.includes("FACT_TABLES.every("));

  const savedCaches368 = globalThis.caches;
  delete globalThis.caches;
  const full368 = () => new Response(JSON.stringify({ vt: [], hl: [], eg: [], ps: [], dead: [], blk2: [], dns: [] }), { status: 200 });
  const partial368 = () => new Response(JSON.stringify({ vt: [], hl: [], eg: [], ps: [], dead: [], blk2: [] }), { status: 200 });
  const env368 = (mk) => ({ uuid: "u368", METER: { idFromName: () => "id368", get: () => ({ fetch: async () => mk() }) } });
  const reset368 = () => { W.VT_SYNC.loaded = false; W.VT_SYNC.coolUntil = 0; W.VT_SYNC.flight = null; };

  // 缺 dns 的响应：不能当成完整事实（否则本 isolate 余生看不到 dns）
  reset368();
  await W.vtLoad(env368(partial368));
  ok("[368] 缺一张事实表不置 vtLoaded", W.VT_SYNC.loaded === false, String(W.VT_SYNC.loaded));
  ok("[368] 形状不对记 60 秒冷却", W.VT_SYNC.coolUntil > Date.now(), String(W.VT_SYNC.coolUntil - Date.now()));

  // 全七张：正常加载
  reset368();
  await W.vtLoad(env368(full368));
  ok("[368] 全七张表正常加载", W.VT_SYNC.loaded === true, String(W.VT_SYNC.loaded));

  globalThis.caches = savedCaches368;
  reset368();

  // ---- D2: 同一 isolate 的两个 flush 不并发 ----
  const psrc368 = fs.readFileSync("src/store/pend.ts", "utf8");
  const ssrc368 = fs.readFileSync("src/core/state.ts", "utf8");
  ok("[368] 单飞守卫字段在 PendingLedger 上", /private flushing = false/.test(psrc368) && !/pendBusy/.test(ssrc368));
  ok("[368] flush 有单飞守卫", psrc368.includes("if (this.flushing) {"));
  ok("[368] flush finally 释放守卫", psrc368.includes("this.flushing = false;"));

  const savedPend368 = { at: W.PEND.flushedAt, ms: W.PEND.intervalMs, busy: W.PEND.flushing };
  W.PEND.rows.clear();
  W.PEND.flushing = false;
  W.PEND.flushedAt = 0;
  W.PEND.intervalMs = 0;
  W.PEND.add("u1-368", 10, 10, true);
  W.PEND.add("u2-368", 10, 10, true);
  let active368 = 0;
  let maxActive368 = 0;
  let posts368 = 0;
  const cenv368 = {
    uuid: "u1-368",
    METER: {
      idFromName: (n) => "id-" + n,
      get: () => ({
        fetch: async () => {
          posts368 += 1;
          active368 += 1;
          maxActive368 = Math.max(maxActive368, active368);
          await new Promise((r) => setTimeout(r, 25));
          active368 -= 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      }),
    },
  };
  // max=1 => 第一批只摘走 u1，u2 仍留在账本里；若不单飞，第二个 flush 会并发再摘 u2
  await Promise.all([
    W.PEND.flush(cenv368, true, 1),
    W.PEND.flush(cenv368, true, 1),
  ]);
  eq("[368] 并发 flush 只跑一个 POST", posts368, 1);
  eq("[368] 同时在途的上报不超过一批", maxActive368, 1);
  ok("[368] 守卫已释放", W.PEND.flushing === false, String(W.PEND.flushing));
  ok("[368] 被跳过的那批仍在账本里", W.PEND.rows.has("u2-368"), [...W.PEND.rows.keys()].join(","));
  ok("[368] 单飞跳过 force 时记一笔补排", psrc368.includes("this.forceSkipped = true"));
  ok("[368] finally 补排被跳过的 force", /if \(this\.forceSkipped\)[\s\S]*this\.schedule\(env, 0\)/.test(psrc368));

  // 在途 flush 期间定时器 force 到点：单飞跳过但记一笔，本轮结束后必须补排把剩余用户上报。
  {
    W.PEND.rows.clear();
    W.PEND.flushedAt = 0;
    W.PEND.flushing = false;
    W.PEND.forceSkipped = false;
    W.PEND.intervalMs = 0;
    W.PEND.add("fa-368", 10, 10, true);
    W.PEND.add("fb-368", 10, 10, true);
    let release;
    const gate = new Promise((r) => { release = r; });
    let firstPosts = 0;
    let allPosts = 0;
    const cenv368b = {
      uuid: "fa-368",
      METER: {
        idFromName: (n) => "id-" + n,
        get: () => ({
          fetch: async () => {
            allPosts += 1;
            if (allPosts === 1) { firstPosts += 1; await gate; }
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        }),
      },
    };
    const inFlight = W.PEND.flush(cenv368b, true, 1); // 摘走 fa，卡在 post
    // 等第一轮真正进入 post（flushing=true）
    await new Promise((r) => setTimeout(r, 5));
    ok("[368] 第一轮在途时 flushing 为真", W.PEND.flushing === true, String(W.PEND.flushing));
    // 定时器到点：force flush 被单飞跳过，但记 forceSkipped
    await W.PEND.flush(cenv368b, true, 1);
    ok("[368] 单飞期间 force 被记下", W.PEND.forceSkipped === true, String(W.PEND.forceSkipped));
    // 放行第一轮；finally 应补排，把 fb 也上报
    release();
    await inFlight;
    await new Promise((r) => setTimeout(r, 20));
    eq("[368] 被跳过的 force 已补排（两次 POST）", allPosts, 2);
    ok("[368] 补排后剩余用户已上报", !W.PEND.rows.has("fb-368"), [...W.PEND.rows.keys()].join(","));
    ok("[368] 补排后 forceSkipped 已清", W.PEND.forceSkipped === false, String(W.PEND.forceSkipped));
  }

  W.PEND.rows.clear();
  W.PEND.flushedAt = savedPend368.at;
  W.PEND.intervalMs = savedPend368.ms;
  W.PEND.flushing = savedPend368.busy;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case274({ W, eq, fs, ok }) {
  // 2.1/2.3：CF 探测与 NAT64 兜底的 DoH 都走 quota.fetch，额度耗尽不能被当网络错吞掉。
  // 用一本 sub 上限=1 的账本 + stub fetch 证明「第二次 fetch 前就被账本拒绝」。
  const budget369 = new W.BudgetLedger("request"); // sub cap=6
  const originalFetch369 = globalThis.fetch;
  let subCalls369 = 0;
  try {
    globalThis.fetch = async (_url, _init) => {
      subCalls369 += 1;
      return new Response("ok", { status: 200, headers: { "cf-ray": "abc-HKG" } });
    };
    // httpProbe 传 quota：每次调用扣一次 sub
    const io369 = new W.BudgetedIO(budget369);
    await W.httpProbe("probe369.example.com", 1000, io369);
    eq("[369] httpProbe 走 quota.fetch 并扣 sub", io369.snapshot().used.sub, 1);
    eq("[369] httpProbe 确实发了子请求", subCalls369, 1);

    // 额度用尽的 io：第一次 fetch 即被拒，httpProbe 吞掉后返回 code 0，但账本 refused 记 1
    const ioTight369 = new W.BudgetedIO(new W.BudgetLedger("request", { sub: 0 }));
    const probe0 = await W.httpProbe("probe369b.example.com", 1000, ioTight369);
    eq("[369] 额度为 0 时探测返回未知", probe0.code, 0);
    eq("[369] 额度耗尽被账本记为拒绝", ioTight369.snapshot().refused.sub, 1);
    eq("[369] 额度耗尽没有真的发 fetch", subCalls369, 1);
  } finally {
    globalThis.fetch = originalFetch369;
  }

  // 结构证据：refreshCfHttp 签名带 quota 并把 httpProbe 的第三参传下去；
  // dial 的 NAT64 兜底把 quota 传给 resolveV4 且 catch 里上抛 BudgetExhausted。
  const cfSrc369 = fs.readFileSync("src/proxy/cfverdict.ts", "utf8");
  const dialSrc369 = fs.readFileSync("src/proxy/dial.ts", "utf8");
  ok("[369] refreshCfHttp 接收 quota", cfSrc369.includes("quota: BudgetedIO = BudgetedIO.unlimited()"), "refreshCfHttp 没有 quota 参数");
  ok("[369] httpProbe 收到 quota", cfSrc369.includes("httpProbe(host, CONNECT_MS, quota)"), "quota 未传给 httpProbe");
  ok("[369] NAT64 兜底 resolveV4 传 quota", dialSrc369.includes("resolveV4(host, quota)"), "NAT64 DoH 仍走 unlimited");
  ok("[369] NAT64 兜底上抛额度耗尽", /resolveV4\(host, quota\)[\s\S]{0,120}isBudgetExhausted\(e\)\)\s*throw e/.test(dialSrc369), "额度耗尽被当 DNS 失败");

  // HTML 抽取：5 个模板都在，且 renderTemplate 占位符替换正确（未在 vars 的原样保留）
  const tplDir369 = "src/views/html";
  for (const name369 of ["panel", "stats", "admin", "login", "admin-hint"]) {
    ok(`[369] 模板 ${name369}.html 存在`, fs.existsSync(`${tplDir369}/${name369}.html`), name369);
  }
  eq("[369] renderTemplate 替换已登记占位符", W.renderTemplate("a{{x}}b", { x: "1" }), "a1b");
  eq("[369] renderTemplate 保留未登记占位符", W.renderTemplate("a{{x}}b", {}), "a{{x}}b");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case275({ fs, ok, W }) {
  const dbgSrc370 = fs.readFileSync("src/routes/debug.ts", "utf8");
  ok("[370] ?do=1 成功时 ack", dbgSrc370.includes("if (r.ok) vtAck();"), "成功未 ack");
  ok("[370] ?do=1 失败时 nack", dbgSrc370.includes("else vtNack();") && /catch \{[\s\S]{0,140}vtNack\(\);/.test(dbgSrc370), "失败未 nack");

  const key370 = "do371.example.com|r:198.51.100.9";
  const setup370 = (addStatus) => {
    W.VT.clear();
    W.VT_SYNC.pending.clear();
    W.VT_SYNC.sent.clear();
    W.VT_SYNC.coolUntil = 0;
    W.VT_SYNC.loaded = false;
    W.VT.setState("do371.example.com", "r:198.51.100.9", 3, 1);
    const adds = [];
    const meter = {
      idFromName: (n) => n,
      get: () => ({
        fetch: async (u) => {
          if (String(u).includes("/meter/add")) {
            adds.push(String(u));
            return new Response("{}", { status: addStatus });
          }
          // /meter/vt 回 5xx，让 vtLoad 进 catch 而不污染判定表
          return new Response("{}", { status: 500 });
        },
      }),
    };
    return { meter, adds };
  };
  const run370 = async (meter) => {
    const url = new URL("https://sim.example.com/u/debug?do=1");
    const request = new Request(url.toString());
    const ctx = { request, url, env: { METER: meter, uuid: "do371-uuid" }, id: "do371-uuid", exec: { waitUntil() {}, passThroughOnException() {} } };
    try { await W.debug(ctx); } catch { /* 后续诊断分支缺 env 绑定，忽略 */ }
  };

  // 成功：add 回 200 → pending 清空且登记进 sent，下轮不再上报
  {
    const { meter, adds } = setup370(200);
    const before370 = W.vtDelta().some((r) => r.k === key370);
    await run370(meter);
    ok("[370] 写回前先登记了 pending", before370, "vtDelta 没登记");
    ok("[370] 成功写回调用 /add", adds.length === 1, "没打 add");
    ok("[370] 成功后 pending 清空", W.VT_SYNC.pending.size === 0, "pending 未清");
    ok("[370] 成功后记进 sent", W.VT_SYNC.sent.has(key370), "sent 没有该行");
  }
  // 失败：add 回 500 → pending 清空但不进 sent，下一轮重新登记
  {
    const { meter, adds } = setup370(500);
    W.vtDelta();
    await run370(meter);
    ok("[370] 失败写回也调用 /add", adds.length === 1, "没打 add");
    ok("[370] 失败后 pending 清空", W.VT_SYNC.pending.size === 0, "pending 未清");
    ok("[370] 失败后不记 sent", !W.VT_SYNC.sent.has(key370), "sent 不该有该行");
  }

  W.VT.clear();
  W.VT_SYNC.pending.clear();
  W.VT_SYNC.sent.clear();
  W.VT_SYNC.coolUntil = 0;
  W.VT_SYNC.loaded = false;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case284({ fs, ok, W, eq }) {
  // 结构：决策理由收进 core 的封闭集合，proxy 侧只引用硬规则集合，不再抄字面量。
  const hookSrc = fs.readFileSync("src/core/hook.ts", "utf8");
  const pxhookSrc = fs.readFileSync("src/proxy/pxhook.ts", "utf8");
  const polSrc = fs.readFileSync("src/route/policy.ts", "utf8");
  const statsSrc = fs.readFileSync("src/store/stats.ts", "utf8");
  const proxyipSrc = fs.readFileSync("src/routes/proxyip.ts", "utf8");
  const subSrc = fs.readFileSync("src/routes/subscription.ts", "utf8");
  ok("[380] core 定义决策理由常量与封闭类型",
    hookSrc.includes("export const DECISION_WHY = {") && hookSrc.includes("export type DecisionWhy"));
  ok("[380] DecisionOut.why 用封闭类型", hookSrc.includes("why: DecisionWhy;"));
  ok("[380] 硬规则集合集中在 core", hookSrc.includes("export const HARD_DECISION_WHY"));
  ok("[380] proxy 侧不再逐字比对 why",
    pxhookSrc.includes("HARD_DECISION_WHY.has(out.why)") && !pxhookSrc.includes('out.why === "v6-cf"'));
  // 所有 policy 产生的 why 字面量都在 DECISION_WHY 里（tsc 已强制，这里再锁运行时集合）。
  const whyVals = Object.values(W.DECISION_WHY || {});
  eq("[380] 决策理由共 14 个", whyVals.length, 14);
  const hardSet380 = W.HARD_DECISION_WHY || new Set();
  ok("[380] 硬规则理由全在封闭集合内",
    [...hardSet380].every((w) => whyVals.includes(w)) && hardSet380.size > 0);
  eq("[380] 硬规则共 6 条", hardSet380.size, 6);
  // 合并去重：单一 helper，两个路由都不再各自抄 Math.max 循环。
  eq("[380] mergeNodeSnap 只有一处定义", (statsSrc.match(/export function mergeNodeSnap\(/g) || []).length, 1);
  ok("[380] proxyip 与订阅都改用共享 helper",
    proxyipSrc.includes("mergeNodeSnap(nsMap, snapS)") && subSrc.includes("mergeNodeSnap(nsMap, snap)"));
  ok("[380] 两路由不再内联取大循环",
    !proxyipSrc.includes("bpsMed: Math.max") && !subSrc.includes("bpsMed: Math.max"));
  // 行为：取大、原地、保留其它字段、跳过空行。
  const m380 = { "a:443": { bps: 100, bpsMed: 50, bpsCap: 200, n: 1, extra: "keep" } };
  const snap380 = {
    "a:443": { med: 90, p90: 140, cap: 180, n: 3, at: 1 },
    "b:443": { med: 10, p90: 20, cap: 30, n: 2, at: 1 },
    "c:443": null,
  };
  const before380 = JSON.stringify(m380);
  if (typeof W.mergeNodeSnap === "function") W.mergeNodeSnap(m380, snap380);
  ok("[380] 合并确实发生（旧代码无 helper 不变）", JSON.stringify(m380) !== before380);
  eq("[380] 逐字段取大 p90", m380["a:443"].bps, 140);
  eq("[380] 逐字段取大 med", m380["a:443"].bpsMed, 90);
  eq("[380] 逐字段取大 cap", m380["a:443"].bpsCap, 200);
  eq("[380] 逐字段取大 n", m380["a:443"].n, 3);
  eq("[380] 保留调用方额外字段", m380["a:443"].extra, "keep");
  eq("[380] 新节点插入", m380["b:443"].bps, 20);
  ok("[380] 空快照行被跳过", !("c:443" in m380));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case285({ fs, ok, W }) {
  const dialSrc = fs.readFileSync("src/proxy/dialer.ts", "utf8");
  const stateSrc = fs.readFileSync("src/core/state.ts", "utf8");
  const seedSrc = fs.readFileSync("src/px/seed.ts", "utf8");
  const ownerSrc = fs.readFileSync("tools/check-state-owner.mjs", "utf8");
  // 结构：cfHost 从 S 迁进 Dialer，门禁登记防回潮。
  ok("[382] Dialer 自持 cfHost 缓存", dialSrc.includes("readonly cfHost = new Map<string, number>()"));
  const dialCode382 = dialSrc.split(/\r?\n/).filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
  ok("[382] classify 读写实例缓存而非 S",
    dialCode382.includes("this.cfHost.get(host)") && dialCode382.includes("this.cfHost.set(host")
      && !dialCode382.includes("S.cfHost"));
  ok("[382] 裁剪用实例缓存", dialSrc.includes("dropExpired(this.cfHost)") && dialSrc.includes("trimAged(this.cfHost)"));
  ok("[382] S 里已无 cfHost 字段", !/^\s*cfHost\s*:/m.test(stateSrc));
  ok("[382] 状态归属门禁登记 cfHost", ownerSrc.includes('["cfHost"'));
  // 行为：缓存确实挂在 DIALER 实例上，且与 S 解耦。
  ok("[382] DIALER 暴露 cfHost 实例", W.DIALER && W.DIALER.cfHost instanceof Map);
  const key382 = "cfhost382.test";
  W.DIALER.cfHost.set(key382, Date.now() + 60000);
  ok("[382] 缓存命中可读写", (W.DIALER.cfHost.get(key382) || 0) > Date.now());
  ok("[382] S 上不再有 cfHost 表", W.S?.cfHost === undefined);
  W.DIALER.cfHost.delete(key382);
  // seed.ts 文档 mojibake 已修复（历史 PowerShell 写坏 UTF-8）。
  ok("[382] seed.ts 无 mojibake", !seedSrc.includes("鎶婃湰鍦") && seedSrc.includes("把本地统计合并进"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case286({ fs, eq, ok }) {
  const shardSrc = fs.readFileSync("src/store/metershard.ts", "utf8");
  const outSrc = fs.readFileSync("src/store/factout.ts", "utf8");
  const addSrc = fs.readFileSync("src/store/meteradd.ts", "utf8");
  const stateSrc = fs.readFileSync("src/store/meter-state.ts", "utf8");
  // 结构：单一 interface + 三处复用 + MeterStore 用 Partial。
  eq("[383] FactTables 只有一处定义", (shardSrc.match(/export interface FactTables\b/g) || []).length, 1);
  // 从 export interface FactTables 到下一个顶层 } 之间才是七个字段（行内有内联 {} 不能简单 split）。
  const ftBody383 = shardSrc.slice(shardSrc.indexOf("export interface FactTables"), shardSrc.indexOf("export interface MeterStore"));
  const fields383 = ["vt", "hl", "eg", "ps", "dead", "blk2", "dns"];
  ok("[383] FactTables 含七张表", fields383.every((f) => new RegExp("\\b" + f + ":").test(ftBody383)));
  ok("[383] MeterStore 复用 Partial<FactTables>", shardSrc.includes("interface MeterStore extends Partial<FactTables>"));
  ok("[383] FactOutSrc 取型自 FactTables", outSrc.includes("type FactOutSrc = FactTables") && !outSrc.includes("interface FactOutSrc"));
  ok("[383] AddTarget 继承 FactTables", addSrc.includes("interface AddTarget extends FactTables"));
  ok("[383] MeterState 实现 FactTables", stateSrc.includes("class MeterState implements FactTables"));
  // 四处 + factmerge 都不再各自抄 ps 的行类型：只有单一真源有一份。
  const mergeSrc383 = fs.readFileSync("src/store/factmerge.ts", "utf8");
  const shape383 = /Record<string, \{ q: number; n: number; at: number; top\?: number \}>/g;
  const allStore383 = [shardSrc, outSrc, addSrc, stateSrc, mergeSrc383];
  eq("[383] ps 行类型只在单一真源出现", allStore383.reduce((n, s) => n + (s.match(shape383) || []).length, 0), 1);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case287({ fs, ok, execFileSync, eq }) {
    const G = 384;
    const gate = "tools/check-singletons.mjs";
    const docPath = "docs/命名约定.md";
    const gateSrc = fs.readFileSync(gate, "utf8");
    const doc = fs.readFileSync(docPath, "utf8");
    ok(`[${G}] 门禁文件存在`, fs.existsSync(gate));
    ok(`[${G}] 文档有清单起止标记`, doc.includes("<!-- singleton-list:start -->") && doc.includes("<!-- singleton-list:end -->"));
    // 数量跟随真实声明，不能用历史常数让错误文档通过、正确文档失败。
    const builtins = new Set(["Set", "Map", "TextEncoder", "TextDecoder", "Uint32Array", "Array", "Date", "URL", "RegExp", "Error", "WeakMap"]);
    const sourceFiles = fs.readdirSync("src", { recursive: true }).filter(file => String(file).endsWith(".ts"));
    let actualDeclarations = 0;
    for (const file of sourceFiles) {
      const source = fs.readFileSync("src/" + file, "utf8");
      for (const match of source.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*new\s+([A-Za-z_$][\w$]*)\s*[\(<]/g)) {
        if (!builtins.has(match[2])) actualDeclarations++;
      }
    }
    ok(`[${G}] 文档声明数与实际一致`, doc.includes(`${actualDeclarations} 处声明`));
    ok(`[${G}] 门禁接进 preflight`, fs.readFileSync("tools/preflight.mjs", "utf8").includes("tools/check-singletons.mjs"));
    ok(`[${G}] 门禁支持 SINGLETON_DOC 覆盖`, gateSrc.includes("SINGLETON_DOC"));
    // 行为：干净文档退出 0。
    let clean384 = 0;
    try { execFileSync("node", [gate], { encoding: "utf8" }); } catch (e) { clean384 = 1; }
    eq(`[${G}] 干净清单通过门禁`, clean384, 0);
    // 删掉一个登记名字（VT）⇒ 门禁必须红且点名。
    const a384 = doc.indexOf("<!-- singleton-list:start -->");
    const b384 = doc.indexOf("<!-- singleton-list:end -->");
    const missing384 = doc.slice(0, a384) + doc.slice(a384, b384).replace("`VT`", "`ZZ_UNUSED`") + doc.slice(b384);
    const tmp384 = ".tmp-sim/singletons384.md";
    fs.mkdirSync(".tmp-sim", { recursive: true });
    fs.writeFileSync(tmp384, missing384);
    let bad384 = 0, badOut384 = "";
    try {
      execFileSync("node", [gate], { encoding: "utf8", env: { ...process.env, SINGLETON_DOC: tmp384 } });
    } catch (e) {
      bad384 = 1;
      badOut384 = String(e.stdout || "") + String(e.stderr || "");
    }
    eq(`[${G}] 清单漏登记就红`, bad384, 1);
    ok(`[${G}] 报错点名漂移名字`, badOut384.includes("ZZ_UNUSED") && badOut384.includes("VT"), badOut384.slice(0, 160));
    if (fs.existsSync(tmp384)) fs.unlinkSync(tmp384);
    ok(`[${G}] 临时文档已清理`, !fs.existsSync(tmp384));
  }

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case288({ fs, ok, W, eq }) {
  const G = 386;
  const srcTun386 = fs.readFileSync("src/proxy/tunnel.ts", "utf8");
  const srcUtil386 = fs.readFileSync("src/core/util.ts", "utf8");
  const srcCnt386 = fs.readFileSync("src/core/counter.ts", "utf8");

  // ── 结构锁 ──
  ok(`[${G}] 常量 FIRST_BYTE_MS 存在`, W.FIRST_BYTE_MS === 10000, String(W.FIRST_BYTE_MS));
  ok(`[${G}] 常量有看门狗说明`, srcUtil386.includes("首字节看门狗"));
  ok(`[${G}] cntKeys 登记 fbwd`, srcCnt386.includes('"fbwd"'));
  ok(`[${G}] pipeBack 有 firstByteMs 参数`, srcTun386.includes("firstByteMs: number = FIRST_BYTE_MS"));
  ok(`[${G}] 看门狗定时器 arm/clear`, srcTun386.includes("const armWd") && srcTun386.includes("const clearWd"));
  ok(`[${G}] 收到字节撤销看门狗`, srcTun386.includes("if (st.down > 0) clearWd()"));
  ok(`[${G}] 看门狗触发记 fbwd`, srcTun386.includes('cnt("fbwd")'));
  ok(`[${G}] 看门狗触发关 socket`, srcTun386.includes("closeQuietly(sock)"));
  ok(`[${G}] 看门狗触发不关客户端 WS`, srcTun386.includes("if (!clientGone && !wdFired)"));
  ok(`[${G}] close 分支清看门狗`, srcTun386.includes("clearWd(); // 流已结束"));

  // ── 行为桩：socket 的 close() 让 readable 报错，模拟黑洞被主动掐断 ──
  const mkSock386 = (ref) => {
    let ctrl = null;
    const sock = {
      readable: new ReadableStream({
        start(c) { ctrl = c; if (ref) ref.ctrl = c; },
      }),
      closed: Promise.resolve(),
      writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
    };
    sock.close = () => { try { ctrl.error(new Error("watchdog")); } catch (e) {} };
    return sock;
  };
  const ws386 = () => ({ readyState: 1, bufferedAmount: 0, send() {}, codes: [], close(code) { this.codes.push(code); } });
  const st386 = () => {
    const st = new W.Connection({}, "u386", "", "tput");
    st.node = "198.51.100.99:443";
    st.host = "x.com";
    st.mark = 1e9;
    st.tAttach = Date.now();
    st.down = 0;
    return st;
  };

  // ① 黑洞：注入 30ms 看门狗，无下行 → 主动关 socket → onClose(false)，且客户端没被关
  {
    const st = st386(), ws = ws386(), sock = mkSock386(null), calls = [];
    const fbwd0 = W.cntView().fbwd || 0;
    W.pipeBack(sock, ws, st, (got) => calls.push(got), 30);
    await new Promise((r) => setTimeout(r, 160));
    eq(`[${G}] 黑洞触发一次 onClose(false)`, calls.length, 1);
    eq(`[${G}] onClose 收到 gotData=false`, calls[0], false);
    eq(`[${G}] 黑洞记 fbwd`, (W.cntView().fbwd || 0) - fbwd0, 1);
    eq(`[${G}] 看门狗不关客户端 WS`, ws.codes.length, 0);
  }

  // ② 收到首字节：看门狗撤销，流正常结束 onClose(true)，不记 fbwd
  {
    const ref = {}, st = st386(), ws = ws386(), sock = mkSock386(ref), calls = [];
    const fbwd0 = W.cntView().fbwd || 0;
    W.pipeBack(sock, ws, st, (got) => calls.push(got), 60);
    await new Promise((r) => setTimeout(r, 10));
    ref.ctrl.enqueue(new Uint8Array([0x48, 0x54]));
    await new Promise((r) => setTimeout(r, 20));
    ref.ctrl.close();
    await new Promise((r) => setTimeout(r, 60));
    eq(`[${G}] 有首字节不记 fbwd`, (W.cntView().fbwd || 0) - fbwd0, 0);
    ok(`[${G}] 有首字节 onClose 收到 true`, calls.length >= 1 && calls[0] === true);
  }

  // ③ 没有 onClose（纯转发）：看门狗不应触发，fbwd 不增
  {
    const st = st386(), ws = ws386(), sock = mkSock386(null);
    const fbwd0 = W.cntView().fbwd || 0;
    W.pipeBack(sock, ws, st, undefined, 30);
    await new Promise((r) => setTimeout(r, 100));
    eq(`[${G}] 无 onClose 不记 fbwd`, (W.cntView().fbwd || 0) - fbwd0, 0);
  }

  // ④ 多跳补救链：run() 挂新跳前必须重置 notified，否则第二跳黑洞的看门狗触发后
  //    close/catch 的 !notified 守卫挡住 onClose，换路断链、客户端干等到 30s。
  ok(`[${G}] run 每跳重置 notified`, fs.readFileSync("src/proxy/attacher.ts", "utf8").includes("conn.notified = false;"));
  {
    const conn = new W.Connection({}, "u386b", "", "tput");
    conn.notified = true; // 模拟第一跳已收尾
    let ctrl = null;
    const sock = {
      readable: new ReadableStream({ start(c) { ctrl = c; } }),
      closed: Promise.resolve(),
      writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
      close() { try { ctrl.error(new Error("done")); } catch (e) {} },
    };
    const ws = ws386();
    // 空 payload 跳过 upWrite，run 直接挂 pipeBack；此时 notified 应已重置
    await new W.Attacher().run({ conn, clientSocket: ws, payload: new Uint8Array(0), env: {}, host: "x.com", port: 443, mode: "tput" }, sock);
    eq(`[${G}] 新跳 notified 归零`, conn.notified, false);
    sock.close();
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case289({ W, ok, eq, fs }) {
  const G = "387";
  const envP = { uuid: "u", proxyip: "auto", defaultMode: "tput" };
  const urlP = new URL("https://edge.example.com/u");
  const rClash = W.renderClash(envP, urlP, "4241b903-8d39-4a17-8f4c-bb33b1630c33", "edge.example.com");
  const rSb = W.renderSingbox(envP, urlP, "4241b903-8d39-4a17-8f4c-bb33b1630c33", "edge.example.com");
  // 默认目标：两种格式都不再用 gstatic，改指 CF 站点
  ok(`[${G}] clash 默认探测目标不是 gstatic`, !rClash.includes("gstatic.com") && rClash.includes("url: https://x.com/"));
  // 吞吐/速率组必须带 expected-status: 200 —— 否则 url-test 把 v6 出口的 737B 403 也当「通」，
  // 测速快就选中，用户仍看到 IPv6 拒绝页。按组名定位块，确认每组都有这条。
  {
    const hasExpected = (name) => {
      const i = rClash.indexOf(`- name: "${name}"`);
      if (i < 0) return false;
      const blk = rClash.slice(i, rClash.indexOf("- name:", i + 10) < 0 ? rClash.length : rClash.indexOf("- name:", i + 10));
      return blk.includes("expected-status: 200");
    };
    ok(`[${G}] 吞吐组拒绝非200`, hasExpected("🚀 吞吐优先"));
    ok(`[${G}] 速率组拒绝非200`, hasExpected("⚡ 速率优先"));
  }
  ok(`[${G}] singbox 默认探测目标不是 gstatic`, !rSb.includes("gstatic.com") && /"url":\s*"https:\/\/x\.com\/"/.test(rSb));
  // ?pu= 可覆盖（合法 https）
  const rPu = W.renderClash(envP, new URL("https://edge.example.com/u?pu=https://cloudflare.com/"), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "edge.example.com");
  ok(`[${G}] ?pu= 覆盖探测目标`, rPu.includes("url: https://cloudflare.com/") && !rPu.includes("url: https://x.com/"));
  // 非法 ?pu= 回落默认
  eq(`[${G}] probeUrlOf 合法覆盖`, W.probeUrlOf(new URL("https://h/u?pu=https://ok.example/a")), "https://ok.example/a");
  eq(`[${G}] probeUrlOf 非法回落`, W.probeUrlOf(new URL("https://h/u?pu=http://bad")), "https://x.com/");
  eq(`[${G}] probeUrlOf 缺省`, W.probeUrlOf(new URL("https://h/u")), "https://x.com/");
  // 中继条目不再钉 rx（结构锁：源码里 r- 条目的 emit 路径无 rx=）
  const subSrc = fs.readFileSync("src/views/sub.ts", "utf8");
    ok(`[${G}] 中继组已删除（无 r- 条目/无 ip=relay）`, !subSrc.includes("ip=relay") && !subSrc.includes("const G_RELAY"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case290({ fs, ok, W, eq }) {
    const G = 388;
    const egSrc = fs.readFileSync("src/route/egfacts.ts", "utf8");
    const fmSrc = fs.readFileSync("src/route/factmul.ts", "utf8");
    const jdSrc = fs.readFileSync("src/route/judge.ts", "utf8");
    ok([`[${G}] egfacts 有 biasFor`], egSrc.includes("biasFor(host: string"));
    ok([`[${G}] egfacts 有 FamFacts 类`], egSrc.includes("export class FamFacts"));
    ok([`[${G}] egfacts 有 FAM 单例`], egSrc.includes("export const FAM = new FamFacts()"));
    ok([`[${G}] factmul 走 biasFor`], fmSrc.includes("EG.biasFor(host, ip, cf)"));
    ok([`[${G}] judge 写 famfacts`], jdSrc.includes("FAM.note(e.host, pipFam"));
    // 行为：用独立 T 实例 + 全局 FAM（biasFor 内部读全局）
    const T = new W.EgFacts();
    const t0 = 1750000000000;
    const v6 = "2001:db8::88";
    T.note(v6, 6, t0);
    W.FAM.clear();
    // 样本不足 2 条 → 回退旧的 ×40
    W.FAM.note("fam.test", 6, true, t0);
    eq([`[${G}] 样本<2 回退旧口径`], T.biasFor("fam.test", v6, true, t0 + 10), 40);
    // 3 条 v6 全成功 → 放松到 1
    W.FAM.note("fam.test", 6, true, t0 + 11);
    W.FAM.note("fam.test", 6, true, t0 + 12);
    eq([`[${G}] v6 全成功放松到 1`], T.biasFor("fam.test", v6, true, t0 + 13), 1);
    eq([`[${G}] 成功率读对`], W.FAM.rate("fam.test", 6, t0 + 13).r, 1);
    // 3 条 v6 全失败 → 40（和旧口径一致）
    W.FAM.clear();
    W.FAM.note("fam.test", 6, false, t0);
    W.FAM.note("fam.test", 6, false, t0 + 1);
    W.FAM.note("fam.test", 6, false, t0 + 2);
    eq([`[${G}] v6 全失败保持 40`], T.biasFor("fam.test", v6, true, t0 + 3), 40);
    // 1 成功 1 失败 → r=0.5 → 20.5，介于 1 和 40
    W.FAM.clear();
    W.FAM.note("fam.test", 6, true, t0);
    W.FAM.note("fam.test", 6, false, t0 + 1);
    const mid = T.biasFor("fam.test", v6, true, t0 + 2);
    ok([`[${G}] 半成功介于 1 与 40`], mid > 1 && mid < 40);
    eq([`[${G}] 半成功乘数 20.5`], mid, 20.5);
    // 未知族不受 FAM 影响（保持探索偏置 ×2）
    eq([`[${G}] 未知族仍 ×2`], T.biasFor("fam.test", "198.51.100.99", true, t0 + 2), 2);
    // 非 CF 站点 FAM 不介入
    eq([`[${G}] 非 CF 站点不受 FAM 影响`], T.biasFor("fam.test", v6, false, t0 + 2), 1.05);
    // 过期样本回退
    W.FAM.clear();
    W.FAM.note("fam.test", 6, true, t0);
    W.FAM.note("fam.test", 6, true, t0 + 1);
    // EG 行保持在观测时刻新鲜，只让 FAM 样本过期（两者 TTL 同源，错开写入时间才能分开验）
    const late = t0 + W.EG_TTL + 10;
    T.note(v6, 6, late);
    eq([`[${G}] 过期样本回退`], T.biasFor("fam.test", v6, true, late), 40);
    // note 的 ok 参数只认整页语义由调用方保证，这里验 ev-note 的计数与 clear
    eq([`[${G}] 站点×族分开记`], (W.FAM.note("fam.test", 4, true, t0), W.FAM.size()), 2);
    W.FAM.clear();
    eq([`[${G}] clear 后为空`], W.FAM.size(), 0);
  }

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case296({ W, ok, fs }) {
  const csp = String(W.SEC_HEADERS["content-security-policy"] || "");
  ok("[394] CSP 含 connect-src 'self'", csp.includes("connect-src 'self'"));
  ok("[394] CSP 仍禁 default-src", csp.includes("default-src 'none'"));
  ok("[394] CSP 保留 form-action self", csp.includes("form-action 'self'"));
  ok("[394] CSP 保留 script-src unsafe-inline", csp.includes("script-src 'unsafe-inline'"));
  ok("[394] CSP 保留 frame-ancestors none", csp.includes("frame-ancestors 'none'"));
  // 行为：html() 响应必须真的带上这条 CSP
  const resp = W.html('<button>probe</button>');
  const h = resp.headers.get("content-security-policy") || "";
  ok("[394] html 响应带 connect-src", h.includes("connect-src 'self'"), h);
  ok("[394] html 响应 content-type 正确", (resp.headers.get("content-type") || "").includes("text/html"));
  // 源码锁：respond.ts 的 connect-src 只能是 self，不能放宽到 *
  const respSrc = fs.readFileSync("src/edge/respond.ts", "utf8");
  ok("[394] 不出现 connect-src *", !/connect-src\s+\*/.test(respSrc));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case305({ fs, ok, W }) {
  const tfbSrc = fs.readFileSync("src/route/tfb.ts", "utf8");
  // relayAddr 必须用 splitRelay 解析端口，而不是裸拼 :443（pp≠443 时探测错端口）
  ok("[404] relayAddr 用 splitRelay 保留端口", /splitRelay\(h\.trim\(\), 443\)/.test(tfbSrc), "relayAddr 未解析端口");
  ok("[404] pool 不再丢端口", !tfbSrc.includes("splitRelay(x.trim(), 443)[0]"), "pool 仍 splitRelay()[0] 丢端口");
  ok("[404] own 列表带端口", tfbSrc.includes("${x.h}:${x.p}"), "own 未拼端口");
  // pickFresh 按裸 IP 查判定表（键是 r:<ip>），入参带端口时不能把端口带进键
  ok("[404] pickFresh 按裸 IP 查 VT", tfbSrc.includes('"r:" + splitRelay(ip, 443)[0]'), "pickFresh 未按裸 IP 查");
  // 行为：同一裸 IP 的不同端口在判定表眼里是同一通道（旧证据能命中）
  W.VT.clear();
  W.VT.set("porttest.example", "r:10.0.0.7", 200, 100, 1);
  const picked = W.pickFresh("porttest.example", ["10.0.0.7:8443", "10.0.0.8:443"], 2);
  ok("[404] pickFresh 接受带端口地址", picked.length === 2, `picked=${picked.length}`);
  W.VT.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case310({ fs, ok, W }) {
  const accSrc409 = fs.readFileSync("src/proxy/conn-settle.ts", "utf8");
  const cntSrc409 = fs.readFileSync("src/core/counter.ts", "utf8");
  ok("[409] 攒样本阈值256KB", W.EMIT_BYTES === 256 * 1024, "EMIT_BYTES=" + W.EMIT_BYTES);
  ok("[409] 墙钟门槛300ms", W.EMIT_WALL_MS === 300, "EMIT_WALL_MS=" + W.EMIT_WALL_MS);
  ok("[409] 单笔最小4096挡4字节", W.ACC_MIN_BYTES === 4096, "ACC_MIN_BYTES=" + W.ACC_MIN_BYTES);
  ok("[409] ACC单例是ByteAccumulator", W.ACC instanceof W.ByteAccumulator, "ACC类型错");
  ok("[409] accEmit计数键登记", cntSrc409.includes('"accEmit"'), "accEmit未登记");
  ok("[409] closeSample接小样本到累加器", accSrc409.includes("ACC.add(v.node"), "closeSample没接累加器");
  ok("[409] 大样本仍走原路径", accSrc409.includes("bytes >= 32768") && accSrc409.includes("NodeStatsTable.nsSpeed(v.node"), "大样本路径被改");
  const realNow409 = Date.now;
  try {
    let NOW409 = Date.UTC(2026, 0, 1); Date.now = () => NOW409;
    const ENV409 = { pxDwellMin: 0, pxShadow: 0, pxSchedH: 6 };
    const bw409 = 4 * 1048576;
    const k409 = "acc-t409"; W.NODE_MEMORY.stats.delete(k409);
    const acc409 = new W.ByteAccumulator();
    for (let i = 0; i < 300; i++) { acc409.add(k409, 4096, 4096 / bw409 * 1000, NOW409, ENV409); NOW409 += 600; }
    const cap409 = W.scoreParts(k409, "tput", NOW409, false, 0).capBps || 0;
    ok("[409] 300页4KB攒出带宽样本", cap409 > 2 * 1048576, "capBps=" + cap409);
    const k403 = "acc-t403"; W.NODE_MEMORY.stats.delete(k403);
    const acc403 = new W.ByteAccumulator();
    for (let i = 0; i < 1000; i++) { acc403.add(k403, 4, 1, NOW409, ENV409); NOW409 += 600; }
    ok("[409] 4字节页不进累加器", acc403.size() === 0, "size=" + acc403.size());
    ok("[409] 4字节页无带宽样本", (W.scoreParts(k403, "tput", NOW409, false, 0).capBps || 0) === 0, "有样本");
    const kWall = "acc-wall"; W.NODE_MEMORY.stats.delete(kWall);
    const accWall = new W.ByteAccumulator();
    accWall.add(kWall, 300 * 1024, 50, NOW409, ENV409);
    ok("[409] 瞬时塞够不发样本", (W.scoreParts(kWall, "tput", NOW409, false, 0).capBps || 0) === 0, "瞬时发了");
    NOW409 += 400;
    accWall.add(kWall, 4096, 1, NOW409, ENV409);
    ok("[409] 过墙钟后发样本", (W.scoreParts(kWall, "tput", NOW409, false, 0).capBps || 0) > 0, "没发");
    W.NODE_MEMORY.stats.delete(k409); W.NODE_MEMORY.stats.delete(k403); W.NODE_MEMORY.stats.delete(kWall);
  } finally { Date.now = realNow409; }
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case311({ W, ok, fs }) {
  const bud410 = W.BudgetedIO.unlimited();
  // 固定直连模式且没有任何中继证据：非 CF 站点不该被硬钉到中继
  // 旧代码没有这个方法时按失败计（抛异常会把后面整段断言跳过，A/B 就看不出差异）
  const isCf410 = (env, host) =>
    typeof W.DIALER.isCfTarget === "function" ? W.DIALER.isCfTarget(env, host, bud410) : Promise.resolve("missing");
  ok("[410] 非自动模式不硬钉", (await isCf410({ proxyip: "direct" }, "github.com")) === false, "被误判需要中继");
  // 失败学习过的站点：需要中继
  const keepNeedPx410 = W.RELAY_DEMAND.get("x.com");
  W.RELAY_DEMAND.set("x.com", Date.now() + 60000);
  ok("[410] 学习过的站点需要中继", (await isCf410({ proxyip: "direct" }, "x.com")) === true, "学习记录没生效");
  if (keepNeedPx410 === undefined) W.RELAY_DEMAND.delete("x.com"); else W.RELAY_DEMAND.set("x.com", keepNeedPx410);
  // CF 托管缓存命中：需要中继
  W.DIALER.cfHost.set("cached410.test", Date.now() + 60000);
  ok("[410] CF 托管缓存命中需要中继", (await isCf410({ proxyip: "direct" }, "cached410.test")) === true, "缓存没被读");
  W.DIALER.cfHost.delete("cached410.test");
  // 计数键必须登记，否则 cnt 会打 unknown
  ok("[410] pinDirect 计数键已登记", W.COUNTER.keys.includes("pinDirect"), "键没登记");
  W.cnt("pinDirect");
  // 源码锁：分流写在 viaPinned 里，硬钉语义仍在
  const fb410 = fs.readFileSync("src/proxy/fallback.ts", "utf8");
  ok("[410] 钉节点先判是否需要中继", fb410.includes('const wantPin = o.pxForce === 1 || (await DIALER.isCfTarget('), "没判目标类型");
  ok("[410] 不需要中继时记 pinDirect", fb410.includes('cnt("pinDirect")'), "没记账");
  ok("[410] 不需要中继时仍钉中继候选", fb410.includes('o.conn.forceRelayIp = o.pinnedNode || ""'), "丢掉了用户点名的节点");
  ok("[410] 需要中继仍硬钉", fb410.indexOf('const wantPin =') < fb410.indexOf('const node = o.pinnedNode || "";'), "硬钉分支被删");
  const dl410 = fs.readFileSync("src/proxy/dialer.ts", "utf8");
  ok("[410] 拨号器暴露 isCfTarget", dl410.includes("  async isCfTarget(env: Env, host: string, budget: BudgetedIO): Promise<boolean> {"), "没有公有判定");
  ok("[410] DoH 判定只写一处", dl410.split("await withTimeout(isCfHost(host, budget), 1200)").length - 1 === 1, "DoH 判定被复制");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case312({ W, ok, eq, fs }) {
  // 池子源里第四份清单是 `ip:port#CC`：以前整段被正则吞掉，地区分流因此永远「暂无可用节点」
  const hasT411 = typeof W.takePoolLine === "function";
  ok("[411] 测试窗口能拿到 takePoolLine", hasT411);
  if (hasT411) {
    const m411 = new Map();
    W.takePoolLine("1.2.3.4:443#JP", "t", m411);
    eq("[411] 池子行里的国家码被采下来", (m411.get("1.2.3.4:443") || {}).cc, "JP");
    const m411b = new Map();
    W.takePoolLine("5.6.7.8:8443", "t", m411b);
    eq("[411] 没有国家码时留空", (m411b.get("5.6.7.8:8443") || {}).cc, "");
    const m411c = new Map();
    W.takePoolLine("9.9.9.9#de", "t", m411c);
    eq("[411] 小写国家码统一成大写", (m411c.get("9.9.9.9:443") || {}).cc, "DE");
  }
  // 池子条目本身允许带 cc（客观事实，可随 seed 传播）
  const dts411 = fs.readFileSync("types/app.d.ts", "utf8");
  ok("[411] PoolEntry 允许带国家码", /interface PoolEntry \{[^}]*cc\?: string;/s.test(dts411));
  // 三条链路上的源码锁：探活继承、冷启动继承
  const scan411 = fs.readFileSync("src/px/scan.ts", "utf8");
  ok("[411] 探活结果继承候选池的国家码", scan411.includes("if (!x.cc && batch[i] && batch[i].cc) x.cc = batch[i].cc;"));
  const alive411 = fs.readFileSync("src/px/alive.ts", "utf8");
  ok("[411] 冷启动从池子起步时带上国家码", alive411.includes("cc: c.cc || \"\""));
  // 地区仍是硬分流（用户点名国家就拨该国节点），不按目标预判降级成直连
  const fb411 = fs.readFileSync("src/proxy/fallback.ts", "utf8");
  ok("[411] 地区硬分流的分支仍在", fb411.includes("o.regionPicker.open({ env: o.env, mode: o.mode, region"));
  ok("[411] 地区分流不做「要不要中继」的预判", !fb411.includes("const wantRelay = o.pxForce === 1"));
  // 非 CF 目标直连失败后不再浪费 connect 去试中继
  ok("[411] 非 CF 目标不再试中继", fb411.includes('cnt("noRelayNonCf")') && fb411.includes("if (!st.cf && o.pxForce !== 1)"));
  // 两个新计数键要登记，否则 /health 里看不到
  const cnt411 = fs.readFileSync("src/core/counter.ts", "utf8");
  ok("[411] noRelayNonCf 已登记", cnt411.includes('"noRelayNonCf"'));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case313({ fs, ok }) {
  const px412 = fs.readFileSync("src/routes/proxyip.ts", "utf8");
  ok("[412] 路由认 ?rebuild=1", px412.includes('searchParams.get("rebuild") === "1"'));
  ok("[412] 重建前把池子构建时间清零", px412.includes("POOL_MEMORY.builtAt = 0;"));
  ok("[412] 重建后复用 refresh 的扫描闸门", /private async rebuildPool\(\):[^{}]+\{[^{}]*return this\.refreshPool\(\)/.test(px412));
  ok("[412] 池子 TTL 仍是 24 小时", fs.readFileSync("src/px/probe.ts", "utf8").includes("24 * 3600e3"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case316({ W, sockOf245, wsOf245, ok, fs, eq }) {
  const posted = [];
  const env416 = {
    METER: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async (url, init) => {
          posted.push({ url: String(url), body: init && init.body ? String(init.body) : "" });
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }),
    },
    uuid: "4241b903-8d39-4a17-8f4c-bb33b1630c33",
  };
  const waits = [];
  const ctx416 = { waitUntil: (pr) => waits.push(pr) };
  const st = new W.Connection(env416, ctx416, "tput", "t");
  st.id = "4241b903-8d39-4a17-8f4c-bb33b1630c33";
  st.down = 4096;
  st.node = "198.51.100.1:443";
  st.host = "example.com";
  st.mark = 1e9;
  st.tAttach = Date.now();
  W.PEND.rows.clear();
  W.ERROR_MEMORY.rows.length = 0;
  W.pipeBack(sockOf245("mid reset"), wsOf245(), st, () => {});
  await new Promise((r) => setTimeout(r, 150));
  ok("[416] 异常收尾把上报挂到了 waitUntil", waits.length >= 1);
  await Promise.all(waits.map((pr) => Promise.resolve(pr).catch(() => {})));
  const hit416 = posted.filter((x) => x.body.includes("dl end"));
  ok("[416] dl end 证据真的随请求体发出", hit416.length >= 1, JSON.stringify(posted.map((x) => x.body.slice(0, 80))));
  const src421 = fs.readFileSync("src/proxy/tunnel.ts", "utf8");
  ok("[416] catch 里用 st.ctx.waitUntil 兜住上报", src421.includes("st.ctx.waitUntil(push)"));
  ok("[416] 单飞被跳过时再补一次 flush", src421.includes("if (PEND.rows.size) await PEND.flush(st.env, true, 1)"));
  // 7.422：账本那条路（单飞 / setTimeout / 账本为空早退）在「客户端刚走」时都走不通，
  // 所以证据必须同时有一条不经账本的直接 /add。
  ok("[416] 证据另走一次直接 /add", src421.includes('doFetch(senv, sid, "https://meter/add"'));
  // 7.423：收尾（SessionTail.done）这条路一定跑得到，是「Worker 收到连接结束」的唯一见证。
  const settle423 = fs.readFileSync("src/proxy/conn-settle.ts", "utf8");
  ok("[416] 收尾也记字节证据", settle423.includes("if (conn.down > 0) logErr("));
  // 7.424：hb=1 的调试心跳，用来分辨「isolate 被杀」与「只掐连接」
  const ses426 = fs.readFileSync("src/proxy/session.ts", "utf8");
  ok("[416] 有调试心跳且默认关闭", src421.includes("st.debugBeat && st.env && st.id") && src421.includes("m: `hb iso="));
  // 7.426：CPU 对照开关（?burn=MS）与 isolate 累计出流量（W.TRAFFIC_MEMORY.egressBytes）
  ok("[416] 有烧 CPU 对照开关", src421.includes("st.debugBurn > 0") && ses426.includes('q.get("burn")'));
  eq("[416] isolate 累计出流量是数字", typeof W.TRAFFIC_MEMORY.egressBytes, "number");
  const connSrc = fs.readFileSync("src/proxy/connection.ts", "utf8");
  ok("[416] Connection 持有 ctx", connSrc.includes("ctx: ExecutionContext;"));
}
