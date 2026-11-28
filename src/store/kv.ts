import { errMsg } from "../core/util";

/** KV 写入观测与额度冷却；只记录本 isolate 的写请求结果。 */
export class KvWriteState {
  /** 累计 KV 写次数（诊断：免费计划每天有额度） */
  writes = 0;
  /** 最近一次写的结果：ok=null 表示还没写过；quota=true 表示配额耗尽（`quotaAt` 起冷却） */
  status: { ok: boolean | null; key: string; at: number; err?: string; quota?: boolean; quotaAt?: number } = { ok: null, key: "", at: 0 };
}

/** KV 写入状态所有者。 */
export const KV_WRITES = new KvWriteState();
import { seal, unseal } from "./crypto";

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

/**
 * 严格读取：KV 读失败时抛错，而不是伪装成"空值"。
 * 落盘前必须先读旧值（seed / snap）：读失败就当空对象再写，会把别的
 * isolate 的数据整份覆盖掉，所以这两处必须能区分"空"和"读不到"。
 */
export async function kvGetStrict<T = unknown>(env: Env, key: string): Promise<T | null> {
  if (!env || !env.STATS) return null;
  const raw = await env.STATS.get(key);
  if (raw == null) return null;
  const val = (await unseal(env, raw)) as T | null;
  // 有原始值却解不出来（损坏 / KEK 变了）：当成读失败，别让调用方拿空表覆盖
  if (val == null) throw new Error("kv unseal failed: " + key);
  return val;
}

/** 功能：kvSet 是薄包装，直接委托 kvPut。@param env Env。@param key string。@param obj unknown。@param opts? { expirationTtl?: number }。@returns 转发 kvPut 的返回值（Promise<void>） */
export async function kvSet(env: Env, key: string, obj: unknown, opts?: { expirationTtl?: number }): Promise<void> {
  return kvPut(env.STATS, key, await seal(env, obj), opts);
}

/**
 * 功能：写 KV（吞掉异常，KV 故障不能让请求失败）。
 * @param kv KV 绑定
 * @param key 键
 * @param val 字符串值
 * @param opts 可选 TTL
 * @returns 无
 */
export async function kvPut(kv: KVNamespace, key: string, val: string, opts?: { expirationTtl?: number }) {
  // 10048 = 当日写额度耗尽。既然写不进去，10 分钟内别再试，
  // 免得每个连接都白跑一次 KV 调用并刷日志。
  // 注意：熔断期必须"抛错"而不是静默返回 —— 调用方（flushSnap 等）
  // 是靠 catch 判断写失败的，静默返回会让它以为写成功，直接把内存里的
  // 统计清空，配额耗尽期间的数据就真丢了。
  if (KV_WRITES.status && KV_WRITES.status.quota && Date.now() - (KV_WRITES.status.quotaAt || 0) < 10 * 60000) {
    const e = new Error("kv quota breaker: " + key);
    (e as Error & { breaker?: boolean }).breaker = true;
    throw e;
  }
  KV_WRITES.writes += 1;
  try {
    await kv.put(key, val, opts);
    KV_WRITES.status = { ok: true, key, at: Date.now() };
  } catch (e) {
    // 10048 = 当日写入额度耗尽；此时所有改动只在内存里生效，必须让调用方知道
    const emsg = String(errMsg(e));
    KV_WRITES.status = {
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

