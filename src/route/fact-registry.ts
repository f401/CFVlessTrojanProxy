// 事实写入注册表：把「谁有权改判定/封锁表」收敛到一个地方。
//
// 7.363 之前 rankOf（名叫「算候选视图」的排序函数）顺手干了三件写的事：
// healRatio 里 VT.setState、全死时 VT.clearHost、BLK.sweep。后果是「读」的函数有副作用，
// 调用顺序一变（5% 探索早返回）就漏掉自愈；想知道「这条封锁谁写的」要读三个文件。
// 现在三件写动作集中在这里，rankOf 只读，decide 在排序前显式调用一次 housekeep。
//
// 做成静态类而非模块级实例：没有跨请求状态（状态都在 VT/BLK 各自的表里），
// 与 7.360 把无字段门面改静态是同一条约定。

import { VT } from "./verdict";
import { BLK } from "./blkfacts";

/**
 * 功能：一次显式的事实维护动作（供日志与单测断言「谁在什么时候写了什么」）。
 * 只登记会改变判定/封锁表的动作；ps/eg/dead/dns 由各自事实表的 note 写。
 */
export interface FactEffect {
  /** 写入种类：verdict = 判定表；blk = 站点封锁/静音表 */
  kind: "verdict" | "blk";
  /** 动作 */
  action: "reset" | "clearHost" | "sweep";
  /** 目标站点 */
  host: string;
  /** 受影响的行数（reset 时是解除判死的通道数） */
  count: number;
}

/**
 * 功能：事实层的写入门面 —— 只有它能改判定表与封锁表。
 */
export class FactRegistry {
  /**
   * 功能：决策前的自愈维护 —— 把三条曾经藏在 rankOf 里的写动作集中执行。
   *
   * 三条判据（顺序不能换，与原 rankOf 完全一致）：
   *  ① 比例兜底：被判死 >3/4 且可用 <2 时，只保留最近判死的两条，其余解除；
   *     只看判死那批，绝不能对整池排序（7.268 曾把唯一能打通的正证据也重置掉）。
   *  ② 全死自愈：一个候选都没剩时清站点结论，宁可再试也不能让站点没路走。
   *  ③ 站点级自愈：整池被同一站点写满时清空并静音；分母必须是整池 relays。
   * @param host 目标站点
   * @param relays 本轮候选中继
   * @returns 本次实际发生的写入动作（空数组表示这一轮什么都不用改）
   */
  static housekeep(host: string, relays: string[]): FactEffect[] {
    const out: FactEffect[] = [];
    const alive = (): string[] => relays.filter((ip) => !(host && VT.bad(host, "r:" + ip)));
    const usable = alive();
    const blockedRatio = relays.length ? (relays.length - usable.length) / relays.length : 0;
    if (blockedRatio > 0.75 && usable.length < 2) {
      const dead = relays.filter((ip) => VT.bad(host, "r:" + ip));
      const sorted = dead.slice().sort((a, b) => VT.at(host, "r:" + b) - VT.at(host, "r:" + a));
      let n = 0;
      for (const ip of sorted.slice(2)) {
        VT.setState(host, "r:" + ip, 0, 1);
        n += 1;
      }
      if (n) out.push({ kind: "verdict", action: "reset", host, count: n });
    }
    // 必须在比例兜底之后重新读表：如果刚解除了几条判死，usable 已经非空，不能再 clearHost。
    // 原 rankOf 里 healRatio 返回的是「setState 之后重新过滤」的结果，这里用 alive() 复现同一时序。
    if (!alive().length && relays.length) {
      VT.clearHost(host);
      out.push({ kind: "verdict", action: "clearHost", host, count: relays.length });
    }
    if (BLK.sweep(host, relays)) out.push({ kind: "blk", action: "sweep", host, count: 1 });
    return out;
  }
}
