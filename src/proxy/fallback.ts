import { NodeStatsTable, CANDS } from "../nodes/score";
import { CONNECT_MS, errMsg, withTimeout } from "../core/util";
import { checkTarget, parseProxyIp } from "./dial";
import { DIALER } from "./dialer";
import type { RegionPicker } from "./region";
import { SEL } from "../px/selector";
import { cnt } from "../core/counter";
import { kickFlush } from "../store/index";
import { SOCKET_DIALER } from "./socket-dialer";
import type { BudgetedIO } from "../core/budgeted-io";
import { logErr } from "../nodes/metrics";
import { isCfIp } from "../core/net";
import { isBudgetExhausted } from "../core/budget-ledger";
import { Prefs } from "../facts/prefs";
import type { Socket } from "cloudflare:sockets";
import type { Connection } from "./connection";
import { splitRelay } from "../core/relay-addr";
import { socks5Open } from "../core/budgeted-io";
import { SOCKS } from "../px/selector";

/** CF 托管目标换节点时最多试几个候选：每个都是一次 connect()，别把免费计划的 6 并发吃光。 */
const ALT_TRIES = 4;

/**
 * 功能：换一个节点再拨一次（首包失败后的兜底，跳过刚失败的那个）。
 * 目标托管在 CF 上时（`st.cf`），只挑非 CF 出口的节点：CF→CF 中转仍然把客户端地址透传给目标，
 * 换一个 CF 边缘等于原地重试，救不回被目标按地址族拒绝的请求。
 * @param env 环境变量
 * @param st 连接状态（读 cf / node）
 * @param mode tput | lat
 * @param tag 日志标签（通常是目标主机）
 * @param cc 地区偏好
 * @returns socket；没有更合适的节点时返回 null（调用方回落到直连或直接断开）
 */
export async function dialAnother(
  _env: Env,
  st: Connection,
  mode: Mode,
  budget: BudgetedIO,
  tag?: string | null,
  cc?: string | null,
): Promise<Socket | null> {
  let avoid = st.node;
  for (let n = 0; n < ALT_TRIES; n++) {
    const alt = CANDS.next(mode, avoid, cc);
    if (!alt || alt === avoid) return null;
    avoid = alt;
    const [host, port] = splitRelay(alt, 443);
    // 池子可能被污染：内网/禁用端口一律不拨。这里是 continue 不是 return ——
    // 一条被污染的条目不该让整条补救链放弃（调用方回落到直连，等于白丢这次请求）。
    if (checkTarget(host, port)) continue;
    if (st.cf && isCfIp(host)) continue; // 见上：CF 托管目标必须换到非 CF 出口
    // 与主路径（Dialer.open → Selector.current → Prefs.chan）同一个口径：这个站点到这个中继
    // 已经被实测判为封锁的，别再花 2.5 秒拨一次 —— 走到补救链时客户端已经等了两三秒。
    if (Prefs.chan(host, st.host) === 2) continue;
    // 建连预算与「迟到关闭」都交给 SOCKET_DIALER：补救链更怕挂死——走到这里客户端已经等了两三秒。
    try {
      const socket = await SOCKET_DIALER.open(host, port, budget);
      st.node = alt;
      st.via = "node";
      st.pxTries = (st.pxTries || 1) + 1;
      logErr(`retry another node ${alt}`, tag || "");
      return socket;
    } catch (e) {
      if (isBudgetExhausted(e)) throw e;
      NodeStatsTable.nsFail(alt); // 这条候选连不上：冷却它，下一轮别再挑回来
    }
  }
  return null;
}


/** 路由会话需要的东西：都是会话自己已经解好的量，router 不再解析请求 */
export interface RouterOpts {
  /** Worker 环境（池子、KV 都在里面） */
  env: Env;
  /** 升级请求（规划器要 cf 信息与 header） */
  request: Request;
  /** 本次连接（记录 node/via/retried 等归属） */
  conn: Connection;
  /** 目标模式（tput / lat） */
  mode: Mode;
  /** `?px=` 强制候选下标（0 表示不强制） */
  pxForce: number;
  /** `?rg=` 地区（null 表示没有钉地区） */
  ipRegion: string | null;
  /** `?node=` 用户钉住的单个节点 key（null 表示没钉；钉住时硬失败不回落） */
  pinnedNode: string | null;
  /** `?s5=` 钉住的一条公共 SOCKS5 出口（null 表示没钉）：它能到任意站点，与 CF 中继不同 */
  socksNode: string | null;
  /** 本次调用的额度闸门（建连只从这里取号） */
  budget: BudgetedIO;
  /** 地区钉住时用的挑选器（会话持有，router 只借用） */
  regionPicker: RegionPicker;
  /** 关连接（会话负责：只有它知道客户端 socket 与关闭码语义） */
  onHangUp: (code: number, reason: string) => void;
}

/**
 * 功能：把「这一跳往哪走」的决策从会话里独立出来 —— `?rg=` 硬分流 → 拨号策略 → 补救一条中继。
 *
 * 为什么是它自己的类：这三段各自会花掉不同的额度（地区分流一次 connect、策略拨号最多两次、补救再
 * 两次），而且失败时记的账完全不同（`rgFail` / `dead` / 节点 `bumpFail`）。原先它们和握手、首帧解析、
 * 收尾挤在 session.ts 的 359 行里，「哪一步在花 connect 名额」只能靠通读；现在会话只说 `route(host, port)`。
 */
export class SessionRouter {
  /**
   * 功能：构造路由会话。
   * @param {RouterOpts} o 会话注入的上下文
   */
  constructor(private readonly o: RouterOpts) {}

  /**
   * 功能：给这一跳选一条出路。
   * @param {string} host 目标主机
   * @param {number} port 目标端口
   * @returns {Promise<Socket | null>} socket；地区路径失败或没有可用中继时返回 null（连接已被关）
   */
  async route(host: string, port: number): Promise<Socket | null> {
    // `?s5=` 比钉节点更强：用户要的是「所有流量都从这一条公共出口走」，它是通用出口（能到任意站点）
    if (this.o.socksNode) return this.viaSocks(host, port);
    // 钉单个节点的优先级最高：用户点名要这一条，节点失效就明确失败，不换节点不回落直连
    if (this.o.pinnedNode) return this.viaPinned(host, port);
    // 地区钉住是硬分流：找不到 / 连不上就明确失败，绝不回落到策略拨号（`?rg=` 的语义）
    if (this.o.ipRegion) return this.viaRegion(host);
    try {
      // 拨号策略整体在 Dialer 里：判难直连 → 选中继 → 退 IPv4 → 退直连
      return await DIALER.open({
        env: this.o.env,
        request: this.o.request,
        conn: this.o.conn,
        mode: this.o.mode,
        host,
        port,
        pxForce: this.o.pxForce,
        budget: this.o.budget,
      });
    } catch (e) {
      return this.viaFallback(host, e);
    }
  }

  /**
   * 功能：`?s5=` 这一支 —— 经指定的公共 SOCKS5 代理打开到目标的通道（通用出口，任意站点都行）。
   *
   * 与 `?node=` 的区别：CF 网络里的中继只肯转发 CF 托管站点（实测 github/gstatic 一律
   * `SSL alert number 40`），而公共 SOCKS5 代理是通用出口。所以这条既用于「全部流量走一个节点」，
   * 也是验证代理池是否真能用的端到端手段。
   * @param {string} host 目标主机
   * @param {number} port 目标端口
   * @returns {Promise<Socket | null>} 已握手的 socket；失败时已关连接并返回 null
   */
  private async viaSocks(host: string, port: number): Promise<Socket | null> {
    const o = this.o;
    const [ph, pp] = splitRelay(o.socksNode || "", 1080);
    const key = ph + ":" + pp;
    try {
      const sock = await socks5Open(o.budget, { host: ph, port: pp }, { host, port });
      cnt("s5Dial");
      o.conn.node = key;
      o.conn.via = "node";
      o.conn.retried = true;
      logErr(`socks5 -> ${key}`, host);
      return sock;
    } catch (e) {
      // 连不上就记一条失败（推进冷却），并明确失败：用户点名了这一条，不偷偷换别的出口
      SOCKS.markFail(key);
      cnt("s5Bad");
      logErr(`socks5 fail ${key}: ${errMsg(e)}`, host);
      o.onHangUp(1011, "socks5 failed");
      return null;
    }
  }

  /**
   * 功能：地区硬分流这一支 —— 失败时记 `rgFail` 并关连接，返回 null。
   * @param {string} host 目标主机
   * @returns {Promise<Socket | null>} socket 或 null
   */
  private async viaRegion(host: string): Promise<Socket | null> {
    const o = this.o;
    const region = o.ipRegion || "";
    // 地区是硬分流：用户点了国家就要那个国家的出口，这里不做「这个目标要不要中继」
    // 的预判——预判会把 ?rg= 悄悄降级成直连，用户看不出地区为什么没生效。
    // 「非 CF 目标别浪费中继」放在 viaFallback 的失败分支里（noRelayNonCf）。
    // 地区失败与「目标不可达」不是一回事：没节点 / 节点被策略禁止 / 节点连不上，三种都不说明目标站
    // 有问题。混记进 dead 会让面板上的 dead 同时代表两件事（v7.170 起分开计）。
    const onFail = (msg: string) => {
      o.conn.dead = true;
      o.conn.failed = true;
      cnt("rgFail");
      kickFlush(o.env, o.conn.id);
      logErr(`region ${region}: ${msg}`, host);
      o.onHangUp(1011, msg);
    };
    const picked = await o.regionPicker.open({ env: o.env, mode: o.mode, region, conn: o.conn, onFail, budget: o.budget });
    return picked || null;
  }

  /**
   * 功能：拨用户点名的单个节点（`?node=`）—— 需要中继时硬钉、失效即明确失败；
   * 不需要中继（非 CF 托管站点）时走普通拨号（直连优先），只把该节点钉成中继候选。
   *
   * 为什么要分情况：中继是 CF 网络里的转发出口，它只可靠转发 CF 托管站点。
   * 2026-11-26 实测（三个中继 × 五个站点）：经任一钉节点打 example.com/cloudflare.com/baidu
   * 都有正常响应，打 github.com/www.google.com/www.gstatic.com 全部 TLS 失败。
   * 而 Clash 的节点延迟测试默认探 `www.gstatic.com/generate_204`，所以无条件全量硬钉会让
   * 钉住的节点在客户端里一律显示「失败」，非 CF 站点也真的上不去。
   * @param host 目标主机
   * @param port 目标端口
   * @returns socket 或 null（已记账并关连接）
   */
  private async viaPinned(host: string, port: number): Promise<Socket | null> {
    const o = this.o;
    // 这个目标要不要绕中继：?px=1 明说要，或者它是 CF 托管/在名单里/失败学习过
    const wantPin = o.pxForce === 1 || (await DIALER.isCfTarget(o.env, host, o.budget).catch(() => false));
    if (!wantPin) {
      // 不需要中继：直连优先（本链路实测直连优于绕中继），但把用户点名的节点钉成中继候选，
      // 真需要绕时不换别的节点（`forceRelayIp` 只改候选来源，不强制走中继）
      cnt("pinDirect");
      o.conn.forceRelayIp = o.pinnedNode || "";
      try {
        return await DIALER.open({
          env: o.env,
          request: o.request,
          conn: o.conn,
          mode: o.mode,
          host,
          port,
          pxForce: o.pxForce,
          budget: o.budget,
        });
      } catch (e) {
        return this.viaFallback(host, e);
      }
    }
    // 用户点名节点：失败回调里记 rgFail 并关连接，绝不换节点/回落（?node= 的硬语义）
    const node = o.pinnedNode || "";
    const onFail = (msg: string) => {
      o.conn.dead = true;
      o.conn.failed = true;
      cnt("rgFail");
      kickFlush(o.env, o.conn.id);
      logErr(`node ${node}: ${msg}`, host);
      o.onHangUp(1011, msg);
    };
    const picked = await o.regionPicker.openPinned(o.env, node, o.conn, o.budget, onFail);
    return picked || null;
  }

  /**
   * 功能：直连/中继都失败时的补救 —— 取一条中继直连，连不上就再换一条。
   * @param {string} host 目标主机
   * @param {unknown} err 原始错误（一条中继都没有时要把它抛出去）
   * @returns {Promise<Socket | null>} socket 或 null
   */
  private async viaFallback(host: string, err: unknown): Promise<Socket | null> {
    const o = this.o;
    const st = o.conn;
    // 中继是 CF 托管站点的专用出口：非 CF 目标再试中继只会白花一次 connect 名额
    // （?px=1 是人工强制的调试开关，仍然按用户要求试）。
    if (!st.cf && o.pxForce !== 1) {
      cnt("noRelayNonCf");
      kickFlush(o.env, st.id);
      logErr(`dead target ${host}: ${errMsg(err)}`);
      o.onHangUp(1011, "连接目标失败");
      throw err;
    }
    const px0 = parseProxyIp(await SEL.current(o.env, o.mode, st, host, st.cf));
    if (!px0) {
      // 直连失败且没有可用中转 ⇒ 目标不可达（与「地区失败」严格区分）
      cnt("dead");
      kickFlush(o.env, st.id);
      logErr(`dead target ${host}: ${errMsg(err)}`);
      o.onHangUp(1011, "连接目标失败");
      throw err;
    }
    st.retried = true;
    st.pxTries = 1;
    try {
      // 纵深防御：种子池来自外部名单，进 connect 之前再验一次地址
      st.node = px0.host + ":" + px0.port;
      if (checkTarget(px0.host, px0.port)) throw new Error("proxyip 被策略禁止");
      // connect() 自己没有超时，挂死会让客户端一直等；超时之后迟到成功的 socket 也必须关掉，
      // 否则白占免费计划的并发 connect 名额（与 Dialer / Attacher / Region 同一口径）
      const pk0 = o.budget.openSocket(px0.host, px0.port);
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
      const alt = await dialAnother(o.env, st, o.mode, o.budget, host);
      if (alt) return alt;
      // 连不上中转是节点问题，不是目标站问题：站点级试探也要把节点冻掉，否则这条探索路径每次白撞
      await SEL.bumpFail(o.env, st.mode, st.node, st.hostTrial);
      throw e2;
    }
  }
}
