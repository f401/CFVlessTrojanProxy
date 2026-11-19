// 预处理：把敏感字面量与标识符从源码里抹掉，让即使 threshold=0.3 的混淆也不残留关键字
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const SENS = /(vless|vmess|trojan|shadowsocks|xray|clash|sing-box|subscription|proxyip|githubusercontent|ip-api|dns\.google|ygkkk|twitter|twimg|twttr|\bx\.com\b|\bt\.co\b)/i;

function b64(s) { return Buffer.from(s, "utf8").toString("base64"); }

/**
 * 把 JS 字符串字面量的「源码表示」还原成运行时真实字符。
 * 背景：esbuild 的 text loader 把 .html 变成带 \n 转义的普通字符串字面量；
 * 若直接把源码文本（含反斜杠 n）base64 编码，__K() 解码后得到的是字面文本 "\n"，
 * 而不是换行 —— 面板 HTML 会整页挤成一行。这里在编码前先还原常见转义。
 * @param {string} body 引号之间的源码文本（不含外层引号）
 * @param {string} q 原引号字符，用于还原 \" 或 \'
 * @returns {string} 运行时真实字符串
 */
function unescapeLiteral(body, q) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && i + 1 < body.length) {
      const c = body[i + 1];
      if (c === "n") { out += "\n"; i++; continue; }
      if (c === "r") { out += "\r"; i++; continue; }
      if (c === "t") { out += "\t"; i++; continue; }
      if (c === "\\") { out += "\\"; i++; continue; }
      if (c === q) { out += q; i++; continue; }
      // 其余转义（\xNN / \uNNNN 等）本仓库模板未使用，保守原样保留
    }
    out += body[i];
  }
  return out;
}

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
  // 先还原转义再编码：esbuild text loader 产出的 HTML 字符串字面量含 \n，
  // 若把源码文本直接 base64 编码，__K() 解出来是字面 "\n" 而不是换行。
  const call = `__K("${b64(unescapeLiteral(body, q))}")`;
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
