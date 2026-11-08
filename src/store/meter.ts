import { cnt } from "../px/pool";
import { seal, unseal } from "./index";

/* do */
export class Meter {
  st: DurableObjectState; env: Env; c: UsageMeter; g: CounterDoc; s: Record<string, NodeSnap>; e: ErrItem[];
  /**
   * 构造：从 storage 恢复累计值；blockConcurrencyWhile 保证恢复完成前不处理请求。
   * @param {DurableObjectState} state DO 状态对象（storage / alarm / blockConcurrencyWhile）
   */
  constructor(state: DurableObjectState, env: Env) {
    this.st = state;
    this.env = env;
    this.c = { up: 0, down: 0, conns: 0, first: 0, ts: 0, d: "", dU: 0, dD: 0 };
    this.g = { d: "" };                        // 全局日计数（连接/走节点/断流…）
    this.s = {};                               // 节点快照 "h:p" -> {med,p90,cap,n,...}
    this.e = [];                               // 跨 isolate 的错误环形（最多 50 条）
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
          if (o.s && typeof o.s === "object") this.s = o.s;
          if (Array.isArray(o.e)) this.e = o.e;
        }
        return;
      }
      // 老结构（c/e/s/g 四个键）：读出来顺手迁到新键，再删掉旧的
      let migrated = false;
      const v = await this.st.storage.get("c");
      if (v) {
        const obj = await unseal<Record<string, number>>(env, v);      // 兼容老的明文对象
        if (obj) { this.c = { ...this.c, ...obj }; migrated = true; }
      }
      const ev = await this.st.storage.get("e");
      if (ev) {
        const o4 = await unseal<ErrItem[]>(env, ev);
        if (Array.isArray(o4)) { this.e = o4; migrated = true; }
      }
      const sv = await this.st.storage.get("s");
      if (sv) {
        const o3 = await unseal<Record<string, NodeSnap>>(env, sv);
        if (o3 && typeof o3 === "object") { this.s = o3; migrated = true; }
      }
      const gv = await this.st.storage.get("g");
      if (gv) {
        const obj2 = await unseal<Record<string, number>>(env, gv);
        if (obj2 && typeof obj2 === "object") { this.g = obj2 as CounterDoc; migrated = true; }
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
    await this.st.storage.put("a", await seal(this.env, { c: this.c, g: this.g, s: this.s, e: this.e }));
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
    const p = new URL(req.url).pathname;

    if (p.endsWith("/add")) {
      let d: MeterBody = {};
      try {
        d = await req.json();
      } catch (e) {}
      const c = this.c;
      // 计数搭便车：同一次 /add 请求把 isolate 的日计数也带上来，0 额外请求
      if (d.c && typeof d.c === "object") {
        const d0 = String(d.c.d || new Date().toISOString().slice(0, 10));
        if (!this.g || this.g.d !== d0) this.g = { d: d0 };
        for (const [k, v] of Object.entries(d.c)) {
          if (k === "d" || !(Number(v) > 0)) continue;
          this.g[k] = (this.g[k] || 0) + v;
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
      if (d.spd && typeof d.spd === "object") {
        for (const [k, v] of Object.entries(d.spd)) {
          if (!v || typeof v !== "object") continue;
          const old = this.s[k];
          if (!old || (v.at || 0) >= (old.at || 0)) this.s[k] = v;   // 新的覆盖旧的
        }
      }
      c.up += Number(d.up) || 0;
      c.down += Number(d.down) || 0;
      c.conns += Number(d.conns) || 0;
      // 当日字节：跨天自动清零。累计值 up/down 是订阅头用的（协议惯例），
      // 面板上的"今日"用这一份 —— 否则用户永远只看到历史总量。
      const today0 = new Date().toISOString().slice(0, 10);
      if (c.d !== today0) { c.d = today0; c.dU = 0; c.dD = 0; }
      c.dU = (c.dU || 0) + (Number(d.up) || 0);
      c.dD = (c.dD || 0) + (Number(d.down) || 0);
      c.ts = Date.now();
      if (!c.first) c.first = c.ts;
      // 每次都落盘：DO 随时可能被驱逐，靠内存攒着会在驱逐时全丢
      await this.save();
      return this.json();
    }

    // 只在当前为 0 时回填，天然幂等，重建脚本后能自动恢复历史用量
    if (p.endsWith("/cnt")) {
      return Response.json({ g: this.g, c: this.c, s: this.s, e: this.e });
    }

    if (p.endsWith("/seed")) {
      let d: MeterBody = {};
      try {
        d = await req.json();
      } catch (e) {}
      if ((this.c.up || 0) + (this.c.down || 0) + (this.c.conns || 0) === 0) {
        this.c.up = Number(d.up) || 0;
        this.c.down = Number(d.down) || 0;
        this.c.conns = Number(d.conns) || 0;
        this.c.first = Number(d.first) || Date.now();
        this.c.ts = Date.now();
        await this.save();
      }
      return this.json();
    }

    // 恢复历史累计：只在传入值更大时覆盖，天然幂等
    if (p.endsWith("/set")) {
      let d: MeterBody = {};
      try {
        d = await req.json();
      } catch (e) {}
      const cur = (this.c.up || 0) + (this.c.down || 0);
      const want = (Number(d.up) || 0) + (Number(d.down) || 0);
      if (want > cur) {
        this.c = {
          up: Number(d.up) || 0,
          down: Number(d.down) || 0,
          conns: Number(d.conns) || this.c.conns || 0,
          first: Number(d.first) || this.c.first || Date.now(),
          ts: Date.now(),
        };
        await this.save();
      }
      return this.json();
    }

    if (p.endsWith("/reset")) {
      this.c = { up: 0, down: 0, conns: 0, first: 0, ts: Date.now(), d: "", dU: 0, dD: 0 };
      await this.save();
      return this.json();
    }

    return this.json();
  }
}

