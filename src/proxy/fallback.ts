import { connect } from "cloudflare:sockets";
import { nextNode } from "../nodes/score";
import { logErr } from "../nodes/metrics";
import { checkTarget } from "./dial";
import type { Socket } from "cloudflare:sockets";
import type { Connection } from "./connection";

/**
 * 功能：换一个节点再拨一次（首包失败后的兜底，跳过刚失败的那个）。
 * @param env 环境变量
 * @param host 目标主机
 * @param port 目标端口
 * @param skip 要跳过的节点键
 * @returns socket；无可用节点返回 null
 */
export async function dialAnother(
  _env: Env,
  st: Connection,
  mode: Mode,
  tag?: string | null,
  cc?: string | null,
): Promise<Socket | null> {
  const alt = nextNode(mode, st.node, cc);
  if (!alt) return null;
  const i = alt.lastIndexOf(":");
  const host = alt.slice(0, i);
  const port = Number(alt.slice(i + 1)) || 443;
  if (checkTarget(host, port)) return null; // 池子可能被污染：内网/禁用端口一律不拨
  try {
    const s = await connect({ hostname: host, port });
    st.node = alt;
    st.via = "node";
    st.pxTries = (st.pxTries || 1) + 1;
    logErr(`retry another node ${alt}`, tag || "");
    return s;
  } catch (e) {
    return null;
  }
}

