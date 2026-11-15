// 注释体检：找出「没有文档注释」的导出函数与公开方法。
// 用法：node tools/doc-audit.mjs [--top N] [模块前缀]
// 判定：函数/方法上方紧邻（允许空行）必须有一个以 /** 开头的多行注释块。
import fs from "node:fs";
import path from "node:path";

const root = "src";
const args = process.argv.slice(2);
const topIdx = args.indexOf("--top");
const TOP = topIdx >= 0 ? Number(args[topIdx + 1]) || 20 : 20;
// 允许的最大缺注释数（--max N）：超过即退出码 1，preflight 用它当硬闸
const maxIdx = args.indexOf("--max");
const MAX = maxIdx >= 0 ? Number(args[maxIdx + 1]) || 0 : Number.POSITIVE_INFINITY;
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

/**
 * 孤儿文档：文档块结束后（跳过空行）紧跟 `}` 或文件结束，说明它在为一个不存在的东西写文档。
 * 7.151 之前有十处（panel.ts 七段移走的辅助函数、session.ts 的下行转发、selector.ts 的扫描方法、
 * panel-admin.ts 的订阅头）——它们读起来像「这个文件里有这些能力」，实际函数早搬走了。
 * @param {string[]} lines 文件行
 * @returns {{line: number, nxt: string}[]} 命中的位置（1 起）
 */
function orphanDocs(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "/**") continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].includes("*/")) j++;
    if (j >= lines.length) break;
    let k = j + 1;
    while (k < lines.length && lines[k].trim() === "") k++;
    const nxt = k >= lines.length ? "" : lines[k].trim();
    if (nxt === "}" || nxt === "") out.push({ line: i + 1, nxt: nxt || "(文件结束)" });
    i = j;
  }
  return out;
}

const rows = [];
let total = 0;
const orphanRows = [];
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
  const orph = orphanDocs(lines);
  if (orph.length) orphanRows.push({ file, orph, n: orph.length });
}

rows.sort((a, b) => b.n - a.n);
const sum = rows.reduce((a, r) => a + r.n, 0);
console.log(`函数总数 ${total}，缺注释 ${sum}（${((sum / total) * 100).toFixed(1)}%），涉及 ${rows.length} 个文件\n`);
for (const r of rows.slice(0, TOP)) {
  console.log(`${String(r.n).padStart(3)}  ${r.file}`);
  if (TOP <= 8) for (const m of r.miss.slice(0, 12)) console.log(`       ${m.line}: ${m.name}`);
}
if (sum > MAX) {
  console.log(`\n✗ 注释门禁：缺注释 ${sum} 个，超过上限 ${MAX}`);
  process.exitCode = 1;
}
const orphSum = orphanRows.reduce((a, r) => a + r.n, 0);
if (orphSum) {
  console.log(`\n孤儿文档（注释块后面不是声明，而是 "}" 或文件结束）：${orphSum} 处`);
  for (const r of orphanRows) {
    for (const o of r.orph) console.log(`  ${r.file}:${o.line} → ${o.nxt}`);
  }
  process.exitCode = 1;
}
process.exitCode = process.exitCode || 0;
