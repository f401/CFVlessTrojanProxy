// 多机房隔离回归：每个机房加载独立测试包实例，只交换节点名字与地址。
// 历史跨机房统计合并实验依赖已删除的 packNode/unpackNode，不能再冒充当前选路实现。
// node tools/sim-colo.mjs [小时数]；只做本地确定性模拟，不访问网络。
import path from "node:path";
import { pathToFileURL } from "node:url";
const hours = Math.max(1, Number(process.argv[2]) || 2);
const ticks = Math.min(1440, Math.ceil(hours * 60));
const colos = ["AMS", "SIN", "LAX", "FRA"];
const bundle = pathToFileURL(path.resolve("test/_bundle.mjs"));
const isolates = await Promise.all(colos.map(async (colo) => {
  const url = new URL(bundle); url.searchParams.set("isolate", colo);
  return import(url.href);
}));
const now = Date.now;
let clock = Date.UTC(2026, 0, 1);
Date.now = () => clock;
try {
  for (let tick = 0; tick < ticks; tick++) {
    clock += 60000;
    for (let ci = 0; ci < isolates.length; ci++) {
      const W = isolates[ci];
      W.ISOLATE.capture("fixture.example", colos[ci]);
      for (let ni = 0; ni < 24; ni++) {
        const key = "node-" + ni + ":443";
        const local = ni % colos.length === ci;
        const latency = (local ? 40 : 140 + ci * 20) + ni;
        W.NODE_MEMORY.alive.set(key, { h: "node-" + ni, p: 443, cc: colos[ci], ms: latency });
        W.NodeStatsTable.nsProbe(key, latency, latency - 20, 20);
        W.NodeStatsTable.nsLatency(key, latency);
      }
    }
  }
  const before = isolates.map(W => W.NodeStatsTable.nsGet("node-0:443").msLocal);
  const names = [...isolates[0].NODE_MEMORY.alive.keys()].map(key => isolates[0].SEED_STORE.packName(key));
  if (names.some(row => Object.keys(row).some(key => !["k", "h", "p", "cc", "q"].includes(key)))) throw Error("seed leaked local samples");
  for (const W of isolates) W.SEED_STORE.document.byColo["*"] = { nodes: structuredClone(names), ts: clock };
  const after = isolates.map(W => W.NodeStatsTable.nsGet("node-0:443").msLocal);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw Error("shared names changed local samples");
  if (new Set(after).size !== colos.length) throw Error("different paths lost local latency");
  for (let i = 1; i < isolates.length; i++) {
    if (isolates[i].NODE_MEMORY.stats === isolates[0].NODE_MEMORY.stats) throw Error("isolates share statistics identity");
    if (isolates[i].SEED_STORE.document === isolates[0].SEED_STORE.document) throw Error("isolates share seed identity");
  }
  console.table(colos.map((colo, i) => ({ colo, localLatencyMs: before[i], afterNameSharingMs: after[i], nodes: isolates[i].NODE_MEMORY.alive.size })));
  console.log("机房隔离：通过 4 个独立实例；共享 24 个名字，统计与种子对象均独立。模拟分钟=" + ticks);
} finally {
  Date.now = now;
}
