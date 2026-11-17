// 「偏好」这一层：判定层的否决（已判封锁的通道别拨）、入口族偏好（非 CF 出口优先）、
// 站点通道偏好（这条中继对这个站已判死就换一条），以及拨号重试要的「排除已试过的那条」。
// 这些偏好都不改代价函数，只在代价可比的范围内换一条；它们与站点画像（pick-site）互不影响。

import { relayIpOf } from "../core/http80";
import { HOOK } from "../core/hook";
import { isCfIp } from "../core/net";
import { candsFor, costOf, isBlack, isFrozen } from "../nodes/score";
import { S } from "../core/state";

/**
 * 偏好过滤：每条方法只回答「按这条规则，下一个该是谁」。
 * 它们都读 `S.alive` / `S.nstat`，但都不写 —— 落选不惩罚、不冷却，那是 failbook 的事。
 */
export class PathPrefs {
  /**
   * 功能：判定层是否否决了这条通道（该通道对这个站已被实测判死）。
   * @param {string} host 目标站点（空串表示没有站点上下文，一律不否决）
   * @param {string} key 候选键 `host:port`
   * @returns {boolean} 是否否决
   */
  vetoed(host: string, key: string): boolean {
    const vet = HOOK.veto;
    return vet && host ? vet(host, relayIpOf(key)) : false;
  }

  /**
   * 功能：按「站点偏好」挑一条（判定层说这条中继能过这个站）。
   * @param {string} host 目标站点
   * @param {'lat'|'tput'} mode 选路模式
   * @param {boolean} cfOnly 目标是否 CF 托管（是则先跳过 CF 边缘中继）
   * @param {Set<string>|null} exclude 已经试过的候选键
   * @returns {string} 候选键；没有符合条件的返回空串
   */
  byPrefer(host: string, mode: Mode, cfOnly: boolean, exclude: Set<string> | null): string {
    const prefer = HOOK.prefer;
    if (!prefer) return "";
    const now = Date.now();
    let best = "";
    let bv = Infinity;
    for (const k of S.alive.keys()) {
      // 已试过的那条要跳过：pFail 惩罚不足以让它在同一秒内掉出第一
      if (exclude && exclude.has(k)) continue;
      if (isBlack(k) || isFrozen(k) || this.vetoed(host, k)) continue;
      const ip = relayIpOf(k);
      if (cfOnly && isCfIp((S.alive.get(k) || { h: "" } as { h?: string }).h || "")) continue;
      if (!prefer(host, ip)) continue;
      const v = costOf(k, mode, now);
      if (v < bv) {
        bv = v;
        best = k;
      }
    }
    return best;
  }

  /**
   * 功能：判定层是否要求「优先非 CF 出口」（CF 托管站点才需要）。
   * @returns {boolean} true 表示要优先非 CF 出口
   */
  nonCfFirst(): boolean {
    const fn = HOOK.nonCfFirst;
    return fn ? fn() : false;
  }

  /**
   * 功能：非 CF 出口里最便宜的那条（CF 托管站点的判定依据是出口 IP 族）。
   * 调用方负责判断「值不值得」——与全局最优差太多时不换，否则等于主动跳坑。
   * @param {string} host 目标站点（判定层的否决键；空串表示没有站点上下文）
   * @param {'lat'|'tput'} mode 选路模式
   * @param {Set<string>|null} exclude 已经试过的候选键
   * @returns {string} 候选键；没有非 CF 出口时返回空串
   */
  byNonCf(host: string, mode: Mode, exclude: Set<string> | null): string {
    const now = Date.now();
    let nk = "";
    let nv = Infinity;
    for (const [rk, a] of S.alive) {
      if (exclude && exclude.has(rk)) continue;
      if (isCfIp(a.h) || isBlack(rk) || isFrozen(rk) || this.vetoed(host, rk)) continue;
      const v = costOf(rk, mode, now);
      if (v < nv) {
        nv = v;
        nk = rk;
      }
    }
    if (!nk) return "";
    // 只有与全局最优可比时才用（1.5 倍 + 50ms 带内），否则优势不足以抵消「量过的那条更快」
    const top = candsFor(mode)[0];
    const av = top ? top.v : Infinity;
    return nv <= av * 1.5 + 50 ? nk : "";
  }

  /**
   * 功能：拨号重试要的「下一条」——抽到的正好是刚失败那条时，按通用分数重扫一遍。
   * 这里不看站点偏好与入口族偏好，只求「换一条能连的」，否则第二次尝试等于空转 2.5 秒。
   * @param {string} host 目标站点（判定层的否决键；空串表示没有站点上下文）
   * @param {'lat'|'tput'} mode 选路模式
   * @param {boolean} cfOnly 目标是否 CF 托管
   * @param {Set<string>} exclude 已经试过的候选键（至少一条）
   * @returns {string} 候选键；全被排除时返回空串
   */
  rescan(host: string, mode: Mode, cfOnly: boolean, exclude: Set<string>): string {
    const now = Date.now();
    let bk = "";
    let bv = Infinity;
    // 扫的是存活表而不是候选表：候选表已经按「可用」截过，被排除的那条可能就在前面占位
    for (const [k, a] of S.alive) {
      if (exclude.has(k) || isBlack(k) || isFrozen(k) || this.vetoed(host, k)) continue;
      // CF 托管目标上，CF 边缘中继第二轮大概率还是 403，白等第二个 2.5 秒
      if (cfOnly && isCfIp(a.h)) continue;
      const v = costOf(k, mode, now);
      if (v < bv) {
        bv = v;
        bk = k;
      }
    }
    return bk;
  }

  /**
   * 功能：这条通道对当前站点的实测结论是不是「还没被判死」。
   * @param {string} host 目标站点
   * @param {string} key 候选键
   * @returns {boolean} true 表示可用（打得通 0 与没测过 1 都算可用 —— 未知不等于坏）
   */
  chanOpen(host: string, key: string): boolean {
    const cp = HOOK.chanPref;
    if (!cp) return true;
    return cp(relayIpOf(key), host) < 2;
  }

  /**
   * 功能：换一条没被判死的通道（站点偏好替身）。
   * @param {string} host 目标站点
   * @param {'lat'|'tput'} mode 选路模式
   * @param {Set<string>|null} exclude 已经试过的候选键
   * @returns {string} 候选键；没有符合条件的返回空串
   */
  byChan(host: string, mode: Mode, exclude: Set<string> | null): string {
    const cp = HOOK.chanPref;
    if (!cp) return "";
    let best = "";
    let bv = Infinity;
    // 这里用的是候选表：换通道时仍然要按「代价」挑，而不是随便找一条没被判死的
    for (const x of candsFor(mode)) {
      if (exclude && exclude.has(x.k)) continue;
      if (isBlack(x.k) || isFrozen(x.k)) continue;
      // chanPref ≥ 2 就是「这条中继对这个站已被实测判死（403/不可达）」
      if (cp(relayIpOf(x.k), host) >= 2) continue;
      if (x.v < bv) {
        bv = x.v;
        best = x.k;
      }
    }
    return best;
  }
}

/** 进程内唯一实例 */
export const PATHS = new PathPrefs();
