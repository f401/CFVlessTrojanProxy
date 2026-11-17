// 「站点 × 中继」成功率事实的类型与刻度常量（v8 §5 的 `ps`）。
//
// 为什么把类型和常量单独放一个文件：表本体（`ps-table.ts`）、待上报队列（`ps-outbox.ts`）、
// 先验（`ps-prior.ts`）三个模块都要认同一份形状；常量放在谁那里，都会让另外两个反向 import。
import { FACT_TTL } from "../core/facts";

/** 事实键：`站点|中继 IP`（`eg` 用 IP、`blk` 用同一个键，方便互相印证） */
export type PsKey = string;

/** 一行成功率统计：`q` 是 0..255 的成功率分位，`n` 是有效样本数 */
export interface PsRow {
  /** 0..255 的成功率（255 = 全成功） */
  q: number;
  /** 有效样本数（上限 32，衰减由乘 0.98 完成） */
  n: number;
  /** 最后一次观测时间 */
  at: number;
  /**
   * 历史最好的一次（0..255）：用来看「这条通道曾经成过」。
   * 与 `q` 分工：`q` 是现在的均值（会衰减），康复通道关心的是「曾经行过」——
   * 用 `q` 做闸门会让「成过一次、后来连着失败」的通道永远进不了康复名单（那是它唯一能回样本的机会）。
   */
  top?: number;
}

/** 一行待上报/已上报的传输形态 */
export interface PsWire {
  /** 事实键 `站点|中继 IP` */
  k: string;
  /** 0..255 成功率 */
  q: number;
  /** 有效样本数 */
  n: number;
  /** 最后观测时间 */
  at: number;
  /**
   * 历史最好（0..255）。旧行没有这个字段（7.163 前不上线）：
   * 缺省时按 `q` 起算，宁可低估也不能假装「曾经行过」。
   */
  top?: number;
}

/** 样本过期时间：45 分钟没再被观测就当没有样本（v8 §3 表） */
export const PS_TTL = FACT_TTL.ps;
/** 表上限：满了按 `at` 淘汰最旧的 */
export const PS_MAX = 512;
/** 平滑强度：先验相当于 4 个样本（Beta(4·p, 4·(1-p)) 的等效） */
export const PS_K = 4;
/** 折价因子的上下界：1/2 ～ 2，防止单次观测把代价翻十倍 */
export const FACTOR_LO = 0.5;
export const FACTOR_HI = 2;
/** 样本数上限：越老的历史越不该压住当前（配合 0.98 衰减） */
export const N_CAP = 32;

/**
 * 功能：把一条观测合成的成功率（0..1）转成 0..255 的分位。
 * @param {number} p 成功率（会被裁剪到 0..1）
 * @returns {number} 0..255
 */
export function toQ(p: number): number {
  const x = Math.max(0, Math.min(1, p));
  return Math.round(x * 255);
}
