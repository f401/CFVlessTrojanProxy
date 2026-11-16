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
// 导出类同样要有一份文档：它是 OOP 结构的骨架（ARCHITECTURE 的类表列的就是它们）。
// 7.194 之前这个门禁只管函数，`Prefs` / `RelayHealth` / `Store` 三个类因此一直没有自己的说明。
const CLS = /^\s*export\s+class\s+([A-Za-z0-9_$]+)/;

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

/**
 * 叠文档：文档块结束后（跳过空行）紧跟另一个文档块 —— 前一段在为「不存在的声明」写文档，
 * 读者却以为文件里真有那个函数。7.158 之前有八处：`score.ts` 的 `scoreParts`/`usable` 各叠三段
 * （旧公式说明 + 签名文档 + doc-gen 生成的「薄包装」）、`connection.ts` 的类文档被 `TICK_BYTES` 挤开、
 * `probe.ts` 的 `refillPool` 旧文档、`ts.ts` 指向「文件底部」的过期指针、`panel.ts` 搬走的密码生成、
 * `sub.ts` 的 `renderClash` 旧签名。孤儿门禁（下一条规则）抓不到它们：下一行不是 `}` 而是另一段 `/**`。
 *
 * 文件头注释不算：它前面没有任何代码行（只有注释与空行），那是模块说明，本来就该独立成段。
 * @param {string[]} lines 文件行
 * @returns {{line: number, next: number}[]} 命中的位置（1 起）
 */
function stackedDocs(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    // 单行文档（`/** 一句话 */`）同样会叠：起点用 startsWith，不要求整行就是 `/**`
    if (!lines[i].trim().startsWith("/**")) continue;
    // 前面只有注释/空行 ⇒ 这是文件头说明，允许后面再跟一个声明的文档
    const header = lines.slice(0, i).every((l) => {
      const t = l.trim();
      return t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t === "*/";
    });
    let j = i;
    while (j < lines.length && !lines[j].includes("*/")) j++;
    if (j >= lines.length) break;
    let k = j + 1;
    while (k < lines.length && lines[k].trim() === "") k++;
    if (!header && k < lines.length && lines[k].trim().startsWith("/**")) out.push({ line: i + 1, next: k + 1 });
    i = j;
  }
  return out;
}

// 活文档：这两份描述的是「当前系统」，不是历史。它们里提到的东西必须真的在 src 里存在，
// 否则读者会照着文档去找一个早已删掉的类/函数/文件（7.156 就是靠这条抓到 ARCHITECTURE 的
// `StatsTable` 行与 v8.md 落地表里的三个设计名）。
const LIVING = ["docs/ARCHITECTURE.md", "docs/v8.md", "docs/LIMITS.md"];

/**
 * 活文档引用体检：路径必须存在、`SC.常量` 必须有定义、`name()` 必须在 src 里出现过。
 * ARCHITECTURE 的类表还多一条：每行首个反引号标识符必须是 src 里真实存在的一个类。
 * @param {string[]} files 活文档路径
 * @param {string} srcAll src 下所有 .ts 的全文拼成一个字符串
 * @param {string} constText src/core/const.ts 全文
 * @returns {{file: string, tok: string, why: string, line: number}[]} 可疑引用
 */
function livingRefs(files, srcAll, constText) {
  const out = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/`([^`\n]{2,80})`/g)) {
        const tok = m[1].trim();
        if (/^src\/[\w/.-]+\.ts$/.test(tok)) {
          if (!fs.existsSync(tok)) out.push({ file: f, tok, why: "文件不存在", line: i + 1 });
          continue;
        }
        const sc = tok.match(/^SC\.([A-Z0-9_]+)$/);
        if (sc) {
          if (!new RegExp(`\\b${sc[1]}\\b`).test(constText)) out.push({ file: f, tok, why: "常量不存在", line: i + 1 });
          continue;
        }
        const fn = tok.match(/^([A-Za-z_$][\w$]*)\(\)?$/);
        if (fn && fn[1].length >= 6 && !new RegExp(`\\b${fn[1]}\\s*[(=:]`).test(srcAll)) {
          out.push({ file: f, tok, why: "符号不存在", line: i + 1 });
        }
      }
      // 类表行：`| \`Name\`（\`EXPORT\`） | \`src/...\` | 职责 |`
      if (f.endsWith("ARCHITECTURE.md") && line.startsWith("| `")) {
        const cls = line.match(/^\| `([A-Za-z_$][\w$]*)`/);
        const hasFile = /`src\/[\w/.-]+\.ts`/.test(line);
        if (cls && hasFile && !new RegExp(`class ${cls[1]}\\b`).test(srcAll)) {
          out.push({ file: f, tok: cls[1], why: "类不存在", line: i + 1 });
        }
      }
    });
  }
  return out;
}

const rows = [];
let total = 0;
let totalCls = 0;
const orphanRows = [];
const stackedRows = [];
for (const file of walk(root)) {
  if (only && !file.includes(only)) continue;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const miss = [];
  lines.forEach((line, i) => {
    const m = line.match(FN) || line.match(METH);
    if (m) {
      total++;
      if (!hasDoc(lines, i)) miss.push({ name: m[1], line: i + 1 });
      return;
    }
    // 导出类单独计数：它不算函数，但缺文档一样要拦（与函数共用同一份 miss 列表）
    const c = line.match(CLS);
    if (!c) return;
    totalCls++;
    if (!hasDoc(lines, i)) miss.push({ name: c[1], line: i + 1 });
  });
  if (miss.length) rows.push({ file, miss, n: miss.length });
  const orph = orphanDocs(lines);
  if (orph.length) orphanRows.push({ file, orph, n: orph.length });
  const stk = stackedDocs(lines);
  if (stk.length) stackedRows.push({ file, stk, n: stk.length });
}

rows.sort((a, b) => b.n - a.n);
const sum = rows.reduce((a, r) => a + r.n, 0);
console.log(
  `函数/方法 ${total} 个、导出类 ${totalCls} 个，缺注释 ${sum}（${((sum / (total + totalCls)) * 100).toFixed(1)}%），涉及 ${rows.length} 个文件\n`,
);
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
const stackSum = stackedRows.reduce((a, r) => a + r.n, 0);
if (stackSum) {
  console.log(`\n叠文档（一段文档后面紧跟另一段文档，前一段没有任何声明可挂）：${stackSum} 处`);
  for (const r of stackedRows) {
    for (const s of r.stk) console.log(`  ${r.file}:${s.line} → 下一段文档在第 ${s.next} 行`);
  }
  process.exitCode = 1;
}
const livingRows = (() => {
  const acc = [];
  const srcAll = (function cat(dir) {
    for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, n.name);
      if (n.isDirectory()) cat(p);
      else if (p.endsWith(".ts")) acc.push(fs.readFileSync(p, "utf8"));
    }
    return acc.join("\n");
  })("src");
  const constText = fs.readFileSync("src/core/const.ts", "utf8");
  return livingRefs(LIVING, srcAll, constText);
})();

if (livingRows.length) {
  console.log(`\n活文档引用（文档在给不存在的东西作证）：${livingRows.length} 处`);
  for (const r of livingRows) console.log(`  ${r.file}:${r.line} \`${r.tok}\` → ${r.why}`);
  process.exitCode = 1;
}
// 类表反向缺口：src 里的每个导出类都必须在 ARCHITECTURE 里出现。
// 原来只查「表 → 代码」方向（表里的类不存在就报错），反方向没人管：v8 落地之后
// 13 个类（五个事实表 + 门面 + 影子 + 三个观察器 + Attacher / Prefs / RelPerfTable）
// 从来没进过那张表，读者按表去找 `FactsStore` 会一无所获。
const classTableMiss = (() => {
  const arch = fs.existsSync("docs/ARCHITECTURE.md") ? fs.readFileSync("docs/ARCHITECTURE.md", "utf8") : "";
  const names = [];
  for (const file of walk(root)) {
    if (only && !file.includes(only)) continue;
    for (const m of fs.readFileSync(file, "utf8").matchAll(/^export class ([A-Za-z_$][\w$]*)/gm)) names.push(m[1]);
  }
  return names.filter((n) => !new RegExp("\\b" + n + "\\b").test(arch));
})();
if (classTableMiss.length) {
  console.log(`\n类表缺口（导出类没进 docs/ARCHITECTURE.md）：${classTableMiss.length} 个`);
  for (const n of classTableMiss) console.log(`  ${n}`);
  process.exitCode = 1;
}
// 表格列数门禁：markdown 里某一行的分栏数与表头不一致，渲染时整行会右移，
// 「证据」「修法」会错位到相邻列。历史上 H6 表 138 行数据里 74 行不符
// （77 行缺「证据」列、5 行把版本/涉及文件/后果拆成了独立列、3 行尾部多了
// 自引用列、7 行的代码跨度里 `|` 没转义）。规范化之后这里守着不再复发。
const tableRows = (() => {
  const doc = "docs/v8实现清单.md";
  const empty = { cols: [], ticks: [] };
  if (!fs.existsSync(doc)) return empty;
  const lines = fs.readFileSync(doc, "utf8").split(/\r?\n/);
  const TICK = String.fromCharCode(96);
  /** 数一行的分栏数：转义过的 `\|` 不算分隔符 */
  const cellCount = (line) => {
    let n = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "\\" && line[i + 1] === "|") {
        i++;
        continue;
      }
      if (line[i] === "|") n++;
    }
    return n - 1;
  };
  const head = lines.findIndex((l) => l.startsWith("| # |"));
  if (head < 0) return empty;
  const want = cellCount(lines[head]);
  const cols = [];
  const ticks = [];
  for (let i = head + 2; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith("|")) {
      if (l.startsWith("#")) break;
      continue;
    }
    // 反引号必须成对：一个没闭合的 ` 会把后面的分隔符一起吞进代码跨度，
    // 于是整行少一格（第 23 行的 `/meter/{dbt,raw,hold,cont}， 就是这么坏的）
    if ((l.split(TICK).length - 1) % 2 === 1) ticks.push({ file: doc, line: i + 1 });
    const got = cellCount(l);
    if (got !== want) cols.push({ file: doc, line: i + 1, got, want });
  }
  return { cols, ticks };
})();
if (tableRows.cols.length) {
  console.log(`\n表格列数（分栏数与表头不一致，渲染会整行错位）：${tableRows.cols.length} 行`);
  for (const r of tableRows.cols) console.log(`  ${r.file}:${r.line} ${r.got} 列 ≠ 表头 ${r.want} 列`);
  process.exitCode = 1;
}
if (tableRows.ticks.length) {
  console.log(`\n表格反引号未闭合（会把后面的分栏吞进代码跨度）：${tableRows.ticks.length} 行`);
  for (const r of tableRows.ticks) console.log(`  ${r.file}:${r.line} 反引号个数是奇数`);
  process.exitCode = 1;
}
process.exitCode = process.exitCode || 0;
