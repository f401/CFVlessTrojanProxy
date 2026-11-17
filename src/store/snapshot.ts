import { S } from "../core/state";
import { RTT_MAX, SC } from "../core/const";
import { eachLimit } from "../core/util";
import { cnt } from "../core/counter";
import { kvGet, kvGetStrict, kvSet } from "./kv";
import { doFetch, meterGet } from "./meter-client";

/* 快照：用量灾备（KV）+ 合成快照 */

export const USAGE_SNAP_KEY = "usage:snap";
export const FLUSH_MIN_MS = 3600000; // 1 小时（且累计 ≥2MB 才写）
export const FLUSH_DIRTY = 2 * 1024 * 1024; // 脏字节门槛
export const FLUSH_MAX_MS = 7200000; // 最迟 2 小时必落一次
export const FLUSH_GAP = 2700000; // 全局闸门：45 分钟内已有别的 isolate 写过就不再写
export const SNAP_TTL = 300000;

/**
 * 功能：读用量快照（KV 里的 USAGE_SNAP_KEY）。
 * @param env 环境变量（STATS 为 KV）
 * @returns 快照对象；不存在或读失败返回 null
 */
export async function usageSnapGet(env: Env) {
  try {
    return (await kvGet<UsageSnap>(env, USAGE_SNAP_KEY)) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 功能：写用量灾备快照。读失败时直接跳过——拿空表覆盖会把别的用户的历史用量抹掉。
 *
 * 六步各自失败后果不同：读旧快照（读失败整轮不写）、2 小时闸门（写太勤会吃掉 KV 写额度）、
 * 轮转切批（决定谁这轮被读到）、逐用户合并（只增不减 + 当日字段只认同一天）、
 * 尾部搬旧值（没读到的人不能从快照里消失）、落盘（失败要可观察）。
 * @param env 环境变量
 * @param users 用户表（必须传：本地没有"全部用户"的表，不传等于什么都不写 —— v7.142 删掉
 *   门面方法就是因为 `usageSnapWrite(env)` 这个形态永远写不出东西，这里如实写清）
 * @param max 本轮最多读几个用户的用量（每人一次 DO 往返，由 `planRound` 的 snap 分账传入）
 * @returns 无
 */
export async function usageSnapWrite(env: Env, users?: UserRec[], max: number = SC.SNAP_MAX) {
  // 没有 KV 或没有计量 DO 时这两件事都无处可写，早退比逐用户失败便宜
  if (!env.STATS || !env.METER) return;
  const prev = await loadPrevUsageSnap(env);
  // 读失败：整轮不写（拿空表覆盖 = 抹掉所有人的历史用量），这里已经在读取处计数
  if (!prev) return;
  // 灾备快照，2 小时一次足够（cron 是 30 分钟一轮，别每轮都写一遍）
  if (Date.now() - (prev.ts || 0) < 2 * 3600e3) return;
  const list = users || [];
  // 读一个用户就是一次 DO 子请求，一次调用总共只有 50 个（cron 还要花在 refill / restore 上）
  const cap = Math.max(1, Math.min(SC.SNAP_MAX, max));
  const { head, tail, next } = rotateWindow(list, cap, Number(prev.idx) || 0);
  if (tail.length) cnt("snapSkip", tail.length);
  const today = new Date().toISOString().slice(0, 10);
  const out: UsageSnap = { ts: Date.now(), users: {}, idx: next };
  // 并发 8：再高就会让「一次 cron 最多 50 个子请求」被这一件事吃光
  await eachLimit(head, 8, async (u) => {
    const row = await mergeOneUsage(env, u, prev, today);
    if (row) out.users[u.id] = row;
  });
  carryUnread(tail, prev, out);
  await commitUsageSnap(env, out);
}

/**
 * 功能：读灾备快照的旧值；读失败时计一次 `snapReadFail` 并返回 null。
 *
 * 三个参数都不能省：读不到就整轮不写（拿空表覆盖会抹掉历史用量），而连续失败的表现
 * 是「用量快照停更」，与「这一轮没人有增量」一模一样 —— 不计数就永远看不出来。
 * @param env 环境变量
 * @returns 上一份快照（不存在时给空骨架）；读失败返回 null，调用方必须放弃这轮写
 */
async function loadPrevUsageSnap(env: Env): Promise<UsageSnap | null> {
  try {
    return (await kvGetStrict<UsageSnap>(env, USAGE_SNAP_KEY)) || ({ users: {}, ts: 0 } as UsageSnap);
  } catch (e) {
    cnt("snapReadFail");
    return null;
  }
}

/**
 * 功能：按游标切出这一轮要读的一批用户，并给出下一轮的游标。
 *
 * 为什么必须轮转：`loadUsers` 顺序稳定（KV 里按创建序），永远取前 cap 个的话，
 * 创建得早的那批每轮都被刷新、排在后面的永远停在第一次读到的水位 ——
 * 7.177 的 `PendingLedger` 尾部饥饿是同一个形状。
 * @param list 用户表
 * @param cap 本轮最多读几个
 * @param prevIdx 上一轮停下的位置
 * @returns 本轮要读的头、只搬旧值的尾，以及下一轮的游标
 */
function rotateWindow(list: UserRec[], cap: number, prevIdx: number) {
  // 用户数不超过上限时不用轮转（起点恒 0，尾永远是空）
  const start = list.length > cap ? prevIdx % list.length : 0;
  const rotated = start ? list.slice(start).concat(list.slice(0, start)) : list;
  const head = rotated.slice(0, cap);
  const tail = rotated.slice(head.length);
  // 游标推进到本轮之后（走完一圈回到 0），下一轮从这批之后接着读
  const next = list.length > cap ? (start + head.length) % list.length : 0;
  return { head, tail, next };
}

/**
 * 功能：把任意读数夹成非负整数（用量 / 连接数都只能往前涨）。
 * @param x 任意读数（DO 返回值、旧快照值都可能缺字段）
 * @returns 非负整数；非法值一律当 0
 */
function safeCount(x: unknown): number {
  const n = Number(x);
  // 绝不能用 `|0`：用量经常超过 2^31，位运算会溢出成负数，灾备快照会被写成 0
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 功能：把一个用户的「DO 现值」与「上一份快照」合并成一条灾备行。
 *
 * 两条口径都是必须的：① 只增不减 —— DO 被重置（重建脚本）时不能把历史用量写回 0；
 * ② 当日字段只合并「同一天」的 —— 昨天 23:59 的 `dU` 不能算进今天。
 * @param env 环境变量
 * @param u 用户记录
 * @param prev 上一份快照
 * @param today 今天（`YYYY-MM-DD`）
 * @returns 有量才返回行；三档全 0 的用户不进快照，返回 null
 */
async function mergeOneUsage(
  env: Env,
  u: UserRec,
  prev: UsageSnap,
  today: string,
): Promise<UsageSnap["users"][string] | null> {
  const v = await meterGet(env, u.id);
  const old = (prev.users || {})[u.id];
  const up = Math.max(safeCount(v && v.up), safeCount(old && old.up));
  const down = Math.max(safeCount(v && v.down), safeCount(old && old.down));
  const conns = Math.max(safeCount(v && v.conns), safeCount(old && old.conns));
  // 当日字段只认同一天的：跨天的那份读出来等于 0，宁可少算也不要算进今天
  const vDay = v && v.d === today ? v : null;
  const oldDay = old && old.d === today ? old : null;
  const dU = Math.max(safeCount(vDay && vDay.dU), safeCount(oldDay && oldDay.dU));
  const dD = Math.max(safeCount(vDay && vDay.dD), safeCount(oldDay && oldDay.dD));
  // 三档全 0 说明这个人从没跑过流量，进快照只会白占一行
  if (!up && !down && !conns) return null;
  return {
    up,
    down,
    conns,
    first: (v && v.first) || (old && old.first) || 0,
    d: today,
    dU,
    dD,
  };
}

/**
 * 功能：把这一轮没读到的用户原样搬进新快照。
 *
 * 只搬旧值、不给它们编新数字：恢复路径读的是「上次真的读到的」那个数，
 * 直接跳过会让它们从灾备里消失，DO 重建之后再也恢复不回来。
 * @param tail 本轮没读到的用户
 * @param prev 上一份快照
 * @param out 正在拼的新快照（就地写入）
 * @returns 无
 */
function carryUnread(tail: UserRec[], prev: UsageSnap, out: UsageSnap): void {
  for (const u of tail) {
    const old = (prev.users || {})[u.id];
    if (!old) continue;
    out.users[u.id] = { ...old };
  }
}

/**
 * 功能：落盘灾备快照（90 天 TTL；一个人都没有时什么都不写）。
 *
 * 失败只计数不抛：额度耗尽/熔断时本来只是「下次再写」，但连续失败与「这一轮没人有增量」
 * 不可区分 —— 快照停更的表现是重装脚本后用量从 0 起算，事后才发现。
 * @param env 环境变量
 * @param out 要写的快照
 * @returns 无
 */
async function commitUsageSnap(env: Env, out: UsageSnap): Promise<void> {
  if (!Object.keys(out.users).length) return;
  try {
    await kvSet(env, USAGE_SNAP_KEY, out, { expirationTtl: 86400 * 90 });
  } catch (e) {
    cnt("snapWriteFail");
  }
}

/** 每轮 cron 最多恢复的用户数：每次恢复 = 1 个 DO 子请求，一次调用总共只有 50 个（还要留给 refill/tfb/DoH） */
export const RESTORE_MAX = 12;

/**
 * 功能：从快照用户里挑出本轮要恢复的那一批 —— 超过上限时按小时窗口轮转，避免「前 12 个永远恢复、后面的永远不恢复」。
 * @param {string[]} ids 快照里的用户 id 列表
 * @param {number} max 本轮上限（默认 RESTORE_MAX）
 * @param {number} now 当前时间（默认 Date.now，便于测试注入）
 * @returns {string[]} 要恢复的 id 列表（长度 ≤ max，无重复）
 */
export function restorePick(ids: string[], max = RESTORE_MAX, now = Date.now()): string[] {
  if (!Array.isArray(ids) || ids.length <= max) return Array.isArray(ids) ? ids.slice() : [];
  // 起点按小时平移：否则用户数一多，排在后面的用户永远拿不到恢复机会
  const start = Math.floor(now / 3600000) % ids.length;
  const out: string[] = [];
  for (let k = 0; k < max; k++) out.push(ids[(start + k) % ids.length]);
  return out;
}

/**
 * 功能：把某用户已上报的用量恢复进本地状态（换 isolate 后不让客户端看到「用量归零」）。
 * @param env 环境变量
 * @param id 用户 id
 * @param snap 预读的快照（可选，避免重复读 KV）
 * @returns 恢复后的用量记录；无快照返回 null
 */
export async function restoreUsage(env: Env, id: string, snap?: UsageSnap) {
  if (!env || !env.METER) return null;
  // 允许调用方把已读到的快照传进来，避免同一请求里二次读 KV
  const s = snap || (await usageSnapGet(env));
  const u = s && s.users && s.users[id];
  if (!u) return null;
  try {
    // 把历史用量推回 DO：DO 可能被回收过，内存计数已经丢了；
    // 推失败就返回 null（调用方按「无记录」处理），绝不能编造用量
    const r = await doFetch(env, id, "https://meter/set", { method: "POST", body: JSON.stringify(u) });
    if (!r.ok) return null;
    const v = await r.json();
    S.meterCache.set(id, { v, t: Date.now() });
    return v;
  } catch (e) {
    return null;
  }
}

/**
 * 功能：合并写快照的总入口。带两道节流：全局闸门 + 最小间隔，避免每个 isolate 各写各的把写次数写爆。
 * @param env 环境变量
 * @param force 跳过节流立即写
 * @returns 无
 */
export async function flushSnap(env: Env, force?: boolean): Promise<void> {
  const kv = env.STATS;
  if (!kv) return;
  const hasData = S.stats.size > 0 || S.rtt.size > 0 || S.errs.length > 0;
  if (!hasData) return;

  const now = Date.now();
  const since = now - (S.snapWritten || 0);
  // 关键：按"时间"节流，而不是按"脏字节"。
  // 以前 snapBytes >= 2MB 就写 —— 一天 12 GB 流量 = 6000 次写，直接把
  // 免费额度（1000/天）打爆。
  const due = !!force || (S.snapBytes >= FLUSH_DIRTY && since >= FLUSH_MIN_MS) || since >= FLUSH_MAX_MS;
  if (!due) return;
  // 全局闸门失败/跳过时不能每条连接都再去读一次 KV：5 分钟内只检查一次。
  // force 必须绕过它，否则 force 就是个死开关（v7.201：强制落盘连续调两次，第二次被
  // 这句静默吃掉，调用方以为已经写进 KV）。
  if (!force && now - S.snapChecked < 5 * 60000) return;
  S.snapChecked = now;
  // 同一 isolate 只允许一个落盘在飞：连接收尾会并发调 flushSnap，
  // 没有这个闩时 50 条连接同时关闭就可能各写一次 KV（写额度 1000/天）。
  if (S.snapBusy) return;
  S.snapBusy = true;
  try {
    await writeSnap(env, now, !!force);
  } finally {
    S.snapBusy = false;
  }
}

/**
 * 功能：真正合并并写入快照（把本地读数并进上一份快照后落 KV）。
 *
 * 五步各自失败后果不同，所以各成一步：读（读失败必须放弃，不能当空快照覆盖别人）、
 * 全局闸门（挡掉 = 别人刚写过，本地增量留到下一轮）、建骨架（跨天重置）、
 * 合并（用量 / 延迟 / 错误三类口径不同）、落盘（成功才清本地，失败要可观察）。
 * @param env 环境变量
 * @param now 当前时间戳
 * @param force 跳过 45 分钟全局闸门（强制落盘时用）
 * @returns 无
 */
async function writeSnap(env: Env, now: number, force = false): Promise<void> {
  const prev = await readPrevSnap(env);
  // 读失败：不能当空快照继续写（会把别的 isolate 的当日统计/错误整份覆盖掉）
  if (!prev) return;
  // 别人 45 分钟内写过就跳过：自己的增量留在内存里下一轮合并，一条不丢
  if (gateHeld(prev, now, force)) return;
  const next = seedSnap(prev, now);
  mergeUsage(next, now);
  mergeRtt(next);
  trimRtt(next);
  mergeErrs(next);
  await commitSnap(env, next, now);
}

/**
 * 功能：严格读上一份快照 —— 读失败时计一次 `snapFlushReadFail` 并返回 null。
 *
 * 必须 fresh + 严格：缓存里的 `ts` 可能已经过时 5 分钟，会误判「该写了」；
 * 读失败时更不能当空快照继续写，否则会把别的 isolate 的当日统计整份覆盖掉。
 * @param env 环境变量
 * @returns 上一份快照（没有快照时给空骨架）；读失败返回 null，调用方必须放弃这次写
 */
async function readPrevSnap(env: Env): Promise<SnapDoc | null> {
  try {
    return (await kvGetStrict<SnapDoc>(env, "snap")) || { v: 1, ts: 0, date: "", stats: {}, rtt: {}, errs: [] };
  } catch (e) {
    cnt("snapFlushReadFail");
    return null;
  }
}

/**
 * 功能：45 分钟的全局闸门 —— 每个 isolate 各写各的会让写次数随实例数线性增长。
 * @param prev 上一份快照（`ts` 是别的 isolate 的写入时刻）
 * @param now 当前时间
 * @param force 强制落盘时绕过闸门（否则 force 就是个死开关，v7.201 的教训）
 * @returns 是否应当跳过这次写（返回 true 时已把本地基线推进到别人那一次）
 */
function gateHeld(prev: SnapDoc, now: number, force: boolean): boolean {
  if (!force && now - (prev.ts || 0) < FLUSH_GAP) {
    // 别人刚写过：把本地基线推进到那一次，并把下一次检查推到闸门结束，
    // 避免下一批连接反复走 getSnap 再跳过。
    S.snapWritten = Math.max(S.snapWritten || 0, prev.ts || 0);
    S.snapChecked = Math.max(S.snapChecked || 0, (prev.ts || 0) + FLUSH_GAP);
    return true;
  }
  return false;
}

/**
 * 功能：建出这次要写的骨架 —— 跨天重置用量、错误只留最近 50 条。
 * @param prev 上一份快照
 * @param now 当前时间戳（写进 `ts`）
 * @returns 待合并的新快照（`stats` / `rtt` 已是上一份的浅拷贝）
 */
function seedSnap(prev: SnapDoc, now: number): SnapDoc {
  const day = new Date().toISOString().slice(0, 10);
  return {
    v: 1,
    ts: now,
    date: day,
    stats: prev.date === day ? { ...(prev.stats || {}) } : {}, // 跨天重置
    rtt: { ...(prev.rtt || {}) },
    errs: (prev.errs || []).slice(-50),
  };
}

/**
 * 功能：把本地按用户累计的用量并进快照（字节与连接数相加，首末次连接取极值）。
 * @param next 待写快照（就地修改）
 * @param now 当前时间（给缺 `first` 的新行兜底）
 * @returns 无
 */
function mergeUsage(next: SnapDoc, now: number): void {
  for (const [id, s] of S.stats) {
    const p = next.stats[id] || { up: 0, down: 0, conns: 0, first: s.first, last: s.last };
    next.stats[id] = {
      up: (p.up || 0) + (s.up || 0),
      down: (p.down || 0) + (s.down || 0),
      conns: (p.conns || 0) + (s.conns || 0),
      // 首次连接取更早、末次取更晚：面板上的「活跃区间」因此跨 isolate 也单调
      first: Math.min(p.first || s.first || now, s.first || now),
      last: Math.max(p.last || 0, s.last || 0),
    };
  }
}

/**
 * 功能：把本地按「用户 × 标签」的延迟桶并进快照（rtt 按 0.3 衰减做 EWMA，计数相加）。
 * @param next 待写快照（就地修改）
 * @returns 无
 */
function mergeRtt(next: SnapDoc): void {
  for (const [id, bucket] of S.rtt) {
    // 不能直接复用 prev 里的普通对象：tag="__proto__" 时赋值会改原型而不是写键
    const tgt = Object.create(null) as Record<string, RttEntry>;
    const oldTgt = next.rtt[id];
    if (oldTgt) for (const [k, v] of Object.entries(oldTgt)) tgt[k] = v;
    for (const [tag, v] of Object.entries(bucket) as [string, RttEntry][]) {
      const p = tgt[tag];
      tgt[tag] = p
        ? {
            rtt: v.rtt ? Math.round((p.rtt || v.rtt) * 0.7 + v.rtt * 0.3) : p.rtt || 0,
            colo: v.colo || p.colo,
            bw: v.bw || p.bw,
            hits: (p.hits || 0) + (v.hits || 0),
            ok: (p.ok || 0) + (v.ok || 0),
            fail: (p.fail || 0) + (v.fail || 0),
            ts: v.ts || p.ts,
          }
        : { ...v, ok: v.ok || 0, fail: v.fail || 0 };
    }
    next.rtt[id] = tgt;
  }
}

/**
 * 功能：落盘前把每个用户下的标签裁到 `RTT_MAX`（按最后活跃时间留新的）。
 *
 * 老快照可能已经攒了很多标签：不裁的话 `rtt` 会一直涨，而面板只画前几条。
 * @param next 待写快照（就地修改）
 * @returns 无
 */
function trimRtt(next: SnapDoc): void {
  for (const tgt of Object.values(next.rtt)) {
    const keys = Object.keys(tgt);
    if (keys.length <= RTT_MAX) continue;
    keys.sort((a, b) => (tgt[a].ts || 0) - (tgt[b].ts || 0));
    for (let i = 0; i < keys.length - RTT_MAX; i++) delete tgt[keys[i]];
  }
}

/**
 * 功能：把本地错误追加进快照并只留最近 50 条。
 * @param next 待写快照（就地修改）
 * @returns 无
 */
function mergeErrs(next: SnapDoc): void {
  if (S.errs.length) next.errs = next.errs.concat(S.errs).slice(-50);
}

/**
 * 功能：落盘并在成功后清空本地读数（失败时本地原样留着，下一轮重试）。
 * @param env 环境变量
 * @param next 待写快照
 * @param now 当前时间（成功时记进 `S.snapWritten`）
 * @returns 无
 */
async function commitSnap(env: Env, next: SnapDoc, now: number): Promise<void> {
  try {
    await kvSet(env, "snap", next, { expirationTtl: 86400 * 30 });
    S.snapCache = { v: next, t: Date.now() };
    S.snapWritten = now;
    S.snapBytes = 0;
    // 只有写成功才清：KV 抖动时这些增量必须留到下一轮，否则这一段流量永久消失
    S.stats.clear();
    S.rtt.clear();
    S.errs.length = 0;
  } catch (e) {
    // 同 usageSnapWrite：KV 写不上去时快照停在旧值，事后只能从「重装后用量从 0 起算」发现
    cnt("snapFlushFail");
  }
}

/**
 * 功能：取快照（带 TTL 缓存，fresh 可强制刷新）。
 *
 * 读失败必须**抛错**，不能返回空快照：`SNAP_TTL` 是 5 分钟，一旦把「KV 抖动」
 * 当成「还没有快照」，`/<uuid>/logs` 的错误列表、`readStats` 的 KV 回退、
 * `loadRtt` 的延迟学习会在 5 分钟里一致地骗人（`loadRtt` 还会顺带把 `S.rttMiss`
 * 压上 10 分钟，KV 恢复了也读不到）。三个调用方本来就都有 try/catch，抛出去各自降级。
 * @param env 环境变量
 * @param fresh 忽略缓存
 * @returns 快照对象；键不存在时是空表，**读失败会抛错**（不进缓存）
 */
export async function getSnap(env: Env, fresh?: boolean) {
  if (!fresh && S.snapCache.v && Date.now() - S.snapCache.t < SNAP_TTL) return S.snapCache.v;
  // 严格读：抛错路径不碰 S.snapCache，下一次调用会重新打 KV
  const v = await kvGetStrict<SnapDoc>(env, "snap");
  const out: SnapDoc = v || { v: 1, ts: 0, date: "", stats: {}, rtt: {}, errs: [] };
  S.snapCache = { v: out, t: Date.now() };
  return out;
}

