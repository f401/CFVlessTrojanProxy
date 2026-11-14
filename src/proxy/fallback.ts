import { connect } from "cloudflare:sockets";
import { nextNode } from "../nodes/score";
import { logErr } from "../nodes/metrics";
import { isCfIp } from "../core/net";
import { checkTarget } from "./dial";
import type { Socket } from "cloudflare:sockets";
import type { Connection } from "./connection";

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
  tag?: string | null,
  cc?: string | null,
): Promise<Socket | null> {
  let avoid = st.node;
  for (let n = 0; n < ALT_TRIES; n++) {
    const alt = nextNode(mode, avoid, cc);
    if (!alt || alt === avoid) return null;
    avoid = alt;
    const i = alt.lastIndexOf(":");
    const host = alt.slice(0, i);
    const port = Number(alt.slice(i + 1)) || 443;
    if (checkTarget(host, port)) return null; // 池子可能被污染：内网/禁用端口一律不拨
    if (st.cf && isCfIp(host)) continue; // 见上：CF 托管目标必须换到非 CF 出口
    try {
      const s = await connect({ hostname: host, port });
      st.node = alt;
      st.via = "node";
      st.pxTries = (st.pxTries || 1) + 1;
      logErr(`retry another node ${alt}`, tag || "");
      return s;
    } catch (e) {
      /* 这个节点拨不通，继续试下一个候选 */
    }
  }
  return null;
}

