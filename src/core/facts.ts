// 事实行的通用合并器（store 层用）：让 meter 不必知道每种事实的语义。
//
// 所有事实都是「一个键 + 一个时间戳 + 一点计数」，合并规则也一样：
// 更新的 `at` 胜、太旧（超过 TTL）的丢、超容量按时间淘汰最旧的。
// 把它抽出来的直接原因：meter.ts 有 560 行硬上限，而每加一种事实要写 20 行合并代码。
/**
 * 五类事实的寿命（毫秒）：store 层的合并规则与 route 层的事实表必须读同一份。
 *
 * 这些数字原本在 `src/store/factmerge.ts` 与各 `src/route/*facts.ts` 里各写一遍
 * （eg 6 小时、ps 45 分钟、dead 30 分钟、blk 90 分钟、dns 24 小时）。两处一旦漂移，
 * 症状是「本地已经当它过期、DO 还当它是新鲜证据」，不报错也测不出来 —— 7.154 的
 * `VT_TTL` 就是这么分裂成两份的，所以这里只留一份，谁要都从这里取。
 */
export const FACT_TTL = {
  /** 出口族（4/6）：6 小时 */
  eg: 21600000,
  /** 站点×中继成功率：45 分钟（样本越旧越不可比） */
  ps: 45 * 60000,
  /** 连不上：30 分钟 */
  dead: 30 * 60000,
  /** 单 IP 封锁：90 分钟 */
  blk: 90 * 60000,
  /** 站点 DNS：24 小时（五类里最稳定的一条） */
  dns: 24 * 3600_000,
} as const;

/**
 * 页面尺寸的三个判据：tiny（小到不像页面）、big（拿到整页）、win（同窗口宽度）。
 *
 * 为什么单独拎出来：这三个数原先在 `commitfact` / `egfacts` / `judge` / `relay-health` 里各写
 * 一份（四份 20000、三份 2048，`judge` 里还有两处直接写裸数字）。调一处而漏一处，症状是
 * 「写入侧认为拿到了整页、推导侧认为没有」—— 与 7.154 的 `VT_TTL` 分裂完全同形，所以和
 * `FACT_TTL` 一样只留一份，谁要都从这里取。
 */
export const PAGE_ABS = {
  /** 小响应上限：封锁页实测 737B，业务页的 4xx 也远小于整页 */
  tiny: 2048,
  /** 整页门槛：≥20KB 才算「真的传了一页」 */
  big: 20000,
  /** 同窗口宽度：120 秒内的观测可以互为对照 */
  win: 120000,
} as const;

/** 带时间戳的行 */
interface AtRow {
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
interface BlkRow {
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
