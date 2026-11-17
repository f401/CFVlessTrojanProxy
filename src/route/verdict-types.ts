// 判定表的公开类型与过期时间：表本体（verdict-table.ts）与门面（verdict.ts）都从这里取，
// 避免「同一个 TTL 抄两份」这类历史缺陷（7.153 删 SC.VT_TTL 之后的 1800000 裸魔数）。
import type { ChanToken, EpochMs, HostName, SampleCount } from "../core/types";

export type VState = 0 | 1 | 2 | 3;
export type VSrc = 0 | 1 | 2; // 0 traffic 弱证据 / 1 probe 强证据 / 2 client 端到端

/** 一行判定：某个目标站经某条通道的结论 */
export interface Verdict {
  target: HostName; // 目标站（主机名或 IP 字面量）
  channel: ChanToken; // 通道键：d=直连 / r:<ip>=中继
  state: VState; // 0 未知 / 1 可用 / 2 被拦 / 3 连不上
  code: number; // 最近一次观察到的 HTTP 状态码（0 = 没拿到状态码）
  ms: number; // 首字节延迟（毫秒，EWMA）
  observations: SampleCount; // 观察次数
  updatedAt: EpochMs; // 最近一次更新时间（毫秒时间戳）
  src: VSrc; // 这条结论的证据来源
}

/**
 * 判定表的过期时间（毫秒）。
 *
 * 为什么导出：`/<uuid>/debug?diag=` 要算「这条封锁还剩多少秒」，它必须与表里的 `ttl`
 * 是**同一个数**。7.153 删掉零读取点的 `SC.VT_TTL` 之后，那条诊断路径曾自己抄了一份
 * `1800000` 裸魔数——表一改就静默错报剩余时间。
 */
export const VT_TTL_MS = 30 * 60_000;
