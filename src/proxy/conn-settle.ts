import { SC } from "../core/const";
import { flushSnap, PEND } from "../store/index";
import { HOOK } from "../core/hook";
import { hostDirectMark, hostNodeMark } from "../nodes/metrics";
import { cnt } from "../core/counter";
import { FO, LAT } from "../core/obs";
import { NodeStatsTable } from "../nodes/score";
import { markSeedDirty } from "../px/seed";
import { S } from "../core/state";
import { PEND_FLUSH_BYTES, scheduleFlush, statBump } from "../store/index";
import { relayIpOf } from "../core/relay-addr";

// ---- 并入自 src\proxy\conn-sample.ts ----
/** 低于这个下行字节数的窗口不构成「吞吐样本」（512KB / 1s 算一个标准样本） */
export const SAMPLE_STD_BYTES = 512 * 1024;

/** 吞吐样本的最小字节数：低于 64KB 的窗口噪声太大，宁可不报 */
export const SAMPLE_MIN_BYTES = 65536;

/** 站点级吞吐只认 256KB 以上的窗口（小响应算出的"速度"会反向排序） */
export const SITE_MIN_BYTES = 262144;

/** 「传了一大段」的门槛：1MB 以上才算过了慢启动，否则吞吐记 0 只保留首字节 */
export const TRANSFER_ENOUGH = 1048576;

/**
 * 功能：判断一个采样窗口里是否有一半以上的时间在背压。
 *
 * 背压窗口代表瓶颈在「客户端 → 边缘」这一跳，而不是节点能力，所以样本要打折。
 * 打折系数由调用方决定（`Connection` 用 0.3），这里只回答「是不是」。
 *
 * @param {number} stallMs 连接累计的背压毫秒
 * @param {number} stallMark 上一次采样时的累计值（窗口起点）
 * @param {number} dt 窗口时长（毫秒）
 * @returns {boolean} 是则 true
 */
export function stalledWindow(stallMs: number, stallMark: number, dt: number): boolean {
  return stallMs - stallMark > dt * 0.5;
}

/**
 * 功能：把「下行字节 + 传输耗时」换算成 KB/s，小样本记 0。
 *
 * 45KB 的正常首页在 2.5 秒里只有 18KB/s，而 4 字节的 403 页在 80 毫秒里有 46KB/s ——
 * 小样本算出来的速率会反向排序（文档 D5 / 吞吐诊断 §9.1），所以只有传够
 * `TRANSFER_ENOUGH` 才算真实吞吐，其余交给代价函数按「首字节 + 固定罚」处理。
 *
 * @param {number} down 下行字节
 * @param {number} xferMs 净传输时长（毫秒，已扣掉首字节）
 * @returns {number} KB/s；样本不足时为 0
 */
export function kbsOf(down: number, xferMs: number): number {
  if (down < TRANSFER_ENOUGH) return 0;
  return (down / 1024) * 1000 / Math.max(1, xferMs);
}

/**
 * 功能：算本窗口该给直方图贡献多少权重。
 *
 * 512KB / 1s 是「一个标准样本」；短窗口或小样本按比例降权，单连接累计封顶。
 * 折扣因子必须在封顶之前生效：否则一条「客户端是瓶颈」的连接会按满权重吃掉
 * `CONN_W_CAP`，报出去的却只有 0.3 倍 —— 它一共只贡献了 cap 的 30%，随后再也报不出样本。
 *
 * @param {number} used 本连接已贡献的权重（`sampleW`）
 * @param {number} bytes 窗口内下行字节
 * @param {number} dt 窗口时长（毫秒）
 * @param {number} factor 折扣因子（背压窗口 0.3，正常 1）
 * @returns {number} 本窗口可用权重；额度用完时为 0
 */
export function sampleWeight(used: number, bytes: number, dt: number, factor = 1): number {
  const room = SC.CONN_W_CAP - used;
  if (room <= 0) return 0;
  const raw = Math.min(1, bytes / SAMPLE_STD_BYTES) * Math.min(1, dt / 1000);
  const clamped = Math.max(0, Math.min(1, factor));
  return Math.min(room, raw * clamped);
}

// ---- 门面（对外导出面保持不变） ----
/**
 * 结算阶段读到的连接字段（只读视图）。
 *
 * 这里刻意用结构化接口而不是 `Connection` 类型：结算模块只该看到「它需要的那几个数」，
 * 而 `Connection` 的四十个字段里绝大多数（`sock`/`writer`/`header`/`udpBuf` …）与结算无关。
 * 反过来，`takeWeight` 留在 `Connection` 上——它写 `sampleW`，状态仍归连接所有。
 */
export interface SettleView {
  /** 会话 id；为空说明这条连接没走到计量（鉴权失败前就结束了） */
  id: string | null;
  env: Env;
  node: string;
  host: string;
  via: string;
  cf: boolean;
  up: number;
  down: number;
  reportedUp: number;
  reportedDown: number;
  ttfb: number;
  tAttach: number;
  startedAt: number;
  stallMs: number;
  sampleAt: number;
  sampleDown: number;
  stallMark: number;
  lastEmit: number;
  siteEmitted: number;
  counted: number;
  failed: boolean;
  directFail: boolean;
  /** 本窗口应贡献多少直方图权重（实现在 `Connection`，因为它要写 `sampleW`） */
  takeWeight(bytes: number, dt: number, factor?: number): number;
}

/** 一条连接结束时最多聚合多少条「节点 → 观测」记录（超过就淘汰样本数最少的那条） */
export const CAGG_MAX = 400;

/** 每条连接给直方图的权重上限（`SC.CONN_W_CAP` 的别名，结算只读它） */
export const CONN_W_CAP = SC.CONN_W_CAP;

/**
 * 一条连接结束时的结算流水线。
 *
 * 结算和热路径是两种完全不同的东西：热路径每个 chunk 都要跑（只加字节、比阈值），
 * 结算一条连接只跑一次，却要碰六张表（节点分数、站点画像、错误环、种子脏标记、
 * 连接聚合、PEND 账本）。把它们混在 `Connection` 里时，读代码的人分不清
 * 「哪个字段只在这里被读」，也看不出「这一处失败会不会影响面板」。
 *
 * 类里不留状态：全部输入来自 `SettleView`，所有状态写在 `S` 上，所以这个类
 * 可以随连接反复构造（`SETTLE` 只是省一次分配的单例）。
 */
export class ConnSettle {
  /**
   * 功能：把一条已经结束的连接结算进六张表（关连接时调用一次）。
   * @param v 连接的只读视图
   * @returns {void}
   */
  close(v: SettleView): void {
    // 收尾采样、pStall、连接聚合、首眼观测都必须先于 pend 记账，否则「零字节连接」会被 early return 漏掉
    this.closeSample(v);
    this.stallShare(v);
    this.aggregate(v);
    this.firstLook(v);
  }

  /**
   * 功能：把「还没上报」的字节推进 PEND 账本（每次 tick 与关连接时都会调）。
   * @param v 连接的只读视图
   * @returns {void}
   */
  pend(v: SettleView): void {
    const du = v.up - v.reportedUp;
    const dd = v.down - v.reportedDown;
    if (du <= 0 && dd <= 0) return;

    // 漏斗按「归一到三档」的 via 记：`v6` 是直连的 IPv6 变体，不能算成中继
    const via = v.via === "node" || v.via === "v6" ? v.via : "direct";
    S.funnel[via] = (S.funnel[via] || 0) + du + dd;
    statBump(v.id || "", du, dd, false);
    v.reportedUp = v.up;
    v.reportedDown = v.down;
    // 攒够阈值就立刻刷（0 表示「马上」），否则交给调度器按节流窗口处理
    scheduleFlush(v.env, S.pendBytes >= PEND_FLUSH_BYTES ? 0 : undefined);
  }

  /**
   * 功能：关连接前补一个吞吐样本。
   * @param v 连接的只读视图
   * @returns {void}
   */
  private closeSample(v: SettleView): void {
    const now = Date.now();
    const dt = now - v.sampleAt;
    const bytes = v.down - v.sampleDown;
    // 快速节点（10MB 在 300ms 内传完，>33MB/s）以前永远进不了直方图：
    // dt>=300ms 的闸门把它们全挡了，e10 只能停在 51 秒先验上。
    // 字节够多（≥1MB）时不再要求 300ms —— 1MB 已经过了慢启动。
    if (
      v.node &&
      v.sampleAt &&
      dt >= 50 &&
      (dt >= 300 || bytes >= 1048576) &&
      bytes >= 32768 &&
      now - v.lastEmit >= 5000
    ) {
      const w = v.takeWeight(bytes, dt, stalledWindow(v.stallMs, v.stallMark, dt) ? 0.3 : 1);
      if (w > 0) {
        NodeStatsTable.nsSpeed(v.node, (bytes * 1000) / dt, bytes, v.env, w);
        cnt("tput");
      }
    }
  }

  /**
   * 功能：把这条连接的卡顿时长并进节点的 pStall 统计。
   * @param v 连接的只读视图
   * @returns {void}
   */
  private stallShare(v: SettleView): void {
    if (!v.node) return;
    // 分母必须是"所有连接的总时长"：pStall = (stallMs + 50) / (runMs + 1000)。
    // 原来只在"这条连接卡过"时才累加 runMs，等于把分母缩成"卡过的那几条连接的时长"：
    // 一条 5 秒连接卡 2 秒 → pStall 0.34（真实占比 0.001），单次卡顿白送 800+ ms 分，
    // 还会踩中 pStall>0.25 的 +400 重罚档，节点一晚上翻不了身。
    NodeStatsTable.nsStall(v.node, v.stallMs, Math.max(1000, Date.now() - v.startedAt));
  }

  /**
   * 功能：把这条连接并进「节点 → 连接观测」聚合表（`S.cagg`）。
   * @param v 连接的只读视图
   * @returns {void}
   */
  private aggregate(v: SettleView): void {
    if (!v.node && !v.host) return;
    // 连接观测按节点聚合（n/ok/p50/p95）：40 条原始记录只能盖住 40 个节点，
    // 聚合后同样载重能覆盖全池（2000 个节点也就 400 条聚合记录）。
    const ck = v.node || "direct";
    let g = S.cagg.get(ck);
    if (!g) {
      g = { n: 0, ok: 0, dn: 0, v: [] };
      if (S.cagg.size >= CAGG_MAX) {
        // 表满时淘汰样本数最少的那条：它信息量最低，而按插入序删会优先删掉最早记录的热节点
        let worst = "";
        let wn = Infinity;
        for (const [k2, g2] of S.cagg) {
          if (g2.n < wn) {
            wn = g2.n;
            worst = k2;
          }
        }
        if (worst) S.cagg.delete(worst);
      }
      S.cagg.set(ck, g);
    }
    g.n += 1;
    if (!v.failed) g.ok += 1;
    g.dn += v.down;
    const ms = Math.round(v.ttfb);
    if (ms > 0) {
      g.v.push(ms);
      if (g.v.length > 64) g.v.shift();
    }
  }

  /**
   * 功能：每条连接只结算一次的「第一眼」观测（全局计数、首屏、延迟、节点成功、站点画像）。
   * @param v 连接的只读视图
   * @returns {void}
   */
  private firstLook(v: SettleView): void {
    if (v.counted) return;
    v.counted = 1;
    cnt(v.node ? "node" : "direct");
    // 前 3 条用户连接的质量：低流量客户端几乎每条请求都落冷 isolate，这是唯一能看到的「第一眼」
    FO.note(v.down);
    // 延迟观测：成功口径是「拿到内容」，不是 2xx（业务 4xx 也是内容）
    LAT.note(v.down > 64, Date.now() - v.startedAt);
    // 真实流量的"成功"样本：可用性(pFail/availOf)、面板成功率全靠它。
    // 早先只有失败才记账（nsFail），成功只走 SEL.resetFail()，而那里
    // 第一行就是 `if (!S.pxFailSeen) return` —— 健康节点永远 n=0，
    // 面板显示"一个连接都没有"，可用性门槛也永远不触发。
    if (v.node && !v.failed && v.down > 0) NodeStatsTable.nsOk(v.node, 0, 0);
    this.relayRates(v);
    this.channelEvidence(v);
    this.siteProfile(v);
    markSeedDirty(v.env);
  }

  /**
   * 功能：把「站点 × 中继」的首字节、吞吐容量与下行字节交给决策层。
   * @param v 连接的只读视图
   * @returns {void}
   */
  private relayRates(v: SettleView): void {
    if (!v.node || !v.host || v.down <= 0) return;
    const ms = Math.max(1, Date.now() - v.tAttach);
    const ip = relayIpOf(v.node);
    const t0 = v.ttfb > 0 ? v.ttfb : ms;
    // 吞吐只在「真的传了一大段」时才有意义：45KB 的正常首页在 2.5 秒里只有 18KB/s，
    // 而 4 字节的 403 页在 80 毫秒里也有 46KB/s —— 小样本算出来的速率会反向排序。
    // 1MB 以上才算「过了慢启动」；其余样本 kbs 记 0（只保留首字节），由代价函数特殊处理。
    HOOK.relPerf?.(v.host, ip, t0, kbsOf(v.down, ms - t0));
    // 只有真正拉到 ≥40KB 才算一次可用的吞吐样本：4 字节 403 页算出的"速度"是假的（文档 D5）
    if (v.down >= 40960) HOOK.capNote?.(ip, Math.round((v.down / 1024) * 1000 / Math.max(1, Date.now() - v.startedAt)));
    // 「站点 × 中继」成功率（v8 §5 的 ps）不在这里写：判定层要的是「同一窗口里有 2xx 对照」，
    // 只有 src/route/judge.ts 的判定出口知道这件事，它自己调 PS.note。
    // 这里只交出三样原料：首字节（relPerf）、容量（capNote）、完整响应字节数（traffic）。
  }

  /**
   * 功能：把这条连接的响应形态作为通道证据交给决策层。
   * @param v 连接的只读视图
   * @returns {void}
   */
  private channelEvidence(v: SettleView): void {
    if (!v.host || !HOOK.traffic) return;
    // 弱证据只可能把 unknown 提成 ok；判死只有 probe 能下
    HOOK.traffic({
      cf: v.cf,
      host: v.host,
      via: v.via as "node" | "direct" | "v6",
      node: v.node || "",
      down: v.down,
      ok: !v.failed && v.down > 0,
      life: Date.now() - v.startedAt,
      up: v.up,
      at: Date.now(),
    });
  }

  /**
   * 功能：更新「站点 → 节点/直连」画像，并回流真实首字节。
   * @param v 连接的只读视图
   * @returns {void}
   */
  private siteProfile(v: SettleView): void {
    // 真实首字节回流：探活只能证明连得上，转发快不快只有这条路径知道
    if (v.node && v.ttfb > 0) NodeStatsTable.nsLatency(v.node, v.ttfb);
    if (!v.host) return;
    if (!v.node) {
      hostDirectMark(v.host, !v.failed && v.down > 0);
      return;
    }
    const life = v.tAttach ? Math.max(1, Date.now() - v.tAttach) : 0;
    // 站点级 bps 只在「没写过、活得够久、传够 512KB」时补一次，否则用「一生平均」会低估近期速度
    const siteBps = !v.siteEmitted && life > 500 && v.down >= 512 * 1024 ? Math.round((v.down * 1000) / life) : 0;
    hostNodeMark(v.host, v.node, {
      ok: !v.failed && v.down > 0 ? 1 : 0,
      bad: v.failed ? 1 : 0,
      bytes: v.down,
      ttfb: v.ttfb,
      bps: siteBps,
    });
    if (v.directFail) hostDirectMark(v.host, false);
  }
}


/** 收尾只需要连接的这三样能力（结构化取参：结算层不 import Connection，避免与连接互相依赖） */
export interface TailConn {
  /** 连接 id（null / 空串表示握手期就结束，没有解析出目标） */
  readonly id: string | null;
  /** 释放上游 socket 与计数名额 */
  release(): void;
  /** 冲一次本地账本（force 为真时忽略节流） */
  flush(force: boolean): void;
}
/**
 * 功能：一条连接收尾时要做的四件事 —— 释放 socket、记「握手期就结束」、冲账本、冲快照。
 *
 * 为什么单独成类：收尾是唯一「连接已经不可用之后还要花 IO 预算」的阶段（`PEND.flush` 是一次 DO 往返、
 * `flushSnap` 可能是一次 KV 写），原先它和握手、拨号挤在 session.ts 里，看不出「谁在关连接之后还在花额度」。
 */
export class SessionTail {
  /**
   * 功能：按顺序收尾（先释放 socket，再记账本，最后冲快照）。
   * @param {TailConn} conn 本次连接（只用到释放 / id / flush 三样，结构化作参）
   * @param {Env} env Worker 环境
   * @param {ExecutionContext | null} ctx 执行上下文（没有 waitUntil 时同步跑完）
   * @returns {void}
   */
  done(conn: TailConn, env: Env, ctx: ExecutionContext | null): void {
    // 先释放 socket：后面两步都是异步 IO，占着连接只会让延迟关掉的名额继续被占用
    conn.release();
    // 握手期就结束的连接（占大多数）以前完全不可见，这里补一个计数
    if (!conn.id) cnt("noPayload");
    conn.flush(true);
    if (!ctx || !ctx.waitUntil) {
      // 本地/单测没有 waitUntil：直接返回，别把 Promise 挂成未处理的 rejection
      return;
    }
    ctx.waitUntil(PEND.flush(env));
    ctx.waitUntil(flushSnap(env));
  }
}
