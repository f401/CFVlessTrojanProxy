// proxy 侧的决策入口：只依赖 core 的 HOOK，不反向依赖 route。
import { HOOK } from "../core/hook";

/** 返回「这一条连接要不要走中继」。apply = 策略是否生效（否则只做影子统计） */
/** 返回「这一条连接要不要走中转」。level = 策略生效级别：0 只影子统计、1 只硬规则、2 全生效。 */
export function pxDecision(request: Request, host: string, cfHost: boolean, wantPx: boolean, level: number): boolean {
  const fn = HOOK.decide;
  if (!fn) return wantPx;
  const cip = request.headers.get("cf-connecting-ip") || "";
  const out = fn({ host, cfHost, clientV6: cip.includes(":"), legacyWantsRelay: wantPx });
  const hard =
    out.why === "v6-cf" ||
    out.why === "v6-cf-none" ||
    out.why === "http403" ||
    out.why === "http200" ||
    out.why === "dir-blocked";
  // CF 托管目标（x.com 这类）：直连与 CF 中继都是 CF→CF，客户端出口原样透传，
  // 只有非 CF 主机能改判。这一条不需要任何学习/池子信息，先让它硬生效，
  // 中继选不出来时 session 会自己回落直连（不会把请求卡死）。
  if (cfHost && level >= 1) {
    return true;
  }
  const on = level >= 2 || (level >= 1 && hard);
  return on ? out.via === "r" : wantPx;
}
