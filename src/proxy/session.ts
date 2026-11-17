import { CONNECT_MS, closeQuietly, enc, errMsg, safeSend, toU8, withTimeout } from "../core/util";
import { connect } from "cloudflare:sockets";
import type { Socket } from "cloudflare:sockets";
import { Connection } from "./connection";
import { wsToStream } from "./ws-in";
import { logErr, rttLearn } from "../nodes/metrics";
import { checkTarget, parseProxyIp } from "./dial";
import { DIALER } from "./dialer";
import { REGION } from "./region";
import { handleDns } from "./dns";
import { ATTACHER } from "./attacher";
import { dialAnother } from "./fallback";
import { detectProtocol, loadUsers, parseTrojan, parseVLESS } from "./protocol";
import { cnt } from "../core/counter";
import { SC } from "../core/const";
import { flushSnap, kickFlush, PEND, statBump } from "../store/index";
import { SEL } from "../px/selector";

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
  private readonly mode: Mode;
  private readonly pxForce: number;
  private readonly rxPin: string;
  private readonly ipTag: string;
  private readonly ipRegion: string | null;
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
      await handleDns(this.serverWS, u8, st, st.udpTrojan);
      return;
    }
    const r = await this.parseHead(u8);
    if (!r) return;
    if (r.udp) {
      await handleDns(this.serverWS, u8.subarray(r.offset), st, r.proto === "trojan");
      st.udp = true;
      st.udpTrojan = r.proto === "trojan";
      return;
    }
    // 首包写入 + 双向搬运 + 0 字节关闭的补救链都在 Attacher 里（P5-4）：
    // 目标是 CF 托管站点时首个连接会被静默丢弃，靠 onClose 重试到 proxyip。
    const sock = await this.dial(r.host, r.port);
    if (!sock) return;
    await ATTACHER.run(
      {
        env: this.env,
        clientSocket: this.serverWS,
        conn: st,
        mode: this.mode,
        host: r.host,
        port: r.port,
        region: this.ipRegion,
        payload: u8.subarray(r.offset),
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
    const proto = detectProtocol(u8);
    const r = proto === "trojan" ? parseTrojan(u8, this.users) : parseVLESS(u8, this.users);
    if (r.ok === false) {
      safeSend(this.serverWS, enc.encode(`HTTP/1.1 400 Bad Request\r\n\r\n`));
      cnt("noAuth");
      this.hangUp(1008, r.err);
      throw new Error(r.err);
    }
    st.id = r.id;
    st.host = r.host;
    statBump(r.id, 0, 0, true);
    if (this.ipTag) rttLearn(this.request.cf || {}, this.ipTag, r.id);
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
   * 功能：拨号 —— 有 `?rg=` 走地区硬分流，否则走拨号策略并在失败时补救一条中继。
   * @param {string} host 目标主机
   * @param {number} port 目标端口
   * @returns {Promise<Socket | null>} socket；地区路径失败时返回 null（连接已关）
   */
  private async dial(host: string, port: number): Promise<Socket | null> {
    // 以前这里末尾有一道 `if (!sock) throw new Error("dial returned null")` 守卫，是为了把类型收窄成
    // Socket —— 结论现在仍然成立（两条拨号路径都不返回 null：DIALER.open 只返回 socket 或抛错），
    // 但守卫已经不需要了：返回 null 只可能来自地区分流那一支，而它失败时自己关过连接，调用方直接
    // return 即可。历史标签「skip-direct」的教训保留在 dialer.ts 那边（v7.168）。
    if (this.ipRegion) return this.dialRegion(host);
    const st = this.conn;
    try {
      // 拨号策略整体在 Dialer 里：判难直连 → 选中继 → 退 IPv4 拨号 → 退直连（P5）
      return await DIALER.open({
        env: this.env,
        request: this.request,
        conn: st,
        mode: this.mode,
        host,
        port,
        pxForce: this.pxForce,
      });
    } catch (e) {
      return this.dialFallback(host, e);
    }
  }

  /**
   * 功能：地区硬分流 —— 找不到 / 连不上就明确失败，绝不回落（`?rg=` 的语义）。
   * @param {string} host 目标主机（地区分流只按主机与地区挑节点，端口留给 Attacher）
   * @returns {Promise<Socket | null>} socket；失败返回 null
   */
  private async dialRegion(host: string): Promise<Socket | null> {
    const st = this.conn;
    const failRegion = (msg: string) => {
      st.dead = true;
      st.failed = true;
      // 地区失败与「目标不可达」不是一回事：没节点 / 节点被策略禁止 / 节点连不上，三种都不说明
      // 目标站有问题。混记进 dead 会让面板上的 dead 同时代表两件事（v7.170 起分开计）。
      cnt("rgFail");
      kickFlush(this.env, st.id);
      logErr(`region ${this.ipRegion}: ${msg}`, host);
      this.hangUp(1011, msg);
    };
    const picked = await REGION.open({ env: this.env, mode: this.mode, region: this.ipRegion || "", conn: st, onFail: failRegion });
    return picked || null;
  }

  /**
   * 功能：直连/中继都失败时的补救 —— 取一条中继直连，连不上就再换一条。
   * @param {string} host 目标主机
   * @param {unknown} err 原始错误（一条中继都没有时要把它抛出去）
   * @returns {Promise<Socket | null>} socket
   */
  private async dialFallback(host: string, err: unknown): Promise<Socket | null> {
    const st = this.conn;
    const px0 = parseProxyIp(await SEL.current(this.env, this.mode, st, host, st.cf));
    if (!px0) {
      cnt("dead");
      kickFlush(this.env, st.id); // 直连失败且没有可用中转 → 目标不可达
      logErr(`dead target ${host}: ${errMsg(err)}`);
      this.hangUp(1011, "连接目标失败");
      throw err;
    }
    st.retried = true;
    st.pxTries = 1;
    try {
      // 纵深防御：种子池来自外部名单，进 connect 之前再验一次地址
      st.node = px0.host + ":" + px0.port;
      if (checkTarget(px0.host, px0.port)) throw new Error("proxyip 被策略禁止");
      // 与 Dialer / Attacher / Region 的补救链同一口径：connect() 自己没有超时，挂死会让客户端
      // 一直等；超时之后迟到成功的 socket 也必须关掉，否则白占免费计划的 6 个并发 connect 名额。
      const pk0 = Promise.resolve(connect({ hostname: px0.host, port: px0.port }));
      try {
        const sock = await withTimeout(pk0, CONNECT_MS);
        st.via = "node";
        return sock;
      } catch (e3) {
        void pk0
          .then((s) => { try { s.close(); } catch { /* 已经被关掉了 */ } })
          .catch(() => { /* 本来就没连上 */ });
        throw e3;
      }
    } catch (e2) {
      // 这个中转连不上，换一个再试一次
      const alt = await dialAnother(this.env, st, this.mode, host);
      if (alt) return alt;
      // 连不上中转是节点问题，不是目标站问题：站点级试探也要把节点冻掉，否则这条探索路径
      // 每次都白撞同一个坏节点（softFail 只记 0.2 站责）。
      await SEL.bumpFail(this.env, st.mode, st.node, st.hostTrial);
      throw e2;
    }
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
    this.conn.release();
    if (!this.conn.id) cnt("noPayload"); // 握手期就结束的连接（占大多数），以前完全不可见
    this.conn.flush(true);
    if (this.ctx && this.ctx.waitUntil) {
      this.ctx.waitUntil(PEND.flush(this.env));
      this.ctx.waitUntil(flushSnap(this.env));
    }
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
