import { EG, type EgRow } from "./egfacts";
import { PS, type PsWire } from "./psfacts";
import { DEAD, type DeadWire } from "./deadfacts";
import { BLK, type BlkWire } from "./blkfacts";
import { DNS, type DnsWire } from "./dnsfacts";

/** 远端事实车身（与 `GET /meter/vt` 的返回字段一一对应）。 */
export interface FactsBody {
  eg?: EgRow[];
  ps?: PsWire[];
  dead?: DeadWire[];
  blk2?: BlkWire[];
  dns?: DnsWire[];
}

/** 上行增量的形状：四类事实各自可能为空。 */
export interface FactsDelta {
  eg?: EgRow[];
  ps?: PsWire[];
  dead?: DeadWire[];
  blk2?: BlkWire[];
  dns?: DnsWire[];
}

/**
 * 功能：四类会同步的事实表的门面 —— 收口「冷启动合并 → 上行增量 → ack/nack」三段生命周期。
 *
 * 为什么要这个门面：这四类事实的读写以前散在 `verdictsync`（4 个 if 块）、`pend`（4 个 HOOK 槽位）、
 * `policy`（4 组 ack/nack 注册）。任何一类新增或退场，都要改三处且容易漏 —— 漏了的表现是
 * 「事实在本地学得很好，但别的 isolate 永远收不到」，而单测与链路验收都发现不了（它们测函数本身）。
 *
 * 分层：`src/store/pend.ts` 不能 import route（反向依赖），所以它只认 `HOOK.factsDelta` 一个槽位，
 * 具体是哪几类由这里决定。
 */
export class FactsStore {
  /**
   * 功能：把远端拉回的事实合并进本地表（各自的 `load` 都只认更新的观测）。
   * @param b 远端车身
   * @returns {{ eg: number; ps: number; dead: number; blk2: number; dns: number }} 各自实际并入的行数
   */
  load(b: FactsBody): { eg: number; ps: number; dead: number; blk2: number; dns: number } {
    return {
      eg: Array.isArray(b.eg) ? EG.load(b.eg) : 0,
      ps: Array.isArray(b.ps) ? PS.load(b.ps) : 0,
      dead: Array.isArray(b.dead) ? DEAD.load(b.dead) : 0,
      blk2: Array.isArray(b.blk2) ? BLK.load(b.blk2) : 0,
      dns: Array.isArray(b.dns) ? DNS.load(b.dns) : 0,
    };
  }

  /**
   * 功能：取出待上行的增量（未 ack 的行会原样再给一次：重发等于重试，不是重复计数）。
   * @returns {FactsDelta} 四类增量
   */
  delta(): FactsDelta {
    const out: FactsDelta = {};
    const eg = EG.delta();
    if (eg.length) out.eg = eg;
    const ps = PS.delta();
    if (ps.length) out.ps = ps;
    const dead = DEAD.delta();
    if (dead.length) out.dead = dead;
    const blk2 = BLK.delta();
    if (blk2.length) out.blk2 = blk2;
    const dns = DNS.delta();
    if (dns.length) out.dns = dns;
    return out;
  }

  /** 功能：上报成功 —— 四张表的 pending 全部转正。 */
  ack(): void {
    EG.ack();
    PS.ack();
    DEAD.ack();
    BLK.ack();
  }

  /** 功能：上报失败 —— 丢弃 pending，下一轮按当前状态重新登记。 */
  nack(): void {
    EG.nack();
    PS.nack();
    DEAD.nack();
    BLK.nack();
  }

  /**
   * 功能：给 `/health` 用的四类事实概览。
   * @returns {{ eg: unknown; ps: unknown; dead: unknown; blk: unknown }} 各自快照
   */
  snap(): { eg: unknown; ps: unknown; dead: unknown; blk: unknown } {
    return { eg: EG.snap(), ps: PS.snap(), dead: DEAD.snap(), blk: BLK.snap() };
  }

  /** 功能：清空四张表（测试用）。 */
  clear(): void {
    EG.clear();
    PS.clear();
    DEAD.clear();
    BLK.clear();
    DNS.clear();
  }
}

/** 全局事实门面。 */
export const FACTS = new FactsStore();
