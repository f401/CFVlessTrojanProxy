// 事实写入决策器（v8 §3.2 的 commitFact）：把「一条连接观测」翻译成「一条事实」或「拒绝理由」。
//
// 为什么要有这一层：v7 里判定散在 judge.ts / verdict.ts / relay-health.ts 三处，同一件事
// 有四种写法（markNeg、markBlocked、vSetState、cnt），谁都能写、谁都能读，出了问题无法回答
// 「这条封锁是谁写的、凭什么」。v8 把写入收敛成一个纯函数：输入一条观测 + 一小份上下文，
// 输出「写什么」或「为什么什么都不写」——纯函数，副作用为零，因此可以用表驱动向量穷举。
//
// 三条铁律（v8 §15 的 I1–I3 在写入侧的体现）：
//   · 直连腿永不写 `blk`：CF 边缘的出口身份不可归属，直连 4xx 只能说明「这一跳被拒」。
//   · 没有同窗口对照就没有封锁：只有「另一条通道拿到整页」才能证明「是这条通道被封」。
//   · 业务 4xx 与封锁必须分开：站点拒绝所有人时写 `blk` 等于把所有通道都打一遍。

/** tiny 的绝对上限：响应小到不像页面（v8 §4；封锁页实测 737B，不是 4 字节） */
export const TINY_ABS = 2048;
/** tiny 的相对上限：小于本站点典型大响应的 20% */
export const TINY_REL = 0.2;
/** 「拿到整页」的门槛：同窗口有通道拿到 ≥20KB */
export const BIG_PEER = 20000;
/** 同窗口宽度：120 秒内的观测可以互为对照 */
export const BIG_WIN = 120000;
/** 确认间隔：第二批至少要隔 60 秒（三批才算 A 级证据） */
/** `blk` 寿命 90 分钟；`ps` 45 分钟（软证据比硬证据过期快） */
export const BLK_TTL = 90 * 60000;
export const DEAD_TTL = 30 * 60000;
/** 同一键 60 秒内最多写一次：facts 是事实，不是日志 */
export const WRITE_GAP = 60000;

/** 一条观测：来自真实连接（relay/direct 腿）或回显探测 */
export interface FactObs {
  /** 观测来自哪条腿：中继腿可写封锁，直连腿不可 */
  kind: "relay" | "direct";
  /** 目标站点主机名（`blk`/`ps` 的键要用到） */
  host: string;
  /** 中继 IP（直连腿没有） */
  relay?: string;
  /** 观测时间（毫秒时间戳） */
  at: number;
  /** 下行字节 */
  down?: number;
  /** HTTP 状态码（0 表示没拿到状态行） */
  status?: number;
  /** 回显探测到的出口族：4 或 6（只有这种观测能直接写 `eg`） */
  echoFam?: number;
  /** 连接层错误类型：x509 / tls / reset / timeout */
  err?: string;
}

/** 写入决策需要的上下文（都是读，调用方负责从事实层/内存表取好） */
export interface FactCtx {
  /** 「现在」：默认取观测时间 */
  now?: number;
  /** 本站点已观测到的典型大响应字节数（0 = 还不知道） */
  bigTypical?: number;
  /** 同窗口内的其他观测（用来找「另一条通道拿到整页」） */
  peers?: FactObs[];
  /** 同键上一次被确认的批次时间（用于「至少要两批」） */
  /** 每个站点最近一次拿到整页的时间（用于「三分钟内还出过整页 → 矛盾」） */
  /** 每个键上次写入时间（用于节流） */
  lastWrite?: Record<string, number>;
}

/** 可以写的事实种类 */
export type FactKind = "eg" | "dead" | "blk" | "ps";

/** 一条待写事实 */
export interface FactWrite {
  kind: FactKind;
  key: string;
  at: number;
  j: Record<string, number | string>;
}

/** 决策结果：要么写一条事实，要么说明为什么弃权 */
export interface FactOut {
  write?: FactWrite;
  /** 拒绝理由码（`ok` 表示放行）；码表见 `docs/v8.md` §3.2 */
  reason: string;
}

/**
 * 功能：判断一条响应是否「小到不像页面」（v8 §4 的结构量，不看正文）。
 *
 * 为什么用相对值：`example.com` 的正常整页只有 932B、`api.github.com` 的业务响应 1277B，
 * 绝对阈值会把它们当成封锁页；而 x 的封锁页 737B、正常整页 45KB —— 比值 1.6%，一眼可分。
 * @param {FactObs} o 观测
 * @param {number} bigTypical 本站点典型大响应字节数（0 = 未知，只按绝对值判）
 * @returns {boolean} 是否 tiny
 */
export function isTiny(o: FactObs, bigTypical: number): boolean {
  const down = o.down || 0;
  if (down <= 0) return false; // 没拿到字节属于「失败」，不是「tiny」
  if (down > TINY_ABS) return false;
  if (!bigTypical) return true;
  return down < TINY_REL * bigTypical;
}

/**
 * 功能：事实键 —— `eg`/`dead` 只按中继键；`blk`/`ps` 按「站点 × 中继」键。
 *
 * 为什么要分：出口族与中继死活是**中继自身**的属性（与站点无关，可以跨站点复用）；
 * 封锁与成功率是**站点 × 出口**的属性，混成一个键会把「对 A 站慢」错记成「对 B 站也慢」。
 * @param {FactObs} o 观测
 * @returns {string} 事实键
 */
export function factKey(o: FactObs): string {
  const relay = String(o.relay || "");
  if (o.kind === "direct") return "d";
  if (!o.host) return relay;
  return o.host + "|" + relay;
}

/**
 * 功能：把一条观测翻译成「写什么事实」或「为什么弃权」。
 *
 * 规则顺序是硬约定（先命中先返回），因为同一份观测可能同时满足多条规则：
 * 0) 节流 → 1) 回显写 `eg` → 2) 连接层坏写 `dead` → 3) 429 只退避 →
 * 4) 4xx 且同窗口无整页 → 站点级（弃权）→ 5) tiny 且中继腿且有两批 → `blk` →
 * 6) 拿到完整响应 → `ps`（成功计数）→ 7) 零字节（弃权）。
 * @param {FactObs} o 一条观测
 * @param {FactCtx} ctx 上下文（默认空对象）
 * @returns {FactOut} 决策结果
 */
export function commitFact(o: FactObs, ctx: FactCtx = {}): FactOut {
  const now = ctx.now ?? o.at;
  const bigTypical = ctx.bigTypical ?? 0;
  const down = o.down || 0;
  const status = o.status || 0;
  const key = factKey(o);

  // 0) 节流：同一个键 60 秒内只写一次（facts 是「事实」，不是日志）
  const lw = ctx.lastWrite ? ctx.lastWrite[key] : 0;
  if (lw && now - lw < WRITE_GAP) return { reason: "R_THROTTLED" };

  // 1) 回显观测：唯一能直接写 `eg` 的证据（族判断只看回显到的 IP 字面量）
  if (o.echoFam) {
    if (down < 64) return { reason: "R_ECHO_SMALL" };
    if (o.echoFam !== 4 && o.echoFam !== 6) return { reason: "R_ECHO_FAM" };
    return { write: { kind: "eg", key, at: now, j: { fam: o.echoFam, at: now } }, reason: "ok" };
  }

  // 2) 中继自身坏了（证书/连接/TLS）→ dead，且不再往下判封锁：
  //    这类中继会把「403」变成「连接失败」，判成封锁只会让池子越来越薄。
  if (o.err === "x509" || o.err === "tls" || o.err === "reset" || o.err === "timeout") {
    if (o.kind !== "relay") return { reason: "R_DEAD_DIRECT" }; // 直连的坏是 CF 边缘的坏，不归中继
    return { write: { kind: "dead", key: String(o.relay), at: now, j: { why: o.err, at: now } }, reason: "ok" };
  }

  // 3) 429：只退避，不写任何事实（限流与封锁是两件事）
  if (status === 429) return { reason: "R_429_BACKOFF" };

  // 4) 站点级 4xx：同窗口没有任何通道拿到整页 → 是站点在拒绝所有人，分不清站点还是通道，弃权
  const peers = sameWindow(o, ctx);
  const bigPeer = peers.some((p) => (p.down || 0) >= BIG_PEER);
  if (!bigPeer && status >= 400 && status < 500) return { reason: "R_SITE_LEVEL" };

  // 5) tiny 响应 = 候选封锁证据：只有中继腿可写（直连腿出口身份不可归属）
  if (isTiny(o, bigTypical)) {
    if (o.kind !== "relay") return { reason: "R_DIRECT_NEVER" };
    if (!bigPeer) return { reason: "R_NO_BIG_PEER" };
    // 两批确认只是「B 级证据」：这里**不写任何事实**，由上层（judge）给 `ps` 记一条负样本。
    // 真正的封锁（`blk`）由 `src/route/blkfacts.ts` 的 `BLK.note` 三批投票决定，反向证据检查也在那边。
    // 这里以前还有一条「两批 → 写 blk」和一条 `R_CONTRADICTORY` 分支，纯函数里永远走不到：
    // `bigPeer` 要求 120 秒内有 ≥20KB 的对照，而那条对照同时会写 `S.bigByHost`，本函数又用
    // 3 分钟的窗口判矛盾 —— 两条规则互相排除，只有手写上下文的单测能走到它们（v7.137 删除）。
    return { reason: "R_TINY_PEER" };
  }

  // 6) 其余「拿到完整响应」→ `ps` 成功计数（tiny 的负样本由上层单独登记，见 §5.1 D14）
  if (down > 0) return { write: { kind: "ps", key, at: now, j: { ok: 1, at: now } }, reason: "ok" };

  // 7) 零字节：没有任何可用证据
  return { reason: "R_NO_BYTES" };
}

/**
 * 功能：挑出同窗口（≤120 秒）内的其他观测。
 * @param {FactObs} o 当前观测
 * @param {FactCtx} ctx 上下文
 * @returns {FactObs[]} 可互为对照的观测
 */
function sameWindow(o: FactObs, ctx: FactCtx): FactObs[] {
  const now = ctx.now ?? o.at;
  const all = ctx.peers || [];
  return all.filter((p) => p !== o && Math.abs(now - (p.at || now)) <= BIG_WIN);
}
