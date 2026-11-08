/* data */
function wsToStream(ws: WebSocketLike, earlyData: string): ReadableStream<Uint8Array> {
  // 流被取消（pipeTo 提前结束）后 WS 仍可能在推消息：
  // 继续 enqueue 会抛 "The stream is not in a state that permits enqueue"，
  // 而这个异常发生在事件回调里，没人接得住 —— 用一个闩把后续消息直接丢掉。
  let live = true;
  return new ReadableStream({
    start(controller) {
      const push = (d) => {
        if (!live) return;
        try {
          controller.enqueue(toU8(d));
        } catch (e) {
          live = false;
        }
      };
      ws.addEventListener("message", (ev) => push(ev.data));
      ws.addEventListener("close", () => {
        live = false;
        try { controller.close(); } catch (e) {}
      });
      ws.addEventListener("error", (e) => {
        live = false;
        try { controller.error(e); } catch (err) {}
      });
      if (earlyData) {
        try {
          const b64 = earlyData.replace(/-/g, "+").replace(/_/g, "/");
          const raw = atob(b64);
          const buf = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
          push(buf);
        } catch (e) {
          /* 早期数据非法，忽略 */
        }
      }
    },
    cancel() {
      live = false;
    },
  });
}

/**
 * 换一个中转节点重连（"这个节点不通就换下一个"）。
 * @param {object} env Worker 环境
 * @param {object} st 连接状态（会被更新 node/via/pxTries）
 * @param {string} mode 模式
 * @returns {Promise<Socket|null>} 新连接，没有可换或连不上返回 null
 */
async function dialAnother(env: Env, st: Connection, mode: string, tag?: string): Promise<any> {
  const alt = nextNode(mode, st.node);
  if (!alt) return null;
  const i = alt.lastIndexOf(":");
  const host = alt.slice(0, i);
  const port = Number(alt.slice(i + 1)) || 443;
  try {
    const s = await connect({ hostname: host, port });
    st.node = alt;
    st.via = "node";
    st.pxTries = (st.pxTries || 1) + 1;
    logErr(`retry another node ${alt}`, tag || "");
    return s;
  } catch (e) {
    return null;
  }
}

/**
 * WebSocket 数据面主流程：鉴权 → 解析目标 → 直连/降级 proxyip → 双向转发。
 * @param {Request} request 升级请求
 * @param {object} env Worker 环境
 * @param {ExecutionContext} ctx 执行上下文
 * @returns {Promise<Response>} 101 升级响应
 */
async function handleUpgrade(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const pair = new WebSocketPair();
  const [clientWS, serverWS] = Object.values(pair) as WebSocketLike[];
  serverWS.accept();
  // 新版兼容日期下 message 事件默认给 Blob，不是 ArrayBuffer —— 不设这一行，
  // 二进制帧会被 toU8() 当成空数组丢掉，VLESS 头解析失败后回 400，客户端看到的就是 SSLError。
  try { serverWS.binaryType = "arraybuffer"; } catch (e) {}

  const auth = await loadUsers(env);
  const cf = request.cf || {};
  let ipTag = null;
  let ipRegion = null;
  let mode = "tput";
  try {
    const q = new URL(request.url).searchParams;
    ipTag = q.get("ip");
    ipRegion = (q.get("rg") || "").toUpperCase() || null;
    mode = q.get("mode") === "lat" ? "lat" : (q.get("mode") === "tput" ? "tput" : "");
    if (!mode) mode = String(env.defaultMode || "").toLowerCase() === "lat" ? "lat" : "tput";
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
          st.onUp(chunk.length);
          if (st.up + st.down - (st.reportedUp || 0) - (st.reportedDown || 0) >= 1048576) {
            st.flush();
          }

          if (st.sock) {
            const w = st.writer;
            return w.write(chunk).catch(() => closeQuietly(st.sock));
          }

          const u8 = toU8(chunk);
          const proto = detectProtocol(u8);
          const r = proto === "trojan" ? parseTrojan(u8, auth) : parseVLESS(u8, auth);

          if (r.ok === false) {
            safeSend(serverWS, enc.encode(`HTTP/1.1 400 Bad Request\r\n\r\n`));
            cnt("noAuth");
            try { serverWS.close(1008, r.err); } catch (e) {}
            throw new Error(r.err);
          }

          st.id = r.id;
          st.host = r.host;
          statBump(r.id, 0, 0, true);
          if (ipTag) rttLearn(cf, ipTag, r.id);

          const bad = checkTarget(r.host, r.port);
          if (bad) {
            try { serverWS.close(1011, bad); } catch (e) {}
            throw new Error(bad);
          }

          // VLESS 的响应头（ver,0）对 TCP/UDP 都要带，所以放在 UDP 分支之前设置
          if (r.proto === "vless") st.header = new Uint8Array([r.ver, 0]);

          if (r.udp) {
            if (r.port !== 53) {
              try { serverWS.close(1011, "UDP 仅支持 DNS(53)"); } catch (e) {}
              throw new Error("unsupported udp");
            }
            await handleDns(serverWS, u8.subarray(r.offset), st);
            return;
          }

          const payload = u8.subarray(r.offset);
          st.retried = false;

          let sock: any = null;

          // 指定地区：直接走该国家的 proxyip（跳过直连，因为直连出口是 CF 自己的 IP）
          if (ipRegion) {
            try {
              const p = await SEL.region(env, ipRegion);
              if (p) {
                sock = await connect({ hostname: p.h, port: p.p });
                st.node = p.h + ":" + p.p;
                st.via = "node";
                st.retried = true;
              }
            } catch (e) {
              /* 该地区暂时没有可用节点 → 走默认逻辑 */
            }
          }

          try {
            // 已知直连必挂的目标（CF 托管站点）直接跳过直连：
            // 每次先等一次 0 字节关闭，短请求很容易被客户端判超时。
            // 只靠失败学习（S.needPx），不在直连前做 DNS 预判：
            // 那会让每个新域名首连多等 50–150 ms，换来的只是一次注定失败的直连。
            const needPx = (S.needPx.get(r.host) || 0) > Date.now();
            if (!sock && !needPx) sock = await dial(r.host, r.port);
            if (!sock) throw new Error("skip-direct");
          } catch (e) {
            const px0 = parseProxyIp(await SEL.current(env, mode, st));
            if (!px0) {
              cnt("dead"); kickFlush(env, st.id);                       // 直连失败且没有可用中转 → 目标不可达
              logErr(`dead target ${r.host}: ${e && e.message ? e.message : e}`);
              try { serverWS.close(1011, "连接目标失败"); } catch (err) {}
              throw e;
            }
            st.retried = true;
            st.pxTries = 1;
            try {
              sock = await connect({ hostname: px0.host, port: px0.port });
              st.node = px0.host + ":" + px0.port;
              st.via = "node";
            } catch (e2) {
              // 这个中转连不上，换一个再试一次
              const alt = await dialAnother(env, st, mode, r.host);
              if (alt) sock = alt;
              else {
                await SEL.bumpFail(env, st.mode, st.node, st.trial);
                throw e2;
              }
            }
          }

          // 把客户端首个载荷（TLS ClientHello 含目标 SNI）写给目标/中转，
          // 目标是 CF 托管站点时首个连接会被静默丢弃，此时靠 onClose 重试到 proxyip
          const attach = async (s2) => {
            st.sock = s2;
            st.writer = s2.writable.getWriter();
            st.headerSent = false;
            st.tAttach = Date.now();          // 首字节耗时从这里起算
            st.ttfb = 0;
            if (payload.length) await st.writer.write(payload).catch(() => {});

            pipeBack(s2, serverWS, st, async (gotData) => {
              // 客户端已经走了（取消下载 / 切网 / 切节点）：别再替它开新中转，
              // 否则每次取消都会白烧一次拨号 + 一次探测不到的失败记录。
              if (serverWS.readyState !== WS_OPEN) { closeQuietly(st.sock); return; }
              if (gotData) SEL.resetFail(env, st.node);   // 能通就说明链路健康，别乱切
              if (!gotData && !st.markedFail) {
                st.markedFail = true;
                rttMark(st.id, st.ipTag, false);
              }

              if (gotData) {
                try { serverWS.close(1000, "done"); } catch (e) {}
                return;
              }

              // 已经走 proxyip 了还是 0 字节关闭 → 这次中转失败，必须计数
              if (st.retried) {
                cnt("eCloseP");                       // 中转后仍空关闭：才算节点的问题
                if (st.node) { const sn = nsGet(st.node); sn.eCloseP = (sn.eCloseP || 0) + 1; }
                // 这个中转不通，换一个再试一次；直接放弃就是用户看到的"下载失败"
                if ((st.pxTries || 1) < 2) {
                  const s2 = await dialAnother(env, st, st.mode, r.host);
                  if (s2) {
                    await attach(s2);
                    return;
                  }
                }
                cnt("dead"); kickFlush(env, st.id);                       // 换节点也不通 → 这个目标走不了中转
                await SEL.bumpFail(env, st.mode, st.node, st.trial);
                try { serverWS.close(1000, "done"); } catch (e) {}
                return;
              }

              // 直连这一跳 0 字节关闭：记成"直连不通"，用来和节点做对照
              st.directFail = true;

              // ① 先试 IPv6：CF 只隔离 IPv4 到自家网段，走 IPv6 能通
              // 可选：IPv6 兜底（实测对 CF 托管站点无效，默认关闭，配了 env.cfIpv6 才启用）
              if (!st.triedV6 && env.cfIpv6 && !isV6Literal(r.host)) {
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
                cnt("dead"); kickFlush(env, st.id);
                cnt("eCloseD");                       // 直连空关闭：目标站的问题，不算节点
                if (st.node) { const sd = nsGet(st.node); sd.eCloseD = (sd.eCloseD || 0) + 1; }
                try { serverWS.close(1000, "done"); } catch (e) {}
                return;
              }
              st.retried = true;
              st.pxTries = 1;
              if (S.needPx.size >= 300) {
                const now2 = Date.now();
                for (const [h2, t2] of S.needPx) if (t2 <= now2) S.needPx.delete(h2);
                if (S.needPx.size >= 300) S.needPx.delete(S.needPx.keys().next().value);
              }
              // 记住"这个站必须走中转"。
              // 10 分钟太短：x.com 这种一次开几十条连接的站点，过期后每条新连接
              // 又要先撞一次注定失败的直连（多 0.3~1s），表现就是"能上但一直转圈"。
              // 6 小时足够覆盖一次浏览会话；真变回可直连也只是多走一跳，不会坏。
              S.needPx.set(r.host, Date.now() + 6 * 3600e3);
              logErr(`empty close -> proxyip ${px.host}`, r.host);
              try {
                const s3 = await connect({ hostname: px.host, port: px.port });
                st.node = px.host + ":" + px.port;
                st.via = "node";
                await attach(s3);
              } catch (e) {
                try { serverWS.close(1011, "proxyip failed"); } catch (err) {}
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
      })
    )
    .catch((err) => {
      cnt("wsFail");
      logErr(`ws: ${err && err.message ? err.message : err}`, ipTag || "");
      closeQuietly(st.sock);
      try { serverWS.close(1011, "internal error"); } catch (e) {}
    })
    .finally(async () => {
      st.release();
      if (!st.id) cnt("noPayload");     // 握手期就结束的连接（占大多数），以前完全不可见
      st.flush(true);
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(pendFlush(env));
        ctx.waitUntil(flushSnap(env));
      }
    });

  return new Response(null, { status: 101, webSocket: clientWS } as any);
}

/**
 * 上游 → WebSocket 的下行转发，含首包合并、RTT 标记与背压控制。
 * @param {Socket} sock 上游连接
 * @param {WebSocket} ws 客户端连接
 * @param {object} st 连接状态
 * @param {(gotData: boolean) => void} [onClose] 上游关闭时的回调（gotData 表示是否收到过数据）
 * @returns {void}
 */

function pipeBack(sock: any, ws: WebSocketLike, st: Connection, onClose?: (gotData: boolean) => void): void {
  sock.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          const u8 = toU8(chunk);
          // 热路径：加字节 → 比阈值 → 发送。其余全在 tick 里（每 512 KB）
          st.down += u8.length;
          if (!st.ttfb && st.tAttach) st.ttfb = Date.now() - st.tAttach;
          if (st.down >= st.mark) {
            if (!(await st.tick(ws))) return;
          }
          if (st.header && !st.headerSent) {
            const merged = new Uint8Array(st.header.length + u8.length);
            merged.set(st.header, 0);
            merged.set(u8, st.header.length);
            safeSend(ws, merged);
            st.headerSent = true;
          } else {
            safeSend(ws, u8);
          }
          if (!st.markedOk) {
            st.markedOk = true;
            rttMark(st.id, st.ipTag, true);
          }
        },
        close() {
          if (onClose) onClose(st.down > 0);
          else {
            try { ws.close(1000, "done"); } catch (e) {}
          }
        },
        abort() {
          closeQuietly(sock);
        },
      })
    )
    .catch((err) => {
      logErr("pipe: " + ((err && err.message) || err), st && st.node ? st.node : "");
      closeQuietly(sock);
      // 已经传过数据却异常结束 = 中途断流，算这个节点一次失败（以前只在空关闭时记账）
      if (st && st.down > 0) {
        st.failed = true;
        cnt("cut");
        if (st.node) {
          const sn = nsGet(st.node);
          sn.tF = (sn.tF || 0) + 1;
          // 中途断流的节点先凉 60 秒：客户端的重试就会落到别的节点上，
          // 否则重试大概率还选同一个，用户看到的就是"这个下载一直失败"。
          sn.freeUntil = Math.max(sn.freeUntil || 0, Date.now() + 60000);
        }
      }
      try { ws.close(1011, "pipe error"); } catch (e) {}
    });
}

/**
 * 处理 UDP/53 的 DNS 查询：转发到 DoH 再把响应回写给客户端。
 * @param {WebSocket} ws 客户端连接
 * @param {Uint8Array} firstBody 首个 DNS 报文
 * @param {object} st 连接状态
 * @returns {Promise<void>}
 */
async function handleDns(ws: WebSocketLike, firstBody: Uint8Array, st: ConnState): Promise<void> {
  const send = async (dnsMsg) => {
    const resp = await fetch("https://1.1.1.1/dns-query", {
      method: "POST",
      headers: { "content-type": "application/dns-message" },
      body: dnsMsg,
    });
    const ab = await resp.arrayBuffer();
    const u8 = new Uint8Array(ab);
    const len = new Uint8Array([(u8.length >> 8) & 0xff, u8.length & 0xff]);
    const out = new Uint8Array(2 + u8.length);
    out.set(len, 0);
    out.set(u8, 2);
    const merged = st.header
      ? (() => { const m = new Uint8Array(st.header.length + out.length); m.set(st.header, 0); m.set(out, st.header.length); return m; })()
      : out;
    safeSend(ws, merged);
    st.header = null;
  };

  // 把连续的 [len][msg] 帧拆出来逐个查询
  let buf = firstBody;
  while (buf.length >= 2) {
    const n = (buf[0] << 8) | buf[1];
    if (buf.length < 2 + n) break;
    await send(buf.slice(2, 2 + n)).catch(() => {});
    buf = buf.slice(2 + n);
  }
}

/* ==================================================================
 * §8  配置下发
 * ================================================================== */

