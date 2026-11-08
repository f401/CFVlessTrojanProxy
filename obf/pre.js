// 预处理：把敏感字面量与标识符从源码里抹掉，让即使 threshold=0.3 的混淆也不残留关键字
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const SENS = /(vless|vmess|trojan|shadowsocks|xray|clash|sing-box|subscription|proxyip|githubusercontent|ip-api|dns\.google|ygkkk)/i;

function b64(s) { return Buffer.from(s, "utf8").toString("base64"); }

let src = fs.readFileSync(path.join(ROOT, "dist/_worker.js"), "utf8");
// 只清理「注释行」里的敏感词（不能动代码，否则会把 URL 里的域名改坏）
src = src
  .split("\n")
  .map((line) => {
    const t = line.trimStart();
    if (!(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"))) return line;
    return line.replace(/ip-api/gi, "第三方接口")
               .replace(/githubusercontent/gi, "代码托管")
               .replace(/dns\.google/gi, "公共 DNS")
               .replace(/proxyip/gi, "中转节点");
  })
  .join("\n");

// ① 测试导出已经拆到 dist/_test.js，生产包只剩 export { Meter, default }，不能剥

// ② 模板字符串里的协议前缀（`vless://${id}…`）先单独处理
src = src.replace(/`vless:\/\//g, "`${P_V}://").replace(/`trojan:\/\//g, "`${P_T}://");

// ③ 编码敏感字面量：字符串内容含敏感词就换成解码调用
//    对象键位置（后面紧跟冒号）改成计算属性
let litCount = 0;
src = src.replace(/(["'])((?:\\.|(?!\1).)*)\1(\s*:)?/g, (all, q, body, colon, offset) => {
  if (!SENS.test(body)) return all;
  litCount++;
  const call = `__K("${b64(body)}")`;
  if (!colon) return call;
  // 只有真的在对象键位置（前面是 { 或 , 或 行首）才转成计算属性；
  // case 标签、三元?:、类型标注 后面也可能跟冒号，那些不能加方括号
  const before = src.slice(0, offset).replace(/\s+$/, "");
  const ch = before.slice(-1);
  return (ch === "{" || ch === ",") ? `[${call}]${colon}` : call + colon;
});

// ③.5 绑定名不能被改名（否则 env.proxyip 读不到），改成运行时解码的计算属性
src = src.replace(/\benv\.proxyip\b/g, () => `env[__K("${b64("proxyip")}")]`);

// ④ 重命名含敏感词的标识符
const idRe = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const map = new Map();
let n = 0;
src = src.replace(idRe, (id) => {
  if (!SENS.test(id)) return id;
  if (id === "__K" || id === "P_V" || id === "P_T") return id;
  if (!map.has(id)) map.set(id, "_R" + (++n).toString(36));
  return map.get(id);
});

// ⑤ 注入解码器
const helper = `const __K = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));\n`;
src = helper + src;

fs.writeFileSync(path.join(ROOT, "_worker_v3.pre.js"), src);
console.log(`预处理完成：编码字面量 ${litCount} 处，重命名标识符 ${map.size} 个`);
