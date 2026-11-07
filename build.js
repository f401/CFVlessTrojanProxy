// 把 build/js/ 下的模块拼成单文件 dist/_worker.js
// - 递归展开相对 import
// - 入口保留全部 export（Workers 需要 export default / export class Meter）
// - 非入口模块去掉 export 关键字（拼接后同处一个作用域）
const fs = require("fs");
const path = require("path");

const ORDER = (process.env.ORDER || "state,util,proto,net,store,px,px-seed,px-probe,px-score,selector,metrics,connection,data,sub,panel,do,index").split(",");
const ENTRY = process.argv[2] || "build/js/index.js";
const OUT = process.env.OUT || "dist/_worker.js";

const seen = new Set();
const chunks = [];
const IMPORT_RE = /^\s*import\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["'];?\s*$/gm;
const EXTERN = [];   // 外部模块（cloudflare:sockets）要保留，并提升到文件头

function stripExports(src) {
  return src
    .replace(/^\s*export\s+\{[^}]*\};?\s*$/gm, "")
    .replace(/^\s*export\s+default\s+/gm, "const __default__ = ")
    .replace(/^\s*export\s+(async\s+function|function\*?|const|let|var)/gm, "$1");
  // 注意：export class 不能删 —— Workers 的 DO 绑定依赖 `export class Meter`
}

function load(file, isEntry) {
  const abs = path.resolve(file);
  if (seen.has(abs)) return;
  seen.add(abs);

  let src = fs.readFileSync(abs, "utf8");
  const dir = path.dirname(abs);

  const deps = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (spec.startsWith(".")) {
      const base = path.resolve(dir, spec);
      deps.push(fs.existsSync(base) ? base : base + ".js");   // import "./util" → util.js
    }
    else if (!EXTERN.some((x) => x.includes(`"${spec}"`))) EXTERN.push(m[0].trim());
  }
  // 全部删掉，外部的已经记在 EXTERN 里，最后统一提升到文件头
  src = src.replace(IMPORT_RE, "");

  // 先依赖后本体（拓扑序）
  for (const d of deps) load(d, false);

  chunks.push(`/* ---- ${path.relative(process.cwd(), abs)} ---- */\n${isEntry ? src.trim() : stripExports(src).trim()}\n`);
}

// 按固定顺序加载（脚本风格：所有文件共享一个作用域，顺序 = 依赖顺序）
let first = true;
for (const name of ORDER) {
  const f = `build/js/${name}.js`;
  if (!fs.existsSync(f)) {
    // 静默跳过会导致"类没被打包进去"这种致命问题（踩过）
    console.error(`[build] 缺少模块: ${f}（ORDER 里有，但文件不存在）`);
    process.exitCode = 1;
    continue;
  }
  load(f, name === "index");
  first = false;
}
if (first) load(ENTRY, true);
const head = EXTERN.join("\n");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
let body = (head ? head + "\n" : "") + chunks.join("\n");
// 单测用的具名导出：运行时多余导出无害，混淆前会被 pre.js 剥掉
try {
  if (fs.existsSync("test-exports.txt")) body += "\n" + fs.readFileSync("test-exports.txt", "utf8");
} catch (e) {}
fs.writeFileSync(OUT, body);
console.log(`${OUT}  ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB  (${seen.size} module(s))`);
