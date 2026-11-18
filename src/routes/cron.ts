import { eachLimit, errMsg } from "../core/util";

import { logErr } from "../nodes/metrics";
import { BudgetLedger } from "../core/budget-ledger";
import { BudgetedIO } from "../core/budgeted-io";
import { S } from "../core/state";
import { cnt } from "../core/counter";
import { CRON_LOCK } from "../core/lock";
import { cronScan, flushPx } from "../px/pool";
import { DNS_BATCH, planRound } from "../route/budget";
import { runTfb } from "../route/tfb";
import { TFB } from "../route/tfbbook";
import { DNS } from "../route/dnsfacts";
import { probeFam } from "../proxy/dial";
import { SEL } from "../px/selector";
import { flushSnap, PEND, restorePick, restoreUsage, usageSnapGet, usageSnapWrite } from "../store/index";
import { loadUsers } from "../proxy/protocol";

/**
 * 定时任务（每 30 分钟）：探活候选池 → 推计量 → 落 seed → 续回并写用量快照。
 * 每轮每类最多写一次 KV，避免额度被定时任务吃掉。
 * cronBusy：Cron Triggers 偶发重投递（同事件 30 分钟内可能来两次），或者手动
 * refresh=1 和 cron 撞车；两轮 cronScan 同时跑会双写 seed、双跑探活。
 */
export async function runCron(env: Env, ctx: ExecutionContext): Promise<void> {
  // 闸门检查在 waitUntil 之前：忙时连任务都不排，而不是排一个立即返回的空任务。
  // 同一 isolate 内 JS 单线程，check + set 之间不会被打断。
  // 闸门是「持有时间戳 + 截止时间」：上一轮超过 CRON_STALE_MS 还没收尾就允许接管，
  // 否则一次卡死的 DO 子请求会让这个 isolate 的 cron 永久停摆（连手动 refresh 也被挡）。
  if (!CRON_LOCK.claim()) return;
  ctx.waitUntil(
    (async () => {
      try {
        await cronOnce(env);
      } finally {
        CRON_LOCK.release();
      }
    })(),
  );
}

/**
 * 功能：每轮挑一个待验站点跑一批 tfb（每站点 30 分钟最多 3 批，不写 KV）。
 * @param env 环境变量
 * @returns 无
 */
async function tfbRound(env: Env): Promise<void> {
  const now = Date.now();
  // 站点过期就把「上一批判定」一起清；起搏记账由 TFB.sweep 按 keep 清理 ——
  // 它同时覆盖「被 trimAged 从 needPx 挤掉」的站点，旧版只清过期那一类，剩下的是永久留行
  for (const [h, t] of S.needPx) if (t <= now) { S.needPx.delete(h); S.tfbV.delete(h); }
  TFB.sweep(S.needPx, now);
  for (const [host, until] of S.needPx) {
    if (until <= now) continue;
    // due() 里含三道坎：10 分钟间隔、30 分钟窗口归零、每窗口最多 3 批
    if (!TFB.due(host, now)) continue;
    TFB.take(host, now);
    cnt("tfb");
    await runTfb({ env } as unknown as Parameters<typeof runTfb>[0], host, 2);
    return;
  }
}



/**
 * 功能：为待决策站点确证「有没有 AAAA」—— 纯 v4 站点在 v6 出口上结构性过不去，
 * 提前知道就能少发一条注定失败的请求、也少浪费一次探索预算。
 * 只处理 `needPx` 里尚未过期的站点、每轮最多 DNS_BATCH 个（每个站点最多 DOH_ENDPOINTS.length 次 DoH：
 * @returns {Promise<void>}
 */
async function dnsRound(gate: BudgetedIO): Promise<void> {
  try {
    const now = Date.now();
    const hosts = [...S.needPx.entries()]
      .filter(([, until]) => until > now)
      .map(([h]) => h)
      .filter((h) => DNS.v6Of(h, now) < 0)
      .slice(0, DNS_BATCH);
    for (const h of hosts) {
      const r = await probeFam(h, gate);
      if (r.answered) DNS.note(h, r.v6, now);
    }
    if (hosts.length) cnt("dnsProbe", hosts.length);
  } catch {
    /* DoH 失败不影响其它环节 */
  }
}
/**
 * 功能：cron 主流程：算预算 → 准入复测 → 站点探测 → 入口扫描 → 快照。
 * @param env 环境变量
 * @returns 无
 */
async function cronOnce(env: Env): Promise<void> {
  // 一轮 cron 的额度先算清：探活次数（connect 账）与剩余 fetch 额度（子请求账）。
  // 放在最外层是因为下面三段都要用：准入探活用 adm，续回用户数用 sub。
  const plan = planRound(S.pool.length, S.alive.size);
  // 一轮 cron = 一份额度：池子扫描、站点判定、DoH 探测都从这里取号（7.362）
  const gate = new BudgetedIO(new BudgetLedger("cron"));
  try {
    // 准入吃满本轮预算即可：加码函数 alivePlan 在 7.179 删除（它永远是恒等变换，见 ALIVE_TARGET 的文档）
    await cronScan(env, plan.adm);
    await tfbRound(env);
    await dnsRound(gate);
    SEL.afterScan(env);
  } catch (e) {
    logErr(`cron: ${errMsg(e)}`);
  }
  // 定时持久化的唯一入口：每轮 cron 最多各写 1 次
  try {
    await PEND.flush(env, true, plan.pend);
  } catch (e) {}
  // cronScan 内部已经落过一次 seed（且自带 55 分钟节流），这里只补写脏数据
  try {
    if (S.seedDirty) {
      // flushPx 不抛错，只用返回值报告失败（seed 读失败、KV 写失败都在里面）：
      // 以前直接把返回值丢掉，于是「池子代际没前进」在别处表现为「选路慢慢变差」，查不到源头
      const fx = await flushPx(env);
      if (!fx.ok) {
        cnt("seedWriteFail");
        logErr(`seed write: ${fx.err || "unknown"}`);
      }
    }
  } catch (e) {}
  try {
    // 先把快照续回 DO（重建脚本后不会从 0 开始），再写新快照。
    // 用户一多时 50 个 /set 同时飞出去会把 cron 的 CPU 拉满，限 8 并发。
    const snap = await usageSnapGet(env);
    if (snap && snap.users) {
      // 每次恢复 = 1 个 DO 子请求：不限量时用户一多就会撞 50 个子请求上限，
      // 而这里的 catch 会吞掉异常、顺带跳过下面的快照写 —— 表现为「用量越用越不记」。
      const allIds = Object.keys(snap.users);
      // 一轮能续回多少个用户，由剩余 fetch 额度决定（plan.sub）：以前写死 12，
      // 与 48 的硬上限没有任何数量关系，加到第 5 个消费者时就会静默撞线（7.186）。
      const pick = restorePick(allIds, plan.restore);
      cnt("restore", pick.length);
      if (allIds.length > pick.length) cnt("restoreSkip", allIds.length - pick.length);
      await eachLimit(pick, 8, (id) => restoreUsage(env, id, snap).then(() => undefined));
    }
    const users = await loadUsers(env);
    // 读 KV 失败且没有完整缓存时 list 可能缺托管用户：此时写快照会把
    // 这些用户的历史用量整份抹掉，宁可这一轮不写
    if (users.ok !== false) await usageSnapWrite(env, users.list, plan.snap);
    else cnt("snapUsersFail"); // 用户表读失败 → 这轮不写快照（防抹掉用量），但要能看见
  } catch (e) {}
  // 不传 force：让 flushSnap 走「1h/2h + 全局 45 分钟闸门」的节奏
  try {
    await flushSnap(env);
  } catch (e) {}
}

