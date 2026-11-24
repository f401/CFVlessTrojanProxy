import { X_EDGE_IPS, edgeCount, loadNodes, nodeLabel, nodePath, orderNodes, pickProtos, REGION_SUB, trojanPasswordOf, renderLinks, renderSingbox } from "./sub-common";
import { probeUrlOf } from "../core/util";
import { splitRelay } from "../core/relay-addr";

// ---- 并入自 src\views\subview.ts ----
/** 订阅输出格式：Clash/Mihomo YAML、sing-box JSON、纯链接列表 */
export type SubKind = "clash" | "singbox" | "links";

interface SubViewIn {
  env: Env;
  url: URL;
  id: string;
  host: string;
  learned: Record<string, RttEntry>;
  regions: string[];
  auth: Auth;
}

/**
 * 订阅视图（P6-1）：把「同一份节点清单按不同客户端格式渲染」收成一个对象。
 * 三种格式共享入参，差别只在序列化方式，所以用一张分派表，而不是三处 if。
 */
export class SubscriptionView {
  /** 按格式渲染；未知格式回落到 clash（历史行为） */
  render(o: SubViewIn, kind: SubKind): string {
    const pick = this.table()[kind] || this.table().clash;
    return pick(o);
  }

  /**
   * 功能：私有：kind → 渲染函数的映射表（clash / singbox / links）。
   * @returns 映射表
   */
  private table(): Record<SubKind, (o: SubViewIn) => string> {
    return {
      clash: (o) => renderClash(o.env, o.url, o.id, o.host, o.learned, o.regions, o.auth),
      singbox: (o) => renderSingbox(o.env, o.url, o.id, o.host, o.learned, o.regions, o.auth),
      links: (o) => renderLinks(o.env, o.url, o.id, o.host, o.learned, o.regions, o.auth),
    };
  }
}


// ---- 门面（对外导出面保持不变） ----
export * from "./sub-common";
export { renderSingbox } from "./sub-common";
export { renderLinks } from "./sub-common";

/** YAML 双引号字符串：JSON 转义是 YAML 双引号标量的合法子集，引号/反斜杠/换行/制表符一起处理 */
const yamlStr = (s: string) => JSON.stringify(String(s));

/** 普通主机名/端口保持裸写；只有含特殊字符时才加引号（不改变现有订阅的字节） */
const yamlScalar = (s: string) => (/^[A-Za-z0-9._-]+$/.test(String(s)) ? String(s) : yamlStr(String(s)));

/**
 * 功能：渲染 mihomo/clash 配置（proxies、proxy-groups、rules）。
 * @param o 订阅输入
 * @returns YAML 字符串
 */
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
  // 入口 IP 只用内置种子：入口质量（用户 → 边缘）只能由客户端实测，服务端测不了
  // （Worker 打自家域名必 522 自环），所以这里不再读什么"实测排名"。
  const noEdge = Boolean(manual) || url.searchParams.get("e") === "0";
  // 通道实测组可以单独关掉（?r=0，历史参数名）；中继块已删除，这个开关现在只影响 G_TU。
  // 关掉之后模式组只剩入口/节点/域名三层，重复请求数也最少。
  const noRelay = url.searchParams.get("r") === "0";
  // 通道实测：客户端对该 URL 逐条中继做 url-test（expected-status 200），把「哪条中继真能打通」
  // 变成端到端实测，而不是服务端靠流量推断（Worker 请求路径跑不动 userland TLS）。
  const tuRaw = url.searchParams.get("tu") || "";
  const tuUrl = /^https:\/\/[^\s"]+$/.test(tuRaw) ? tuRaw : "";
  const edgeIps: string[] = noEdge ? [] : X_EDGE_IPS.slice(0, edgeCount(url));
  const nodes = orderNodes(loadNodes(env, host), learned);
  const pass = trojanPasswordOf(env, id, auth);
  const protos = pickProtos(env, url, Boolean(pass));
  // 默认 url-test 探测目标：gstatic 对 v6 出口也回 204 会误判，改用会拒 v6 的 CF 站点。
  // ?pu=<https-url> 可覆盖，不把单一站点写死。
  const probeUrl = probeUrlOf(url);
  const out: string[] = [];
  const byMode: Record<string, string[]> = { lat: [], tput: [] };
  const all = [];
  const G_LAT = "\u26a1 \u901f\u7387\u4f18\u5148";
  const G_TPUT = "\ud83d\ude80 \u541e\u5410\u4f18\u5148";
  const G_REG = "\ud83c\udf0d \u5730\u533a";
  const G_PIN = "\ud83d\udccc \u81ea\u9009\u8282\u70b9";
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
        // 入口一律钉 IPv4：客户端在双栈网络上会把域名解析成 AAAA，
        // 而 CF→CF 会把客户端出口原样透传给目标（X 会直接回 4 字节 `IPv6` 的 403）。
        // 用 IP 字面量 + servername/Host 指回域名，TLS 与 WS 路由都不变。
        const vip = edgeIps.length ? String(edgeIps[byMode[mode].length % edgeIps.length]) : n.host;
        emit(
          name,
          proto,
          vip,
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

  // 域名入口（备用）：能解析到 AAAA 的网络上会走 IPv6，目标侧就是 403；
  // 只在用户手动切换时使用，默认组一律走上面的 IPv4 字面量条目。
  const domNames: string[] = [];
  if (edgeIps.length) {
    for (const mode of ["tput", "lat"]) {
      const suffix = mode === "lat" ? "L" : "T";
      for (const proto of protos) {
        if (proto === "trojan" && !pass) continue;
        const name = `d-${proto === "trojan" ? "TJ" : "VL"}${suffix}`;
        emit(name, proto, host, 443, `/?ed=2560&mode=${mode}`, true, "");
        domNames.push(name);
        all.push(name);
      }
    }
  }

  // 地区出口节点（强制走该国的中转），不分模式
  const regNames = [];
  for (const e of REGION_SUB.entries(regions, host, pass, protos, url, auth, id)) {
    emit(e.name, e.proto, e.server, e.port, e.path, true, "");
    regNames.push(e.name);
    all.push(e.name);
  }

  // 面板勾选的具体节点：单独成组（只进手动组，不进默认选路），节点名带 📌 便于区分
  const pinNames: string[] = [];
  const me = auth && auth.list ? auth.list.find((u) => u.id === id) : undefined;
  for (const raw of me?.pinnedNodes || []) {
    const [ph, pp] = splitRelay(String(raw), 443);
    if (!ph || pp <= 0) continue;
    for (const proto of protos) {
      if (proto === "trojan" && !pass) continue;
      const name = `📌${ph}-${proto === "trojan" ? "TJ" : "VL"}`;
      // server 必须是 CF 边缘入口，不能是中继 IP：中继上面没有 Worker 的 WS/TLS 监听，
      // 客户端 wss 到它必超时（面板探测走 DO→中继，跟客户端入口无关，所以探测 200 也证明不了这条能连）。
      // node= 只作为服务端选路参数硬钉这条中继；入口沿用钉 v4 的边缘 IP，避免双栈回落 v6。
      const vip = edgeIps.length ? String(edgeIps[pinNames.length % edgeIps.length]) : host;
      emit(name, proto, vip, 443, `/?ed=2560&node=${encodeURIComponent(`${ph}:${pp}`)}`, true, "面板自选");
      pinNames.push(name);
      all.push(name);
    }
  }

  const q = (arr: string[]) => `    proxies: [${arr.map((x) => `"${x}"`).join(", ")}]`;
  const pick = (arr: string[], n: number) => arr.slice(0, Math.max(1, Math.min(n, arr.length)));
  // 目标实测组（?tu=）的成员只能是「按中继走」的条目，两个理由：
  //   ① 只有把中继那一跳包含进来，测出来的才是「这条中继的出口族能不能过这个站」；
  //      入口/节点条目走的是 CF 自己的出口，测它等于测 CF，和 ?tu= 想回答的问题无关。
  //   ② 成员数就是真实请求数：客户端每隔 interval 秒对目标站发「成员数」条 HTTPS。
  //      上限取 10 —— v8 §7 的结论是「10 成员 + 连测 2 次 = 97.4%」，再往上只是拿
  //      目标站的限流换一点点精度。
  //   ③ 中继组删除后成员退化成前 10 个入口/节点条目 —— 至少还能回答
  //      「哪条入口能过这个站」；?r=0 明确要求关通道实测，就不生成了。
  const tuMembers = noRelay ? [] : pick(all, 10);

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
  const G_DOM = "📛 域名入口";
  const G_TU = "📡 通道实测";
  if (domNames.length) {
    groups.push(`  - name: "${G_DOM}"`);
    groups.push(`    type: select`);
    groups.push(q(domNames));
  }
  // 模式组的成员顺序就是客户端的选择顺序：① 先信「端到端实测能过这个站点」的通道（只有 ?tu= 才有）；
  // ② 再入口优选；③ 然后是具体节点；④ 最后拿域名入口兜底 —— 8 个钉住的 v4 边缘
  // 全不通时，用户至少还能走域名。url-test 只在这些成员之间测速，顺序本身表达的是可信度。
  groups.push(`  - name: "${G_TPUT}"`);
  groups.push(`    type: url-test`);
  groups.push(`    url: ${probeUrl}`);
  // expected-status 必须写：url-test 默认「拿到任意 HTTP 响应就算通」，
  // v6 出口打 CF 站拿到的是 737B 403，不写这条会被当可用、测速快就选中 → 用户仍看到 IPv6 拒绝页。
  groups.push(`    expected-status: 200`);
  groups.push(`    interval: 300`);
  groups.push(`    tolerance: 30`);
  groups.push(`    lazy: false`);
  groups.push(
    q([
      ...(tuUrl && tuMembers.length ? [G_TU] : []),
      ...(edgeNames.length ? [G_EDGE] : []),
      ...pick(byMode.tput, 5),
      ...(domNames.length ? [G_DOM] : []),
    ]),
  );

  groups.push(`  - name: "${G_LAT}"`);
  groups.push(`    type: url-test`);
  groups.push(`    url: ${probeUrl}`);
  groups.push(`    expected-status: 200`);
  groups.push(`    interval: 300`);
  groups.push(`    tolerance: 30`);
  groups.push(`    lazy: false`);
  groups.push(
    q([
      ...(tuUrl && tuMembers.length ? [G_TU] : []),
      ...(edgeNames.length ? [G_EDGE] : []),
      ...pick(byMode.lat, 5),
      ...(domNames.length ? [G_DOM] : []),
    ]),
  );

  if (regNames.length) {
    groups.push(`  - name: "${G_REG}"`);
    groups.push(`    type: select`);
    groups.push(q(regNames));
  }
  if (pinNames.length) {
    groups.push(`  - name: "${G_PIN}"`);
    groups.push(`    type: select`);
    groups.push(q(pinNames));
  }


  // 通道实测组：成员是「按中继走」的节点条目，客户端对 tu 指定的 URL 逐条实测，
  // 只有真能打通（expected-status 200）的通道才算健康 —— 端到端证据，零服务端开销。
  if (tuUrl && tuMembers.length) {
    groups.push(`  - name: "${G_TU}"`);
    groups.push("    type: url-test");
    groups.push(`    url: ${tuUrl}`);
    groups.push("    expected-status: 200");
    groups.push("    interval: 180");
    groups.push("    tolerance: 0");
    groups.push("    lazy: false");
    groups.push(q(tuMembers));
  }

  groups.push(`  - name: "${G_MAN}"`);
  groups.push(`    type: select`);
  groups.push(
    `    proxies: ["${G_TPUT}", "${G_LAT}"${domNames.length ? `, "${G_DOM}"` : ""}${edgeNames.length ? `, "${G_EDGE}"` : ""}${regNames.length ? `, "${G_REG}"` : ""}${pinNames.length ? `, "${G_PIN}"` : ""}${tuUrl && tuMembers.length ? `, "${G_TU}"` : ""}, ${all.map((x) => `"${x}"`).join(", ")}, "DIRECT"]`,
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
    // MATCH 必须指向手动组，否则 📌 自选节点 / 🎯 手动 这两个 select 组没有任何规则引用，
    // 用户在 UI 里选了自选节点也不生效（流量仍被 MATCH 送进 url-test 组）。
    // 手动组第一个成员是吞吐优先组，Clash select 默认选第一个 ⇒ 老用户行为完全不变，
    // 只是多了一个可切换的入口。
    `  - MATCH,${G_MAN}`,
  ].join("\n");
}

