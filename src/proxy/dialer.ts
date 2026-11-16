import { connect } from "cloudflare:sockets";
import type { Socket } from "cloudflare:sockets";
import type { Connection } from "./connection";
import { SC } from "../core/const";
import { HOOK } from "../core/hook";
import { isPxHost } from "../core/hosts";
import { isCfIp } from "../core/net";
import { S } from "../core/state";
import { cnt } from "../core/counter";
import { CONNECT_MS, closeQuietly, withTimeout } from "../core/util";
import { dropExpired, trimAged } from "../core/hostmem";
import { logErr } from "../nodes/metrics";
import { nsFail } from "../nodes/stat";
import { SEL } from "../px/selector";
import { refreshCfHttp } from "./cfverdict";
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
      if (cfHost) {
        S.cfHost.set(host, Date.now() + 1800000);
        // 键是客户端请求里的站点名：先过期清理，再按「最早过期」压回上限
        if (S.cfHost.size > SC.HOST_MEM_MAX) {
          dropExpired(S.cfHost);
          trimAged(S.cfHost);
        }
      }
    }
    if (cfHost && !S.vtLoaded && HOOK.vtLoad) {
      // 冷 isolate 读一次事实能省掉「注定失败的第一次请求」，但首字节不能为它排队：
      // 最多等 200ms，超时先放行（事实会在后台继续应用，下一条连接就能用上）。
      await Promise.race([HOOK.vtLoad(env), new Promise<void>((r) => setTimeout(r, 200))]);
    }
    const win = HOOK.win ? HOOK.win(host) : { d: false, r: false };
    const relWin = win.r;
    if (cfHost) refreshCfHttp(host, st.ctx);
    // 判定层要知道目标是 CF 托管：直连被自家边缘拒时一次即判，所以放在分支外
    st.cf = cfHost;
    // CF 托管目标：直连与中继谁更可能被拒，取决于**出口地址族**，与客户端族无关
    // （隧道是原始 TCP，客户端 IP 不进隧道——7.85 用 clientV6 卡过一次，是错的）。
    // 2026-11-15 04:14 实测：强制直连 2/6、强制中继 4/6、默认 5/6；且用户网络无 v6
    // 时 clientV6 恒为假 → 这条恒走直连 → 全线 403。所以这里只问「有没有新鲜直连成功证据」，
    // 有的情况交给 policy 的 direct-ok（5 分钟）判断，没有就优先中继。
    // 本出口 fetch 的 200 不代表隧道直连能成（fetch 走 CF 自己的出口）：7.60 起就用它挡过一次，
    // 2026-11-15 06:5x 配对实测（同一条命令内交替，各 30 条）：强制直连 30/30、强制中继 26/30；
    // 即「CF 托管站点默认绕中继」在当前链路下是负收益。改成只在**有证据**时才绕：
    // 直连最近失败过（`learned`）、命中 proxyip 名单、或该站点中继最近成功过（`relWin`）。
    // 但实测 `httpCode === 200` 时隧道仍有大量 403 —— 继续用它会让「明明有 v4 中继」的请求退回直连。
    const wantPx =
      pxForce > 0 ||
      (pxForce === 0 && !!env.proxyip && (learned || onList || relWin));

    if (pxDecision(request, host, cfHost, wantPx, SC.POLICY, mode)) {
      // ?rx= 钉住中继（只给诊断脚本用）：跳过选择器直接用它，用来给每条中继量吞吐。
      // 最多试两条：公共中继里有一类是「TCP 能连、但一直不回字节」或「回自己的证书」，
      // 单次尝试失败就退回直连，而 CF 托管目标直连大概率 4 字节 403 —— 等于白丢这次请求。
      // 第二个候选必须**换一条**：选择器的确定性路径（站点偏好 / 非 CF 优先）在同一秒内
      // 两次调用返回的是同一条，而 nsFail 的惩罚不足以让它掉出第一 —— 所以把试过的键传下去。
      const tried = new Set<string>();
      // 钉住的 ?rx= 只试一次：它本来就是「我就要这一条」的诊断语义
      const maxTries = st.rx ? 1 : 2;
      // 名额的语义是「真的拨了几次」。以前用循环下标当名额，于是下面那个
      // 「跳过 CF 边缘中继」的 continue 也会吃掉一次 —— 候选里排着 CF 边缘时，
      // 「最多试两条」实际只试了一条，剩下那条能用的中继根本没被拨过。
      let tries = 0;
      for (let guard = 0; guard < maxTries + 4 && tries < maxTries && !sock; guard++) {
        const p = parseProxyIp(st.rx || (await SEL.current(env, mode, st, host, cfHost, tried)));
        if (!p || checkTarget(p.host, p.port)) break;
        const key = p.host + ":" + p.port;
        // 没有别的候选了（选择器回空或回同一条）：不要再花 2.5 秒试同一条
        if (tried.has(key)) break;
        tried.add(key);
        // 池子里的「优选 IP」本身就是 CF 边缘：拿它中转到 CF 托管目标，等于从同一边缘再撞一次。
        if (cfHost && isCfIp(p.host)) {
          // 只计数：这里每个 CF 托管站点的请求都可能命中一次，
          // 写进错误环会把真正的故障挤掉（7.84 删「每条成功连接都写 logErr」就是同一个原因）
          cnt("skipCfRelay");
          continue;
        }
        tries += 1;
        const pk = Promise.resolve(connect({ hostname: p.host, port: p.port }));
        try {
          // 拨号必须有上限：connect() 自己没有超时，挂死的中继会把整个请求拖到客户端放弃为止。
          sock = await withTimeout(pk, CONNECT_MS);
          st.node = key;
          st.via = "node";
          st.retried = true;
          st.pxTries = tries;
          cnt("pxf");
          // 连上了：把这条中继的「连不上」计数清零（复活只可能由真实连接触发）
          HOOK.deadNote?.(p.host, true);
          break;
        } catch {
          sock = null;
          // 超时之后 connect 仍可能迟到成功：必须把它关掉，否则免费计划 6 个并发 connect 名额
          // 会被「已经超时、但真的连上了」的连接慢慢吃掉（现象是后面所有请求都失败）。
          void pk.then((s) => { try { s.close(); } catch { /* 已经被关掉了 */ } }).catch(() => { /* 本来就没连上 */ });
          nsFail(key); // 中转本身连不上：冷却它，下一条换个候选试
          // 连接层事实（v8 §3 的 dead）：没有任何 HTTP 状态行，与业务 403 物理上不可混淆
          HOOK.deadNote?.(p.host, false);
        }
      }
    }

    // 中转不可用或没走中转：CF 托管目标优先按 A 记录拨号（X 会直接拒 IPv6 出口）。
    if (!sock) {
      if (cfHost && !isV6Literal(host)) {
        sock = await this.guarded(dial4(host, port), host);
        if (sock) {
          cnt("px4");
          logErr(`ipv4 first ${host}`, host);
        }
      }
      if (!sock) sock = await this.guarded(dial(host, port), host);
    }
    if (!sock) throw new Error("dial returned null");
    return sock;
  }

  /**
   * 功能：给一条直连拨号加上限，并在超时后把「迟到连上」的 socket 关掉。
   * @param p 拨号 Promise（`dial` / `dial4` 的返回值，`null` 表示没有可用地址）
   * @param host 目标域名（只用于错误信息）
   * @returns 连上的 socket；超时或全部失败时抛错 / 返回 null
   */
  private async guarded(p: Promise<Socket | null>, host: string): Promise<Socket | null> {
    // 与中继分支同一个口径：直连同样是 connect()，同样没有自己的超时。
    // 挂死的直连会把请求拖到客户端放弃为止，而那条「已经超时、但真的连上了」的连接
    // 会白占免费计划 6 个并发 connect 名额（症状是之后所有站点开始零星失败）。
    const pk = Promise.resolve(p);
    try {
      return await withTimeout(pk, CONNECT_MS);
    } catch (e) {
      void pk.then((x) => closeQuietly(x)).catch(() => {
        /* 本来就没连上 */
      });
      logErr(`direct dial timeout ${host}`, host);
      throw e;
    }
  }
}

/** 进程内唯一实例 */
export const DIALER = new Dialer();

