// 成员变量注释门禁：类字段（类体第一层的字段声明）上方必须有 /** 说明它代表什么。
// 棘轮：`tools/members-baseline.json` 记录当前还没补上注释的字段（迁移期），
// 只允许「基线里有的变少」，出现基线外的新字段没注释直接失败。
import fs from "node:fs";
import path from "node:path";

const BASE = "tools/members-baseline.json";
const FIELD = /^\s+(?:(?:private|public|protected) )?(?:readonly )?[A-Za-z_]\w*[?!]?\s*[:=]/;
const METHOD = /^\s+(?:(?:private|public|protected) )?(?:readonly )?(?:async )?[A-Za-z_]\w*\s*[(<]/;

/** 递归列出 src 下的 .ts 文件。 */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name).replace(/\\/g, "/");
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** 每个类的第一层字段声明行号 + 是否有注释。 */
function scan(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  /** 每行行首的花括号深度。 */
  const depthAt = [];
  let depth = 0;
  for (const line of lines) {
    depthAt.push(depth);
    const code = line.replace(/\/\/.*$/, "").replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "");
    depth += (code.match(/{/g) || []).length - (code.match(/}/g) || []).length;
  }
  /** 结果：{ line, text, hasDoc }。 */
  const out = [];
  let body = null;
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (/^(export )?(abstract )?class \w+/.test(t)) {
      body = depthAt[i] + 1;
      continue;
    }
    if (body === null) continue;
    if (depthAt[i] < body) {
      body = null;
      continue;
    }
    if (depthAt[i] !== body) continue;
    if (!FIELD.test(lines[i]) || METHOD.test(lines[i])) continue;
    // 构造函数里的参数属性（行尾是逗号）由构造函数的 @param 说明，不在这里重复要求
    if (t.endsWith(",")) continue;
    let k = i - 1;
    while (k >= 0 && lines[k].trim() === "") k -= 1;
    const prev = k >= 0 ? lines[k].trim() : "";
    // 行尾 // 注释、或上一行是 // 注释，都算「说明了含义」
    const inline = lines[i].includes("//");
    const above = prev.endsWith("*/") || prev.startsWith("*") || prev.startsWith("//");
    out.push({ line: i + 1, text: t, hasDoc: inline || above });
  }
  return out;
}

const baseline = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, "utf8")) : { missing: [] };
const allowed = new Set(baseline.missing || []);
const debt = [];
const fresh = [];

for (const f of walk("src")) {
  for (const fld of scan(f)) {
    if (fld.hasDoc) continue;
    const key = `${f}:${fld.text.replace(/\s+/g, " ")}`;
    if (allowed.has(key)) debt.push(key);
    else fresh.push(`${f}:${fld.line} ${fld.text}`);
  }
}

// `--list` 只打印还欠注释的字段：迁移期用它点名下一次要补哪几个
if (process.argv.includes("--list")) for (const k of debt) console.log(k);

if (fresh.length) {
  console.error(`成员变量缺注释（基线外，必须补）：${fresh.length} 处`);
  for (const f of fresh.slice(0, 25)) console.error("  " + f);
  process.exit(1);
}
console.log(`成员变量注释门禁通过：迁移期还剩 ${debt.length} 处（基线 ${allowed.size} 处）`);
