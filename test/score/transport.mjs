/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case187({ W, ok, eq, dialerSrc269 }) {
  const host269 = "dialer269.test";
  // 走到重拨循环需要三个前置条件：池子有条目（relays() 冷启动回退名单）、
  // 直连被判死（否则判定层直接返回 direct、整段跳过）、以及能记录调用次数的 SEL.current。
  W.POOL_MEMORY.rows = [{ k: "a", h: "1.1.1.1", p: 443 }, { k: "b", h: "1.1.1.1", p: 8443 }];
  W.VT.setState(host269, "d", 2, 1);
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
  ok("cntKeys 登记了 badRelay", W.COUNTER.keys.includes("badRelay"), "badRelay");
  ok("dialer 对非法候选是 continue 而不是 break", dialerSrc269.includes("cnt(\"badRelay\");") && dialerSrc269.includes("continue;"), "continue");
  ok("dialer 不再把 checkTarget 和解析失败并成一次 break", !dialerSrc269.includes("checkTarget(p.host, p.port)) break;"), "无合并 break");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case236({ debugAll, eq, W, ok }) {
  // ═══ 第 325 组：diag 的六段细节各自成方法（7.325）═══
  const nets = debugAll();
  const clsSrc = nets.slice(nets.indexOf("export class DebugDiag {")).replace(/\r\n/g, "\n");
  const body = (name) => {
    const re = new RegExp("\\n  (private )?(async )?" + name + "\\(");
    const m = clsSrc.match(re);
    if (!m) return "";
    const head2 = m.index;
    const lines2 = clsSrc.split("\n");
    const from = clsSrc.slice(0, head2).split("\n").length - 1;
    for (let i = from; i < lines2.length; i++) {
      if (lines2[i] === "  }") return lines2.slice(from, i + 1).join("\n");
    }
    return clsSrc.slice(head2);
  };
  const dg = body("diag");
  eq("[325] 六段细节各自成方法", ["hostOf", "sampleRows", "probeTops", "pickBasis", "cfFacts", "relayBlocked", "doRing"].filter((n) => typeof W.DEBUG.nets.diagRunner[n] === "function").length, 7);
  ok("[325] diag 只做编排（≤45 行）", dg.split("\n").length <= 45, dg.split("\n").length);
  eq("[325] diag 里恰好七处 this. 委托", (dg.match(/this\.[a-zA-Z]+\(/g) || []).length, 7);
  ok("[325] diag 不再自己拨号 / 扫判定表", !dg.includes("probeSni(") && !dg.includes("resolveV4All(") && !dg.includes("VT.all()") && !dg.includes("https://meter/vt"));
  ok("[325] 取样本走站点画像并按样本数排序", body("sampleRows").includes("HOSTS.nodes.get(fam)") && body("sampleRows").includes(".sort("));
  ok("[325] 探活只传三个参数（第三个是 SNI，不是 port）", body("probeTops").includes("probeSni(a.h, a.p, host)") && !body("probeTops").includes("a.p, a.p"));
  ok("[325] 有样本就用样本、没有才用主动探测", body("pickBasis").includes("if (rows.length || !probe)") && clsSrc.includes('label: "主动探测"'));
  ok("[325] CF 事实带 4 秒上限并写回会话缓存", body("cfFacts").includes("httpProbe(host, 4000)") && body("cfFacts").includes("CF_HTTP.cache.set("));
  ok("[325] 判定表只列中继通道且算剩余秒数", body("relayBlocked").includes('v.channel.startsWith("r:")') && body("relayBlocked").includes("VT_TTL_MS"));
  ok("[325] DO 封锁环读 blk2 且只在 &do=1 时读", body("doRing").includes('!== "1"') && body("doRing").includes("https://meter/vt") && body("doRing").includes("blk2"));
  const pctx = { request: new Request("https://x.test/"), url: new URL("https://x.test/" + "u/debug"), env: {}, id: "u", exec: { waitUntil() {}, passThroughOnException() {} } };
  eq("[325] 没有 ?diag= 时让给后面的分支", await W.DEBUG.nets.diagRunner.diag(pctx, new URL("https://x.test/u/debug?probe=1")), null);
  const badHost = await W.DEBUG.nets.diagRunner.diag(pctx, new URL("https://x.test/u/debug?diag=bad_host!"));
  eq("[325] 站点名形状不对时直接报错", (await badHost.json()).ok, false);
}
