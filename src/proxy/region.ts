import type { Socket } from "cloudflare:sockets";
import { connect } from "cloudflare:sockets";
import type { Connection } from "./connection";
import { nsFail } from "../nodes/stat";
import { SEL } from "../px/selector";
import { checkTarget } from "./dial";

export interface RegionOpts {
  env: Env;
  mode: Mode;
  /** 目标国家/地区码（?rg=xx），是硬要求：绝不跨地区回落 */
  region: string;
  st: Connection;
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
    const { env, mode, region, st, onFail } = o;
    const p = await SEL.region(env, region, mode);
    if (!p) {
      onFail(`地区 ${region} 暂无可用节点`);
      return null;
    }
    st.node = p.h + ":" + p.p;
    if (checkTarget(p.h, p.p)) {
      onFail(`地区 ${region} 节点地址被策略禁止`);
      return null;
    }
    try {
      const sock = await connect({ hostname: p.h, port: p.p });
      st.via = "node";
      st.retried = true;
      return sock;
    } catch {
      // 同国家再试一个，仍然失败就结束（不跨地区）
      nsFail(st.node); // 冷却坏节点，否则下一条连接还会撞同一个
      const alt = await SEL.region(env, region, mode, st.node);
      if (alt && !checkTarget(alt.h, alt.p)) {
        st.node = alt.h + ":" + alt.p;
        try {
          const sock2 = await connect({ hostname: alt.h, port: alt.p });
          st.via = "node";
          st.retried = true;
          return sock2;
        } catch {
          /* 落到下面的失败处理 */
        }
      }
      nsFail(st.node);
      onFail(`地区 ${region} 节点连接失败`);
      return null;
    }
  }
}

/** 进程内唯一实例 */
export const REGION = new RegionPicker();
