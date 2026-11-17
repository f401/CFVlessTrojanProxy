// 失败怎么记：节点级失败推进快速失败窗口并重算分数，站点级失败只进站点画像（跨 isolate 不共享）。
// 记账的形状是「谁失败 → 罚多重 → 什么时候清」，与「挑谁」（./pickpath）、「什么时候换」（./rotation）分开。

import { SC } from "../core/const";
import { logErr } from "../nodes/metrics";
import { pxPolicy } from "./probe";
import { bestFor, freezeNode, isBlack, isFrozen, nsFail, nsSiteFail } from "../nodes/score";
import { S } from "../core/state";
import { ROTATION } from "./rotation";

/**
 * 失败账本：`onFail` 只改内存里的分数与窗口，`bumpFail` 额外给节点记一次真实失败，
 * `resetFail` 在连接真的拿到整页时把窗口清掉（否则一次抖动会压住一整轮）。
 */
export class FailBook {
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
  // 失败分三档：影子连接失败只冻结它自己；
  // 真连接失败先记全局（pFail 立刻上升），再决定「回滚到上一个」还是「重新排第一」
    if (!k) return;
    nsFail(k);
    // 影子连接只贡献一个样本，失败就冻结，别让它继续占探索名额
    if (trial) {
      freezeNode(k);
      return;
    }
    const m = mode === "lat" ? "lat" : "tput";
    const prev = S.prev[m];
    const now = Date.now();
    if (
      k === S.curs[m] &&
      prev &&
      S.alive.has(prev) &&
      !isBlack(prev) &&
      !isFrozen(prev) &&
      now - (S.lastSwitch[m] || 0) < SC.ROLL_WIN
    ) {
      S.curs[m] = prev;
      S.prev[m] = "";
      S.lastSwitch[m] = now;
      freezeNode(k);
      logErr(`rollback(${m}) ${k} -> ${prev}`, "60s");
      return;
    }
    // 回滚不成（prev 已坏 / 超出 ROLL_WIN）就重排第一：bestFor 会跳过黑名单与冻结，
    // 失败的节点交给 nsFail 的退避阶梯，不是在这里硬判死
    if (k === S.curs[m]) {
      const b = bestFor(m);
      if (b && b !== k) {
        S.prev[m] = k;
        S.curs[m] = b;
        S.lastSwitch[m] = now;
        logErr(`fail-switch(${m}) ${k} -> ${b}`, "");
      }
    }
  }

  /** 只记一次全局失败，不动游标也不冻结（站点级试探失败用） */
  async softFail(k: string) {
    // 站点级试探失败：只轻记全局，不动主游标
    if (k) nsSiteFail(k);
  }

  /** 记一次失败；连续到阈值就换节点。兼容旧调用。 */
  async bumpFail(env: Env, mode: Mode, k: string, trial: boolean, kind: "node" | "site" = "node") {
    if (kind === "site") {
      // 目标站侧的问题：不推进失败计数、不换全局游标，只轻记节点
      if (k) nsSiteFail(k);
      return;
    }
    const node = k || S.curs[mode === "lat" ? "lat" : "tput"] || S.curs.tput || S.curs.lat || "";
    this.onFail(env, mode, node, !!trial);
    if (trial) return; // 影子/站点试探失败不惩罚主游标，也不进全局失败记忆
    S.pxFailSeen = 1;
    S.pxFailMem += 1;
    const { fail, force } = pxPolicy(env);
    if (S.pxFailMem < fail) return;
    const n = S.pxFailMem;
    S.pxFailMem = 0;
    if (n >= force) {
      S.prev.tput = "";
      S.prev.lat = "";
    }
    ROTATION.maybeSwitch(env, "lat");
    ROTATION.maybeSwitch(env, "tput");
  }

  /** 链路健康：清零计数。成功样本由 Connection.flush 在收尾时统一记一次。 */
  async resetFail(_env: Env, _k: string) {
    if (!S.pxFailSeen) return;
    S.pxFailSeen = 0;
    S.pxFailMem = 0;
  }
}

/** 进程内唯一实例 */
export const FAILS = new FailBook();
