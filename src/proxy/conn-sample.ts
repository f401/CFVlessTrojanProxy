import { SC } from "../core/const";

/** 低于这个下行字节数的窗口不构成「吞吐样本」（512KB / 1s 算一个标准样本） */
export const SAMPLE_STD_BYTES = 512 * 1024;

/** 吞吐样本的最小字节数：低于 64KB 的窗口噪声太大，宁可不报 */
export const SAMPLE_MIN_BYTES = 65536;

/** 站点级吞吐只认 256KB 以上的窗口（小响应算出的"速度"会反向排序） */
export const SITE_MIN_BYTES = 262144;

/** 「传了一大段」的门槛：1MB 以上才算过了慢启动，否则吞吐记 0 只保留首字节 */
export const TRANSFER_ENOUGH = 1048576;

/**
 * 功能：判断一个采样窗口里是否有一半以上的时间在背压。
 *
 * 背压窗口代表瓶颈在「客户端 → 边缘」这一跳，而不是节点能力，所以样本要打折。
 * 打折系数由调用方决定（`Connection` 用 0.3），这里只回答「是不是」。
 *
 * @param {number} stallMs 连接累计的背压毫秒
 * @param {number} stallMark 上一次采样时的累计值（窗口起点）
 * @param {number} dt 窗口时长（毫秒）
 * @returns {boolean} 是则 true
 */
export function stalledWindow(stallMs: number, stallMark: number, dt: number): boolean {
  return stallMs - stallMark > dt * 0.5;
}

/**
 * 功能：把「下行字节 + 传输耗时」换算成 KB/s，小样本记 0。
 *
 * 45KB 的正常首页在 2.5 秒里只有 18KB/s，而 4 字节的 403 页在 80 毫秒里有 46KB/s ——
 * 小样本算出来的速率会反向排序（文档 D5 / 吞吐诊断 §9.1），所以只有传够
 * `TRANSFER_ENOUGH` 才算真实吞吐，其余交给代价函数按「首字节 + 固定罚」处理。
 *
 * @param {number} down 下行字节
 * @param {number} xferMs 净传输时长（毫秒，已扣掉首字节）
 * @returns {number} KB/s；样本不足时为 0
 */
export function kbsOf(down: number, xferMs: number): number {
  if (down < TRANSFER_ENOUGH) return 0;
  return (down / 1024) * 1000 / Math.max(1, xferMs);
}

/**
 * 功能：算本窗口该给直方图贡献多少权重。
 *
 * 512KB / 1s 是「一个标准样本」；短窗口或小样本按比例降权，单连接累计封顶。
 * 折扣因子必须在封顶之前生效：否则一条「客户端是瓶颈」的连接会按满权重吃掉
 * `CONN_W_CAP`，报出去的却只有 0.3 倍 —— 它一共只贡献了 cap 的 30%，随后再也报不出样本。
 *
 * @param {number} used 本连接已贡献的权重（`sampleW`）
 * @param {number} bytes 窗口内下行字节
 * @param {number} dt 窗口时长（毫秒）
 * @param {number} factor 折扣因子（背压窗口 0.3，正常 1）
 * @returns {number} 本窗口可用权重；额度用完时为 0
 */
export function sampleWeight(used: number, bytes: number, dt: number, factor = 1): number {
  const room = SC.CONN_W_CAP - used;
  if (room <= 0) return 0;
  const raw = Math.min(1, bytes / SAMPLE_STD_BYTES) * Math.min(1, dt / 1000);
  const clamped = Math.max(0, Math.min(1, factor));
  return Math.min(room, raw * clamped);
}
