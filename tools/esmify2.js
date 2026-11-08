// 第二轮：用保守策略重算 import（宁可多引，不可漏引）
const fs = require("fs");
const path = require("path");
const DIR = path.resolve(__dirname, "..", "src");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".ts"));
const DECL = /^(?:export\s+)?(async\s+function\*?|function\*?|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

const own = new Map(), where = new Map();
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), "utf8");
  const set = new Set();
  for (const line of src.split("\n")) { const m = line.match(DECL); if (m) set.add(m[2]); }
  own.set(f, set);
  for (const s of set) where.set(s, f);
}

const EXTERNAL = { connect: "cloudflare:sockets" };
for (const f of files) {
  const p = path.join(DIR, f);
  let src = fs.readFileSync(p, "utf8");
  src = src.replace(/^import \{[^}]*\} from "(?:\.\/[^"]+|cloudflare:sockets)";\n?/gm, "");
  src = src.replace(/^\s*\n/, "");

  const used = new Set(src.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []);
  const mine = own.get(f);
  const need = new Map();
  for (const s of used) {
    if (mine.has(s)) continue;
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
  fs.writeFileSync(p, (lines.length ? lines.join("\n") + "\n\n" : "") + src);
  console.log(`${f}: ${lines.length} import line(s)`);
}
