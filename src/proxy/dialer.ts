import { connect } from "cloudflare:sockets";
import type { Socket } from "cloudflare:sockets";
import type { Connection } from "./connection";
import { SC } from "../core/const";
import { HOOK } from "../core/hook";
import { isPxHost } from "../core/hosts";
import { isCfIp } from "../core/net";
import { S } from "../core/state";
import { cnt } from "../core/counter";
import { withTimeout } from "../core/util";
import { logErr } from "../nodes/metrics";
import { nsFail } from "../nodes/stat";
import { SEL } from "../px/selector";
import { cfHttpCode, refreshCfHttp } from "./cfverdict";
import { checkTarget, dial, dial4, isCfHost, isV6Literal, parseProxyIp } from "./dial";
import { pxDecision } from "./pxhook";


export interface DialOpts {
  env: Env;
  request: Request;
  st: Connection;
  mode: Mode;
  host: string;
  port: number;
  /** 1 = 强制中转，-1 = 强制直连，0 = 按名单 + 失败学习（?px= 调试用） */
  pxForce: number;
}

/**
 * 出站拨号器（P5 第一刀）：把 handleUpgrade 里那一大段「判难直连 → 选中继 → 退 IPv4 → 退直连」
 * 收成一个对象。session 只负责解析首包，拨号策略全在这里。
 */
export class Dialer {
  /**
   * 打开到目标的出站连接；失败抛错（由调用方决定是否回落到中继/断开）。
   * 返回值非空即成功，`st.node/via/pxTries` 已在内部写好。
   */
  async open(o: DialOpts): Promise<Socket> {
    const { env, request, st, mode, host, port, pxForce } = o;
    let sock: Socket | null = null;

    // 难直连目标（如 x.com）：判据 = 名单 / 6h 学习 / CF 网段 / ?px=1，?px=0 一律直连
    // 顺序：中继优先（直连多半撞自家边缘），退 IPv4 拨号，再退普通直连
    const learned = (S.needPx.get(host) || 0) > Date.now();
    const onList = isPxHost(env, host);
    let cfHost = (S.cfHost.get(host) || 0) > Date.now();
    if (!learned && !onList && !cfHost && env.proxyip === "auto") {
      // DoH 抖动会偶发失败，而这是判定层的关键输入：给两次机会（不做负缓存）。
      for (let k = 0; k < 2 && !cfHost; k++) {
        try {
          cfHost = await withTimeout(isCfHost(host), 1200);
        } catch {
          cfHost = false;
        }
      }
      if (cfHost) S.cfHost.set(host, Date.now() + 1800000);
    }
    if (cfHost && !S.vtLoaded && HOOK.vtLoad) await HOOK.vtLoad(env);
    const win = HOOK.win ? HOOK.win(host) : { d: false, r: false };
    const dirWin = win.d;
    const relWin = win.r;
    const httpCode = cfHost ? cfHttpCode(host) : 0;
    if (cfHost) refreshCfHttp(host, st.ctx);
    // 判定层要知道目标是 CF 托管：直连被自家边缘拒时一次即判，所以放在分支外
    st.cf = cfHost;
    // 客户端出口地址族：v6 客户端打 CF 托管目标必被 4 字节 `IPv6` 页拒（F6），
    // 而 v4 客户端直连往往就是好的——同时段对照实测「直连 6/8、中继 5/8」，
    // 中继那一跳只多加两段 RTT（TTFB +0.4~1.3s），并不提升命中率。
    const clientV6 = (request.headers.get("cf-connecting-ip") || "").includes(":");
    const wantPx =
      pxForce > 0 ||
      (pxForce === 0 && !!env.proxyip && (learned || onList || relWin || (cfHost && clientV6 && !dirWin && httpCode !== 200)));

    if (pxDecision(request, host, cfHost, wantPx, SC.POLICY, mode)) {
      // ?rx= 钉住中继（只给诊断脚本用）：跳过选择器直接用它，用来给每条中继量吞吐。
      // 最多试两条：公共中继里有一类是「TCP 能连、但一直不回字节」或「回自己的证书」，
      // 单次尝试失败就退回直连，而 CF 托管目标直连大概率 4 字节 403 —— 等于白丢这次请求。
      for (let tries = 0; tries < 2 && !sock; tries++) {
        const p = parseProxyIp(st.rx || (await SEL.current(env, mode, st, host, cfHost)));
        if (!p || checkTarget(p.host, p.port)) break;
        const key = p.host + ":" + p.port;
        // 池子里的「优选 IP」本身就是 CF 边缘：拿它中转到 CF 托管目标，等于从同一边缘再撞一次。
        if (cfHost && isCfIp(p.host)) {
          logErr(`skip cf-edge relay ${p.host}`, host);
          continue;
        }
        try {
          // 拨号必须有上限：connect() 自己没有超时，挂死的中继会把整个请求拖到客户端放弃为止。
          sock = await withTimeout(Promise.resolve(connect({ hostname: p.host, port: p.port })), 2500);
          st.node = key;
          st.via = "node";
          st.retried = true;
          st.pxTries = tries + 1;
          cnt("pxf");
          break;
        } catch {
          sock = null;
          nsFail(key); // 中转本身连不上：冷却它，下一条换个候选试
        }
      }
    }

    // 中转不可用或没走中转：CF 托管目标优先按 A 记录拨号（X 会直接拒 IPv6 出口）。
    if (!sock) {
      if (cfHost && !isV6Literal(host)) {
        sock = await dial4(host, port);
        if (sock) {
          cnt("px4");
          logErr(`ipv4 first ${host}`, host);
        }
      }
      if (!sock) sock = await dial(host, port);
    }
    if (!sock) throw new Error("skip-direct");
    return sock;
  }
}

/** 进程内唯一实例 */
export const DIALER = new Dialer();

