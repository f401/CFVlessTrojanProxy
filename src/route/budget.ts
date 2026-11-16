// 子请求预算：一轮 cron 给「准入探活」多少次 connect()，以及还剩多少 fetch 子请求额度。
// 这是两笔账，不能混：
//   ① connect() 探活吃的是「同时打开的 socket」额度（SC.PROBE_CONC = 6），不占 fetch 子请求；
//   ② fetch 子请求免费计划一次调用 50 个（SC.SCAN_SUB 取 48 留余量），由各消费者自己的上限
//      保证：refillPool 最多 6 个源、tfbRound 1 批、dnsRound（DNS_BATCH × DoH 服务数）、pendFlush 1 次、
//      快照 4 次。把这些固定支出从硬上限里扣掉，剩下来的才是可以自由分配的额度
//      （restorePick 用它决定一轮能续回多少个用户）。
// 7.186 之前这里还有一个 `cap` 字段自称「本轮总闸」，但它零读取点：单测拿它当上界做断言，
// 生产侧从来没有任何减法 —— 等于在验证一条不存在的约束（六型里的「假仪表」）。
import { SC } from "../core/const";
import { S } from "../core/state";
import { vAll } from "./verdict";
import { DOH_ENDPOINTS } from "../proxy/dial";
import { REFILL_MAX } from "../px/probe";
import { RESTORE_MAX } from "../store/snapshot";

/**
 * 一批 tfbRound 在**调用方**这一侧要发几次 DO 子请求。
 *
 * `runTfb` 先打一次 `/meter/tf` 让 DO 自己直连目标（直连也算一条通道：DO 的出口族与中继不同，
 * 常常正好一个 403 一个 200），再打一次 `/meter/tfb` 让 DO 逐条中继去抓。两次都在 `cron` 的账上；
 * DO 内部再向外抓的那几次记在 DO 自己那一笔（同一个免费额度池，但不由这里扣）。
 */
export const TFB_CALLS = 2;

/**
 * 每轮最多给几个站点做 AAAA 探测。
 *
 * 单列出来是为了让 `SUB_FIXED.dns` 能按真实最坏情况推导：一个站点要依次试
 * `DOH_ENDPOINTS` 里的每个解析服务（前一个报错或非 NOERROR 才换下一个），
 * 所以最坏是「站点数 × 解析服务数」次 fetch —— 7.239 之前这里写死 2，比真实最坏少了 4 次。
 */
export const DNS_BATCH = 2;

/**
 * 一轮 cron 里**次数固定**的 fetch 子请求支出：每个数字都对应一个真实调用点，改调用点就要同步这里。
 *
 * 只放「一轮固定几次」的项。三批「每人一次 DO 往返」的消费者（增量上报 / 灾备快照 / 用量回填）
 * **不在这里** —— 它们的人数由剩余额度决定，见 `planRound` 的分账（7.242 之前 `pend: 1`、
 * `snap: 4` 按调用点数计，而真实最坏是 32 + 24 次 DO 往返，一轮能到 82 次，越过免费计划 50 次硬上限）。
 * 不把探活算进来：探活走 connect()，不吃 fetch 子请求额度。
 * 也不把 `usageSnapGet` / `loadUsers` / `flushPx` 算进来：它们只打 KV，不吃子请求额度。
 */
export const SUB_FIXED = {
  refill: REFILL_MAX, // refillPool：最多 REFILL_MAX 个池子源（冷却中的源在池子够多时会被跳过）
  tfb: TFB_CALLS, // tfbRound：一次直连探针 + 一次中继批（DO 内部的抓取记在它自己那笔账上）
  dns: DNS_BATCH * DOH_ENDPOINTS.length, // dnsRound：DNS_BATCH 个站点 × 每站点最多 DOH_ENDPOINTS.length 次 DoH
} as const;

/** 固定支出合计：订阅端与单测直接拿它和硬上限对账 */
export const SUB_FIXED_N = SUB_FIXED.refill + SUB_FIXED.tfb + SUB_FIXED.dns;

/**
 * 「每人一次 DO 往返」的三批消费者在剩余额度里的占比：增量上报 50%、灾备快照 30%，回填拿剩下的。
 *
 * 上报最频繁（每轮都可能有人攒着增量），快照 2 小时才写一次，回填是灾备路径（DO 被回收后才有活干），
 * 所以按这个优先级切；三者之和恒等于剩余额度，谁也不会把别人挤成 0。
 */
export const SHARE_PEND = 0.5;
export const SHARE_SNAP = 0.3;

export interface Plan {
  adm: number; // 池子准入探活（新增候选），单位是 connect() 次数
  sub: number; // 扣掉固定支出后剩余的 fetch 子请求额度（= pend + snap + restore + 余量）
  pend: number; // 本轮增量上报最多带几个用户（每人一次 DO 往返）
  snap: number; // 本轮灾备快照最多读几个用户的用量（每人一次 DO 往返）
  restore: number; // 本轮最多回填几个用户的用量（每人一次 DO 往返）
}

/**
 * 功能：算出一轮 cron 的额度分配。
 * @param {number} poolN 池子大小（预算已与池子解耦，保留签名是因为 `?vt=` 与单测按它取数）
 * @param {number} aliveN 活跃池大小（同上，不参与计算）
 * @returns {Plan} 准入次数 + 剩余 fetch 额度
 */
export function planRound(poolN: number, aliveN: number): Plan {
  // 两个参数只为兼容调用方签名：判定侧扫描在 7.69 删 userland TLS 后就没额度了，
  // 7.149 把那条只剩空壳的维度（round.ts）一起删掉，预算因此与池子彻底解耦。
  void poolN;
  void aliveN;
  // 探活走 connect()，不吃 fetch 子请求：按「本轮最多扫多少」给满，硬上限仍是 SCAN_SUB
  const adm = Math.max(1, Math.min(SC.SCAN_MAX, SC.SCAN_SUB));
  // 固定支出必须先扣：扣完仍为正，才是能自由分配的额度（负数说明固定支出本身就超预算了）
  const sub = Math.max(0, SC.SCAN_SUB - SUB_FIXED_N);
  // 两批按占比切，回填拿剩下的：三者之和恒 ≤ sub，所以「固定 + 三批」不会越界。
  // 各自再夹到自己的硬上限（PEND_MAX / SNAP_MAX / RESTORE_MAX），额度富裕时也不会多花。
  const cap = (n: number, top: number) => Math.min(top, Math.max(0, Math.floor(n)));
  const pend = cap(sub * SHARE_PEND, SC.PEND_MAX);
  const snap = cap(sub * SHARE_SNAP, SC.SNAP_MAX);
  const restore = cap(sub - pend - snap, RESTORE_MAX);
  return { adm, sub, pend, snap, restore };
}

/**
 * 功能：供调试端点与日志用的快照（不参与决策）。
 * @param {number} poolN 池子大小
 * @param {number} aliveN 活跃池大小
 * @returns {Plan & { verds: number; site: string }} 预算 + 判定表行数 + 最近站点
 */
export function planView(poolN: number, aliveN: number): Plan & { verds: number; site: string } {
  const p = planRound(poolN, aliveN);
  return { ...p, verds: vAll().length, site: S.site || "" };
}
