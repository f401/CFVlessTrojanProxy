/**
 * `/add` 的合并逻辑：把一次上报的增量并进账本（用量、日计数、错误环、连接观测、六类事实）。
 *
 * 为什么是一个类而不是一个函数：这里原本是 145 行的 `applyAdd`，八件事首尾相接 ——
 * 日计数、错误环、连接观测、判定表、六张事实表、中继存活度、节点快照、用量。
 * 它们各自的合并口径完全不同（有的相加、有的「一条证据整体胜出」、有的取更严格的状态），
 * 但都写在同一个函数体里，改其中一段时必须通读全部八段才知道自己会不会动到邻居。
 * 现在八段各是一个私有方法，`apply()` 只按固定顺序分派；`FactMerger`（六张事实表的规矩）
 * 是它的私有成员，不再需要一个模块级单例。
 *
 * 为什么从 `Meter` 里搬出来：这 160 行让 `src/store/meter.ts` 超出「单文件 ≤560 行」的硬上限，
 * 而它只读写字面字段、不碰 storage —— `Meter.handle()` 只剩「快照 → 合并 → 落盘 → 失败回滚」。
 */
import { St } from "../core/enums";
import { FactMerger } from "./factmerge";
import type { FactTables } from "./metershard";

/** 合并目标：`Meter` 公开的账本字段 + 七张事实表（行形状单一真源在 metershard.ts） */
export interface AddTarget extends FactTables {
  usage: UsageMeter;
  dayCounter: CounterDoc;
  nodeSnapshots: Record<string, NodeSnap>;
  errors: ErrItem[];
  connRing: ClRec[];
}

/**
 * 一次 `/add` 上报的合并器：八段口径各一个方法，`apply()` 只负责顺序。
 *
 * 顺序不能随意换：`verdicts` 必须在 `merger.merge` 之前（判定表的裁剪按到期时间，
 * 与事实表互不影响，但视图层先写后读更符合直觉）；`usage` 放最后，
 * 因为它是唯一会跨天清零的一段，先清零再叠加当次字节才不会把今天的量算进昨天。
 */
export class MeterAdd {
  /** 六张事实表的合并规矩（`eg`/`ps`/`dead`/`blk2`/`dns`，每张表一个方法） */
  private readonly merger = new FactMerger();

  /**
   * 功能：把一次上报的增量并进账本（纯内存，落盘由调用方负责）。
   * @param {AddTarget} m 账本
   * @param {MeterBody} d 上报体（`c`/`e`/`cl`/`vt`/`hl`/`spd`/事实表/`up`/`down`/`conns`）
   * @returns {void}
   */
  apply(m: AddTarget, d: MeterBody): void {
    // 顺序即口径：先把「搭便车上来的」四类小表合并，再让事实表并入，最后结算用量
    this.dayCounter(m, d);
    this.errors(m, d);
    this.connRing(m, d);
    this.verdicts(m, d);
    this.merger.merge(m, d);
    this.relayHealth(m, d);
    this.snapshots(m, d);
    this.usage(m, d);
  }

  /**
   * 功能：合并 isolate 的日计数（同一次请求搭便车上来，0 额外请求）。
   * @param {AddTarget} m 账本
   * @param {MeterBody} d 上报体
   * @returns {void}
   */
  private dayCounter(m: AddTarget, d: MeterBody): void {
    if (!d.c || typeof d.c !== "object" || Array.isArray(d.c)) return;
    const d0 = String(d.c.d || new Date().toISOString().slice(0, 10));
    // 只接受"今天"或更新的一天：旧的 isolate 可能带着昨天的计数晚到，
    // 不能让它把全局日计数回滚到昨天，更不能把旧数加进今天。
    if (!m.dayCounter || !m.dayCounter.d || d0 > m.dayCounter.d) m.dayCounter = { d: d0 };
    if (m.dayCounter.d !== d0) return;
    for (const [k, v] of Object.entries(d.c)) {
      // 这三个键名来自 JSON 解析，直接当普通属性写会污染原型链
      if (k === "d" || k === "__proto__" || k === "constructor" || k === "prototype") continue;
      if (!(Number(v) > 0)) continue;
      m.dayCounter[k] = (Number(m.dayCounter[k]) || 0) + Number(v);
    }
  }

  /**
   * 功能：按时间戳去重合并错误环（不同 isolate 报各自的 40 条）。
   * @param {AddTarget} m 账本
   * @param {MeterBody} d 上报体
   * @returns {void}
   */
  private errors(m: AddTarget, d: MeterBody): void {
    if (!Array.isArray(d.e) || !d.e.length) return;
    const seen = new Set(m.errors.map((x) => x && x.t));
    for (const x of d.e) {
      if (!x || !x.t || seen.has(x.t)) continue;
      m.errors.push(x);
      seen.add(x.t);
    }
    m.errors.sort((a, b) => a.t - b.t);
    if (m.errors.length > 50) m.errors = m.errors.slice(-50);
  }

  /**
   * 功能：连接观测按节点合并（不同 isolate 各报一段）：计数相加，分位数取最新一段。
   * @param {AddTarget} m 账本
   * @param {MeterBody} d 上报体
   * @returns {void}
   */
  private connRing(m: AddTarget, d: MeterBody): void {
    if (!Array.isArray(d.cl) || !d.cl.length) return;
    // 时间戳必须严格大于表里已有的任何一条（v7.215）：同一毫秒里连着来两批时，
    // 时间戳相同会让排序退回插入序，「插得最早」的那条又被当成最旧的删掉 ——
    // 而它恰恰可能是样本最多的节点。取 max(now, 表内最大 + 1) 就永不并列。
    let clNow = Date.now();
    for (const r of m.connRing) {
      const t0 = Number(r.t) || 0;
      if (t0 >= clNow) clNow = t0 + 1;
    }
    for (const x of d.cl) {
      if (!x || typeof x.n !== "number" || typeof x.k !== "string") continue;
      const old = m.connRing.find((r) => r.k === x.k);
      if (!old) {
        m.connRing.push({ k: x.k, n: x.n, ok: x.ok, p50: x.p50, p95: x.p95, dn: x.dn, t: clNow });
        continue;
      }
      old.n += x.n;
      old.ok += x.ok;
      old.dn += x.dn;
      old.p50 = x.p50;
      old.p95 = x.p95;
      // 刷新时间戳（v7.215）：淘汰按它排序，活跃节点不能因为「插得早」先被删
      old.t = clNow;
    }
    if (m.connRing.length <= 60) return;
    // 按最近更新时间淘汰（v7.215）：以前按插入序 slice(-60)，而合并是就地累加、不移动位置，
    // 于是「最先进来的、样本最多的那个节点」永远排在最前，表一满就先被删，
    // 一次性的新节点反而都留着。没有 t 的老行按 0 处理，先按样本数少的淘汰（它们本来就更旧）。
    m.connRing.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0) || (a.n || 0) - (b.n || 0));
    m.connRing = m.connRing.slice(-60);
  }

  /**
   * 功能：合并中继判定（只保留未过期的，最多 200 条）。
   * @param {AddTarget} m 账本
   * @param {MeterBody} d 上报体
   * @returns {void}
   */
  private verdicts(m: AddTarget, d: MeterBody): void {
    // 这一段以前被整块嵌在上面那个 `d.cl` 判断里：同一批没有连接观测时，DO 会静默丢掉它们，
    // 而发送侧照样 syncAck —— 增量就此蒸发（同一形状在 `hl`/`blk`/事实表上各犯过一次）。
    if (!Array.isArray(d.vt) || !d.vt.length) return;
    const nowVt = Date.now();
    for (const r of d.vt) {
      if (!r || typeof r.k !== "string" || typeof r.t !== "number") continue;
      if (r.t <= nowVt) continue;
      // 状态必须一起存（v7.164）：只存到期时间的话，`dead` 读回来一律变 `blocked`，
      // `policy` 里的硬排除退化成 ×6 降权，一条连不上的中继会继续占 `connect()` 名额。
      // 合并口径：更晚到期的那条胜；同一时刻取更严格的状态（3 > 2）。
      const s = r.s === St.Dead ? St.Dead : St.Blocked;
      const old = m.vt[r.k];
      const oldT = typeof old === "number" ? old : old ? old.t : 0;
      const oldS = typeof old === "number" ? St.Blocked : old ? old.s : 0;
      const t = Math.max(oldT, r.t);
      m.vt[r.k] = { s: t > oldT ? s : Math.max(oldS, s), t };
    }
    const ks = Object.keys(m.vt);
    if (ks.length <= 200) return;
    const expOf = (k: string): number => {
      const v = m.vt[k];
      return typeof v === "number" ? v : v.t;
    };
    // 留最晚到期的 200 条：按到期时间降序取前 200，其余删掉
    ks.sort((a, b) => expOf(b) - expOf(a));
    for (const k of ks.slice(200)) delete m.vt[k];
  }

  /**
   * 功能：合并中继存活度（加性合并，避免别的 isolate 的旧数据把本地结论冲掉）。
   * @param {AddTarget} m 账本
   * @param {MeterBody} d 上报体
   * @returns {void}
   */
  private relayHealth(m: AddTarget, d: MeterBody): void {
    if (!Array.isArray(d.hl) || !d.hl.length) return;
    const nowHl = Date.now();
    for (const r of d.hl) {
      if (!r || typeof r.i !== "string") continue;
      const o0 = Number(r.o) || 0;
      const b0 = Number(r.b) || 0;
      const d0 = Number(r.d) || 0;
      // 别处的时钟可能快于本地：未来时间戳夹回 now，否则半衰期算出来是负数
      const t0 = Math.min(Number(r.t) || nowHl, nowHl);
      const cur0 = m.hl[r.i];
      // 一条证据整体胜出（v7.181）：以前逐字段取 max，会把「三小时前 9 次成功」与
      // 「刚刚 6 次失败」拼成 { o:9, b:6, t:刚刚 } —— 一条从未发生过的证据，
      // 而客户端的 30 分钟半衰期正是按 t 算的，最容易过期的那批数据反而永远新鲜
      // （7.161 在客户端 merge 里修过同一形状，DO 这层漏了）。
      const inN = o0 + b0 + d0;
      const curN = cur0 ? cur0.o + cur0.b + cur0.d : -1;
      if (!cur0 || inN > curN || (inN === curN && t0 > (Number(cur0.t) || 0))) {
        m.hl[r.i] = { o: o0, b: b0, d: d0, t: t0 };
      }
    }
    const hk = Object.keys(m.hl);
    if (hk.length <= 200) return;
    // 留最新的 200 条（v7.181）：按插入顺序切会删掉刚写进来的那条，
    // 新中继的健康证据永远进不了表（同 7.177 的 pend 星形饥饿）。
    hk.sort((x, y) => (Number(m.hl[y].t) || 0) - (Number(m.hl[x].t) || 0));
    for (const k of hk.slice(200)) delete m.hl[k];
  }

  /**
   * 功能：合并节点快照（新的覆盖旧的，只留最近活跃的 64 个）。
   * @param {AddTarget} m 账本
   * @param {MeterBody} d 上报体
   * @returns {void}
   */
  private snapshots(m: AddTarget, d: MeterBody): void {
    if (!d.spd || typeof d.spd !== "object") return;
    for (const [k, v] of Object.entries(d.spd)) {
      if (!v || typeof v !== "object") continue;
      // 键来自 JSON，且会被当成普通属性写进快照表
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      const old = m.nodeSnapshots[k];
      // 新的覆盖旧的（按快照时间，不是按到达顺序）
      if (!old || (v.at || 0) >= (old.at || 0)) m.nodeSnapshots[k] = v;
    }
    // 池子每天换代，旧节点快照会无限累积；只留最近活跃的 64 个
    const sk = Object.keys(m.nodeSnapshots);
    if (sk.length <= 64) return;
    sk.sort((a, b) => (m.nodeSnapshots[a].at || 0) - (m.nodeSnapshots[b].at || 0));
    for (let i = 0; i < sk.length - 64; i++) delete m.nodeSnapshots[sk[i]];
  }

  /**
   * 功能：结算用量（累计值 + 当日值，跨天自动清零）。
   * @param {AddTarget} m 账本
   * @param {MeterBody} d 上报体
   * @returns {void}
   */
  private usage(m: AddTarget, d: MeterBody): void {
    const usage = m.usage;
    const up = Number(d.up) || 0;
    const down = Number(d.down) || 0;
    usage.up += up;
    usage.down += down;
    usage.conns += Number(d.conns) || 0;
    // 当日字节：跨天自动清零。累计值 up/down 是订阅头用的（协议惯例），
    // 面板上的"今日"用这一份 —— 否则用户永远只看到历史总量。
    const today0 = new Date().toISOString().slice(0, 10);
    if (usage.d !== today0) {
      usage.d = today0;
      usage.dU = 0;
      usage.dD = 0;
    }
    usage.dU = (usage.dU || 0) + up;
    usage.dD = (usage.dD || 0) + down;
    usage.ts = Date.now();
    if (!usage.first) usage.first = usage.ts;
  }
}
