import { factsOut } from "./factout";
import { unseal } from "./index";
import { applyAdd } from "./meteradd";
import { probeTf } from "../core/tf";
import { cnt } from "../core/counter";
import { readShards, saveState } from "./metershard";

/**
 * 用量账本（Durable Object，全局唯一）：一个用户一个实例，只有它能回答「已用多少字节」。
 *
 * 为什么必须是 DO：KV 最终一致、无法原子累加，多个 isolate 并发上报同一用户时只有单实例
 * 能把增量串行合并；配额判断与快照回写也在这一次串行里完成。
 * 与 `PendingLedger` 的分工：isolate 侧只攒增量、失败回滚；DO 侧落账、判额度、维护内存快照。
 */
export class Meter {
  st: DurableObjectState;
  env: Env;
  c: UsageMeter;
  g: CounterDoc;
  s: Record<string, NodeSnap>;
  e: ErrItem[];
  /** 连接记录环形：最近 60 条，离线标定用 */
  cl: ClRec[];
  /**
   * 判定表的强证据：`站点|通道` → `{ s: 状态, t: 到期时间 }`。
   * 老数据里是裸数字（只有到期时间，状态默认 2）—— v7.164 前 DO 只存到期时间，
   * 于是 `state=3`（dead，硬排除）读回来会变成 2（blocked，软降权），硬排除在跨 isolate 后消失。
   */
  vt: Record<string, number | { s: number; t: number }>;
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
  /** 事实表代号：`a` 里记的号与分片里的号不同就说明分片是上一轮的残留（v7.219） */
  fs: number;
  /** 读不出来的 `a` 原文（换过 kek 或值被写坏）：第一次落盘前先备份到 `a_bak` */
  private bakRaw: unknown = null;
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
    this.fs = 0; // 事实表代号（与分片同号才认；0 = 事实就在 `a` 里）
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
          if (o.vt && typeof o.vt === "object")
          this.vt = o.vt as unknown as Record<string, number | { s: number; t: number }>;
          if (o.hl && typeof o.hl === "object") this.hl = o.hl as unknown as Record<string, { o: number; b: number; d: number; t?: number }>;
          if (o.eg && typeof o.eg === "object") this.eg = o.eg as unknown as Record<string, { f: number; at: number }>;
          if (o.ps && typeof o.ps === "object") this.ps = o.ps as unknown as Record<string, { q: number; n: number; at: number; top?: number }>;
          if (o.dead && typeof o.dead === "object") this.dead = o.dead as unknown as Record<string, { n: number; at: number }>;
          if (o.dns && typeof o.dns === "object") this.dns = o.dns as unknown as Record<string, { v: number; at: number }>;
          if (o.blk2 && typeof o.blk2 === "object") this.blk2 = o.blk2 as unknown as Record<string, { n: number; at: number }>;
        // 代号决定「要不要读分片」：0 表示事实就在这个值里，磁盘上的分片必是上一轮的残留
          this.fs = Number((o as unknown as { fs?: number }).fs) || 0;
        } else {
          // 换过 kek、或值被写坏：这份账本解不开。**不能当成「没有账本」静默从零开始** ——
          // 下一次 /add 就会把零值覆盖回去，历史用量与配额永久消失。这里只留底与计数，
          // 真正的写入让 save() 先把原文备份到 `a_bak`（人工可抢救）。
          cnt("doBad");
          this.bakRaw = all;
        }
        // 分片要在 `a` 之后再读：装不下时事实表搬去了 f1/f2/f3，只读 `a` 会看到空表
        await this.loadShards();
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
      // 老布局的分片同样要读：从 7.218 起事实表可能只存在于 f1/f2/f3 里
        await this.loadShards();
      }
    });
  }

  /**
   * 把分片里的七张事实表读回内存（只在 `saveState()` 曾因体积拆过片时存在）。
   * 为什么单独一个方法：恢复有两条路径（新布局 `a`、老布局 `c/e/s/g`），分片对两条都适用，
   * 塞在任一条里都会让另一条漏读 —— 表现为「重启后事实全空」。
   * @returns {Promise<void>}
   */
  private async loadShards(): Promise<void> {
    Object.assign(this, await readShards(this.env, this.st.storage, this.fs));
  }

  /**
   * 把当前账本加密后写进 DO storage（装得下就单键 `a`，装不下按体积拆 `f1`/`f2`/`f3`）。
   * 体积预算与分片布局都在 `src/store/metershard.ts` 的 `saveState()` 里。
   * @returns {Promise<void>}
   */
  async save() {
    // 解不开的旧值只备份一次：`a_bak` 只给人工抢救用，不进任何读路径
    if (this.bakRaw !== null) {
      await this.st.storage.put("a_bak", this.bakRaw);
      this.bakRaw = null;
    }
    this.fs = await saveState(this.env, this.st.storage, {
      c: this.c, g: this.g, s: this.s, e: this.e, cl: this.cl,
      vt: this.vt, hl: this.hl, eg: this.eg, ps: this.ps,
      dead: this.dead, blk2: this.blk2, dns: this.dns,
    });
  }

  /**
   * 把当前累计值序列化成 JSON 响应。
   * @returns {Response} 200 + {up, down, conns, first, ts}
   */
  json() {
    return Response.json(this.c);
  }

  /**
   * DO 的请求入口：/add 累加增量、/seed 首次回填、其他路径返回当前值。
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
      // 快照只覆盖「就地累加」的字段：事实表按时间戳幂等、用量/日计数/节点快照整体替换，
      // 连接观测是加法合并（行在表里就地累加）—— 所以 `cl` 必须深拷，否则回滚回不去。
      const snap = {
        c: { ...this.c },
        g: { ...this.g },
        s: Object.assign(Object.create(null), this.s),
        e: this.e.slice(),
        cl: this.cl.map((r) => ({ ...r })),
      };
      applyAdd(this, d);
      // 每次都落盘：DO 随时可能被驱逐，靠内存攒着会在驱逐时全丢；
      // 落盘失败必须回滚内存，否则 pendFlush 重发同一批会把用量算两遍。
      try {
        await this.save();
      } catch (e) {
        Object.assign(this, snap);
        throw e;
      }
      return this.json();
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
      // 按证据时间降序出站（v7.216）：以前按「坏证据条数」排，于是表里超过 120 条中继时，
      // 只有一两条新证据的中继永远排在最后、一条都发不出去 —— 而「这条中继刚刚成功过」正是
      // 最该扩散给别的 isolate 的那条证据（30 分钟半衰期，还没等它排上队就过期了）。
      // 存储侧本来就只留最新的 200 条（同一条判据），出站再按新鲜度切才自洽；
      // 条数只当并列时的次序，避免同一毫秒写入的行顺序抖动。
      rows.sort((a, b) => b.t - a.t || b.d + b.b - (a.d + a.b));
      return Response.json({ hl: rows.slice(0, 120) });
    }
    // 七张表的出站形状与切片顺序都在 src/store/factout.ts（v7.187）
    if (p.endsWith("/vt")) return Response.json(factsOut(this));
    if (p.endsWith("/cnt")) {
      return Response.json({ g: this.g, c: this.c, s: this.s, e: this.e });
    }

    // 只在当前为 0 时回填，天然幂等，重建脚本后能自动恢复历史用量
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
      // 连接数也是单调量：只看字节会让「只建过连接、没有可计量流量」的用户恢复不到
      // conns/first；`/seed` 的门槛是 up+down+conns，两条恢复路径的口径必须一致
      const curN = this.c.conns || 0;
      const wantN = Number(d.conns) || 0;
      if (want > cur || wantN > curN) {
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
          // 两维各自取大（v7.181）：以前无条件写成快照值，只看 conns 变大就会把
          // up/down 换成快照里的旧数（快照可能落后几小时）——面板与订阅头的累计用量倒退。
          up: Math.max(Number(d.up) || 0, this.c.up || 0),
          down: Math.max(Number(d.down) || 0, this.c.down || 0),
          // conns 取两者更大：快照可能比 DO 落后几小时，直接赋值会让面板的连接数变小
          conns: Math.max(wantN, curN),
          // first 取更早的非零值：重建后不能把「首次使用时间」推后
          first: (() => {
            const a = Number(d.first) || 0;
            const b = this.c.first || 0;
            if (a > 0 && b > 0) return Math.min(a, b);
            return a || b || Date.now();
          })(),
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

    return this.json();
  }
}