import { seal, unseal } from "./index";

/**
 * 单个 DO 存储值的字节预算。平台硬上限是 128 KiB（131072），这里留 8 KiB 余量。
 *
 * 为什么必须有这个预算（v7.218）：`seal()` 是 AES-GCM + base64，密文串比明文 JSON 大约
 * 4/3；七张事实表按各自上限填满时明文 JSON 就有 193.6 KB，封出来 258.2 KB —— 而 `put`
 * 的单值上限是 131072 字节。超限时 `put` 抛错 ⇒ `/add` 回滚并 5xx ⇒ `pendFlush` 永远重试，
 * 用量、配额、事实证据一起停摆，且**表越满越修不好**（自锁）。
 */
export const VALUE_MAX = 120000;

/**
 * 事实表的三个分片键。热状态（用量 / 日计数 / 节点快照 / 错误环 / 连接环）永远在 `a`，
 * 七张事实表装不进一个值时拆成三片；装得下时仍旧单键（见 `saveState()`），不多花行写入。
 */
export const SHARD_KEYS = ["f1", "f2", "f3"] as const;

/** 从 storage 解出来的账本形状（老布局把全部字段塞在 `a` 里，新布局按体积拆片） */
export interface MeterStore {
  /** 事实表代号：分片与 `a` 必须同号才认（见 saveState() 的注释） */
  fs?: number;
  c?: UsageMeter;
  g?: CounterDoc;
  s?: Record<string, NodeSnap>;
  e?: ErrItem[];
  cl?: ClRec[];
  vt?: Record<string, number | { s: number; t: number }>;
  hl?: Record<string, { o: number; b: number; d: number; t?: number }>;
  eg?: Record<string, { f: number; at: number }>;
  ps?: Record<string, { q: number; n: number; at: number; top?: number }>;
  dead?: Record<string, { n: number; at: number }>;
  blk2?: Record<string, { n: number; at: number }>;
  dns?: Record<string, { v: number; at: number }>;
}

/**
 * 估算一个值落进 storage 后的字节数（加密后）。
 *
 * 为什么要估而不是量：`put` 一旦超限就抛错，而抛错时内存已经改过 —— 只能提前算。
 * `seal()` 的开销是「明文 JSON × 4/3 + 固定头」，没有 kek 时按明文长度算（测试与本地桩）。
 * @param {Env | null} env 绑定环境（取 `kek` 判断是否加密）
 * @param {unknown} obj 待封对象
 * @returns {number} 预计字节数
 */
export function estSize(env: Env | null, obj: unknown): number {
  const text = JSON.stringify(obj) || "";
  if (!env || !env.kek) return text.length;
  return Math.ceil((text.length * 4) / 3) + 40;
}

/**
 * 把一个分片里的表按「最旧先丢」削到预算内（就地修改）。
 *
 * 为什么要这么做：`dns`/`blk2` 的条数上限（512/1024）是按行数定的，而主机名最长 253 字节 ——
 * 条数没超、字节却超了。这里按 `at`/`t` 升序（裸数字行按数值本身）每轮丢四分之一，直到装下；
 * 一行都丢不掉时立刻退出，避免死循环。
 * @param {Env | null} env 绑定环境
 * @param {Record<string, Record<string, unknown>>} bag 一个分片里的表集合
 * @returns {void}
 */
export function fitBag(env: Env | null, bag: Record<string, Record<string, unknown>>): void {
  let guard = 0;
  while (estSize(env, bag) > VALUE_MAX && guard < 24) {
    guard += 1;
    let dropped = 0;
    for (const name of Object.keys(bag)) {
      const tbl = bag[name];
      const keys = Object.keys(tbl);
      if (keys.length <= 1) continue;
      // 行可能是对象（`at`/`t`），也可能是老格式的裸数字（判定表只存到期时间）
      const atOf = (k: string): number => {
        const row = tbl[k];
        if (typeof row === "number") return row;
        const o = row as { at?: number; t?: number } | null;
        return Number((o && (o.at ?? o.t)) || 0) || 0;
      };
      keys.sort((a, b) => atOf(a) - atOf(b));
      const cut = Math.max(1, Math.floor(keys.length / 4));
      for (const k of keys.slice(0, cut)) {
        delete tbl[k];
        dropped += 1;
      }
    }
    if (!dropped) break;
  }
}

/** 一次写盘需要的最小接口：只要 `put`/`delete`，不依赖整个 `DurableObjectState` */
interface MiniStore {
  put: (k: string, v: unknown) => Promise<unknown>;
  delete: (k: string) => Promise<unknown>;
}

/**
 * 把账本写进 DO storage（装得下就单键，装不下按体积拆片）。
 *
 * 布局：热状态（`c/g/s/e/cl`）永远一个值 `a`；七张事实表装得下就并进 `a`，装不下才拆
 * `f1={vt,hl}` / `f2={eg,ps,dead}` / `f3={blk2,dns}`。退回单键时会删残片 —— 否则下次恢复
 * 会读到两份互相覆盖的旧表。
 * @param {Env | null} env 绑定环境
 * @param {MiniStore} st DO storage（只用到 `put`/`delete`）
 * @param {MeterStore} parts 当前全部账本字段
 * @returns {Promise<void>}
 */
export async function saveState(env: Env | null, st: MiniStore, parts: MeterStore): Promise<number> {
  const hot = { c: parts.c, g: parts.g, s: parts.s, e: parts.e, cl: parts.cl };
  const whole = { ...hot, vt: parts.vt, hl: parts.hl, eg: parts.eg, ps: parts.ps, dead: parts.dead, blk2: parts.blk2, dns: parts.dns };
  if (estSize(env, whole) <= VALUE_MAX) {
    // `fs: 0` = 事实就在这个值里（没有分片）。删残片失败时靠这个 0 把残留分片判成过期的
    await st.put("a", await seal(env as Env, { ...whole, fs: 0 }));
    for (const k of SHARD_KEYS) await st.delete(k);
    return 0;
  }
  const f1: Record<string, Record<string, unknown>> = { vt: parts.vt as unknown as Record<string, unknown>, hl: parts.hl as unknown as Record<string, unknown> };
  const f2: Record<string, Record<string, unknown>> = {
    eg: parts.eg as unknown as Record<string, unknown>,
    ps: parts.ps as unknown as Record<string, unknown>,
    dead: parts.dead as unknown as Record<string, unknown>,
  };
  const f3: Record<string, Record<string, unknown>> = {
    blk2: parts.blk2 as unknown as Record<string, unknown>,
    dns: parts.dns as unknown as Record<string, unknown>,
  };
  fitBag(env, f1);
  fitBag(env, f2);
  fitBag(env, f3);
  // 每片与 `a` 必须同号：删残片失败、或写完 `a` 就被杀，靠代号把上一轮的分片判成过期
  const fs = Date.now();
  await st.put("a", await seal(env as Env, { ...hot, fs }));
  await st.put("f1", await seal(env as Env, { fs, ...f1 }));
  await st.put("f2", await seal(env as Env, { fs, ...f2 }));
  await st.put("f3", await seal(env as Env, { fs, ...f3 }));
  return fs;
}

/**
 * 读出分片里的事实表（只在 `saveState()` 曾因体积拆过片时存在）。
 *
 * 为什么要单独一个函数：`blockConcurrencyWhile` 里的恢复有两条路径（新布局 `a`、老布局
 * `c/e/s/g`），分片对两条都适用，塞在任一条里都会让另一条漏读 —— 表现为「重启后事实全空」。
 * @param {Env | null} env 绑定环境
 * @param {MiniStore & { get: (k: string) => Promise<unknown> }} st DO storage
 * @returns {Promise<MeterStore>} 只含实际读到的表，缺的字段保持 `undefined`
 */
export async function readShards(
  env: Env | null,
  st: MiniStore & { get: (k: string) => Promise<unknown> },
  want: number,
): Promise<MeterStore> {
  const out: MeterStore = {};
  // `want` 是 `a` 里的代号：0（或缺失）说明事实已经在 `a` 里，任何分片都是上一轮的残留
  if (!want) return out;
  for (const key of SHARD_KEYS) {
    const raw = await st.get(key);
    if (!raw) continue;
    const o = await unseal<MeterStore>(env as Env, raw as never);
    if (!o || typeof o !== "object") continue;
    // 代号不同的分片是「删残片失败」留下的：用它覆盖 `a` 会让旧事实复活、新事实被顶掉
    if (Number(o.fs) !== want) continue;
    if (o.vt) out.vt = o.vt;
    if (o.hl) out.hl = o.hl;
    if (o.eg) out.eg = o.eg;
    if (o.ps) out.ps = o.ps;
    if (o.dead) out.dead = o.dead;
    if (o.blk2) out.blk2 = o.blk2;
    if (o.dns) out.dns = o.dns;
  }
  return out;

}
