// 地理标注：批量问第三方免费接口拿两位国家码（单次最多 100 个），查不到就不打标。

import { timeoutSignal } from "../core/util";

/**
 * 批量查询 IP 归属国（第三方免费接口，单次最多 100 个）。
 * @param {string[]} ips IP 列表
 * @returns {Promise<Record<string,string>>} IP → 两位国家码
 */
export async function geoLabel(ips: string[]) {
  const out: Record<string, string> = {};
  if (!ips.length) return out;
  try {
    const r = await fetch("http://ip-api.com/batch?fields=status,countryCode", {
      signal: timeoutSignal(5000),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ips.slice(0, 100)),
    });
    if (r.ok) {
      const arr = await r.json();
      (arr as IpApiRow[]).forEach((x, i) => {
        if (x && x.status === "success" && x.countryCode) out[ips[i]] = String(x.countryCode).toUpperCase();
      });
    }
  } catch (e) {
    /* 查不到就不打标，不影响可用性 */
  }
  return out;
}
