import { errMsg } from "../core/util";
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
import { kickFlush } from "../store/index";
import { SEL } from "../px/selector";
import { flushSnap, pendFlush, statBump } from "../store/index";
import { closeQuietly, enc, safeSend, toU8 } from "../core/util";
import { connect } from "cloudflare:sockets";

/**
 * WebSocket 数据面主流程：鉴权 → 解析目标 → 直连/降级 proxyip → 双向转发。
 * @param {Request} request 升级请求
 * @param {object} env Worker 环境
 * @param {ExecutionContext} ctx 执行上下文
 * @returns {Promise<Response>} 101 升级响应
 */
export async function handleUpgrade(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const pair = new WebSocketPair();
  const [clientWS, serverWS] = Object.values(pair) as WebSocketLike[];
  serverWS.accept();
  // 新版兼容日期下 message 事件默认给 Blob，不是 ArrayBuffer —— 不设这一行，
  // 二进制帧会被 toU8() 当成空数组丢掉，VLESS 头解析失败后回 400，客户端看到的就是 SSLError。
  try {
    serverWS.binaryType = "arraybuffer";
  } catch (e) {}

  const auth = await loadUsers(env);
  const cf = request.cf || {};
  let ipTag = null;
  let ipRegion = null;
  let mode: Mode = "tput";
  let szBytes = 0;
  let pxForce = 0; // 1 = 强制中转，-1 = 强制直连，0 = 按名单 + 失败学习
  let rxPin = ""; // ?rx= 指定的中继（诊断用，正常流量为空）
  try {
    const q = new URL(request.url).searchParams;
    ipTag = q.get("ip");
    if (ipTag) ipTag = ipTag.slice(0, 48); // 标签只用于统计，别让超长 ?ip= 把快照撑大
    ipRegion = (q.get("rg") || "").trim().toUpperCase() || null;
    const qm = q.get("mode");
    if (qm === "lat" || qm === "tput") mode = qm;
    else mode = String(env.defaultMode || "").toLowerCase() === "lat" ? "lat" : "tput";
    // 目标流量 S：交互 i=64KB / 流媒体 s=1MB / 批量 b=16MB（不传就按模式默认：160KB / 10MB）
    const qs = q.get("sz");
    szBytes = qs === "i" ? SC.SZ_I : qs === "s" ? SC.SZ_S : qs === "b" ? SC.SZ_B : 0;
    const qp = q.get("px");
    pxForce = qp === "1" ? 1 : qp === "0" ? -1 : 0;
    // ?rx=<ip[:port]>：诊断用，钉住这一条连接走哪条中继（给吞吐体检脚本用）
    const qrx = (q.get("rx") || "").trim();
    if (qrx && /^[0-9a-zA-Z.:\[\]-]{3,64}$/.test(qrx)) rxPin = qrx;
  } catch (e) {
    ipTag = null;
    ipRegion = null;
  }
  const early = request.headers.get("sec-websocket-protocol") || "";
  const stream = wsToStream(serverWS, early);

  const st = new Connection(env, ctx, mode, ipTag || "");
  st.sz = szBytes;
  st.rx = rxPin;
  cnt("conn");

  stream
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          if (st.dead) return;
          st.onUp(chunk.length);
          if (st.up + st.down - (st.reportedUp || 0) - (st.reportedDown || 0) >= 1048576) {
            st.flush();
          }

          if (st.sock) {
            const w = st.writer!;
            return w.write(chunk).catch(() => closeQuietly(st.sock));
          }

          const u8 = toU8(chunk);
          // 同一个 UDP 连接里的后续 DNS 报文：首包已经解析过，不能再当协议头。
          // 上行字节在 write() 入口已经计过，这里只转发，不要重复 onUp。
          if (st.udp) {
            await handleDns(serverWS, u8, st, st.udpTrojan);
            return;
          }
          const proto = detectProtocol(u8);
          const r = proto === "trojan" ? parseTrojan(u8, auth) : parseVLESS(u8, auth);

          if (r.ok === false) {
            safeSend(serverWS, enc.encode(`HTTP/1.1 400 Bad Request\r\n\r\n`));
            cnt("noAuth");
            try {
              serverWS.close(1008, r.err);
            } catch (e) {}
            throw new Error(r.err);
          }

          st.id = r.id;
          st.host = r.host;
          statBump(r.id, 0, 0, true);
          if (ipTag) rttLearn(cf, ipTag, r.id);

          const bad = checkTarget(r.host, r.port);
          if (bad) {
            try {
              serverWS.close(1011, bad);
            } catch (e) {}
            throw new Error(bad);
          }

          // VLESS 的响应头（ver,0）对 TCP/UDP 都要带，所以放在 UDP 分支之前设置
          if (r.proto === "vless") st.header = new Uint8Array([r.ver || 0, 0]);

          if (r.udp) {
            if (r.port !== 53) {
              try {
                serverWS.close(1011, "UDP 仅支持 DNS(53)");
              } catch (e) {}
              throw new Error("unsupported udp");
            }
            await handleDns(serverWS, u8.subarray(r.offset), st, r.proto === "trojan");
            st.udp = true;
            st.udpTrojan = r.proto === "trojan";
            return;
          }

          const payload = u8.subarray(r.offset);
          st.retried = false;

          let sock: Socket | null = null;

          if (ipRegion) {
            const failRegion = (msg: string) => {
              st.dead = true;
              st.failed = true;
              // 地区失败与「目标不可达」不是一回事：没节点 / 节点被策略禁止 / 节点连不上，
              // 三种都不说明目标站有问题。混记进 dead 会让面板上的 dead 同时代表两件事，
              // 排查「目标到底能不能连」时读不出来（v7.170 起分开计）。
              cnt("rgFail");
              kickFlush(env, st.id);
              logErr(`region ${ipRegion}: ${msg}`, r.host);
              try {
                serverWS.close(1011, msg);
              } catch (e) {}
            };
            const picked = await REGION.open({ env, mode, region: ipRegion, st, onFail: failRegion });
            if (!picked) return;
            sock = picked;
          } else {
            try {
              // 拨号策略整体在 Dialer 里：判难直连 → 选中继 → 退 IPv4 拨号 → 退直连（P5）
              sock = await DIALER.open({ env, request, st, mode, host: r.host, port: r.port, pxForce });
            } catch (e) {
              const px0 = parseProxyIp(await SEL.current(env, mode, st, r.host, st.cf));
              if (!px0) {
                cnt("dead");
                kickFlush(env, st.id); // 直连失败且没有可用中转 → 目标不可达
                logErr(`dead target ${r.host}: ${errMsg(e)}`);
                try {
                  serverWS.close(1011, "连接目标失败");
                } catch (err) {}
                throw e;
              }
              st.retried = true;
              st.pxTries = 1;
              try {
                // 纵深防御：种子池来自外部名单，进 connect 之前再验一次地址
                st.node = px0.host + ":" + px0.port;
                if (checkTarget(px0.host, px0.port)) throw new Error("proxyip 被策略禁止");
                sock = await connect({ hostname: px0.host, port: px0.port });
                st.via = "node";
              } catch (e2) {
                // 这个中转连不上，换一个再试一次
                const alt = await dialAnother(env, st, mode, r.host);
                if (alt) sock = alt;
                else {
                  // 连不上中转是节点问题，不是目标站问题：站点级试探也要把节点冻掉，
                  // 否则这条探索路径每次都白撞同一个坏节点（softFail 只记 0.2 站责）。
                  await SEL.bumpFail(env, st.mode, st.node, st.hostTrial || st.trial);
                  throw e2;
                }
              }
            }
          }

          // 把客户端首个载荷（TLS ClientHello 含目标 SNI）写给目标/中转，
          // 目标是 CF 托管站点时首个连接会被静默丢弃，此时靠 onClose 重试到 proxyip
          // 首包写入 + 双向搬运 + 0 字节关闭的补救链都在 Attacher 里（P5-4）
          //
          // 这里的守卫只是为了把类型收窄成 Socket：两条拨号路径都不返回 null
          // （REGION.open 为空时上面已经 return，DIALER.open 只会返回 socket 或抛错）。
          // 以前写的是 throw new Error("skip-direct")，读日志的人会以为「故意跳过直连」，
          // 实际只可能是「两条路都没给出 socket」——同一个错标签在 dialer 里也有一份（v7.168）。
          if (!sock) throw new Error("dial returned null");
          await ATTACHER.run(
            { env, ws: serverWS, st, mode, host: r.host, port: r.port, region: ipRegion, payload },
            sock,
          );
        },
        close() {
          st.release();
        },
        abort() {
          st.release();
        },
      }),
    )
    .catch((err) => {
      cnt("wsFail");
      logErr(`ws: ${errMsg(err)}`, ipTag || "");
      closeQuietly(st.sock);
      try {
        serverWS.close(1011, "internal error");
      } catch (e) {}
    })
    .finally(async () => {
      st.release();
      if (!st.id) cnt("noPayload"); // 握手期就结束的连接（占大多数），以前完全不可见
      st.flush(true);
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(pendFlush(env));
        ctx.waitUntil(flushSnap(env));
      }
    });
  return new Response(null, { status: 101, webSocket: clientWS } as unknown as ResponseInit);
}


