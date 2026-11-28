/**
 * 地区面板的读模型：把「池子 + 存活表 + 质量/覆盖/连接观测 + 六张事实表」装配成展示行。
 *
 * 放在 route 层而不是 routes 层是为了解耦：路由只负责 HTTP 形状（分页、JSON、表单），
 * 装配口径（谁进表、哪几列、缓存多久）只在这里；新增一张事实表时改这一个文件即可。
 * 缓存与读模型同生共死——它缓存的正是这里算出来的行，放进 routes 会造成 route → routes 反向依赖。
 */

import { ISOLATE } from "../core/state";
import { relayIpOf, splitRelay } from "../core/relay-addr";
import { IpFamily, IpKind } from "../core/enums";
import { POOL_MEMORY } from "../px/pool-memory";
import { SEED_STORE } from "../px/seed";
import { AliveBoard } from "../px/pool";
import { QUALITY, COVERAGE, CONN_OBS } from "../px/regions";
import { EG } from "../facts/egfacts";
import { PS } from "../facts/psfacts";
import { DEAD } from "../facts/deadfacts";
import { BLK } from "../facts/blkfacts";
import { DNS } from "../facts/dnsfacts";
import type { RegionNodeRow } from "../views/regions";

/** 地区页面单槽类型化缓存；行与 JSON 分开，均允许 30 秒展示陈旧。 */
export class RegionPageCache {
  /** 节点行缓存（30 秒）：站点相关列在渲染前才补算 */
  rows: { t: number; rows: RegionNodeRow[] } | null = null;
  /** JSON 文本缓存（5 秒）：同一份结果不重复序列化 */
  json: { t: number; key: string; text: string } | null = null;
  /** 功能：在寿命内返回基础行，站点投影由调用方复制。@param now 当前时间。@returns 行或 null */
  freshRows(now: number): RegionNodeRow[] | null {
    return this.rows && now - this.rows.t < 30000 ? this.rows.rows : null;
  }
  /** 功能：按目标与条数命中序列化缓存。@param key 请求键。@param now 当前时间。@returns JSON 或 null */
  freshJson(key: string, now: number): string | null {
    return this.json && this.json.key === key && now - this.json.t < 30000 ? this.json.text : null;
  }
}
/** 地区展示缓存所有者，不保存用户上下文或口令。 */
export const REGION_CACHE = new RegionPageCache();

/**
 * 功能：把 host 归到地址族（字面量 IPv6 带冒号，其余按 v4）。
 * @param h 主机（IP 字面量或域名）
 * @returns 地址族枚举
 */
export function familyOf(h: string): IpFamily {
  return h.includes(":") ? IpFamily.IPv6 : IpFamily.IPv4;
}

/**
 * 功能：把 seed 的 byColo 分桶摊平成 `key → 国家码` 的映射（跨 isolate 的已知节点）。
 * @returns key 到 cc 的表
 */
function seedNodes(): Map<string, string> {
  const out = new Map<string, string>();
  const byColo = (SEED_STORE.document && SEED_STORE.document.byColo) || {};
  for (const [cc, bucket] of Object.entries(byColo)) {
    for (const n of bucket?.nodes || []) {
      const k = n.k || `${n.h}:${n.p}`;
      if (!out.has(k)) out.set(k, String(n.cc || cc).toUpperCase());
    }
  }
  return out;
}

/**
 * 功能：拼出全部节点行（alive ∪ seed），按「质量等级 → 国家码 → key」稳定排序。
 * @param target 目标站点（空 = 不算 RTT）
 * @returns 展示行数组
 */
export function buildPanelRows(): RegionNodeRow[] {
  // 重建 1600 行 + ICU 排序逼近 10ms CPU（TTL 到期即 1102）；缓存 30 秒、命中只看寿命，后台 probe 改 alive 不重建动失效）。
  const now = Date.now();
  let rows = REGION_CACHE.freshRows(now);
  if (!rows) {
    const alive = new AliveBoard().list();
    const seeds = seedNodes();
    const keys = [...new Set([...alive.map((n) => `${n.h}:${n.p}`), ...seeds.keys(), ...POOL_MEMORY.rows.map((x) => `${x.h}:${x.p}`)])];
    // alive 上限 800，逐 key find() 是 64 万次拼接；Map 压成 O(n)。
    const liveByKey = new Map<string, (typeof alive)[number]>(alive.map((n) => [`${n.h}:${n.p}`, n]));
    rows = keys.map((key) => {
      const [h, p] = splitRelay(key, 443), ip = h, seedCc = seeds.get(key) || "", live = liveByKey.get(key);
      const q = QUALITY.getFor(h, p, now), cov = COVERAGE.rows.get(key), isoCc = QUALITY.getIso(h);
      return {
        key,
        country: String(isoCc || live?.cc || seedCc || "").toUpperCase(),
        family: familyOf(h),
        alive: !!live,
        source: live && seedCc ? "alive+seed" : live ? "alive" : "seed",
        kind: q?.kind ?? IpKind.Unknown,
        level: q?.level ?? "normal",
        proxy: q?.proxy ?? false,
        vpn: q?.vpn ?? false,
        org: q?.org || "",
        reach: 0,
        probed: !!cov || !!q,
        rtt: null,
        egFamily: EG.famOf(ip, now),
        psOk: -1,
        dead: DEAD.isDead(ip, now),
        blkPenalty: 1,
        dnsV6: -1,
      } as RegionNodeRow;
    });
    // 已探测在前，再按质量等级 → 国家 → key 排序。
    const rank: Record<string, number> = { good: 0, normal: 1, risky: 2 };
    rows.sort(
      (a, b) =>
        Number(b.probed) - Number(a.probed) ||
        Number(b.alive) - Number(a.alive) ||
        (rank[a.level] ?? 3) - (rank[b.level] ?? 3) ||
        (a.country < b.country ? -1 : a.country > b.country ? 1 : 0) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    REGION_CACHE.rows = { t: now, rows };
  }
  return rows;
}

/** 功能：给要渲染的那几行补上站点相关列；@param rows 切片后的行；@param target 站点；@returns 同一批行 */
export function decoratePanelRows(rows: RegionNodeRow[], target: string): RegionNodeRow[] {
  // 只补切片：整表 1600 行 × 5 次查表就是 1102 的来源之一
  const now = Date.now();
  const coloNow = ISOLATE.colo || "??";
  const v6 = target ? DNS.v6Of(target, now) : -1;
  // 基础行由缓存共享；派生站点字段写入新对象，避免本次展示污染下一次请求。
  return rows.map((r) => {
    const ip = relayIpOf(r.key);
    const reachRow = CONN_OBS.get(coloNow, r.key, "@reach", now);
    return { ...r, reach: reachRow ? (reachRow.ok ? 1 : -1) : 0,
      rtt: target ? CONN_OBS.rttOf(coloNow, r.key, target, now) : null,
      psOk: target ? PS.okOf(target, ip, now) : -1,
      blkPenalty: target ? BLK.penOf(target, ip, now) : 1, dnsV6: v6 };
  });
}
