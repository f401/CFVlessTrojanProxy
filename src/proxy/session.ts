import { closeQuietly, enc, errMsg, safeSend, toU8 } from "../core/util";
import { CallGate } from "../core/call-gate";
import type { Socket } from "cloudflare:sockets";
import { Connection } from "./connection";
import { wsToStream } from "./ws-in";
import { logErr, rttLearn } from "../nodes/metrics";
import { checkTarget } from "./dial";
import { RegionPicker } from "./region";
import { DnsLane } from "./dns";
import { Attacher } from "./attacher";
import { SessionTail } from "./conn-settle";
import { SessionRouter } from "./fallback";
import { FirstFrame, loadUsers } from "./protocol";
import { cnt } from "../core/counter";
import { SC } from "../core/const";
import { statBump } from "../store/index";

/**
 * 功能：一条 WebSocket 数据面连接的会话对象 —— 把「升级握手 / 首帧解析 / 拨号路由 / 收尾」四段各自成方法。
 *
 * 为什么是一个类而不是一个 221 行的函数：这四段的失败语义与代价完全不同 ——
 * 握手期结束（`noPayload`）只是客户端放弃；首帧解析失败要给 400 并区分鉴权/目标；拨号失败要么记
 * 「目标不可达」（`dead`）要么记「地区失败」（`rgFail`）；收尾要落 PEND 与快照。挤在一个函数里时
 * 「哪一步在花 `connect()` 名额、哪一步在写账本」只能靠通读全文。
 *
 * 生命周期：`new ProxySession(request, env, ctx)` 解析参数并建 Connection → `run()` 起管道并返回 101，
 * 之后所有动作都由 stream 的 `write`/`close`/`abort` 三个回调驱动，最终在 `finally` 里 `finish()`。
 */
export class ProxySession {
  private readonly request: Request;
  private readonly env: Env;
  private readonly ctx: ExecutionContext;
  private readonly clientWS: WebSocketLike;
  private readonly serverWS: WebSocketLike;
  private readonly conn: Connection;
  /** 本次调用的额度：建连只从它取号，用完即放弃补救（7.362 起额度随调用传递） */
  private readonly budget = new CallGate("request");
  private readonly mode: Mode;
  private readonly pxForce: number;
  private readonly rxPin: string;
  private readonly ipTag: string;
  private readonly ipRegion: string | null;
  // 地区钉住（`?rg=`）时的挑选器：只有 dialRegion 一个分支用它，所以挂在这个会话上，
  // 而不是留成模块级单例（7.346 起 —— 模块级实例在门面上看不出「谁在用」）。
  private readonly regionPicker = new RegionPicker();
  // 上游挂载器没有任何字段（补救链的状态全在 Connection 里），但「谁在挂上游」属于会话自己：
  // 7.354 前它是模块级 `ATTACHER`，读 session.ts 时看不出这个会话用什么挂载上游。
  private readonly attacher = new Attacher();
  // 收尾（释放 / noPayload / 冲账本 / 冲快照）自成一类：它是唯一「连接已不可用还要花 IO 预算」的阶段
  private readonly tail = new SessionTail();
  // 这条连接的 DNS 通道（首包进入 UDP 模式后由它接手，会话只说 feed）
  private readonly dns: DnsLane;
  // 首帧解析器：纯函数式，只回答「这帧是什么」，回 400 / 关连接 / 记账都由本会话按顺序做（7.362）
  private readonly frames = new FirstFrame();
  // 往哪走的决策（地区硬分流 / 拨号策略 / 补救一条中继）在 7.362 起是单独对象，会话只问 route(host, port)
  private readonly router: SessionRouter;
  // 用户表在 run() 里才读（ctor 只解析参数、不碰 KV）；给一份空表让类型成立，
  // 真实值一定在首帧到达之前就绪。
  private users: Auth = { uuids: new Set<string>(), trojan: new Map<string, string>(), list: [] };

  /**
   * 功能：解析本次升级的参数并建好连接对象（此时还没有任何 I/O 之外的副作用）。
   * @param {Request} request 升级请求
   * @param {Env} env Worker 环境
   * @param {ExecutionContext} ctx 执行上下文
   */
  constructor(request: Request, env: Env, ctx: ExecutionContext) {
    this.request = request;
    this.env = env;
    this.ctx = ctx;
    const pair = new WebSocketPair();
    const [clientWS, serverWS] = Object.values(pair) as WebSocketLike[];
    this.clientWS = clientWS;
    this.serverWS = serverWS;
    serverWS.accept();
    // 新版兼容日期下 message 事件默认给 Blob，不是 ArrayBuffer —— 不设这一行，
    // 二进制帧会被 toU8() 当成空数组丢掉，VLESS 头解析失败后回 400，客户端看到的就是 SSLError。
    try {
      serverWS.binaryType = "arraybuffer";
    } catch (e) {}

    const q = this.queryParams();
    this.ipTag = (q.get("ip") || "").slice(0, 48); // 标签只用于统计，别让超长 ?ip= 把快照撑大
    this.ipRegion = (q.get("rg") || "").trim().toUpperCase() || null;
    this.mode = this.readMode(q.get("mode"));
    // 目标流量 S：交互 i=64KB / 流媒体 s=1MB / 批量 b=16MB（不传就按模式默认：160KB / 10MB）
    const qs = q.get("sz");
    const szBytes = qs === "i" ? SC.SZ_I : qs === "s" ? SC.SZ_S : qs === "b" ? SC.SZ_B : 0;
    const qp = q.get("px");
    this.pxForce = qp === "1" ? 1 : qp === "0" ? -1 : 0;
    // ?rx=<ip[:port]>：诊断用，钉住这一条连接走哪条中继（给吞吐体检脚本用）
    const qrx = (q.get("rx") || "").trim();
    this.rxPin = qrx && /^[0-9a-zA-Z.:\[\]-]{3,64}$/.test(qrx) ? qrx : "";

    this.conn = new Connection(env, ctx, this.mode, this.ipTag);
    this.conn.targetBytes = szBytes;
    this.conn.forceRelayIp = this.rxPin;
    this.dns = new DnsLane(this.serverWS, this.conn);
    // 路由会话借用本会话已解好的参数与额度闸门；关连接仍由本会话执行（只有它知道客户端 socket）
    this.router = new SessionRouter({
      env,
      request,
      conn: this.conn,
      mode: this.mode,
      pxForce: this.pxForce,
      ipRegion: this.ipRegion,
      budget: this.budget,
      regionPicker: this.regionPicker,
      onHangUp: (code, reason) => this.hangUp(code, reason),
    });
  }

  /**
   * 功能：起管道并返回 101 升级响应（之后的数据面动作都由 stream 回调驱动）。
   * @returns {Promise<Response>} 101 响应
   */
  async run(): Promise<Response> {
    // 鉴权表在升级之前读：解析首帧要用它，而 loadUsers 有缓存，冷启动也只是一次 KV 读。
    this.users = await loadUsers(this.env);
    // 计数放在这里而不是构造里：构造在请求被拒时也会跑，看着像「连上了」的假信号。
    cnt("conn");
    const early = this.request.headers.get("sec-websocket-protocol") || "";
    const stream = wsToStream(this.serverWS, early);
    const st = this.conn;
    // 三个回调各自只做一件事：write 交回 feed（一帧一次），close/abort 释放 socket。
    // 错误与收尾挂在管道外面，因为 write 抛出会被 pipeTo 吞成 abort 原因。
    stream
      .pipeTo(
        new WritableStream({
          write: (chunk) => this.feed(chunk),
          close: () => st.release(),
          abort: () => st.release(),
        }),
      )
      .catch((err) => this.onFrameError(err))
      .finally(() => this.finish());
    return new Response(null, { status: 101, webSocket: this.clientWS } as unknown as ResponseInit);
  }

  /**
   * 功能：读查询参数；`new URL()` 对畸形 URL 会抛错，那种请求按「无参数」处理。
   * @returns {URLSearchParams} 参数表
   */
  private queryParams(): URLSearchParams {
    try {
      return new URL(this.request.url).searchParams;
    } catch (e) {
      return new URLSearchParams();
    }
  }

  /**
   * 功能：模式取 `?mode=`，缺省看 `env.defaultMode`，都不合法则按吞吐。
   * @param {string | null} raw 查询参数里的原始值
   * @returns {Mode} 模式
   */
  private readMode(raw: string | null): Mode {
    if (raw === "lat" || raw === "tput") return raw;
    return String(this.env.defaultMode || "").toLowerCase() === "lat" ? "lat" : "tput";
  }

  /**
   * 功能：处理一帧上行数据 —— 已连上就转发，首帧要解析协议头、拨号、再把首包交出去。
   * @param {Uint8Array | ArrayBuffer | string} chunk 帧内容
   * @returns {Promise<void>} 处理完成
   */
  private async feed(chunk: Uint8Array | ArrayBuffer | string): Promise<void> {
    const st = this.conn;
    if (st.dead) return;
    st.onUp(toU8(chunk).length);
    if (st.up + st.down - (st.reportedUp || 0) - (st.reportedDown || 0) >= 1048576) {
      st.flush();
    }
    // 已经拨通：后续帧只有转发，没有解析。上游写是数据面上唯一没有上限的操作（黑洞中继接了连接
    // 却不读时 write() 永不返回），上限与归因都收在 upWrite 里。
    if (st.sock) return st.upWrite(chunk instanceof Uint8Array ? chunk : toU8(chunk));

    const u8 = toU8(chunk);
    // 同一个 UDP 连接里的后续 DNS 报文：首包已经解析过，不能再当协议头。
    // 上行字节在入口已经计过，这里只转发，不要重复 onUp。
    if (st.udp) {
      await this.dns.feed(u8);
      return;
    }
    const r = await this.parseHead(u8);
    if (!r) return;
    if (r.udp) {
      // 首包带 UDP 头：先让通道记下偏移与协议，再按偏移剥掉转发（后续报文直接走 feed(u8)）
      this.dns.start(r.offset, r.proto === "trojan");
      await this.dns.feed(u8, true);
      return;
    }
    // 首包写入 + 双向搬运 + 0 字节关闭的补救链都在 Attacher 里（P5-4）：
    // 目标是 CF 托管站点时首个连接会被静默丢弃，靠 onClose 重试到 proxyip。
    const sock = await this.dial(r.host, r.port);
    if (!sock) return;
    await this.attacher.run(
      {
        env: this.env,
        clientSocket: this.serverWS,
        conn: st,
        mode: this.mode,
        host: r.host,
        port: r.port,
        region: this.ipRegion,
        payload: u8.subarray(r.offset),
        budget: this.budget,
      },
      sock,
    );
  }

  /**
   * 功能：解析首帧的协议头（VLESS / Trojan），失败时按原因回 400 或 1011。
   * @param {Uint8Array} u8 首帧内容
   * @returns {Promise<{ id: string; host: string; port: number; proto: string; ver?: number; udp: boolean; udpTrojan?: boolean; offset: number } | null>} 解析结果；连接已被关闭时返回 null
   */
  private async parseHead(u8: Uint8Array): Promise<{
    id: string;
    host: string;
    port: number;
    proto: string;
    ver?: number;
    udp: boolean;
    offset: number;
  } | null> {
    const st = this.conn;
    // 解析本身是纯的；下面按「协议错 → 记账 → 目标黑名单 → 响应头 → UDP 白名单」的固定顺序施加副作用，
    // 顺序错会让面板上的 noAuth / dead / 头部语义互相冒充（v7.187 那种错就是这样漏进去的）
    const r = this.frames.read(u8, this.users);
    if (r.ok === false) {
      // 协议头都解析不出来：给客户端 400 再按 1008 关，计 noAuth（与鉴权失败分开看）
      safeSend(this.serverWS, enc.encode(`HTTP/1.1 400 Bad Request\r\n\r\n`));
      cnt("noAuth");
      this.hangUp(1008, r.err);
      throw new Error(r.err);
    }
    st.id = r.id;
    st.host = r.host;
    statBump(r.id, 0, 0, true);
    if (this.ipTag) rttLearn(this.request.cf || {}, this.ipTag, r.id);
    // 目标黑名单要在记账之后判：被策略禁止的目标同样是一次真实连接尝试（面板能看到是谁在打 25 端口）
    const bad = checkTarget(r.host, r.port);
    if (bad) {
      this.hangUp(1011, bad);
      throw new Error(bad);
    }
    // VLESS 的响应头（ver,0）对 TCP/UDP 都要带，所以放在 UDP 分支之前设置
    if (r.proto === "vless") st.header = new Uint8Array([r.ver || 0, 0]);
    if (r.udp && r.port !== 53) {
      this.hangUp(1011, "UDP 仅支持 DNS(53)");
      throw new Error("unsupported udp");
    }
    st.retried = false;
    return { id: r.id, host: r.host, port: r.port, proto: r.proto, ver: r.ver, udp: !!r.udp, offset: r.offset };
  }

  /**
   * 功能：给这一跳选一条出路 —— 地区硬分流 / 拨号策略 / 补救一条中继都在 `SessionRouter` 里。
   * @param {string} host 目标主机
   * @param {number} port 目标端口
   * @returns {Promise<Socket | null>} socket；地区路径失败时返回 null（连接已被关）
   */
  private async dial(host: string, port: number): Promise<Socket | null> {
    return this.router.route(host, port);
  }

  /**
   * 功能：管道里抛错时的归因 —— 记日志、关 socket、给客户端一个 1011。
   * @param {unknown} err 错误
   * @returns {void}
   */
  private onFrameError(err: unknown): void {
    cnt("wsFail");
    logErr(`ws: ${errMsg(err)}`, this.ipTag);
    closeQuietly(this.conn.sock);
    this.hangUp(1011, "internal error");
  }

  /**
   * 功能：收尾 —— 释放 socket、记「握手期就结束」、冲一次账本与快照。
   * @returns {void}
   */
  private finish(): void {
    this.tail.done(this.conn, this.env, this.ctx);
  }

  /**
   * 功能：给客户端一个关闭码（关闭本身失败无所谓，连接可能已经断了）。
   * @param {number} code 关闭码
   * @param {string} reason 原因（会出现在 `/logs` 里）
   * @returns {void}
   */
  private hangUp(code: number, reason: string): void {
    try {
      this.serverWS.close(code, reason);
    } catch (e) {}
  }
}

/**
 * WebSocket 数据面主流程：鉴权 → 解析目标 → 直连/降级 proxyip → 双向转发。
 * @param {Request} request 升级请求
 * @param {object} env Worker 环境
 * @param {ExecutionContext} ctx 执行上下文
 * @returns {Promise<Response>} 101 升级响应
 */
export async function handleUpgrade(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return new ProxySession(request, env, ctx).run();
}
