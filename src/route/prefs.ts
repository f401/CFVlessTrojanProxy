import { vAll, vState } from "./verdict";

/** 一条通道的偏好记录 */
export interface PrefRow {
  /** 通道键：d（直连）/ r:<ip>（中继）/ e:<ip>（边缘入口） */
  c: string;
  /** 1 = 实测能打通；2/3 = 实测打不通 */
  s: number;
  /** 最近一次实测的时间戳 */
  at: number;
}

/**
 * 站点 × 通道的偏好视图：把判定表按「能打通 / 打不通」两栏摆出来。
 *
 * 目标这一维既有具体 IP（直连能钉住目标 IP），也有 `*`（中继自己解析域名，
 * 只能记到节点级），所以这里按通道聚合、取最近一次证据。
 */
export function prefsOf(host = "", limit = 40): { ok: PrefRow[]; bad: PrefRow[] } {
  const pick = new Map<string, PrefRow>();
  for (const r of vAll()) {
    if (host && r.t !== host && r.t !== "*") continue;
    const prev = pick.get(r.c);
    if (!prev || r.at > prev.at) pick.set(r.c, { c: r.c, s: r.state, at: r.at });
  }
  const all = [...pick.values()].sort((a, b) => b.at - a.at);
  return {
    ok: all.filter((x) => x.s === 1).slice(0, limit),
    bad: all.filter((x) => x.s >= 2).slice(0, limit),
  };
}

/** 通道偏好：0 = 实测能打通，2 = 实测打不通，1 = 还没测过（未知不惩罚） */
export function chanPref(ip: string, host = ""): 0 | 1 | 2 {
  if (!ip) return 1;
  const keys = ["r:" + ip, "e:" + ip];
  let bad = 0;
  for (const c of keys) {
    const ss = host ? [vState(host, c), vState("*", c)] : [vState("*", c)];
    for (const s of ss) {
      if (s === 1) return 0; // 有「能打通」的证据就直接放行
      if (s >= 2) bad = 1;
    }
  }
  return bad ? 2 : 1;
}

/** 调试：整张偏好表（按通道聚合后的两栏） */
export function prefsJson(limit = 40): { ok: PrefRow[]; bad: PrefRow[]; n: number } {
  const { ok, bad } = prefsOf("", limit);
  return { ok, bad, n: ok.length + bad.length };
}
