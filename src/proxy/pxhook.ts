// proxy 侧的决策入口：只依赖 core 的 HOOK，不反向依赖 route。
import { HOOK } from "../core/hook";

/** 返回「这一条连接要不要走中转」。level = 策略生效级别：0 只影子统计、1 只硬规则、2 全生效。 */
export function pxDecision(request: Request, host: string, cfHost: boolean, wantPx: boolean, level: number, mode = "tput"): boolean {
  const fn = HOOK.decide;
  if (!fn) return wantPx;
  const cip = request.headers.get("cf-connecting-ip") || "";
  // ?fx=none|all|eg,ps —— 只改这一条连接的事实开关，用来在同一条命令内交替做配对测量
  const fx = new URL(request.url).searchParams.get("fx");
  const facts = fx !== null && HOOK.factsFor ? HOOK.factsFor(fx) : HOOK.facts ? HOOK.facts() : undefined;
  const out = fn({ host, cfHost, clientV6: cip.includes(":"), legacyWantsRelay: wantPx, mode, facts });
  const hard =
    out.why === "v6-cf" ||
    out.why === "v6-cf-none" ||
    out.why === "http403" ||
    out.why === "http200" ||
    out.why === "dir-blocked" || out.why === "explore";
  // CF 托管目标（x.com 这类）：直连与 CF 中继都是 CF→CF，客户端出口原样透传，
  // 只有非 CF 主机能改判。**只在判定层自己选了中继时**才把它硬生效：
  // 无条件的 `return true` 会把判定层的 `direct-ok` 一起盖掉 —— 那条分支要的证据是
  // 「隧道直连 5 分钟内真出过整页」（`vOk(host,"d")` + `vAt`），比任何静态规则都硬，
  // 而本地配对实测中继比直连差 4 个百分点（直连 30/30 vs 中继 26/30）。
  // 同一条件也放过 `http200` 与 `v6-cf-none`（没有中继候选可挑时直连是唯一的出口），
  // 但它们本来就不在 `hard` 里，所以只在 level === 2 时生效（level 1 只改硬规则）。
  if (cfHost && level >= 1 && out.via === "r") {
    return true;
  }
  const on = level >= 2 || (level >= 1 && hard);
  return on ? out.via === "r" : wantPx;
}

