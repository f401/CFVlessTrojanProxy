import { S } from "../core/state";
import { HOOK } from "../core/hook";
import { SC } from "../core/const";
import { cnt, cntDelta, cntUnsend } from "../core/counter";
import { eachLimit } from "../core/util";
import { spdSnapshot } from "../core/obs";
import { doFetch } from "./meter-client";

/* PEND 缓冲：连接侧只记增量，30 秒一批推给 Meter DO */

export const PEND_FLUSH_BYTES = 16 * 1024 * 1024; // 大文件传输时别频繁打 DO：DO 调用会吃这条连接的 CPU

/**
 * 功能：这一轮「搭车增量」的状态（挂在主 uuid 的那个请求体上）。
 *
 * 为什么要独立对象：日计数、判定/健康/事实、连接观测三样增量每轮只出现一次，
 * 确认与退回都必须精确落到「挂着它的那个请求」——其它用户的成功不能再去 ack 一次
 * （会把连接观测的行重复相减、还会把在途期间新加的待发行一起清掉）。
 */
interface PendCarry {
  /** 挂了增量的用户（小写）；空串表示这一批还没人挂 */
  owner: string;
  /** 是否挂了判定 / 健康 / 事实增量（只影响 syncAck / syncNack 要不要调） */
  sync: boolean;
  /** 这一批真发出去的连接观测行（成功后按行相减，不是整表清空） */
  rows: ClRec[];
}

/**
 * 功能：待上报账本（用户 → 未提交的字节/连接数）与上报节流器。
 *
 * 为什么要攒：每次上报都是一次 DO 调用，逐包上报会把连接的 CPU 烧光；
 * 攒到 16 MB 或有定时器到期再一次性推。失败必须回滚，否则字节账会凭空消失。
 */
export class PendingLedger {
  /** 上次实际上报的时刻 */
  private flushedAt = 0;
  /** 单飞守卫：一次只跑一轮 flush，避免跨 flush ack 串扰 */
  private flushing = false;
  /** 单飞期间被跳过的 force 上报：本轮结束后补排一次（否则定时器意图被吞） */
  private forceSkipped = false;
  /** flush 定时器句柄 */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** 轮转起点：下一轮从第几个用户开始读 */
  private cursor = 0;
  /**
   * 功能：取主用户 id（env.uuid/uuids 的第一个，去空白）。
   * @param env 环境变量
   * @returns 用户 id；没有时返回空串
   */
  id(env: Env): string {
    return String((env && (env.uuid || env.uuids)) || "")
      .split(",")[0]
      .trim()
      .toLowerCase();
  }

  /**
   * 功能：把一段流量记进待上报账本。
   * @param id 用户 id
   * @param up 上行字节
   * @param down 下行字节
   * @param isNew 是否新连接（用于 conns 计数）
   * @returns 无
   */
  add(id: string, up: number, down: number, isNew?: boolean): void {
    if (!id) return;
    const p = S.pend.get(id) || { up: 0, down: 0, conns: 0 };
    p.up += up || 0;
    p.down += down || 0;
    S.pendBytes += (up || 0) + (down || 0);
    if (isNew) p.conns += 1;
    // 以前超过 500 个用户就整体 clear()，一次丢掉所有未推送的字节账。
    // 用户数由用户表决定，内存有界，保留比丢账安全。
    S.pend.set(id, p);
  }

  /**
   * 功能：安排一次上报。已有定时器时，大流量触发的 delay=0 不能被之前的 30 秒定时器压住。
   * @param env 环境变量
   * @param delay 延迟毫秒，0 表示尽快
   * @returns 无
   */
  schedule(env: Env, delay?: number): void {
    if (this.flushTimer) {
      // 大流量触发 delay=0 时，不能被之前排好的 30 秒定时器压住
      if (delay !== 0) return;
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const d = delay === undefined ? S.pendMs : delay;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush(env, true).catch(() => {});
    }, d);
  }

  /**
   * 功能：只有计数、没有字节时账本是空的，塞一个空批次把计数顶出去。
   * @param env 环境变量
   * @param id 用户 id
   * @returns 无
   */
  kick(env: Env, id: string | null): void {
    if (!env || !id || !env.METER) return;
    if (!S.pend.has(id)) S.pend.set(id, { up: 0, down: 0, conns: 0 });
    this.schedule(env, 0);
  }

  /**
   * 功能：把待上报账本 POST 给 DO。成功才 ack（否则 nack 以便重算），失败回滚流量。
   *
   * 这一层只做编排：摘批 → 拼体（顺带搭车）→ 发 → 确认或退回 → 调退避。
   * 每一步的判据都在各自方法里，本函数不再出现「谁挂了增量」这类条件。
   * @param env 环境变量
   * @param force 忽略节流
   * @param max 本轮最多带几个用户（每人一次 DO 往返；由 `planRound` 按剩余额度分给这里）
   * @returns 无
   */
  async flush(env: Env, force?: boolean, max: number = SC.PEND_MAX): Promise<void> {
    if (!env || !env.METER || !S.pend.size) return;
    // 两批并发会各 carry 同一组事实增量：先回来的 ack() 把整张 pending 清空，
    // 后回来那批失败时 nack() 已无从撤销 —— 证据永久丢失。同一 isolate 只跑一批；
    // 被跳过的那批什么都没摘、也没登记 pending，证据仍在原表里等下一轮。
    if (this.flushing) {
      // 单飞期间又来一次上报（定时器到点 / 大流量 kick）：记下来，等这轮结束补排。
      // 不补排的话定时回调已经清掉 flushTimer，这一轮 force 意图就被单飞吞掉，
      // 新到的字节账要等下一次外部请求/cron 才上报（7.270 无单飞，并发两批不会吞）。
      if (force) this.forceSkipped = true;
      return;
    }
    this.flushing = true;
    try {
      if (!force && Date.now() - this.flushedAt < S.pendMs) return;
      this.flushedAt = Date.now();
      const batch = this.take(max);
      if (!batch.length) return;
      // 快照固定挂在主 uuid 的对象上：挂到"批次第一个"会挂到另一个用户，
      // 结果面板（读主 uuid）永远看不到更新。
      const primary = this.id(env);
      // 日计数只搭主 uuid 的车：主 uuid 这批没有流量时不要先 cntDelta（会推进基线），
      // 否则计数会永久丢；等主 uuid 下次有批次再一起发。
      const hasPrimary = !primary || batch.some(([bid]) => String(bid).toLowerCase() === primary);
      const cd = hasPrimary ? cntDelta() : {};
      const today = new Date().toISOString().slice(0, 10);
      const carry: PendCarry = { owner: "", sync: false, rows: [] };
      let bad = 0;
      await eachLimit(batch, 8, async ([id, d]) => {
        const mine = !primary || String(id).toLowerCase() === primary;
        try {
          await this.post(env, id, this.body(id, d, mine, cd, today, carry));
          this.ack(id, carry);
        } catch {
          bad += 1;
          this.rollback(id, d, cd, mine, carry);
        }
      });
      this.backoff(bad);
    } finally {
      this.flushing = false;
      // 本轮结束：若期间有 force 被单飞挡下（定时句柄已消费），补排一次尽快上报。
      // 用定时器而非直接递归 flush，避免同步深递归；没有账本时 schedule 的回调会自然早退。
      if (this.forceSkipped) {
        this.forceSkipped = false;
        this.schedule(env, 0);
      }
    }
  }

  /**
   * 功能：从账本里摘出这一轮要发的批次（轮转起点、只摘这一批、重算剩余字节）。
   *
   * 为什么必须轮转起点：Map 的插入顺序几乎不变，只取前 N 个会让尾部用户长期推不上去
   * （表现是「用量永远落后」，而失败批次会照常回滚、只把退避翻倍，看不出是截断）。
   * @param max 本轮最多带几个用户
   * @returns 批次（用户 id → 增量）；空数组表示账本里没有可发的
   */
  private take(max: number): Array<[string, PendEntry]> {
    const all = [...S.pend.entries()];
    if (!all.length) return [];
    const start = (this.cursor || 0) % all.length;
    const rotated = all.slice(start).concat(all.slice(0, start));
    // 一轮最多带 PEND_MAX 个用户：每个用户 1 次 DO 往返，一轮总量不能超 50 子请求额度。
    const batch = rotated.slice(0, Math.max(1, Math.min(SC.PEND_MAX, max)));
    this.cursor = (start + batch.length) % all.length;
    if (rotated.length > batch.length) cnt("pendSkip", rotated.length - batch.length);
    // 只摘掉这一批：在途期间新加的增量留在账本里，下一轮接着发（不是整表清空）
    for (const [bid] of batch) S.pend.delete(bid);
    S.pendBytes = 0;
    for (const [, left] of S.pend) S.pendBytes += left.up + left.down;
    return batch;
  }

  /**
   * 功能：拼出一个用户的请求体，并让主 uuid 那一批顺带捎上增量。
   * @param id 用户 id
   * @param d 该用户的增量
   * @param mine 这一批是不是主 uuid（只有主 uuid 才搭车）
   * @param cd 本轮的计数增量（主 uuid 这批没出现时是空对象）
   * @param today 今天的日期串
   * @param carry 搭车状态（写它的字段等于登记「这一批由谁挂了增量」）
   * @returns 请求体
   */
  private body(
    id: string,
    d: PendEntry,
    mine: boolean,
    cd: Record<string, number>,
    today: string,
    carry: PendCarry,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = { ...d };
    // 已经有人挂过就不再挂：增量只出现一次，否则 DO 会把同一份计数重复并入
    if (carry.owner || !mine) return body;
    body.c = { ...cd, d: today }; // 只挂一次，避免重复计
    body.spd = spdSnapshot(); // 节点快照：跨 isolate 可见
    body.e = S.errs.slice(-8); // 错误也带上去：/logs 才能跨 isolate
    if (HOOK.vtDelta) {
      const vt = HOOK.vtDelta();
      if (vt.length) body.vt = vt;
      const hl = HOOK.healthDelta ? HOOK.healthDelta() : [];
      if (hl.length) body.hl = hl;
    }
    // 六类事实一次取齐：新增一类只需改 FactsStore，不必在这里加槽位
    const fd = HOOK.factsDelta ? HOOK.factsDelta() : null;
    if (fd) {
      if (fd.blk2 && fd.blk2.length) body.blk2 = fd.blk2;
      if (fd.dead && fd.dead.length) body.dead = fd.dead;
      if (fd.ps && fd.ps.length) body.ps = fd.ps;
      if (fd.eg && fd.eg.length) body.eg = fd.eg;
      if (fd.dns && fd.dns.length) body.dns = fd.dns;
    }
    const cl = this.clSnap(40);
    if (cl.length) body.cl = cl; // 连接观测（按节点聚合）：同理，离线可标定
    // 三样增量都只是「登记进请求体」，真正的提交要等 DO 回 200：
    // 这里以前顺手 S.cagg.clear()，一旦 POST 失败这 40 条观测就永久蒸发。
    carry.owner = String(id).toLowerCase();
    carry.sync = true;
    carry.rows = cl;
    return body;
  }

  /**
   * 功能：把一个用户的增量 POST 给计量 DO。
   * @param env 环境变量
   * @param id 用户 id
   * @param body 请求体
   * @returns 无；非 2xx 时抛错，由调用方回滚
   */
  private async post(env: Env, id: string, body: Record<string, unknown>): Promise<void> {
    const r = await doFetch(env, id, "https://meter/add", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("do " + r.status);
  }

  /**
   * 功能：确认这一批送达，并顺带确认它挂着的增量。
   *
   * 只有挂了增量的那一批能确认它们：每条增量只出现在一个请求体里，其它用户批次成功时
   * 再 ack 一次会把 clSnap 的行重复相减、还会把在途期间新加的待发行一起清掉。
   * @param id 刚成功的用户
   * @param carry 搭车状态（`by` 为空表示这一批没人挂增量）
   * @returns 无
   */
  private ack(id: string, carry: PendCarry): void {
    if (carry.owner && String(id).toLowerCase() === carry.owner) {
      if (carry.sync && HOOK.syncAck) HOOK.syncAck();
      // 按行相减，而不是把整张表清掉（v7.157）：在途期间新加的观测必须留下
      if (carry.rows.length) this.clAck(carry.rows);
    }
    S.meterCache.delete(id); // 刚推过增量，缓存立即失效，避免读数倒退
  }

  /**
   * 功能：失败时把这一批的字节退回账本，并按需退回增量。
   * @param id 失败的用户
   * @param d 被摘走的增量
   * @param cd 本轮计数增量
   * @param mine 是不是主 uuid 这一批
   * @param carry 搭车状态
   * @returns 无
   */
  private rollback(
    id: string,
    d: PendEntry,
    cd: Record<string, number>,
    mine: boolean,
    carry: PendCarry,
  ): void {
    const cur = S.pend.get(id) || { up: 0, down: 0, conns: 0 };
    S.pend.set(id, { up: cur.up + d.up, down: cur.down + d.down, conns: cur.conns + d.conns });
    S.pendBytes += (d.up || 0) + (d.down || 0); // 回滚失败批次：健康页与立即刷新的判断要准
    if (carry.owner && String(id).toLowerCase() === carry.owner) {
      if (mine) cntUnsend(cd); // 日计数搭车主批次失败 → 基线退回，下轮重发
      if (carry.sync && HOOK.syncNack) HOOK.syncNack(); // 判定/中继增量退回，下轮重发
    }
    // 失败也要让用量缓存失效：在途期间别的 isolate 可能已经改了账本，
    // 留着旧缓存会让 readStats 继续返回过期值（与 ack 分支对称，1.2）
    S.meterCache.delete(id);
  }

  /**
   * 功能：按这一轮失败数调上报间隔（失败翻倍，最多 60s；成功慢慢降回 30s）。
   * @param bad 本轮失败的批次数
   * @returns 无
   */
  private backoff(bad: number): void {
    if (!bad) {
      S.pendMs = Math.max(30000, Math.round(S.pendMs / 2));
      return;
    }
    // 失败批次已经回滚进账本、间隔也翻倍了，但「这一轮一个都没发出去」与「这一轮没人有增量」
    // 在面板上完全一样。计数是唯一能区分两者的量：它连着涨说明 DO 侧一直没接受上报。
    cnt("pendFail", bad);
    S.pendMs = Math.min(S.pendMs * 2, 60000);
  }

  /**
   * 功能：连接观测快照：把本 isolate 的按节点聚合转成可上报的行。
   * @param max 最多返回几行
   * @returns 按样本数降序的观测行（p50/p95 由最近 64 条首字节算）
   */
  clSnap(max = 40): ClRec[] {
    const out: ClRec[] = [];
    for (const [k, g] of S.cagg) {
      if (!g.n) continue;
      const v = g.v.slice().sort((a, b) => a - b);
      // 分位用「上取整」索引：样本少时也要给出一个真实观测值，而不是 0
      // 分位用 nearest-rank：索引 = ceil(p*n) - 1（下限 0、上限 n-1）。
      // 旧写法 floor(p*n) 在小样本上系统性偏慢一位：n=2 时 p50 直接等于最大值，n=10 时等于第 6 小；
      // 面板与 DO 里的 p50 是给「这个节点的首字节到底多慢」定性的，偏慢一位会把快节点也报成慢。
      const q = (p: number) => {
        if (!v.length) return 0;
        const i = Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1));
        return v[i];
      };
      out.push({ k, n: g.n, ok: g.ok, p50: q(0.5), p95: q(0.95), dn: g.dn });
    }
    out.sort((a, b) => b.n - a.n);
    return out.slice(0, max);
  }

  /**
   * 功能：确认一批连接观测已进 DO，按「发出去多少」相减，而不是整表清空。
   *
   * 为什么不能 clear()：`S.cagg` 里有两种「还没发出去的」东西 —— ① 这一轮被
   * `clSnap(40)` 的上限挤掉的键（池子可以有 400 个聚合键，每次只发 40 条），
   * ② POST 在途期间新结束的连接（await 期间生产者还在写）。整表清空会把它们
   * 一起抹掉，等于每次上报都丢掉一部分观测，且没有任何计数能看出来。
   * 因为行是「自上次确认以来的增量」、DO 侧按加法合并，所以这里也必须按数量
   * 相减：减到 0 才删键，剩下的留给下一轮。
   * @param sent 这一批请求体里实际发出的行（来自 `clSnap`）
   * @returns 无
   */
  clAck(sent: ClRec[]): void {
    for (const s of sent) {
      const g = S.cagg.get(s.k);
      if (!g) continue;
      g.n -= s.n;
      g.ok -= s.ok;
      g.dn -= s.dn;
      // 计数减到 0 就整键删掉：留着空壳会让 `clSnap` 继续为它算分位，
      // 也会让 `S.cagg.size` 的 400 上限被死键占满。
      if (g.n <= 0 && g.dn <= 0) S.cagg.delete(s.k);
    }
  }
}

/** 进程内单例：待上报账本（每个 isolate 各自维护） */
export const PEND = new PendingLedger();

/**
 * 功能：把一段流量记进待上报账本（薄包装，委托 PEND.add）。
 * @param id 用户 id
 * @param up 上行字节
 * @param down 下行字节
 * @param isNew 是否新连接
 * @returns 无
 */
export function pendAdd(id: string, up: number, down: number, isNew?: boolean): void {
  PEND.add(id, up, down, isNew);
}

/**
 * 功能：安排一次上报（薄包装，委托 PEND.schedule）。
 * @param env 环境变量
 * @param delay 延迟毫秒，0 表示尽快
 * @returns 无
 */
export function scheduleFlush(env: Env, delay?: number): void {
  PEND.schedule(env, delay);
}

/**
 * 功能：塞一个空批次把计数顶出去（薄包装，委托 PEND.kick）。
 * @param env 环境变量
 * @param id 用户 id
 * @returns 无
 */
export function kickFlush(env: Env, id: string | null): void {
  PEND.kick(env, id);
}

