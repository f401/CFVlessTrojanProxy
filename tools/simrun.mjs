// 本地请求模拟器：不部署也能跑 /health、控制页、订阅、用量、调试端点。
// 用法：
//   node tools/simrun.mjs                     # 标准套件
//   node tools/simrun.mjs /health             # 单个路径
//   node tools/simrun.mjs "/<uuid>/debug?vt=example.com"
// 边界：KV/DO 是内存桩，验证的是「路由 + 序列化 + 判定逻辑」，
// 不验证 CF 运行时限制（CPU/子请求/1101/1102）与真实出口网络。
import mod from "../test/_bundle.mjs";

const UUID = process.env.SIM_UUID || "7c53c12a-88b1-4fda-b6e7-4da62e47a4e1";
const HOST = process.env.SIM_HOST || "sim.example.com";
const KEY = process.env.SIM_KEY || "";

const mem = new Map();
const kv = {
  async get(k) {
    return mem.has(k) ? mem.get(k) : null;
  },
  async put(k, v) {
    mem.set(k, v);
  },
  async delete(k) {
    mem.delete(k);
  },
  async list() {
    return { keys: [...mem.keys()].map((name) => ({ name })), list_complete: true };
  },
};

const env = {
  uuids: UUID,
  trojan: `${UUID}:test123`,
  nodes: process.env.SIM_NODES || "",
  adminKey: KEY,
  STATS: kv,
  defaultMode: "lat",
  regions: "",
  proxyip: "auto",
};

const mk = (path, headers = {}) => {
  const u = new URL(`https://${HOST}${path}`);
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    url: u.toString(),
    headers: { get: (k) => h[String(k).toLowerCase()] ?? null },
    cf: { asn: 4134, city: "Guangzhou", colo: "HKG", clientTcpRtt: 42 },
  };
};

const ctx = { waitUntil: () => {} };

async function run(path, headers = KEY ? { "X-Admin-Key": KEY } : {}) {
  const r = await mod.fetch(mk(path, headers), env, ctx);
  const body = await r.text();
  return { status: r.status, type: r.headers.get("content-type") || "", body };
}

function brief(res) {
  const b = res.body;
  if (res.type.includes("json")) {
    try {
      const j = JSON.parse(b);
      const keys = Object.keys(j);
      const pick = ["ok", "version", "uuids", "errors", "errsByKind", "host", "verdict", "escalate", "probed", "count", "n"];
      const shown = {};
      for (const k of pick) if (k in j) shown[k] = j[k];
      return `status=${res.status} json[${keys.length}] ${JSON.stringify(shown).slice(0, 400)}`;
    } catch {
      return `status=${res.status} json(坏) ${b.slice(0, 120)}`;
    }
  }
  const title = (b.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
  const proxies = (b.match(/^\s*- name: /gm) || []).length;
  return `status=${res.status} body=${b.length}B title="${title}" proxies=${proxies}`;
}

const full = process.argv.includes("--full");
const call = process.argv.slice(2).filter((x) => !x.startsWith("--"));
const suite = call.length
  ? call
  : [
      "/health",
      "/",
      `/${UUID}`,
      `/${UUID}/cl`,
      `/${UUID}/sb`,
      `/${UUID}/stats`,
      `/${UUID}/proxyip`,
      `/${UUID}/debug?vt=example.com`,
      `/${UUID}/logs`,
    ];

let bad = 0;
for (const p of suite) {
  try {
    const res = await run(p);
    if (res.status >= 500) bad++;
    console.log(`${p}\n  ${brief(res)}`);
  } catch (e) {
    bad++;
    console.log(`${p}\n  THROW ${String(e && e.message ? e.message : e).slice(0, 200)}`);
  }
}
console.log(`\n本地模拟结束：${suite.length} 个路径，5xx/异常 ${bad} 个`);
process.exit(bad ? 1 : 0);
