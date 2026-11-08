// 目录重排后修正 import 路径（按旧文件名 → 新路径映射）
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

const MAP = {
  util: "src/core/util.ts", const: "src/core/const.ts", state: "src/core/state.ts",
  store: "src/store/index.ts", do: "src/store/meter.ts",
  "px-score": "src/nodes/score.ts", selector: "src/nodes/selector.ts", metrics: "src/nodes/metrics.ts",
  px: "src/px/pool.ts", "px-seed": "src/px/seed.ts", "px-probe": "src/px/probe.ts",
  connection: "src/proxy/connection.ts", data: "src/proxy/session.ts",
  proto: "src/proxy/protocol.ts", net: "src/proxy/dial.ts",
  panel: "src/views/panel.ts", sub: "src/views/sub.ts",
  "test-surface": "src/test-surface.ts",
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

for (const file of walk(SRC)) {
  let s = fs.readFileSync(file, "utf8");
  const before = s;
  s = s.replace(/from "\.\/([\w-]+)"/g, (all, name) => {
    const target = MAP[name];
    if (!target) return all;
    let rel = path.relative(path.dirname(file), path.join(ROOT, target)).replace(/\\/g, "/").replace(/\.ts$/, "");
    if (!rel.startsWith(".")) rel = "./" + rel;
    return `from "${rel}"`;
  });
  if (s !== before) { fs.writeFileSync(file, s); console.log("fix", path.relative(ROOT, file)); }
}
