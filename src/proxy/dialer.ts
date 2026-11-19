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
import { NodeStatsTable } from "../nodes/stat";
import { SEL } from "../px/selector";
import { refreshCfHttp } from "./cfverdict";
import { checkTarget, dial, dial4, isCfHost, isV6Literal, parseProxyIp } from "./dial";
import { pxDecision } from "./pxhook";
import { BudgetedIO } from "../core/budgeted-io";
import { isBudgetExhausted } from "../core/budget-ledger";


interface DialOpts {
  env: Env;
  request: Request;
  conn: Connection;
  mode: Mode;
  host: string;
  port: number;
  /** 1 = 强制中转，-1 = 强制直连，0 = 按名单 + 失败学习（?px= 调试用） */
  pxForce: number;
  /** 本次请求的额度：建连只从它取号（额度用完即视为这条腿拨不动） */
  budget: BudgetedIO;
}

/**
 * 一次拨号前的判定结果。
 * 这两个值都是 `Classify` 那一段的产物：`cfHost` 回答「目标是不是 CF 托管」，
 * `wantPx` 回答「这次要不要绕中继」，下游只读不改。
 */
interface Route {
  cfHost: boolean;
  wantPx: boolean;
}

/**
 * 一次候选评估的结论：要么可以拨，要么给出跳过原因。
 * 把「取哪条」与「这条能不能用」分开之后，循环只剩三件事：取候选、处理跳过、拨一次。
 */
interface RelayCand {
  /** 能不能拿去拨 */
  ok: boolean;
  /** 跳过原因：`none` = 选择器没给出候选，`bad` = 地址非法，`dup` = 已经试过，`cf` = 边缘中继 */
  why: "none" | "bad" | "dup" | "cf" | "ok";
  /** 候选地址（`why === "none"` 时为空串） */
  host: string;
  /** 候选端口 */
  port: number;
  /** `host:port`，用来记账与防重复 */
  key: string;
}

/**
 * 出站拨号器（P5 第一刀）：把 handleUpgrade 里那一大段「判难直连 → 选中继 → 退 IPv4 → 退直连」
 * 收成一个对象。session 只负责解析首包，拨号策略全在这里。
 *
 * 三段各管一件事，代价从高到低：`classify`（可能要一次 DoH + 一次事实加载，最多 200ms）
 * → `viaRelay`（每条候选一次 `connect()`，每次最多 2.5 秒）→ `direct`（一次 `dial4`、一次 `dial`）。
 */
export class Dialer {
  /**
   * 打开到目标的出站连接；失败抛错（由调用方决定是否回落到中继/断开）。
   * 返回值非空即成功，`conn.node/via/pxTries` 已在内部写好。
   * @param o 目标、模式与调试开关（`?px=` / `?rx=`）
   * @returns 已连上的 socket
   */
  async open(o: DialOpts): Promise<Socket> {
    const { request, host, port } = o;
    const route = await this.classify(o);
    let sock: Socket | null = null;
    if (pxDecision(request, host, route.cfHost, route.wantPx, SC.POLICY, o.mode)) {
      sock = await this.viaRelay(o, route.cfHost);
    }
    // 中转不可用或没走中转：CF 托管目标优先按 A 记录拨号（X 会直接拒 IPv6 出口）
    if (!sock) sock = await this.direct(o, host, port, route.cfHost);
    if (!sock) throw new Error("dial returned null");
    return sock;
  }

  /**
   * 功能：判定这次拨号的前提（目标是否 CF 托管、要不要绕中继），并写好连接上的事实。
   * 这一段会做 I/O（DoH 判 CF 托管、冷 isolate 读一次事实），所以只在 `open` 开头调用一次。
   * @param o 目标与模式
   * @returns 判定结果（`cfHost` 与 `wantPx`）
   */
  private async classify(o: DialOpts): Promise<Route> {
    const { env, conn, host, pxForce } = o;
    // 难直连目标（如 x.com）：判据 = 名单 / 6h 学习 / CF 网段 / ?px=1，?px=0 一律直连
    // 顺序：中继优先（直连多半撞自家边缘），退 IPv4 拨号，再退普通直连
    const learned = (S.needPx.get(host) || 0) > Date.now();
    const onList = isPxHost(env, host);
    let cfHost = (S.cfHost.get(host) || 0) > Date.now();
    if (!learned && !onList && !cfHost && env.proxyip === "auto") {
      // DoH 抖动会偶发失败，而这是判定层的关键输入：给两次机会（不做负缓存）。
      for (let k = 0; k < 2 && !cfHost; k++) {
        try {
          cfHost = await withTimeout(isCfHost(host, o.budget), 1200);
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
    if (cfHost) refreshCfHttp(host, conn.ctx, o.budget);
    // 判定层要知道目标是 CF 托管：直连被自家边缘拒时一次即判，所以放在分支外
    conn.cf = cfHost;
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
    return { cfHost, wantPx };
  }

  /**
   * 功能：按候选池逐条试中继，最多拨 `maxTries` 次（`?rx=` 钉住时只拨一次）。
   * @param o 目标与模式
   * @param cfHost 目标是 CF 托管（此时跳过「优选 IP」这类边缘中继）
   * @returns 连上的 socket；全部候选都失败时返回 null
   */
  private async viaRelay(o: DialOpts, cfHost: boolean): Promise<Socket | null> {
    // ?rx= 钉住中继（只给诊断脚本用）：跳过选择器直接用它，用来给每条中继量吞吐。
    // 最多试两条：公共中继里有一类是「TCP 能连、但一直不回字节」或「回自己的证书」，
    // 单次尝试失败就退回直连，而 CF 托管目标直连大概率 4 字节 403 —— 等于白丢这次请求。
    const tried = new Set<string>();
    // 钉住的 ?rx= 只试一次：它本来就是「我就要这一条」的诊断语义
    const maxTries = o.conn.forceRelayIp ? 1 : 2;
    // 名额的语义是「真的拨了几次」。以前用循环下标当名额，于是「跳过 CF 边缘中继」的
    // continue 也会吃掉一次 —— 候选里排着 CF 边缘时，「最多试两条」实际只试了一条。
    let tries = 0;
    // guard 上限比名额多四：跳过（非法 / 重复 / CF 边缘）不花名额，但循环必须有界
    for (let guard = 0; guard < maxTries + 4 && tries < maxTries; guard++) {
      const cand = await this.nextCand(o, cfHost, tried);
      if (cand.why === "none") break;
      if (!cand.ok) {
        // 非法候选只是**这一条**不能用：跳过它继续找下一条。以前这里是一个 break ——
        // 池子里混进一条 10.x 的 proxyip（公开源里很常见，takePoolLine 只校验八位组范围、
        // 不排除保留地址）就让整条重试链提前结束，请求退回直连；对 CF 托管目标那就是 4 字节 403。
        if (cand.why === "bad") cnt("badRelay");
        // 池子里的「优选 IP」本身就是 CF 边缘：拿它中转到 CF 托管目标，等于从同一边缘再撞一次。
        // 只计数：这里每个 CF 托管站点的请求都可能命中一次，写进错误环会把真正的故障挤掉
        else if (cand.why === "cf") cnt("skipCfRelay");
        // 没有别的候选了（选择器回空或回同一条）：不要再花 2.5 秒试同一条
        else if (cand.why === "dup") break;
        continue;
      }
      tries += 1;
      const sock = await this.attemptRelay(o, cand, tries);
      if (sock) return sock;
    }
    return null;
  }

  /**
   * 功能：取下一个候选并判断这一条能不能拨（只判断，不拨）。
   * @param o 目标与模式
   * @param cfHost 目标是 CF 托管
   * @param tried 已经试过的键（原地写入）
   * @returns 结论；`ok` 为真时 `host`/`port` 就是要拨的地址
   */
  private async nextCand(o: DialOpts, cfHost: boolean, tried: Set<string>): Promise<RelayCand> {
    const raw = o.conn.forceRelayIp || (await SEL.current(o.env, o.mode, o.conn, o.host, cfHost, tried));
    const p = parseProxyIp(raw);
    // 选择器给不出候选（池子空、或者所有候选都被排除）：本轮到此为止
    if (!p) return { ok: false, why: "none", host: "", port: 0, key: "" };
    // 内网地址 / 策略禁止的端口：这一条不能用，但下一条可能行
    if (checkTarget(p.host, p.port)) return { ok: false, why: "bad", host: p.host, port: p.port, key: "" };
    const key = p.host + ":" + p.port;
    if (tried.has(key)) return { ok: false, why: "dup", host: p.host, port: p.port, key };
    // 进 `tried` 的时机在「能不能用」之前：边缘中继虽然不拨，但同一条候选不该被反复评估
    // （以前每次都是同一秒内选择器回同一条，不记下来就会在 guard 里空转四圈）
    tried.add(key);
    // 边缘中继中转 CF 托管目标等于同一边缘撞第二次：不花名额，也不算失败
    if (cfHost && isCfIp(p.host)) return { ok: false, why: "cf", host: p.host, port: p.port, key };
    return { ok: true, why: "ok", host: p.host, port: p.port, key };
  }

  /**
   * 功能：拨一次候选；成功就把这条中继记到连接上，失败就冷却它并关掉迟到成功的 socket。
   * @param o 目标与模式
   * @param cand 已判定可拨的候选
   * @param tries 这是第几次真拨（写进连接，供收尾分派）
   * @returns 连上的 socket；失败返回 null
   */
  private async attemptRelay(o: DialOpts, cand: RelayCand, tries: number): Promise<Socket | null> {
    const { conn } = o;
    const pk = o.budget.openSocket(cand.host, cand.port);
    try {
      // 拨号必须有上限：connect() 自己没有超时，挂死的中继会把整个请求拖到客户端放弃为止。
      const sock = await withTimeout(pk, CONNECT_MS);
      conn.node = cand.key;
      conn.via = "node";
      conn.retried = true;
      conn.pxTries = tries;
      cnt("pxf");
      // 连上了：把这条中继的「连不上」计数清零（复活只可能由真实连接触发）
      HOOK.deadNote?.(cand.host, true);
      return sock;
    } catch (err) {
      // 额度用尽不是「这条腿不通」：继续换只会把剩下的候选全试一遍，还会把好中继记成坏
      if (isBudgetExhausted(err)) throw err;
      // 超时之后 connect 仍可能迟到成功：必须把它关掉，否则免费计划 6 个并发 connect 名额
      // 会被「已经超时、但真的连上了」的连接慢慢吃掉（现象是后面所有请求都失败）。
      void pk.then((s) => { try { s.close(); } catch { /* 已经被关掉了 */ } }).catch(() => { /* 本来就没连上 */ });
      NodeStatsTable.nsFail(cand.key); // 中转本身连不上：冷却它，下一条换个候选试
      // 连接层事实（v8 §3 的 dead）：没有任何 HTTP 状态行，与业务 403 物理上不可混淆
      HOOK.deadNote?.(cand.host, false);
      return null;
    }
  }

  /**
   * 功能：直连目标（CF 托管目标先按 A 记录拨 IPv4，再退普通拨号）。
   * @param host 目标域名
   * @param port 目标端口
   * @param cfHost 目标是 CF 托管（此时 `X` 会拒 IPv6 出口，所以先试 IPv4）
   * @returns 连上的 socket；两条都失败时返回 null
   */
  private async direct(o: DialOpts, host: string, port: number, cfHost: boolean): Promise<Socket | null> {
    let sock: Socket | null = null;
    if (cfHost && !isV6Literal(host)) {
      sock = await this.guarded(dial4(host, port, o.budget), host);
      if (sock) {
        cnt("px4");
        logErr(`ipv4 first ${host}`, host);
      }
    }
    if (!sock) sock = await this.guarded(dial(host, port, o.budget), host);
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
