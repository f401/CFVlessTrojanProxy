import { errMsg } from "../core/util";
import type { Socket } from "cloudflare:sockets";

import { Connection } from "./connection";
import { wsToStream } from "./ws-in";
import { dialAnother } from "./fallback";
import { pipeBack } from "./tunnel";
import { logErr, rttLearn, rttMark } from "../nodes/metrics";
import { checkTarget, dial, expandV6, isV6Literal, parseProxyIp } from "./dial";
import { detectProtocol, loadUsers, parseTrojan, parseVLESS } from "./protocol";
import { cnt } from "../core/counter";
import { kickFlush } from "../store/index";
import { nsEmptyClose, nsFail } from "../nodes/score";
import { SEL } from "../px/selector";
import { S } from "../core/state";
import { flushSnap, pendFlush, statBump } from "../store/index";
import { WS_OPEN, closeQuietly, enc, safeSend, timeoutSignal, toU8 } from "../core/util";
import { connect } from "cloudflare:sockets";

/**
 * 换一个中转节点重连（"这个节点不通就换下一个"）。
 * @param {object} env Worker 环境
 * @param {object} st 连接状态（会被更新 node/via/pxTries）
 * @param {string} mode 模式
 * @returns {Promise<Socket|null>} 新连接，没有可换或连不上返回 null
 */

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
  try {
    const q = new URL(request.url).searchParams;
    ipTag = q.get("ip");
    if (ipTag) ipTag = ipTag.slice(0, 48); // 标签只用于统计，别让超长 ?ip= 把快照撑大
    ipRegion = (q.get("rg") || "").trim().toUpperCase() || null;
    const qm = q.get("mode");
    if (qm === "lat" || qm === "tput") mode = qm;
    else mode = String(env.defaultMode || "").toLowerCase() === "lat" ? "lat" : "tput";
  } catch (e) {
    ipTag = null;
    ipRegion = null;
  }
  const early = request.headers.get("sec-websocket-protocol") || "";
  const stream = wsToStream(serverWS, early);

  const st = new Connection(env, ctx, mode, ipTag || "");
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
            // 地区是硬要求：只允许该国家的节点。找不到 / 连不上就明确失败，
            // 绝不回落到直连（CF 出口）或全球节点，否则用户拿到的不是该国 IP。
            const failRegion = (msg: string) => {
              st.dead = true;
              st.failed = true;
              cnt("dead");
              kickFlush(env, st.id);
              logErr(`region ${ipRegion}: ${msg}`, r.host);
              try {
                serverWS.close(1011, msg);
              } catch (e) {}
            };
            const p = await SEL.region(env, ipRegion, mode);
            if (!p) {
              failRegion(`地区 ${ipRegion} 暂无可用节点`);
              return;
            }
            st.node = p.h + ":" + p.p;
            if (checkTarget(p.h, p.p)) {
              failRegion(`地区 ${ipRegion} 节点地址被策略禁止`);
              return;
            }
            try {
              sock = await connect({ hostname: p.h, port: p.p });
              st.via = "node";
              st.retried = true;
            } catch (e) {
              // 同国家再试一个，仍然失败就结束（不跨地区）
              nsFail(st.node); // 冷却坏节点，否则下一条连接还会撞同一个
              const alt = await SEL.region(env, ipRegion, mode, st.node);
              if (alt && !checkTarget(alt.h, alt.p)) {
                st.node = alt.h + ":" + alt.p;
                try {
                  sock = await connect({ hostname: alt.h, port: alt.p });
                  st.via = "node";
                  st.retried = true;
                } catch (e2) {}
              }
              if (!sock) {
                nsFail(st.node);
                failRegion(`地区 ${ipRegion} 节点连接失败`);
                return;
              }
            }
          } else {
            try {
              // 已知直连必挂的目标（CF 托管站点）直接跳过直连：
              // 每次先等一次 0 字节关闭，短请求很容易被客户端判超时。
              // 只靠失败学习（S.needPx），不在直连前做 DNS 预判：
              // 那会让每个新域名首连多等 50–150 ms，换来的只是一次注定失败的直连。
              const needPx = (S.needPx.get(r.host) || 0) > Date.now();
              if (!needPx) sock = await dial(r.host, r.port);
              if (!sock) throw new Error("skip-direct");
            } catch (e) {
              const px0 = parseProxyIp(await SEL.current(env, mode, st));
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
          const attach = async (s2: Socket) => {
            st.syncInflight();
            st.sock = s2;
            st.writer = s2.writable.getWriter();
            st.headerSent = false;
            st.tAttach = Date.now(); // 首字节耗时从这里起算
            st.ttfb = 0;
            if (payload.length) await st.writer!.write(payload).catch(() => {});

            pipeBack(s2, serverWS, st, async (gotData) => {
              // 客户端已经走了（取消下载 / 切网 / 切节点）：别再替它开新中转，
              // 否则每次取消都会白烧一次拨号 + 一次探测不到的失败记录。
              if (serverWS.readyState !== WS_OPEN) {
                closeQuietly(st.sock);
                return;
              }
              if (gotData) SEL.resetFail(env, st.node); // 能通就说明链路健康，别乱切
              if (!gotData && !st.markedFail) {
                st.markedFail = true;
                rttMark(st.id, st.ipTag, false);
              }

              if (gotData) {
                try {
                  serverWS.close(1000, "done");
                } catch (e) {}
                return;
              }

              // 已经走 proxyip 了还是 0 字节关闭 → 这次中转失败，必须计数
              if (st.retried) {
                cnt("eCloseP"); // 中转后仍空关闭：才算节点的问题
                nsEmptyClose(st.node, true);
                // 这个中转不通，换一个再试一次；直接放弃就是用户看到的"下载失败"
                if ((st.pxTries || 1) < 2) {
                  const s2 = await dialAnother(env, st, st.mode, r.host, ipRegion || undefined);
                  if (s2) {
                    await attach(s2);
                    return;
                  }
                }
                cnt("dead");
                kickFlush(env, st.id); // 换节点也不通 → 这个目标走不了中转
                // 站点侧失败：连上了中转，但目标 0 字节关闭 —— 不当作节点故障
                st.failed = true;
                st.siteFail = true;
                if (st.hostTrial) await SEL.softFail(st.node);
                else await SEL.bumpFail(env, st.mode, st.node, st.trial, "site");
                try {
                  serverWS.close(1000, "done");
                } catch (e) {}
                return;
              }

              // 直连这一跳 0 字节关闭：记成"直连不通"，用来和节点做对照
              st.directFail = true;

              // ① 先试 IPv6：CF 只隔离 IPv4 到自家网段，走 IPv6 能通
              // 可选：IPv6 兜底（实测对 CF 托管站点无效，默认关闭，配了 env.cfIpv6 才启用）
              if (!ipRegion && !st.triedV6 && env.cfIpv6 && !isV6Literal(r.host)) {
                st.triedV6 = true;
                for (const raw of String(env.cfIpv6).split(",")) {
                  const v6 = raw.trim();
                  if (!v6) continue;
                  try {
                    logErr(`empty close -> retry via IPv6 ${v6}`, r.host);
                    const s6 = await connect({ hostname: expandV6(v6), port: r.port });
                    st.via = "v6";
                    await attach(s6);
                    return;
                  } catch (e) {
                    /* 试下一个 */
                  }
                }
              }

              // ② 再试 proxyip（第三方中转，最后兜底）
              const px = parseProxyIp(await SEL.current(env, mode, st));
              if (!px || st.retried) {
                cnt("dead");
                kickFlush(env, st.id);
                cnt("eCloseD"); // 直连空关闭：目标站的问题，不算节点
                nsEmptyClose(st.node, false);
                try {
                  serverWS.close(1000, "done");
                } catch (e) {}
                return;
              }
              st.retried = true;
              st.pxTries = 1;
              if (S.needPx.size >= 300) {
                const now2 = Date.now();
                for (const [h2, t2] of S.needPx) if (t2 <= now2) S.needPx.delete(h2);
                if (S.needPx.size >= 300) S.needPx.delete(S.needPx.keys().next().value as string);
              }
              // 记住"这个站必须走中转"。
              // 10 分钟太短：x.com 这种一次开几十条连接的站点，过期后每条新连接
              // 又要先撞一次注定失败的直连（多 0.3~1s），表现就是"能上但一直转圈"。
              // 6 小时足够覆盖一次浏览会话；真变回可直连也只是多走一跳，不会坏。
              S.needPx.set(r.host, Date.now() + 6 * 3600e3);
              logErr(`empty close -> proxyip ${px.host}`, r.host);
              if (checkTarget(px.host, px.port)) {
                try {
                  serverWS.close(1011, "proxyip blocked");
                } catch (e) {}
                return;
              }
              try {
                const s3 = await connect({ hostname: px.host, port: px.port });
                st.node = px.host + ":" + px.port;
                st.via = "node";
                await attach(s3);
              } catch (e) {
                try {
                  serverWS.close(1011, "proxyip failed");
                } catch (err) {}
              }
            });
          };

          await attach(sock);
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

/**
 * 上游 → WebSocket 的下行转发，含首包合并、RTT 标记与背压控制。
 * @param {Socket} sock 上游连接
 * @param {WebSocket} ws 客户端连接
 * @param {object} st 连接状态
 * @param {(gotData: boolean) => void} [onClose] 上游关闭时的回调（gotData 表示是否收到过数据）
 * @returns {void}
 */

/**
 * 拆一个 Trojan UDP 包：[ATYP][ADDR][PORT][LEN][PAYLOAD]。
 * 返回 head（原样回显的地址前缀）、msg、rest；不完整/非法返回 null。
 */
function trojanUdpFrame(buf: Uint8Array): { head: Uint8Array; msg: Uint8Array; rest: Uint8Array } | null {
  if (buf.length < 1) return null;
  const atyp = buf[0];
  let alen = 0;
  if (atyp === 1) alen = 4;
  else if (atyp === 4) alen = 16;
  else if (atyp === 3) {
    if (buf.length < 2) return null;
    alen = 1 + buf[1];
  } else return null;
  const hlen = 1 + alen + 2;
  if (buf.length < hlen + 2) return null;
  const n = (buf[hlen] << 8) | buf[hlen + 1];
  if (n < 12 || n > 4096) return null;
  if (buf.length < hlen + 2 + n) return null;
  return {
    head: buf.slice(0, hlen),
    msg: buf.slice(hlen + 2, hlen + 2 + n),
    rest: buf.slice(hlen + 2 + n),
  };
}

/**
 * 处理 UDP/53 的 DNS 查询：转发到 DoH 再把响应回写给客户端。
 * @param {WebSocket} ws 客户端连接
 * @param {Uint8Array} firstBody 首个 DNS 报文
 * @param {object} st 连接状态
 * @param {boolean} trojan Trojan UDP 与会话首包之后的分帧：
 *   每包是 [ATYP][ADDR][PORT][LEN][PAYLOAD]，响应要把地址前缀原样带回；
 *   VLESS 则是 [LEN][PAYLOAD]，响应头（ver,0）只在第一包前出现一次。
 * @returns {Promise<void>}
 */
export async function handleDns(
  ws: WebSocketLike,
  firstBody: Uint8Array,
  st: Connection,
  trojan = false,
): Promise<void> {
  const send = async (dnsMsg: Uint8Array, head?: Uint8Array) => {
    const resp = await fetch("https://1.1.1.1/dns-query", {
      signal: timeoutSignal(5000),
      method: "POST",
      headers: { "content-type": "application/dns-message" },
      body: dnsMsg,
    });
    const ab = await resp.arrayBuffer();
    const u8 = new Uint8Array(ab);
    // DNS 响应也要计入下行：否则 UDP/53 的流量完全不计费/不进面板
    st.down += u8.length;
    const len = new Uint8Array([(u8.length >> 8) & 0xff, u8.length & 0xff]);
    const pre = head && head.length ? head : null;
    const out = new Uint8Array((pre ? pre.length : 0) + 2 + u8.length);
    let off = 0;
    if (pre) {
      out.set(pre, 0);
      off = pre.length;
    }
    out.set(len, off);
    out.set(u8, off + 2);
    const merged = st.header
      ? (() => {
          const m = new Uint8Array(st.header.length + out.length);
          m.set(st.header, 0);
          m.set(out, st.header.length);
          return m;
        })()
      : out;
    safeSend(ws, merged);
    st.header = null;
  };

  let buf = firstBody;
  let queries = 0;
  if (trojan) {
    // Trojan UDP：每个包都带地址前缀；响应的前缀必须原样带回
    while (buf.length >= 7 && queries < 32) {
      const f = trojanUdpFrame(buf);
      if (!f) {
        try {
          ws.close(1003, "bad udp frame");
        } catch (e) {}
        return;
      }
      await send(f.msg, f.head).catch(() => {});
      queries++;
      buf = f.rest;
    }
    return;
  }

  // VLESS UDP：[len][msg]；恶意客户端声明超长帧会让缓冲无限堆积
  while (buf.length >= 2 && queries < 32) {
    const n = (buf[0] << 8) | buf[1];
    if (n < 12 || n > 4096) {
      try {
        ws.close(1003, "bad dns frame");
      } catch (e) {}
      return;
    }
    if (buf.length < 2 + n) break;
    await send(buf.slice(2, 2 + n)).catch(() => {});
    queries++;
    buf = buf.slice(2 + n);
  }
}

/* ==================================================================
 * §8  配置下发
 * ================================================================== */
