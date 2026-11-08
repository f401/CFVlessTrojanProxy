/* 节点选择：挑谁 / 何时换 / 失败怎么办 */
class Selector {
/** 按国家挑一个节点（地区出口） */
async region(env: Env, cc) {
  const want = String(cc || "").toUpperCase();
  if (!want) return null;
  const list = await aliveList(env);
  const hit = list.filter((x) => String(x.cc || "").toUpperCase() === want && !isBlack(keyOf(x)));
  if (!hit.length) return null;
  hit.sort((a, b) => costOf(keyOf(a), "tput") - costOf(keyOf(b), "tput"));
  return hit[0];
}

/**
 * 选一个节点。
 *   ① 先看"这个站"的历史：有样本就按站点分选（hostCost）
 *   ② 冷启动（这个站试过的节点 <3）：一半概率去试一个没试过的
 *   ③ 都没有 → 回到全局游标 + 影子流量
 */
pick(env: Env, mode, st) {
  const m = mode === "lat" ? "lat" : "tput";
  const cur = S.curs[m] || bestFor(m);
  if (!cur) cnt("noCand");
  const host = st && st.host ? String(st.host) : "";
  if (st) st.hostTrial = false;

  if (host) {
    const tried = (S.hostNode.get(host) || new Map()).size;

    // ① 冷启动：头几次连接故意岔开，否则第一个碰上的节点会被永久锁死
    if (tried < 3 && !(st && st.retried) && Math.random() < (tried === 0 ? 1 : 0.5)) {
      const t = hostUntried(host, m);
      if (t) {
        nsGet(t).lastTry = Date.now();
        if (st) { st.hostTrial = true; st.node = t; }
        return t;
      }
    }

    // ② 有站点样本 → 按站点分选
    const rank = hostRank(host, m);
    if (rank.length) {
      const best = rank[0].k;
      const bs = (S.hostNode.get(host) || new Map()).get(best);
      // 样本够了才敢覆盖全局游标；只有 1 次样本时跟着走风险太大
      if (bs && bs.n >= 2) {
        // 稳定期留 2% 给次优节点，保持样本新鲜（不然一次侥幸定终身）
        if (rank.length > 1 && !(st && st.retried) && Math.random() < 0.02) {
          if (st) st.node = rank[1].k;
          return rank[1].k;
        }
        if (st) st.node = best;
        return best;
      }
    }
  }

  // ③ 全局：粘滞游标 + 影子流量
  const dual = (S.curs.lat ? 1 : 0) + (S.curs.tput ? 1 : 0);
  let base = Number(env && env.pxShadow);
  if (!Number.isFinite(base) || base < 0) base = 0.1;
  const ps = dual >= 2 ? base / 2 : base;
  const canTrial = !(st && st.retried);       // 已经是重试的请求，别再拿它试新节点
  if (cur && canTrial && ps > 0 && Math.random() < ps) {
    const t = this.trial(m);
    if (t) {
      const s = nsGet(t);
      s.lastTry = Date.now();
      if (st) { st.trial = true; st.node = t; }
      return t;
    }
  }
  if (st) st.node = cur;
  return cur;
}

/** 待测队列：样本不足的节点，最久没试的优先 */
trial(mode) {
  const pool = [];
  for (const k of S.alive.keys()) {
    if (k === S.curs[mode] || isBlack(k) || isFrozen(k)) continue;
    const a = (S.alive.get(k) || {}) as NodeEntry;
    if (!a.ms || a.ms > 250) continue;       // 只试"探活不慢"的节点，慢的试了只会更慢
    const s = (S.nstat.get(k) || {}) as NodeStats;
    const n = (s.okW || 0) + (s.failW || 0);
    if ((s.bytesDown || 0) >= SC.MIN_BYTES && n >= SC.TRIAL_N) continue;
    pool.push({ k, t: s.lastTry || 0 });
  }
  pool.sort((a, b) => a.t - b.t);
  return pool.length ? pool[0].k : "";
}

/** 重新评估是否该换节点（cron 与失败路径共用） */
maybeSwitch(env: Env, mode) {
  const m = mode === "lat" ? "lat" : "tput";
  const now = Date.now();
  const cur = S.curs[m];
  const cands = candsFor(m);
  if (!cands.length) return false;
  const best = cands[0];
  if (!cur) { S.curs[m] = best.k; S.lastSwitch[m] = now; return true; }
  if (isBlack(cur) || isFrozen(cur)) {
    S.prev[m] = cur; S.curs[m] = best.k; S.lastSwitch[m] = now;
    return true;
  }
  if (best.k === cur) return false;
  const cv = costOf(cur, m);
  const h = m === "tput" ? Math.max(1, cv * SC.H_TPUT) : Math.max(SC.H_LAT, cv * 0.15);
  if (cv - best.v <= h) return false;
  const dwell = m === "tput" ? SC.DWELL_TPUT : SC.DWELL;
  if (now - (S.lastSwitch[m] || 0) < dwell) return false;
  const hits = (S.switchHits[m] || []).filter((t) => now - t < 3600000);
  if (hits.length >= SC.BUDGET) { S.switchHits[m] = hits; return false; }
  hits.push(now);
  S.switchHits[m] = hits;
  S.prev[m] = cur;
  S.curs[m] = best.k;
  S.lastSwitch[m] = now;
  S.lastUp = now;
  cnt("sw");
  logErr(`switch(${m}) ${cur} -> ${best.k}`, "v=" + Math.round(cv) + ">" + Math.round(best.v));
  return true;
}

/**
 * 失败处理：记账 → 必要时回滚/换节点。
 * 影子连接的失败只记在该节点头上，不动主游标。
 * @param {object} env Worker 环境
 * @param {string} mode 模式
 * @param {string} k 节点
 * @param {boolean} trial 是否为影子连接
 * @returns {void}
 */
onFail(env: Env, mode, k, trial) {
  if (!k) return;
  nsFail(k);
  if (trial) { freezeNode(k); return; }
  const m = mode === "lat" ? "lat" : "tput";
  const prev = S.prev[m];
  const now = Date.now();
  if (k === S.curs[m] && prev && now - (S.lastSwitch[m] || 0) < SC.ROLL_WIN) {
    S.curs[m] = prev;
    S.prev[m] = "";
    S.lastSwitch[m] = now;
    freezeNode(k);
    logErr(`rollback(${m}) ${k} -> ${prev}`, "60s");
    return;
  }
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
async softFail(k) {
  if (k) nsFail(k);
}

/** 记一次失败；连续到阈值就换节点。兼容旧调用。 */
async bumpFail(env: Env, mode, k, trial) {
  S.pxFailSeen = 1;
  S.pxFailMem += 1;
  const node = k || S.curs[mode === "lat" ? "lat" : "tput"] || S.curs.tput || S.curs.lat || "";
  this.onFail(env, mode, node, !!trial);
  if (trial) return;                       // 影子连接失败不惩罚主游标
  const { fail, force } = pxPolicy(env);
  if (S.pxFailMem < fail) return;
  const n = S.pxFailMem;
  S.pxFailMem = 0;
  if (n >= force) { S.prev.tput = ""; S.prev.lat = ""; }
  this.maybeSwitch(env, "lat");
  this.maybeSwitch(env, "tput");
}

/** 链路健康：清零计数并把当前节点记为成功 */
async resetFail(env: Env, k) {
  if (!S.pxFailSeen) return;
  S.pxFailSeen = 0;
  S.pxFailMem = 0;
  const node = k || S.curs.tput || S.curs.lat || "";
  if (node) nsOk(node, 0, 0);
}

/** 当前节点（"auto" 模式才用池子；手动配置直接返回） */
async current(env: Env, mode, st) {
  const raw = String(env.proxyip || "").trim();
  if (!raw) return "";
  const m = mode === "lat" ? "lat" : "tput";
  if (raw.toLowerCase() !== "auto") {
    if (st) st.node = raw;
    return raw;
  }
  await pxGet(env);
  const k = this.pick(env, m, st);
  return k || "";
}

/**
 * 定时轮换：让"成绩接近"的前二名轮流吃真实流量，保证吞吐样本不全压在一个人身上。
 * @param {object} env Worker 环境
 * @returns {void}
 */
sched(env: Env) {
  const h = env.pxSchedH === undefined ? 6 : Number(env.pxSchedH) || 0;
  if (!(h > 0)) return;
  const last = Math.max(S.lastSwitch.lat || 0, S.lastSwitch.tput || 0, SEEDS.bucket().lastSwitch || 0);
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

/**
 * 一轮扫描：重建池子 → 探测候选 → 复测 alive → 重算游标 → 落盘。
 * @param {object} env Worker 环境
 * @returns {Promise<void>}
 */
}

const SEL = new Selector();
