// v8 订阅结构原型（只做实验，不进 src/）：node tools/exp-subv8.mjs
// 目的：把「🅰 模式 → fallback(入口竞速 → 中继竞速 → 域名入口)」渲染出来并断言，
//       验证开关组合下不会出现「模式组里混进别的模式」「组内成员不存在」这类问题。

const HOST = "nanlianqing.ccwu.cc";
const UUID = "00000000-0000-0000-0000-000000000000";
const PWD = "test-password";
const EDGE_IPS = [
  "104.18.32.1", "172.66.0.96", "162.159.140.98", "104.26.0.1",
  "172.67.179.231", "104.21.35.216", "162.159.141.2", "104.16.0.1",
  "172.64.0.1", "104.17.0.1", "162.159.0.1", "172.65.0.1",
  "104.19.0.1", "172.68.0.1", "162.159.1.1", "104.20.0.1",
];
const RELAYS = [
  "45.136.117.194", "45.147.250.39", "45.151.183.22",
  "91.215.153.143", "91.215.154.80", "193.181.211.185",
  "185.253.117.147", "89.22.227.132",
];
const MODES = [["tput", "🚀 吞吐优先"], ["lat", "⚡ 速率优先"]];
const PORT = 443;
const PATH = "/?ed=2560";

/** 一条 VLESS/Trojan 代理条目 */
function mkProxy({ name, mode, proto, server, query }) {
  const path = `${PATH}&ip=${query}&mode=${mode}`;
  const ws = { path, headers: { Host: HOST } };
  if (proto === "vless") {
    return {
      name, type: "vless", server, port: PORT, uuid: UUID, tls: true, servername: HOST,
      network: "ws", "ws-opts": ws, "ip-version": "ipv4", udp: true,
    };
  }
  return {
    name, type: "trojan", server, port: PORT, password: PWD, sni: HOST, tls: true,
    network: "ws", "ws-opts": ws, "ip-version": "ipv4", udp: true,
  };
}

/**
 * 渲染订阅。
 * @param {object} o { e?:0, r?:0, ei?:number, p?:'vless'|'tj'|'both', tu?:string, full?:0|1, modes?:string[] }
 */
export function render(o = {}) {
  const budget = o.full ? 60 : 36;
  const protos = o.p === "both" ? ["vless", "tj"] : o.p === "tj" ? ["tj"] : ["vless"];
  const modes = o.modes ?? MODES.map(([m]) => m);
  const withE = o.e !== 0;
  const withR = o.r !== 0;

  // 预算分配：每个模式要留 1 条域名回退，其余按 入口 : 中继 = 8 : 6 分
  const perMode = Math.floor((budget - modes.length) / modes.length);
  const unit = protos.length;                             // 每个 (模式, 协议) 一组条目
  const slots = Math.floor(perMode / unit) - 1;           // 减去域名回退那 1 条
  const eiWant = Math.max(0, Math.min(16, o.ei ?? (o.full ? 16 : 8)));
  let ei = withE ? Math.max(0, Math.min(eiWant, slots - (withR ? 3 : 0))) : 0;
  let rn = withR ? Math.min(6, Math.max(0, slots - ei)) : 0;
  if (!withE) { ei = 0; rn = withR ? Math.min(6, slots) : 0; }

  const proxies = [];
  const entryNames = [];
  const relayNames = [];
  const domainNames = [];
  const tuNames = [];

  for (const [mode] of MODES.filter(([m]) => modes.includes(m))) {
    for (const proto of protos) {
      const tag = proto === "vless" ? "VL" : "TJ";
      const sfx = tag + mode[0].toUpperCase();
      // ① 入口竞速：同一个域名，多个边缘 IPv4（客户端自己挑最快的）
      for (let i = 0; i < ei; i++) {
        const name = `e-${EDGE_IPS[i]}-${sfx}`;
        entryNames.push(name);
        proxies.push(mkProxy({ name, mode, proto, server: EDGE_IPS[i], query: "edge" }));
      }
      // ② 中继竞速：钉住某条中继（服务端 ?rx=），吞吐模式才有意义
      for (const ip of RELAYS.slice(0, rn)) {
        const name = `r-${ip}-${sfx}`;
        relayNames.push(name);
        proxies.push(mkProxy({ name, mode, proto, server: EDGE_IPS[relayNames.length % EDGE_IPS.length], query: `relay&px=1&rx=${ip}` }));
      }
      // ③ 域名入口：双栈网络的回退（可能走 v6），每个模式至少要有一条
      if (domainNames.length === 0 || !domainNames[domainNames.length - 1].endsWith(mode.toUpperCase())) {
        const name = `d-${sfx}`;
        domainNames.push(name);
        proxies.push(mkProxy({ name, mode, proto, server: HOST, query: "domain" }));
      }
      // ④ 目标实测：只有显式给 ?tu= 才发，健康检查 URL 用真站点
      if (o.tu) {
        const name = `t-${sfx}`;
        tuNames.push(name);
        proxies.push(mkProxy({ name, mode, proto, server: EDGE_IPS[0], query: "target" }));
      }
    }
  }

  const ut = (name, members, url) => ({
    name, type: "url-test", proxies: members, url, interval: 180, tolerance: 50,
    lazy: false, "expected-status": 200,
  });

  const suffixOf = (mode) => " " + mode;                  // 组名后缀用原始模式名，避免大小写歧义
  const groups = [];
  for (const [mode, label] of MODES.filter(([m]) => modes.includes(m))) {
    const sfx = suffixOf(mode);
    const up = mode[0].toUpperCase();
    const eNames = proxies.filter((p) => p.name.startsWith("e-") && p.name.endsWith(up)).map((p) => p.name);
    const rNames = proxies.filter((p) => p.name.startsWith("r-") && p.name.endsWith(up)).map((p) => p.name);
    const tNames = proxies.filter((p) => p.name.startsWith("t-") && p.name.endsWith(up)).map((p) => p.name);
    const dNames = proxies.filter((p) => p.name.startsWith("d-") && p.name.endsWith(up)).map((p) => p.name);
    // 组内只放「组名」，不放对象 —— mihomo 的 proxies 是名字列表
    const chain = [];
    if (tNames.length) { chain.push("📡 目标实测" + sfx); groups.push(ut("📡 目标实测" + sfx, tNames, o.tu)); }
    if (eNames.length) { chain.push("🌐 入口竞速" + sfx); groups.push(ut("🌐 入口竞速" + sfx, eNames, `https://${HOST}/health`)); }
    if (rNames.length) { chain.push("🔁 中继竞速" + sfx); groups.push(ut("🔁 中继竞速" + sfx, rNames, `https://${HOST}/health`)); }
    chain.push("📛 域名入口" + sfx);
    groups.push({ name: "📛 域名入口" + sfx, type: "select", proxies: dNames });
    groups.push({ name: label, type: "fallback", proxies: chain });
  }
  groups.push({ name: "🅰 模式", type: "select", proxies: MODES.filter(([m]) => modes.includes(m)).map(([, l]) => l) });
  groups.push({ name: "🎯 手动", type: "select", proxies: proxies.map((p) => p.name) });

  return { proxies, groups, ei, rn };
}

// ─── 断言 ────────────────────────────────────────────────────────────────────
function check(o, label) {
  const { proxies, groups } = render(o);
  const names = new Set(proxies.map((p) => p.name));
  const gnames = new Set(groups.map((g) => g.name));
  const errs = [];
  const E = (cond, msg) => { if (!cond) errs.push(msg); };

  // 1) 所有组成员必须存在（组名或条目名）
  for (const g of groups) {
    for (const m of g.proxies) E(names.has(m) || gnames.has(m), `组「${g.name}」的成员不存在：${m}`);
  }
  // 2) 模式组是 fallback，顺序 = 目标实测 → 入口 → 中继 → 域名
  for (const [mode, label] of MODES) {
    if (o.modes && !o.modes.includes(mode)) continue;
    const want = [];
    if (o.tu) want.push("📡 目标实测 " + mode);
    if (o.e !== 0) want.push("🌐 入口竞速 " + mode);
    if (o.r !== 0) want.push("🔁 中继竞速 " + mode);
    want.push("📛 域名入口 " + mode);
    const g = groups.find((x) => x.name === label);
    E(!!g, `缺「${label}」组`);
    if (!g) continue;
    E(g.type === "fallback", "模式组必须是 fallback（客户端按顺序试）");
    E(JSON.stringify(g.proxies) === JSON.stringify(want), `组序不对：${g.proxies.join(" > ")}`);
  }
  // 3) url-test 组必须有 url / expected-status / interval / tolerance / lazy:false
  for (const g of groups.filter((x) => x.type === "url-test")) {
    for (const k of ["url", "expected-status", "interval", "tolerance"]) E(g[k] !== undefined, `url-test 组「${g.name}」缺 ${k}`);
    E(g.lazy === false, `url-test 组「${g.name}」必须 lazy:false`);
    E(g.proxies.length >= 1, `url-test 组「${g.name}」没有成员`);
  }
  // 4) 条目合规
  for (const p of proxies) {
    E(p.port !== 80, `条目「${p.name}」用了 80 端口（服务端 checkTarget 直接拒）`);
    E(p["ip-version"] === "ipv4", `条目「${p.name}」缺 ip-version: ipv4`);
    E((p.servername || p.sni) === HOST, `条目「${p.name}」SNI 不是域名`);
    E(String(p["ws-opts"].path).includes("ed=2560"), `条目「${p.name}」缺 ed=2560`);
    if (p.name.startsWith("r-")) E(p["ws-opts"].path.includes("rx="), `中继条目「${p.name}」缺 rx=`);
    if (p.name.startsWith("e-")) E(/^\d+\.\d+\.\d+\.\d+$/.test(p.server), `入口条目「${p.name}」server 必须是 IPv4 字面量`);
    if (p.name.startsWith("d-")) E(p.server === HOST, `域名条目「${p.name}」server 应为域名`);
  }
  // 5) 名称唯一 + 预算
  E(names.size === proxies.length, "条目名重复");
  E(groups.length === new Set(groups.map((g) => g.name)).size, "组名重复");
  E(proxies.length <= (o.full ? 60 : 36), `条目数 ${proxies.length} 超预算 ${o.full ? 60 : 36}`);
  // 6) 协议过滤
  const wantType = o.p === "tj" ? "trojan" : o.p === "both" ? null : "vless";
  if (wantType) E(proxies.every((p) => p.type === wantType), `?p=${o.p ?? "vless"} 时仍有别的协议`);

  return { label, ok: errs.length === 0, n: proxies.length, g: groups.length, errs, ei: render(o).ei, rn: render(o).rn };
}

const cases = [
  [{}, "默认"],
  [{ e: 0 }, "?e=0"],
  [{ r: 0 }, "?r=0"],
  [{ e: 0, r: 0 }, "?e=0&r=0"],
  [{ ei: 16 }, "?ei=16"],
  [{ ei: 4 }, "?ei=4"],
  [{ p: "tj" }, "?p=tj"],
  [{ p: "both" }, "?p=both"],
  [{ tu: "https://x.com/" }, "?tu=x.com"],
  [{ tu: "https://x.com/", e: 0 }, "?tu + ?e=0"],
  [{ modes: ["lat"] }, "只发速率模式"],
  [{ full: 1 }, "?full=1"],
];

let bad = 0;
for (const [o, label] of cases) {
  const r = check(o, label);
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${label.padEnd(14)} 条目 ${String(r.n).padStart(3)} 组 ${r.g}  (ei=${r.ei} rn=${r.rn})`);
  for (const e of r.errs) { console.log("      -", e); bad++; }
}
console.log(bad ? `\n${bad} 处失败` : "\n全部通过");
if (bad) process.exit(1);
