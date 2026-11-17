// 池子从哪来：公开源清单、去重解析、逐源抓取，以及「哪个源该排到最后」的健康度。
// 这一层只管「拿到候选名单」，探活（能不能真的中转）在 ./rawprobe，地理标注在 ./geo。

import { logErr } from "../nodes/metrics";
import { cnt } from "../core/counter";
import { checkTarget } from "../core/net";
import { timeoutSignal } from "../core/util";

// 额外候选主机（不是列表，是"池域名"，解析后是多台机器）
export const EXTRA_HOSTS = ["pyip.ygkkk.dpdns.org"];

// 候选池来源（按价值排序；单源失败不影响其余源）
//   1. IPDB 官方 GitHub 镜像 —— API 站从 Worker 访问恒 403，镜像可通
//   2. CB-X2-Jun —— IP:PORT:CC 格式，上游已做存活校验
//   3. jsDelivr —— 与 2 同内容，防 raw.githubusercontent 429
//   4. IPDB 精选带国家码
//   5. 老源（唯一长期验证可用的原始源）
//   6. 官方 API —— 目前 403，留作对方解封后的兜底
export const POOL_SOURCES = [
  "https://raw.githubusercontent.com/ymyuuu/IPDB/main/BestProxy/proxy.txt",
  "https://raw.githubusercontent.com/CB-X2-Jun/cf-proxyip-lists/main/proxyip.txt",
  "https://cdn.jsdelivr.net/gh/CB-X2-Jun/cf-proxyip-lists@main/proxyip.txt",
  "https://raw.githubusercontent.com/ymyuuu/IPDB/main/BestProxy/bestproxy%26country.txt",
  "https://raw.githubusercontent.com/xgonce/Cloudflare_IP/main/result.csv",
  "https://ipdb.api.030101.xyz/?type=proxy",
];

/**
 * 一轮最多抓几个池子源。
 *
 * `env.poolSrc` 可以覆盖源列表，但抓取次数必须有个上界：一次 cron 调用的 fetch 子请求
 * 硬上限是 50（`SC.SCAN_SUB = 48` 留余量），而固定支出里「源」那一笔是按这个常量记的。
 * 7.240 之前自定义源列表不限条数、`refillPool` 又逐个抓 —— 配 30 个源就是 30 次 fetch，
 * 加上恢复用量（12）、DoH（6）与快照（4）会直接越过硬上限、整轮 cron 1102。
 */
export const REFILL_MAX = 6;

// 一行候选：IP[:PORT][#CC | ,… | :CC | 空白]
export const PX_LINE = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(?:[#,:]|\s|$)/;

/**
 * 解析候选池的一行文本并写入去重表；私网/保留地址直接丢弃。
 * @param {string} line 一行文本（IP[:PORT][#CC|,|:CC]）
 * @param {string} src 来源 URL
 * @param {Map<string,object>} seen 去重表（key = ip:port）
 * @returns {boolean} 是否为有效新增
 */
export function takePoolLine(line: string, src: string, seen: Map<string, PoolEntry>) {
  const m = PX_LINE.exec(line.trim());
  if (!m) return false;
  // 源里的行三种写法：ip、ip:port、ip:port#国家码；端口缺省 443，越界也回 443（源数据脏是常态）
  const ip = m[1];
  let port = m[2] ? Number(m[2]) : 443;
  if (!(port >= 1 && port <= 65535)) port = 443;
  if (checkTarget(ip, port)) return false;
  // 只接受 IPv4 字面量：域名会带来 DNS 依赖，而候选池要的是能直接 connect 的地址
  const oct = ip.split(".").map(Number);
  if (oct.some((x) => !(x >= 0 && x <= 255))) return false;
  // 去重键是 ip:port——同一 IP 不同端口是两条不同的出口，不能合并
  const key = ip + ":" + port;
  if (seen.size >= POOL_MAX) return false; // 上游源可能大到离谱，硬上限防内存/ KV 值爆掉
  if (!seen.has(key)) seen.set(key, { h: ip, p: port, src });
  return true;
}

export const POOL_TTL_MS = 24 * 3600e3; // 候选池重建周期（上游源每天都会变）

export const POOL_MAX = 1600; // 候选池硬上限

/**
 * 功能：冷却中的源可以被跳过的最小已有条目数（冷启动兜底）。
 * 低于它就照旧全抓：宁可多花几个子请求，也不能让池子在建池阶段变小。
 */
export const POOL_ENOUGH = 300;

/** 一次抓取的结果：池子 + 每个源的行数/新增数（/proxyip?refill=1 直接展示） */
export interface PoolRefill {
  pool: PoolEntry[];
  sources: Record<string, { lines: number; ok: number; skip?: boolean }>;
}

/**
 * 功能：池子源健康度表（每个 isolate 一份，不跨 isolate 共享）。
 *
 * 镜像源经常整站挂掉或被限流，逐个重试会白烧子请求预算（免费计划每轮约 50 个子请求）。
 * 这里只影响「先抓谁」，**不删除源**：全部冷却时仍会按冷却到期时间全部重试一遍。
 */
export class SourceHealth {
  /** 源 URL → { 连续失败次数, 冷却截止时间 } */
  private bad = new Map<string, { n: number; until: number }>();

  /**
   * 功能：按健康度排序：可用源按配置顺序在前，连续失败且仍在冷却的源排最后。
   * @param env Worker 环境（可含 poolSrc 覆盖源列表）
   * @returns 源 URL 数组（与 poolSources 同一集合，只是顺序不同）
   */
  rank(env: Env): string[] {
    const now = Date.now();
    return poolSources(env)
      .map((src, i) => {
        const h = this.bad.get(src);
        const bad = this.cooling(src, now);
        return { src, i, bad, until: h ? h.until : 0 };
      })
      .sort((a, b) => (a.bad === b.bad ? (a.bad ? a.until - b.until : a.i - b.i) : a.bad ? 1 : -1))
      .map((x) => x.src);
  }

  /**
   * 功能：记录一次抓取结果。成功清零，失败累加并刷新 1 小时冷却。
   * @param src 源 URL
   * @param ok 本次抓取是否成功
   * @returns 无
   */
  note(src: string, ok: boolean): void {
    const h = this.bad.get(src) || { n: 0, until: 0 };
    // 失败只影响「先抓谁」的顺序，不清空计数就无从判断冷却是否该结束
    if (ok) this.bad.set(src, { n: 0, until: 0 });
    else this.bad.set(src, { n: h.n + 1, until: Date.now() + 3600_000 });
  }

  /**
   * 功能：这个源是否在冷却期（连续失败 ≥2 且冷却未到期）。
   * @param src 源 URL
   * @param now 当前时间（测试里注入假时间）
   * @returns 在冷却期返回 true
   */
  cooling(src: string, now = Date.now()): boolean {
    const h = this.bad.get(src);
    return !!h && h.n >= 2 && h.until > now;
  }

  /**
   * 功能：当前 isolate 的源健康快照（调试端点与面板用）。
   * @returns 源 URL → { n, until } 的浅拷贝，调用方改动不会影响内部表
   */
  snap(): Record<string, { n: number; until: number }> {
    const out: Record<string, { n: number; until: number }> = Object.create(null);
    for (const [k, v] of this.bad) out[k] = { n: v.n, until: v.until };
    return out;
  }
}

/** 进程内单例：池子源健康度（每个 isolate 各自一份，不跨 isolate 共享） */
export const SOURCES = new SourceHealth();

/**
 * 功能：把数组切成每段不超过 n 个。用于「同时打开的连接数」受限的场景
 * （免费计划 connect() 并发上限见 SC.PROBE_CONC）。
 * @param arr 原数组
 * @param n 每段上限
 * @returns 分段后的二维数组；n 非法时按 1 处理
 */
export function chunks<T>(arr: T[], n: number): T[][] {
  const lim = Math.max(1, Math.floor(n) || 1);
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += lim) out.push(arr.slice(i, i + lim));
  return out;
}

/**
 * 功能：池子源列表：env.poolSrc 优先，非法项回退内置 6 个源。
 * @param env 环境变量
 * @returns 源 URL 数组
 */
export function poolSources(env: Env): string[] {
  const custom = String(env.poolSrc || "").trim();
  if (!custom) return POOL_SOURCES;
  const list = custom.split(/[,\s]+/).filter((x) => /^https?:\/\//.test(x));
  // 只取前 REFILL_MAX 条：rank / 冷却记账与实际抓取必须是同一个集合，多出来的源等于没配
  return list.length ? list.slice(0, REFILL_MAX) : POOL_SOURCES;
}

/**
 * 功能：按源健康度顺序抓取并合并去重（失败的源排到最后，不删除）。
 *
 * 冷却中的源在已经抓到足够条目时会**直接跳过**（`skip: true`，记 `srcSkip`）：
 * 只调顺序、照抓不误的话，冷却从来没省下过子请求（免费计划一次调用只有 50 个）。
 * `keep` 是当前池子大小，跳过之后新池子不能比它小太多，否则 `commitPool` 的缩水守卫会拒掉整轮刷新。
 *
 * @param env 环境变量
 * @param keep 当前池子大小（0 表示冷启动，只要够 `POOL_ENOUGH` 就可以跳过冷却源）
 * @returns 本次抓取统计：新增数、总数、每源行数（被跳过的源带 `skip`）
 */
export async function refillPool(env: Env, keep = 0): Promise<PoolRefill> {
  const seen = new Map<string, PoolEntry>();
  const sources: Record<string, { lines: number; ok: number; skip?: boolean }> = Object.create(null);
  // 冷却中的源在「已经抓到足够条目」时直接跳过：rank 只决定先抓谁，
  // 全部照抓的话冷却等于没做（每轮仍然白烧 5 个子请求）。keep 是当前池子大小，
  // 跳过之后新池子不能比它小太多，否则 commitPool 的缩水守卫会拒掉整轮刷新。
  const enough = Math.max(POOL_ENOUGH, Math.ceil(keep * 0.75));
  for (const src of SOURCES.rank(env)) {
    if (seen.size >= enough && SOURCES.cooling(src)) {
      sources[src] = { lines: 0, ok: 0, skip: true };
      cnt("srcSkip");
      continue;
    }
    let lines = 0;
    const before = seen.size;
    try {
      const r = await fetch(src, {
        signal: timeoutSignal(10000),
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          accept: "text/html,application/json,text/plain,*/*",
          "accept-language": "en-US,en;q=0.9",
          referer: "https://www.google.com/",
        },
      });
      if (!r.ok) {
        lines = -r.status;
      } else {
        const txt = (await r.text()).slice(0, 2 * 1024 * 1024); // 防异常大响应把 CPU/内存打满
        for (const line of txt.split("\n")) {
          if (PX_LINE.test(line.trim())) lines++;
          takePoolLine(line, src, seen);
        }
      }
    } catch (e) {
      lines = -1;
    }
    sources[src] = { lines, ok: seen.size - before };
    SOURCES.note(src, lines >= 0);
  }
  for (const h of EXTRA_HOSTS) {
    // seen 的键是 "ip:port"：以前用不带端口的 h 去重，永远判不存在，
    // 上游列表里已有同名条目时会插进两条一样的节点。
    const key = h + ":443";
    if (!seen.has(key)) seen.set(key, { h, p: 443, src: "builtin" });
  }

  const pool = [...seen.values()];
  if (pool.length) logErr("pool refilled: " + pool.length, "");
  return { pool, sources };
}
