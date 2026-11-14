// 子请求预算分配：一轮 cron 里「准入探活 / 判定扫描 / 入口探测」各拿多少个 connect()。
// 硬上限是 SC.SCAN_SUB（免费计划 50 子请求），保底给前两项，剩余按价值分。
import { SC } from "../core/const";
import { S } from "../core/state";
import { vAll } from "./verdict";

export interface Plan {
  adm: number; // 池子准入探活（新增候选）
  vt: number; // 判定扫描（目标 IP × 通道）
  edge: number; // 入口偏好（客户端 → 边缘）
  cap: number; // 本轮总闸
}

/**
 * 价值近似：`覆盖缺口 × 陈旧度`。
 * - 覆盖缺口：候选里还没测过的比例（`1 - alive/pool`），越大越该花在准入上；
 * - 陈旧度：判定表里超过一半 TTL 的条目占比，越大越该花在判定上。
 * 都是 O(1)，不遍历全表（判定表 ≤600）。
 */
export function planRound(poolN: number, aliveN: number): Plan {
  const cap = Math.max(12, SC.SCAN_SUB);
  const cover = poolN > 0 ? Math.max(0, 1 - aliveN / poolN) : 0;
  const now = Date.now();
  const all = vAll();
  let stale = 0;
  for (const v of all) if (now - v.at > SC.VT_TTL / 2) stale++;
  const staleR = all.length ? stale / all.length : 1;

  // 保底：池子最饿的时候也别把额度全给判定
  const admMin = aliveN < 64 ? 6 : 4;
  const vtMin = 4;
  const edgeMin = 1;
  let rest = cap - admMin - vtMin - edgeMin;
  if (rest < 0) rest = 0;

  const wAdm = cover * 2 + 0.3;
  const wVt = staleR * 2 + 0.3;
  const wEdge = 0.2;
  const wSum = wAdm + wVt + wEdge;
  let adm = admMin + Math.round((rest * wAdm) / wSum);
  let vt = vtMin + Math.round((rest * wVt) / wSum);
  // 四舍五入可能把总和顶到 cap 之上：多出来的先退判定（每轮本来只探 1 个），再退准入。
  // 之前这里是 `Math.max(0, cap - adm - vt)`，总和一旦超 cap 就只是把 edge 压成 0，
  // 实际子请求数仍然超额。
  while (adm + vt > cap - edgeMin) {
    if (vt > vtMin) vt--;
    else if (adm > admMin) adm--;
    else break;
  }
  const edge = cap - adm - vt;
  return { adm: Math.min(adm, SC.SCAN_MAX), vt, edge: Math.min(edge, 4), cap };
}

/** 供调试端点与日志用的快照（不参与决策） */
export function planView(poolN: number, aliveN: number): Plan & { verds: number; site: string } {
  const p = planRound(poolN, aliveN);
  return { ...p, verds: vAll().length, site: S.site || "" };
}
