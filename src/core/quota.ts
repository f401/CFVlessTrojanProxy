/* 配额与订阅头：纯计算，不碰 IO */

/**
 * 功能：算有效配额：env.quotaBytes 优先，否则 1 TB；已用超过基数时按档位抬高上限。
 * @param env 环境变量
 * @param used 已用字节
 * @returns 配额字节数
 */
export function effectiveQuota(env: Env, used: number) {
  const base = Number(env.quotaBytes) > 0 ? Number(env.quotaBytes) : 1024 ** 4; // 默认 1 TB
  const u = Number(used);
  if (!Number.isFinite(u) || u <= 0) return base;
  let total = base;
  while (u >= total) total *= 2; // 不设上限，直到覆盖实际用量
  return total;
}

/**
 * 功能：生成订阅响应头（流量已用/总量、订阅到期提示）。
 * @param env 环境变量
 * @param stats 用量统计（up/down 字节）
 * @returns 可直接挂到 Response 的 Headers
 */
export function subHeaders(env: Env, stats: { up?: number; down?: number }) {
  const used = (stats.up || 0) + (stats.down || 0);
  const total = effectiveQuota(env, used);

  // expire=0 表示"无期限"。空值 / never / 0 / 非法日期 一律当无期限处理
  let exp = 0;
  const raw = String(env.expireAt || "").trim();
  if (raw && raw !== "0" && raw.toLowerCase() !== "never") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) exp = Math.floor(n);
    else {
      const t = Date.parse(raw);
      if (!Number.isNaN(t)) exp = Math.floor(t / 1000);
    }
  }
  return {
    "Subscription-Userinfo": `upload=${stats.up || 0}; download=${stats.down || 0}; total=${total}; expire=${exp}`,
    "Profile-Update-Interval": "12",
    "Profile-Title": "edge",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Access-Control-Allow-Origin": "*",
  };
}

