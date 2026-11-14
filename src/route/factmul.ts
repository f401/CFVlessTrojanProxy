import { EG } from "./egfacts";
import { PS, psFactor } from "./psfacts";
import { BLK, blkPen } from "./blkfacts";
import { DNS } from "./dnsfacts";
import { capFactor } from "./capfacts";

/**
 * 功能：把「本类事实是否启用」翻译成一个乘数。关掉就是 1，等于这条事实完全没上线。
 * @param on 启用的名字集合
 * @param name 事实名
 * @param v 该事实算出的乘数
 * @returns {number} 生效的乘数
 */
function pick(on: ReadonlySet<string>, name: string, v: number): number {
  return on.has(name) ? v : 1;
}

/**
 * 功能：把五类事实的乘数合成一个数 —— 选路代价唯一的入口。
 *
 * 为什么收成一个函数：这五个乘数以前散落在 `scoreOf` 的一行长表达式里，任何一条事实
 * 要能「单独回滚」都得手工拆那一行，极易改错。现在开关（`env.facts`）在这里统一裁剪：
 * 关掉 `blk` 就等于把 `blkPen` 换成 1，其余事实照常，**不需要重新理解表达式**。
 *
 * 纪律（v8 §15）：五类事实**只乘代价，永不剔除候选**；唯一能缩小候选集合的是 `dead`（在别处处理）。
 * @param on 启用的事实集合（见 `src/route/factflags.ts`）
 * @param host 目标站点
 * @param ip 中继 IP
 * @param mode 模式（`lat` 不看带宽）
 * @param cf 目标是否 CF 托管（出口族只对这类站点敏感）
 * @returns {number} 合计乘数
 */
export function factMul(on: ReadonlySet<string>, host: string, ip: string, mode: string, cf = false): number {
  let m = 1;
  m *= pick(on, "eg", EG.bias(ip, cf));
  m *= pick(on, "dns", DNS.penOf(host, EG.famOf(ip)));
  m *= pick(on, "ps", psFactor(host, ip));
  m *= pick(on, "cap", capFactor(ip, mode));
  m *= pick(on, "blk", blkPen(host, ip));
  return m;
}

/** 重新导出，方便调用方与测试在一个地方取到全部事实表。 */
export { EG, PS, BLK, DNS };
