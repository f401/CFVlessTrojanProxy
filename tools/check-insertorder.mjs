// 「按插入序切片 / 淘汰」门禁（棘轮）：这是 7.177、7.181、7.187、7.215、7.224 五条缺陷的同一个形状。
//
// 判据：`Object.keys/values/entries(...).slice|splice` 与 `Map.keys().next()`。
//   · `Object.entries` 给的是**插入序**，而事实表合并只会「更新已有键」或「追加新键」，
//     所以新学到的证据永远排在最后 —— 直接 slice(0, n) 切出来的是最旧的那批。
//   · `Map.set` 对**已存在的键不移动插入位置**，所以 `keys().next()` 是「首次插入的键」，
//     不是「最久没更新的键」。
// 两处都需要显式排序（按时间戳）或「先 delete 再 set」才成立。允许清单里的三处都写了理由。
//
// 用法：node tools/check-insertorder.mjs
// 棘轮：`tools/insertorder-baseline.json` 里的条目是上限。多出来 → 红；少掉 → 也红（提示下调基线），
// 逼着每次改动只能往下走，不允许悄悄新增。
import fs from "node:fs";
import path from "node:path";

/** 允许清单文件：每条 { file, snippet, why } */
const BASE = "tools/insertorder-baseline.json";

/**
 * 功能：递归收集 `src` 下所有 `.ts` 文件路径。
 * @param {string} dir 起始目录
 * @param {string[]} acc 累加器
 * @returns {string[]} 文件路径
 */
const walk = (dir, acc = []) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
};

/** 判据正则：按插入序切片或取首键 */
const PATTERNS = [
  /Object\.(?:keys|values|entries)\([^)]*\)\s*(?:as [^;{}]*?)?\.\s*(?:slice|splice)\(/,
  /Array\.from\([^)]*\.(?:keys|values|entries)\(\)\)\s*\.\s*(?:slice|splice|shift)\(/,
  /\.(?:keys|values|entries)\(\)\s*\.next\(\)/,
];

/**
 * 功能：扫全部源码，返回命中列表（文件路径 + 去缩进的代码片段）。
 * @returns {Array<{ file: string; snippet: string; line: number }>} 命中
 */
export function scanInsertOrder() {
  const hits = [];
  for (const file of walk("src")) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      // 注释行不算命中：判据要的是真的代码（注释里常引用旧写法）
      const t = line.trim();
      if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      if (PATTERNS.some((re) => re.test(line))) hits.push({ file, snippet: t, line: i + 1 });
    });
  }
  return hits;
}

const hits = scanInsertOrder();
const raw = fs.existsSync(BASE) ? fs.readFileSync(BASE, "utf8").replace(/^\uFEFF/, "") : "[]";
const allowed = JSON.parse(raw);
// 键里的路径统一成正斜杠：Windows 上 `path.join` 给的是反斜杠，基线文件里写的是 `/`
const key = (x) => `${x.file.replace(/\\/g, "/")} :: ${x.snippet}`;
const allowKeys = new Set(allowed.map(key));

const extra = hits.filter((h) => !allowKeys.has(key(h)));
const missing = allowed.filter((a) => !hits.some((h) => key(h) === key(a)));

if (extra.length) {
  console.log(`「按插入序」判据命中新增 ${extra.length} 处（必须显式按时间排序，或先 delete 再 set）：`);
  for (const h of extra) console.log(`  ${h.file}:${h.line}  ${h.snippet.slice(0, 110)}`);
}
if (missing.length) {
  console.log(`允许清单里少了 ${missing.length} 处（已改掉就下调 ${BASE}）：`);
  for (const m of missing) console.log(`  ${m.file} :: ${m.snippet.slice(0, 110)}`);
}
if (extra.length || missing.length) process.exitCode = 1;
else console.log(`「按插入序」门禁通过（与基线一致，${hits.length} 处都在允许清单里）`);
