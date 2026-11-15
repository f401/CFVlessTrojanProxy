import { mergeFacts } from "./factmerge";
import { seal, unseal } from "./index";
import { probeHttp80 } from "../core/http80";
import { probeTf } from "../core/tf";

/* do */
export class Meter {
  st: DurableObjectState;
  env: Env;
  c: UsageMeter;
  g: CounterDoc;
  s: Record<string, NodeSnap>;
  e: ErrItem[];
  /** 连接记录环形：最近 60 条，离线标定用 */
  cl: ClRec[];
  /** 键 `host|node` → 到期时间：这条中继对这个站点被按 IP 拒（403）的判定，跨 isolate 共享 */
  blk: Record<string, number>;
  vt: Record<string, number>;
  /** 中继存活度：ip → { o: ok, b: bad, d: dead, t: 最后观测时间 }（`t` 缺省表示 7.160 之前写入的老行） */
  hl: Record<string, { o: number; b: number; d: number; t?: number }>;
  /** 出口族事实：ip → { f: 4|6, at }。v8 §3 的 eg：只用于选路代价偏置，永不剔除候选 */
  eg: Record<string, { f: number; at: number }>;
  /** 「站点 × 中继」成功率事实：`站点|中继IP` → { q 0..255, n 样本数, at }。只折价，永不剔候选 */
  ps: Record<string, { q: number; n: number; at: number; top?: number }>;
  /** 中继「连不上」事实：IP → { n 连续失败次数, at }。判死才会影响选路，仅由连接层触发 */
  dead: Record<string, { n: number; at: number }>;
  /** DNS 事实：站点 → { v: 1 有 AAAA / 0 确证没有, at }。24 小时寿命，只用于代价乘数 */
  dns: Record<string, { v: number; at: number }>;
  /** 单 IP 封锁事实：`host|relay` → { n 批数, at }。只影响代价（×6），从不剔候选 */
  blk2: Record<string, { n: number; at: number }>;
  /** 请求串行队列：/add 与 /set 交错会让内存和 storage 的顺序不一致 */
  q: Promise<unknown> = Promise.resolve();
  /**
   * 构造：从 storage 恢复累计值；blockConcurrencyWhile 保证恢复完成前不处理请求。
   * @param {DurableObjectState} state DO 状态对象（storage / blockConcurrencyWhile）
   */
  constructor(state: DurableObjectState, env: Env) {
    this.st = state;
    this.env = env;
    this.c = { up: 0, down: 0, conns: 0, first: 0, ts: 0, d: "", dU: 0, dD: 0 };
    this.g = { d: "" }; // 全局日计数（连接/走节点/断流…）
    // 节点 key 来自 ?spd 的外部快照：用 null 原型，`__proto__` 当键也不能改原型
    this.s = Object.create(null) as Record<string, NodeSnap>;
    this.e = []; // 跨 isolate 的错误环形（最多 50 条）
    this.cl = []; // 连接记录环形（最多 60 条）：离线标定 ttfb/抖动用
    this.blk = {};
    this.vt = {};
    this.hl = {};
    this.eg = {};
    this.ps = {};
    this.dead = {};
    this.dns = {};
    this.blk2 = {};
    this.st.blockConcurrencyWhile(async () => {
      // 单键存储：每次 /add 只写 1 行。
      // 以前是 c/g/s/e 四个键 = 4 行，SQLite DO 的「行写入」额度（免费 10 万/天）
      // 会被吃掉 4 倍；一个持续活跃的 isolate 就要 3.4 万行/天。
      const all = await this.st.storage.get("a");
      if (all) {
        const o = await unseal<MeterBody>(env, all);
        if (o && typeof o === "object") {
          if (o.c && typeof o.c === "object") this.c = { ...this.c, ...o.c };
          if (o.g && typeof o.g === "object") this.g = o.g as CounterDoc;
          if (o.s && typeof o.s === "object") this.s = Object.assign(Object.create(null), o.s);
          if (Array.isArray(o.e)) this.e = o.e;
          if (Array.isArray(o.cl)) this.cl = o.cl as ClRec[];
    if (o.blk && typeof o.blk === "object") this.blk = o.blk as Record<string, number>;
    if (o.vt && typeof o.vt === "object") this.vt = o.vt as unknown as Record<string, number>;
    if (o.hl && typeof o.hl === "object") this.hl = o.hl as unknown as Record<string, { o: number; b: number; d: number; t?: number }>;
    if (o.eg && typeof o.eg === "object") this.eg = o.eg as unknown as Record<string, { f: number; at: number }>;
    if (o.ps && typeof o.ps === "object") this.ps = o.ps as unknown as Record<string, { q: number; n: number; at: number; top?: number }>;
    if (o.dead && typeof o.dead === "object") this.dead = o.dead as unknown as Record<string, { n: number; at: number }>;
    if (o.dns && typeof o.dns === "object") this.dns = o.dns as unknown as Record<string, { v: number; at: number }>;
    if (o.blk2 && typeof o.blk2 === "object") this.blk2 = o.blk2 as unknown as Record<string, { n: number; at: number }>;
        }
        return;
      }
      // 老结构（c/e/s/g 四个键）：读出来顺手迁到新键，再删掉旧的
      let migrated = false;
      const v = await this.st.storage.get("c");
      if (v) {
        const obj = await unseal<Record<string, number>>(env, v); // 兼容老的明文对象
        if (obj) {
          this.c = { ...this.c, ...obj };
          migrated = true;
        }
      }
      const ev = await this.st.storage.get("e");
      if (ev) {
        const o4 = await unseal<ErrItem[]>(env, ev);
        if (Array.isArray(o4)) {
          this.e = o4;
          migrated = true;
        }
      }
      const sv = await this.st.storage.get("s");
      if (sv) {
        const o3 = await unseal<Record<string, NodeSnap>>(env, sv);
        if (o3 && typeof o3 === "object") {
          this.s = Object.assign(Object.create(null), o3);
          migrated = true;
        }
      }
      const gv = await this.st.storage.get("g");
      if (gv) {
        const obj2 = await unseal<Record<string, number>>(env, gv);
        if (obj2 && typeof obj2 === "object") {
          this.g = obj2 as CounterDoc;
          migrated = true;
        }
      }
      if (migrated) {
        try {
          await this.save();
          for (const k of ["c", "e", "s", "g"]) await this.st.storage.delete(k);
        } catch (e) {}
      }
    });
  }

  /**
   * 把当前计数加密后写进 DO storage（存储里看不到任何明文）。
   * @returns {Promise<void>}
   */
  async save() {
    // 一次 put = 一行。四个字段塞进一个对象，行写入直接 ÷4。
    await this.st.storage.put(
      "a",
      await seal(this.env, { c: this.c, g: this.g, s: this.s, e: this.e, cl: this.cl, blk: this.blk, vt: this.vt, hl: this.hl, eg: this.eg, ps: this.ps, dead: this.dead, blk2: this.blk2, dns: this.dns }),
    );
  }

  /**
   * 把当前累计值序列化成 JSON 响应。
   * @returns {Response} 200 + {up, down, conns, first, ts}
   */
  json() {
    return Response.json(this.c);
  }

  /**
   * DO 的请求入口：/add 累加增量、/seed 首次回填、/reset 清零、其他路径返回当前值。
   * @param {Request} req 请求（body 为 {up, down, conns, first} 的 JSON）
   * @returns {Promise<Response>} 处理后的累计值
   */
  async fetch(req: Request): Promise<Response> {
    // DO 的异步存储操作会让多个请求在 await 处交错；这里按到达顺序串行化
    const run = this.q.then(() => this.handle(req));
    this.q = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p.endsWith("/add")) {
      let d: MeterBody = {};
      try {
        const j = await req.json();
        if (j && typeof j === "object" && !Array.isArray(j)) d = j as MeterBody;
      } catch (e) {}
      const c = this.c;
      const oldC = { ...this.c },
        oldG = { ...this.g },
        oldS = Object.assign(Object.create(null), this.s),
        oldE = this.e.slice(),
        // 连接观测是**加法**合并（同一个键的 n/ok/dn 直接相加），不像事实表那样按 `at` 幂等：
        // 落盘失败后 pendFlush 会原样重发这一批（`S.cagg` 只在成功后清），只回滚用量的话
        // `cl` 的计数会被加两遍。这一份因此必须深拷（行对象就地累加），其余结构要么整体替换、要么按时间戳幂等。
        oldCl = this.cl.map((r) => ({ ...r }));
      // 计数搭便车：同一次 /add 请求把 isolate 的日计数也带上来，0 额外请求
      if (d.c && typeof d.c === "object" && !Array.isArray(d.c)) {
        const d0 = String(d.c.d || new Date().toISOString().slice(0, 10));
        // 只接受"今天"或更新的一天：旧的 isolate 可能带着昨天的计数晚到，
        // 不能让它把全局日计数回滚到昨天，更不能把旧数加进今天。
        if (!this.g || !this.g.d || d0 > this.g.d) this.g = { d: d0 };
        if (this.g.d === d0) {
          for (const [k, v] of Object.entries(d.c)) {
            if (k === "d" || k === "__proto__" || k === "constructor" || k === "prototype") continue;
            if (!(Number(v) > 0)) continue;
            this.g[k] = (Number(this.g[k]) || 0) + Number(v);
          }
        }
      }
      if (Array.isArray(d.e) && d.e.length) {
        const seen = new Set(this.e.map((x) => x && x.t));
        for (const x of d.e) {
          if (!x || !x.t || seen.has(x.t)) continue;
          this.e.push(x);
          seen.add(x.t);
        }
        this.e.sort((a, b) => a.t - b.t);
        if (this.e.length > 50) this.e = this.e.slice(-50);
      }
      // 连接观测按节点合并（不同 isolate 各报一段）：计数相加，分位数取最新一段
      if (Array.isArray(d.cl) && d.cl.length) {
        for (const x of d.cl) {
          if (!x || typeof x.n !== "number" || typeof x.k !== "string") continue;
          const old = this.cl.find((r) => r.k === x.k);
          if (old) {
            old.n += x.n;
            old.ok += x.ok;
            old.dn += x.dn;
            old.p50 = x.p50;
            old.p95 = x.p95;
          } else this.cl.push({ k: x.k, n: x.n, ok: x.ok, p50: x.p50, p95: x.p95, dn: x.dn });
        }
        if (this.cl.length > 60) this.cl = this.cl.slice(-60);
      }
      // 中继 403 判定搭便车上来：只保留未过期的，最多 200 条。
      // 下面四段（vt / 事实 / hl / blk）以前被整块嵌在上面那个 d.cl 判断里：
      // 同一批没有连接观测时，DO 会静默丢掉它们，而发送侧照样 syncAck —— 增量就此蒸发。
      if (Array.isArray(d.vt) && d.vt.length) {
        for (const r of d.vt) {
          if (!r || typeof r.k !== "string" || typeof r.t !== "number") continue;
          if (r.t <= Date.now()) continue;
          this.vt[r.k] = r.t;
        }
        const ks = Object.keys(this.vt);
        if (ks.length > 200) {
          ks.sort((a, b) => this.vt[b] - this.vt[a]);
          for (const k of ks.slice(200)) delete this.vt[k];
        }
      }
      mergeFacts(this, d);
      // 中继存活度搭便车：加性合并（只增不减，避免别的 isolate 的旧数据把本地结论冲掉）
      if (Array.isArray(d.hl) && d.hl.length) {
        const nowHl = Date.now();
        for (const r of d.hl) {
          if (!r || typeof r.i !== "string") continue;
          const cur = this.hl[r.i] || { o: 0, b: 0, d: 0 };
          cur.o = Math.max(cur.o, Number(r.o) || 0);
          cur.b = Math.max(cur.b, Number(r.b) || 0);
          cur.d = Math.max(cur.d, Number(r.d) || 0);
          // 存下证据时间（夹到现在）：不带它，冷启动读回的行只能被当成「刚刚观测」，
          // 30 分钟半衰期对最容易过期的那批数据完全失效（v7.160）。
          const t = Math.min(Number(r.t) || nowHl, nowHl);
          cur.t = Math.max(Number(cur.t) || 0, t);
          this.hl[r.i] = cur;
        }
        const hk = Object.keys(this.hl);
        if (hk.length > 200) for (const k of hk.slice(200)) delete this.hl[k];
      }
      // 被封的中继（带到期时间）：只接受未过期的
      if (d.blk && typeof d.blk === "object") {
        const nowB = Date.now();
        for (const [bk, exp] of Object.entries(d.blk as Record<string, number>)) {
          if (typeof exp !== "number" || exp <= nowB) continue;
          this.blk[bk] = exp;
        }
        const ks = Object.keys(this.blk).filter((k) => this.blk[k] > nowB);
        if (ks.length > 200) {
          ks.sort((a, b) => this.blk[a] - this.blk[b]);
          for (const k of ks.slice(0, ks.length - 200)) delete this.blk[k];
        }
      }
      if (d.spd && typeof d.spd === "object") {
        for (const [k, v] of Object.entries(d.spd)) {
          if (!v || typeof v !== "object") continue;
          if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
          const old = this.s[k];
          if (!old || (v.at || 0) >= (old.at || 0)) this.s[k] = v; // 新的覆盖旧的
        }
        // 池子每天换代，旧节点快照会无限累积；只留最近活跃的 64 个
        const sk = Object.keys(this.s);
        if (sk.length > 64) {
          sk.sort((a, b) => (this.s[a].at || 0) - (this.s[b].at || 0));
          for (let i = 0; i < sk.length - 64; i++) delete this.s[sk[i]];
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
      // 每次都落盘：DO 随时可能被驱逐，靠内存攒着会在驱逐时全丢。
      // 落盘失败必须回滚内存，否则 pendFlush 重发同一批会把用量算两遍。
      try {
        await this.save();
      } catch (e) {
        this.c = oldC;
        this.g = oldG;
        this.s = oldS;
        this.e = oldE;
        this.cl = oldCl;
        throw e;
      }
      return this.json();
    }

    // 只在当前为 0 时回填，天然幂等，重建脚本后能自动恢复历史用量
    // 明文 HTTP 证据：零 TLS，CPU 几乎为零，DO 里也能跑。
    if (p.endsWith("/http80")) {
      const hh = url.searchParams.get("h") || "";
      const rr = url.searchParams.get("r") || "";
      const pp = url.searchParams.get("p") || "/";
      if (!/^[a-z0-9.*-]+(\.[a-z0-9*-]+)+$/i.test(hh)) return Response.json({ ok: false, err: "bad host" }, { status: 400 });
      return Response.json(await probeHttp80(hh, rr, pp));
    }
    // TLS 探测走 DO：请求路径只有 10ms CPU 预算，DO 有独立且大得多的预算。
    // 一次探测不落盘、不额外写 DO（结果由调用方并入既有批次），不增加 KV 写。
    if (p.endsWith("/stage")) {
      const v = await this.st.storage.get("pstage");
      return Response.json({ stage: v || null });
    }
    if (p.endsWith("/tim")) {
      // 诊断：DO 里 setTimeout 会不会触发（不触发，则所有「计时器竞速」的截止时间都失效）
      const ms = Math.max(10, Math.min(3000, Number(url.searchParams.get("ms") || 200)));
      const t0 = Date.now();
      await new Promise((res) => setTimeout(res, ms));
      return Response.json({ ok: true, asked: ms, wall: Date.now() - t0 });
    }
    if (p.endsWith("/iter")) {
      // 固定迭代次数的纯 CPU 循环：不依赖 Date.now()（Worker 里同步段内时间冻结）
      const n = Math.max(1, Math.min(200000000, Number(url.searchParams.get("n") || 1000000)));
      const t0 = Date.now();
      let x = 7;
      for (let i = 0; i < n; i++) x = (x * 31 + 7) % 1000003;
      return Response.json({ ok: true, n, wall: Date.now() - t0, x });
    }
    if (p.endsWith("/burn")) {
      // 诊断：量 DO 自己的 CPU 预算（用 digest 循环烧 CPU，返回完成了多少次）
      const ms = Math.max(1, Math.min(5000, Number(url.searchParams.get("ms") || 50)));
      const t0 = Date.now();
      let n = 0;
      const buf = new Uint8Array(256);
      while (Date.now() - t0 < ms) {
        await crypto.subtle.digest("SHA-256", buf);
        n++;
      }
      return Response.json({ ok: true, n, ms: Date.now() - t0 });
    }
    if (p.endsWith("/burnjs")) {
      // 同步忙等：完全不碰 crypto，用来区分「CPU 预算不够」与「crypto.subtle 不返回」
      const ms = Math.max(1, Math.min(5000, Number(url.searchParams.get("ms") || 20)));
      const t0 = Date.now();
      let x = 7;
      let n = 0;
      while (Date.now() - t0 < ms) {
        for (let i = 0; i < 1000; i++) x = (x * 31 + 7) % 1000003;
        n++;
      }
      return Response.json({ ok: true, n, ms: Date.now() - t0 });
    }
    if (p.endsWith("/crypto")) {
      // 逐项量：随机数 / 单次 digest / HMAC importKey+sign，任一项挂着就说明该 API 在 DO 里不可用
      const out: Record<string, number | string> = {};
      let t = Date.now();
      try {
        crypto.getRandomValues(new Uint8Array(32));
        out.random = Date.now() - t;
      } catch (e) {
        out.random = "err " + String(e);
      }
      t = Date.now();
      try {
        const h = await crypto.subtle.digest("SHA-256", new Uint8Array(64));
        out.digest = Date.now() - t;
        out.digestLen = h.byteLength;
      } catch (e) {
        out.digest = "err " + String(e);
      }
      t = Date.now();
      try {
        const k = await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        out.importKey = Date.now() - t;
        t = Date.now();
        await crypto.subtle.sign("HMAC", k, new Uint8Array(16));
        out.sign = Date.now() - t;
      } catch (e) {
        out.sign = "err " + String(e);
      }
      t = Date.now();
      try {
        const p1 = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
        out.genP256 = Date.now() - t;
        t = Date.now();
        await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
        out.genP256b = Date.now() - t;
        out.hasP1 = p1 ? 1 : 0;
      } catch (e) {
        out.genP256 = "err " + String(e);
      }
      return Response.json(out);
    }
    if (p.endsWith("/tfb")) {
      const host = url.searchParams.get("h") || "";
      const list = (url.searchParams.get("r") || "").split(",").filter(Boolean).slice(0, 3);
      const rows: unknown[] = [];
      for (const relay of list) rows.push({ relay, ...(await probeTf(host, relay)) });
      return Response.json({ host, rows, ms: Date.now() });
    }
    if (p.endsWith("/tf"))
      return Response.json(
        await probeTf(url.searchParams.get("h") || "", url.searchParams.get("r") || "", url.searchParams.get("p") || "/"),
      );
    if (p.endsWith("/cl")) {
      return Response.json({ cl: this.cl });
    }
    if (p.endsWith("/hl")) {
const rows = Object.entries(this.hl).map(([i, x]) => ({ i, o: x.o, b: x.b, d: x.d, t: Number(x.t) || 0 }));
      rows.sort((a, b) => b.d + b.b - (a.d + a.b));
      return Response.json({ hl: rows.slice(0, 120) });
    }
    if (p.endsWith("/vt")) {
      const out: Array<{ k: string; s: number; t: number }> = [];
      const now = Date.now();
      for (const [k, t] of Object.entries(this.vt)) if (t > now) out.push({ k, s: 2, t });
const hl = Object.entries(this.hl).map(([i, x]) => ({ i, o: x.o, b: x.b, d: x.d, t: Number(x.t) || 0 }));
      const eg = Object.entries(this.eg).map(([i, x]) => ({ i, f: x.f, at: x.at }));
      eg.sort((a, b) => b.at - a.at);
      // top 也要发（v7.163）：只发均值的话，冷启动的 isolate 只能看到「现在还行」——
      // 康复闸门需要的是「曾经行过」，那条证据必须跨 isolate 活着。
      const ps = Object.entries(this.ps).map(([k, x]) => ({ k, q: x.q, n: x.n, at: x.at, top: Number(x.top) || 0 }));
      ps.sort((a, b) => b.at - a.at);
      const dd = Object.entries(this.dead).map(([i, x]) => ({ i, n: x.n, at: x.at }));
      dd.sort((a, b) => b.at - a.at);
      return Response.json({ vt: out.slice(0, 120), hl: hl.slice(0, 120), eg: eg.slice(0, 160), ps: ps.slice(0, 200), dead: dd.slice(0, 120), blk2: Object.entries(this.blk2).map(([k, v]) => ({ k, ...v })).slice(0, 120), dns: Object.entries(this.dns).map(([h, x]) => ({ h, v: x.v, at: x.at })).slice(0, 160) });
    }
    if (p.endsWith("/blk")) {
      const nowB = Date.now();
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(this.blk)) if (v > nowB) out[k] = v;
      return Response.json({ blk: out });
    }
    if (p.endsWith("/cnt")) {
      return Response.json({ g: this.g, c: this.c, s: this.s, e: this.e });
    }

    if (p.endsWith("/seed")) {
      let d: MeterBody = {};
      try {
        const j = await req.json();
        if (j && typeof j === "object" && !Array.isArray(j)) d = j as MeterBody;
      } catch (e) {}
      if ((this.c.up || 0) + (this.c.down || 0) + (this.c.conns || 0) === 0) {
        const oldC = { ...this.c };
        const today = new Date().toISOString().slice(0, 10);
        const restoreDay = String(d.d || "") === today;
        this.c.up = Number(d.up) || 0;
        this.c.down = Number(d.down) || 0;
        this.c.conns = Number(d.conns) || 0;
        this.c.first = Number(d.first) || Date.now();
        this.c.ts = Date.now();
        // 灾备快照里的当日字段：DO 被重建后"今日"不该从 0 开始
        this.c.d = restoreDay ? today : this.c.d || "";
        this.c.dU = restoreDay ? Number(d.dU) || 0 : this.c.dU || 0;
        this.c.dD = restoreDay ? Number(d.dD) || 0 : this.c.dD || 0;
        try {
          await this.save();
        } catch (e) {
          this.c = oldC;
          throw e;
        }
      }
      return this.json();
    }

    // 恢复历史累计：只在传入值更大时覆盖，天然幂等
    if (p.endsWith("/set")) {
      let d: MeterBody = {};
      try {
        const j = await req.json();
        if (j && typeof j === "object" && !Array.isArray(j)) d = j as MeterBody;
      } catch (e) {}
      const cur = (this.c.up || 0) + (this.c.down || 0);
      const want = (Number(d.up) || 0) + (Number(d.down) || 0);
      if (want > cur) {
        const oldC = { ...this.c };
        // 恢复历史累计不能把"今日"一起抹掉；只有快照的 d 是今天才采纳 dU/dD
        const today = new Date().toISOString().slice(0, 10);
        const restoreDay = String(d.d || "") === today;
        const sameDay = this.c.d === today;
        const dU = restoreDay
          ? Math.max(Number(d.dU) || 0, sameDay ? this.c.dU || 0 : 0)
          : sameDay
            ? this.c.dU || 0
            : 0;
        const dD = restoreDay
          ? Math.max(Number(d.dD) || 0, sameDay ? this.c.dD || 0 : 0)
          : sameDay
            ? this.c.dD || 0
            : 0;
        this.c = {
          up: Number(d.up) || 0,
          down: Number(d.down) || 0,
          conns: Number(d.conns) || this.c.conns || 0,
          first: Number(d.first) || this.c.first || Date.now(),
          ts: Date.now(),
          d: restoreDay || sameDay ? today : this.c.d || "",
          dU,
          dD,
        };
        try {
          await this.save();
        } catch (e) {
          this.c = oldC;
          throw e;
        }
      }
      return this.json();
    }

    if (p.endsWith("/reset")) {
      const oldC = { ...this.c };
      this.c = { up: 0, down: 0, conns: 0, first: 0, ts: Date.now(), d: "", dU: 0, dD: 0 };
      try {
        await this.save();
      } catch (e) {
        this.c = oldC;
        throw e;
      }
      return this.json();
    }

    return this.json();
  }
}