// 纯常量：不依赖任何模块，供各方引用（避免 ESM 循环初始化时读到 undefined）

/* 评分参数：单位统一为「毫秒当量」——分数就是"平均多等多少毫秒" */
export const SC = {
  HL: 6 * 3600e3, // 统计半衰期
  A: 0.3, // EWMA 系数
  P_TCP: 250, // 冷启动先验
  P_TLS: 60,
  FAIL: 8000, // 一次失败的期望代价
  STALL: 2500, // 卡顿当量
  TLS_G: 1.2,
  LOSS_G: 2,
  LOSS_SLACK: 30,
  MIN_BYTES: 1048576, // 吞吐样本准入门槛
  PRIOR_BPS: 2 * 1024 * 1024, // 冷启动先验：200KB/s 让"没测过的节点"永远排不上（实测 tput 1.60→1.47）
  H_LAT: 20,
  H_LAT_REL: 0.25, // 延迟模式的滞回比例（按延迟分量算，不按含风险的总分算）
  H_TPUT: 0.25,
  DWELL_TPUT: 20 * 60000,
  DWELL: 10 * 60000,
  BUDGET: 3,
  ROLL_WIN: 60000,
  ROLL_FREEZE: 30 * 60000,
  TRIAL_LAT: 60, // 延迟模式试用样本数：3 个样本定生死＝把运气当能力
  TRIAL_TPUT: 6, // 吞吐模式的试用样本数：3 只能排出名次，不足以压住估计噪声（节点数扫描 96 节点 1.76→1.54）
  ROUTE_T_LAT: 20, // 延迟模式的抽签温度（毫秒）：差 20ms 的节点权重 37%；0 = 退回粘滞游标
  ROUTE_T_TPUT: 50, // 吞吐模式的抽签温度；0 = 退回粘滞游标（实测 50 最好：真实画像 2.36→1.61）
  ROUTE_K: 12, // 参与抽签的候选数
  WATCH_N: 32, // 探索 watchlist 大小：5% 的探索流量只在这 32 个里轮转
  WATCH_BONUS: 300, // watchlist 排序：探活延迟 + 300/√(n+1)（样本越少越靠前）
  LAT_TS: 1, // 延迟模式：Thompson 采样（只信已测节点，未测节点走分数兜底）
  TS_K: 64, // 成员表大小：按延迟取前 64
  FAIL_GATE: 0.02, // 失败率门槛（超过它不参与排序）

  // —— v2 评分 ——
  BETA_A: 1, // 失败率先验 α（无数据时均值 10%）
  BETA_B: 9,
  N_EFF_MIN: 3, // 有效吞吐窗口数下限
  RECENT_MIN: 3 * 1048576, // 近期有效字节门槛
  SAMPLE_TTL: 24 * 3600e3, // 吞吐样本保质期
  CONN_W_CAP: 4, // 单条连接对直方图的累计权重上限
  SEED_CONF: 0.25, // seed 先验最大置信度
  SEED_TTL: 24 * 3600e3, // seed 先验保质期
  EXPLORE_MAX: 0.1, // 样本不足时的探索上限（样本够了回落到 pxShadow）
  WIN_HL: 3 * 60000, // 快速失败窗口半衰期：3 分钟（指数窗口，不按 10 分钟一刀切）
};
export const HIST_BASE = 16 * 1024; // 直方图起点 16 KB/s
export const HIST_N = 12; // 16K ~ 32M
export const RTT_MAX = 24; // 每个用户最多记 24 个入口标签（防 ?ip= 刷爆快照）

/** 信誉表落盘的最小间隔（全局闸门，防多 isolate 叠加写 KV） */
export const SEED_WRITE_GAP = 90 * 60000;
