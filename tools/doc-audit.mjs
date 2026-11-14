// 注释体检：找出「没有文档注释」的导出函数与公开方法。
// 用法：node tools/doc-audit.mjs [--top N] [模块前缀]
// 判定：函数/方法上方紧邻（允许空行）必须有一个以 /** 开头的多行注释块。
import fs from "node:fs";
import path from "node:path";

const root = "src";
const args = process.argv.slice(2);
const topIdx = args.indexOf("--top");
const TOP = topIdx >= 0 ? Number(args[topIdx + 1]) || 20 : 20;
const only = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a));

/** 递归收集 .ts 文件 */
function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** 该行上方（跳过空行）是否有文档注释块 */
function hasDoc(lines, i) {
  let j = i - 1;
  while (j >= 0 && lines[j].trim() === "") j--;
  if (j < 0) return false;
  if (!lines[j].trim().endsWith("*/")) return false;
  // 往上找到注释开头
  let k = j;
  while (k >= 0 && !lines[k].trim().startsWith("/*")) k--;
  if (k < 0) return false;
  return lines[k].trim().startsWith("/**");
}

const FN = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/;
const METH = /^  (?:async\s+)?(?:private\s+|public\s+|protected\s+|static\s+)*(?!constructor\b)([A-Za-z0-9_$]+)\s*\([^)]*\)\s*:\s*[^{;]+[{;]\s*$/;

const rows = [];
let total = 0;
for (const file of walk(root)) {
  if (only && !file.includes(only)) continue;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const miss = [];
  lines.forEach((line, i) => {
    const m = line.match(FN) || line.match(METH);
    if (!m) return;
    total++;
    if (!hasDoc(lines, i)) miss.push({ name: m[1], line: i + 1 });
  });
  if (miss.length) rows.push({ file, miss, n: miss.length });
}

rows.sort((a, b) => b.n - a.n);
const sum = rows.reduce((a, r) => a + r.n, 0);
console.log(`函数总数 ${total}，缺注释 ${sum}（${((sum / total) * 100).toFixed(1)}%），涉及 ${rows.length} 个文件\n`);
for (const r of rows.slice(0, TOP)) {
  console.log(`${String(r.n).padStart(3)}  ${r.file}`);
  if (TOP <= 8) for (const m of r.miss.slice(0, 12)) console.log(`       ${m.line}: ${m.name}`);
}
process.exitCode = 0;
