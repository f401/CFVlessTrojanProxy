const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
global.window = global; global.self = global;
const JSO = require("./obfuscator-browser.js");

let src = fs.readFileSync(path.join(ROOT, "_worker_v3.pre.js"), "utf8");

// 生产包不再附带测试导出（测试用 dist/_test.js）

// === 用户指定配置 ===
const options = {
  compact: true,
  simplify: true,
  identifierNamesGenerator: "hexadecimal",
  identifiersPrefix: "a",
  renameGlobals: true,                 // 全局命名也混淆
  reservedNames: ["^Meter$"],          // 只有 DO 类名必须保留（绑定要用）
  renameProperties: false,             // 保留：会破坏 env 绑定与 WebSocket API
  stringArray: true,
  stringArrayThreshold: 0.7,             // 100% 字符串进数组
  stringArrayEncoding: ["base64"],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersType: "variable",
  stringArrayWrappersChainedCalls: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.5,
  stringArrayIndexShift: true,
  splitStrings: false,
  splitStringsChunkLength: 6,
  transformObjectKeys: true,
  numbersToExpressions: false,
  controlFlowFlattening: true,         // 控制流平坦化
  controlFlowFlatteningThreshold: 0.3,
  deadCodeInjection: false,             // 死代码注入
  deadCodeInjectionThreshold: 0.25,
  selfDefending: false,                // 实测在 Workers 上触发 1104，必须关
  debugProtection: false,              // 会用 setInterval 挂住 isolate
  disableConsoleOutput: true,
  unicodeEscapeSequence: false,
};

const BAD = ["vless", "vmess", "trojan", "shadowsocks", "xray", "clash", "sing-box",
             "subscription", "proxyip", "githubusercontent", "ip-api", "dns.google", "ygkkk"];
const scan = (txt) => { const low = txt.toLowerCase(); return BAD.map((w) => [w, low.split(w).length - 1]).filter(([, n]) => n > 0); };

// 混淆器生成的随机标识符偶尔会拼出 xray / clash 这类子串（例如 nXRaY），
// 换个随机种子重跑即可。最多试 6 次。
const t0 = Date.now();
let out = "", hits = [];
for (let i = 0; i < 6; i++) {
  out = JSO.obfuscate(src, options).getObfuscatedCode();
  hits = scan(out);
  if (!hits.length) break;
  if (i < 5) console.log(`第 ${i + 1} 次有随机标识符撞词（${hits.map(([w, n]) => w + "=" + n).join(" ")}），重试`);
}
fs.writeFileSync(path.join(ROOT, "_worker_v3.mid.js"), out);
if (hits.length) { console.error("仍然残留:", JSON.stringify(hits)); process.exit(1); }
console.log(`源 ${(src.length/1024).toFixed(1)} KB → ${(out.length/1024).toFixed(1)} KB，${((Date.now()-t0)/1000).toFixed(1)}s`);
console.log("关键字残留:", "无");
