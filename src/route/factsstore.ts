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

/** 上行增量的形状：五类事实各自可能为空。 */
export interface FactsDelta {
  eg?: EgRow[];
  ps?: PsWire[];
  dead?: DeadWire[];
  blk2?: BlkWire[];
  dns?: DnsWire[];
}

/** 事实表在门面里的统一接口 —— 六段生命周期各一个方法，缺一个就是编译错误。 */
interface FactTable {
  /** 在车身 / 增量里的字段名（`blk` 类型的字段叫 `blk2`，避开计量表里的 `blk`） */
  readonly kind: keyof FactsBody;
  /** 合并远端行，返回实际并入的行数 */
  load(rows: unknown): number;
  /** 取待上行增量 */
  delta(): unknown[];
  /** 上报成功：待发转已发 */
  ack(): void;
  /** 上报失败：保留待发（重发 = 重试） */
  nack(): void;
  /** 清空（测试与调试端点） */
  clear(): void;
  /** 调试快照 */
  snap(): unknown;
}

/**
 * 五张会同步的事实表 —— **这是唯一需要登记的地方**。
 *
 * 为什么改成表驱动（v7.140）：原来六个方法各写五段并列的 `X.ack()` 之类，`dns` 作为后加的第五类
 * 只在 `load`/`delta`/`clear` 里被接上，`ack`/`nack`/`snap` 漏了 —— 于是 `DNS.pend` 只进不出，
 * 每次上报都把同一批最多 60 行 DNS 事实重发一遍（v7.139 修的就是这个）。
 * 现在门面只遍历这张数组：新增一类 = 加一个对象，少写一个方法 = `interface FactTable` 报编译错误，
 * 「静默漏接」这件事在类型层就不成立了。
 */
const TABLES: FactTable[] = [
  {
    kind: "eg",
    load: (rows) => EG.load(rows as EgRow[]),
    delta: () => EG.delta(),
    ack: () => EG.ack(),
    nack: () => EG.nack(),
    clear: () => EG.clear(),
    snap: () => EG.snap(),
  },
  {
    kind: "ps",
    load: (rows) => PS.load(rows as PsWire[]),
    delta: () => PS.delta(),
    ack: () => PS.ack(),
    nack: () => PS.nack(),
    clear: () => PS.clear(),
    snap: () => PS.snap(),
  },
  {
    kind: "dead",
    load: (rows) => DEAD.load(rows as DeadWire[]),
    delta: () => DEAD.delta(),
    ack: () => DEAD.ack(),
    nack: () => DEAD.nack(),
    clear: () => DEAD.clear(),
    snap: () => DEAD.snap(),
  },
  {
    kind: "blk2",
    load: (rows) => BLK.load(rows as BlkWire[]),
    delta: () => BLK.delta(),
    ack: () => BLK.ack(),
    nack: () => BLK.nack(),
    clear: () => BLK.clear(),
    snap: () => BLK.snap(),
  },
  {
    kind: "dns",
    load: (rows) => DNS.load(rows as DnsWire[]),
    delta: () => DNS.delta(),
    ack: () => DNS.ack(),
    nack: () => DNS.nack(),
    clear: () => DNS.clear(),
    snap: () => DNS.snap(),
  },
];

/** 门面的返回形状：按字段名给「并入行数」/「快照」。 */
type RowCounts = { eg: number; ps: number; dead: number; blk2: number; dns: number };
type SnapView = { eg: unknown; ps: unknown; dead: unknown; blk: unknown; dns: unknown };

/**
 * 功能：会同步的事实表的门面 —— 收口「冷启动合并 → 上行增量 → ack/nack」三段生命周期。
 *
 * 为什么要这个门面：这几类事实的读写以前散在 `verdictsync`（每类一个 if 块）、`pend`（每类一个 HOOK 槽位）、
 * `policy`（每组一份 ack/nack 注册）。任何一类新增或退场，都要改三处且容易漏 —— 漏了的表现是
 * 「事实在本地学得很好，但别的 isolate 永远收不到」，而单测与链路验收都发现不了（它们测函数本身）。
 *
 * v7.140 起改成表驱动：六个方法都只遍历 `TABLES`，新增一类只需登记一个对象。
 */
export class FactsStore {
  /**
   * 功能：门面登记了哪几类事实（按登记顺序）。
   * 用途：`/health` 与单测用它断言「五张表都在门面里」——没有这一步，漏登记的类别只能靠人眼发现。
   * @returns {string[]} 字段名（`eg`/`ps`/`dead`/`blk2`/`dns`）
   */
  static kinds(): string[] {
    return TABLES.map((t) => t.kind);
  }

  /**
   * 功能：把远端拉回的事实合并进本地表（各自的 `load` 都只认更新的观测）。
   * @param b 远端车身
   * @returns {RowCounts} 各类实际并入的行数
   */
  static load(b: FactsBody): RowCounts {
    const out: RowCounts = { eg: 0, ps: 0, dead: 0, blk2: 0, dns: 0 };
    for (const t of TABLES) {
      const rows = b[t.kind];
      // 远端车身是不可信输入：字段不是数组就当作「这一类没有内容」，而不是整包丢弃
      if (Array.isArray(rows)) out[t.kind] = t.load(rows);
    }
    return out;
  }

  /**
   * 功能：取出待上行的增量（未 ack 的行会原样再给一次：重发等于重试，不是重复计数）。
   * @returns {FactsDelta} 各类增量（空的那类不出现）
   */
  static delta(): FactsDelta {
    const out: FactsDelta = {};
    // 逐类写入：`FactsDelta` 的每个字段类型不同，这里只按字段名赋值，类型由各表自己的 `delta()` 保证
    const bag = out as Record<string, unknown>;
    for (const t of TABLES) {
      const rows = t.delta();
      if (rows.length) bag[t.kind] = rows;
    }
    return out;
  }

  /**
   * 功能：上报成功 —— 五张表的 pending 全部转正。
   * @returns {void}
   */
  static ack(): void {
    for (const t of TABLES) t.ack();
  }

  /**
   * 功能：上报失败 —— 保留 pending，下一轮原样重发（`nack` 在各表里都是「不动 pending」的显式声明）。
   * @returns {void}
   */
  static nack(): void {
    for (const t of TABLES) t.nack();
  }

  /**
   * 功能：给 `/health` 用的五类事实概览。
   * @returns {SnapView} 各类快照
   */
  static snap(): SnapView {
    const out: Record<string, unknown> = {};
    for (const t of TABLES) out[t.kind] = t.snap();
    return out as SnapView;
  }

  /** 功能：清空五张表（测试用）。 @returns {void} */
  static clear(): void {
    for (const t of TABLES) t.clear();
  }
}
