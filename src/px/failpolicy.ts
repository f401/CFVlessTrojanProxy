// 失败阈值策略：连续失败几次判坏、失败到几次无视驻留时间强制换（都可用 env 覆盖）。


// 换节点策略（可用环境变量覆盖；驻留时间见 selector.dwellOf）
//   pxFailMax  : 连续失败多少次才允许换（默认 3）
//   pxForceAt  : 失败到这个数就无视驻留强制换（默认 5）
/**
 * 读取失败阈值策略（可用 env 覆盖）。
 * @param {object} env Worker 环境
 * @returns {{fail:number, force:number}} 失败阈值、强制换阈值
 */
export function pxPolicy(env: Env) {
  const f = Number(env.pxFailMax);
  const x = Number(env.pxForceAt);
  return {
    fail: Number.isFinite(f) && f > 0 ? f : 3,
    force: Number.isFinite(x) && x > 0 ? x : 5,
  };
}
