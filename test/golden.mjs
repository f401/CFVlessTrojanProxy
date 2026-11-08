// 契约基线：把"订阅输出 / 统计头 / 面板关键串"做成可逐字节比对的指纹。
// 用法：
//   node test/mk_test.mjs && node test/golden.mjs write   → 写 test/golden.json
//   node test/mk_test.mjs && node test/golden.mjs         → 与基线比对
import fs from "fs";
import crypto from "crypto";
import * as W from "./_bundle.mjs";

const file = new URL("./golden.json", import.meta.url);
const UUID = "7c53c12a-88b1-4fda-b6e7-4da62e47a4e1";

const env = {
  uuid: UUID,
  uuids: UUID + ",df1af8dd-3efe-407b-a5b6-4950afa4ac6f",
  pwd: "TjRYUOTxz1eBDxS2",
  adminKey: "#CKgF998244353",
  expireAt: "2099-12-31T00:00:00Z",
  quotaBytes: "0",
  nodes: [
    "edge-a.example.com:443:tls#HK|香港|HKG",
    "edge-b.example.com:443:tls#JP|日本|NRT",
    "edge-c.example.com:2053:tls#US|美国|LAX",
    "edge-d.example.com:8443:tls#SG|新加坡|SIN",
  ].join(","),
  regions: "HK,JP,US,SG",
  proxyip: "auto",
  defaultMode: "tput",
  pxShadow: "0.05",
  cfIpv6: "",
};

const learned = {
  "edge-a.example.com:443": { rtt: 38, colo: "HKG" },
  "edge-b.example.com:443": { rtt: 92, colo: "NRT" },
  "edge-c.example.com:2053": { rtt: 210, colo: "LAX" },
};

const stats = { up: 17742682, down: 2493569125, conns: 16728, todayUp: 12345678, todayDown: 99887766 };

function seedState() {
  const S = W.S;
  S.colo = "HKG";
  S.curs = { lat: "edge-a.example.com:443", tput: "edge-b.example.com:443" };
  S.funnel = { direct: 612, node: 3388, v6: 12 };
  for (const k of S.cntKeys || []) { S.cnt[k] = 0; S.cntSent[k] = 0; }
  S.cnt.conn = 412; S.cnt.node = 388; S.cnt.direct = 24;
  S.hostNode.clear();
  S.hostNode.set("x.com", new Map([
    ["edge-a.example.com:443", { n: 12, ok: 11, bad: 1, bytes: 8123456, ttfb: 193, at: Date.now() - 60000 }],
    ["edge-b.example.com:443", { n: 7, ok: 6, bad: 1, bytes: 2211334, ttfb: 402, at: Date.now() - 120000 }],
  ]));
  return S;
}

const url = new URL("https://edge.example.com/" + UUID + "?ed=2048");
const host = "edge.example.com";

function fp(name, value) {
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { name, bytes: Buffer.byteLength(s), sha: crypto.createHash("sha256").update(s).digest("hex").slice(0, 32) };
}

const out = [];
seedState();
out.push(fp("clash", W.renderClash(env, url, UUID, host, learned, ["HK", "JP", "US", "SG"])));
seedState();
out.push(fp("singbox", W.renderSingbox(env, url, UUID, host, learned, ["HK", "JP", "US", "SG"])));
seedState();
out.push(fp("links", W.renderLinks(env, url, UUID, host, learned, ["HK", "JP", "US", "SG"])));
out.push(fp("subHeaders", W.subHeaders(env, stats)));
out.push(fp("orderNodes", W.orderNodes(W.loadNodes(env, host), learned)));
out.push(fp("nodeLabels", W.loadNodes(env, host).map((n) => W.nodeLabel(n))));
out.push(fp("subHeadersQuota", W.subHeaders({ ...env, quotaBytes: "1073741824" }, stats)));
out.push(fp("subHeadersNoExpire", W.subHeaders({ ...env, expireAt: "" }, stats)));

const result = { version: W.VERSION, items: out };
const text = JSON.stringify(result, null, 2);

if (process.argv[2] === "write") {
  fs.writeFileSync(file, text + "\n");
  console.log("wrote test/golden.json");
  for (const x of out) console.log(`  ${x.name.padEnd(12)} ${String(x.bytes).padStart(7)} B  ${x.sha}`);
} else {
  const base = JSON.parse(fs.readFileSync(file, "utf8"));
  let bad = 0;
  for (const b of base.items) {
    const cur = out.find((x) => x.name === b.name);
    if (!cur) { console.log(`MISSING ${b.name}`); bad++; continue; }
    if (cur.sha !== b.sha || cur.bytes !== b.bytes) {
      console.log(`DIFF ${b.name}: ${b.bytes}B/${b.sha} → ${cur.bytes}B/${cur.sha}`);
      bad++;
    }
  }
  console.log(bad ? `golden: ${bad} 项不一致` : `golden: ${base.items.length} 项全部一致`);
  process.exit(bad ? 1 : 0);
}
