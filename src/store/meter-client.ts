import { S } from "../core/state";

/* Meter DO 客户端：单次读取 + 15 秒缓存，供 stats / snapshot 共用 */

export const METER_TTL = 15000;

export async function meterGet(env: Env, id: string) {
  if (!env || !env.METER || !id) return null;
  const hit = S.meterCache.get(id);
  if (hit) {
    // 成功缓存 15 秒；失败（v=null）只缓存 10 秒，避免 DO 抖动时每次翻页都等两次超时
    if (Date.now() - hit.t < (hit.v ? METER_TTL : 10000)) return hit.v;
  }

  for (let i = 0; i < 2; i++) {
    try {
      const stub = env.METER.get(env.METER.idFromName(id));
      const r = await stub.fetch("https://meter/get");
      if (!r.ok) throw new Error("do " + r.status);
      const v = await r.json();
      if (S.meterCache.size > 500) S.meterCache.clear();
      S.meterCache.set(id, { v, t: Date.now() });
      return v;
    } catch (e) {
      if (i === 0) await new Promise((res) => setTimeout(res, 120));
    }
  }
  if (S.meterCache.size > 500) S.meterCache.clear();
  S.meterCache.set(id, { v: hit ? hit.v : null, t: Date.now() });
  return hit ? hit.v : null;
}
