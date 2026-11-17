// 挑哪一个候选：地区硬要求（?rg=）、正常请求（站点画像 → 抽样 → 偏好），以及「这条连接当时选的是谁」。
// 三层住在三个文件里：候选池准备在 ./pick-ready，画像与抽样在 ./pick-site，偏好过滤在 ./pick-pref；
// 「什么时候换」在 ./rotation，「失败怎么记」在 ./failbook。这个文件只做编排与地区硬要求。

import { aliveList } from "./pool";
import { keyOf } from "./const";
import { costOf, isBlack, isFrozen, usable } from "../nodes/score";
import { S } from "../core/state";
import type { PickState } from "./pick-types";
import { PATHS } from "./pick-pref";
import { ensureReady } from "./pick-ready";
import { SITE } from "./pick-site";

export type { PickState } from "./pick-types";

/**
 * 挑候选的执行器：`region`（地区硬要求）与 `current`（正常请求）。
 * 它自己不写任何统计：画像与抽样在 `SitePick`，偏好过滤在 `PathPrefs`，池子在 `ensureReady`。
 */
export class PickPath {
  /**
   * 功能：选一个节点（站点画像 → 冷启动影子 → 单层抽样 → 粘滞兜底），委托给 `SitePick`。
   * 保留这个门面是因为 `src/px/selector.ts` 与单测都从 `PICK.pick(...)` 进来。
   * @param {object} env Worker 环境
   * @param {'lat'|'tput'} mode 选路模式
   * @param {object|null} st 连接状态（会写 st.node / st.hostTrial）
   * @returns {string} 候选键 `host:port`
   */
  pick(env: Env, mode: Mode, st: PickState | null): string {
    return SITE.pick(env, mode, st);
  }

  /**
   * 功能：按国家挑一个节点（地区硬要求：调用方不得回落到直连/全球）。
   * @param {object} env Worker 环境
   * @param {string|null} cc 国家码（两位）
   * @param {'lat'|'tput'} mode 选路模式
   * @param {string} avoid 要避开的候选键（重试时传上次那条）
   * @returns {Promise<object|null>} 存活表条目；该国没有可用节点时返回 null（交给上层 1011）
   */
  async region(env: Env, cc: string | null, mode: Mode = "tput", avoid = "") {
    const want = String(cc || "").toUpperCase();
    if (!want) return null;
    const list = await aliveList(env);
    // 冷却/冻结是硬排除：全国都不可用就返回 null，交给上层 1011
    const live = list.filter((x) => {
      const k = keyOf(x);
      return String(x.cc || "").toUpperCase() === want && k !== avoid && !isBlack(k) && !isFrozen(k);
    });
    if (!live.length) return null;
    // 低可用/空关闭可疑是软排除：全国只剩它们时仍然要选一个（地区是硬要求）
    const ok = live.filter((x) => usable(keyOf(x)));
    const pool = ok.length ? ok : live;
    // 一次算分，别在 sort 比较器里反复调 costOf（30 个节点会算 150 次）
    const scored = pool.map((x) => ({ x, v: costOf(keyOf(x), mode) })).sort((a, b) => a.v - b.v);
    // 负载感知：最优代价 1.5 倍内挑在途最少的，避免全国连接全压在第一名
    const band = scored.filter((r) => r.v <= scored[0].v * 1.5 + 50).slice(0, 8);
    let pick = band[0];
    let load = S.inflight.get(keyOf(pick.x)) || 0;
    for (const r of band) {
      const l = S.inflight.get(keyOf(r.x)) || 0;
      if (l < load) {
        pick = r;
        load = l;
      }
    }
    return pick.x;
  }

  /**
   * 功能：当前该走哪条候选（手动配置直接返回，auto 走池子）。
   * @param {object} env Worker 环境
   * @param {'lat'|'tput'} mode 选路模式
   * @param {object|null} st 连接状态（会写 st.node）
   * @param {string} host 目标站点（空串 = 没有站点上下文，只按通用分数挑）
   * @param {boolean} cfOnly 目标是否 CF 托管（是则跳过 CF 边缘中继）
   * @param {Set<string>|null} exclude 已经试过的 `host:port`（拨号重试要找「下一条」，
   *   不能把刚失败的同一条再挑回来 —— 这条链路的返回值在确定性路径下是每次都一样的）
   * @returns {Promise<string>} `host:port`，没有可选候选时返回空串
   */
  async current(
    env: Env,
    mode: Mode,
    st: PickState | null,
    host = "",
    cfOnly = false,
    exclude: Set<string> | null = null,
  ): Promise<string> {
    const raw = String(env.proxyip || "").trim();
    if (!raw) return "";
    const m = mode === "lat" ? "lat" : "tput";
    if (raw.toLowerCase() !== "auto") {
      if (st) st.node = raw;
      return raw;
    }
    await ensureReady(env);
    // 站点偏好：判定层说「这条中继能过这个站」时才用它，优先于画像与抽样
    if (host) {
      const hit = PATHS.byPrefer(host, m, cfOnly, exclude);
      if (hit) {
        if (st) st.node = hit;
        return hit;
      }
    }
    // 非 CF 出口优先，但只在分数可比时（1.5x + 50ms 带内）：CF 托管站点的
    // 判定依据是出口 IP 族，非 CF 中继才可能改变结果。偏好开关由判定层（Policy）给。
    if (host && PATHS.nonCfFirst()) {
      const nk = PATHS.byNonCf(host, m, exclude);
      if (nk) {
        if (st) st.node = nk;
        return nk;
      }
    }
    // 站点画像 → 抽样 → 粘滞兜底（都在 SitePick 里）
    const first = SITE.pick(env, m, st);
    // 拨号重试要的是「下一条」：抽到的正好是刚失败的那条时，直接按通用分数重扫一遍
    if (first && exclude && exclude.has(first)) {
      const bk = PATHS.rescan(host, m, cfOnly, exclude);
      if (bk) {
        if (st) st.node = bk;
        return bk;
      }
      return "";
    }
    // 站点通道偏好：该通道对当前站点已被实测判死（403/不可达）就换一条没被判死的，
    // 打得通（0）与没测过（1）都不降权 —— 未知不等于坏，否则新中继永远上不了场。
    if (!first || !host || PATHS.chanOpen(host, first)) return first || "";
    const best = PATHS.byChan(host, m, exclude);
    if (best) {
      if (st) st.node = best;
      return best;
    }
    return first;
  }
}

/** 进程内唯一实例 */
export const PICK = new PickPath();
