import { SOURCES } from "./probe";

/**
 * 活跃池的目标规模。
 *
 * 为什么是 16：仿真里「稳态好出口比例」只有 `r/(d+r) ≈ 0.286`（d=5%/h 掉线、r=2%/h 恢复），
 * 池子 8 条时「好出口 < 2 条」的概率 28.5%，12 条 10.2%，16 条降到 **3.4%**；
 * 而把复检频率拉到最大也只能把缺货率压到 26.7% —— 探测频率买不来供给，只有池子大小能。
 *
 * 这个数字**只作判据**：`/health` 的 `relays.short` 用它回答「池子够不够」。
 * 7.179 之前它还有一个消费者 `alivePlan()`，按「离目标差多少」给扫描加码 ——
 * 但那个加码永远是恒等变换（预算 `budget.ts` 的 `adm` 恒等于 `SC.SCAN_SUB`，
 * 而加码值最大只有 `16 - 0 + 4 = 20`，`cronScan` 里又会被 `sub` 夹回去），
 * 也就是说「缺货就多扫」这件事从 7.149 起就没有真正发生过，函数已删。
 */
export const ALIVE_TARGET = 16;

/**
 * 功能：源健康度概览 —— `/health` 用，回答「补货是不是一直失败」。
 * 补货成功与否决定了能否维持 16 条活跃池；而 6 个公开源实测每轮都有 1–4 个失败
 * （可达 1/6、3/6、2/6），失败时不看不出来，只能靠这个数。
 * @returns {{ bad: number; retryAt: number }} 当前失败的源数量、最早恢复时间
 */
export function srcStat(): { bad: number; retryAt: number } {
  const snap = SOURCES.snap();
  let bad = 0;
  let retryAt = 0;
  for (const k of Object.keys(snap)) {
    const v = snap[k];
    if (!v || !v.until || v.until <= Date.now()) continue;
    bad += 1;
    if (!retryAt || v.until < retryAt) retryAt = v.until;
  }
  return { bad, retryAt };
}
