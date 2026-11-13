// proxy 侧的决策入口：只依赖 core 的 HOOK，不反向依赖 route。
import { HOOK } from "../core/hook";

/** 返回「这一条连接要不要走中继」。apply = 策略是否生效（否则只做影子统计） */
/** 返回「这一条连接要不要走中转」。level = 策略生效级别：0 只影子统计、1 只硬规则、2 全生效。 */
export function pxDecision(request: Request, host: string, cfHost: boolean, wantPx: boolean, level: number): boolean {
  const fn = HOOK.decide;
  if (!fn) return wantPx;
  const cip = request.headers.get("cf-connecting-ip") || "";
  const out = fn({ host, cfHost, clientV6: cip.includes(":"), legacyWantsRelay: wantPx });
  const hard = out.why === "v6-cf" || out.why === "v6-cf-none";
  const on = level >= 2 || (level >= 1 && hard);
  return on ? out.via === "r" : wantPx;
}
