import type { Socket } from "cloudflare:sockets";
import { connect } from "cloudflare:sockets";
import type { Connection } from "./connection";
import { S } from "../core/state";
import { cnt } from "../core/counter";
import { closeQuietly, WS_OPEN } from "../core/util";
import { logErr, rttMark } from "../nodes/metrics";
import { nsEmptyClose } from "../nodes/stat";
import { SEL } from "../px/selector";
import { kickFlush } from "../store/pend";
import { checkTarget, expandV6, isV6Literal, parseProxyIp } from "./dial";
import { dialAnother } from "./fallback";
import { pipeBack } from "./tunnel";

export interface AttachOpts {
  env: Env;
  ws: WebSocketLike;
  st: Connection;
  mode: Mode;
  host: string;
  port: number;
  /** ?rg=xx 地区（硬约束）；为空表示普通分流 */
  region: string | null;
  /** 客户端首个载荷（TLS ClientHello 含 SNI）：每接一条新上游都要重发 */
  payload: Uint8Array;
}

/**
 * 上游挂载器（P5-4）：把「首包写入 + 双向搬运 + 0 字节关闭的补救链」收成一个对象。
 * 补救链顺序：中转再试一个 → IPv6 兜底（可选）→ proxyip → 放弃。
 */
export class Attacher {
  /**
   * 把已建立的 `sock` 挂到客户端 WS 上；0 字节关闭时按补救链继续，直到成功或放弃。
   */
  async run(o: AttachOpts, sock: Socket): Promise<void> {
    const { env, ws, st, host, port, payload, region } = o;
    st.syncInflight();
    st.sock = sock;
    st.writer = sock.writable.getWriter();
    st.headerSent = false;
    st.tAttach = Date.now(); // 首字节耗时从这里起算
    st.ttfb = 0;
    if (payload.length) await st.writer!.write(payload).catch(() => {});

    pipeBack(sock, ws, st, async (gotData) => {
      // 客户端已经走了（取消下载 / 切网 / 切节点）：别再替它开新中转
      if (ws.readyState !== WS_OPEN) {
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
          ws.close(1000, "done");
        } catch (e) {}
        return;
      }

      // 已经走中转还是 0 字节关闭 → 这次中转失败，必须计数
      if (st.retried) {
        cnt("eCloseP");
        nsEmptyClose(st.node, true);
        if ((st.pxTries || 1) < 2) {
          const s2 = await dialAnother(env, st, o.mode, host, region || undefined);
          if (s2) {
            await this.run(o, s2);
            return;
          }
        }
        cnt("dead");
        kickFlush(env, st.id); // 换节点也不通 → 这个目标走不了中转
        st.failed = true;
        st.siteFail = true;
        if (st.hostTrial) await SEL.softFail(st.node);
        else await SEL.bumpFail(env, o.mode, st.node, st.trial, "site");
        try {
          ws.close(1000, "done");
        } catch (e) {}
        return;
      }

      // 直连这一跳 0 字节关闭：记成"直连不通"，用来和节点做对照
      st.directFail = true;

      // ① 可选 IPv6 兜底（实测对 CF 托管站点无效，默认关闭，配了 env.cfIpv6 才启用）
      if (!region && !st.triedV6 && env.cfIpv6 && !isV6Literal(host)) {
        st.triedV6 = true;
        for (const raw of String(env.cfIpv6).split(",")) {
          const v6 = raw.trim();
          if (!v6) continue;
          try {
            logErr(`empty close -> retry via IPv6 ${v6}`, host);
            const s6 = await connect({ hostname: expandV6(v6), port });
            st.via = "v6";
            await this.run(o, s6);
            return;
          } catch (e) {
            /* 试下一个 */
          }
        }
      }

      // ② proxyip（第三方中转，最后兜底）
      const px = parseProxyIp(await SEL.current(env, o.mode, st, host, st.cf));
      if (!px || st.retried) {
        cnt("dead");
        kickFlush(env, st.id);
        cnt("eCloseD"); // 直连空关闭：目标站的问题，不算节点
        nsEmptyClose(st.node, false);
        try {
          ws.close(1000, "done");
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
      // 记住"这个站必须走中转"：6 小时覆盖一次浏览会话，真变回可直连也只是多走一跳
      S.needPx.set(host, Date.now() + 6 * 3600e3);
      logErr(`empty close -> proxyip ${px.host}`, host);
      if (checkTarget(px.host, px.port)) {
        try {
          ws.close(1011, "proxyip blocked");
        } catch (e) {}
        return;
      }
      try {
        const s3 = await connect({ hostname: px.host, port: px.port });
        st.node = px.host + ":" + px.port;
        st.via = "node";
        await this.run(o, s3);
      } catch (e) {
        try {
          ws.close(1011, "proxyip failed");
        } catch (err) {}
      }
    });
  }
}

/** 进程内唯一实例 */
export const ATTACHER = new Attacher();
