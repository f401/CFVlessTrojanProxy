// 给指定文件补 import：扫描全仓顶层声明，按"用了但没定义也没引入"补上
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const DECL = /^(?:export\s+)?(async\s+function\*?|function\*?|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const files = walk(SRC);
const owner = new Map();
for (const f of files) {
  let inTpl = false;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const ticks = (line.match(/`/g) || []).length;
    if (!inTpl) {
      const m = line.match(DECL);
      if (m && m[2] !== "default") owner.set(m[2], f);
    }
    if (ticks % 2 === 1) inTpl = !inTpl;
  }
}

const target = path.resolve(process.argv[2]);
const texts = walk(SRC).map((f) => [f, fs.readFileSync(f, "utf8")]);
let src = fs.readFileSync(target, "utf8");
const declaredHere = new Set([...src.matchAll(new RegExp(DECL.source, "gm"))].map((m) => m[2]));
const imported = new Set();
for (const m of src.matchAll(/import \{([^}]*)\} from/g)) {
  for (const s of m[1].split(",")) imported.add(s.trim().split(/\s+as\s+/)[0]);
}
const used = new Set(src.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []);
const bySpec = new Map();
for (const u of used) {
  if (declaredHere.has(u) || imported.has(u)) continue;
  if (u.length < 3 && !["S", "SEL", "SC", "P_T", "P_V"].includes(u)) continue;
  const f = owner.get(u);
  if (!f || f === target) continue;
  let rel = path.relative(path.dirname(target), f).replace(/\\/g, "/").replace(/\.ts$/, "");
  if (!rel.startsWith(".")) rel = "./" + rel;
  if (!bySpec.has(rel)) bySpec.set(rel, []);
  bySpec.get(rel).push(u);
}
let out = "";
for (const [spec, syms] of [...bySpec.entries()].sort()) out += `import { ${[...new Set(syms)].sort().join(", ")} } from "${spec}";\n`;
out += "\n" + src;
fs.writeFileSync(target, out);
console.log("added", bySpec.size, "import line(s)");
