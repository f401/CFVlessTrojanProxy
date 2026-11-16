interface PickState {
  host?: string;
  node?: string;
  hostTrial?: boolean;
  retried?: boolean;
  targetBytes?: number;
}

import { SC } from "../core/const";
import { HOOK } from "../core/hook";
import { isCfIp } from "../core/net";
import { shadowRate } from "../core/util";
import { hostKey, hostRank, hostUntried, logErr } from "../nodes/metrics";
import { MODES, keyOf } from "./const";
import { pickThom } from "./ts";
import { aliveList, ensurePool, pxGet } from "./pool";
import { seedAlive } from "./warm";
import { cnt } from "../core/counter";
import { pxPolicy } from "./probe";
import {
  bestFor,
  candsFor,
  costOf,
  freezeNode,
  isBlack,
  isFrozen,
  nsFail,
  nsGet,
  scoreParts,
  usable,
  nsSiteFail,
} from "../nodes/score";
import { S } from "../core/state";

/**
 * 切换后的最短驻留时间。pxDwellMin 只接受正数覆盖；未设置 / 0 / 非法时
 * 回落到模式默认值（lat 10 分钟、tput 20 分钟），避免"配了 0 却以为关掉了"。
 */
export function dwellOf(env: Env, mode: Mode) {
  const def = mode === "tput" ? SC.DWELL_TPUT : SC.DWELL;
  const raw = env && env.pxDwellMin;
  if (raw === undefined || raw === null || String(raw).trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n * 60000 : def;
}

/**
 * 节点选择器：把「挑哪台节点 / 什么时候换 / 失败怎么记」收在一处。
 *
 * 三条入口（生产代码只从这里走）：
 * · `pick` —— 正常请求：地区硬要求 → 站点偏好 → 单层抽样（`px/ts` 的 `pickThom`）；
 * · `region` —— `?rg=xx` 的地区通道，找不到就明确失败，绝不回落直连（否则用户拿到的不是该国 IP）；
 * · `softFail` / `bumpFail` —— 失败记账：站点级失败只进站点画像，节点级失败同时推进快速失败窗口。
 * 它自己不留跨请求状态（状态都在 `S` 里），收成类只是为了让每个步骤都能单独测。
 */
export class Selector {
  /** 按国家挑一个节点（地区硬要求：调用方不得回落到直连/全球） */
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
    const pool = ok.length ? ok : live;
    // 一次算分，别在 sort 比较器里反复调 costOf（30 个节点会算 150 次）
    const scored = pool.map((x) => ({ x, v: costOf(keyOf(x), mode) })).sort((a, b) => a.v - b.v);
    // 负载感知：最优代价 1.5 倍内挑在途最少的，避免全国连接全压在第一名
    const band = scored.filter((r) => r.v <= scored[0].v * 1.5 + 50).slice(0, 8);
    let pick = band[0];
    let load = S.inflight.get(keyOf(pick.x)) || 0;
    for (const r of band) {
      const l = S.inflight.get(keyOf(r.x)) || 0;
      if (l < load) {
        pick = r;
        load = l;
      }
    }
    return pick.x;
  }

  /**
   * 选一个节点。
   *   ① 先看"这个站"的历史：有样本就按站点分选（hostCost）
   *   ② 冷启动（这个站试过的节点 <3）：一半概率去试一个没试过的
   *   ③ 都没有 → 回到全局游标 + 影子流量
   */
  pick(env: Env, mode: Mode, st: PickState | null) {
    const m = mode === "lat" ? "lat" : "tput";
    const now = Date.now();
    let cur = S.curs[m];
    // 游标可能是上一代候选池里的节点：池子刷新后 alive 里已经没有它了。
    // 以前会一直把连接拨到这个死地址，直到 cron 的 maybeSwitch 才发现。
    // 游标只做面板/健康展示：真正走谁由 ③ 的单层抽样器决定。
    // 这里仍然维护游标，是为了面板/health 不显示一个已经死掉或冷却的节点。
    if (!cur || !S.alive.has(cur) || isBlack(cur) || isFrozen(cur)) {
      cur = bestFor(m);
      S.curs[m] = cur;
    }
    if (!cur) cnt("noCand");
    const host = st && st.host ? String(st.host) : "";
    if (st) st.hostTrial = false;

    // 画像按"域名族"存（api.x.com 与 pbs.twimg.com 共用 x.com），读写必须用同一个键
    const fam = host ? hostKey(host) : "";
    if (host && fam) {
      const hm = S.hostNode.get(fam);
      const tried = hm ? hm.size : 0;

      // ① 有站点样本 → 按站点分选。
      //    少于 3 个节点有样本时排序没有比较意义（门槛在下面也要求 sampled>=3），
      //    直接跳过：省掉一次遍历全部节点的 hostRank 构建。
      if (tried >= 3) {
        const rank = hostRank(host, m);
        if (rank.length) {
          const best = rank[0].k;
          const bs = hm!.get(best);
          // 至少 3 个节点有样本、且首选样本不超过 2 小时，才敢用站点偏好覆盖全局
          let sampled = 0;
          for (const s of hm!.values()) if (s.n > 0) sampled++;
          const fresh = now - (bs ? bs.at || 0 : 0) <= 2 * 3600e3;
          if (bs && bs.n > 0 && sampled >= 3 && fresh) {
            // 稳定期留 2% 给次优节点，保持样本新鲜（不然一次侥幸定终身）。
            // 但次优和首选差太多时不换：那不是"保持新鲜"，是主动跳坑。
            const second = rank[1];
            if (second && second.v <= rank[0].v * 1.3 + 100 && !(st && st.retried) && Math.random() < 0.02) {
              if (st) st.node = second.k;
              return second.k;
            }
            if (st) st.node = best;
            return best;
          }
        }
      }
    }

    // ② 冷启动：这个站还没攒够节点样本时，用影子流量补几条（只为站点画像，不参与选路）
    //    抽样器本身就带探索（样本少 ⇒ 乐观面大 ⇒ 自然被抽），这里只解决"新域名前几条连接
    //    全打同一个节点、画像建不起来"的问题，所以跟的是同一个 pxShadow 预算。
    const base = shadowRate(env);
    if (cur && base > 0 && !(st && st.retried) && host && fam && Math.random() < base) {
      const hm = S.hostNode.get(fam);
      if (!hm || hm.size < 3) {
        const t0 = hostUntried(host, m);
        if (t0) {
          nsGet(t0).lastTry = Date.now();
          if (st) {
            st.hostTrial = true;
            st.node = t0;
          }
          return t0;
        }
      }
    }

    // ③ 选路：单层抽样器（完整分数 ± 不确定性，两种模式共用同一套）
    const pick = pickThom(m, (st && st.targetBytes) || 0);
    if (pick) {
      let chosen = pick;
      // 负载感知：抽中的节点在途多时，换到分数接近、在途更少的候选
      if ((S.inflight.get(chosen) || 0) >= 2) {
        const cv = costOf(chosen, m);
        let alt = "",
          bv = Infinity;
        for (const x of candsFor(m).slice(0, 8)) {
          if (x.k === chosen) continue;
          if (x.v > cv * 1.5) continue;
          if ((S.inflight.get(x.k) || 0) >= (S.inflight.get(chosen) || 0)) continue;
          if (x.v < bv) {
            bv = x.v;
            alt = x.k;
          }
        }
        if (alt) chosen = alt;
      }
      if (st) st.node = chosen;
      return chosen;
    }
    // ⑤ 兜底：粘滞游标 + 负载溢出
    if (cur && (S.inflight.get(cur) || 0) >= 2) {
      const cv = costOf(cur, m);
      let alt = "",
        bv = Infinity;
      for (const x of candsFor(m).slice(0, 8)) {
        if (x.k === cur) continue;
        if (x.v > cv * 1.5) continue;
        if ((S.inflight.get(x.k) || 0) >= (S.inflight.get(cur) || 0)) continue;
        if (x.v < bv) {
          bv = x.v;
          alt = x.k;
        }
      }
      if (alt) cur = alt;
    }
    if (st) st.node = cur;
    if (cur) return cur;
    // ⑥ 全池都在冷却/冻结时的兜底：返回"最早能恢复、且代价最低"的那个，
    // 不能返回空串——空串会让 session 直接放弃这条连接（cnt("dead")），
    // 哪怕池子里还有一堆节点只是暂时被罚。宁可试一次再失败，也不要凭空判死。
    const last = this.leastBad(m);
    if (st) st.node = last;
    return last;
  }

  /** 兜底：冷却期里挑最不坏的（先比恢复时间，再比代价） */
  private leastBad(mode: Mode): string {
    // 冷却期兜底：先比谁最早恢复（until 小者优先），再比代价；两个都取不到就回空串
    let best = "",
      bk = Infinity,
      bs = Infinity;
    for (const k of S.alive.keys()) {
      const s = S.nstat.get(k);
      const until = Math.max(s ? s.blackUntil : 0, s ? s.freeUntil : 0);
      const v = costOf(k, mode);
      if (until < bk || (until === bk && v < bs)) {
        best = k;
        bk = until;
        bs = v;
      }
    }
    return best;
  }

  /** 重新评估是否该换节点（cron 与失败路径共用） */
  maybeSwitch(env: Env, mode: Mode) {
    const m = mode === "lat" ? "lat" : "tput";
    const now = Date.now();
    const cur = S.curs[m];
    const cands = candsFor(m);
    if (!cands.length) return false;
    const best = cands[0];
    if (!cur) {
      S.curs[m] = best.k;
      S.lastSwitch[m] = now;
      return true;
    }
    if (!S.alive.has(cur) || isBlack(cur) || isFrozen(cur)) {
      S.prev[m] = cur;
      S.curs[m] = best.k;
      S.lastSwitch[m] = now;
      return true;
    }
    if (best.k === cur) return false;
    // 滞回必须按"主项"算：总分里含 8000×pFail 的风险项，拿总分乘比例会让
    // 风险项把延迟差异整个吃掉（250ms 的老节点门槛高达 210ms，60ms 的新节点永远换不上）。
    const cp = scoreParts(cur, m);
    const cv = cp.score;
    const h =
      m === "tput" ? Math.max(1, cp.e10Ms * SC.H_TPUT) : Math.max(SC.H_LAT, cp.latencyMs * SC.H_LAT_REL);
    if (cv - best.v <= h) return false;
    const dwell = dwellOf(env, m);
    if (now - (S.lastSwitch[m] || 0) < dwell) return false;
    const hits = (S.switchHits[m] || []).filter((t) => now - t < 3600000);
    if (hits.length >= SC.BUDGET) {
      S.switchHits[m] = hits;
      return false;
    }
    hits.push(now);
    S.switchHits[m] = hits;
    S.prev[m] = cur;
    S.curs[m] = best.k;
    S.lastSwitch[m] = now;
    cnt("sw");
    logErr(`switch(${m}) ${cur} -> ${best.k}`, "v=" + Math.round(cv) + ">" + Math.round(best.v));
    return true;
  }

  /**
   * 失败处理：记账 → 必要时回滚/换节点。
   * 站点级试探（Connection.hostTrial）的失败只冻结它自己，不动主游标，也不进全局失败记忆。
   * @param {object} env Worker 环境
   * @param {string} mode 模式
   * @param {string} k 节点
   * @param {boolean} trial 是不是站点级试探（只有 hostTrial 会置位）
   * @returns {void}
   */
  onFail(_env: Env, mode: Mode, k: string, trial: boolean) {
  // 失败分三档：影子连接失败只冻结它自己；
  // 真连接失败先记全局（pFail 立刻上升），再决定「回滚到上一个」还是「重新排第一」
    if (!k) return;
    nsFail(k);
    // 影子连接只贡献一个样本，失败就冻结，别让它继续占探索名额
    if (trial) {
      freezeNode(k);
      return;
    }
    const m = mode === "lat" ? "lat" : "tput";
    const prev = S.prev[m];
    const now = Date.now();
    if (
      k === S.curs[m] &&
      prev &&
      S.alive.has(prev) &&
      !isBlack(prev) &&
      !isFrozen(prev) &&
      now - (S.lastSwitch[m] || 0) < SC.ROLL_WIN
    ) {
      S.curs[m] = prev;
      S.prev[m] = "";
      S.lastSwitch[m] = now;
      freezeNode(k);
      logErr(`rollback(${m}) ${k} -> ${prev}`, "60s");
      return;
    }
    // 回滚不成（prev 已坏 / 超出 ROLL_WIN）就重排第一：bestFor 会跳过黑名单与冻结，
    // 失败的节点交给 nsFail 的退避阶梯，不是在这里硬判死
    if (k === S.curs[m]) {
      const b = bestFor(m);
      if (b && b !== k) {
        S.prev[m] = k;
        S.curs[m] = b;
        S.lastSwitch[m] = now;
        logErr(`fail-switch(${m}) ${k} -> ${b}`, "");
      }
    }
  }

  /** 只记一次全局失败，不动游标也不冻结（站点级试探失败用） */
  async softFail(k: string) {
    // 站点级试探失败：只轻记全局，不动主游标
    if (k) nsSiteFail(k);
  }

  /** 记一次失败；连续到阈值就换节点。兼容旧调用。 */
  async bumpFail(env: Env, mode: Mode, k: string, trial: boolean, kind: "node" | "site" = "node") {
    if (kind === "site") {
      // 目标站侧的问题：不推进失败计数、不换全局游标，只轻记节点
      if (k) nsSiteFail(k);
      return;
    }
    const node = k || S.curs[mode === "lat" ? "lat" : "tput"] || S.curs.tput || S.curs.lat || "";
    this.onFail(env, mode, node, !!trial);
    if (trial) return; // 影子/站点试探失败不惩罚主游标，也不进全局失败记忆
    S.pxFailSeen = 1;
    S.pxFailMem += 1;
    const { fail, force } = pxPolicy(env);
    if (S.pxFailMem < fail) return;
    const n = S.pxFailMem;
    S.pxFailMem = 0;
    if (n >= force) {
      S.prev.tput = "";
      S.prev.lat = "";
    }
    this.maybeSwitch(env, "lat");
    this.maybeSwitch(env, "tput");
  }

  /** 链路健康：清零计数。成功样本由 Connection.flush 在收尾时统一记一次。 */
  async resetFail(_env: Env, _k: string) {
    if (!S.pxFailSeen) return;
    S.pxFailSeen = 0;
    S.pxFailMem = 0;
  }

  /**
   * 当前节点（"auto" 模式才用池子；手动配置直接返回）。
   * @param {object} env Worker 环境
   * @param {'lat'|'tput'} mode 选路模式
   * @param {object|null} st 连接状态（会写 st.node）
   * @param {string} host 目标站点（空串 = 没有站点上下文，只按通用分数挑）
   * @param {boolean} cfOnly 目标是否 CF 托管（是则跳过 CF 边缘中继）
   * @param {Set<string>|null} exclude 已经试过的 `host:port`（拨号重试要找「下一条」，
   *   不能把刚失败的同一条再挑回来 —— 这条链路的返回值在确定性路径下是每次都一样的）
   * @returns {string} `host:port`，没有可选候选时返回空串
   */
  async current(
    env: Env,
    mode: Mode,
    st: PickState | null,
    host = "",
    cfOnly = false,
    exclude: Set<string> | null = null,
  ) {
    const raw = String(env.proxyip || "").trim();
    if (!raw) return "";
    const m = mode === "lat" ? "lat" : "tput";
    if (raw.toLowerCase() !== "auto") {
      if (st) st.node = raw;
      return raw;
    }
    // 冷 isolate（新机房/刚回收）里内存池是空的，而候选池早就由别的机房提交进了 KV：
    // 这里按需从代际键拉一次，否则连上的第一个请求只能直连 —— 对 CF 托管目标就是必 403。
    // 节流 60 秒：池子确实没有时不要每个请求都读一次 KV。
    if (!S.pool.length && Date.now() - (S.poolAt || 0) > 60000) {
      S.poolAt = Date.now();
      // 最多等 700ms：ensurePool 会读 KV 代际键，必要时还要去公开源抓列表，
      // 实测在冷 isolate 上能拖到 2–4 秒——那是用户已经在等首字节的时间，
      // 不能整段押在这里。超时就先放行（有 S.alive 就用，没有就走直连），
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
    if (!S.alive.size) void seedAlive(env).catch(() => {});
    await pxGet(env);
    const vet = HOOK.veto;
    const bad = (k: string): boolean => (vet && host ? vet(host, k.slice(0, k.lastIndexOf(":"))) : false);
    if (host && HOOK.prefer) {
      const now = Date.now();
      let best = "";
      let bv = Infinity;
      for (const k of S.alive.keys()) {
        // 已试过的那条要跳过：pFail 惩罚不足以让它在同一秒内掉出第一
        if (exclude && exclude.has(k)) continue;
        if (isBlack(k) || isFrozen(k) || bad(k)) continue;
        const ip = k.slice(0, k.lastIndexOf(":"));
        if (cfOnly && isCfIp((S.alive.get(k) || { h: "" } as { h?: string }).h || "")) continue;
        if (!HOOK.prefer(host, ip)) continue;
        const v = costOf(k, m, now);
        if (v < bv) { bv = v; best = k; }
      }
      if (best) { if (st) st.node = best; return best; }
    }
    // 非 CF 出口优先，但只在分数可比时（1.5x + 50ms 带内）：CF 托管站点的
    // 判定依据是出口 IP 族，非 CF 中继才可能改变结果。偏好开关由判定层（Policy）给。
    if (host && HOOK.nonCfFirst && HOOK.nonCfFirst()) {
      const now = Date.now();
      let nk = "";
      let nv = Infinity;
      for (const [rk, a] of S.alive) {
        if (exclude && exclude.has(rk)) continue;
        if (isCfIp(a.h) || isBlack(rk) || isFrozen(rk) || bad(rk)) continue;
        const v = costOf(rk, m, now);
        if (v < nv) { nv = v; nk = rk; }
      }
      const top = candsFor(m)[0];
      const av = top ? top.v : Infinity;
      if (nk && nv <= av * 1.5 + 50) { if (st) st.node = nk; return nk; }
    }
    // CF 托管目标：优先非 CF 出口，但没有时必须允许 CF 边缘中继 ——
    // 直连经常被自家边缘丢掉，只有绕一次才拿得到响应（哪怕是 403）。
    const first = this.pick(env, m, st);
    // 拨号重试要的是「下一条」：抽到的正好是刚失败的那条时，直接按通用分数重扫一遍。
    // 这里不看站点偏好与入口族偏好，只求「换一条能连的」，否则第二次尝试等于空转 2.5 秒。
    if (first && exclude && exclude.has(first)) {
      const now2 = Date.now();
      let bk = "";
      let bv2 = Infinity;
      for (const [k2, a2] of S.alive) {
        if (exclude.has(k2) || isBlack(k2) || isFrozen(k2) || bad(k2)) continue;
        if (cfOnly && isCfIp(a2.h)) continue;
        const v2 = costOf(k2, m, now2);
        if (v2 < bv2) { bv2 = v2; bk = k2; }
      }
      if (bk) { if (st) st.node = bk; return bk; }
      return "";
    }
    // 站点偏好：该通道对当前站点已被实测判死（403/不可达）就换一条没被判死的，
    // 打得通（0）与没测过（1）都不降权 —— 未知不等于坏，否则新中继永远上不了场。
    const cp = HOOK.chanPref;
    if (!first || !cp || !host) return first || "";
    const ipOf = (k: string): string => k.slice(0, k.lastIndexOf(":"));
    if (cp(ipOf(first), host) < 2) return first;
    let best = "";
    let bv = Infinity;
    for (const x of candsFor(m)) {
      if (exclude && exclude.has(x.k)) continue;
      if (isBlack(x.k) || isFrozen(x.k)) continue;
      if (cp(ipOf(x.k), host) >= 2) continue;
      if (x.v < bv) { bv = x.v; best = x.k; }
    }
    if (best) { if (st) st.node = best; return best; }
    return first;
  }

  /** cron 扫描收尾：重算两个模式的游标，再做定时轮换 */
  afterScan(env: Env) {
    for (const m of MODES) this.maybeSwitch(env, m);
    this.sched(env);
  }

  /**
   * 定时轮换：让"成绩接近"的前二名轮流吃真实流量，保证吞吐样本不全压在一个人身上。
   * @param {object} env Worker 环境
   * @returns {void}
   */
  sched(env: Env) {
    const h = env.pxSchedH === undefined ? 6 : Number(env.pxSchedH) || 0;
    if (!(h > 0)) return;
    const seedBucket = (S.seed.byColo || {})[S.colo || "*"] || {};
    const last = Math.max(S.lastSwitch.lat || 0, S.lastSwitch.tput || 0, seedBucket.lastSwitch || 0);
    // 冷启动（还没有任何切换记录）不要轮换：否则第一条 cron 会把刚选出的第 1 名
    // 换成第 2 名，第 2 名因此拿到最初 10 分钟的全部样本，反过来把第 1 名永久压住。
    if (!last) return;
    if (Date.now() - last < h * 3600000) return;
    for (const m of MODES) {
      const cands = candsFor(m);
      if (cands.length < 2) continue;
      const bs = cands[0].v;
      const pair = cands.filter((x) => x.v <= bs * 1.3).slice(0, 2);
      if (pair.length < 2) continue;
      const next = S.curs[m] === pair[0].k ? pair[1].k : pair[0].k;
      if (!next || next === S.curs[m]) continue;
      const prev = S.curs[m];
      S.curs[m] = next;
      S.lastSwitch[m] = Date.now();
      S.prev[m] = prev;
      logErr(`sched(${m}) ${prev} -> ${next}`, "sched");
    }
    S.seedDirty = true;
  }

}

export const SEL = new Selector();

