// 把"共享作用域"的脚本文件改成真正的 ESM 模块（模板字符串/注释内的假声明不会被误伤）
const fs = require("fs");
const path = require("path");
const DIR = path.resolve(__dirname, "..", "src");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".ts"));

const DECL = /^(?:export\s+)?(async\s+function\*?|function\*?|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const BUILTIN = new Set(["constructor", "toString", "valueOf", "prototype", "length", "name",
  "call", "apply", "bind", "then", "catch", "finally", "hasOwnProperty", "arguments"]);
const SHORT_OK = new Set(["S", "SEL", "SC", "P_V", "P_T"]);

/** 逐行标注：这一行是不是"代码"（排除块注释与模板字符串内部） */
function codeLines(src) {
  const out = [];
  let inTpl = false, inBlock = false;
  const lines = src.split("\n");
  for (const line of lines) {
    let tpl = inTpl, blk = inBlock;
    // 统计本行的反引号（忽略转义），用于判断行内是否进入/退出模板
    let ticks = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "\\") { i++; continue; }
      if (line[i] === "`") ticks++;
      if (!tpl && !blk && line[i] === "/" && line[i + 1] === "*") { blk = true; i++; continue; }
      if (!tpl && blk && line[i] === "*" && line[i + 1] === "/") { blk = false; i++; continue; }
    }
    const isCode = !tpl && !blk;
    if (ticks % 2 === 1) inTpl = !inTpl;
    inBlock = blk;
    out.push({ line, isCode });
  }
  return out;
}

const own = new Map(), where = new Map();
for (const f of files) {
  const rows = codeLines(fs.readFileSync(path.join(DIR, f), "utf8"));
  const set = new Set();
  for (const r of rows) {
    if (!r.isCode) continue;
    const m = r.line.match(DECL);
    if (m) set.add(m[2]);
  }
  own.set(f, set);
  for (const s of set) {
    if (where.has(s)) console.error(`! 重名 ${s}: ${where.get(s)} / ${f}`);
    where.set(s, f);
  }
}

const EXTERNAL = { connect: "cloudflare:sockets" };
for (const f of files) {
  const p = path.join(DIR, f);
  const rows = codeLines(fs.readFileSync(p, "utf8"));
  const mine = own.get(f);

  // 1) 顶层声明加 export（只动代码行）
  const exported = rows.map((r) => {
    if (!r.isCode) return r.line;
    const m = r.line.match(DECL);
    if (!m || /^export\s/.test(r.line)) return r.line;
    return "export " + r.line;
  }).join("\n");

  // 2) 去掉旧 import（副作用 + 上一轮生成的具名）
  const cleaned = exported
    .replace(/^\s*import\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*import\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?\s*$/gm, "");

  // 3) 计算 import
  const used = new Set(cleaned.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []);
  const need = new Map();
  for (const s of used) {
    if (mine.has(s) || BUILTIN.has(s)) continue;
    if (s.length < 3 && !SHORT_OK.has(s)) continue;
    if (EXTERNAL[s]) { if (!need.has(EXTERNAL[s])) need.set(EXTERNAL[s], []); need.get(EXTERNAL[s]).push(s); continue; }
    const owner = where.get(s);
    if (!owner || owner === f) continue;
    const spec = "./" + owner.replace(/\.ts$/, "");
    if (!need.has(spec)) need.set(spec, []);
    need.get(spec).push(s);
  }
  const lines = [];
  for (const [spec, syms] of [...need.entries()].sort()) {
    lines.push(`import { ${[...new Set(syms)].sort().join(", ")} } from "${spec}";`);
  }
  fs.writeFileSync(p, (lines.length ? lines.join("\n") + "\n\n" : "") + cleaned.replace(/^\s*\n/, ""));
  console.log(`${f}: export ${mine.size} · imports ${lines.length}`);
}
