import { SC } from "../core/const";
import { S } from "../core/state";
import { costOf } from "./score-cost";
import { isBlack, isFrozen, usable } from "./score-health";

/* 候选表：把「谁能进候选、按什么顺序」这一件事单独放一层。
   排行缓存只冻结排序，不冻结「能不能用」——这一条是 7.37 用 22 条失败单测换来的：
   曾经把 `usable()` 的结果一起缓存，节点被判死后缓存还在把它推荐出去。 */

const CAND_TTL = 20000;      // 排行缓存寿命（按模式各记各的时间）
const CAND_CACHE_MIN = 24;   // 候选少的时候不必缓存（重算也就几十 µs）
const CAND_KEEP = 224;       // 排行榜只留前 N 名（抽样只看前 64 + 64 个样本不足的）
const CAND_EXTRA = 64;       // 额外兜一批样本不足的节点，否则新节点永远进不了抽样池
const CAND_SLICE = 128;      // 分片重建：每次最多给多少个节点打分（2000 候选一次算完要 4 ms）
const CAND_SLICE_MIN = 1200; // 池子大于这个数才分片：800 个候选整算 1.6 ms 还吃得下，2000 个就要 4 ms

/**
 * 功能：一次算完的排行（小池与「大池冷启动」走这条路）。
 *
 * 只保留前 CAND_KEEP 名 + 最多 CAND_EXTRA 个样本不足的节点：前者决定「谁最快」，
 * 后者保证新节点也有机会进抽样池（否则它们永远拿不到样本，也就永远进不了排行）。
 * @param m 模式
 * @param now 当前时间戳
 * @returns 按代价升序的候选行
 */
function buildCands(m: Mode, now: number): RankRow[] {
  const top: RankRow[] = [];
  let usableN = 0;
  for (const k of S.alive.keys()) {
    if (!usable(k)) continue;
    usableN++;
    const v = costOf(k, m);
    if (top.length < CAND_KEEP || v < top[top.length - 1].v) {
      let lo = 0;
      let hi = top.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        // 相等时插在后面：保持插入顺序（同价节点按 alive 顺序，结果可复现）
        if (top[mid].v <= v) lo = mid + 1;
        else hi = mid;
      }
      top.splice(lo, 0, { k, v });
      if (top.length > CAND_KEEP) top.pop();
    }
  }
  const seen = new Set(top.map((r) => r.k));
  let extra = 0;
  for (const k of S.alive.keys()) {
    if (extra >= CAND_EXTRA) break;
    if (seen.has(k) || !usable(k)) continue;
    const s = S.nstat.get(k);
    if (s && s.okW + s.failW >= SC.N_EFF_MIN) continue;
    top.push({ k, v: costOf(k, m) });
    seen.add(k);
    extra++;
  }
  S.candN = usableN;
  // 小池不写缓存：否则一次 2 节点的小算例会把后面 30 节点的算例喂成旧表
  if (S.alive.size >= CAND_CACHE_MIN) {
    const c = S.rankCache;
    S.rankCache = { ...c, t: now, at: { ...c.at, [m]: now }, v: { ...c.v, [m]: top } };
  }
  return top;
}

/**
 * 功能：候选排行（按代价升序）。大池分片重建：每次调用只给 CAND_SLICE 个节点打分，
 * 边算边维护有界的前 CAND_KEEP 名（不做事后排序），2000 候选不再有 4 ms 的重建尖峰。
 * @param mode 模式
 * @returns 按代价升序的候选行（分片中途返回的是半程结果或上一轮缓存）
 */
export function rankedCands(mode: Mode): RankRow[] {
  const m: Mode = mode === "tput" ? "tput" : "lat";
  const now = Date.now();
  const c = S.rankCache;
  // 小池不进缓存：测试与冷启动都要看到当前真实列表
  const cached = S.alive.size >= CAND_CACHE_MIN ? c.v[m] : undefined;
  if (cached && c.t && now - (c.at[m] || 0) < CAND_TTL) return cached;
  if (S.alive.size < CAND_CACHE_MIN || S.alive.size < CAND_SLICE_MIN) return buildCands(m, now);
  const steps = c.step || (c.step = {});
  let st = steps[m];
  if (!st) {
    st = { keys: [...S.alive.keys()], pos: 0, top: [], extra: [], ok: 0 };
    c.step[m] = st;
  }
  const end = Math.min(st.keys.length, st.pos + CAND_SLICE);
  for (let i = st.pos; i < end; i++) {
    const k = st.keys[i];
    if (!usable(k)) continue;
    st.ok++;
    const v = costOf(k, m);
    if (st.top.length < CAND_KEEP || v < st.top[st.top.length - 1].v) {
      let lo = 0;
      let hi = st.top.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        // 相等时插在后面：保持插入顺序（同价节点按 alive 顺序，结果可复现）
        if (st.top[mid].v <= v) lo = mid + 1;
        else hi = mid;
      }
      st.top.splice(lo, 0, { k, v });
      if (st.top.length > CAND_KEEP) st.top.pop();
    } else if (st.extra.length < CAND_EXTRA) {
      const s = S.nstat.get(k);
      if (!(s && s.okW + s.failW >= SC.N_EFF_MIN)) st.extra.push({ k, v });
    }
  }
  st.pos = end;
  // 只有整轮扫完才写 S.candN：切片中途的 st.ok 只是「扫过这一段」里的可用数，
  // 被抽样器当成池子大小会让抽样宽度（kMax 档）与 β 在同一个池子里来回跳（7.211）
  if (st.pos >= st.keys.length) S.candN = st.ok;
  if (st.pos < st.keys.length) {
    // 半程不重发表格（省掉每 pick 一次 concat）；只有冷启动时才把半程结果先用起来
    if (cached) return cached;
    S.rankCache = { ...c, v: { ...c.v, [m]: st.top } };
    return st.top;
  }
  const rows = st.extra.length ? st.top.concat(st.extra) : st.top;
  delete c.step[m];
  S.rankCache = { ...c, t: now, at: { ...c.at, [m]: now }, v: { ...c.v, [m]: rows } };
  return rows;
}

/**
 * 功能：候选列表（已按黑名单/冻结过滤，按代价升序）。
 *
 * 缓存只冻结排序、不冻结「能不能用」：每一行都在这里重新过一遍 `alive`/`isBlack`/`isFrozen`。
 * @param mode 模式
 * @returns 过滤后的候选行
 */
export function candsFor(mode: Mode): RankRow[] {
  const out: RankRow[] = [];
  for (const r of rankedCands(mode)) if (S.alive.has(r.k) && !isBlack(r.k) && !isFrozen(r.k)) out.push(r);
  return out;
}

/**
 * 功能：下一个候选（可跳过 `avoid`，可限定国家码）。
 * @param mode 模式
 * @param avoid 要跳过的节点键（通常是刚失败的那条）
 * @param cc 限定国家码（大小写不敏感，空值表示不限定）
 * @returns 节点键，没有可用候选时返回空串
 */
export function nextNode(mode: Mode, avoid: string, cc?: string | null): string {
  const want = String(cc || "").toUpperCase();
  for (const x of candsFor(mode)) {
    if (x.k === avoid) continue;
    if (want) {
      const a = S.alive.get(x.k);
      if (!a || String(a.cc || "").toUpperCase() !== want) continue;
    }
    return x.k;
  }
  return "";
}

/**
 * 功能：当前最优（候选表第一名的键）。
 * @param mode 模式
 * @returns 节点键，没有候选时返回空串
 */
export function bestFor(mode: Mode): string {
  const c = candsFor(mode);
  return c.length ? c[0].k : "";
}
