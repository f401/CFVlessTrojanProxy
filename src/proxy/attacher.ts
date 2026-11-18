import type { Socket } from "cloudflare:sockets";
import type { Connection } from "./connection";
import { S } from "../core/state";
import { SC } from "../core/const";
import { trimAged } from "../core/hostmem";
import { cnt } from "../core/counter";
import { FIRST_UP_MS, closeQuietly, releaseAll, WS_OPEN } from "../core/util";
import { logErr, rttMark } from "../nodes/metrics";
import { NodeStatsTable } from "../nodes/stat";
import { SEL } from "../px/selector";
import { kickFlush } from "../store/pend";
import { checkTarget, expandV6, isV6Literal, parseProxyIp } from "./dial";
import { dialAnother } from "./fallback";
import { SOCKET_DIALER } from "./socket-dialer";
import { isBudgetExhausted } from "../core/budget-ledger";
import type { BudgetedIO } from "../core/budgeted-io";
import { pipeBack } from "./tunnel";

export interface AttachOpts {
  env: Env;
  clientSocket: WebSocketLike;
  conn: Connection;
  mode: Mode;
  host: string;
  port: number;
  /** ?rg=xx 地区（硬约束）；为空表示普通分流 */
  region: string | null;
  /** 客户端首个载荷（TLS ClientHello 含 SNI）：每接一条新上游都要重发 */
  payload: Uint8Array;
  /** 本次请求的额度：补救链的每一次建连都从这里取号 */
  budget: BudgetedIO;
}

/**
 * 上游挂载器（P5-4）：把「首包写入 + 双向搬运 + 0 字节关闭的补救链」收成一个对象。
 * 补救链顺序：中转再试一个 → IPv6 兜底（可选）→ proxyip → 放弃。
 */
export class Attacher {
  /**
   * 功能：关掉客户端 WS，并吞掉「已经关了」的异常。
   *
   * 为什么要收成一处：补救链上有五个放弃点（首包回完 / 换节点也不通 / 直连无候选 /
   * proxyip 被策略拦 / proxyip 连不上），每一处在关客户端时都要区分关闭码与原因。
   * 以前每处各写一个 `try { close } catch (e) {}`，改原因字符串时容易只改一半。
   * @param {WebSocketLike} clientSocket 客户端连接
   * @param {number} code 关闭码（1000 正常结束 / 1011 上游不可用）
   * @param {string} reason 关闭原因（会出现在 `/logs` 里，用来区分是哪一跳放弃的）
   * @returns {void}
   */
  private endClient(clientSocket: WebSocketLike, code: number, reason: string): void {
    // close() 在已经关闭的连接上会抛：这是唯一该吞掉的异常，其他错误要显形
    try {
      clientSocket.close(code, reason);
    } catch {
      /* 客户端已经走了 */
    }
  }

  /**
   * 把已建立的 `sock` 挂到客户端 WS 上；0 字节关闭时按补救链继续，直到成功或放弃。
   */
  async run(o: AttachOpts, sock: Socket): Promise<void> {
    const { conn, payload } = o;
    // 递归重试时上一跳的 socket 与写锁必须显式释放：下面几行会把字段覆盖掉，
    // 不关就等于每重试一次漏一个 socket（免费计划的并发 connect 名额全局只有 6 个）。
    if (conn.sock && conn.sock !== sock) releaseAll(conn);
    conn.syncInflight();
    conn.sock = sock;
    conn.writer = sock.writable.getWriter();
    conn.headerSent = false;
    conn.tAttach = Date.now(); // 首字节耗时从这里起算
    conn.ttfb = 0;
    // 首包写也要有上限：黑洞中继接了连接却不读，write 永不返回，而客户端已经等在首字节上
    if (payload.length) await conn.upWrite(payload, FIRST_UP_MS);

    // 之后所有收尾都交给 onClose：这里只负责把这一跳接上，不再关心它怎么结束
    pipeBack(sock, o.clientSocket, conn, async (gotData) => {
      await this.onClose(o, gotData);
    });
  }

  /**
   * 功能：一跳链路结束时的分派 —— 先判「客户端还在不在」「这一跳拿到数据了吗」，
   * 再决定是正常收尾、走中转失败、还是直连 0 字节关闭后的两条兜底。
   *
   * 为什么单独成方法：这三件事的判据互相依赖（`gotData` 决定要不要重置失败记忆，
   * `conn.retried` 决定走哪条兜底链），但它们的**代价**差别极大 —— 正常收尾零成本，
   * 中转失败可能要再拨一次，直连空关闭可能要试 IPv6 与 proxyip 两条外部路径。
   * 挤在一个函数体里读不出「这次到底会不会再发请求」。
   * @param {AttachOpts} o 本跳的选项（含 env / clientSocket / conn / host / port）
   * @param {boolean} gotData 这一跳是否交出过上行数据
   * @returns {Promise<void>} 收尾完成后 resolve
   */
  private async onClose(o: AttachOpts, gotData: boolean): Promise<void> {
    const { env, clientSocket, conn } = o;
    // 客户端已经走了（取消下载 / 切网 / 切节点）：别再替它开新中转
    if (clientSocket.readyState !== WS_OPEN) {
      closeQuietly(conn.sock);
      return;
    }
    if (gotData) SEL.resetFail(env, conn.node); // 能通就说明链路健康，别乱切
    // 第一次 0 字节关闭才记一次 RTT 失败：同一条连接反复关闭不该累加惩罚
    if (!gotData && !conn.markedFail) {
      conn.markedFail = true;
      rttMark(conn.id, conn.ipTag, false);
    }
    if (gotData) {
      // 拿到过数据就是正常结束：不惩罚任何一方
      this.endClient(clientSocket, 1000, "done");
      return;
    }
    // 这一跳本来就是中转（第 ④ 支标记过 retried）：中转失败有独立的记账与重试规则
    if (conn.retried) return this.viaRelayFailed(o);
    // 剩下的都是直连 0 字节关闭：先试 IPv6，再试 proxyip（两条都是外部兜底）
    return this.directEmpty(o);
  }

  /**
   * 功能：中转这一跳 0 字节关闭的收尾 —— 记账、必要时换一条中继重试、否则判这个目标走不了中转。
   * @param {AttachOpts} o 本跳的选项
   * @returns {Promise<void>} 收尾完成后 resolve
   */
  private async viaRelayFailed(o: AttachOpts): Promise<void> {
    const { env, clientSocket, conn, host, region } = o;
    // 已经走中转还是 0 字节关闭 → 这次中转失败，必须计数（否则面板上看不出中转在失败）
    cnt("eCloseP");
    NodeStatsTable.nsEmptyClose(conn.node, true);
    // 同一跳最多换一条中继：换第三跳解决不了「这个站经中转走不通」这件事
    if ((conn.pxTries || 1) < 2) {
      const s2 = await dialAnother(env, conn, o.mode, o.budget, host, region || undefined);
      if (s2) {
        // 递归回来时 run 会接管新 socket，旧的已在 run 开头释放
        await this.run(o, s2);
        return;
      }
    }
    // 地区钉住的连接失败不等价于「目标不可达」：这里可能只是该地区没别的候选了。
    // 混记进 dead 会让面板上的 dead 同时代表两件事（v7.170 在 session.ts 里分开计，
    // v7.171 把补救链这一处也一起分开）。
    cnt(region ? "rgFail" : "dead");
    kickFlush(env, conn.id); // 换节点也不通 → 这个目标走不了中转
    conn.failed = true;
    conn.siteFail = true;
    // 站点级试探与普通站点失败在这里是同一件事：只轻记节点（nsSiteFail），
    // 不动全局失败记忆、也不冻结。原来那个 if/else 的两条分支调的其实是同一个函数。
    await SEL.softFail(conn.node);
    this.endClient(clientSocket, 1000, "done");
  }

  /**
   * 功能：直连这一跳 0 字节关闭后的兜底链 —— 先试 IPv6（可选），再试 proxyip（最后兜底）。
   * @param {AttachOpts} o 本跳的选项
   * @returns {Promise<void>} 收尾完成后 resolve
   */
  private async directEmpty(o: AttachOpts): Promise<void> {
    const { conn } = o;
    // 直连这一跳 0 字节关闭：记成「直连不通」，用来和节点做对照
    conn.directFail = true;
    // 第一条兜底成功接手就直接返回：它内部会递归回 run，这里不需要再做别的
    if (await this.tryV6(o)) return;
    await this.tryProxyip(o);
  }

  /**
   * 功能：IPv6 兜底 —— 用 `env.cfIpv6` 里的地址重试一次（`?rg=` 钉住地区时不启用）。
   *
   * 实测对 CF 托管站点无效（那类目标只认 IPv4 出口），所以默认关闭，
   * 只有显式配了 `env.cfIpv6` 才启用；一次连接只试一次（`conn.triedV6`）。
   * @param {AttachOpts} o 本跳的选项
   * @returns {Promise<boolean>} 是否已经由 IPv6 重试接手（接手后调用方不再走 proxyip）
   */
  private async tryV6(o: AttachOpts): Promise<boolean> {
    const { env, conn, host, port, region } = o;
    // 地区钉住时不能用别的地址族冒充：那会让 `?rg=` 的语义失真
    if (region || conn.triedV6 || !env.cfIpv6 || isV6Literal(host)) return false;
    conn.triedV6 = true;
    for (const raw of String(env.cfIpv6).split(",")) {
      const v6 = raw.trim();
      if (!v6) continue;
      // 建连预算与「迟到关闭」都交给拨号器：这两条补救建连以前和主路径各写一遍，
      // 谁漏掉后半段都不会有门禁变红，只会静默吃掉并发名额（7.86）。
      try {
        logErr(`empty close -> retry via IPv6 ${v6}`, host);
        const s6 = await SOCKET_DIALER.open(expandV6(v6), port, o.budget);
        conn.via = "v6";
        await this.run(o, s6);
        return true;
      } catch (e) {
        // 额度耗尽时 connect 根本没发出：别再空转剩余 v6 地址（F1.4）
        if (isBudgetExhausted(e)) return false;
        // 这条候选不通就换下一个：迟到成功的 socket 已经由拨号器关掉了
      }
    }
    return false;
  }

  /**
   * 功能：proxyip 兜底（第三方中转，直连与 IPv6 都不通时的最后一跳）。
   *
   * 成功接手时不返回任何东西（递归回 `run`）；失败时只关客户端、不再往上抛，
   * 因为此时已经没有任何可试的路径了。
   * @param {AttachOpts} o 本跳的选项
   * @returns {Promise<void>} 收尾完成后 resolve
   */
  private async tryProxyip(o: AttachOpts): Promise<void> {
    const { env, clientSocket, conn, host } = o;
    const px = parseProxyIp(await SEL.current(env, o.mode, conn, host, conn.cf));
    // 这里只判「没有候选」：conn.retried 为真时 onClose 已经走了 viaRelayFailed，
    // 以前写成 `!px || conn.retried` 的那半截条件永远不生效（7.169 删掉）。
    if (!px) {
      cnt("dead");
      kickFlush(env, conn.id);
      cnt("eCloseD"); // 直连空关闭：目标站的问题，不算节点
      NodeStatsTable.nsEmptyClose(conn.node, false);
      this.endClient(clientSocket, 1000, "done");
      return;
    }
    conn.retried = true;
    conn.pxTries = 1;
    // 记住"这个站必须走中转"：6 小时覆盖一次浏览会话，真变回可直连也只是多走一跳。
    // 窗口读 SC.PX_LEARN —— 7.226 之前这里内联 6 * 3600e3，judge 里另有一份 21_600_000。
    // 上限用 SC.PX_MAX：以前这里手写一段「先清过期、再删最旧一条」，而 judge 写
    // 同一张表的两条路径完全绕过了它（7.182 统一成 trimAged，按最早过期先删）。
    S.needPx.set(host, Date.now() + SC.PX_LEARN);
    trimAged(S.needPx, SC.PX_MAX);
    logErr(`empty close -> proxyip ${px.host}`, host);
    if (checkTarget(px.host, px.port)) {
      this.endClient(clientSocket, 1011, "proxyip blocked");
      return;
    }
    try {
      const s3 = await SOCKET_DIALER.open(px.host, px.port, o.budget);
      conn.node = px.host + ":" + px.port;
      conn.via = "node";
      await this.run(o, s3);
    } catch (e) {
      // 额度耗尽时 connect 根本没发出，不能把健康中继记成不可达（F1.1）
      if (isBudgetExhausted(e)) {
        this.endClient(clientSocket, 1011, "budget exhausted");
        return;
      }
      // 池子里能解析、但连不上：必须给这条中继记账，否则选择器会一直把它挑回来
      NodeStatsTable.nsFail(px.host + ":" + px.port);
      this.endClient(clientSocket, 1011, "proxyip failed");
    }
  }

}


