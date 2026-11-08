// 把 tsc 报的"参数隐式 any"批量标注成显式 any（随后人工把关键签名换成真类型）
const fs = require("fs");
const lines = fs.readFileSync("/tmp/errs.txt", "utf8").split("\n");
const jobs = new Map(); // file -> [{line,col,name}]
const re = /^(src\/[\w.-]+\.ts):(\d+):(\d+)\s+Parameter '([A-Za-z_$][\w$]*)' implicitly has an 'any' type\./;
for (const l of lines) {
  const m = l.match(re);
  if (!m) continue;
  const [, f, ln, col, name] = m;
  if (!jobs.has(f)) jobs.set(f, []);
  jobs.get(f).push({ ln: +ln, col: +col, name });
}
let n = 0;
for (const [f, list] of jobs) {
  const src = fs.readFileSync(f, "utf8");
  const offsets = [];
  let off = 0;
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  for (const { ln, col, name } of list) {
    const pos = lineStarts[ln - 1] + col - 1;
    if (!src.startsWith(name, pos)) { console.error(`skip ${f}:${ln}:${col} ${name}`); continue; }
    const after = src[pos + name.length];
    if (after === ":" || after === "?") continue;
    offsets.push({ pos: pos + name.length, text: ": any" });
  }
  offsets.sort((a, b) => b.pos - a.pos);
  let out = src;
  for (const o of offsets) out = out.slice(0, o.pos) + o.text + out.slice(o.pos);
  fs.writeFileSync(f, out);
  n += offsets.length;
  console.log(`${f}: +${offsets.length}`);
}
console.log("total", n);
