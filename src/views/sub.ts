import { X_EDGE_IPS, loadNodes, nodeLabel, nodePath, orderNodes, pickProtos, regionEntries, trojanPasswordOf } from "./sub-common";
import { edgeRank } from "../route/edge";

export * from "./sub-common";
export { renderSingbox } from "./sub-singbox";
export { renderLinks } from "./sub-links";

/**
 * 生成 Clash / Mihomo 订阅 YAML。
 * @param {object} env Worker 环境
 * @param {URL} url 请求 URL
 * @param {string} id 用户 UUID
 * @param {string} host 入口域名
 * @param {object} [learned] RTT 学习结果
 * @param {string[]} [regions] 地区列表
 * @returns {string} YAML 文本
 */
/** YAML 双引号字符串：JSON 转义是 YAML 双引号标量的合法子集，引号/反斜杠/换行/制表符一起处理 */
const yamlStr = (s: string) => JSON.stringify(String(s));

/** 普通主机名/端口保持裸写；只有含特殊字符时才加引号（不改变现有订阅的字节） */
const yamlScalar = (s: string) => (/^[A-Za-z0-9._-]+$/.test(String(s)) ? String(s) : yamlStr(String(s)));

export function renderClash(
  env: Env,
  url: URL,
  id: string,
  host: string,
  learned: Record<string, RttEntry> = {},
  regions: string[] = [],
  auth?: Auth,
) {
  const manual = String(env.nodes || "").trim();
  // 服务端测不到「客户端 → 边缘」这条路径（Worker 访问自己的域名是 522 回环），
  // 所以入口偏好交给客户端的 url-test 组实测：这里只提供候选 CF 边缘 IP，
  // 有实测排名（edge:pref）时用它排序，否则用内置的 8 个种子 IP。
  const noEdge = Boolean(manual) || url.searchParams.get("e") === "0";
  // 通道实测：客户端对该 URL 逐条中继做 url-test（expected-status 200），把「哪条中继真能打通」
  // 变成端到端实测，而不是服务端靠流量推断（免费计划跑不动 TLS 客户端）。
  const tuRaw = url.searchParams.get("tu") || "";
  const tuUrl = /^https:\/\/[^\s"]+$/.test(tuRaw) ? tuRaw : "";
  const ranked = noEdge ? [] : edgeRank(8);
  const edgeIps: string[] = noEdge ? [] : ranked.length ? ranked : X_EDGE_IPS.slice(0, 8);
  const nodes = orderNodes(loadNodes(env, host), learned);
  const pass = trojanPasswordOf(env, id, auth);
  const protos = pickProtos(env, url, Boolean(pass));
  const out: string[] = [];
  const byMode: Record<string, string[]> = { lat: [], tput: [] };
  const all = [];
  const G_LAT = "\u26a1 \u901f\u7387\u4f18\u5148";
  const G_TPUT = "\ud83d\ude80 \u541e\u5410\u4f18\u5148";
  const G_REG = "\ud83c\udf0d \u5730\u533a";
  const G_MAN = "\ud83c\udfaf \u624b\u52a8";

  const emit = (
    name: string,
    proto: string,
    server: string,
    port: number,
    path: string,
    tls: boolean,
    extra: string,
  ) => {
    out.push(`  - name: ${yamlStr(name)}`);
    out.push(`    type: ${proto}`);
    out.push(`    server: ${yamlScalar(server)}`);
    out.push(`    port: ${port}`);
    out.push(`    ip-version: ipv4`);
    if (proto === "vless") out.push(`    uuid: ${id}`);
    else out.push(`    password: ${yamlStr(pass)}`);
    out.push(`    udp: false`);
    out.push(`    tls: ${tls ? "true" : "false"}`);
    if (tls) out.push(`    servername: ${yamlScalar(host)}`);
    out.push(`    network: ws`);
    out.push(`    ws-opts:`);
    out.push(`      path: ${yamlStr(path)}`);
    out.push(`      headers: { Host: ${yamlScalar(host)} }`);
    if (extra) out.push(`    # ${extra}`);
  };

  // 每个模式一份入口副本：模式是服务端行为，客户端只能靠 path 上的参数区分
  for (const mode of ["tput", "lat"]) {
    const suffix = mode === "lat" ? "L" : "T";
    for (const proto of protos) {
      for (const n of nodes) {
        if (proto === "trojan" && !pass) continue;
        const name = `${proto}-${nodeLabel(n)}-${suffix}`;
        emit(
          name,
          proto,
          n.host,
          n.port,
          `${nodePath(n)}&mode=${mode}`,
          n.tls,
          n._rtt != null ? `rtt ~${n._rtt}ms` : "",
        );
        byMode[mode].push(name);
        all.push(name);
      }
    }
  }

  // 钉在具体 CF 边缘 IP 上的入口条目（客户端用它们做「哪个边缘最快」的实测）
  const edgeNames: string[] = [];
  for (const mode of ["tput", "lat"]) {
    const suffix = mode === "lat" ? "L" : "T";
    for (const proto of protos) {
      if (proto === "trojan" && !pass) continue;
      for (const ip of edgeIps) {
        const name = `e-${ip}-${proto === "trojan" ? "TJ" : "VL"}${suffix}`;
        emit(name, proto, ip, 443, `/?ed=2560&ip=edge&mode=${mode}`, true, "");
        edgeNames.push(name);
        all.push(name);
      }
    }
  }

  // 地区出口节点（强制走该国的中转），不分模式
  const regNames = [];
  for (const e of regionEntries(regions, host, pass, protos, url)) {
    emit(e.name, e.proto, e.server, e.port, e.path, true, "");
    regNames.push(e.name);
    all.push(e.name);
  }

  const q = (arr: string[]) => `    proxies: [${arr.map((x) => `"${x}"`).join(", ")}]`;
  const pick = (arr: string[], n: number) => arr.slice(0, Math.max(1, Math.min(n, arr.length)));

  const G_EDGE = "\ud83c\udf10 \u5165\u53e3\u4f18\u9009";
  const groups = [];
  if (edgeNames.length) {
    groups.push(`  - name: "${G_EDGE}"`);
    groups.push(`    type: url-test`);
    groups.push(`    url: https://${host}/health`);
    groups.push(`    expected-status: 200`);
    groups.push(`    interval: 300`);
    groups.push(`    tolerance: 50`);
    groups.push(`    lazy: false`);
    groups.push(q(edgeNames));
  }
  groups.push(`  - name: "${G_TPUT}"`);
  groups.push(`    type: url-test`);
  groups.push(`    url: http://www.gstatic.com/generate_204`);
  groups.push(`    interval: 300`);
  groups.push(`    tolerance: 30`);
  groups.push(`    lazy: false`);
  groups.push(q(edgeNames.length ? [G_EDGE, ...pick(byMode.tput, 5)] : pick(byMode.tput, 5)));

  groups.push(`  - name: "${G_LAT}"`);
  groups.push(`    type: url-test`);
  groups.push(`    url: http://www.gstatic.com/generate_204`);
  groups.push(`    interval: 300`);
  groups.push(`    tolerance: 30`);
  groups.push(`    lazy: false`);
  groups.push(q(edgeNames.length ? [G_EDGE, ...pick(byMode.lat, 5)] : pick(byMode.lat, 5)));

  if (regNames.length) {
    groups.push(`  - name: "${G_REG}"`);
    groups.push(`    type: select`);
    groups.push(q(regNames));
  }


  const G_TU = "📡 通道实测";
  // 通道实测组：成员是「按中继走」的节点条目，客户端对 tu 指定的 URL 逐条实测，
  // 只有真能打通（expected-status 200）的通道才算健康 —— 端到端证据，零服务端开销。
  if (tuUrl && all.length) {
    groups.push(`  - name: "${G_TU}"`);
    groups.push("    type: url-test");
    groups.push(`    url: ${tuUrl}`);
    groups.push("    expected-status: 200");
    groups.push("    interval: 180");
    groups.push("    tolerance: 0");
    groups.push("    lazy: false");
    groups.push(q(pick(all, 64)));
  }

  groups.push(`  - name: "${G_MAN}"`);
  groups.push(`    type: select`);
  groups.push(
    `    proxies: ["${G_TPUT}", "${G_LAT}"${edgeNames.length ? `, "${G_EDGE}"` : ""}${regNames.length ? `, "${G_REG}"` : ""}${tuUrl && all.length ? `, "${G_TU}"` : ""}, ${all.map((x) => `"${x}"`).join(", ")}, "DIRECT"]`,
  );

  return [
    "port: 7890",
    "allow-lan: true",
    "mode: rule",
  "ipv6: false",
    "log-level: info",
    "unified-delay: true",
    "global-client-fingerprint: chrome",
    "dns:",
    "  enable: true",
    "  enhanced-mode: fake-ip",
    "  fake-ip-range: 198.18.0.1/16",
    "  nameserver: [223.5.5.5, 119.29.29.29]",
  "  ipv6: false",
    "",
    "proxies:",
    ...out,
    "",
    "proxy-groups:",
    ...groups,
    "",
    "rules:",
    "  - GEOIP,CN,DIRECT",
    `  - MATCH,${G_TPUT}`,
  ].join("\n");
}

