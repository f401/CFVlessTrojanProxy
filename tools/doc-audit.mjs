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

/**
 * 文档挂在 import 上：一段 JSDoc 后面紧跟 `import` 语句。
 *
 * 成因是「插入 import 时插在了文档与声明之间」—— 于是被描述的那个常量/函数反倒没有文档，
 * 而 import 顶上一段说明既无意义又会被读者当成「这个 import 的注解」。7.196 在
 * `commitfact.ts` 与 `dnsfacts.ts` 各抓到一处，原有四条判据（缺注释/孤儿/叠文档/类表）
 * 全都看不见它：缺注释只查函数与方法，孤儿查的是「块后是 } 或 EOF」。
 *
 * 文件头说明不算（它前面只有注释与空行），因为模块说明本来就该在 import 之上。
 * @param {string[]} lines 文件行
 * @returns {{line: number, imp: number}[]} 命中的位置（1 起）
 */
function docOnImport(lines) {
  // 每个位置属于第几个注释块（1 起）：文件头说明是第 1 块，之后的块都不可能是「模块说明」
  const blockOf = new Array(lines.length);
  let blocks = 0;
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const isComment = t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t === "*/";
    if (isComment) {
      if (!open) {
        blocks += 1;
        open = true;
      }
    } else {
      open = false;
    }
    blockOf[i] = blocks;
  }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    // 只认真正的 import 语句：`import(` 是名为 import 的方法定义，不在此列
    if (!/^\s*import\s+[\w{*]/.test(lines[i])) continue;
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === "") j--;
    if (j < 0 || !lines[j].trim().endsWith("*/")) continue;
    let k = j;
    while (k >= 0 && !lines[k].trim().startsWith("/**")) k--;
    if (k < 0) continue;
    // 文件头说明：这是整份文件的第一个注释块，它本来就该压在 import 之上
    if (blockOf[k] === 1) continue;
    out.push({ line: k + 1, imp: i + 1 });
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
const onImportRows = [];
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
  const onImp = docOnImport(lines);
  if (onImp.length) onImportRows.push({ file, onImp, n: onImp.length });
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
const onImpSum = onImportRows.reduce((a, r) => a + r.n, 0);
if (onImpSum) {
  console.log(`\n文档挂在 import 上（被描述的东西反而没有文档）：${onImpSum} 处`);
  for (const r of onImportRows) {
    for (const o of r.onImp) console.log(`  ${r.file}:${o.line} 的文档块 → 第 ${o.imp} 行是 import`);
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
// H6 表行号连续性：编号必须从 1 连续到最大值。7.231 的第 188 行与 7.233 的第 190 行都是
// 我自己漏写的 —— 表格语法合法、列数与反引号都对，只是少了一行，靠肉眼扫才发现。
const h6seq = (() => {
  const file = "docs/v8实现清单.md";
  if (!fs.existsSync(file)) return { max: 0, miss: [], dup: [] };
  const nums = [];
  for (const l of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = l.match(/^\|\s*(\d+)\s*\|/);
    if (m) nums.push(Number(m[1]));
  }
  const max = nums.length ? Math.max(...nums) : 0;
  const have = new Set(nums);
  const miss = [];
  // 从 1 开始逐个对，缺号即报（编号是人写的序号，不能有洞）
  for (let i = 1; i <= max; i++) if (!have.has(i)) miss.push(i);
  const dup = [...have].filter((n) => nums.filter((x) => x === n).length > 1);
  return { max, miss, dup };
})();
if (h6seq.miss.length) {
  console.log(`\nH6 表缺号（缺陷编号必须从 1 连续到 ${h6seq.max}）：${h6seq.miss.length} 个`);
  console.log(`  缺：${h6seq.miss.join(", ")}`);
  process.exitCode = 1;
}
if (h6seq.dup.length) {
  console.log(`\nH6 表重号（同一编号出现多次）：${h6seq.dup.join(", ")}`);
  process.exitCode = 1;
}

// 版本口径一致性：AGENTS.md 头部那句「仓库 **7.x**（自举审计…共 N 个缺陷）」必须与
// src/core/util.ts 的 VERSION、H6 表最大编号三者对齐。7.233 那轮我漏改过版本号，
// 结果是「仓库 7.231」挂在树上、而代码已经是 7.233 —— 没有任何门禁会因此变红。
const headSync = (() => {
  const util = fs.readFileSync("src/core/util.ts", "utf8");
  const vm = util.match(/export const VERSION = "([0-9.]+)";/);
  const agents = fs.readFileSync("AGENTS.md", "utf8");
  const hm = agents.match(/仓库 \*\*([0-9.]+)\*\*（[^）]*?共 (\d+) 个缺陷/);
  const om = agents.match(/线上 \*\*([0-9.]+)\*\*/);
  const bad = [];
  if (!vm || !hm) bad.push("解析失败：src/core/util.ts 的 VERSION 或 AGENTS.md 头部格式变了");
  else {
    if (hm[1] !== vm[1]) bad.push(`版本：AGENTS 写 ${hm[1]}，代码是 ${vm[1]}`);
    if (Number(hm[2]) !== h6seq.max) bad.push(`缺陷数：AGENTS 写 ${hm[2]}，H6 表最大编号是 ${h6seq.max}`);
    // 「两者差 N 个版本」也要对得上（7.x 的 x 是单调递增的小版本号）
    if (om) {
      const dm = agents.match(/两者差 (\d+) 个版本/);
      const gap = Number(vm[1].split(".")[1]) - Number(om[1].split(".")[1]);
      if (dm && Number(dm[1]) !== gap) bad.push(`版本差：AGENTS 写 ${dm[1]}，实际 ${gap}`);
    }
  }
  return bad;
})();
if (headSync.length) {
  console.log("\n版本口径不一致（AGENTS.md 头部 / VERSION / H6 编号三者必须对齐）：");
  for (const b of headSync) console.log(`  ${b}`);
  process.exitCode = 1;
}

// JSDoc 里的类型必须与 TS 签名一致（7.235）：文档写 {number}、代码是 string 这类漂移
// 单看注释门禁查不出来，只有「把文档里的类型和签名里的类型对一遍」才能发现。
// 保守口径：参数含泛型 / 解构 / 剩余参数 / 换行的函数一律跳过（正则拆不干净，宁可漏报）。
const docType = (() => {
  const PRIM = new Set(["number", "string", "boolean", "void", "null", "undefined", "object"]);
  const out = [];
  for (const f of walk(root)) {
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
      if (!m) continue;
      // 文档块必须紧贴签名（中间只允许空行）
      let k = i - 1;
      while (k >= 0 && lines[k].trim() === "") k--;
      if (k < 0 || lines[k].trim() !== "*/") continue;
      let d0 = k;
      while (d0 >= 0 && lines[d0].trim() !== "/**") d0--;
      const doc = lines.slice(d0, k + 1).join("\n");
      // 签名最多拼 10 行，遇到 `) :` 就停
      let sig = "";
      for (let q = i; q < Math.min(lines.length, i + 10); q++) {
        sig += lines[q] + "\n";
        if (/\)\s*:/.test(sig)) break;
      }
      const pm = sig.match(/\(([\s\S]*?)\)\s*:/);
      if (!pm) continue;
      const raw = pm[1];
      if (/[<>{}\[\]]|\.\.\./.test(raw)) continue;
      const params = [];
      let simple = true;
      for (const part of raw.split(",")) {
        const t = part.trim();
        if (!t) continue;
        const mm = t.match(/^([A-Za-z_$][\w$]*)\??\s*:\s*([A-Za-z_$][\w$]*)$/);
        if (!mm) { simple = false; break; }
        params.push({ name: mm[1], type: mm[2] });
      }
      if (!simple || !params.length) continue;
      // 返回类型：`X` 或 `X | null` 都按 X 比（文档省掉 | null 是常见简写，不算漂移）
      const retM = sig.match(/\)\s*:\s*([A-Za-z_$][\w$]*)\s*(?:\|\s*[A-Za-z_$][\w$.\[\]]*\s*)*\{/);
      const retDoc = doc.match(/@returns \{([A-Za-z_$][\w$]*)\}/);
      if (retM && retDoc && PRIM.has(retDoc[1]) && PRIM.has(retM[1]) && retDoc[1] !== retM[1]) {
        out.push(`${f}:${i + 1} ${m[1]}() 文档 @returns {${retDoc[1]}}，签名是 ${retM[1]}`);
      }
      for (const dm of doc.matchAll(/@param \{([A-Za-z_$][\w$]*)\} ([A-Za-z_$][\w$]*)/g)) {
        const c = params.find((x) => x.name === dm[2]);
        if (!c) continue;
        if (PRIM.has(dm[1]) && PRIM.has(c.type) && dm[1] !== c.type) {
          out.push(`${f}:${i + 1} ${m[1]}() 文档 @param ${dm[2]} {${dm[1]}}，签名是 ${c.type}`);
        }
      }
    }
  }
  return out;
})();
if (docType.length) {
  console.log("\nJSDoc 类型与签名不一致（文档里的类型必须是签名里的类型）：");
  for (const x of docType) console.log(`  ${x}`);
  process.exitCode = 1;
}
process.exitCode = process.exitCode || 0;
