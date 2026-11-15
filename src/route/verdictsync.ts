// 判定表的跨 isolate 同步：只同步「强证据」（blocked/dead），带 30 分钟 TTL。
// 目标 isolate 冷启动时拉一次，之后靠本地的记录增量回传，避免每请求都读 DO。
import { S } from "../core/state";
import { vAll, vImport } from "./verdict";
import { HEALTH } from "./relay-health";
import { FACTS } from "./factsstore";
import { EG } from "./egfacts";
import type { EgRow } from "./egfacts";
import { cnt } from "../core/counter";

export interface VtRow {
  k: string; // `target|chan`
  s: number; // state
  t: number; // 到期时间
}

/** 自上次上报以来新学到的强证据（只发增量） */
export function vtDelta(): VtRow[] {
  const out: VtRow[] = [];
  const now = Date.now();
  // 上次交出去、还没 ack 的强证据：原样再带上（DO 可能没收到）
  for (const [k, t] of S.vtPend) {
    const bar = k.indexOf("|");
    if (bar <= 0 || t <= now) continue;
    out.push({ k, s: 2, t });
  }
  for (const v of vAll()) {
    if (v.state < 2) continue;
    // 表里不可能再有通配行：写入入口（`VerdictTable.blockWild`）直接拒绝 `*`。
    // 站点级证据（`站点|通道`）照旧同步 —— 那才是「这个站点这条通道被封」的可信事实。
    const k = v.t + "|" + v.c;
    const exp = v.at + 1800000;
    if (exp <= now) continue;
    if ((S.vtSent.get(k) || 0) >= exp) continue;
    if ((S.vtPend.get(k) || 0) >= exp) continue;
    // 只登记 pending：DO 没收到时由调用方 nack，下轮还能再发一次
    S.vtPend.set(k, exp);
    out.push({ k, s: v.state, t: exp });
    if (out.length >= 60) break;
  }
  if (out.length) cnt("vtSent", out.length);
  return out;
}


/** 上报成功：pending 正式生效 */
export function vtAck(): void {
  for (const [k, exp] of S.vtPend) S.vtSent.set(k, exp);
  S.vtPend.clear();
}

/** 上报失败：丢掉 pending，下一轮重新登记 */
export function vtNack(): void {
  S.vtPend.clear();
}
/**
 * 功能：冷启动拉一次远端事实（失败静默：判定表本来就是「本 isolate 先信自己」）。
 * 两条并发纪律：
 * - single-flight：旧实现是「先同步置 `vtLoaded` 再 await」，于是同一波次里只有第 1 条连接真的在读，
 *   其余全部空手返回 —— DO 读确实只有 1 次，但代价是 19 条连接在冷启动时盲选（实测首次请求 40% 对 40%）。
 *   现在后到者等同一个 Promise（调用方用 200ms 上限，不会拖住首字节），换来同波次都有事实可用。
 * - colo 缓存：同一 POP 的多个 isolate 共享 90 秒快照，命中率 ≈ 1−e^(−λ·TTL/60)
 *   （λ=0.5/分、TTL=120s 时 63%，λ=2 时 86%），低流量下把「冷 isolate 只能盲选」的窗口压到十几次请求。
 * @param env 环境绑定
 * @returns {Promise<void>} 读完 resolve（失败也 resolve）
 */
export async function vtLoad(env: Env): Promise<void> {
  if (S.vtLoaded) return;
  // 失败后 60 秒内不重试（一次抖动不该让首字节为坏运气反复排队），过期后允许再试一次
  if (S.vtCool > Date.now()) return;
  if (S.vtFlight) {
    cnt("factsJoin");
    return S.vtFlight;
  }
  S.vtFlight = vtFetch(env);
  return S.vtFlight;
}

/** 远端事实的响应体形状（五种事实 + 判定表 + 中继健康度） */
interface FactsBody {
  vt?: VtRow[];
  hl?: Array<{ i: string; o: number; b: number; d: number }>;
  eg?: EgRow[];
  ps?: Array<{ k: string; q: number; n: number; at: number }>;
  dead?: Array<{ i: string; n: number; at: number }>;
  blk2?: Array<{ k: string; n: number; at: number }>;
}

/**
 * 功能：真正的一次读取（single-flight 的内核）—— 先看 colo 缓存，未命中再问 DO，并顺手回写缓存。
 * @param env 环境绑定
 * @returns {Promise<void>} 无返回值
 */
async function vtFetch(env: Env): Promise<void> {
  try {
    const ckey = new Request("https://facts.internal/meter/vt?u=" + encodeURIComponent(String(env.uuid || env.uuids || "")));
    // Workers 的 `caches.default` 不在默认 TS lib 里，用结构化类型声明，避免为它引 dom 类型
    const cs = (globalThis as unknown as {
      caches?: { default?: { match: (r: Request) => Promise<Response | undefined>; put: (r: Request, x: Response) => Promise<void> } };
    }).caches;
    const cache = cs && cs.default ? cs.default : null;
    let jj: FactsBody | null = null;
    if (cache) {
      const hit = await cache.match(ckey);
      if (hit) {
        jj = (await hit.json()) as FactsBody;
        cnt("factsCacheHit");
      }
    }
    if (!jj) {
      const raw = String(env.uuid || env.uuids).split(",")[0].trim().toLowerCase();
      const rr = await env.METER.get(env.METER.idFromName(raw)).fetch("https://meter/vt");
      jj = (await rr.json()) as FactsBody;
      cnt("factsDo");
      // 回写缓存不阻塞连接：写失败（无 Cache API / 配额）也不影响本次结果
      if (cache) void cache.put(ckey, new Response(JSON.stringify(jj), { headers: { "cache-control": "max-age=90" } })).catch(() => {});
    }
    if (Array.isArray(jj.vt)) {
      // 过滤掉历史版本外发出去的通配封锁：它们已经在别的 isolate 里造成过大面积误封，重新导入只会复发。
      const rows = jj.vt.filter((r) => !r.k.startsWith("*|"));
      vImport(rows);
      cnt("vtDO", rows.length);
    }
    if (Array.isArray(jj.hl)) HEALTH.merge(jj.hl);
    // 只有真的拿到 DO 的回答才算「读过」：否则失败的 isolate 会一直带着空事实选路
    S.vtLoaded = true;
    const nf = FACTS.load(jj);
    cnt("egDO", nf.eg);
    cnt("psDO", nf.ps);
    cnt("deadDO", nf.dead);
    cnt("blkDO", nf.blk2);
    cnt("dnsDO", nf.dns);
  } catch {
    // 读不到就当作没有事实（不阻塞连接），但记下冷却时间，60 秒后允许重试
    S.vtCool = Date.now() + 60000;
  } finally {
    // 订阅层（views）不能 import route，所以把「哪些中继已知是 v4 出口」放进 S，供渲染直接取用
    S.eg4Top = EG.v4List().slice(0, 8);
    S.vtFlight = null;
  }
}
