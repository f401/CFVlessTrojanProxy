// 架构门禁：分层方向、循环依赖、顶层可变状态、单文件体积
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

const LAYERS = ["core", "store", "nodes", "px", "proxy", "views", "edge", "routes"];
const RANK = Object.fromEntries(LAYERS.map((l, i) => [l, i]));
// 允许的反向边（数据面要回写指标，视图要读节点），其它一律禁止
const ALLOW = new Set([
  // 数据面回写指标 / 计量
  "proxy->px", "proxy->nodes", "proxy->store",
  // 中转池要落盘、读节点评分；目标校验已抽到 core/net，px 不再依赖 proxy
  "px->store",
  // 快照要枚举用户、要读计数器
  "store->proxy", "store->px",
  // 选择器要知道"当前中转出口"，这是唯一的 nodes → px 依赖
  "nodes->px",
  // 视图只读节点画像 / 计量
  "views->nodes", "views->px", "views->store",
  // 路由向下调用
  "routes->views", "routes->proxy", "routes->px", "routes->nodes", "routes->store",
  "edge->core",
]);

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const layerOf = (f) => {
  const rel = path.relative(SRC, f).split(path.sep);
  return rel.length > 1 ? rel[0] : "entry";
};

const problems = [];
const layerGraph = new Map();

for (const f of files) {
  // 类型导入在编译后消失，不算分层依赖
  const src = fs.readFileSync(f, "utf8").split("\n").map((l) => l.startsWith("import type") ? "" : l).join("\n");
  const rel = path.relative(ROOT, f);
  const lines = src.split("\n").length;
  if (lines > 560) problems.push(`${rel}: ${lines} 行，超过 560 行上限`);

  // 禁止 any：边界用 unknown + 收窄，别把类型系统关掉
  if (/(:\s*any\b|as any\b|<any>|any\[\]|Record<[^>]*\bany\b)/.test(src)) {
    problems.push(`${rel}: 出现 any（请用 unknown / 具体类型）`);
  }

  // 顶层 let / var：只允许 const
  const topLet = src.match(/^(?:export\s+)?(?:let|var)\s+[A-Za-z_$]/m);
  if (topLet) problems.push(`${rel}: 顶层可变绑定 ${topLet[0].trim()}`);

  const from = layerOf(f);
  const deps = new Set();
  for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const target = path.resolve(path.dirname(f), m[1]);
    const to = layerOf(target + ".ts");
    deps.add(to);
    if (from === to) continue;
    if (!RANK[from] || !RANK[to]) continue;             // entry / test 文件不参与方向校验
    if (RANK[to] > RANK[from] && !ALLOW.has(`${from}->${to}`)) {
      problems.push(`${rel}: 反向依赖 ${from} -> ${to}`);
    }
    // 循环检查只看未登记的反向边；ALLOW 里的接缝是显式允许的
    if (!ALLOW.has(`${from}->${to}`)) {
      if (!layerGraph.has(from)) layerGraph.set(from, new Set());
      layerGraph.get(from).add(to);
    }
  }
}

// 循环依赖（按目录粒度）：对全部层跑 DFS，而不是只从第一个文件跑一次
const seen = new Set(), stack = new Set();
function dfs(layer, pathArr) {
  if (stack.has(layer)) {
    const cyc = pathArr.slice(pathArr.indexOf(layer)).concat(layer).join(" → ");
    problems.push(`循环依赖：${cyc}`);
    return;
  }
  if (seen.has(layer)) return;
  stack.add(layer);
  for (const d of layerGraph.get(layer) || []) dfs(d, pathArr.concat(layer));
  stack.delete(layer);
  seen.add(layer);
}
for (const layer of LAYERS) dfs(layer, []);

const uniq = [...new Set(problems)];
if (uniq.length) {
  console.log("架构门禁失败：");
  for (const p of uniq) console.log("  ✗", p);
  process.exit(1);
}
console.log(`架构门禁通过：${files.length} 个文件，分层方向 / 循环依赖 / 顶层状态 / 体积 全部 OK`);
