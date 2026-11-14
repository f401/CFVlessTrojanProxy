// 部署闸门：拒绝把明文包推上线（协议关键字严格为 0），域名类只做提示。
// 用法：node tools/check-obf.js <file> [more...]
const fs = require("node:fs");
// 严格：任何出现都说明没混淆干净
const STRICT = ["vless", "vmess", "trojan", "shadowsocks", "xray", "clash", "sing-box", "subscription", "proxyip", "githubusercontent", "workers.dev", "x-admin-key"];
// 提示：功能性字面量（站点族键/正则/面板文案），有也不 blocking
const INFO = ["x.com", "twitter", "twimg", "twttr", "t.co"];
const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node tools/check-obf.js <file> ...");
  process.exit(2);
}
let bad = 0;
for (const f of files) {
  if (!fs.existsSync(f)) {
    console.error(`✗ ${f}: 文件不存在`);
    bad++;
    continue;
  }
  const s = fs.readFileSync(f, "utf8");
  const low = s.toLowerCase();
  const a0x = (s.match(/a_0x[0-9a-f]{4,6}/g) || []).length;
  const plainClass = /class Meter\b/.test(s);
  const hits = STRICT.filter((w) => low.includes(w));
  const info = INFO.map((w) => `${w}:${low.split(w).length - 1}`).filter((x) => !x.endsWith(":0"));
  const ok = a0x >= 100 && !plainClass && hits.length === 0;
  console.log(`${ok ? "✓" : "✗"} ${f}  ${(s.length / 1024).toFixed(0)} KB  a_0x=${a0x}  classMeter=${plainClass}  严格关键字=${hits.join(",") || "无"}  提示=${info.join(",") || "无"}`);
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
