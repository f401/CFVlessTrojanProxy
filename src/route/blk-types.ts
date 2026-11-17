// `blk` 事实的形状与刻度：三条独立确认门槛 + 上报行格式。
//
// 单独成文件的原因：这些数字每一个都对应线上事故里的一个具体教训（批数不够会把业务 403 误判成
// 单 IP 封锁、间隔太短等于重复掷骰子、静默表无上限会被客户端带来的站点名灌满），
// 而读代码的人经常只想确认「现在到底要几批」，不该在 300 行的状态机里翻。

/** 需要几批独立确认 */
export const BLK_BATCH = 3;
/** 每批至少几次 tiny 观测 */
export const BLK_MIN = 3;
/** 两批之间的最小间隔（60 秒） */
export const BLK_GAP = 60000;
/** 命中后的代价倍数（只折价，不排除） */
export const BLK_PEN = 6;
/** 表上限 */
export const BLK_MAX = 1024;
/** 站点级自愈：同一站点被写满这么多行（且 ≥75% 候选）就整体清空并静默 30 分钟 */
export const BLK_SWEEP_MIN = 3;
/** 静默时长 */
export const BLK_MUTE = 30 * 60000;
/** 静默表的容量上限：键是客户端带来的站点名，30 分钟 TTL 内可以灌任意多条（v7.230） */
export const BLK_MUTE_MAX = 256;

/** 累计中的一批 */
export interface Batch {
  /** 当前这一批里已经看到的 tiny 次数 */
  n: number;
  /** 当前这一批的开始时间 */
  at: number;
  /** 已经确认完成的批数 */
  done: number;
  /** 上一批完成的时间（用于强制两批之间 ≥ BLK_GAP） */
  last: number;
}

/** 已确认的封锁行 */
export interface Row {
  /** 确认时的批数（= BLK_BATCH） */
  n: number;
  /** 最后一批的时间 */
  at: number;
}

/** 上报行 */
export interface BlkWire {
  /** `host|relay` */
  k: string;
  /** 批数 */
  n: number;
  /** 时间 */
  at: number;
}
