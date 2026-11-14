/**
 * 写入路径撞车实验（§37）：`ps` 批量写到 DO 的「会不会丢、额度上限在哪」
 *
 * 背景：§34.4 发现「逐条写 = DO 请求数 = 用户请求数，10 万/天被打满」，
 *       §22.4 于是规定「每 isolate 攒 16 条样本或 60 秒才写」。
 *       但生产实测 isolate 平均只活 3 条连接 —— 攒不到 16 条就死了。
 *
 * 本实验只回答**可以用算术精确回答**的问题：
 *   Q1 攒不够时样本去哪了？
 *   Q2 写一次最多几行、每天能写多少次、额度上限对应多少连接？
 *   Q3 超过上限时有哪些降级手段，各自的收敛代价是多少？
 *
 * 不回答「丢了 ps 成功率掉多少」——那由 §29 / §33 的已验证模型负责，
 * 在这里重新推导只会给出一个没校准的数字（§35.4 的教训）。
 *
 * 纯本地、零网络。运行：node tools/exp-writeburst.mjs
 */

const CONNS_PER_ISO = 3; // 生产实测：低流量客户端每 isolate 约 3 条连接
const DO_QUOTA = 100000; // DO 请求 10 万/天（§23）
const RELAYS = 8;

/**
 * 统计一种批量策略下「每次冲写几行」与「丢弃率」。
 *
 * @param {number} B 攒够多少行写一次
 * @param {boolean} flushOnDeath isolate 结束（3 条连接用尽）时是否把余量写掉
 * @param {number} every 每 k 个 isolate 才真正写一次（抽样降级，默认 1 = 不抽样）
 * @returns {{ rowsPerWrite: number, lostRatio: number }} 平均每次写几行 / 样本丢弃比例
 */
function policy(B, flushOnDeath, every = 1) {
  const iso = CONNS_PER_ISO;
  // 攒满几批：批量超过 isolate 寿命时一批也攒不满（§22.4 的原写法就栽在这里）
  const full = Math.floor(iso / B);
  const rest = iso % B;
  let writes = full;
  let rows = full * B;
  if (rest > 0 && flushOnDeath) {
    writes += 1;
    rows += rest;
  }
  // 抽样降级：只有 1/every 的 isolate 会真的写，其余样本直接丢弃
  const lostRatio = 1 - (rows / iso) * (every === 1 ? 1 : 0);
  return {
    rowsPerWrite: writes ? rows / writes : 0,
    lostRatio: every === 1 ? lostRatio : 1 - rows / iso / every,
    writesPerIso: writes,
  };
}

/**
 * 给定「每天连接数」与策略，算每天 DO 请求数与每中继每天样本数。
 *
 * @param {number} connsPerDay 每天用户连接数
 * @param {number} B 批量行数
 * @param {boolean} flushOnDeath 死亡时冲写
 * @param {number} every 每 k 个 isolate 抽样写一次
 * @returns {{ req: number, perRelay: number }} DO 请求/天、每个中继每天拿到多少样本
 */
function daily(connsPerDay, B, flushOnDeath, every = 1) {
  const isolates = Math.floor(connsPerDay / CONNS_PER_ISO);
  const p = policy(B, flushOnDeath, every);
  // 抽样时只有 1/every 的 isolate 会写，每次写的行数不变
  const writers = every === 1 ? isolates : Math.floor(isolates / every);
  const writes = writers * p.writesPerIso;
  const samples = writes * p.rowsPerWrite;
  return { req: writes, perRelay: Math.floor(samples / RELAYS) };
}

const t = [];
const ok = (name, cond, detail) => {
  t.push({ name, cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

console.log("策略                       每次写几行  丢弃%  40万连接/天: DO请求  每中继样本/天");
for (const [name, B, death, every] of [
  ["逐条写（B=1）", 1, true, 1],
  ["B=2 死亡冲写", 2, true, 1],
  ["B=4 死亡冲写", 4, true, 1],
  ["B=16 死亡不冲写（§22.4 原写法）", 16, false, 1],
  ["B=16 死亡冲写（=每 isolate 一次）", 16, true, 1],
  ["B=16 死亡冲写 + 每 2 个 isolate 写", 16, true, 2],
  ["B=16 死亡冲写 + 每 3 个 isolate 写", 16, true, 3],
]) {
  const p = policy(B, death, every);
  const d = daily(400000, B, death, every);
  console.log(
    `${name.padEnd(34)}  ${p.rowsPerWrite.toFixed(1).padStart(10)}  ` +
      `${(100 * p.lostRatio).toFixed(0).padStart(5)}%  ${String(d.req).padStart(17)}  ${String(d.perRelay).padStart(15)}`
  );
}

console.log("\n额度上限（每次写 3 行、不抽样）:");
for (const conns of [100000, 200000, 300000, 400000]) {
  const d = daily(conns, 16, true, 1);
  console.log(`  ${String(conns).padStart(7)} 连接/天 → DO 请求 ${String(d.req).padStart(7)} / 天  ${d.req > DO_QUOTA ? "超额度" : "OK"}`);
}

const p16 = policy(16, false, 1);
const p16d = policy(16, true, 1);
const d300 = daily(300000, 16, true, 1);
const d400 = daily(400000, 16, true, 1);
const d400s2 = daily(400000, 16, true, 2);

const d400b1 = daily(400000, 1, true, 1);
ok("死守「16 条或 60 秒」在 3 连 isolate 下永远攒不满 → 全丢", p16.lostRatio === 1, `丢弃 ${(100 * p16.lostRatio).toFixed(0)}%`);
ok("死亡时冲写能把丢弃降到 0", p16d.lostRatio === 0);
ok("每次写最多 3 行（= isolate 寿命）", p16d.rowsPerWrite === 3, `${p16d.rowsPerWrite.toFixed(0)} 行`);
ok("逐条写（B=1）在 40 万连接下远超额度", d400b1.req > DO_QUOTA, `${d400b1.req} 次/天`);
ok("30 万连接/天刚好在额度内", d300.req <= DO_QUOTA, `${d300.req} 次/天`);
ok("40 万连接/天会超额度 → 必须抽样", d400.req > DO_QUOTA, `${d400.req} 次/天`);
ok("每 2 个 isolate 抽样写可把 40 万连接压回额度内", d400s2.req <= DO_QUOTA, `${d400s2.req} 次/天`);

const bad = t.filter((x) => !x.cond);
console.log(`\n断言：${t.length - bad.length}/${t.length} 通过`);
process.exit(bad.length ? 1 : 0);
