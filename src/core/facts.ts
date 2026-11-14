// 事实行的通用合并器（store 层用）：让 meter 不必知道每种事实的语义。
//
// 所有事实都是「一个键 + 一个时间戳 + 一点计数」，合并规则也一样：
// 更新的 `at` 胜、太旧（超过 TTL）的丢、超容量按时间淘汰最旧的。
// 把它抽出来的直接原因：meter.ts 有 560 行硬上限，而每加一种事实要写 20 行合并代码。
/** 带时间戳的行 */
export interface AtRow {
  /** 最后观测时间 */
  at: number;
}

/**
 * 功能：把远端事实行合并进本地表。
 * @template T 行类型（必须有 `at`）
 * @param {Record<string, T>} cur 本地表
 * @param {unknown[]} rows 远端行（形状未知，由 `fix` 校验）
 * @param {number} max 表上限
 * @param {number} ttl 过期时间（0 = 不按时间过期）
 * @param {(r: unknown) => T | null} fix 行校验/归一化，返回 null 表示丢弃
 * @param {number} now 当前时间
 * @returns {Record<string, T>} 合并后的表（就地修改并返回）
 */
export function mergeAt<T extends AtRow>(
  cur: Record<string, T>,
  rows: unknown[],
  max: number,
  ttl: number,
  fix: (r: unknown) => T | null,
  now = Date.now(),
): Record<string, T> {
  for (const raw of rows) {
    const row = fix(raw);
    if (!row) continue;
    // 太旧的直接丢：跨 isolate 回放一份一小时前的结论没有意义
    if (ttl > 0 && now - row.at > ttl) continue;
    const r = raw as { k?: unknown; i?: unknown; h?: unknown };
    // 键可能在 `k`（host|relay）、`i`（ip）或 `h`（站点）上：三种形状都是既有 wire 类型，不另设归一化层
    const k = typeof r.k === "string" ? r.k : typeof r.i === "string" ? r.i : typeof r.h === "string" ? r.h : "";
    if (!k) continue;
    const old = cur[k];
    // 严格更新：相同时间戳也保留本地的（两个 isolate 同一毫秒写同一键时不该互相翻转）
    if (old && old.at >= row.at) continue;
    cur[k] = row;
  }
  const keys = Object.keys(cur);
  if (keys.length > max) {
    keys.sort((a, b) => cur[b].at - cur[a].at);
    for (const k of keys.slice(max)) delete cur[k];
  }
  return cur;
}

/** 封锁行（键在 map 上，值只有计数与时间） */
export interface BlkRow {
  /** 批数 */
  n: number;
  /** 时间 */
  at: number;
}

/**
 * 功能：合并封锁事实行（形状 `{ k, n, at }`）。
 * @param {Record<string, BlkRow>} cur 本地表
 * @param {unknown[]} rows 远端行
 * @param {number} max 表上限
 * @param {number} ttl 过期时间
 * @param {number} now 当前时间
 * @returns {number} 合并条数
 */
export function mergeBlk(cur: Record<string, BlkRow>, rows: unknown[], max: number, ttl: number, now = Date.now()): number {
  const before = Object.keys(cur).length;
  mergeAt(cur, rows, max, ttl, (r) => {
    const x = r as { n?: unknown; at?: unknown };
    if (typeof x.at !== "number") return null;
    const n = typeof x.n === "number" ? Math.max(1, Math.min(9, Math.round(x.n))) : 1;
    return { n, at: x.at };
  }, now);
  return Math.max(0, Object.keys(cur).length - before);
}
