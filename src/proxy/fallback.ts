import { connect } from "cloudflare:sockets";
import { nextNode, nsFail } from "../nodes/score";
import { CONNECT_MS, withTimeout } from "../core/util";
import { logErr } from "../nodes/metrics";
import { isCfIp } from "../core/net";
import { checkTarget } from "./dial";
import { HOOK } from "../core/hook";
import type { Socket } from "cloudflare:sockets";
import type { Connection } from "./connection";
import { splitRelay } from "../core/http80";

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
    const [host, port] = splitRelay(alt, 443);
    // 池子可能被污染：内网/禁用端口一律不拨。这里是 continue 不是 return ——
    // 一条被污染的条目不该让整条补救链放弃（调用方回落到直连，等于白丢这次请求）。
    if (checkTarget(host, port)) continue;
    if (st.cf && isCfIp(host)) continue; // 见上：CF 托管目标必须换到非 CF 出口
    // 与主路径（Dialer.open → Selector.current → HOOK.chanPref）同一个口径：这个站点到这个中继
    // 已经被实测判为封锁的，别再花 2.5 秒拨一次 —— 走到补救链时客户端已经等了两三秒。
    if (HOOK.chanPref && HOOK.chanPref(host, st.host) === 2) continue;
    // 与 Dialer.open 的主路径同一个口径：connect() 自己没有超时，挂死的中继会把请求拖到
    // 客户端放弃为止。补救链更怕这个——走到这里时客户端已经等了两三秒。
    const pk = Promise.resolve(connect({ hostname: host, port }));
    try {
      const s = await withTimeout(pk, CONNECT_MS);
      st.node = alt;
      st.via = "node";
      st.pxTries = (st.pxTries || 1) + 1;
      logErr(`retry another node ${alt}`, tag || "");
      return s;
    } catch (e) {
      // 超时之后 connect 仍可能迟到成功：不关掉就会把免费计划的 6 个并发名额慢慢吃掉。
      void pk.then((s) => { try { s.close(); } catch { /* 已经被关掉了 */ } }).catch(() => { /* 本来就没连上 */ });
      nsFail(alt); // 这条候选连不上：冷却它，下一轮别再挑回来
    }
  }
  return null;
}

