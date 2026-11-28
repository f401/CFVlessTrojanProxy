import { BoundedMap } from "../core/table";

/** DO 用量读缓存与发出次数，均为本 isolate 的客户端状态。 */
export class MeterClientState {
  /** DO 调用次数（免费计划每轮子请求预算按它核） */
  calls = 0;
  /** 用量读取缓存（上限 500 条，按写入时刻淘汰） */
  cache = new BoundedMap<string, { v: UsageMeter | null; t: number }>({ max: 500, timeOf: (row) => row.t });

  /** 功能：缓存读数，容量不足只裁最旧行。@param id 用户。@param value 用量或失败。@returns 无 */
  remember(id: string, value: UsageMeter | null): void {
    this.cache.set(id, { v: value, t: Date.now() });
    this.cache.prune(Date.now(), false);
  }
}

/** 计量客户端状态所有者。 */
export const METER_CLIENT = new MeterClientState();

/* Meter DO 客户端：单次读取 + 15 秒缓存，供 stats / snapshot 共用 */

export const METER_TTL = 15000;

/**
 * 功能：发一次计量 DO 的请求，并把它记进 `METER_CLIENT.calls`。
 *
 * 为什么要有这个唯一入口：`/health` 的 `doCalls` 以前只在「用量批次推成功」那一处自增
 * （`src/store/pend.ts` 的 flush），而读用量、回填快照、读事实表这些同样是 DO 子请求 ——
 * 少数的六类路径一个都没计入，于是这个数字被当成「本 isolate 发过几次 DO 请求」来读时
 * 会小一个数量级，排障时会误判「没在打 DO」。计数点放在这里，生产路径就只有这一个。
 *
 * 计的是「发出次数」而不是「成功次数」：免费计划的子请求额度按发出算，失败也占额度。
 * 漏进来的 `try/catch`（例如 `src/store/snapshot.ts` 的 restore）里抛出也会先计入。
 * @param env 环境变量
 * @param id 用户 id（DO 名字）
 * @param url 完整端点地址（`https://meter/...`）：`tools/check-wire.mjs` 靠这个字面量判断「端点有没有调用方」
 * @param init 可选的请求参数
 * @returns DO 的响应
 */
export async function doFetch(env: Env, id: string, url: string, init?: RequestInit): Promise<Response> {
  METER_CLIENT.calls += 1;
  const stub = env.METER.get(env.METER.idFromName(id));
  return stub.fetch(url, init);
}

/**
 * 功能：从 DO 读某用户的累计用量。
 * @param env 环境变量
 * @param id 用户 id
 * @returns 用量记录或 null
 */
export async function meterGet(env: Env, id: string) {
  if (!env || !env.METER || !id) return null;
  const hit = METER_CLIENT.cache.get(id);
  if (hit) {
    // 成功缓存 15 秒；失败（v=null）只缓存 10 秒，避免 DO 抖动时每次翻页都等两次超时
    if (Date.now() - hit.t < (hit.v ? METER_TTL : 10000)) return hit.v;
  }

  for (let i = 0; i < 2; i++) {
    try {
      const r = await doFetch(env, id, "https://meter/get");
      if (!r.ok) throw new Error("do " + r.status);
      const v = await r.json();
      METER_CLIENT.remember(id, v);
      return v;
    } catch (e) {
      if (i === 0) await new Promise((res) => setTimeout(res, 120));
    }
  }
  METER_CLIENT.remember(id, hit ? hit.v : null);
  return hit ? hit.v : null;
}

