import { errMsg } from "../core/util";

import { S } from "../core/state";
import { seal, unseal } from "./crypto";
import { flushSnap } from "./snapshot";

/* KV 读写：所有 KV 访问的唯一入口 */

export async function kvGet<T = unknown>(env: Env, key: string): Promise<T | null> {
  if (!env || !env.STATS) return null;
  let raw = null;
  try {
    raw = await env.STATS.get(key);
  } catch (e) {
    return null;
  }
  return (await unseal(env, raw)) as T | null;
}

export async function kvSet(env: Env, key: string, obj: unknown, opts?: { expirationTtl?: number }): Promise<void> {
  return kvPut(env.STATS, key, await seal(env, obj), opts);
}

export async function kvPut(kv: KVNamespace, key: string, val: string, opts?: { expirationTtl?: number }) {
  // 10048 = 当日写额度耗尽。既然写不进去，10 分钟内别再试，
  // 免得每个连接都白跑一次 KV 调用并刷日志。
  // 注意：熔断期必须"抛错"而不是静默返回 —— 调用方（flushSnap 等）
  // 是靠 catch 判断写失败的，静默返回会让它以为写成功，直接把内存里的
  // 统计清空，配额耗尽期间的数据就真丢了。
  if (S.kvStat && S.kvStat.quota && Date.now() - (S.kvStat.quotaAt || 0) < 10 * 60000) {
    const e = new Error("kv quota breaker: " + key);
    (e as Error & { breaker?: boolean }).breaker = true;
    throw e;
  }
  S.kvw += 1;
  try {
    await kv.put(key, val, opts);
    S.kvStat = { ok: true, key, at: Date.now() };
  } catch (e) {
    // 10048 = 当日写入额度耗尽；此时所有改动只在内存里生效，必须让调用方知道
    const emsg = String(errMsg(e));
    S.kvStat = {
      ok: false,
      key,
      at: Date.now(),
      err: emsg.slice(0, 100),
      quota: /10048|quota|limit/i.test(emsg),
      quotaAt: Date.now(),
    };
    throw e;
  }
}
