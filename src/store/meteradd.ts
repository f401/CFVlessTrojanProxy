/**
 * `/add` 的合并逻辑：把一次上报的增量并进账本（用量、日计数、错误环、连接观测、四类事实）。
 *
 * 为什么从 `Meter` 里搬出来：这 160 行让 `src/store/meter.ts` 超出「单文件 ≤560 行」的硬上限，
 * 而它只读写字面字段、不碰 storage —— 挪成自由函数后 `Meter.handle()` 只剩「快照 → 合并 → 落盘 → 失败回滚」。
 * 想改合并口径的人只需要读这一个文件。
 */
import { mergeFacts } from "./factmerge";

/** 合并目标：`Meter` 公开的账本字段（结构化即可，不要求是 `Meter` 实例） */
export interface AddTarget {
  c: UsageMeter;
  g: CounterDoc;
  s: Record<string, NodeSnap>;
  e: ErrItem[];
  cl: ClRec[];
  vt: Record<string, number | { s: number; t: number }>;
  hl: Record<string, { o: number; b: number; d: number; t?: number }>;
  eg: Record<string, { f: number; at: number }>;
  ps: Record<string, { q: number; n: number; at: number; top?: number }>;
  dead: Record<string, { n: number; at: number }>;
  blk2: Record<string, { n: number; at: number }>;
  dns: Record<string, { v: number; at: number }>;
}

/**
 * 把一次 `/add` 上报的增量并进账本（纯内存，落盘由调用方负责）。
 * @param {AddTarget} m 账本
 * @param {MeterBody} d 上报体（`c`/`e`/`cl`/`vt`/`hl`/`spd`/事实表/`up`/`down`/`conns`）
 * @returns {void}
 */
export function applyAdd(m: AddTarget, d: MeterBody): void {
  const c = m.c;
  // 下面所有统计都写在这张表上：它同时是 `json()` 的响应体
      // 计数搭便车：同一次 /add 请求把 isolate 的日计数也带上来，0 额外请求
      if (d.c && typeof d.c === "object" && !Array.isArray(d.c)) {
        const d0 = String(d.c.d || new Date().toISOString().slice(0, 10));
        // 只接受"今天"或更新的一天：旧的 isolate 可能带着昨天的计数晚到，
        // 不能让它把全局日计数回滚到昨天，更不能把旧数加进今天。
        if (!m.g || !m.g.d || d0 > m.g.d) m.g = { d: d0 };
        if (m.g.d === d0) {
          for (const [k, v] of Object.entries(d.c)) {
            if (k === "d" || k === "__proto__" || k === "constructor" || k === "prototype") continue;
            if (!(Number(v) > 0)) continue;
            m.g[k] = (Number(m.g[k]) || 0) + Number(v);
          }
        }
      }
      if (Array.isArray(d.e) && d.e.length) {
        const seen = new Set(m.e.map((x) => x && x.t));
        for (const x of d.e) {
          if (!x || !x.t || seen.has(x.t)) continue;
          m.e.push(x);
          seen.add(x.t);
        }
        m.e.sort((a, b) => a.t - b.t);
        if (m.e.length > 50) m.e = m.e.slice(-50);
      }
      // 连接观测按节点合并（不同 isolate 各报一段）：计数相加，分位数取最新一段
      if (Array.isArray(d.cl) && d.cl.length) {
        // 时间戳必须严格大于表里已有的任何一条（v7.215）：同一毫秒里连着来两批时，
        // 时间戳相同会让排序退回插入序，「插得最早」的那条又被当成最旧的删掉 ——
        // 而它恰恰可能是样本最多的节点。取 max(now, 表内最大 + 1) 就永不并列。
        let clNow = Date.now();
        for (const r of m.cl) {
          const t0 = Number(r.t) || 0;
          if (t0 >= clNow) clNow = t0 + 1;
        }
        for (const x of d.cl) {
          if (!x || typeof x.n !== "number" || typeof x.k !== "string") continue;
          const old = m.cl.find((r) => r.k === x.k);
          if (old) {
            old.n += x.n;
            old.ok += x.ok;
            old.dn += x.dn;
            old.p50 = x.p50;
            old.p95 = x.p95;
            // 刷新时间戳（v7.215）：淘汰按它排序，活跃节点不能因为「插得早」先被删
            old.t = clNow;
          } else m.cl.push({ k: x.k, n: x.n, ok: x.ok, p50: x.p50, p95: x.p95, dn: x.dn, t: clNow });
        }
        if (m.cl.length > 60) {
          // 按最近更新时间淘汰（v7.215）：以前按插入序 slice(-60)，而合并是就地累加、不移动位置，
          // 于是「最先进来的、样本最多的那个节点」永远排在最前，表一满就先被删，
          // 一次性的新节点反而都留着。没有 t 的老行按 0 处理，最先淘汰（它们本来就是最旧的）。
          // 无 t 的老行全是 0，先按样本数少的淘汰（它们是升级前留下的、也确实更旧）
          m.cl.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0) || (a.n || 0) - (b.n || 0));
          m.cl = m.cl.slice(-60);
        }
      }
      // 中继 403 判定搭便车上来：只保留未过期的，最多 200 条。
      // 下面四段（vt / 事实 / hl / blk）以前被整块嵌在上面那个 d.cl 判断里：
      // 同一批没有连接观测时，DO 会静默丢掉它们，而发送侧照样 syncAck —— 增量就此蒸发。
      if (Array.isArray(d.vt) && d.vt.length) {
        for (const r of d.vt) {
          if (!r || typeof r.k !== "string" || typeof r.t !== "number") continue;
          if (r.t <= Date.now()) continue;
          // 状态必须一起存（v7.164）：只存到期时间的话，`dead` 读回来一律变 `blocked`，
          // `policy` 里的硬排除退化成 ×6 降权，一条连不上的中继会继续占 `connect()` 名额。
          // 合并口径：更晚到期的那条胜；同一时刻取更严格的状态（3 > 2）。
          const s = r.s === 3 ? 3 : 2;
          const old = m.vt[r.k];
          const oldT = typeof old === "number" ? old : old ? old.t : 0;
          const oldS = typeof old === "number" ? 2 : old ? old.s : 0;
          const t = Math.max(oldT, r.t);
          m.vt[r.k] = { s: t > oldT ? s : Math.max(oldS, s), t };
        }
        const ks = Object.keys(m.vt);
        if (ks.length > 200) {
          const expOf = (k: string): number => {
            const v = m.vt[k];
            return typeof v === "number" ? v : v.t;
          };
          ks.sort((a, b) => expOf(b) - expOf(a));
          for (const k of ks.slice(200)) delete m.vt[k];
        }
      }
      mergeFacts(m, d);
      // 中继存活度搭便车：加性合并（只增不减，避免别的 isolate 的旧数据把本地结论冲掉）
      if (Array.isArray(d.hl) && d.hl.length) {
        const nowHl = Date.now();
        for (const r of d.hl) {
          if (!r || typeof r.i !== "string") continue;
          const o0 = Number(r.o) || 0;
          const b0 = Number(r.b) || 0;
          const d0 = Number(r.d) || 0;
          const t0 = Math.min(Number(r.t) || nowHl, nowHl);
          const cur0 = m.hl[r.i];
          // 一条证据整体胜出（v7.181）：以前逐字段取 max，会把「三小时前 9 次成功」与
          // 「刚刚 6 次失败」拼成 { o:9, b:6, t:刚刚 } —— 一条从未发生过的证据，
          // 而客户端的 30 分钟半衰期正是按 t 算的，最容易过期的那批数据反而永远新鲜
          // （7.161 在客户端 merge 里修过同一形状，DO 这层漏了）。
          const inN = o0 + b0 + d0;
          const curN = cur0 ? cur0.o + cur0.b + cur0.d : -1;
          if (!cur0 || inN > curN || (inN === curN && t0 > (Number(cur0.t) || 0))) {
            m.hl[r.i] = { o: o0, b: b0, d: d0, t: t0 };
          }
        }
        const hk = Object.keys(m.hl);
        if (hk.length > 200) {
          // 留最新的 200 条（v7.181）：按插入顺序切会删掉刚写进来的那条，
          // 新中继的健康证据永远进不了表（同 7.177 的 pend 星形饥饿）。
          hk.sort((x, y) => (Number(m.hl[y].t) || 0) - (Number(m.hl[x].t) || 0));
          for (const k of hk.slice(200)) delete m.hl[k];
        }
      }
      if (d.spd && typeof d.spd === "object") {
        for (const [k, v] of Object.entries(d.spd)) {
          if (!v || typeof v !== "object") continue;
          if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
          const old = m.s[k];
          if (!old || (v.at || 0) >= (old.at || 0)) m.s[k] = v; // 新的覆盖旧的
        }
        // 池子每天换代，旧节点快照会无限累积；只留最近活跃的 64 个
        const sk = Object.keys(m.s);
        if (sk.length > 64) {
          sk.sort((a, b) => (m.s[a].at || 0) - (m.s[b].at || 0));
          for (let i = 0; i < sk.length - 64; i++) delete m.s[sk[i]];
        }
      }
      c.up += Number(d.up) || 0;
      c.down += Number(d.down) || 0;
      c.conns += Number(d.conns) || 0;
      // 当日字节：跨天自动清零。累计值 up/down 是订阅头用的（协议惯例），
      // 面板上的"今日"用这一份 —— 否则用户永远只看到历史总量。
      const today0 = new Date().toISOString().slice(0, 10);
      if (c.d !== today0) {
        c.d = today0;
        c.dU = 0;
        c.dD = 0;
      }
      c.dU = (c.dU || 0) + (Number(d.up) || 0);
      c.dD = (c.dD || 0) + (Number(d.down) || 0);
      c.ts = Date.now();
      if (!c.first) c.first = c.ts;
}
