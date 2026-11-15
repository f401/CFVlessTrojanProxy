// 站点 × 通道的偏好视图（OOP 版）：把判定表按「能打通 / 打不通」两栏摆出来。
// 判定表里只有两种键：`d`（直连）与 `r:<ip>`（中继）。曾经还有 `*`（节点级通配）与 `e:<ip>`
// （入口）两种：前者 7.57 把池子打薄后写入点全部删除、7.133 之后连写入入口都直接拒绝；后者随
// 入口偏好表一起删除。这里只剩中继通道，读到 `*`/`e:` 的代码已经是死分支，一并去掉。
import { vAll, vState } from "./verdict";

/** 一条通道的偏好记录 */
export interface PrefRow {
  /** 通道键：d（直连）/ r:<ip>（中继） */
  c: string;
  /** 1 = 实测能打通；2/3 = 实测打不通 */
  s: number;
  /** 最近一次实测的时间戳 */
  at: number;
}

export class Prefs {
  /**
   * 功能：把判定表按通道聚合，取每条通道最近一次证据，分成「能打通 / 打不通」两栏。
   * @param host 只看这个站点的结论，空串表示全部
   * @param limit 每栏最多返回多少条
   * @returns 两栏记录
   */
  of(host = "", limit = 40): { ok: PrefRow[]; bad: PrefRow[] } {
    const pick = new Map<string, PrefRow>();
    for (const r of vAll()) {
      if (host && r.t !== host) continue;
      const prev = pick.get(r.c);
      if (!prev || r.at > prev.at) pick.set(r.c, { c: r.c, s: r.state, at: r.at });
    }
    const all = [...pick.values()].sort((a, b) => b.at - a.at);
    return { ok: all.filter((x) => x.s === 1).slice(0, limit), bad: all.filter((x) => x.s >= 2).slice(0, limit) };
  }

  /**
   * 功能：某条中继对某站点的通道偏好。
   * 为什么必须带站点：判定表的键是「站点 × 通道」，不传站点就只能去查 `*` 通配行，
   * 而通配行已经不可能存在 —— 那种调用会永远返回「没测过」，等于悄悄失效。
   * @param ip 中继出口 IP
   * @param host 目标站点
   * @returns 0 = 实测能打通，2 = 实测打不通，1 = 还没测过（未知不惩罚）
   */
  chan(ip: string, host: string): 0 | 1 | 2 {
    if (!ip || !host) return 1;
    const s = vState(host, "r:" + ip);
    if (s === 1) return 0;
    return s >= 2 ? 2 : 1;
  }

  /**
   * 功能：调试用——整张偏好表。
   * @param limit 每栏最多返回多少条
   * @returns 两栏记录与总条数
   */
  json(limit = 40): { ok: PrefRow[]; bad: PrefRow[]; n: number } {
    const { ok, bad } = this.of("", limit);
    return { ok, bad, n: ok.length + bad.length };
  }
}

/** 进程内唯一偏好视图（判定表的只读投影） */
export const PREFS = new Prefs();

export const prefsOf = (host = "", limit = 40) => PREFS.of(host, limit);
export const chanPref = (ip: string, host: string) => PREFS.chan(ip, host);
export const prefsJson = (limit = 40) => PREFS.json(limit);
