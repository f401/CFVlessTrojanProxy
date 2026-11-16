// 「这个站点在这个出口上被单 IP 封锁」事实（v8 §3 的 `blk`）。
//
// 这是全套事实里最危险的一张表：它是唯一会让「少发请求」的事实，所以门槛必须由**结构**决定，
// 而不是由「看起来像封锁页」决定：
// 1) 三批独立确认：同一批里的 3 次观测只能算 1 票（同一时刻的连续请求会共享同一个倒霉后端）。
// 2) 每批之间至少 60 秒：X 的拒绝是请求级/概率级的（同一出口 2/5），间隔太短等于重复掷骰子。
// 3) 每批至少要 3 次 tiny 观测（§3.2 规则 5），防止「偶发一个空体响应」就定价。
// 4) 反向证据优先：3 分钟内同通道出过整页（≥20KB）就不算，直接丢弃本批（`R_CONTRADICTORY`）。
//
// 而它的**后果**被设计成软的：`blk` 只把代价乘 6（`BLK_PEN`），永不把候选移出。
// 理由写在 v8.md §15 的 I1：业务 403 也一定带状态行、也可能是小响应，只有让「判错」的代价
// 只是「顺序变差」而不是「发不出去」，才可能满足「业务 403 绝对不会被误伤」。
import { cnt } from "../core/counter";
import { BLK_TTL } from "./commitfact";

/** 需要几批独立确认 */
export const BLK_BATCH = 3;
/** 每批至少几次 tiny 观测 */
export const BLK_MIN = 3;
/** 两批之间的最小间隔（60 秒） */
export const BLK_GAP = 60000;
/** 命中后的代价倍数（只折价，不排除） */
export const BLK_PEN = 6;
/** 表上限 */
export const BLK_MAX = 1024;
/** 站点级自愈：同一站点被写满这么多行（且 ≥75% 候选）就整体清空并静默 30 分钟 */
export const BLK_SWEEP_MIN = 3;
/** 静默时长 */
export const BLK_MUTE = 30 * 60000;
/** 静默表的容量上限：键是客户端带来的站点名，30 分钟 TTL 内可以灌任意多条（v7.230） */
export const BLK_MUTE_MAX = 256;

/** 累计中的一批 */
interface Batch {
  /** 当前这一批里已经看到的 tiny 次数 */
  n: number;
  /** 当前这一批的开始时间 */
  at: number;
  /** 已经确认完成的批数 */
  done: number;
  /** 上一批完成的时间（用于强制两批之间 ≥ BLK_GAP） */
  last: number;
}
/** 已确认的封锁行 */
interface Row {
  /** 确认时的批数（= BLK_BATCH） */
  n: number;
  /** 最后一批的时间 */
  at: number;
}

/** 上报行 */
export interface BlkWire {
  /** `host|relay` */
  k: string;
  /** 批数 */
  n: number;
  /** 时间 */
  at: number;
}

/**
 * 功能：单 IP 封锁事实表。键是 `站点|出口 IP`（不是站点级，也不是通配）。
 */
export class BlkFacts {
  private rows = new Map<string, Row>();
  private batch = new Map<string, Batch>();
  private pend = new Map<string, Row>();
  // 这一批真正发出去的行（键 → 发出时的 at）：ack 只清它们，见 ack() 的注释
  private sent = new Map<string, number>();
  private mute = new Map<string, number>();

  /**
   * 功能：喂一次 tiny 观测。
   * @param {{host: string; ip: string; down: number; peerBig: boolean; at: number}} o 观测
   * @returns {boolean} true 表示这次观测让一个 key 完成了确认（写入了封锁行）
   */
  note(o: { host: string; ip: string; down: number; peerBig: boolean; at: number }): boolean {
    if (!o.host || !o.ip) return false;
    // 没有同窗口的整页对照 ⇒ 连票都不投：这是 §4 的三条禁令之一
    if (!o.peerBig) {
      cnt("blkNoPeer");
      return false;
    }
    if (this.muted(o.host, o.at)) return false;
    // `batch` 与 `mute` 都按「见过的键」增长（rows 有 BLK_MAX 与 drop，这两张没有）：
    // 超过上限时扫一遍 —— 批的有效窗口只有 BLK_GAP，更旧的批下次只会被当成换批重置。
    if (this.batch.size + this.mute.size > BLK_MAX) this.trim(o.at);
    const k = o.host + "|" + o.ip;
    const b = this.batch.get(k);
    if (!b) {
      this.batch.set(k, { n: 1, at: o.at, done: 0, last: 0 });
      return false;
    }
    // 同一批：把观测累计到这一批里（60 秒窗口内的连续请求共享同一个倒霉后端，只能算一批）
    if (o.at - b.at <= BLK_GAP) {
      // 计数只为「这一批够不够 3 次」服务，封顶免得长突发把 n 顶到几千（它只是个计数器）
      b.n = Math.min(BLK_MIN * 4, b.n + 1);
      if (b.n < BLK_MIN) return false;
    } else {
      // 换批：上一批没攒够 BLK_MIN 次就作废（偶发一个空体响应不该定价）。
      // 这条分支必然 return —— 新批的第一条只是「开批」，不是一次投票。
      // （v7.138 之前这里写的是 `b.n = 1; if (b.n < BLK_MIN) return false;`，判断恒真。）
      b.n = 1;
      b.at = o.at;
      return false;
    }
    // 这一批确认了：还要满足「与上一批之间 ≥ BLK_GAP」
    if (b.last > 0 && o.at - b.last < BLK_GAP) return false;
    b.done += 1;
    b.last = o.at;
    if (b.done < BLK_BATCH) {
      cnt("blkBatch");
      return false;
    }
    this.batch.delete(k);
    const row: Row = { n: BLK_BATCH, at: o.at };
    this.rows.set(k, row);
    this.pend.set(k, row);
    cnt("blkWrote");
    if (this.rows.size > BLK_MAX) this.drop(o.at);
    return true;
  }
  /**
   * 功能：反向证据 —— 这个站点在这个出口上刚出过整页，就把累计进度清零。
   * @param {string} host 站点
   * @param {string} ip 出口 IP
   * @returns {void}
   */
  contra(host: string, ip: string): void {
    const k = host + "|" + ip;
    this.batch.delete(k);
    // 这个出口刚刚给出整页 ⇒ 之前的封锁结论不成立，连已确认的行一起清掉
    if (this.rows.delete(k)) cnt("blkContra");
    this.pend.delete(k);
  }

  /**
   * 功能：查询代价倍数（1 = 正常，`BLK_PEN` = 判为封锁，只乘不排）。
   * @param {string} host 站点
   * @param {string} ip 出口 IP
   * @param {number} now 当前时间
   * @returns {number} 代价倍数
   */
  penOf(host: string, ip: string, now = Date.now()): number {
    const r = this.rows.get(host + "|" + ip);
    if (!r) return 1;
    if (now - r.at > BLK_TTL) return 1;
    return BLK_PEN;
  }

  /**
   * 功能：这个站点此刻是否被静默（自愈之后 30 分钟不再写新行）。
   * @param {string} host 站点
   * @param {number} now 当前时间
   * @returns {boolean} true 表示静默中
   */
  muted(host: string, now = Date.now()): boolean {
    const until = this.mute.get(host) || 0;
    // 到期就删：这张表只在 note() 的总量守卫里被清，一条再也不会被查到的静默会一直占着
    if (until && until <= now) {
      this.mute.delete(host);
      return false;
    }
    return until > now;
  }

  /**
   * 功能：清掉两张表里已经不可能再用的条目 —— 超过两倍窗口的批、已经到期的静默。
   *
   * 为什么必须主动清：批进度超过 `BLK_GAP` 就再也延长不了（下次只会走「换批」重置），
   * 静默到期后时间戳也没意义；而这两张表没有容量淘汰，一个长寿命 isolate 里只增不减。
   * @param {number} now 当前时间
   * @returns {void}
   */
  private trim(now: number): void {
    for (const [k, b] of this.batch) if (now - b.at > BLK_GAP * 2) this.batch.delete(k);
    for (const [h, until] of this.mute) if (until <= now) this.mute.delete(h);
    // 过期清不掉（短时间见过一大堆键）时按 `at` 兜底 —— 扔掉一条批进度最多丢两次投票，
    // 而真需要它确认的那条通道，下一次观测会重新开批。
    // 静默表也要有兜底：`sweep()` 写它时不带守卫，30 分钟内见过的站点名可以任意多
    if (this.mute.size > BLK_MUTE_MAX) {
      const oldMute = [...this.mute.entries()].sort((a, b) => a[1] - b[1]).slice(0, this.mute.size - BLK_MUTE_MAX);
      for (const [h] of oldMute) this.mute.delete(h);
    }
    if (this.batch.size <= BLK_MAX) return;
    const old = [...this.batch.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, this.batch.size - BLK_MAX);
    for (const [k] of old) this.batch.delete(k);
  }

  /**
   * 功能：站点级自愈 —— 一个站点被写满「≥3 行且 ≥75% 候选」就说明不是单 IP 封锁，而是站点自己
   * 在拒绝所有人（或我们的对照判据失效）。此时清空该站点所有行并静默 30 分钟。
   * @param {string} host 站点
   * @param {string[]} cands 当前候选 IP 列表
   * @param {number} now 当前时间
   * @returns {boolean} true 表示发生了自愈
   */
  sweep(host: string, cands: string[], now = Date.now()): boolean {
    if (!this.rows.size || !cands.length) return false;
    let hit = 0;
    for (const ip of cands) {
      const r = this.rows.get(host + "|" + ip);
      if (r && now - r.at <= BLK_TTL) hit += 1;
    }
    // 小池子只有 2 条候选时，max(3, 75%) 永远达不到 —— 门槛下限必须跟着池子大小走
    const need = Math.max(Math.min(BLK_SWEEP_MIN, cands.length), Math.ceil(cands.length * 0.75));
    if (hit < need) return false;
    for (const ip of cands) {
      const k = host + "|" + ip;
      this.rows.delete(k);
      this.pend.delete(k);
      this.batch.delete(k);
    }
    this.mute.set(host, now + BLK_MUTE);
    // 唯一一条不经过 note() 的写入：这里也得过一遍守卫，否则静默表只受 TTL 约束
    if (this.mute.size > BLK_MUTE_MAX) this.trim(now);
    cnt("bizSweeps");
    return true;
  }

  /**
   * 功能：导出待上报增量。
   * @returns {BlkWire[]} 最多 60 行
   */
  delta(): BlkWire[] {
    const out: BlkWire[] = [];
    for (const [k, r] of this.pend) {
      out.push({ k, n: r.n, at: r.at });
      this.sent.set(k, r.at);
      if (out.length >= 60) break;
    }
    return out;
  }

  /** 功能：上报成功。@returns {void} */
  ack(): void {
    // 只清这一批真正发出去的行：delta() 有上限（本表最多 60 行），一次清空全部 pending 会让
    // 超出上限的行既没发出去、也不再重发 —— 证据就这样永久丢了（v7.143 修）。
    // 只在值没变新时才清：delta 与 ack 之间可能又记了一条更新的观测，那条还没发过。
    for (const [k, at] of this.sent) {
      const cur = this.pend.get(k);
      if (cur && cur.at <= at) this.pend.delete(k);
    }
    this.sent.clear();
  }

  /** 功能：上报失败（丢弃待发，事实保留）。@returns {void} */
  nack(): void {
    this.sent.clear();
    // 保留 pending：上报失败时下一轮 delta() 会把同一批原样再给一次（重发 = 重试，幂等靠 at）。
    // 清掉它就等于「这条证据从此不会送到 DO」—— 与 v8 §3 的 pending 语义相反（只有 ack 才清）。
  }

  /**
   * 功能：合并远端事实（只认更新的 `at`）。
   * @param {BlkWire[]} rows 远端行
   * @returns {number} 合并条数
   */
  load(rows: BlkWire[]): number {
    let n = 0;
    // 静音期内的站点不再收事实（v7.221）：`sweep` 刚判定「这个站点在拒绝所有人」，于是清表并
    // 静音 30 分钟。别处 isolate 的 blk2 里还躺着同一批「这个出口被封锁」的行，收下来等于把
    // 自愈的结论当场撤销（penOf 又乘 6 倍）—— 而「静音期内不再收新证据」正是 mute 的定义。
    const now = Date.now();
    for (const r of rows) {
      if (!r || typeof r.k !== "string") continue;
      const at = Number(r.at);
      if (!Number.isFinite(at)) continue;
      const cut = r.k.lastIndexOf("|");
      if (cut <= 0) continue;
      if (this.muted(r.k.slice(0, cut), now)) {
        cnt("blkMutedSkip");
        continue;
      }
      const cur = this.rows.get(r.k);
      if (cur && cur.at >= at) continue;
      this.rows.set(r.k, { n: BLK_BATCH, at });
      n += 1;
    }
    if (this.rows.size > BLK_MAX) this.drop(0);
    return n;
  }

  /**
   * 功能：快照（`/health`、单测）。
   * @param {number} now 当前时间
   * @returns {Array<{ k: string; at: number; live: boolean }>} 最多 12 行
   */
  snap(now = Date.now()): Array<{ k: string; at: number; live: boolean }> {
    const out: Array<{ k: string; at: number; live: boolean }> = [];
    for (const [k, r] of this.rows) out.push({ k, at: r.at, live: now - r.at <= BLK_TTL });
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, 12);
  }

  /** 功能：清空（单测用）。@returns {void} */
  clear(): void {
    this.rows.clear();
    this.batch.clear();
    this.pend.clear();
    this.sent.clear();
    this.mute.clear();
  }

  /**
   * 功能：容量淘汰 —— 先扔过期行，再按时间扔最旧的。
   * @param {number} now 当前时间（0 = 只做容量淘汰）
   * @returns {void}
   */
  private drop(now: number): void {
    if (now > 0) for (const [k, r] of this.rows) if (now - r.at > BLK_TTL) this.rows.delete(k);
    if (this.rows.size <= BLK_MAX) return;
    const keys = [...this.rows.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of keys) {
      if (this.rows.size <= BLK_MAX) break;
      this.rows.delete(k);
    }
  }
}

/** 进程内唯一实例 */
export const BLK = new BlkFacts();

/**
 * 功能：薄包装 —— 查询代价倍数。
 * @param {string} host 站点
 * @param {string} ip 出口 IP
 * @param {number} now 当前时间
 * @returns {number} 代价倍数
 */
export function blkPen(host: string, ip: string, now = Date.now()): number {
  return BLK.penOf(host, ip, now);
}
