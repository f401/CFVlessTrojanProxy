import { NODE_MEMORY } from "../core/node-memory";
import type { Socket } from "cloudflare:sockets";
import { errMsg, UP_STALL_MS, closeQuietly, releaseAll, withTimeout, WS_BUFFER_LIMIT, WS_MAX_BUFFER, WS_OPEN, WS_STALL_MS } from "../core/util";
import { hostNodeMark, logErr } from "../nodes/metrics";
import { cnt } from "../core/counter";
import { NodeStatsTable } from "../nodes/score";
import { ConnSettle } from "./conn-settle";
import { sampleWeight, SAMPLE_MIN_BYTES, SITE_MIN_BYTES, stalledWindow } from "./conn-settle";

// ---- 并入自 sample-window.ts ----
/** 节点级采样窗口的最小长度：tick 可能比这更密（每次 tick 都结算会把短窗口算成低带宽） */
export const NODE_WIN_MS = 800;

/** 节点级样本的最小间隔：一次十几秒的大下载只够交 5 秒一个样本，再密就是同一段流量重复计分 */
export const NODE_EMIT_GAP_MS = 5000;

/** 站点级窗口的长度：长连接（看视频）不必等到结束才有第一个站点级样本 */
export const SITE_WIN_MS = 60000;

/** 一个可以交给评分层的节点级窗口 */
export interface NodeWindow {
  /** 窗口内下行字节 */
  bytes: number;
  /** 窗口时长（毫秒） */
  elapsedMs: number;
}

/** 一个可以交给站点画像的站点级窗口 */
export interface SiteWindow {
  /** 窗口内下行字节 */
  bytes: number;
  /** 窗口时长（毫秒） */
  elapsedMs: number;
}

/**
 * 一条连接上的两个采样窗口（节点级 5 秒 / 站点级 60 秒）。
 *
 * 为什么单独成类：窗口边界是「上一次结算的时刻与字节数」这一对状态，一共七个字段，
 * 全都只在采样路径上读写。放在 `Connection` 里时，它们与热路径的 `down`/`up` 混在一起，
 * 读代码的人分不清「哪个字段每 chunk 变、哪个每 5 秒变」。
 *
 * 三条纪律（挪动窗口时最容易踩的）：
 * 1) 窗口边界**无论能不能出样本都要推进**，否则短窗口会把下一次的 dt 越拖越长；
 * 2) 只有真的交出一个样本才推进 `lastEmit`（否则「样本太短」会被算成「刚采过」，
 *    高带宽连接反而被自己的短窗口饿死）；
 * 3) 背压占比用**本连接累计**的背压毫秒来算，不是窗口内的增量（`stallMark` 就是那条基线）。
 */
export class SampleWindow {
  /** 节点级：上一次结算的时刻（0 = 还没建立窗口起点） */
  at = 0;
  /** 节点级：上一次结算时的累计下行字节 */
  down = 0;
  /** 节点级：上一次真的交出样本的时刻（用来压「5 秒一个样本」的间隔） */
  lastEmit = 0;
  /** 节点级：上一次结算时的累计背压毫秒（算窗口内背压占比的基线） */
  stallMark = 0;
  /** 站点级：上一次结算的时刻 */
  siteAt = 0;
  /** 站点级：上一次结算时的累计下行字节 */
  siteDown = 0;
  /** 站点级：已经写出过几次样本（写过就别再用「一生平均」覆盖） */
  siteEmitted = 0;

  /**
   * 功能：建立窗口起点（第一次 tick 专用）。
   * @param {number} now 当前毫秒时间
   * @param {number} total 当前累计下行字节
   * @param {number} stallMs 当前累计背压毫秒
   * @returns {void}
   */
  begin(now: number, total: number, stallMs: number): void {
    // 第一次 tick 只记起点：否则第一段速率会把建连耗时一起算进分母
    this.at = now;
    this.down = total;
    this.stallMark = stallMs;
  }

  /**
   * 功能：推进节点级窗口，够格就交出样本。
   * @param {number} now 当前毫秒时间
   * @param {number} total 当前累计下行字节
   * @param {number} stallMs 当前累计背压毫秒
   * @returns {NodeWindow | null} 样本；窗口太短或样本太小返回 null
   */
  node(now: number, total: number, stallMs: number): NodeWindow | null {
    const dt = now - this.at;
    // 没有起点、窗口短于 800ms、或距上次出样本不足 5 秒：三种情况都直接跳过，边界不动
    if (!this.at || dt < NODE_WIN_MS || now - this.lastEmit < NODE_EMIT_GAP_MS) return null;
    const bytes = total - this.down;
    // 小样本不构成带宽证据：少于 64KB 的窗口会被建连耗时主导，交给连接是「噪声当样本」
    const out = bytes >= SAMPLE_MIN_BYTES ? { bytes, elapsedMs: dt } : null;
    // 边界无条件推进（纪律 1）：这次没出样本，下次的 dt 也必须是干净的
    this.at = now;
    this.down = total;
    this.stallMark = stallMs;
    return out;
  }

  /**
   * 功能：记下「刚才那个样本真的交出去了」，用于压住采样间隔。
   * @param {number} now 交出样本的时刻
   * @returns {void}
   */
  emitted(now: number): void {
    // 只有真的交给评分层才算采过（纪律 2）：算出来权重为 0 的样本不该占用间隔
    this.lastEmit = now;
  }

  /**
   * 功能：推进站点级窗口，够格就交出样本。
   * @param {number} now 当前毫秒时间
   * @param {number} total 当前累计下行字节
   * @returns {SiteWindow | null} 样本；没到 60 秒或样本太小时返回 null
   */
  site(now: number, total: number): SiteWindow | null {
    // 第一次进窗口只记起点：站点级要的是「这一段」而不是「这一生」
    if (!this.siteAt) {
      this.siteAt = now;
      this.siteDown = total;
      return null;
    }
    if (now - this.siteAt < SITE_WIN_MS) return null;
    const bytes = total - this.siteDown;
    const dt = now - this.siteAt;
    // 256KB 以下不报：小响应用「一生平均」算出的速率会反向排序（D5，7.83 的同一口径）
    const out = bytes >= SITE_MIN_BYTES ? { bytes, elapsedMs: dt } : null;
    if (out) this.siteEmitted++;
    this.siteAt = now;
    this.siteDown = total;
    return out;
  }

  /**
   * 功能：判断这个节点窗口里是不是有一半以上时间卡在背压（瓶颈在客户端）。
   * @param {number} dt 窗口时长（毫秒）
   * @param {number} stallMs 当前累计背压毫秒
   * @returns {boolean} 真表示「这段速率不代表节点能力」
   */
  stalled(dt: number, stallMs: number): boolean {
    // 用累计背压差值除以窗口长度：单看「这辈子卡过多久」会让老连接的每个窗口都被降权
    return stalledWindow(stallMs, this.stallMark, dt);
  }
}

// ---- 并入自 client-flow.ts ----
/** 背压检查的轮询间隔：10ms 是「感知得到客户端在读」与「不空转烧 CPU」的折中 */
export const FLOW_TICK_MS = 10;

/**
 * 客户端这一侧的流量控制：客户端收不动时暂停读上游，超时或爆缓冲则主动断开。
 *
 * 为什么单独成类：这段逻辑是**唯一**读 `ws.bufferedAmount` 的地方，也是唯一拿
 * 「客户端断连」与「节点卡死」做区分的地方 —— 两类原因必须记不同的计数器
 * （`ccut` vs `stall`），否则面板的可用性会被客户端切网/关标签页拉低（7.124 的同族缺陷）。
 * 把它埋在 `Connection` 的热路径旁边时，这两条计数的差别读不出来。
 *
 * 状态只有一项：本连接累计的背压毫秒。它同时喂给结算（`pStall`）和采样（折扣因子）。
 */
export class ClientFlow {
  /** 本连接累计的背压毫秒（只累加「真的卡住了」的时间，正常的缓冲不算） */
  stallMs = 0;

  /**
   * 功能：检查客户端缓冲区；必要时等它排空，等不到就断开这条连接。
   * @param {WebSocketLike} ws 客户端连接
   * @param {Socket | null} sock 上游 socket（判定卡死后要一起关掉）
   * @returns {Promise<boolean>} 真表示可以继续读上游，假表示这条连接应当中止
   */
  async gate(ws: WebSocketLike, sock: Socket | null): Promise<boolean> {
    const buffered = ws.bufferedAmount || 0;
    // 缓冲在阈值内：直接放行，这条热路径不该有任何等待
    if (buffered <= WS_BUFFER_LIMIT) return true;

    const t0 = Date.now();
    // 超限之后不立刻断：客户端可能只是瞬时抖动，给它 60 秒的恢复窗口
    const deadline = t0 + WS_STALL_MS;
    while ((ws.bufferedAmount || 0) > WS_BUFFER_LIMIT) {
      if (ws.readyState !== WS_OPEN) {
        // 「客户端自己走了」不是节点断流：必须记 ccut。记成 cut 会把切网/关标签算到节点头上
        cnt("ccut");
        closeQuietly(sock);
        return false;
      }
      if ((ws.bufferedAmount || 0) > WS_MAX_BUFFER || Date.now() > deadline) {
        // 缓冲涨到 WS_MAX_BUFFER（64MB）或等满 WS_STALL_MS（180s）：判定真卡死，
        // 主动断，别让一个连接拖住整个 isolate（两值都在 core/util.ts）
        cnt("stall");
        this.stallMs += Date.now() - t0;
        try {
          ws.close(1011, "stall");
        } catch (e) {
          /* 已经关了就不必再关一次 */
        }
        closeQuietly(sock);
        return false;
      }
      await new Promise((r) => setTimeout(r, FLOW_TICK_MS));
    }
    // 排空了：这段时间仍然算「背压时间」，它要进 pStall 的分母（客户端慢是真的慢）
    this.stallMs += Date.now() - t0;
    return true;
  }
}

// ---- 门面（对外导出面保持不变） ----
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
  /** 入口 IP 标签（`?ip=` 或 CF 头推断）：按入口分桶的记忆、限流键都用它 */
  ipTag: string;
  /** 当前这条连接绑定的中继节点 key（host:port）；直连为空串 */
  node = "";
  host = ""; // 目标域名（按站点的节点画像用）
  /** 节点选择模式（tput 吞吐优先 / lat 速率优先），决定打分口径与目标流量 */
  mode: Mode;
  /** 实际生效的通道（direct / relay / v6）：结算与按通道统计都按它分类 */
  via = "direct";
  udp = false; // 首包已判定为 UDP/53：后续帧直接当 DNS 报文
  udpTrojan = false; // Trojan UDP 的后续帧带 [ATYP][ADDR][PORT] 前缀
  /** 上一帧没拆完的 UDP 字节：WS 分帧不等于 UDP 分帧，拆不完的要留到下一帧接着拼 */
  udpBuf: Uint8Array | null = null;
  dead = false; // 已经明确失败并关闭：后续帧不要再解析

  // —— 热路径计数 ——
  /** 已下行字节（含 VLESS 头；热路径累加，tick 看它是否跨过 mark） */
  down = 0;
  /** 已上行字节（客户端→目标，含首帧头） */
  up = 0;
  mark = TICK_BYTES; // 下一个 tick 的字节水位

  /** 两个采样窗口（节点级 5 秒 / 站点级 60 秒）的边界状态 */
  readonly win = new SampleWindow();
  /** 客户端背压与「客户端先走」的归因 */
  readonly flow = new ClientFlow();
  /** 功能：关连接时的结算流水线（收尾采样 / 节点观测 / 首眼观测 / PEND 记账），无状态
   *  7.348 起由连接自己持有：它是唯一调用方，挂模块上时读不懂这两处凭什么叫「结算」。 */
  private readonly settle = new ConnSettle();
  /** 本连接已贡献给直方图的权重（上限 SC.CONN_W_CAP） */
  sampleW = 0;
  inflightKey = ""; // 已经计入在途的节点（变更时迁移）

  // —— 生命周期 ——
  /** 是否已给这个节点记过一次成功：一条连接只记一次，避免长连接刷分 */
  markedOk = false;
  /** 是否已记过一次失败（与 markedOk 先到者生效，防止一失败一成功互相覆盖） */
  markedFail = false;
  notified = false; // onClose 已经通知过（close 与 pipe 的 error 路径互斥，见 tunnel.ts）
  failed = false; // 中途断流/异常（由 pipeBack 的 catch 置位），不算成功
  siteFail = false; // 失败归因：连上了节点但目标侧拒绝（只轻记全局）
  hostTrial = false; // 站点级试探：失败只记账，不动全局游标/不冻结
  /** 是否已经为重试换过一次节点（限制单连接的重试次数） */
  retried = false;
  /** 本条连接已尝试的中继个数（免费计划 connect 名额有限，要有上限） */
  pxTries = 0;
  /** 是否已经试过 IPv6 兜底（同一连接不重复试） */
  triedV6 = false;
  /** 允许结算的次数（0/1）：保证 ConnSettle 只跑一次 */
  counted = 0;

  // —— 上游 ——
  /** 上游 socket（目标站或中继）：关连接时置空，避免二次 close */
  sock: Socket | null = null;
  /** 上游 socket 的写端：上行帧直接写它，不经额外缓冲 */
  writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  /** 要拼在首个下行分片前面的 VLESS 响应头（还没发出去时非空） */
  header: Uint8Array | null = null;
  /** 头是否已经随首个分片发出（发过就不再加，避免重复前缀） */
  headerSent = false;

  // —— 结算 ——
  /** 已经上报给计量 DO 的上行字节（增量口径） */
  reportedUp = 0;
  /** 已经上报给计量 DO 的下行字节（增量口径） */
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
  /** 连接建立时刻（算总寿命；结算与断流取证都用它） */
  startedAt = Date.now();
  /** 计费用的用户标识（uuid）；首帧鉴权通过前是 null */
  id: string | null = null;
  /** 调试开关（查询串 hb=1）：这条连接每 3 秒往 DO 打一次心跳，用来判断断流后 isolate 还活不活 */
  debugBeat = false;

  /** 调试烧 CPU：每 512 KB 空转 debugBurn×20 万次循环（?burn=N），只在取证时用 */
  debugBurn = 0;

  /** 上一次烧 CPU 时的下行字节数（判断是否又攒够 512 KB） */
  burnAt = 0;
  /** 运行环境绑定（KV / DO / 密钥）：构造时注入，连接期间不变 */
  env: Env;
  /** 请求的执行上下文：waitUntil 用来兜住收尾上报 */
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
    NodeStatsTable.nsSpeed(this.node, (bytes * 1000) / dt, bytes, this.env, w);
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
      NodeStatsTable.nsFail(this.node);
      logErr("up stall " + this.node, this.node);
    } else logErr("up stall direct", this.host || "");
    this.dead = true; // 后续分片不再往这条死连接上写
    closeQuietly(this.sock);
  }

  /** 把"在途连接数"对齐到当前节点（切换节点时会迁移） */
  syncInflight(): void {
    const k = this.node;
    if (k === this.inflightKey) return;
    if (this.inflightKey) NODE_MEMORY.release(this.inflightKey);
    this.inflightKey = k || "";
    NODE_MEMORY.acquire(k);
  }

  /**
   * 功能：连接结束时把该目标的 inflight 计数减一（并发场景用于观测并发度）。
   * @returns 无
   */
  clearInflight(): void {
    if (!this.inflightKey) return;
    NODE_MEMORY.release(this.inflightKey);
    this.inflightKey = "";
  }

  /**
   * 本次窗口应贡献多少直方图权重。
   * 512KB / 1s 是"一个标准样本"；短窗口或小样本按比例降权，单连接累计封顶。
   * 换算规则在 `./conn-settle.ts` 的 `sampleWeight`，这里只负责把结果记进 `sampleW`。
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
      if (this.id) this.settle.close(this);
    }
    if (!this.id) return;
    this.settle.pend(this);
  }

  /** 释放持有的 socket / 写锁 */
  release(): void {
    releaseAll(this);
  }
}
