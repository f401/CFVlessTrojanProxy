import { SELECTION_MEMORY } from "./selection-memory";
import { NODE_MEMORY } from "../core/node-memory";
import { POOL_MEMORY } from "./pool-memory";
// 挑路编排：池子就绪 → 站点画像 → 判定偏好 → 重扫。四段无独立生命周期，同文件一次看完换节点的原因。

import { ensurePool, pxGet, aliveList } from "./pool";
import { seedAlive } from "./warm";
import { shadowRate } from "../core/util";
import { hostKey, HOSTS } from "../nodes/metrics";
import { cnt } from "../core/counter";
import { costOf, isBlack, isFrozen, usable, NodeStatsTable, CANDS } from "../nodes/score";
import { ThompsonPicker } from "./ts";
import { relayIpOf } from "../core/relay-addr";
import { HOOK } from "../core/hook";
import { isCfIp } from "../core/net";
import { keyOf } from "./const";
import { QUALITY } from "./regions";
import { IpLevel } from "../core/enums";

// ---- 来自 pick-types.ts ----
/** 一次请求的上下文：站点、已选节点、是否已重试过、目标流量 */
export interface PickState {
  /** 目标站点（判定表与站点偏好的键） */
  host?: string;
  /** 已选中的候选键 `host:port`（重试时作为排除项） */
  node?: string;
  /** 本轮是否是「本站点第一次试这条」 */
  hostTrial?: boolean;
  /** 已经重试过一次（第二次失败就换节点而不是原地再试） */
  retried?: boolean;
  /** 这次要传多少字节（代价函数按它定价） */
  targetBytes?: number;
}

// ---- 来自 pick-ready.ts ----
// 候选池准备：冷 isolate 里内存池是空的（新机房 / 刚回收），而候选池早就由别的机房提交进了 KV。
// 这一步只做「让池子能用」，不参与挑谁 —— 挑在 pick-site / pick-pref / pickpath 三处。

/**
 * 功能：按需把候选池拉起来，并保证存活表至少被起搏过一次。
 * 所有等待都有上限：这里任何一秒都是用户等首字节的秒数。
 * @param {object} env Worker 环境
 * @returns {Promise<void>} 池子可用（或已尽力）时 resolve
 */
export async function ensureReady(env: Env): Promise<void> {
  // 只看「池子确实没有」且距上次尝试超过 60 秒：池子有就绝不读 KV，冷启动也不会每个请求都读一次
  if (!POOL_MEMORY.rows.length && Date.now() - (POOL_MEMORY.lastAttemptAt || 0) > 60000) {
    POOL_MEMORY.lastAttemptAt = Date.now();
    // 最多等 700ms：ensurePool 会读 KV 代际键，必要时还要去公开源抓列表，
    // 实测在冷 isolate 上能拖到 2–4 秒——那是用户已经在等首字节的时间，
    // 不能整段押在这里。超时就先放行（有 NODE_MEMORY.alive 就用，没有就走直连），
    // 让后台继续把池子补齐，下一条连接就能用上。
    await Promise.race([
      ensurePool(env).catch(() => 0),
      new Promise<void>((r) => setTimeout(r, 700)),
    ]);
  }
  // 池子有了但一条都没探活过：就地起搏几个（5 分钟节流），否则 relays() 只能回空，
  // CF 托管目标会一路直连下去。**不 await**：探活会占 300–2200ms，挡在首字节前面
  // 会把 p50 拖到 6 秒（实测 7.63）。7.67 曾试过「最多等 1500ms」，tput 仍是 10/20 而
  // p50 从 1.9s 涨到 3.1s —— 说明探活成功只证明「TCP 通」，不证明「出口是 v4」，
  // 等它没用。要按出口地址族排中继，得在探测时顺便问中继「你出去是什么地址」。
  if (!NODE_MEMORY.alive.size) void seedAlive(env).catch(() => {});
  // 补游标（`SELECTION_MEMORY.current`）与两代候选的关系：pxGet 是唯一入口，挑路之前必须调过一次
  await pxGet(env);
}

// ---- 来自 pick-site.ts ----
// 站点画像这一层：这个站历史上哪条最好、要不要给没试过的节点一次机会、以及抽到之后怎么避开在途过多的那条。
// 「候选池准备」（pick-ready）、「通道/入口偏好」（pick-pref）与「地区硬要求」（pickpath）都不在这里。

/**
 * 按站点画像挑一个候选：站点样本优先，其次冷启动影子，最后交给单层抽样器。
 * 收成类是为了让每一步能被单独观察（站点偏好 / 影子 / 抽样 / 粘滞），状态全在 `S` 里。
 */
export class SitePick {
  /**
   * 功能：选一个节点。
   *   ① 站点画像（`byProfile`）② 冷启动影子（`byShadow`）③ 单层抽样 + 负载溢出（`bySample`）
   *   ④ 兜底：粘滞游标 + 负载溢出 ⑤ 全池都冷却/冻结时返回「最不坏」的那条（不会是空串）
   * @param {object} env Worker 环境
   * @param {'lat'|'tput'} mode 选路模式
   * @param {object|null} st 连接状态（会写 st.node / st.hostTrial）
   * @returns {string} 候选键 `host:port`，全池不可用时返回「最不坏」的那条（不会是空串）
   */
  pick(env: Env, mode: Mode, st: PickState | null): string {
    const m = mode === "lat" ? "lat" : "tput";
    // 游标先对齐这一代候选池：它只做面板/健康展示，但④⑤两步的兜底要用它
    const cur = this.syncCursor(m);
    if (!cur) cnt("noCand");
    const host = st && st.host ? String(st.host) : "";
    if (st) st.hostTrial = false;
    // 画像按「域名族」存（api.x.com 与 pbs.twimg.com 共用 x.com），读写必须用同一个键
    const fam = host ? hostKey(host) : "";
    // ① 站点画像：命中就当场返回 —— 它比全局分数更懂这个站
    if (host && fam) {
      const prof = this.byProfile(host, fam, m, Date.now(), st);
      if (prof) return prof;
    }
    // ② 冷启动影子：只为把画像建起来，不参与选路
    if (host && fam) {
      const shadow = this.byShadow(env, cur, host, fam, m, st);
      if (shadow) return shadow;
    }
    // ③ 单层抽样 + 负载溢出
    const sampled = this.bySample(m, st);
    if (sampled) return sampled;
    // ④ 兜底：粘滞游标 + 负载溢出
    const back = cur ? this.spill(cur, m) || cur : "";
    if (back) {
      if (st) st.node = back;
      return back;
    }
    // ⑤ 返回「最早能恢复、代价最低」的那条：不能给空串，否则 session 直接判死（cnt("dead")），
    //    而池子里可能还有只是暂时被罚的节点 —— 宁可试一次再失败，也不要凭空判死。
    const last = this.leastBad(m);
    if (st) st.node = last;
    return last;
  }

  /**
   * 功能：把游标对齐到这一代候选池 —— 池子换代之后不要把连接拨到已经消失的地址。
   * @param {'lat'|'tput'} mode 选路模式
   * @returns {string} 可用的游标键；池子里一条都没有时返回空串
   */
  private syncCursor(mode: Mode): string {
    let cur = SELECTION_MEMORY.current[mode];
    // 游标可能是上一代候选池里的节点（池子刷新后 alive 里已没有它）：以前会一直把连接拨到
    // 这个死地址，直到 cron 的 maybeSwitch 才发现。它只做面板展示，真正走谁由③决定。
    if (!cur || !NODE_MEMORY.alive.has(cur) || isBlack(cur) || isFrozen(cur)) {
      cur = CANDS.best(mode);
      SELECTION_MEMORY.current[mode] = cur;
    }
    return cur;
  }

  /**
   * 功能：按站点画像挑一条 —— 至少 3 个节点有样本、且首选样本不超过 2 小时才敢覆盖全局。
   * @param {string} host 目标站点（原始写法，画像查询用）
   * @param {string} fam 站点族键（`hostKey(host)`，读写 `HOSTS.nodes` 用）
   * @param {'lat'|'tput'} mode 选路模式
   * @param {number} now 当前时间
   * @param {object|null} st 连接状态（会写 st.node）
   * @returns {string} 挑中的候选键；画像不够用时返回空串（交回调用方继续往下走）
   */
  private byProfile(host: string, fam: string, mode: Mode, now: number, st: PickState | null): string {
    const hm = HOSTS.nodes.get(fam);
    const tried = hm ? hm.size : 0;
    // 少于 3 个节点有样本时排序没有比较意义（下面也要求 sampled>=3），
    // 直接跳过：省掉一次遍历全部节点的 hostRank 构建。
    if (tried < 3) return "";
    const rank = HOSTS.rank(host, mode);
    if (!rank.length) return "";
    const best = rank[0].k;
    const bs = hm!.get(best);
    // 至少 3 个节点有样本、且首选样本不超过 2 小时，才敢用站点偏好覆盖全局
    let sampled = 0;
    for (const s of hm!.values()) if (s.n > 0) sampled++;
    const fresh = now - (bs ? bs.at || 0 : 0) <= 2 * 3600e3;
    if (!bs || bs.n <= 0 || sampled < 3 || !fresh) return "";
    // 稳定期留 2% 给次优节点保持样本新鲜；但差太多不换 —— 那不是「保鲜」，是主动跳坑。
    const second = rank[1];
    if (second && second.v <= rank[0].v * 1.3 + 100 && !(st && st.retried) && Math.random() < 0.02) {
      if (st) st.node = second.k;
      return second.k;
    }
    if (st) st.node = best;
    return best;
  }

  /**
   * 功能：冷启动影子 —— 这个站还没攒够节点样本时，按影子预算试一个没试过的节点。
   * @param {object} env Worker 环境
   * @param {string} cur 当前游标（没有候选时不投影子，省得白试一条）
   * @param {string} host 目标站点
   * @param {string} fam 站点族键
   * @param {'lat'|'tput'} mode 选路模式
   * @param {object|null} st 连接状态（会写 st.node / st.hostTrial）
   * @returns {string} 试的那条候选键；不在影子档期、或画像已够、或没有未试过的节点时返回空串
   */
  private byShadow(env: Env, cur: string, host: string, fam: string, mode: Mode, st: PickState | null): string {
    const base = shadowRate(env);
    // ①②的随机数消耗顺序必须固定：影子这一步排在站点画像之后、抽样之前
    if (!(cur && base > 0 && !(st && st.retried) && Math.random() < base)) return "";
    const hm = HOSTS.nodes.get(fam);
    if (hm && hm.size >= 3) return "";
    const t0 = HOSTS.untried(host, mode);
    if (!t0) return "";
    // 记下试过的时间：`HOSTS.untried` 下次就会跳过它，影子预算因此能轮到别的节点
    NodeStatsTable.nsGet(t0).lastTry = Date.now();
    if (st) {
      st.hostTrial = true;
      st.node = t0;
    }
    return t0;
  }

  /**
   * 功能：单层抽样（完整分数 ± 不确定性）并按在途数做负载溢出。
   * @param {'lat'|'tput'} mode 选路模式
   * @param {object|null} st 连接状态（读 st.targetBytes，写 st.node）
   * @returns {string} 选中的候选键；抽样器没有候选时返回空串
   */
  private bySample(mode: Mode, st: PickState | null): string {
    const pick = new ThompsonPicker(mode, (st && st.targetBytes) || 0).pick();
    if (!pick) return "";
    // 负载感知：抽中的节点在途多时，换到分数接近、在途更少的候选
    const chosen = this.spill(pick, mode) || pick;
    if (st) st.node = chosen;
    return chosen;
  }

  /**
   * 功能：负载溢出 —— 指定节点在途 ≥2 时换到代价相近、在途更少的候选。
   * @param {string} key 当前选中的候选键
   * @param {'lat'|'tput'} mode 选路模式
   * @returns {string} 替代候选键；不需要换或换不到时返回空串
   */
  private spill(key: string, mode: Mode): string {
    // 在途少于 2 条时不用管：两条并发的上限就是免费计划的常态
    if (!key || (NODE_MEMORY.inflight.get(key) || 0) < 2) return "";
    const cur = costOf(key, mode);
    let alt = "";
    let bv = Infinity;
    // 只在候选表前 8 条里找：更靠后的候选本来就慢，换过去是「换个人排队」不是「少排队」
    for (const x of CANDS.list(mode).slice(0, 8)) {
      if (x.k === key) continue;
      // 代价超过 1.5 倍就宁可排队：溢出的目的是削峰，不是把流量送给慢节点
      if (x.v > cur * 1.5) continue;
      // 只在「确实比当前更空」时换，否则会在两个同样忙的节点间来回弹
      if ((NODE_MEMORY.inflight.get(x.k) || 0) >= (NODE_MEMORY.inflight.get(key) || 0)) continue;
      if (x.v < bv) {
        bv = x.v;
        alt = x.k;
      }
    }
    return alt;
  }

  /**
   * 功能：兜底 —— 冷却期里挑最不坏的（先比恢复时间，再比代价）。
   * @param {'lat'|'tput'} mode 选路模式
   * @returns {string} 候选键；池子为空时返回空串
   */
  private leastBad(mode: Mode): string {
    let best = "";
    let bk = Infinity;
    let bs = Infinity;
    // 遍历存活表而不是候选表：候选表是「可用」的排序结果，这里恰恰是它们全都不可用的时候
    for (const k of NODE_MEMORY.alive.keys()) {
      const s = NODE_MEMORY.stats.get(k);
      // 冷却有两种（判死 / 冻结），取更晚的那个作为「最早能再试」的时刻
      const until = Math.max(s ? s.blackUntil : 0, s ? s.freeUntil : 0);
      const v = costOf(k, mode);
      // 先比恢复时间（早恢复的先试），同刻再比代价 —— 与 `ranked` 的口径一致，只是不看可用性
      if (until < bk || (until === bk && v < bs)) {
        best = k;
        bk = until;
        bs = v;
      }
    }
    return best;
  }
}

// ---- 来自 pick-pref.ts ----
// 「偏好」这一层：判定层的否决（已判封锁的通道别拨）、入口族偏好（非 CF 出口优先）、
// 站点通道偏好（这条中继对这个站已判死就换一条），以及拨号重试要的「排除已试过的那条」。
// 这些偏好都不改代价函数，只在代价可比的范围内换一条；它们与站点画像（pick-site）互不影响。


/**
 * 偏好过滤：每条方法只回答「按这条规则，下一个该是谁」。
 * 它们都读 `NODE_MEMORY.alive` / `NODE_MEMORY.stats`，但都不写 —— 落选不惩罚、不冷却，那是 failbook 的事。
 */
export class PathPrefs {
  /**
   * 功能：判定层是否否决了这条通道（该通道对这个站已被实测判死）。
   * @param {string} host 目标站点（空串表示没有站点上下文，一律不否决）
   * @param {string} key 候选键 `host:port`
   * @returns {boolean} 是否否决
   */
  vetoed(host: string, key: string): boolean {
    const vet = HOOK.veto;
    return vet && host ? vet(host, relayIpOf(key)) : false;
  }

  /**
   * 功能：按「站点偏好」挑一条（判定层说这条中继能过这个站）。
   * @param {string} host 目标站点
   * @param {'lat'|'tput'} mode 选路模式
   * @param {boolean} cfOnly 目标是否 CF 托管（是则先跳过 CF 边缘中继）
   * @param {Set<string>|null} exclude 已经试过的候选键
   * @returns {string} 候选键；没有符合条件的返回空串
   */
  byPrefer(host: string, mode: Mode, cfOnly: boolean, exclude: Set<string> | null): string {
    const prefer = HOOK.prefer;
    if (!prefer) return "";
    const now = Date.now();
    let best = "";
    let bv = Infinity;
    for (const k of NODE_MEMORY.alive.keys()) {
      // 已试过的那条要跳过：pFail 惩罚不足以让它在同一秒内掉出第一
      if (exclude && exclude.has(k)) continue;
      if (isBlack(k) || isFrozen(k) || this.vetoed(host, k)) continue;
      const ip = relayIpOf(k);
      if (cfOnly && isCfIp((NODE_MEMORY.alive.get(k) || { h: "" } as { h?: string }).h || "")) continue;
      if (!prefer(host, ip)) continue;
      const v = costOf(k, mode, now);
      if (v < bv) {
        bv = v;
        best = k;
      }
    }
    return best;
  }

  /**
   * 功能：判定层是否要求「优先非 CF 出口」（CF 托管站点才需要）。
   * @returns {boolean} true 表示要优先非 CF 出口
   */
  nonCfFirst(): boolean {
    const fn = HOOK.nonCfFirst;
    return fn ? fn() : false;
  }

  /**
   * 功能：非 CF 出口里最便宜的那条（CF 托管站点的判定依据是出口 IP 族）。
   * 调用方负责判断「值不值得」——与全局最优差太多时不换，否则等于主动跳坑。
   * @param {string} host 目标站点（判定层的否决键；空串表示没有站点上下文）
   * @param {'lat'|'tput'} mode 选路模式
   * @param {Set<string>|null} exclude 已经试过的候选键
   * @returns {string} 候选键；没有非 CF 出口时返回空串
   */
  byNonCf(host: string, mode: Mode, exclude: Set<string> | null): string {
    const now = Date.now();
    let nk = "";
    let nv = Infinity;
    for (const [rk, a] of NODE_MEMORY.alive) {
      if (exclude && exclude.has(rk)) continue;
      if (isCfIp(a.h) || isBlack(rk) || isFrozen(rk) || this.vetoed(host, rk)) continue;
      const v = costOf(rk, mode, now);
      if (v < nv) {
        nv = v;
        nk = rk;
      }
    }
    if (!nk) return "";
    // 只有与全局最优可比时才用（1.5 倍 + 50ms 带内），否则优势不足以抵消「量过的那条更快」
    const top = CANDS.list(mode)[0];
    const av = top ? top.v : Infinity;
    return nv <= av * 1.5 + 50 ? nk : "";
  }

  /**
   * 功能：拨号重试要的「下一条」——抽到的正好是刚失败那条时，按通用分数重扫一遍。
   * 这里不看站点偏好与入口族偏好，只求「换一条能连的」，否则第二次尝试等于空转 2.5 秒。
   * @param {string} host 目标站点（判定层的否决键；空串表示没有站点上下文）
   * @param {'lat'|'tput'} mode 选路模式
   * @param {boolean} cfOnly 目标是否 CF 托管
   * @param {Set<string>} exclude 已经试过的候选键（至少一条）
   * @returns {string} 候选键；全被排除时返回空串
   */
  rescan(host: string, mode: Mode, cfOnly: boolean, exclude: Set<string>): string {
    const now = Date.now();
    let bk = "";
    let bv = Infinity;
    // 扫的是存活表而不是候选表：候选表已经按「可用」截过，被排除的那条可能就在前面占位
    for (const [k, a] of NODE_MEMORY.alive) {
      if (exclude.has(k) || isBlack(k) || isFrozen(k) || this.vetoed(host, k)) continue;
      // CF 托管目标上，CF 边缘中继第二轮大概率还是 403，白等第二个 2.5 秒
      if (cfOnly && isCfIp(a.h)) continue;
      const v = costOf(k, mode, now);
      if (v < bv) {
        bv = v;
        bk = k;
      }
    }
    return bk;
  }

  /**
   * 功能：这条通道对当前站点的实测结论是不是「还没被判死」。
   * @param {string} host 目标站点
   * @param {string} key 候选键
   * @returns {boolean} true 表示可用（打得通 0 与没测过 1 都算可用 —— 未知不等于坏）
   */
  chanOpen(host: string, key: string): boolean {
    const cp = HOOK.chanPref;
    if (!cp) return true;
    return cp(relayIpOf(key), host) < 2;
  }

  /**
   * 功能：换一条没被判死的通道（站点偏好替身）。
   * @param {string} host 目标站点
   * @param {'lat'|'tput'} mode 选路模式
   * @param {Set<string>|null} exclude 已经试过的候选键
   * @returns {string} 候选键；没有符合条件的返回空串
   */
  byChan(host: string, mode: Mode, exclude: Set<string> | null): string {
    const cp = HOOK.chanPref;
    if (!cp) return "";
    let best = "";
    let bv = Infinity;
    // 这里用的是候选表：换通道时仍然要按「代价」挑，而不是随便找一条没被判死的
    for (const x of CANDS.list(mode)) {
      if (exclude && exclude.has(x.k)) continue;
      if (isBlack(x.k) || isFrozen(x.k)) continue;
      // chanPref ≥ 2 就是「这条中继对这个站已被实测判死（403/不可达）」
      if (cp(relayIpOf(x.k), host) >= 2) continue;
      if (x.v < bv) {
        bv = x.v;
        best = x.k;
      }
    }
    return best;
  }
}

// ---- 编排与门面 ----
// 挑哪一个候选：地区硬要求（?rg=）、正常请求（站点画像 → 抽样 → 偏好），以及「这条连接当时选的是谁」。
// 三层住在三个文件里：候选池准备在 ./pick-ready，画像与抽样在 ./pick-site，偏好过滤在 ./pick-pref；
// 「什么时候换」在 ./rotation，「失败怎么记」在 ./failbook。这个文件只做编排与地区硬要求。



/**
 * 挑候选的执行器：`region`（地区硬要求）与 `current`（正常请求）。
 * 它自己不写任何统计：画像与抽样在 `SitePick`，偏好过滤在 `PathPrefs`，池子在 `ensureReady`。
 */
export class PickPath {
  /** 站点画像与抽样（无自有状态，全部读 `S`；7.345 起由门面持有，不再是模块级单例） */
  readonly site = new SitePick();
  /** 偏好过滤（同上：判定否决、族偏好、通道偏好、排除已试过的那条） */
  readonly paths = new PathPrefs();
  /**
   * 功能：选一个节点（站点画像 → 冷启动影子 → 单层抽样 → 粘滞兜底），委托给 `SitePick`。
   * 唯一实例由 `Selector`（`SEL.picker`）持有；这里只定义行为，不再导出模块级单例。
   * @param {object} env Worker 环境
   * @param {'lat'|'tput'} mode 选路模式
   * @param {object|null} st 连接状态（会写 st.node / st.hostTrial）
   * @returns {string} 候选键 `host:port`
   */
  pick(env: Env, mode: Mode, st: PickState | null): string {
    return this.site.pick(env, mode, st);
  }

  /**
   * 按国家挑一个节点（地区硬要求：不回落到直连/全球）。
   * @param env Worker 环境 @param cc 两位国家码 @param mode 选路模式
   * @param avoid 要避开的候选键（重试时传上次那条）
   * @returns 存活表条目；该国无可用节点返回 null（上层 1011）
   */
  async region(env: Env, cc: string | null, mode: Mode = "tput", avoid = "") {
    const want = String(cc || "").toUpperCase();
    if (!want) return null;
    const list = await aliveList(env);
    // 冷却/冻结是硬排除：全国都不可用就返回 null，交给上层 1011
    const live = list.filter((x) => {
      const k = keyOf(x);
      return String(x.cc || "").toUpperCase() === want && k !== avoid && !isBlack(k) && !isFrozen(k);
    });
    if (!live.length) return null;
    // 低可用/空关闭可疑是软排除：全国只剩它们时仍然要选一个（地区是硬要求）
    const ok = live.filter((x) => usable(keyOf(x)));
    let pool = ok.length ? ok : live;
    // 质量分层：Good 优先、Risky 排除、Unknown 按 Normal；无 Good 才退回全池
    const nowQ = Date.now();
    const good = pool.filter((x) => QUALITY.getFor(x.h, x.p, nowQ)?.level === IpLevel.Good);
    const notRisky = pool.filter((x) => QUALITY.getFor(x.h, x.p, nowQ)?.level !== IpLevel.Risky);
    if (notRisky.length) pool = good.length ? good : notRisky;
    // 先算分（别在 sort 比较器里反复调 costOf），再在最优 1.5 倍内挑在途最少的
    const scored = pool.map((x) => ({ x, v: costOf(keyOf(x), mode) })).sort((a, b) => a.v - b.v);
    const band = scored.filter((r) => r.v <= scored[0].v * 1.5 + 50).slice(0, 8);
    let pick = band[0];
    let load = NODE_MEMORY.inflight.get(keyOf(pick.x)) || 0;
    for (const r of band) {
      const l = NODE_MEMORY.inflight.get(keyOf(r.x)) || 0;
      if (l < load) {
        pick = r;
        load = l;
      }
    }
    return pick.x;
  }

  /**
   * 功能：当前该走哪条候选（手动配置直接返回，auto 走池子）。
   * @param {object} env Worker 环境
   * @param {'lat'|'tput'} mode 选路模式
   * @param {object|null} st 连接状态（会写 st.node）
   * @param {string} host 目标站点（空串 = 没有站点上下文，只按通用分数挑）
   * @param {boolean} cfOnly 目标是否 CF 托管（是则跳过 CF 边缘中继）
   * @param {Set<string>|null} exclude 已经试过的 `host:port`（拨号重试要找「下一条」，
   *   不能把刚失败的同一条再挑回来 —— 这条链路的返回值在确定性路径下是每次都一样的）
   * @returns {Promise<string>} `host:port`，没有可选候选时返回空串
   */
  async current(
    env: Env,
    mode: Mode,
    st: PickState | null,
    host = "",
    cfOnly = false,
    exclude: Set<string> | null = null,
  ): Promise<string> {
    const raw = String(env.proxyip || "").trim();
    if (!raw) return "";
    const m = mode === "lat" ? "lat" : "tput";
    if (raw.toLowerCase() !== "auto") {
      if (st) st.node = raw;
      return raw;
    }
    await ensureReady(env);
    // 站点偏好：判定层说「这条中继能过这个站」时才用它，优先于画像与抽样
    if (host) {
      const hit = this.paths.byPrefer(host, m, cfOnly, exclude);
      if (hit) {
        if (st) st.node = hit;
        return hit;
      }
    }
    // 非 CF 出口优先，但只在分数可比时（1.5x + 50ms 带内）：CF 托管站点的
    // 判定依据是出口 IP 族，非 CF 中继才可能改变结果。偏好开关由判定层（Policy）给。
    if (host && this.paths.nonCfFirst()) {
      const nk = this.paths.byNonCf(host, m, exclude);
      if (nk) {
        if (st) st.node = nk;
        return nk;
      }
    }
    // 站点画像 → 抽样 → 粘滞兜底（都在 SitePick 里）
    const first = this.site.pick(env, m, st);
    // 拨号重试要的是「下一条」：抽到的正好是刚失败的那条时，直接按通用分数重扫一遍
    if (first && exclude && exclude.has(first)) {
      const bk = this.paths.rescan(host, m, cfOnly, exclude);
      if (bk) {
        if (st) st.node = bk;
        return bk;
      }
      return "";
    }
    // 站点通道偏好：该通道对当前站点已被实测判死（403/不可达）就换一条没被判死的，
    // 打得通（0）与没测过（1）都不降权 —— 未知不等于坏，否则新中继永远上不了场。
    if (!first || !host || this.paths.chanOpen(host, first)) return first || "";
    const best = this.paths.byChan(host, m, exclude);
    if (best) {
      if (st) st.node = best;
      return best;
    }
    return first;
  }
}


