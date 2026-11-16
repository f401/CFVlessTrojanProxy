// 代码体注释体检：找「函数体够长但体内一条注释都没有」的函数。
// 目的：goals 要求「代码体里面也要介绍步骤，难理解的加原因」，
// 所以这里只统计体内是否**有**注释，不评价写得好不好——那是人看的。
// 用法：node tools/body-audit.mjs [--min 12] [--top 25] [模块前缀]
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const minIdx = args.indexOf("--min");
const MIN = minIdx >= 0 ? Number(args[minIdx + 1]) || 12 : 12;
const topIdx = args.indexOf("--top");
const TOP = topIdx >= 0 ? Number(args[topIdx + 1]) || 25 : 25;
// --max N：允许的「体内零注释」函数个数上限（超过即红）。preflight 里用 --max 0，
// 意思是这条规则从「体检」升级成硬门禁；不给 --max 时保持原来的纯体检行为。
const maxIdx = args.indexOf("--max");
const MAX = maxIdx >= 0 ? Number(args[maxIdx + 1]) || 0 : -1;
const only = args.find((a, i) => !a.startsWith("--") && !/^\d+$/.test(a) && args[i - 1] !== "--min" && args[i - 1] !== "--top");

/** 递归收集 .ts（跳过 .d.ts 与 vendor） */
function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const SIG = /^(\s*)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/;
const METH = /^(\s{2})(?:(?:private|public|protected|static|async)\s+)*(?!constructor\b)([A-Za-z0-9_$]+)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*$/;
const KW = new Set(["if", "for", "while", "switch", "catch", "return", "do", "try", "else"]);

const rows = [];
for (const file of walk("src")) {
  if (only && !file.includes(only)) continue;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SIG) || lines[i].match(METH);
    if (!m || KW.has(m[2])) continue;
    // 花括号配平找函数体结束
    let depth = 0;
    let end = -1;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth === 0 && j > i) { end = j; break; }
      if (depth === 0 && j === i) { end = i; break; } // 单行函数
    }
    if (end <= i) continue;
    const body = lines.slice(i + 1, end);
    const codeLines = body.filter((x) => x.trim() && !x.trim().startsWith("//"));
    const code = codeLines.length;
    // 纯模板字面量（HTML 渲染）跳过：在模板里写 // 会原样发给浏览器
    const first = codeLines[0] || "";
    const lastIdx = codeLines.length - 1;
    const closed = /`;?\s*$/.test(codeLines[lastIdx] || "");
    if (/^\s*return\s+`/.test(first) && closed) continue;
    const cm = body.filter((x) => /^\s*\/\//.test(x) || /\/\*/.test(x)).length;
    if (code >= MIN && cm === 0) rows.push({ file, line: i + 1, name: m[2], code });
  }
}

rows.sort((a, b) => b.code - a.code);
console.log(`体内零注释且代码行 ≥${MIN} 的函数：${rows.length} 个\n`);
for (const r of rows.slice(0, TOP)) {
  console.log(`${String(r.code).padStart(4)} 行  ${r.file}:${r.line}  ${r.name}`);
}


// 硬门禁档位：超过 --max 就红，并逐条点名（与 check-names / check-insertorder 的棘轮口径一致）
if (MAX >= 0 && rows.length > MAX) {
  console.error(`肉体零注释的函数 ${rows.length} 个，上限 ${MAX}：`);
  for (const r of rows) console.error(`  ${r.file}:${r.line} ${r.name}（${r.code} 行）`);
  process.exitCode = 1;
}