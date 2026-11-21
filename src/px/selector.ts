// 节点选择器的门面：`SEL` 是生产代码唯一入口。
// 实现分成三块 —— 挑谁（./pickpath 的 `PickPath`）、什么时候换（./rotation 的 `Rotation`）、
// 失败怎么记（./failbook 的 `FailBook`）；这个文件只做委托与再导出，不再有算法。

import { PickPath } from "./pickpath";
import { Rotation } from "./rotation";
import { FailBook } from "./failbook";
import type { PickState } from "./pickpath";

export { Rotation, dwellOf } from "./rotation";
export { FailBook } from "./failbook";
export type { PickState } from "./pickpath";

/**
 * 节点选择器（门面）：把「挑哪台节点 / 什么时候换 / 失败怎么记」暴露成同一组方法。
 * 每个方法都委托给各自的执行器，返回值就是被委托函数的返回值 —— 不要在这里另做裁剪。
 */
export class Selector {
  /**
   * 换节点判定器：什么条件算「该换了」、留在新节点上至少多久，都封在 `Rotation` 里。
   * 7.356 前它是模块级 `ROTATION`，且失败记账器直接引它 —— 读门面看不出这件
   * 决策挂在谁身上。现在门面持有唯一实例，并把同一个实例交给记账器。
   */
  private readonly rotation = new Rotation();
  /**
   * 失败记账器：罚多重、什么时候清、连带要不要换节点都封在 `FailBook` 里。
   * 7.347 前它是模块级 `FAILS`，读门面时看不出谁在用它、用了几次。
   */
  private readonly fails = new FailBook(this.rotation);
  /**
   * 挑节点的执行器（7.385 起由门面自己持有）：画像、冷启动影子、抽样、粘滞兜底都在它里面。
   * 7.384 前它是模块级 `PICK`，selector.ts 还多一条 `export { PICK }` 死导出；
   * 现在门面是生产唯一入口，挑谁这件事就挂在 `SEL.picker` 上。
   */
  private readonly picker = new PickPath();
  /** 按国家挑一个节点（地区硬要求：调用方不得回落到直连/全球） */
  async region(env: Env, cc: string | null, mode: Mode = "tput", avoid = "") {
    // 实现见 PickPath.region：这个类只做委托。
    return this.picker.region(env, cc, mode, avoid);
  }

  /**
   * 选一个节点。
   *   ① 先看"这个站"的历史：有样本就按站点分选（hostCost）
   *   ② 冷启动（这个站试过的节点 <3）：一半概率去试一个没试过的
   *   ③ 都没有 → 回到全局游标 + 影子流量
   */
  pick(env: Env, mode: Mode, st: PickState | null) {
    // 实现见 PickPath.pick：这个类只做委托。
    return this.picker.pick(env, mode, st);
  }

  /** 重新评估是否该换节点（cron 与失败路径共用） */
  maybeSwitch(env: Env, mode: Mode) {
    // 实现见 Rotation.maybeSwitch：这个类只做委托。
    return this.rotation.maybeSwitch(env, mode);
  }

  /**
   * 失败处理：记账 → 必要时回滚/换节点。
   * 站点级试探（Connection.hostTrial）的失败只冻结它自己，不动主游标，也不进全局失败记忆。
   * @param {object} env Worker 环境
   * @param {string} mode 模式
   * @param {string} k 节点
   * @param {boolean} trial 是不是站点级试探（只有 hostTrial 会置位）
   * @returns {void}
   */
  onFail(_env: Env, mode: Mode, k: string, trial: boolean) {
    // 实现见 FailBook.onFail：这个类只做委托。
    return this.fails.onFail(_env, mode, k, trial);
  }

  /** 只记一次全局失败，不动游标也不冻结（站点级试探失败用） */
  async softFail(k: string) {
    // 实现见 FailBook.softFail：这个类只做委托。
    return this.fails.softFail(k);
  }

  /** 记一次失败；连续到阈值就换节点。兼容旧调用。 */
  async bumpFail(env: Env, mode: Mode, k: string, trial: boolean, kind: "node" | "site" = "node") {
    // 实现见 FailBook.bumpFail：这个类只做委托。
    return this.fails.bumpFail(env, mode, k, trial, kind);
  }

  /** 链路健康：清零计数。成功样本由 Connection.flush 在收尾时统一记一次。 */
  async resetFail(_env: Env, _k: string) {
    // 实现见 FailBook.resetFail：这个类只做委托。
    return this.fails.resetFail(_env, _k);
  }

  /**
   * 当前节点（"auto" 模式才用池子；手动配置直接返回）。
   * @param {object} env Worker 环境
   * @param {'lat'|'tput'} mode 选路模式
   * @param {object|null} st 连接状态（会写 st.node）
   * @param {string} host 目标站点（空串 = 没有站点上下文，只按通用分数挑）
   * @param {boolean} cfOnly 目标是否 CF 托管（是则跳过 CF 边缘中继）
   * @param {Set<string>|null} exclude 已经试过的 `host:port`（拨号重试要找「下一条」，
   *   不能把刚失败的同一条再挑回来 —— 这条链路的返回值在确定性路径下是每次都一样的）
   * @returns {string} `host:port`，没有可选候选时返回空串
   */
  async current(
    env: Env,
    mode: Mode,
    st: PickState | null,
    host = "",
    cfOnly = false,
    exclude: Set<string> | null = null,
  ) {
    // 实现见 PickPath.current：这个类只做委托。
    return this.picker.current(env, mode, st, host, cfOnly, exclude);
  }

  /** cron 扫描收尾：重算两个模式的游标，再做定时轮换 */
  afterScan(env: Env) {
    // 实现见 Rotation.afterScan：这个类只做委托。
    return this.rotation.afterScan(env);
  }

  /**
   * 定时轮换：让"成绩接近"的前二名轮流吃真实流量，保证吞吐样本不全压在一个人身上。
   * @param {object} env Worker 环境
   * @returns {void}
   */
  sched(env: Env) {
    // 实现见 Rotation.sched：这个类只做委托。
    return this.rotation.sched(env);
  }
}

/** 进程内唯一实例 */
export const SEL = new Selector();
