import type { Socket } from "cloudflare:sockets";
import type { Connection } from "./connection";
import { NodeStatsTable } from "../nodes/stat";
import { SOCKET_DIALER } from "./socket-dialer";
import type { BudgetedIO } from "../core/budgeted-io";
import { SEL } from "../px/selector";
import { checkTarget } from "./dial";
import { aliveList } from "../px/pool";
import { keyOf } from "../px/const";
import { splitRelay } from "../core/relay-addr";
import { isBlack, isFrozen } from "../nodes/score";

interface RegionOpts {
  /** 本次请求的额度：地区分流同样要从两个出口取号 */
  budget: BudgetedIO;
  env: Env;
  mode: Mode;
  /** 目标国家/地区码（?rg=xx），是硬要求：绝不跨地区回落 */
  region: string;
  conn: Connection;
  /** 明确失败时由调用方负责关连接/计数（这里只报告原因） */
  onFail: (msg: string) => void;
}

/**
 * 地区分流（P5-2）：`?rg=xx` 是硬要求，只允许该国节点。
 * 找不到 / 连不上就明确失败，绝不回落到直连或全球节点 —— 否则用户拿到的不是该国 IP。
 */
export class RegionPicker {
  /**
   * 打开一条「该国中转」连接；同国再试一次仍失败就返回 null（已调用 onFail）。
   */
  async open(o: RegionOpts): Promise<Socket | null> {
    const { env, mode, region, conn, onFail } = o;
    const p = await SEL.region(env, region, mode);
    if (!p) {
      onFail(`地区 ${region} 暂无可用节点`);
      return null;
    }
    conn.node = p.h + ":" + p.p;
    if (checkTarget(p.h, p.p)) {
      onFail(`地区 ${region} 节点地址被策略禁止`);
      return null;
    }
    let failed = ""; // 已经记过失败的那个节点：同一次失败只罚一次
    // 建连预算与「迟到关闭」都交给 SOCKET_DIALER（与 Dialer.open 同一个口径）
    try {
      const sock = await SOCKET_DIALER.open(p.h, p.p, o.budget);
      conn.via = "node";
      conn.retried = true;
      return sock;
    } catch {
      // 同国家再试一个，仍然失败就结束（不跨地区）
      NodeStatsTable.nsFail(conn.node); // 冷却坏节点，否则下一条连接还会撞同一个
      failed = conn.node;
      const alt = await SEL.region(env, region, mode, conn.node);
      if (alt && !checkTarget(alt.h, alt.p)) {
        conn.node = alt.h + ":" + alt.p;
        try {
          const sock2 = await SOCKET_DIALER.open(alt.h, alt.p, o.budget);
          conn.via = "node";
          conn.retried = true;
          return sock2;
        } catch {
          // 这一条也失败：落到下面的“都没有可用节点”分支
        }
      }
      // 只在换了节点才再罚一次：没有备选时 conn.node 还是刚罚过的那一个，
      // 再调一次 nsFail 会让它的 streak 跳两档（小池子里一节冷却直接变成十分钟）。
      if (conn.node && conn.node !== failed) NodeStatsTable.nsFail(conn.node);
      onFail(`地区 ${region} 节点连接失败`);
      return null;
    }
  }

  /**
   * 功能：拨一条用户明确钉住的节点（`?node=host:port`），硬失败不回落。
   *
   * 为什么独立成方法：钉节点是「我要的就是这一条」——节点不在存活表/被黑或冻结/连不上，
   * 都明确失败，绝不换别的节点或回落直连（用户拍板的语义）。与 `?rg=` 的地区硬分流同源，
   * 但校验更严（必须精确匹配 key，不做同国补救）。
   * @param env Worker 环境（查存活表用）
   * @param node 节点 key（`host:port`）
   * @param conn 连接状态（成功时写 node/via/retried）
   * @param budget 本次调用的额度闸门
   * @param onFail 明确失败时的回调（由会话关连接/记账）
   * @returns socket 或 null（已调用 onFail）
   */
  async openPinned(env: Env, node: string, conn: Connection, budget: BudgetedIO, onFail: (msg: string) => void): Promise<Socket | null> {
    const list = await aliveList(env);
    const hit = list.find((x) => keyOf(x) === node);
    // ?node=host:port 本身就是完整的拨号目标；面板勾选来自 alive∪seed∪pool，后两者
    // 可能不在本 isolate 的存活表里，直接按 key 解析出来拨，不再误报「不在存活表」。
    const [host, port] = hit ? [hit.h, hit.p] : splitRelay(node, 443);
    if (!host || port <= 0) {
      onFail(`节点 ${node} 地址无效`);
      return null;
    }
    const k = hit ? keyOf(hit) : node;
    if (isBlack(k) || isFrozen(k) || checkTarget(host, port)) {
      onFail(`节点 ${node} 被封禁或地址不允许`);
      return null;
    }
    conn.node = k;
    try {
      const sock = await SOCKET_DIALER.open(host, port, budget);
      conn.via = "node";
      conn.retried = true;
      return sock;
    } catch {
      NodeStatsTable.nsFail(k);
      onFail(`节点 ${node} 连接失败`);
      return null;
    }
  }
}

