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
// 反方向：登记了却从来没有写入点的键。这类键在 /health 与面板上恒为 0，读代码的人会以为
// 「这个功能从没触发过」，实际是「这个计数没人写」——`szBig` 就是这样挂着的一格（文档还写着
// 尺寸分桶是 `sz1..sz4/szBig`，而 `szBig` 连触发条件都不可达：桶只在 `e.down < SMALL_MAX` 里累加）。
// 三元表达式里的动态键（`cnt(this.node ? "node" : "direct")`）扫不到字面量，用显式白名单兜住。
const DYN_CNT = new Set(["node", "direct", "smN", "smD", "rgFail", "dead"]);
const literals = new Set();
for (const f of prod) {
  for (const m of fs.readFileSync(f, "utf8").matchAll(/\bcnt\("([A-Za-z0-9_]+)"/g)) literals.add(m[1]);
}
let deadCnt = 0;
for (const k of known) {
  if (literals.has(k) || DYN_CNT.has(k)) continue;
  deadCnt += 1;
  console.log(`FAIL 计数 ${k} 登记了但没有任何 cnt("${k}") 写入点（面板上恒为 0）`);
}
fail += deadCnt;
fail += cntFail;
// DO 端点的调用方与实现方必须成对：7.69 删掉 subtls 时移除了 `/meter/{probe,raw,dbt}`，
// 但调试端点仍在 POST 它们 —— `Meter.fetch` 的兜底分支是 `return this.json()`（200 + 整份计量表），
// 于是 `?draw=` / `?dbt=` 一直"返回成功"，看起来还能用。这类"调用方还在、实现方已删"的死链
// 只能靠静态比对发现（行为测试根本不会去点这些诊断端点）。
const meterSrc = fs.readFileSync("src/store/meter.ts", "utf8");
const served = new Set([...meterSrc.matchAll(/endsWith\("\/([A-Za-z0-9]+)"\)/g)].map((m) => m[1]));
// `/get` 是**故意**走兜底：`Meter.fetch` 的契约就是「其他路径返回当前值」（见它的 JSDoc），
// `meterGet` 靠这条读计量表。除它以外的未实现路径都算死链。
const FALLBACK_OK = new Set(["get"]);
let routeFail = 0;
for (const f of prod) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/https:\/\/meter\/([A-Za-z0-9]+)/g)) {
      if (!served.has(m[1]) && !FALLBACK_OK.has(m[1])) {
        routeFail += 1;
        console.log(`FAIL DO 端点 /meter/${m[1]} 不存在（${f}:${i + 1}），调用方会拿到兜底 JSON 却以为成功`);
      }
    }
  });
}
// 反方向：实现方必须有调用方。7.171 之前有两个 DO 端点「有完整实现、零调用点」——
// `/meter/http80`（DO 侧明文探测，与 debug 的 `?http=` 重复一份）与 `/meter/reset`
// （用量清零能力没有任何入口）。它们不会让任何门禁变红：调用方检查只看「调用方是否
// 有实现」，不看「实现方是否有人调」，于是能力被删了也没人发现。
let zombieFail = 0;
for (const k of served) {
  if (FALLBACK_OK.has(k)) continue;
  const used = prod.some((f) => f !== "src/store/meter.ts" && fs.readFileSync(f, "utf8").includes("https://meter/" + k));
  if (!used) {
    zombieFail += 1;
    console.log(`FAIL DO 端点 /meter/${k} 有实现但没有任何调用方（死端点：能力写着，实际不可达）`);
  }
}
fail += zombieFail;
fail += routeFail;
if (fail) {
  console.log(`\n接线扫描：${fail} 条事实没有被真实链路调用`);
  process.exit(1);
}
console.log(`接线扫描：${NEED.length} 条事实的写入/读取点全部可达`);
