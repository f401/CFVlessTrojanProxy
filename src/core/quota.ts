
/* 配额与订阅头：纯计算，不碰 IO */

export function effectiveQuota(env: Env, used: any) {
  const base = Number(env.quotaBytes) > 0 ? Number(env.quotaBytes) : 1024 ** 4;  // 默认 1 TB
  const u = Number(used);
  if (!Number.isFinite(u) || u <= 0) return base;
  let total = base;
  while (u >= total) total *= 2;     // 不设上限，直到覆盖实际用量
  return total;
}

export function subHeaders(env: Env, stats: any) {
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
