// 接线扫描：确认 v8 的每条事实都有「生产侧」的写入点与读取点。
//
// 为什么需要它：单测与集成验收都能通过，但事实仍可能是死代码 —— 例如 `EG.note` 只在
// `probeEg` 里被调用，而 `probeEg` 只挂在调试端点上，那么线上永远不会写入出口族事实，
// 「把首请求成功率从 40% 抬到 90%」这条最贵的收益就完全没上线。这类问题不会被任何
// 行为测试抓到（行为测试调的是函数本身），只能靠静态检查「谁在调用它」。
//
// 规则：每个符号必须至少有一个调用点，且不能只出现在它自己的定义文件里。
import fs from "node:fs";
import path from "node:path";

/** 待检查的符号 → 允许的「自己人」文件（定义处，不算调用点） */
const NEED = [
  { sym: "EG.bias", own: "src/route/egfacts.ts", why: "选路读取出口族" },
  { sym: "PS.note", own: "src/route/psfacts.ts", why: "成功率事实的写入点（judge 按 commitFact 裁决）" },
  { sym: "EG.note", own: "src/route/egfacts.ts", why: "出口族写入点（在 egDerive 内）", via: "egDerive" },
  { sym: "psFactor", own: "src/route/psfacts.ts", why: "选路读取成功率" },
  { sym: "deadNote", own: "src/route/deadfacts.ts", why: "连不上事实的写入点" },
  { sym: "isDead", own: "src/route/deadfacts.ts", why: "选路读取判死" },
  { sym: "BLK.note", own: "src/route/blkfacts.ts", why: "封锁事实的写入点" },
  { sym: "blkPen", own: "src/route/blkfacts.ts", why: "选路读取封锁" },
  { sym: "FO.note", own: "src/core/firstobs.ts", why: "冷启动观测写入点" },
  { sym: "DNS.penOf", own: "src/route/dnsfacts.ts", why: "选路读取 AAAA 事实" },
  { sym: "probeFam", own: "src/proxy/dial.ts", why: "AAAA 探测的生产调用点" },
  { sym: "egDerive", own: "src/route/egfacts.ts", why: "出口族推导的生产调用点（judge.onTraffic）" },
  { sym: "commitFact", own: "src/route/commitfact.ts", why: "写入决策器被真实链路调用" },
  { sym: "CAP.note", own: "src/route/capfacts.ts", why: "吞吐容量写入点（经 HOOK.capNote 的薄包装 capNote）", via: "capNote" },
  { sym: "capFactor", own: "src/route/capfacts.ts", why: "选路读取容量比" },
];

// 槽位不是「调用」而是「注册」：符号扫描看不见它们，于是出现过一个真洞 ——
// `HOOK.facts` 从来没被赋值，`?facts=none` 只影响 /health 显示、不影响选路，
// 而所有行为测试都通过（它们直接调 factMul）。这里补一条静态检查。
const SLOTS = ["facts", "factsFor", "factsDelta", "decide", "vtLoad"];

const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith(".ts")) files.push(p.replace(/\\/g, "/"));
  }
};
walk("src");
// 测试窗口本身不算生产调用点：它存在的意义就是给测试拿符号
const prod = files.filter((f) => !f.includes("test-surface"));

let fail = 0;
for (const n of NEED) {
  const needle = n.via || n.sym;
  const hits = prod.filter((f) => f !== n.own && fs.readFileSync(f, "utf8").includes(needle));
  if (!hits.length) {
    fail += 1;
    console.log(`FAIL ${n.sym} 没有生产调用点（${n.why}）`);
  }
}
// HOOK 槽位：proxy 层只读不赋值，赋值必须发生在别处（route 层注册）
let slotFail = 0;
for (const name of SLOTS) {
  const needle = `HOOK.${name} =`;
  const hits = prod.filter((f) => fs.readFileSync(f, "utf8").includes(needle));
  if (!hits.length) {
    slotFail += 1;
    console.log(`FAIL HOOK.${name} 从未被注册（读它的代码会静默退回默认行为）`);
  }
}
fail += slotFail;
// 计数字面量必须在 S.cntKeys 登记：漏登记时 cnt() 只打一行 `[cnt] unknown key` 就静默丢计数，
// 面板和 /health 会显示「这个功能从没触发过」——这类缺陷靠读代码很难看出来。
const stSrc = fs.readFileSync("src/core/state.ts", "utf8");
const keyBlock = (stSrc.match(/cntKeys = \[([\s\S]*?)\]/) || [])[1] || "";
const known = new Set([...keyBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
let cntFail = 0;
for (const f of prod) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/\bcnt\("([A-Za-z0-9_]+)"/g)) {
      if (!known.has(m[1])) {
        cntFail += 1;
        console.log(`FAIL 计数 ${m[1]} 未登记（${f}:${i + 1}），会静默丢失`);
      }
    }
  });
}
fail += cntFail;
if (fail) {
  console.log(`\n接线扫描：${fail} 条事实没有被真实链路调用`);
  process.exit(1);
}
console.log(`接线扫描：${NEED.length} 条事实的写入/读取点全部可达`);
