import type { Socket } from "cloudflare:sockets";
import { errMsg } from "../core/util";
import { hostNodeMark, logErr } from "../nodes/metrics";
import { cnt } from "../core/counter";
import { STATS } from "../nodes/score";
import { S } from "../core/state";
import { UP_STALL_MS, closeQuietly, releaseAll, withTimeout } from "../core/util";
import { SETTLE } from "./conn-settle";
import { ClientFlow } from "./client-flow";
import { SampleWindow } from "./sample-window";
import { sampleWeight } from "./conn-sample";


/** 每收到多少字节触发一次 tick */
export const TICK_BYTES = 512 * 1024;

/**
 * 一条 WebSocket 连接的全部状态与行为。
 *
 * 设计要点（CPU 优先）：
 *   热路径（每个 chunk）只做：加字节 → 比阈值 → 发送
 *   其余全部搬到 tick（每 512 KB 一次）：
 *     · 吞吐采样（用两次 tick 的字节/时间算 bps）
 *     · 结算给 PEND
 *     · 背压检查（唯一读 ws.bufferedAmount 的地方）
 *
 * 改造前每个 64KB chunk 要读 3 次 bufferedAmount、取 1 次时钟；
 * 4MB/s 下就是每秒 192 次跨边界调用。现在降到每秒 8 次。
 *
 * 这个类现在只管「连接持有状态 + 热路径」：
 * · 关连接时的结算流水线在 `./conn-settle.ts`（要碰六张表）；
 * · 采样窗口的边界与间隔在 `./sample-window.ts`（每 5 秒 / 60 秒各一套）；
 * · 客户端背压与「谁先走了」的归因在 `./client-flow.ts`（唯一读 bufferedAmount 的地方）。
 */

export class Connection {
  // —— 归属 ——
  ipTag: string;
  node = "";
  host = ""; // 目标域名（按站点的节点画像用）
  mode: Mode;
  via = "direct";
  udp = false; // 首包已判定为 UDP/53：后续帧直接当 DNS 报文
  udpTrojan = false; // Trojan UDP 的后续帧带 [ATYP][ADDR][PORT] 前缀
  /** 上一帧没拆完的 UDP 字节：WS 分帧不等于 UDP 分帧，拆不完的要留到下一帧接着拼 */
  udpBuf: Uint8Array | null = null;
  dead = false; // 已经明确失败并关闭：后续帧不要再解析

  // —— 热路径计数 ——
  down = 0;
  up = 0;
  mark = TICK_BYTES; // 下一个 tick 的字节水位

  /** 两个采样窗口（节点级 5 秒 / 站点级 60 秒）的边界状态 */
  readonly win = new SampleWindow();
  /** 客户端背压与「客户端先走」的归因 */
  readonly flow = new ClientFlow();
  /** 本连接已贡献给直方图的权重（上限 SC.CONN_W_CAP） */
  sampleW = 0;
  inflightKey = ""; // 已经计入在途的节点（变更时迁移）

  // —— 生命周期 ——
  markedOk = false;
  markedFail = false;
  notified = false; // onClose 已经通知过（close 与 pipe 的 error 路径互斥，见 tunnel.ts）
  failed = false; // 中途断流/异常（由 pipeBack 的 catch 置位），不算成功
  siteFail = false; // 失败归因：连上了节点但目标侧拒绝（只轻记全局）
  hostTrial = false; // 站点级试探：失败只记账，不动全局游标/不冻结
  retried = false;
  pxTries = 0;
  triedV6 = false;
  counted = 0;

  // —— 上游 ——
  sock: Socket | null = null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  header: Uint8Array | null = null;
  headerSent = false;

  // —— 结算 ——
  reportedUp = 0;
  reportedDown = 0;

  // —— 观测 ——
  tAttach = 0; // 连上上游的时刻
  ttfb = 0; // 首字节耗时（ms），按站点的画像就靠它
  targetBytes = 0; // 目标流量（字节，0 = 按模式默认）：决定「传完一个请求」要算多少流量
  /** 目标站点是否托管在 CF 上（决定中继只能用非 CF 出口） */
  cf = false;
  /** 调试用：`?rx=<ip>` 强制这一条连接走指定中继（只给诊断脚本用，正常流量留空） */
  forceRelayIp = "";
  directFail = false; // 直连阶段 0 字节关闭过（用于"直连对照"）

  // —— 身份与上下文 ——
  startedAt = Date.now();
  id: string | null = null;
  env: Env;
  ctx: ExecutionContext;

  constructor(env: Env, ctx: ExecutionContext, mode: Mode, ipTag: string) {
    this.env = env;
    this.ctx = ctx;
    this.mode = mode;
    this.ipTag = ipTag || "";
  }

  /**
   * 功能：本连接累计的背压毫秒（结算要算 pStall 的分子）。
   * @returns {number} 毫秒
   */
  get stallMs(): number {
    return this.flow.stallMs;
  }

  /**
   * 功能：上一次采样时的累计背压毫秒（结算用它算窗口内占比）。
   * @returns {number} 毫秒
   */
  get stallMark(): number {
    return this.win.stallMark;
  }

  /**
   * 功能：节点级窗口的起点时刻（0 表示还没建立起点）。
   * @returns {number} 毫秒时间戳
   */
  get sampleAt(): number {
    return this.win.at;
  }

  /**
   * 功能：起点时刻的累计下行字节（结算按它算窗口字节）。
   * @returns {number} 字节
   */
  get sampleDown(): number {
    return this.win.down;
  }

  /**
   * 功能：上一次真的交出节点级样本的时刻（0 表示还没交过）。
   * @returns {number} 毫秒时间戳
   */
  get lastEmit(): number {
    return this.win.lastEmit;
  }

  /** 已经写出过几次站点级样本；写过就不再让「一生平均」覆盖它 */
  get siteEmitted(): number {
    return this.win.siteEmitted;
  }

  set siteEmitted(n: number) {
    this.win.siteEmitted = n;
  }

  /** 上行字节（不做采样，只要计数） */
  onUp(n: number): void {
    this.up += n;
  }

  /**
   * 每 512 KB 触发一次。返回 false 表示连接应当中止。
   * @param ws 客户端连接
   */
  async tick(ws: WebSocketLike): Promise<boolean> {
    this.mark = this.down + TICK_BYTES;

    try {
      const now = Date.now();
      // 两级采样：节点级（决定分数）与站点级（决定「这个站点走哪个节点快」）
      this.sampleNode(now);
      this.sampleSite(now);
      // 第一次 tick 只建立窗口起点，不产生样本（否则第一段速率会把建连耗时算进去）
      if (!this.win.at) this.win.begin(now, this.down, this.stallMs);

      // 先把这段时间的字节结算给 PEND，再看客户端收不收得动
      this.flush(false);
      return await this.flow.gate(ws, this.sock);
    } catch (e) {
      logErr("tick: " + errMsg(e), this.node || "");
      return true; // 统计出错绝不影响数据面
    }
  }

  /**
   * 功能：节点级吞吐采样（一个窗口最多每 5 秒产生一条样本）。
   * @param {number} now 当前毫秒时间
   * @returns {void}
   */
  private sampleNode(now: number): void {
    // 直连连接没有节点可记：窗口照常推进（由 SampleWindow 负责），只是不出样本
    const win = this.win.node(now, this.down, this.stallMs);
    if (!win || !this.node) return;
    // 窗口里一半以上时间在背压 = 瓶颈在客户端，这个样本按 0.3 折价（不代表节点能力）
    const w = this.takeWeight(win.bytes, win.elapsedMs, this.win.stalled(win.elapsedMs, this.stallMs) ? 0.3 : 1);
    // 权重 0 说明这条连接的贡献额度用完了：不记 lastEmit，否则后面更长的窗口会被一起饿掉
    if (!w) return;
    this.win.emitted(now);
    this.emitSpeed(win.bytes, win.elapsedMs, w);
  }

  /**
   * 功能：站点级吞吐采样（长连接每 60 秒补一个窗口，别等连接结束）。
   * @param {number} now 当前毫秒时间
   * @returns {void}
   */
  private sampleSite(now: number): void {
    // 直连连接没有「站点 × 节点」可言：站点窗口只在走节点时才有意义
    if (!this.node || !this.host) return;
    const win = this.win.site(now, this.down);
    if (win) this.emitSite(win.bytes, win.elapsedMs);
  }

  /**
   * 功能：把节点吞吐样本交给评分层。
   * @param {number} bytes 窗口内下行字节
   * @param {number} dt 窗口时长（毫秒）
   * @param {number} w 本次贡献的直方图权重
   * @returns {void}
   */
  private emitSpeed(bytes: number, dt: number, w: number): void {
    // 权重必须先过 `takeWeight` 的封顶逻辑，否则慢节点的 e10 会被短窗口刷偏
    STATS.nsSpeed(this.node, (bytes * 1000) / dt, bytes, this.env, w);
    cnt("tput");
  }

  /**
   * 功能：把站点级吞吐交给站点画像。
   * @param {number} bytes 窗口内下行字节
   * @param {number} dt 窗口时长（毫秒）
   * @returns {void}
   */
  private emitSite(bytes: number, dt: number): void {
    hostNodeMark(this.host, this.node, { bps: Math.round((bytes * 1000) / dt), bytes });
  }

  /**
   * 功能：客户端收不动时暂停读上游；超时或爆缓冲则主动断（实现在 `ClientFlow`）。
   * @param {WebSocketLike} ws 客户端连接
   * @returns {Promise<boolean>} 假表示这条连接应当中止
   */
  async backpressure(ws: WebSocketLike): Promise<boolean> {
    return this.flow.gate(ws, this.sock);
  }

  /**
   * 功能：把客户端分片写给上游（中继或源站），并给这一次写加时间上限。
   * @param {Uint8Array} chunk 客户端上行的分片
   * @param {number} ms 本次写的上限毫秒（默认 `UP_STALL_MS`，单测用小值）
   * @returns {Promise<void>} 写完（或写失败被吞掉）后 resolve；永不 reject
   */
  async upWrite(chunk: Uint8Array, ms = UP_STALL_MS): Promise<void> {
    const w = this.writer;
    if (!w) return;
    // 先把迟到的那一半接住：超时判完之后它可能才失败，未捕获的 rejection 会打到 1101
    const p = w.write(chunk);
    void p.catch(() => {
      /* 已经按写失败处理过了 */
    });
    try {
      await withTimeout(p, ms, "up stall");
    } catch (e) {
      if (errMsg(e) === "up stall") this.onUpStall();
      else closeQuietly(this.sock); // 普通写失败：与改造前一致，只关 socket
    }
  }

  /**
   * 功能：判定上游是黑洞出口（接了连接却从不读）时的收尾：计数、归因到节点、断开连接。
   * @returns {无}
   */
  private onUpStall(): void {
    // 这是节点问题不是站点问题：只有「走中继」时才有节点可罚，直连目标黑洞不该记到池子头上
    cnt("ustall");
    if (this.via === "node" && this.node) {
      STATS.nsFail(this.node);
      logErr("up stall " + this.node, this.node);
    } else logErr("up stall direct", this.host || "");
    this.dead = true; // 后续分片不再往这条死连接上写
    closeQuietly(this.sock);
  }

  /** 把"在途连接数"对齐到当前节点（切换节点时会迁移） */
  syncInflight(): void {
    const k = this.node;
    if (k === this.inflightKey) return;
    if (this.inflightKey) dropInflight(this.inflightKey);
    this.inflightKey = k || "";
    if (k) S.inflight.set(k, (S.inflight.get(k) || 0) + 1);
  }

  /**
   * 功能：连接结束时把该目标的 inflight 计数减一（并发场景用于观测并发度）。
   * @returns 无
   */
  clearInflight(): void {
    if (!this.inflightKey) return;
    dropInflight(this.inflightKey);
    this.inflightKey = "";
  }

  /**
   * 本次窗口应贡献多少直方图权重。
   * 512KB / 1s 是"一个标准样本"；短窗口或小样本按比例降权，单连接累计封顶。
   * 换算规则在 `./conn-sample.ts` 的 `sampleWeight`，这里只负责把结果记进 `sampleW`。
   */
  takeWeight(bytes: number, dt: number, factor = 1): number {
    const use = sampleWeight(this.sampleW, bytes, dt, factor);
    this.sampleW += use;
    return use;
  }

  /**
   * 功能：把「尚未上报」的字节推给 PEND，并在关连接时触发一次结算。
   * @param {boolean} closing 是否是关连接的最后一次 flush（补收尾样本）
   * @returns {void}
   */
  flush(closing?: boolean): void {
    if (closing) {
      this.clearInflight();
      // 收尾逻辑必须在"零字节"提前返回之前：鉴权成功但一个字节都没传的连接
      // （探测、被客户端立刻取消）也要计入 node/direct 与种子刷新，否则计数和信誉表会漏掉这一整类连接。
      if (this.id) SETTLE.close(this);
    }
    if (!this.id) return;
    SETTLE.pend(this);
  }

  /** 释放持有的 socket / 写锁 */
  release(): void {
    releaseAll(this);
  }
}

/**
 * 功能：把某个节点的在途计数减一（到 0 就删键，避免表里堆满零值）。
 * @param {string} key 节点键
 * @returns {void}
 */
function dropInflight(key: string): void {
  const n = (S.inflight.get(key) || 1) - 1;
  if (n > 0) S.inflight.set(key, n);
  else S.inflight.delete(key);
}
