// 节点数扫描：把"池子里到底有几个节点"当作唯一自变量，看选路在各档位值多少。
// 线上实测 alive=18（全是 BOOT 种子，0 个地区节点），所以小池子是**常态**而不是边界。
//   node test/mk_test.mjs
//   node tools/sim-count.mjs 12                 # 小时数
//   COUNTS=4,8,18,24,64 SEEDS=5 node tools/sim-count.mjs 24
// 复用 sim-real 的画像/时钟/上帝视角（SIM_LIB=1 只导入，不跑它的主流程）。
process.env.SIM_LIB = "1";
const { run, fmt, mean } = await import("./sim-real.mjs");

const counts = String(process.env.COUNTS || "6,8,12,18,24,32,48,64,96,128")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => x > 0);
const seeds = Number(process.env.SEEDS || 3);
const hours = Number(process.argv[2] || 12);
const seed0 = Number(process.env.SEED0 || 100);
const REAL = Number(process.env.REAL || 18); // 线上 alive 实测值，表里打标记

/** 三种负载：纯延迟 / 纯大包 / 混合（大包 25% + 相关故障 + 抖动 + 站点失败） */
const allShapes = [
  { name: "延迟", tputShare: 0 },
  { name: "吞吐", tputShare: 1 },
  { name: "混合(坏节点/抖动)", tputShare: 0.25, markov: true, jitter: 0.3, siteShare: 0.2 },
];
const shapes = process.env.SHAPE ? allShapes.filter((x) => x.name.includes(process.env.SHAPE)) : allShapes;

console.log(`节点数扫描 ${hours}h × ${seeds} 种子 / 对数正态延迟(Δtcp≈0.55) 与带宽(σ≈0.7)`);
console.log(`线上 alive = ${REAL}（←），池子里再多也没用：只有 alive 参与选路\n`);

for (const sh of shapes) {
  console.log(
    fmt(`【${sh.name}】`, 18) +
      fmt("节点", 6) +
      fmt("请求", 9) +
      fmt("失败%", 7) +
      fmt("倍率", 8) +
      fmt("P95", 7) +
      fmt(">1.5x", 7) +
      fmt("末段", 7) +
      fmt("切/小时", 8) +
      fmt("死节点%", 8) +
      "每节点请求",
  );
  for (const n of counts) {
    const rs = [];
    for (let i = 0; i < seeds; i++) rs.push(await run({ ...sh, nodes: n }, hours, seed0 + i));
    const tag = n === REAL ? " ←" : "";
    console.log(
      fmt("", 18) +
        fmt(n + tag, 6) +
        fmt(Math.round(mean(rs.map((r) => r.reqs))), 9) +
        fmt(mean(rs.map((r) => r.failPct)).toFixed(1), 7) +
        fmt(mean(rs.map((r) => r.ratio)).toFixed(2) + "x", 8) +
        fmt(mean(rs.map((r) => r.p95)).toFixed(1) + "x", 7) +
        fmt(mean(rs.map((r) => r.bad)).toFixed(0) + "%", 7) +
        fmt(mean(rs.map((r) => r.tail)).toFixed(2) + "x", 7) +
        fmt(mean(rs.map((r) => r.sw)).toFixed(1), 8) +
        fmt(mean(rs.map((r) => r.downPct)).toFixed(1), 8) +
        Math.round(mean(rs.map((r) => r.reqs)) / n),
    );
  }
  console.log("");
}
