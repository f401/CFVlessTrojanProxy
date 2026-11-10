// 纯常量：不依赖任何模块，供各方引用（避免 ESM 循环初始化时读到 undefined）

/* 评分参数：单位统一为「毫秒当量」——分数就是"平均多等多少毫秒" */
export const SC = {
  HL: 6 * 3600e3,     // 统计半衰期
  A: 0.3,             // EWMA 系数
  P_TCP: 250,         // 冷启动先验
  P_TLS: 60,
  FAIL: 8000,         // 一次失败的期望代价
  STALL: 2500,        // 卡顿当量
  TLS_G: 1.2,
  LOSS_G: 2,
  LOSS_SLACK: 30,
  MIN_BYTES: 1048576, // 吞吐样本准入门槛
  PRIOR_BPS: 200 * 1024,
  H_LAT: 20,
  H_TPUT: 0.25,
  DWELL_TPUT: 20 * 60000,
  DWELL: 10 * 60000,
  BUDGET: 3,
  ROLL_WIN: 60000,
  ROLL_FREEZE: 30 * 60000,
  TRIAL_N: 3,

  // —— v2 评分 ——
  BETA_A: 1,              // 失败率先验 α（无数据时均值 10%）
  BETA_B: 9,
  N_EFF_MIN: 3,           // 有效吞吐窗口数下限
  RECENT_MIN: 3 * 1048576,// 近期有效字节门槛
  SAMPLE_TTL: 24 * 3600e3,// 吞吐样本保质期
  CONN_W_CAP: 4,          // 单条连接对直方图的累计权重上限
  SEED_CONF: 0.25,        // seed 先验最大置信度
  SEED_TTL: 24 * 3600e3,  // seed 先验保质期
  EXPLORE_MAX: 0.10,      // 样本不足时的探索上限（样本够了回落到 pxShadow）
  WIN_MS: 10 * 60000,     // 快速失败窗口：10 分钟
};
export const HIST_BASE = 16 * 1024;   // 直方图起点 16 KB/s
export const HIST_N = 12;             // 16K ~ 32M

/** 信誉表落盘的最小间隔（全局闸门，防多 isolate 叠加写 KV） */
export const SEED_WRITE_GAP = 90 * 60000;
