/** 一次请求的上下文：站点、已选节点、是否已重试过、目标流量 */
export interface PickState {
  /** 目标站点（判定表与站点偏好的键） */
  host?: string;
  /** 已选中的候选键 `host:port`（重试时作为排除项） */
  node?: string;
  /** 本轮是否是「本站点第一次试这条」 */
  hostTrial?: boolean;
  /** 已经重试过一次（第二次失败就换节点而不是原地再试） */
  retried?: boolean;
  /** 这次要传多少字节（代价函数按它定价） */
  targetBytes?: number;
}
