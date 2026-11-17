// 从 `Env` 里读配置的两个口子（密码绑定、影子流量比例）。
// 单独成文件的原因：它们都带「历史绑定名 / 非法值回落」这类必须解释的规则，混进通用工具里没人会读。
import { P_T } from "./proto-names";

// 密码绑定的读取：优先 env.pwd（中性名），兼容老的 env[P_T]（历史绑定名见 P_T 的构造）。
// `Env` 故意没有索引签名（见 types/env.d.ts 末尾说明），所以这条历史别名必须显式转型取，
// 而不是靠 `env[P_T]` 从索引签名里混过去 —— 那个签名会让所有拼错的绑定名一起编译通过。
export const secretPwd = (env: Env) => {
  const legacy = (env as unknown as Record<string, unknown>)[P_T];
  return String((env && (env.pwd || legacy)) || "").trim();
};

/**
 * 影子流量默认比例（`env.pxShadow` 没配时用它）。
 * 这里**不**做「样本不足就抬比例」：探索由单层抽样自己负责（样本少 ⇒ 乐观面大 ⇒ 天然被抽），
 * 比例只决定「给站点画像补样本」的那点点流量。
 */
export const SHADOW_DEFAULT = 0.05;

/**
 * 解析 pxShadow。三处（选择器 / 控制器 / /proxyip）必须用同一套规则，
 * 否则会出现「面板写一个数、实际跑另一个数」的老毛病（7.x 之前就踩过）。
 *   未设置 / 非数字 → 默认 5%
 *   0            关闭探索（面板也显示 0%，两边一致）
 *   >1            按 1 处理（不放大）
 */
export function shadowRate(env: Env) {
  const raw = env ? env.pxShadow : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === "") return SHADOW_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SHADOW_DEFAULT;
  return Math.min(1, n);
}
