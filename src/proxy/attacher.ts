import type { Socket } from "cloudflare:sockets";
import { connect } from "cloudflare:sockets";
import type { Connection } from "./connection";
import { S } from "../core/state";
import { SC } from "../core/const";
import { trimAged } from "../core/hostmem";
import { cnt } from "../core/counter";
import { CONNECT_MS, closeQuietly, releaseAll, withTimeout, WS_OPEN } from "../core/util";
import { logErr, rttMark } from "../nodes/metrics";
import { nsEmptyClose, nsFail } from "../nodes/stat";
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
    // 递归重试时上一跳的 socket 与写锁必须显式释放：下面两行会把字段覆盖掉，
    // 不关就等于每重试一次漏一个 socket（免费计划的并发 connect 名额全局只有 6 个）。
    if (st.sock && st.sock !== sock) releaseAll(st);
    st.syncInflight();
    st.sock = sock;
    st.writer = sock.writable.getWriter();
    st.headerSent = false;
    st.tAttach = Date.now(); // 首字节耗时从这里起算
    st.ttfb = 0;
// 首包写也要有上限：黑洞中继接了连接却不读，write 永不返回，而客户端已经等在首字节上
    if (payload.length) await st.upWrite(payload);

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
        // 地区钉住的连接失败不等价于「目标不可达」：这里可能只是该地区没别的候选了。
        // 混记进 dead 会让面板上的 dead 同时代表两件事（v7.170 在 session.ts 里分开计，
        // v7.171 把补救链这一处也一起分开）。
        cnt(region ? "rgFail" : "dead");
        kickFlush(env, st.id); // 换节点也不通 → 这个目标走不了中转
        st.failed = true;
        st.siteFail = true;
        // 站点级试探与普通站点失败在这里是同一件事：只轻记节点（nsSiteFail），
        // 不动全局失败记忆、也不冻结。原来那个 if/else 的两条分支调的其实是同一个函数。
        await SEL.softFail(st.node);
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
          // 与主路径同一个口径：connect() 自己没有超时，挂死会把客户端拖到放弃
          const p6 = Promise.resolve(connect({ hostname: expandV6(v6), port }));
          try {
            logErr(`empty close -> retry via IPv6 ${v6}`, host);
            const s6 = await withTimeout(p6, CONNECT_MS);
            st.via = "v6";
            await this.run(o, s6);
            return;
          } catch (e) {
            // 超时迟到成功的 socket 也要关掉，否则白占并发名额
            void p6.then((s) => { try { s.close(); } catch { /* 已经被关掉了 */ } }).catch(() => { /* 没连上 */ });
          }
        }
      }

      // ② proxyip（第三方中转，最后兜底）
      const px = parseProxyIp(await SEL.current(env, o.mode, st, host, st.cf));
      // 这里只判「没有候选」：st.retried 为真时上面第 ④ 支已经 return，
      // 以前写成 `!px || st.retried` 的那半截条件永远不生效（7.169 删掉）。
      if (!px) {
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
      // 记住"这个站必须走中转"：6 小时覆盖一次浏览会话，真变回可直连也只是多走一跳。
      // 窗口读 SC.PX_LEARN —— 7.226 之前这里内联 6 * 3600e3，judge 里另有一份 21_600_000。
      // 上限用 SC.PX_MAX：以前这里手写一段「先清过期、再删最旧一条」，而 judge 写
      // 同一张表的两条路径完全绕过了它（7.182 统一成 trimAged，按最早过期先删）。
      S.needPx.set(host, Date.now() + SC.PX_LEARN);
      trimAged(S.needPx, SC.PX_MAX);
      logErr(`empty close -> proxyip ${px.host}`, host);
      if (checkTarget(px.host, px.port)) {
        try {
          ws.close(1011, "proxyip blocked");
        } catch (e) {}
        return;
      }
      // 与主路径同一个口径：connect() 自己没有超时，挂死会把客户端拖到放弃
      const p3 = Promise.resolve(connect({ hostname: px.host, port: px.port }));
      try {
        const s3 = await withTimeout(p3, CONNECT_MS);
        st.node = px.host + ":" + px.port;
        st.via = "node";
        await this.run(o, s3);
      } catch (e) {
        // 池子里能解析、但连不上：必须给这条中继记账，否则选择器会一直把它挑回来
        nsFail(px.host + ":" + px.port);
        void p3.then((s) => { try { s.close(); } catch { /* 已经被关掉了 */ } }).catch(() => { /* 没连上 */ });
        try {
          ws.close(1011, "proxyip failed");
        } catch (err) {}
      }
    });
  }
}

/** 进程内唯一实例 */
export const ATTACHER = new Attacher();

