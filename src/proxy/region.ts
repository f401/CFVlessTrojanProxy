import type { Socket } from "cloudflare:sockets";
import type { Connection } from "./connection";
import { STATS } from "../nodes/stat";
import { SOCKET_DIALER } from "./socket-dialer";
import { SEL } from "../px/selector";
import { checkTarget } from "./dial";

export interface RegionOpts {
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
      const sock = await SOCKET_DIALER.open(p.h, p.p);
      conn.via = "node";
      conn.retried = true;
      return sock;
    } catch {
      // 同国家再试一个，仍然失败就结束（不跨地区）
      STATS.nsFail(conn.node); // 冷却坏节点，否则下一条连接还会撞同一个
      failed = conn.node;
      const alt = await SEL.region(env, region, mode, conn.node);
      if (alt && !checkTarget(alt.h, alt.p)) {
        conn.node = alt.h + ":" + alt.p;
        try {
          const sock2 = await SOCKET_DIALER.open(alt.h, alt.p);
          conn.via = "node";
          conn.retried = true;
          return sock2;
        } catch {
          // 这一条也失败：落到下面的“都没有可用节点”分支
        }
      }
      // 只在换了节点才再罚一次：没有备选时 conn.node 还是刚罚过的那一个，
      // 再调一次 nsFail 会让它的 streak 跳两档（小池子里一节冷却直接变成十分钟）。
      if (conn.node && conn.node !== failed) STATS.nsFail(conn.node);
      onFail(`地区 ${region} 节点连接失败`);
      return null;
    }
  }
}

