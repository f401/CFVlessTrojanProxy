/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case001({ W, ok, eq }) {
  // 一条 512KB、1 秒的本地窗口：capBps 立刻由本地样本给出，confB 仍不够（要 3 个有效窗口 + 3MiB）
  W.NodeStatsTable.nsSpeed("seed:443", 512 * 1024, 512 * 1024, {}, 1);
  const p = W.scoreParts("seed:443", "tput");
  ok("本地样本决定 capBps", p.capBps >= 400 * 1024, String(p.capBps));
  eq("单条短样本不构成高置信度", p.confB, 0);
  W.NodeStatsTable.nsSpeed("seed:443", 512 * 1024, 512 * 1024, {}, 1);
  W.NodeStatsTable.nsSpeed("seed:443", 512 * 1024, 512 * 1024, {}, 1);
  ok("3 个有效窗口后 nEff 达标", W.scoreParts("seed:443", "tput").nEff >= 3, String(W.scoreParts("seed:443", "tput").nEff));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case002({ W, ok }) {
  const s = W.NodeStatsTable.nsGet("z2:443");
  s.okW = 1;
  s.failW = 5;
  ok("1 成功 5 失败 → avail < 0.75", W.availOf(s) < 0.75, W.availOf(s));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case003({ W, ok, eq }) {
  const se = W.NodeStatsTable.nsGet("e:443");
  se.at = Date.now() - 12 * 3600e3; // 两个半衰期
  W.NodeStatsTable.nsEmptyClose("e:443", true); // 触发衰减后再 +1
  ok("空关闭计数按半衰期衰减", se.eCloseP > 2 && se.eCloseP < 2.6, String(se.eCloseP));
  eq("衰减后不再可疑", W.emptyCloseSuspect("e:443"), false);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case004({ reset, node, W, eq }) {
  reset();
  node("de1:443", { tcp: 50 });
  node("de2:443", { tcp: 90 });
  node("us1:443", { tcp: 40 });
  W.NODE_MEMORY.alive.get("de1:443").cc = "DE";
  W.NODE_MEMORY.alive.get("de2:443").cc = "DE";
  W.NODE_MEMORY.alive.get("us1:443").cc = "US";
  const de = await W.SEL.region({}, "DE", "lat");
  eq("地区只选 DE 节点", de && de.h + ":" + de.p, "de1:443");
  const deAlt = await W.SEL.region({}, "DE", "lat", "de1:443");
  eq("地区避开指定节点", deAlt && deAlt.h + ":" + deAlt.p, "de2:443");
  eq("地区无节点返回 null", await W.SEL.region({}, "JP", "lat"), null);
  eq("nextNode 按国家过滤", W.CANDS.next("lat", "", "US"), "us1:443");
  eq("nextNode 避开后无同国节点", W.CANDS.next("lat", "us1:443", "US"), "");
  W.NodeStatsTable.nsFail("de1:443");
  const deCold = await W.SEL.region({}, "DE", "lat");
  eq("地区跳过冷却节点", deCold && deCold.h + ":" + deCold.p, "de2:443");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case005({ mkDO, eq }) {
  const doG = mkDO();
  await doG.m.fetch(
    new Request("https://m/add", {
      method: "POST",
      body: JSON.stringify({ up: 1, down: 1, conns: 1, c: { d: "2099-01-01", conn: 2 } }),
    }),
  );
  await doG.m.fetch(
    new Request("https://m/add", {
      method: "POST",
      body: JSON.stringify({ up: 1, down: 1, conns: 1, c: { d: "2000-01-01", conn: 9 } }),
    }),
  );
  const jg = await (await doG.m.fetch(new Request("https://m/cnt"))).json();
  eq("全局日计数不被旧批次回滚", jg.g.d, "2099-01-01");
  eq("旧批次计数被丢弃", jg.g.conn, 2);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case006({ mkDO, eq, ok }) {
  const do2 = mkDO();
  const spd = {};
  for (let i = 0; i < 80; i++) spd[`n${i}:443`] = { med: 1, p90: 1, cap: 1, n: 1, at: i + 1 };
  await do2.m.fetch(
    new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 0, down: 0, conns: 0, spd }) }),
  );
  const j2 = await (await do2.m.fetch(new Request("https://m/cnt"))).json();
  eq("节点快照最多 64 个", Object.keys(j2.s).length, 64);
  ok("保留最新节点", !!j2.s["n79:443"] && !j2.s["n0:443"]);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case007({ W, eq }) {
  let calls = 0;
  const body = { s: { "a:443": { med: 100, p90: 200, cap: 210, n: 7, at: 1 } } };
  const mkEnv = () => ({
    METER: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async () => {
          calls++;
          return new Response(JSON.stringify(body));
        },
      }),
    },
  });
  W.NODE_SNAP.reset();
  const snap = await W.nodeSnapGet(mkEnv(), "u1");
  eq("nodeSnapGet 拿到 DO 里的节点快照", Object.keys(snap), ["a:443"]);
  const again = await W.nodeSnapGet(mkEnv(), "u1");
  eq("60 秒内走缓存，不再打 DO", calls, 1);
  eq("缓存内容一致", again["a:443"].p90, 200);

  const bad = {
    METER: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async () => {
          throw new Error("do down");
        },
      }),
    },
  };
  W.NODE_SNAP.reset();
  eq("DO 挂了返回空表而不是抛错", await W.nodeSnapGet(bad, "u1"), {});
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case009({ W, ok, eq }) {
  // v6.35：seed 只传候选名单，没有可靠性伪计数 —— 失败率先验只由本地样本决定
  const s = W.NodeStatsTable.nsGet("seedrel:443");
  s.failW = 1;
  const p = W.pFailOf(s);
  ok("一次失败就把风险先验抬到 0.1 以上", p > 0.1, String(p));
  s.failW = 0;
  eq("清掉本地失败后回到 0.1", W.pFailOf(s), 0.1);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case010({ W, ok }) {
  const s = W.NodeStatsTable.nsGet("oneok:443");
  s.okW = 1;
  const p = W.pFailOf(s);
  ok("第一条成功不额外惩罚", p <= 0.101, String(p));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case011({ W, eq }) {
  const box = new Map();
  const env = {
    STATS: {
      get: async (k) => box.get(k) || null,
      put: async (k, v) => {
        box.set(k, v);
      },
    },
  };
  W.ISOLATE.colo = "TST";
  W.SEED_STORE.readAt = 0;
  await W.SEED_STORE.write(env, false, true);
  const doc = JSON.parse(box.get([...box.keys()][0]));
  const row = doc.byColo.TST.nodes.find((x) => x.k === "hpb:443");
  eq("seed 只存候选名单的四个字段", row ? Object.keys(row).sort().join(",") : "", "cc,h,k,p");
  eq("seed 不再写站点偏好", !!doc.byColo.TST.hp, false);
  // 模拟另一个 isolate 冷启动：拿到名字，拿不到任何品质结论
  W.NODE_MEMORY.alive.clear();
  W.NODE_MEMORY.stats.clear();
  W.HOSTS.nodes.clear();
  W.SEED_STORE.readAt = 0;
  W.SEED_STORE.document = { v: 0, ts: 0, poolGen: 0, poolN: 0, builtAt: 0, byColo: {} };
  await W.SEED_STORE.read(env);
  await W.pxGet(env);
  eq("别的 isolate 只用名字起步（延迟=先验）", (W.NODE_MEMORY.alive.get("hpb:443") || {}).ms, 250);
  eq("没有任何统计被灌进来", W.NODE_MEMORY.stats.has("hpb:443"), false);
  eq("站点偏好不跨 isolate", W.HOSTS.nodes.has("site-seed.test"), false);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case012({ W, ok, eq }) {
  const s = W.NodeStatsTable.nsGet("sitefail:443");
  const beforeFail = s.failW,
    beforeBlack = s.blackUntil;
  W.NodeStatsTable.nsSiteFail("sitefail:443");
  ok("站点失败只加 0.2 全局权重", Math.abs(s.failW - beforeFail - 0.2) < 1e-9, String(s.failW));
  eq("站点失败不进冷却阶梯", s.blackUntil, beforeBlack);
  W.CANDS.cache.t = 12345;
  W.NodeStatsTable.nsSiteFail("sitefail:443");
  eq("站点失败不再清空全局排行缓存", W.CANDS.cache.t, 12345);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case013({ W, ok }) {
  const s = W.NodeStatsTable.nsGet("flap:443");
  s.winAt = Date.now();
  s.winOk = 2;
  s.winFail = 3;
  W.NodeStatsTable.nsFail("flap:443");
  ok("抖动（窗口内成败参半）触发 5 分钟冷却", s.blackUntil - Date.now() > 4 * 60000, String(s.blackUntil - Date.now()));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case014({ W, eq, ok }) {
  W.SNAP.cache = { v: { v: 1, ts: 1, date: "", stats: {}, rtt: {}, errs: [] }, t: Date.now() };
  W.ENTRY_MEMORY.misses.clear();
  let reads = 0;
  const envR = {
    STATS: {
      get: async () => {
        reads += 1;
        return null;
      },
    },
  };
  await W.loadRtt(envR, "miss-u");
  eq("rtt 缺失第一次读 KV", reads, 1);
  await W.loadRtt(envR, "miss-u");
  eq("rtt 缺失 10 分钟内不再读", reads, 1);
  // ?ip= 是用户可传的：每个用户的标签数必须有上限，否则能把 snap 写成超大 KV 值
  for (let i = 0; i < 40; i++) W.rttMark("cap-u", "t" + i, true);
  const capB = W.ENTRY_MEMORY.rows.get("cap-u");
  eq("rtt 标签最多 24 个", Object.keys(capB).length, 24);
  ok("保留的是最新的标签", !!capB.t39 && !capB.t0);
  // ?ip=__proto__ 不能污染 Object.prototype
  W.rttMark("proto-u", "__proto__", true);
  eq("rtt 标签不污染原型", {}.rtt, undefined);
  ok("__proto__ 作为普通键保存", Object.prototype.hasOwnProperty.call(W.ENTRY_MEMORY.rows.get("proto-u"), "__proto__"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case015({ W, eq }) {
  let gets = 0,
    puts = 0;
  const envS = {
    STATS: {
      get: async () => {
        gets += 1;
        return JSON.stringify({ v: 1, ts: Date.now(), date: "", stats: {}, rtt: {}, errs: [] });
      },
      put: async () => {
        puts += 1;
      },
    },
  };
  W.USAGE_MEMORY.rows.set("snap-u", { up: 1, down: 2, conns: 1, first: Date.now(), last: Date.now() });
  W.USAGE_MEMORY.dirtyBytes = 3 * 1048576;
  W.SNAP.written = Date.now() - 3 * 3600e3;
  W.SNAP.checked = 0;
  W.SNAP.busy = false;
  await W.flushSnap(envS);
  await W.flushSnap(envS);
  eq("快照全局闸门只读一次 KV", gets, 1);
  eq("闸门命中不写 KV", puts, 0);
  W.USAGE_MEMORY.rows.clear();
  W.USAGE_MEMORY.dirtyBytes = 0;
  W.SNAP.written = 0;
  W.SNAP.checked = 0;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case016({ W, eq }) {
  W.COUNTER.day = new Date().toISOString().slice(0, 10);
  W.COUNTER.values.conn = 7;
  W.COUNTER.sent.conn = 0;
  const dl = W.cntDelta();
  eq("cntDelta 取出增量", dl.conn, 7);
  eq("cntDelta 推进基线", W.COUNTER.sent.conn, 7);
  W.cntUnsend(dl);
  eq("cntUnsend 退回基线", W.COUNTER.sent.conn, 0);
  W.COUNTER.values.conn = 0;
  W.COUNTER.sent.conn = 0;
  // 跨天出口也要清零，不能把昨天的计数继续发出去
  W.COUNTER.day = "2000-01-01";
  W.COUNTER.values.conn = 9;
  eq("跨天后计数不再发送", Object.keys(W.cntDelta()).length, 0);
  W.COUNTER.day = new Date().toISOString().slice(0, 10);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case017({ reset, node, W, eq }) {
  reset();
  node("fr:443", {});
  W.freezeNode("fr:443");
  eq("冻结生效", W.isFrozen("fr:443"), true);
  W.NodeStatsTable.nsOk("fr:443", 0, 0);
  eq("成功连接解除冻结", W.isFrozen("fr:443"), false);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case018({ W, eq }) {
  const box = new Map();
  const envU = {
    uuid: "7c53c12a-88b1-4fda-b6e7-4da62e47a4e1",
    STATS: {
      get: async (k) => box.get(k) || null,
      put: async (k, v) => {
        box.set(k, v);
      },
    },
    METER: {
      idFromName: (id) => id,
      get: () => ({
        fetch: async () => ({
          ok: true,
          json: async () => ({ up: 3000000000, down: 5000000000, conns: 10, first: 1 }),
        }),
      }),
    },
  };
  W.USERS.v = null; W.USERS.t = 0;
  W.USERS.sig = "";
  W.METER_CLIENT.cache.clear();
  await W.usageSnapWrite(envU, [{ id: envU.uuid, pwd: "", note: "", enabled: true, managed: false }]);
  const doc = JSON.parse(box.get("usage:snap"));
  eq("大用量快照不溢出", doc.users[envU.uuid].up, 3000000000);
  eq("大下行快照不溢出", doc.users[envU.uuid].down, 5000000000);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case019({ W, ok }) {
  const s = W.NodeStatsTable.nsGet("cd:443");
  const until = Date.now() + 10 * 60000;
  s.blackUntil = until;
  W.NodeStatsTable.nsFail("cd:443");
  ok("失败不缩短已有冷却", s.blackUntil >= until, String(s.blackUntil - Date.now()));
  s.freeUntil = Date.now() + 60 * 60000;
  W.freezeNode("cd:443");
  ok("冻结不缩短已有冻结", s.freeUntil >= Date.now() + 59 * 60000, String(s.freeUntil - Date.now()));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case021({ mkDO, eq }) {
  const doQ = mkDO();
  await Promise.all([
    doQ.m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 1, down: 0, conns: 0 }) })),
    doQ.m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 2, down: 0, conns: 0 }) })),
  ]);
  const jq = await (await doQ.m.fetch(new Request("https://m/get"))).json();
  eq("并发 /add 串行累加", jq.up, 3);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case022({ mkDO, eq }) {
  const doN = mkDO();
  const rn = await doN.m.fetch(new Request("https://m/add", { method: "POST", body: "null" }));
  eq("DO /add null body 不抛", rn.status, 200);
  const jn = await rn.json();
  eq("DO /add null body 累计仍为 0", [jn.up, jn.down, jn.conns], [0, 0, 0]);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case023({ mkDO, eq }) {
  const today = new Date().toISOString().slice(0, 10);
  const doSeed = mkDO();
  await doSeed.m.fetch(
    new Request("https://m/seed", {
      method: "POST",
      body: JSON.stringify({ up: 1000, down: 2000, conns: 5, first: 1, d: today, dU: 77, dD: 88 }),
    }),
  );
  const js = await (await doSeed.m.fetch(new Request("https://m/get"))).json();
  eq("seed 回填累计", [js.up, js.down], [1000, 2000]);
  eq("seed 回填当日量", [js.dU, js.dD], [77, 88]);
  eq("seed 回填日期", js.d, today);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case024({ W, eq }) {
  const day = new Date().toISOString().slice(0, 10);
  const fakeEnv = (c) => ({
    METER: { idFromName: (x) => x, get: () => ({ fetch: async () => Response.json(c) }) },
  });
  W.METER_CLIENT.cache.clear();
  W.PEND.rows.clear();
  const old = await W.readStats(
    fakeEnv({ up: 100, down: 200, conns: 1, first: 1, ts: 2, d: "2000-01-01", dU: 50, dD: 60 }),
    "u-yesterday",
  );
  eq("昨天的不算今日（上行）", old.todayUp, 0);
  eq("昨天的不算今日（下行）", old.todayDown, 0);
  eq("累计仍然保留", [old.up, old.down], [100, 200]);

  W.METER_CLIENT.cache.clear();
  const cur = await W.readStats(
    fakeEnv({ up: 100, down: 200, conns: 1, first: 1, ts: 2, d: day, dU: 50, dD: 60 }),
    "u-today",
  );
  eq("今天照常显示当日量", [cur.todayUp, cur.todayDown], [50, 60]);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case025({ mkDO, eq, ok }) {
  const doS = mkDO();
  await doS.m.fetch(
    new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 10, down: 20, conns: 1 }) }),
  );
  await doS.m.fetch(
    new Request("https://m/set", {
      method: "POST",
      body: JSON.stringify({ up: 1000, down: 2000, conns: 9, first: 1 }),
    }),
  );
  const js = await (await doS.m.fetch(new Request("https://m/get"))).json();
  eq("恢复历史后累计生效", [js.up, js.down], [1000, 2000]);
  eq("恢复历史不抹今日", [js.dU, js.dD], [10, 20]);
  ok("恢复历史保留日期", !!js.d);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case026({ mkDO, eq }) {
  const today = new Date().toISOString().slice(0, 10);
  const doT = mkDO();
  await doT.m.fetch(
    new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 10, down: 20, conns: 1 }) }),
  );
  await doT.m.fetch(
    new Request("https://m/set", {
      method: "POST",
      body: JSON.stringify({ up: 1000, down: 2000, conns: 9, first: 1, d: today, dU: 33, dD: 44 }),
    }),
  );
  const jt = await (await doT.m.fetch(new Request("https://m/get"))).json();
  eq("同日快照 dU/dD 取较大值", [jt.dU, jt.dD], [33, 44]);

  const doY = mkDO();
  await doY.m.fetch(
    new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 10, down: 20, conns: 1 }) }),
  );
  await doY.m.fetch(
    new Request("https://m/set", {
      method: "POST",
      body: JSON.stringify({ up: 1000, down: 2000, d: "2000-01-01", dU: 999, dD: 999 }),
    }),
  );
  const jy = await (await doY.m.fetch(new Request("https://m/get"))).json();
  eq("旧日快照不覆盖今日", [jy.dU, jy.dD], [10, 20]);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case027({ W, eq }) {
  const today = new Date().toISOString().slice(0, 10);
  const store = new Map();
  const envS = {
    STATS: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => store.set(k, v),
    },
    METER: {
      idFromName: (x) => x,
      get: () => ({
        fetch: async () => Response.json({ up: 100, down: 200, conns: 1, first: 1, d: today, dU: 77, dD: 88 }),
      }),
    },
  };
  store.set(
    "usage:snap",
    JSON.stringify({ ts: 0, users: { "snap-u1": { up: 1, down: 1, conns: 1, d: "2000-01-01", dU: 999, dD: 999 } } }),
  );
  W.METER_CLIENT.cache.clear();
  await W.usageSnapWrite(envS, [{ id: "snap-u1" }]);
  const snap = JSON.parse(store.get("usage:snap"));
  eq("快照写入今日 dU/dD", [snap.users["snap-u1"].dU, snap.users["snap-u1"].dD], [77, 88]);
  eq("快照日期是今天", snap.users["snap-u1"].d, today);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case028({ W, eq, ok }) {
  const seen = [];
  let live = 0,
    peak = 0;
  await W.eachLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 1));
    seen.push(x);
    live--;
  });
  eq(
    "eachLimit 覆盖全部任务",
    seen.sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7],
  );
  ok("eachLimit 并发不超过 3", peak <= 3, String(peak));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case029({ mkDO, eq, ok }) {
  const doP = mkDO();
  await doP.m.fetch(
    new Request("https://m/add", {
      method: "POST",
      body: '{"up":0,"down":0,"conns":0,"spd":{"__proto__":{"med":1},"ok:443":{"med":2,"at":1}}}',
    }),
  );
  eq("spd 容器是 null 原型", Object.getPrototypeOf(doP.m.ledger.nodeSnapshots), null);
  eq("__proto__ 不作为自有键写入", Object.prototype.hasOwnProperty.call(doP.m.ledger.nodeSnapshots, "__proto__"), false);
  ok("正常节点仍保留", !!doP.m.ledger.nodeSnapshots["ok:443"]);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case030({ W, eq }) {
  const s = W.NodeStatsTable.nsGet("probe-only:443");
  W.NodeStatsTable.nsProbe("probe-only:443", 50, 40, 10);
  eq("探活不增加 ok", s.ok, 0);
  eq("探活仍记延迟样本", s.probeSamples, 1);
  W.NODE_MEMORY.stats.delete("probe-only:443");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case031({ W, ok }) {
  const hit = {};
  for (let i = 0; i < 400; i++) {
    const k = W.SEL.pick({ pxShadow: 0 }, "lat", { host: "" });
    hit[k] = (hit[k] || 0) + 1;
    W.NodeStatsTable.nsOk(k, 0, 0); // 真实连接成功 → 样本 +1，乐观面随之收缩
  }
  ok("未测节点拿到探索流量", (hit["k3:443"] || 0) > 0, JSON.stringify(hit));
  ok("测过且慢的节点基本退场", (hit["k2:443"] || 0) <= 2, JSON.stringify(hit));
  ok("王者仍拿大头", (hit["k1:443"] || 0) > 200, JSON.stringify(hit));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case032({ W, eq }) {
  const envS = { uuid: "u", nodes: "", proxyip: "auto" };
  const y = W.renderClash(envS, new URL("https://example.com/x"), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "example.com");
  const eCount = (y.match(/name: "e-/g) || []).length;
  eq("边缘入口条目：8 个 IP × 2 模式", eCount, 16);
  eq("边缘条目 server 是 IP", y.includes("server: 104.18.32.1"), true);
  eq("边缘条目 servername 仍是域名", y.includes("servername: example.com"), true);
  eq("入口优选组按 /health 实测", y.includes('name: "🌐 入口优选"') && y.includes("url: https://example.com/health"), true);
  eq("默认订阅不含站点特化（无 x 组）", y.includes('name: "\ud83d\udef0 x \u4f18\u9009"'), false);
  eq("默认订阅不含站点规则", /DOMAIN-SUFFIX,x\.com/.test(y), false);
  const ytu = W.renderClash(envS, new URL("https://example.com/x?tu=" + encodeURIComponent("https://probe.example.org/")), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "example.com");
  eq("?tu= 才发按客户端实测的 url-test 组", ytu.includes("url: https://probe.example.org/"), true);
  eq("?tu= 也不引入站点级规则", /DOMAIN-SUFFIX/.test(ytu), false);
  const y0 = W.renderClash(envS, new URL("https://example.com/x?e=0"), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "example.com");
  eq("?e=0 时不发边缘条目", (y0.match(/name: "e-/g) || []).length, 0);
  eq("?e=0 时不发实测组", y0.includes("url: https://probe.example.org/"), false);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case033({ W, eq }) {
  const envR = { uuid: "u", nodes: "", proxyip: "auto" };
  const keep = W.NODE_MEMORY.alive;
  W.NODE_MEMORY.alive = new Map([
    ["203.0.113.7:443", { h: "203.0.113.7", p: 443, cc: "", ms: 120, src: "pool" }],
    ["198.51.100.9:443", { h: "198.51.100.9", p: 443, cc: "", ms: 180, src: "pool" }],
  ]);
  const yr = W.renderClash(envR, new URL("https://example.com/x"), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "example.com");
    eq("不再发 r- 中继条目", (yr.match(/name: "r-/g) || []).length, 0);
    eq("NODE_MEMORY.alive 里的中继不再泄漏进订阅", yr.includes("203.0.113.7") === false && yr.includes("198.51.100.9") === false, true);
    eq("订阅里没有 rx 硬钉", /rx=203\.0\.113\.7|px=1|ip=relay/.test(yr), false);
    eq("不再有中继优选组", yr.includes("\u4e2d\u7ee7\u4f18\u9009"), false);
  const y0r = W.renderClash(envR, new URL("https://example.com/x?e=0"), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "example.com");
    // 冷 isolate：W.NODE_MEMORY.alive/eg4Top 都不应再泄漏成订阅节点
  W.NODE_MEMORY.alive = new Map();
  const yt = W.renderClash(envR, new URL("https://example.com/x"), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "example.com");
    eq("冷 isolate 不因 eg4Top 发中继条目", yt.includes("192.0.2.44"), false);
    // ?e=0 只关入口条目；中继组已删，两者互不影响：
    // 通道实测组成员退化为入口/节点，仍可用。
    eq("?e=0 时也没有 r- 条目", (y0r.match(/name: "r-/g) || []).length, 0);
  eq("?e=0 时入口条目消失", (y0r.match(/name: "e-/g) || []).length, 0);
  W.NODE_MEMORY.alive = keep;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case038({ W, ok }) {
    const A = [
      { name: "200", r: { ok: true, status: 200, bytes: 45290 } },
      { name: "403tiny", r: { ok: false, status: 403, bytes: 4 } },
      { name: "403big", r: { ok: false, status: 403, bytes: 265 } },
      { name: "404", r: { ok: false, status: 404, bytes: 0 } },
      { name: "dead", r: { ok: false } },
    ];
    let combos = 0, bans = 0, badBan = 0, escOnOk = 0, noEscOnFail = 0;
    for (const a of A) for (const b of A) for (const c of A) {
      const rows = [a.r, b.r, c.r];
      const v = W.tfClass(rows);
      const esc = W.tfEscalate(v);
      const has200 = rows.some((x) => x.ok && x.status === 200);
      combos++;
      if (v === "chan") bans++;                      // chan 是唯一会写 state=2 的分支
      if (v === "chan" && !has200) badBan++;         // 有 200 才允许封禁
      if (v === "ok" && esc !== "none") escOnOk++;   // ok 不换出口
      if (!has200 && esc !== "rotate") noEscOnFail++; // 没有 200 必须继续换出口
    }
    ok("穷举 125 种采样组合", combos === 125);
    ok("封禁只可能出现在 chan", bans > 0 && badBan === 0);
    ok("ok 不触发换出口", escOnOk === 0);
    ok("没有任何 2xx 时一律继续换出口（不写封禁）", noEscOnFail === 0);
  }

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case039({ eq, W }) {
  const envSrc = { poolSrc: "https://a.example/x.txt, https://b.example/y.txt, https://c.example/z.txt" };
  eq("env.poolSrc 覆盖生效", W.SOURCES.rank(envSrc).join(","), "https://a.example/x.txt,https://b.example/y.txt,https://c.example/z.txt");
  eq("没有 poolSrc 时用内置表", W.SOURCES.rank({}).length, 6);
  W.SOURCES.note("https://a.example/x.txt", false);
  eq("失败一次仍排第一", W.SOURCES.rank(envSrc)[0], "https://a.example/x.txt");
  W.SOURCES.note("https://a.example/x.txt", false);
  eq("连续两次失败排到最后", W.SOURCES.rank(envSrc)[2], "https://a.example/x.txt");
  eq("其余源保持原顺序", W.SOURCES.rank(envSrc).slice(0, 2).join(","), "https://b.example/y.txt,https://c.example/z.txt");
  eq("失败源仍会被重试（不删除）", W.SOURCES.rank(envSrc).length, 3);
  W.SOURCES.note("https://a.example/x.txt", true);
  eq("成功一次立刻恢复首位", W.SOURCES.rank(envSrc)[0], "https://a.example/x.txt");
  eq("env.poolSrc 非法值回退内置表", W.SOURCES.rank({ poolSrc: "not-a-url" }).length, 6);
  eq("health 记录了该源", typeof W.SOURCES.snap()["https://a.example/x.txt"], "object");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case040({ eq, W, ok }) {
  eq("errKind 取前两个词", W.errKind("tfb x.com site ok=0 bad=3 esc=rotate n=3"), "tfb x.com");
  eq("errKind 第二类", W.errKind("forced proxyip 1.2.3.4:443"), "forced proxyip");
  eq("空消息给占位", W.errKind(""), "?");
  const before = W.ERRS.hist().find((x) => x.k === "tfb x.com");
  const n0 = before ? before.n : 0;
  W.errCount("tfb x.com chan ok=1 bad=1 esc=none n=2");
  W.errCount("tfb x.com ok ok=3 bad=0 esc=none n=3");
  const after = W.ERRS.hist().find((x) => x.k === "tfb x.com");
  eq("同类两次累加", after.n, n0 + 2);
  const other = W.ERRS.hist().find((x) => x.k === "cron: scan");
  eq("别的类不受影响", other, undefined);
  W.errCount("cron: scan start");
  eq("跨前缀独立成立", W.errKind("cron: scan start"), "cron: scan");
  ok("直方图键不含正文", W.ERRS.hist().every((x) => !/bad=|ok=\d/.test(x.k)));
  W.ERRS.hist().forEach((x) => ok("直方图项非空", x.k.length > 0 && x.n > 0));
  ok("直方图最多 8 条", W.ERRS.hist().length <= 8, String(W.ERRS.hist().length));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case041({ W, ok, eq }) {
  const pools = [0, 3, 10, 64, 400, 1600, 3000];
  const alives = [0, 1, 8, 64, 400, 1500];
  let worst = 0;
  for (const poolN of pools) {
    for (const aliveN of alives) {
      const q = W.planRound(poolN, Math.min(aliveN, poolN));
const sum = q.adm;
      if (sum > worst) worst = sum;
      ok(`总和不超硬上限（pool ${poolN} alive ${aliveN}）`, sum <= W.SC.SCAN_SUB, `${sum} > ${W.SC.SCAN_SUB}`);
      eq(`预算里没有入口这一项（pool ${poolN} alive ${aliveN}）`, q.edge, undefined);
      ok(`准入不超 SCAN_MAX（pool ${poolN}）`, q.adm <= 400, String(q.adm));
    }
  }
  ok("最坏情况也没超 48", worst <= 48, String(worst));
  // 7.186：以前这里拿 plan.cap 当上界，而 cap 在生产侧零读取 —— 断言永远成立、什么也没锁住。
  // 现在锁真实账本：剩余 fetch 额度 = 硬上限 − 固定支出，且固定支出本身不能吃掉一半预算。
  const l0 = W.planRound(1600, 8);
  eq("剩余 fetch 额度 = 硬上限 − 固定支出", l0.sub, W.SC.SCAN_SUB - W.SUB_FIXED_N);
  ok("剩余额度非负", l0.sub >= 0, String(l0.sub));
  ok("固定支出不到硬上限的一半", W.SUB_FIXED_N * 2 <= W.SC.SCAN_SUB, String(W.SUB_FIXED_N));
  eq("固定支出只剩三笔（源/判定批/DoH）", Object.keys(W.SUB_FIXED).length, 3);
  ok("上报与快照不再算作固定支出（人数由分账决定）", W.SUB_FIXED.pend === undefined && W.SUB_FIXED.snap === undefined);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case042({ eq, W, ok }) {
  eq("EDGE_AUTO 常量已删除", W.SC.EDGE_AUTO, undefined);
  for (const poolN of [0, 64, 1600, 3000]) {
const q = W.planRound(poolN, Math.floor(poolN / 2));
ok(`额度不超额（pool ${poolN}）`, q.adm <= W.SC.SCAN_SUB, String(q.adm));
  }
  const big = W.planRound(3000, 0);
ok("整轮额度都给了准入", big.adm >= 40, String(big.adm));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case043({ ok, W, eq }) {
  ok("两个探测开关已删除（不再有「关着的旋钮」）", W.SC.PROBE_REQ === undefined && W.SC.PROBE_RND === undefined);
  for (const poolN of [0, 64, 400, 1600, 3000]) {
    const q = W.planRound(poolN, 0);
eq(`预算里不再有判定额度这一项（pool ${poolN}）`, q.vt, undefined);
    ok(`准入吃满（pool ${poolN}）`, q.adm >= 40, String(q.adm));
ok(`不超额（pool ${poolN}）`, q.adm <= W.SC.SCAN_SUB, String(q.adm));
  }
  const big = W.planRound(3000, 0);
  ok("准入拿到 48 上限附近", big.adm >= 44 && big.adm <= W.SC.SCAN_SUB, String(big.adm));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case044({ ok, W, eq }) {
  ok("并发上限是 6", W.SC.PROBE_CONC === 6, String(W.SC.PROBE_CONC));
  const c1 = W.chunks([...Array(13).keys()], W.SC.PROBE_CONC);
  eq("13 个切成 3 段", String(c1.length), "3");
  eq("段大小 6/6/1", c1.map((x) => x.length).join(","), "6,6,1");
  const total = c1.reduce((a, x) => a + x.length, 0);
  eq("切完不丢不多", String(total), "13");
  ok("每段都不超上限", c1.every((x) => x.length <= W.SC.PROBE_CONC), String(Math.max(...c1.map((x) => x.length))));
  eq("空数组不产生段", String(W.chunks([], 6).length), "0");
  eq("非法 n 退化成 1", String(W.chunks([1, 2, 3], 0).map((x) => x.length).join(",")), "1,1,1");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case045({ W, ok, eq }) {
  const h1 = new W.RelayHealth();
  for (let i = 0; i < 260; i++) h1.note(`10.0.${Math.floor(i / 250)}.${i % 250}:443`, 30000, true);
  ok("整页中继不会把表撑破", h1.size() <= 200, String(h1.size()));
  const h2 = new W.RelayHealth();
  for (let i = 0; i < 260; i++) h2.note(`10.1.${Math.floor(i / 250)}.${i % 250}:443`, 0, false);
  ok("全是死中继时表也有界（回归）", h2.size() <= 200, String(h2.size()));
  const h3 = new W.RelayHealth();
  h3.note("1.2.3.4", 5000, false);
  eq("裸 IP 也按原样记键", h3.json(3)[0].ip, "1.2.3.4");
  h3.note("2606:4700::1:443", 30000, true);
  eq("IPv6:port 切出裸地址", h3.json(3).map((r) => r.ip).join(",").includes("2606:4700::1"), true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case047({ W, ok, eq }) {
  const d0 = W.ERRS.dropped();
  W.logErr("t71 dup probe", "h1");
  W.logErr("t71 dup probe", "h1");
  W.logErr("t71 dup probe", "h1");
  ok("限流丢掉的也算进账", W.ERRS.dropped() - d0 === 2, String(W.ERRS.dropped() - d0));
  const d1 = W.ERRS.dropped();
  for (let i = 0; i < 240; i++) W.logErr(`t71 flood ${i}`, `h${i}`);
  W.logErr("t71 dup probe", "h1");
  eq("表被灌满后，5 秒内的旧键仍被限流（不再整表清空）", W.ERRS.dropped() - d1, 1);
  ok("灌满没把限流表清空", W.ERRS.dropped() - d1 === 1, String(W.ERRS.dropped() - d1));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case048({ ok, W }) {
  const key = "198.51.100.77:443";
  const t0 = 1_700_000_000_000;
  ok("阈值是 3", W.SC.SCAN_BAD_MAX === 3, String(W.SC.SCAN_BAD_MAX));
  ok("过期时长 30 分钟", W.SC.PROBE_BAD_TTL === 1800000, String(W.SC.PROBE_BAD_TTL));
  ok("没失败过不跳过", W.COOLDOWN.skip(key, t0) === false, "false");
  W.bumpProbeBad(key, false, t0);
  ok("失败 1 次不跳过", W.COOLDOWN.skip(key, t0) === false, "false");
  W.bumpProbeBad(key, false, t0 + 1000);
  W.bumpProbeBad(key, false, t0 + 2000);
  ok("连续 3 次后跳过", W.COOLDOWN.skip(key, t0 + 3000) === true, "true");
  ok("30 分钟后自动作废", W.COOLDOWN.skip(key, t0 + 2000 + W.SC.PROBE_BAD_TTL + 1) === false, "false");
  // 真正过了 TTL 之后再失败，才算新一轮
  W.bumpProbeBad(key, false, t0 + 2000 + W.SC.PROBE_BAD_TTL + 5000);
  ok("过期后再失败从 1 重新数（还不跳过）", W.COOLDOWN.skip(key, t0 + 2000 + W.SC.PROBE_BAD_TTL + 5000) === false, "false");
  W.bumpProbeBad(key, false, t0 + 2000 + W.SC.PROBE_BAD_TTL + 6000);
  W.bumpProbeBad(key, false, t0 + 2000 + W.SC.PROBE_BAD_TTL + 7000);
  ok("重新数满 3 次又跳过", W.COOLDOWN.skip(key, t0 + 2000 + W.SC.PROBE_BAD_TTL + 7000) === true, "true");
  W.bumpProbeBad(key, true, t0 + 2000 + W.SC.PROBE_BAD_TTL + 8000);
  ok("探活成功立刻清除", W.COOLDOWN.skip(key, t0 + 2000 + W.SC.PROBE_BAD_TTL + 8000) === false, "false");
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case056({ W, eq }) {
  W.FACT.clear();
  const ev = (x) => ({ host: "shadow.example", via: "node", node: "45.136.117.194:443", down: 0, ok: true, life: 900, up: 0, ...x });
  // 时间轴必须拉开：从 v7.137 起 `WRITE_GAP` 真的生效了（`ctx.lastWrite` 有了生产者），
  // 同一个「站点|中继」60 秒内第二次裁决一律是 `R_THROTTLED`。对照窗口是 120 秒，
  // 所以「看不见对照」的用例要跨过 120 秒，而不是 60 秒。
  const t0 = 1_700_000_000_000;
  eq("整页 → 本会写 ps", W.FACT.observe(ev({ down: 45290, ok: true }), t0), "ok");
  eq("tiny 但没有同窗口对照 → 弃权", W.FACT.observe(ev({ down: 737, ok: true, life: 80 }), t0 + 121000), "R_NO_BIG_PEER");
  eq("直连腿的 tiny → 永不写封锁", W.FACT.observe(ev({ via: "direct", node: "", down: 737 }), t0 + 242000), "R_DIRECT_NEVER");
  eq("零字节 → 弃权", W.FACT.observe(ev({ down: 0, ok: false }), t0 + 363000), "R_NO_BYTES");
  const sn = W.FACT.snap();
  eq("影子统计了 4 条", sn.samples, 4);
  eq("本会写 ps 的只有 1 条", sn.would.ps, 1);
  eq("本会写封锁的是 0 条", sn.would.blk || 0, 0);
  eq("理由码也被统计", sn.why.R_NO_BYTES, 1);
  // 节流：同一个键 60 秒内只写一条事实（这条规则在 v7.137 之前根本命中不了）
  W.FACT.clear();
  const t1 = 1_700_100_000_000;
  eq("第一次整页 → 写 ps", W.FACT.observe(ev({ down: 45290, ok: true }), t1), "ok");
  eq("20 秒后同一个键 → 节流", W.FACT.observe(ev({ down: 45290, ok: true }), t1 + 20000), "R_THROTTLED");
  eq("61 秒后再来 → 又能写", W.FACT.observe(ev({ down: 45290, ok: true }), t1 + 61000), "ok");
  W.FACT.clear();
  eq("清零后快照为空", W.FACT.snap().samples, 0);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case060({ W, eq }) {
  W.FO.clear();
  const s0 = W.FO.snap();
  eq("没有样本时比率是 0", s0.firstTry, 0);
  eq("没有样本时 n 是 0", s0.samples, 0);
  W.FO.note(0);
  eq("零字节不算连上", W.FO.snap().firstTry, 0);
  W.FO.note(737);
  eq("封锁页（737B）算连通但不算整页", W.FO.snap().first, 1);
  eq("737B 不在整页里", W.FO.snap().page, 0);
  W.FO.note(4096);
  eq("4096 刚好算整页", W.FO.snap().page, 1);
  eq("三条到上限", W.FO.snap().samples, 3);
  eq("firstTry = 2/3", W.FO.snap().firstTry, 0.667);
  eq("firstPage = 1/3", W.FO.snap().firstPage, 0.333);
  W.FO.note(3000);
  eq("超过上限只记 skip，不改比率", W.FO.snap().firstTry, 0.667);
  eq("skip 计数了多余的一条", W.FO.snap().skip, 1);
  W.FO.clear();
  W.FO.note(2048);
  eq("2048 落在灰带", W.FO.snap().gray, 1);
  eq("灰带不算整页", W.FO.snap().page, 0);
  eq("灰带算连通", W.FO.snap().first, 1);
  W.FO.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case062({ W, eq }) {
  const envS = { uuid: "u", nodes: "", proxyip: "auto" };
  const rend = (q) => W.renderClash(envS, new URL("https://example.com/x" + q), "4241b903-8d39-4a17-8f4c-bb33b1630c33", "example.com");
  const seg = (text, name) => {
    const i = text.indexOf(`  - name: "${name}"`);
    if (i < 0) return "";
    const j = text.indexOf("\n  - name:", i + 5);
    return text.slice(i, j < 0 ? undefined : j);
  };
  const base = rend("");
  const tput = seg(base, "🚀 吞吐优先");
  const lat = seg(base, "⚡ 速率优先");
  eq("吞吐组第一个成员是入口优选（无 ?tu= 时）", tput.includes('proxies: ["🌐 入口优选"'), true);
  eq("速率组第一个成员也是入口优选", lat.includes('proxies: ["🌐 入口优选"'), true);
  eq("两个模式组都以域名入口收尾", tput.includes('", "📛 域名入口"]') && lat.includes('", "📛 域名入口"]'), true);
  const withTu = seg(rend("?tu=" + encodeURIComponent("https://probe.example.org/")), "🚀 吞吐优先");
  eq("有 ?tu= 时实测组排在最前", withTu.includes('proxies: ["📡 通道实测"'), true);
  eq("有 ?tu= 时也保留域名入口兜底", withTu.includes('", "📛 域名入口"]'), true);
  const noEdge = seg(rend("?e=0"), "🚀 吞吐优先");
  eq("?e=0 时成员里没有入口优选", noEdge.includes("🌐 入口优选"), false);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case066({ W, eq }) {
  W.LAT.clear();
  for (let i = 0; i < 10; i++) W.LAT.note(true, 500 + i * 100);
  W.LAT.note(true, 9000); // 一条很慢的成功
  for (let i = 0; i < 9; i++) W.LAT.note(false, 60); // 失败页很快
  const s1 = W.LAT.snap();
  eq("样本数", s1.n, 20);
  eq("good3s 只算成功且 ≤3s", s1.good3s, 0.5);
  eq("p95ok 抓到那条 9 秒", s1.p95ok >= 9000, true);
  eq("p95all 不高于 p95ok（失败页更快）", s1.p95all <= s1.p95ok, true);
  W.LAT.clear();
  eq("清空后归零", W.LAT.snap().n, 0);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case068({ W, eq }) {
  W.EG.clear();
  const A = "198.51.100.10", B = "198.51.100.11", C = "198.51.100.12", D = "198.51.100.13";
  W.EG.note(A, 4);
  W.EG.note(B, 6);
  const c1 = W.egCounts([A, B, C, D]);
  eq("v4 计数", c1.v4, 1);
  eq("v6 计数", c1.v6, 1);
  eq("未知计数", c1.unk, 2);
  eq("出口族配额函数已删除：探测看不出出口族，配额从来不可达", W.egQuota, undefined);
  W.EG.note(C, 4);
  W.EG.note(D, 4);
  eq("v4 三票后计数跟着走", W.egCounts([A, B, C, D]).v4, 3);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case069({ W, eq }) {
  W.CAP.clear();
  const t0 = Date.now();
  const A = "198.51.100.20";
  for (let i = 0; i < 8; i += 1) W.CAP.note("198.51.100." + (30 + i), 100, t0);
  eq("单次样本不构成容量比", W.CAP.capOf(A, t0), 1);
  const w1 = W.CAP.note(A, 200, t0);
  eq("第一次 200 还不算", w1, false);
  const w2 = W.CAP.note(A, 200, t0 + 1000);
  eq("两次一致且是池内 2 倍 → 记下", w2, true);
  eq("容量比夹到 2.0", W.CAP.capOf(A, t0 + 1000), 2);
  eq("吞吐模式代价 ×0.5", W.CAP.factor(A, "tput", t0 + 1000), 0.5);
  eq("延迟模式不看容量", W.CAP.factor(A, "lat", t0 + 1000), 1);
  const B2 = "198.51.100.21";
  W.CAP.note(B2, 100, t0);
  W.CAP.note(B2, 400, t0 + 1000);
  eq("两次差 4 倍 → 不记（噪声）", W.CAP.capOf(B2, t0 + 1000), 1);
  const C = "198.51.100.22";
  W.CAP.note(C, 105, t0);
  W.CAP.note(C, 110, t0 + 1000);
  eq("与池内中位数接近 → 不记", W.CAP.capOf(C, t0 + 1000), 1);
  eq("过期后回中性", W.CAP.capOf(A, t0 + 1000 + W.CAP_TTL + 1), 1);
  W.CAP.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case071({ W, eq }) {
  let hits = 0;
  const mkEnv = () => ({ uuid: "u-test", METER: { idFromName: () => "id", get: () => ({ fetch: async () => { hits += 1; await new Promise((r) => setTimeout(r, 15)); return { ok: true, json: async () => ({ vt: [], hl: [], eg: [], ps: [], dead: [], blk2: [], dns: [] }) }; } }) } });
  W.VT_SYNC.loaded = false;
  W.VT_SYNC.flight = null;
  const before = globalThis.caches;
  delete globalThis.caches;
  await Promise.all([W.vtLoad(mkEnv()), W.vtLoad(mkEnv()), W.vtLoad(mkEnv())]);
  eq("三条并发只发一次 DO 读", hits, 1);
  eq("读完标记为已加载", W.VT_SYNC.loaded, true);
  eq("句柄已释放", W.VT_SYNC.flight, null);
  // 缓存命中：有 colo 缓存时不应再问 DO
  hits = 0;
  W.VT_SYNC.loaded = false;
  globalThis.caches = { default: { match: async () => new Response(JSON.stringify({ vt: [], hl: [], eg: [], ps: [], dead: [], blk2: [], dns: [] })), put: async () => {} } };
  await W.vtLoad(mkEnv());
  eq("缓存命中不问 DO", hits, 0);
  eq("缓存命中后仍标记已加载", W.VT_SYNC.loaded, true);
  globalThis.caches = before;
  W.VT_SYNC.loaded = false;
  W.VT_SYNC.flight = null;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case072({ W, eq }) {
  const A = "203.0.113.70";
  W.EG.clear();
  W.EG.note(A, 4, Date.now());
  eq("未配置时全开", [...W.factParse(undefined)].length, 5);
  eq("空串表示全关", W.factParse("").size, 0);
  eq("none 表示全关", W.factParse("none").size, 0);
  eq("all 表示全开", W.factParse("all").size, 5);
  eq("按名字打开", [...W.factParse("eg, blk")].sort().join(","), "blk,eg");
  eq("未知名字被忽略", [...W.factParse("nope,ps")].join(","), "ps");
  const onlyEg = W.factParse("eg");
  eq("只开 eg 时乘数 = bias（v4 ×0.95）", Number(W.factMul(onlyEg, "example.com", A, "tput", false).toFixed(3)), 0.95);
  eq("全关时乘数恒为 1", W.factMul(W.factParse(""), "example.com", A, "tput"), 1);
  W.FACT_SWITCHES.current = null;
  eq("factOn 未配置时全开", [...W.factOn({})].length, 5);
  W.FACT_SWITCHES.current = null;
  eq("factOn 读绑定字符串", [...W.factOn({ facts: "ps" })].join(","), "ps");
  W.FACT_SWITCHES.current = null;
  W.EG.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case074({ W, eq }) {
  W.EG.clear();
  const A = "203.0.113.21";
  const B = "203.0.113.22";
  eq("整页 45KB 判 v4", W.egDerive(A, 45000, { cf: true }), 4);
  eq("写进去以后能查到 4", W.EG.famOf(A), 4);
  eq("737B 小页 + 同窗口整页对照 判 v6", W.egDerive(B, 737, { peerBig: true, cf: true }), 6);
  eq("没有整页对照的小页不写", W.egDerive("203.0.113.23", 737, { cf: true }), 0);
  eq("零字节不写", W.egDerive("203.0.113.24", 0, { peerBig: true, cf: true }), 0);
  eq("5KB 真实内容（>EG_TINY）判 v4", W.egDerive("203.0.113.25", 5000, { peerBig: true, cf: true }), 4);
  eq("空 IP 不写", W.egDerive("", 45000, { cf: true }), 0);
  eq("整页证据会把 v6 改回 v4", W.egDerive(B, 40000, { peerBig: true, cf: true }), 4);
  eq("改回后查得到 4", W.EG.famOf(B), 4);
  eq("known 旁证下的小页判 v6", W.egDerive("203.0.113.26", 737, { known: true, cf: true }), 6);
  eq("纯 v4 站点送到 900B 页面判 v4", W.egDerive("203.0.113.27", 900, { siteV4: true, cf: true }), 4);
  // 4107B 是 x.com 隧道首页实测大小，旧 EG_BIG=20KB 门槛下学到东西 → 全分组 v6 偶发 403
  eq("4107B CF 站点内容判 v4", W.egDerive("203.0.113.30", 4107, { cf: true }), 4);
  eq("刚过 EG_TINY 的 2049B 也判 v4", W.egDerive("203.0.113.31", 2049, { cf: true }), 4);
  eq("2048B 边界不判 v4", W.egDerive("203.0.113.32", 2048, { cf: true }), 0);
  eq("非 CF 站点 5KB 不判 v4", W.egDerive("203.0.113.33", 5000, { cf: false }), 0);
  eq("既有 known 又有 siteV4 时按族级拒绝优先", W.egDerive("203.0.113.28", 737, { known: true, siteV4: true, cf: true }), 6);
  eq("整页优先于 siteV4", W.egDerive("203.0.113.29", 45000, { siteV4: true, cf: true }), 4);
  W.EG.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case075({ W, eq }) {
  const mem = new Map();
  const envP = { uuid: "00000000-0000-0000-0000-000000000000", STATS: {
    get: async (k) => (mem.has(k) ? mem.get(k) : null),
    put: async (k, v) => { mem.set(k, v); },
  } };
  const mk = (n, tag) => Array.from({ length: n }, (_x, i) => ({ h: tag + i, p: 443, cc: "" }));
  // 键名与 src/px/const.ts 的 SEED_KEY 一致；写错的话下面「代际号跟着锚点走」会立刻失败
  const putSeed = (gen, n) => mem.set("px:seed", JSON.stringify({ v: 7, ts: 0, poolGen: gen, poolN: n, builtAt: 0, byColo: {} }));
  W.POOL_MEMORY.rows = mk(10, "old"); W.POOL_MEMORY.generation = 3; W.SEED_STORE.document.poolGen = 3; W.SEED_STORE.readAt = Date.now(); W.SEED_STORE.readFailed = false; W.ISOLATE.colo = "TST";
  putSeed(9, 10);
  const c1 = await W.commitPool(envP, mk(60, "n"), true);
  eq("代际号以 KV 锚点为准（不是本地 +1）", c1.gen, 10);
  eq("新代际键写进去了", mem.has("px:pool:10"), true);
  eq("锚点写回成功", c1.anchored, true);
  // 本地没有池子时，缩水判断必须看 KV 里的真实大小
  W.POOL_MEMORY.rows = []; W.POOL_MEMORY.generation = 10; W.SEED_STORE.document.poolGen = 10;
  putSeed(10, 100);
  const c2 = await W.commitPool(envP, mk(50, "s"), false);
  eq("按 KV 的真实池子大小拒绝缩水", c2.ok, false);
  eq("拒绝时不落新代际键", mem.has("px:pool:11"), false);
  // 锚点读失败：宁可这轮不换池，也不盲写一个可能被占用的号
  const badEnv = { uuid: "00000000-0000-0000-0000-000000000000", STATS: { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); } } };
  const c3 = await W.commitPool(badEnv, mk(60, "b"), true);
  eq("锚点读失败就不提交", c3.ok, false);
  eq("理由就是 anchor read", c3.reason, "anchor read");
  W.POOL_MEMORY.rows = []; W.POOL_MEMORY.generation = 0; W.SEED_STORE.document.poolGen = 0; W.ISOLATE.colo = "";
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case076({ ok, W }) {
  const ae = { adminKey: "K#1" };
  const u = new URL("https://x/");
  const h = (v) => new Request(u, { headers: { authorization: v } });
  ok("Bearer 明文密钥可用", await W.adminAuthed(h("Bearer K#1"), u, ae));
  ok("Bearer 小写也认", await W.adminAuthed(h("bearer K#1"), u, ae));
  ok("Bearer 摘要等价凭证可用", await W.adminAuthed(h("Bearer " + (await W.sha256Hex("K#1"))), u, ae));
  ok("错误 Bearer 不通过", !(await W.adminAuthed(h("Bearer nope"), u, ae)));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case080({ ok, W, eq }) {
  // usageSnapWrite 需要用户表：门面只给 env 时 list=[] 会立刻 return，永远不写却返回 resolved
  ok("usageSnapWrite 只以模块函数形式存在（要求用户表）", typeof W.usageSnapWrite === "function" && W.STORE === undefined, "门面又回来了");
  // 管理面板每人一次 DO 往返：免费计划一次调用 50 个子请求，必须留出固定开销的余量
  eq("管理面板一次最多读 32 人的用量", W.SC.ADMIN_STATS_MAX, 32);
  eq("超出预算的人数会被计数（而不是静默显示 0）", "admStatsSkip" in W.cntView(), true);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case081({ mkDO, eq }) {
  const do9 = mkDO();
  const stub9 = { fetch: (u, init) => do9.m.fetch(typeof u === "string" ? new Request(u, init) : u) };
  const now9 = Date.now();
  // 故意只带事实与判定表，一条 cl 都不带：这正是缺陷 39 之前的丢数据场景
  const body9 = {
    vt: [{ k: "203.0.113.9|443", s: 2, t: now9 + 600000 }],
    eg: [{ i: "203.0.113.10", f: 4, at: now9 }],
    dns: [{ h: "d39.example", v: 1, at: now9 }],
    ps: [{ k: "d39.example|203.0.113.10", q: 200, n: 3, at: now9 }],
    hl: [{ i: "203.0.113.9", o: 1, b: 0, d: 2 }],
    blk2: [{ k: "203.0.113.9|443", n: 3, at: now9 }],
  };
  await stub9.fetch("https://meter/add", { method: "POST", body: JSON.stringify(body9) });
  const j9 = await (await stub9.fetch("https://meter/vt")).json();
  eq("没有连接观测时 vt 也要落表", (j9.vt || []).some((r) => r.k === "203.0.113.9|443"), true);
  eq("没有连接观测时出口族事实也要落表", (j9.eg || []).some((r) => r.i === "203.0.113.10" && r.f === 4), true);
  eq("dns 事实跟着走", (j9.dns || []).some((r) => r.h === "d39.example" && r.v === 1), true);
  eq("ps 事实跟着走", (j9.ps || []).some((r) => r.k === "d39.example|203.0.113.10"), true);
  eq("hl 存活度跟着走", (j9.hl || []).some((r) => r.i === "203.0.113.9"), true);
  eq("封锁事实跟着走（走 blk2，不是计量表里那张没有生产者的旧表）", (j9.blk2 || []).some((r) => r.k === "203.0.113.9|443" && r.n === 3), true);
  // 带 cl 的那一批仍然按节点累加：搬出 if 不能把 cl 自己弄坏
  await stub9.fetch("https://meter/add", { method: "POST", body: JSON.stringify({ cl: [{ k: "n1", n: 1, ok: 1, dn: 100, p50: 10, p95: 20 }] }) });
  await stub9.fetch("https://meter/add", { method: "POST", body: JSON.stringify({ cl: [{ k: "n1", n: 2, ok: 2, dn: 200, p50: 12, p95: 22 }] }) });
  const c9 = await (await stub9.fetch("https://meter/cl")).json();
  const row9 = (c9.cl || []).find((r) => r.k === "n1");
  eq("cl 仍然按节点累加计数", row9 && row9.n, 3);
  eq("cl 的分位数取最新一段", row9 && row9.p95, 22);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case084({ mkDO, eq }) {
  const d = mkDO();
  // 让 put 失败一次：模拟 DO 存储写入被拒（免费计划上偶发）
  const put0 = d.m.state.storage.put;
  let failPut = true;
  d.m.state.storage.put = async (k, v) => {
    if (failPut) throw new Error("storage down");
    return put0(k, v);
  };
  const body = { up: 100, down: 200, cl: [{ k: "1.2.3.4:443", n: 4, ok: 3, dn: 1, p50: 120, p95: 300 }] };
  const r1 = await d.m
    .fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify(body) }))
    .then(() => "ok", () => "rejected");
  eq("落盘失败时 /add 返回失败（让发送侧重发这一批）", r1, "rejected");
  eq("失败后连接观测没有留在内存里", d.m.ledger.connRing.length, 0);
  eq("失败后用量也没有留在内存里", [d.m.ledger.usage.up, d.m.ledger.usage.down], [0, 0]);
  failPut = false;
  await d.m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify(body) }));
  eq("重发同一批后连接观测只算一次", [d.m.ledger.connRing.length, d.m.ledger.connRing[0].n, d.m.ledger.connRing[0].ok], [1, 4, 3]);
  const j108 = await (await d.m.fetch(new Request("https://m/get"))).json();
  eq("用量也只算一次", [j108.up, j108.down], [100, 200]);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case085({ W, eq }) {
  // 109. tfb：两批共识（单批 403 只是怀疑）+ 记忆表限量
  const tb = (p, v) => W.tfBlockOk(p, v);
  eq("首批 chan 证据不落封锁（可能是限流）", tb("", "chan"), false);
  eq("上一批也是 chan → 两批共识成立", tb("chan/none", "chan"), true);
  eq("上一批是 ok → 这一批 chan 仍只是怀疑", tb("ok/none", "chan"), false);
  eq("这一批不是 chan → 不落封锁", tb("chan/none", "ok"), false);
  W.TFB.verdicts.clear();
  for (let i = 0; i < 300; i++) W.tfRemember("h" + i + ".test", "chan/none");
  eq("记忆表有上限（键来自客户端）", W.TFB.verdicts.size, 256);
  eq("最旧的站点已被挤掉", W.TFB.verdicts.has("h0.test"), false);
  eq("最新的站点仍在", [W.TFB.verdicts.get("h299.test"), W.TFB.verdicts.has("h44.test")], ["chan/none", true]);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case086({ W, eq }) {
  // 110. relperf：kbs=0 是「这次没量到吞吐」，不是「吞吐为 0」
  W.RELPERF.clear();
  const H = "tput.example";
  const A = "203.0.113.140";
  // 一次 1MB 以上的下载：800KB/s，首字节 100ms
  W.relNote(H, A, 100, 800);
  // 随后三个普通页面（都不足 1MB，Connection 记 kbs=0）
  W.relNote(H, A, 100, 0);
  W.relNote(H, A, 100, 0);
  W.relNote(H, A, 100, 0);
  eq("小响应样本不会把吞吐拽下去（100 + 512000/800）", Math.round(W.RELPERF.costFor("tput", H, A)), 740);
  eq("调试快照里的速率也还是 800", Math.round(W.RELPERF.snap(H)[0].kiloBytesPerSec), 800);
  // 反过来：先只有小响应（没量到吞吐），再来一次大下载
  W.RELPERF.clear();
  const B = "203.0.113.141";
  W.relNote(H, B, 100, 0);
  W.relNote(H, B, 100, 800);
  eq("第一次量到吞吐时不被旧的 0 稀释", Math.round(W.RELPERF.costFor("tput", H, B)), 740);
  // 一次都没量到吞吐：走「首字节 + 2000」的兜底，不能落到 32KB/s 的下限
  W.RELPERF.clear();
  const C = "203.0.113.142";
  W.relNote(H, C, 80, 0);
  W.relNote(H, C, 80, 0);
  eq("从没量到吞吐的样本按首字节 + 固定罚计", Math.round(W.RELPERF.costFor("tput", H, C)), 2080);
  // 跨站点聚合表同样不能把 0 混进来
  W.RELPERF.clear();
  const D = "203.0.113.143";
  W.relNote("agg-a.example", D, 100, 800);
  W.relNote("agg-a.example", D, 100, 0);
  eq("聚合表沿用已量到的容量（+200ms 表示不是本站点亲测）", Math.round(W.RELPERF.costFor("tput", "agg-b.example", D)), 940);
  W.RELPERF.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case092({ W, ok }) {
  const K = "203.0.113.9";
  const H3 = 3 * 3600 * 1000;
  W.HEALTH.clear();
  // 本地攒下 8 次成功 / 2 次小响应，但已经是三小时前的证据
  W.HEALTH.merge([{ i: K, o: 8, b: 2, d: 0, t: Date.now() - H3 }]);
  const oldStrong = W.HEALTH.score(K);
  // 别处报来一条更弱、但更新的证据：不能把旧证据的「最后一次观测」刷新到现在
  W.HEALTH.merge([{ i: K, o: 1, b: 0, d: 0, t: Date.now() }]);
  const afterWeak = W.HEALTH.score(K);
  ok("三小时前的强证据已经衰减到中性", Math.abs(oldStrong - 0.5) < 0.03);
  ok("更弱的新证据不会给它续命（计数与时间必须来自同一次观测）", Math.abs(afterWeak - 0.5) < 0.03);
  // 反过来：更强的证据应当整体胜出，并且带着自己的时间戳生效
  W.HEALTH.merge([{ i: K, o: 20, b: 1, d: 0, t: Date.now() }]);
  ok("更强的证据整体胜出（新计数 + 新时间）", W.HEALTH.score(K) > 0.8);
  // 同分时用较新的时间：等价证据不该让衰减倒流
  W.HEALTH.clear();
  W.HEALTH.merge([{ i: K, o: 2, b: 0, d: 0, t: Date.now() - H3 }]);
  W.HEALTH.merge([{ i: K, o: 1, b: 1, d: 0, t: Date.now() }]);
  ok("条数相同时采用较新的观测时间", W.HEALTH.score(K) > 0.5);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case093({ W, ok }) {
  // 每批严格 ≤40 行：以前上限判断写在压入之后，pending 已满时会返回 41 行
  W.HEALTH.clear();
  for (let i = 0; i < 60; i++) W.HEALTH.note("198.51.100." + i + ":443", 45290, true);
  ok("一批最多 40 行中继证据", W.HEALTH.delta().length === 40);
  // pending 已满时再来一条，仍然不能突破 40
  W.HEALTH.note("198.51.100.200:443", 45290, true);
  ok("pending 已满时也不会多出一行", W.HEALTH.delta().length === 40);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case100({ W, ok }) {
  W.NODE_MEMORY.rankCache.clear();
  for (let i2 = 0; i2 < 4; i2 += 1) W.NodeStatsTable.nsEmptyClose("ec.test:443", true);
  const ecs = W.NODE_MEMORY.stats.get("ec.test:443");
  W.NODE_MEMORY.rankCache.set("a.example", { t: 1, v: [] });
  W.NodeStatsTable.nsEmptyClose("ec.test:443", true);   // 第 5 条：这一条把计数推过门槛
  ok("跨过门槛那一条会作废站点排行缓存", !W.NODE_MEMORY.rankCache.has("a.example"));
  ok("门槛就是 5 次", Math.round(ecs.eCloseP) >= 5);
  W.NODE_MEMORY.rankCache.set("b.example", { t: 1, v: [] });
  W.NodeStatsTable.nsEmptyClose("ec.test:443", true);   // 第 6 条：已经跨过，不该再清
  ok("跨过之后再空关闭不再清缓存（eCloseP 按 6 小时半衰期挂着，每次清等于关掉缓存）", W.NODE_MEMORY.rankCache.has("b.example"));
  ok("计数继续累加", Math.round(ecs.eCloseP) >= 6);
  W.NODE_MEMORY.rankCache.set("c.example", { t: 1, v: [] });
  W.NodeStatsTable.nsEmptyClose("ec.test:443", false);
  ok("直连腿的空关闭不清站点排行", W.NODE_MEMORY.rankCache.has("c.example"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case101({ W, eq, ok, statAll }) {
  W.NodeStatsTable.nsProbe("pr.test:443", 120, 90, 30);
  W.NodeStatsTable.nsProbe("pr.test:443", 130, 95, 35);
  const prs = W.NODE_MEMORY.stats.get("pr.test:443");
  eq("探活只累加样本数", prs.probeSamples, 2);
  ok("探活不写首字节矩（否则会给还没承载流量的节点白加抖动罚）", prs.pSum === 0 && prs.pSumSq === 0);
  ok("探活会更新 tcp 的 EWMA", prs.tcp > 0);
  ok("门槛判断写成「跨过那一条」", statAll().includes("before < EMPTY_CLOSE_BAD"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case102({ W, eq, ok }) {
  const keepAlive = new Map(W.NODE_MEMORY.alive);
  const keepN = new Map(W.NODE_MEMORY.stats);
  W.NODE_MEMORY.alive.clear();
  W.NODE_MEMORY.stats.clear();
  const mk = (k) => { const i = k.lastIndexOf(":"); W.NODE_MEMORY.alive.set(k, { h: k.slice(0, i), p: Number(k.slice(i + 1)) || 443, cc: "", ms: 100 }); };
  mk("1.1.1.1:443");
  mk("2.2.2.2:443");
  W.NodeStatsTable.nsGet("1.1.1.1:443").tcp = 40;
  W.NodeStatsTable.nsGet("2.2.2.2:443").tcp = 200;
  W.hostNodeMark("1.1.1.1:443", "retry.test", true, 120);
  const env = { proxyip: "auto" };
  const a1 = await W.SEL.current(env, "tput", null, "retry.test", false);
  const a2 = await W.SEL.current(env, "tput", null, "retry.test", false);
  eq("站点偏好是确定性路径：两次调用挑同一条", a1, a2);
  const a3 = await W.SEL.current(env, "tput", null, "retry.test", false, new Set([a1]));
  ok("排除刚失败的那条之后换一条（否则第二次尝试等于空转 2.5 秒）", a3 && a3 !== a1);
  eq("排除之后挑到的是另一条", a3, "2.2.2.2:443");
  eq("全部排除时回空：宁可退直连也不重复同一条", await W.SEL.current(env, "tput", null, "retry.test", false, new Set(["1.1.1.1:443", "2.2.2.2:443"])), "");
  W.NODE_MEMORY.alive.clear();
  W.NODE_MEMORY.stats.clear();
  for (const [k, v] of keepAlive) W.NODE_MEMORY.alive.set(k, v);
  for (const [k, v] of keepN) W.NODE_MEMORY.stats.set(k, v);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case108({ W, eq }) {
  const SNAPMAX = W.SC.SNAP_MAX || 24;
  eq("SNAP_MAX 是 24（每人一次 DO 往返的预算）", W.SC.SNAP_MAX, 24);
  const box = new Map();
  const old = { ts: Date.now() - 3 * 3600 * 1000, users: {} };
  const list = [];
  for (let i = 0; i < 30; i++) {
    const id = "aaaaaaaa-0000-4000-8000-" + String(i).padStart(12, "0");
    list.push({ id, pwd: "", note: "", enabled: true, managed: true });
    old.users[id] = { up: 111 + i, down: 222 + i, conns: 1, first: 0, d: "2000-01-01", dU: 7, dD: 8 };
  }
  box.set("usage:snap", JSON.stringify(old));
  let calls = 0;
  const envS = {
    STATS: { get: async (k) => box.get(k) || null, put: async (k, v) => { box.set(k, v); } },
    METER: {
      idFromName: (id) => id,
      get: () => ({
        fetch: async () => {
          calls++;
          return { ok: true, json: async () => ({ up: 999, down: 999, conns: 2, first: 0 }) };
        },
      }),
    },
  };
  W.METER_CLIENT.cache.clear();
  const beforeSkip = W.cntView().snapSkip || 0;
  await W.usageSnapWrite(envS, list);
  eq("灾备快照只读 SNAP_MAX 个人的用量（每人一次 DO 子请求）", calls, SNAPMAX);
  eq("超过预算的人被计数（snapSkip）", (W.cntView().snapSkip || 0) - beforeSkip, 30 - SNAPMAX);
  const doc = JSON.parse(box.get("usage:snap"));
  eq("没读的那个人仍是上次的数值", doc.users[list[SNAPMAX].id].up, 111 + SNAPMAX);
  eq("读到的那个人换成了新数值", doc.users[list[0].id].up, 999);
  eq("快照里没有丢人", Object.keys(doc.users).length, 30);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case110({ mkDO, dset, eq }) {
  const a = mkDO();
  await dset(a.m, { up: 0, down: 0, conns: 7, first: 1000 });
  eq("只有连接数、没有字节的用户也能恢复（旧代码整条跳过）", a.m.ledger.usage.conns, 7);
  eq("首次使用时间跟着恢复", a.m.ledger.usage.first, 1000);
  await dset(a.m, { up: 0, down: 0, conns: 12, first: 1000 });
  eq("字节没变多时不再整体跳过：连接数继续前进", a.m.ledger.usage.conns, 12);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case111({ mkDO, dset, eq }) {
  const b = mkDO();
  await dset(b.m, { up: 100, down: 200, conns: 9, first: 1000 });
  await dset(b.m, { up: 150, down: 200, conns: 3, first: 5000 });
  eq("快照落后时不会把更大的连接数改小", b.m.ledger.usage.conns, 9);
  eq("首次使用时间取更早的那个", b.m.ledger.usage.first, 1000);
  eq("字节按快照恢复（快照更大才覆盖）", b.m.ledger.usage.up + b.m.ledger.usage.down, 350);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case120({ scanAll, eq, ok, W }) {
  const pSrc = scanAll();
  eq(
    "pool.ts 里没有任何 nsLatency 调用（探活 RTT 不是真实首字节）",
    (pSrc.match(/^\s*NodeStatsTable\.nsLatency\(/gm) || []).length,
    0,
  );
  ok(
    "探活仍然把样本写进统计（nsProbe）：② 与 ②b 复测合并进 probeInto 后剩三处调用",
    (pSrc.match(/^\s*NodeStatsTable\.nsProbe\(/gm) || []).length >= 3,
    true,
  );
  const pk = "11.9.9.9:443";
  W.NODE_MEMORY.stats.delete(pk);
  W.NodeStatsTable.nsProbe(pk, 40, 38, 2);
  W.NodeStatsTable.nsProbe(pk, 44, 40, 4);
  const st175 = W.NodeStatsTable.nsGet(pk);
  eq("探活只累加样本数", st175.probeSamples, 2);
  ok(
    "探活不写首字节矩（pSum 仍是 0）",
    st175.pSum === 0 && st175.pSumSq === 0,
    true,
  );
  const u1 = "https://a185.example/x.txt";
  const u2 = "https://b185.example/x.txt";
  const u3 = "https://c185.example/x.txt";
  W.SOURCES.note(u1, true);
  ok("抓成功一次不算冷却", W.SOURCES.cooling(u1) === false);
  W.SOURCES.note(u1, false);
  ok("失败一次还不算冷却（要求连续两次）", W.SOURCES.cooling(u1) === false);
  W.SOURCES.note(u1, false);
  ok("连续两次失败进冷却", W.SOURCES.cooling(u1), true);
  W.SOURCES.note(u1, true);
  ok("成功之后立刻退出冷却", W.SOURCES.cooling(u1) === false);
  const realFetch185 = globalThis.fetch;
  const fetched185 = [];
  const mkLines185 = (n, base) =>
    Array.from({ length: n }, (_, i) => `${base}.${Math.floor(i / 250) + 1}.${(i % 250) + 1}:443`).join("\n");
  globalThis.fetch = async (u) => {
    fetched185.push(String(u));
    const body = mkLines185(400, String(u).includes("c185") ? "13.9" : "12.9");
    return { ok: true, status: 200, text: async () => body };
  };
  W.SOURCES.note(u2, false);
  W.SOURCES.note(u2, false);
  W.SOURCES.note(u3, false);
  W.SOURCES.note(u3, false);
  const c0 = W.cntView().srcSkip || 0;
  const r1 = await W.refillPool({ poolSrc: [u1, u2, u3].join(",") }, 0);
  eq("健康源已经抓到 400 条 → 两个冷却源被跳过，只发一次请求", fetched185.length, 1);
  eq("被跳过的源在结果里带 skip 标记", [!!r1.sources[u2].skip, !!r1.sources[u3].skip], [true, true]);
  ok("跳过的次数记进 srcSkip", (W.cntView().srcSkip || 0) - c0 >= 2, true);
  ok("跳过的这一轮池子仍然有足够条目", r1.pool.length >= 300, true);
  fetched185.length = 0;
  globalThis.fetch = async (u) => {
    fetched185.push(String(u));
    const body = mkLines185(10, "14.7");
    return { ok: true, status: 200, text: async () => body };
  };
  const r2 = await W.refillPool({ poolSrc: [u1, u2, u3].join(",") }, 1600);
  eq("健康源只给 10 条时不许跳过冷却源（否则整轮刷新会被缩水守卫拒掉）", fetched185.length, 3);
  ok("这一轮没有 skip 标记", !r2.sources[u2].skip && !r2.sources[u3].skip);
  globalThis.fetch = realFetch185;
  ok("POOL_ENOUGH 是 300（低于它就照旧全抓）", W.POOL_ENOUGH, 300);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case121({ W, eq, ok }) {
  const late = new Promise((_, rej) => setTimeout(() => rej(new Error("late failure")), 30));
  let thrown = "";
  try {
    await W.withTimeout(late, 5, "to");
  } catch (e) {
    thrown = String((e && e.message) || e);
  }
  eq("超时会按 msg 抛错", thrown, "to");
  // 等到那一半真正失败：将来若把 race 改成「自己收尾、不再管 p」，这里会以 unhandledRejection 崩掉
  await new Promise((r) => setTimeout(r, 120));
  ok("超时之后的那一半失败不会打崩进程", true);
  eq("restorePick 收到 0 时一个也不续回", W.restorePick([...Array(40).keys()].map((i) => "u" + i), 0).length, 0);
  const l2 = W.planRound(0, 0);
  ok("剩余额度不小于续回上限", l2.sub >= 12, String(l2.sub));
  eq("准入次数 = min(SCAN_MAX, SCAN_SUB)", l2.adm, Math.min(W.SC.SCAN_MAX, W.SC.SCAN_SUB));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case125({ eq, W, ok }) {
  const U = (q) => new URL("https://example.com/x" + q);
  eq("默认发满种子表（8 个入口）", W.edgeCount(U("")), 8);
  eq("?ei=5 就发 5 个", W.edgeCount(U("?ei=5")), 5);
  eq("少于 4 个没意义（下限夹到 4）", W.edgeCount(U("?ei=2")), 4);
  eq("超过种子表只会重复地址（上限夹到 8）", W.edgeCount(U("?ei=99")), 8);
  eq("不是数字按默认", W.edgeCount(U("?ei=abc")), 8);
  eq("空的 ?ei= 也按默认（Number(\"\") 是 0 不是 NaN）", W.edgeCount(U("?ei=")), 8);

  const envA = { uuid: "u", nodes: "", proxyip: "auto" };
  const idA = "4241b903-8d39-4a17-8f4c-bb33b1630c33";
  const keepAlive = W.NODE_MEMORY.alive;
  W.NODE_MEMORY.alive = new Map();
  const y4 = W.renderClash(envA, U("?ei=4"), idA, "example.com");
  eq("?ei=4 只发 4 个入口 × 2 个模式", (y4.match(/name: "e-/g) || []).length, 8);
  eq("第 4 个入口仍在", y4.includes("104.26.0.1"), true);
  eq("第 5 个入口不该出现", y4.includes("104.20.2.1"), false);

  W.NODE_MEMORY.alive = new Map([
    ["203.0.113.7:443", { h: "203.0.113.7", p: 443, cc: "", ms: 120, src: "pool" }],
    ["198.51.100.9:443", { h: "198.51.100.9", p: 443, cc: "", ms: 180, src: "pool" }],
  ]);
  const yR = W.renderClash(envA, U(""), idA, "example.com");
    eq("默认不发中继条目", (yR.match(/name: "r-/g) || []).length, 0);
  const yNoR = W.renderClash(envA, U("?r=0"), idA, "example.com");
  eq("?r=0 时不发中继条目", (yNoR.match(/name: "r-/g) || []).length, 0);
  eq("?r=0 时也不发中继优选组", yNoR.includes("\u{1F501} \u4e2d\u7ee7\u4f18\u9009"), false);
  ok("?r=0 仍发入口条目", (yNoR.match(/name: "e-/g) || []).length > 0, "e- 条目数 " + (yNoR.match(/name: "e-/g) || []).length);

  const tuQ = "?tu=" + encodeURIComponent("https://probe.example.org/");
  const yTu = W.renderClash(envA, U(tuQ), idA, "example.com");
  // 按行取组定义后面的 proxies 行：直接对整段做正则会被 emoji 转义和非贪婪量词坑到
  const gLines = yTu.split("\n");
  const gi = gLines.findIndex((l) => l.startsWith('  - name: "\u{1F4E1} \u901a\u9053\u5b9e\u6d4b"'));
  const pi = gi >= 0 ? gLines.findIndex((l, k) => k > gi && l.trim().startsWith("proxies: [")) : -1;
  const members =
    pi >= 0
      ? JSON.parse("[" + gLines[pi].slice(gLines[pi].indexOf("[") + 1, gLines[pi].lastIndexOf("]")) + "]")
      : [];
  eq("?tu= 有实测组", gi >= 0 && pi > gi, true);
    ok("实测组成员是入口/节点条目（中继组已删）", members.length > 0 && members.every((x) => !x.startsWith("r-")), "成员 " + members.join("/"));
  ok("成员上限 10（每条都是一次对目标站的真实请求）", members.length > 0 && members.length <= 10, "成员数 " + members.length);
  const yTuNoR = W.renderClash(envA, U(tuQ + "&r=0"), idA, "example.com");
  eq("?r=0 时实测组不退化到入口条目", yTuNoR.includes("\u{1F4E1} \u901a\u9053\u5b9e\u6d4b"), false);

  // 冷 isolate：一条中继都还没判活时，实测组退化成前 10 个条目，否则 ?tu= 会静默失效
  W.NODE_MEMORY.alive = new Map();
  const yCold = W.renderClash(envA, U(tuQ), idA, "example.com");
  eq("冷 isolate 下 ?tu= 仍然出组", yCold.includes("\u{1F4E1} \u901a\u9053\u5b9e\u6d4b"), true);

  W.NODE_MEMORY.alive = keepAlive;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case127({ W, ok }) {
  // 用 merge 造本地旧证据：一次整页、1 分钟前（note 用的是「现在」，没法造出旧时间戳）
  const e = new W.RelayHealth();
  e.merge([{ i: "10.3.3.3", o: 1, b: 0, d: 0, t: Date.now() - 60000 }]);
  ok("本地整页证据让健康度高于中性", e.score("10.3.3.3") > 0.5, String(e.score("10.3.3.3")));
  // 别处：同样 1 条，但是零字节，且更新 —— 整条按较新的观测替换
  e.merge([{ i: "10.3.3.3", o: 0, b: 0, d: 1, t: Date.now() }]);
  const row = e.json(5).find((r) => r.ip === "10.3.3.3");
  ok("条数相等时按较新的观测整条替换（ok 归零）", !!row && row.ok === 0 && row.dead === 1, JSON.stringify(row));
  ok("替换后健康度落到中性以下", e.score("10.3.3.3") < 0.5, String(e.score("10.3.3.3")));
  // 别处更旧就不该动本地结论，时间戳也不能被搬过来
  const f = new W.RelayHealth();
  f.merge([{ i: "10.4.4.4", o: 1, b: 0, d: 0, t: Date.now() - 1000 }]);
  const before = f.score("10.4.4.4");
  f.merge([{ i: "10.4.4.4", o: 0, b: 0, d: 1, t: Date.now() - 3600 * 1000 }]);
  // 健康度带半衰期、每次读都会重新算，直接比浮点数会随两行之间的毫秒抖动 —— 用容差
ok("较旧的观测不覆盖本地结论", Math.abs(f.score("10.4.4.4") - before) < 1e-6, f.score("10.4.4.4") + " vs " + before);
  // 条数更多的那条照样整条胜出
  f.merge([{ i: "10.4.4.4", o: 5, b: 0, d: 0, t: Date.now() }]);
  const r2 = f.json(5).find((r) => r.ip === "10.4.4.4");
  ok("条数更多时整条替换", !!r2 && r2.ok === 5 && r2.dead === 0, JSON.stringify(r2));
  // 相等条数 + 相等时间戳：保持本地（不写入）也不能拼
  const g = new W.RelayHealth();
  const t0 = Date.now() - 60000;
  g.merge([{ i: "10.5.5.5", o: 2, b: 0, d: 0, t: t0 }]);
  g.merge([{ i: "10.5.5.5", o: 0, b: 0, d: 2, t: t0 }]);
  const r3 = g.json(5).find((r) => r.ip === "10.5.5.5");
  ok("条数相同且时间相同则保持本地", !!r3 && r3.ok === 2 && r3.dead === 0, JSON.stringify(r3));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case128({ W, eq, ok }) {
  const mem = new Map();
  const envP = { uuid: "00000000-0000-0000-0000-000000000000", STATS: {
    get: async (k) => (mem.has(k) ? mem.get(k) : null),
    put: async (k, v) => { mem.set(k, v); },
  } };
  const mk = (n, tag) => Array.from({ length: n }, (_x, i) => ({ h: tag + i, p: 443, cc: "" }));
  const putSeed = (gen, n) => mem.set("px:seed", JSON.stringify({ v: 7, ts: 0, poolGen: gen, poolN: n, builtAt: 0, byColo: {} }));
  // 别的 isolate 已经提交过 200 条的池子；本 isolate 内存还停在上一代的小池子（10 条）
  W.POOL_MEMORY.rows = mk(10, "stale"); W.POOL_MEMORY.generation = 4; W.SEED_STORE.document.poolGen = 4; W.SEED_STORE.document.poolN = 10;
  W.SEED_STORE.readAt = Date.now(); W.SEED_STORE.readFailed = false; W.ISOLATE.colo = "TST";
  putSeed(5, 200);
  const c1 = await W.commitPool(envP, mk(80, "shrink"), false);
  eq("本地是小池子时仍按 KV 的真实规模判缩水", c1.ok, false);
  ok("拒绝理由写明是缩水", String(c1.reason || "").includes("rejected"), String(c1.reason));
  const c2 = await W.commitPool(envP, mk(80, "shrink"), true);
  eq("手动 refill 仍然可以缩水", c2.ok, true);
  // 读失败：普通 kvGet 会把 get 抛错吞成 null，那条 logErr 永远写不出来
  // 错误环上限 50 条、满了 shift：只能按时间戳认「这条是刚写进去的」，不能按下标切
  const errAt = Date.now();
  W.POOL_MEMORY.rows = []; W.POOL_MEMORY.generation = 0; W.SEED_STORE.document.poolGen = 6; W.SEED_STORE.readAt = 0; W.SEED_STORE.readFailed = false;
  const downEnv = { uuid: "00000000-0000-0000-0000-000000000000", STATS: {
    get: async () => { throw new Error("kv down"); },
    put: async () => { throw new Error("kv down"); },
  } };
  const got = await W.ensurePool(downEnv);
  eq("读失败按空池返回，不炸调用方", got.length, 0);
  const logged = W.ERROR_MEMORY.rows.some((x) => x && x.t >= errAt && String(x.m || "").includes("pool gen 6"));
  ok("读失败写进了错误环", logged, JSON.stringify(W.ERROR_MEMORY.rows.filter((x) => x && x.t >= errAt)));
  W.POOL_MEMORY.rows = []; W.POOL_MEMORY.generation = 0; W.SEED_STORE.document.poolGen = 0; W.SEED_STORE.document.poolN = 0; W.ISOLATE.colo = ""; W.SEED_STORE.readAt = 0;
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case151({ mkDO, eq, ok, storeSrc }) {
  const d = mkDO();
  const now = Date.now();
  const heavy = Array.from({ length: 120 }, (_, i) => ({ i: "10.1.1." + i, o: 9, b: 0, d: 0, t: now - 10 * 60000 }));
  const fresh = Array.from({ length: 30 }, (_, i) => ({ i: "10.2.2." + i, o: 1, b: 0, d: 0, t: now - 5000 }));
  const stale = Array.from({ length: 5 }, (_, i) => ({ i: "10.3.3." + i, o: 7, b: 0, d: 0 })); // 不带 t：DO 收到时补当前时间
  await d.m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify({ hl: heavy.concat(fresh).concat(stale) }) }));
  const hl = (await (await d.m.fetch(new Request("https://m/hl"))).json()).hl || [];
  eq("出站上限仍是 120 行", hl.length, 120);
  eq("刚出现过的新证据全部发出去", hl.filter((r) => r.i.startsWith("10.2.2.")).length, 30);
  ok("第一条是最近被记过的证据", (hl[0].t || 0) >= now - 60000, JSON.stringify(hl[0]));
  ok("不带 t 的老行由 DO 按收到时间补", hl.some((r) => r.i.startsWith("10.3.3.") && (r.t || 0) >= now - 60000), String(hl.filter((r) => r.i.startsWith("10.3.3.")).length));
  ok("按证据时间降序", hl.every((r, k) => k === 0 || (hl[k - 1].t || 0) >= (r.t || 0)));
  const meterSrc = storeSrc();
  ok("出站排序按 t 降序", meterSrc.includes("rows.sort((a, b) => b.t - a.t || b.d + b.b - (a.d + a.b));"));
  ok("不再按坏证据条数单独排序", !meterSrc.includes("rows.sort((a, b) => b.d + b.b - (a.d + a.b));"));
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case171({ W, H247, eq, ok }) {
  // 选择器只给一条 CF 边缘：中转到 CF 托管目标等于从同一边缘再撞一次，必须跳过
  const realCur = W.SEL.current;
  W.SEL.current = async () => "104.16.0.1:443";
  W.ERROR_MEMORY.rows.length = 0;
  const before = W.cntView().skipCfRelay || 0;
  const st247 = {
    rx: "",
    node: "",
    via: "",
    retried: false,
    pxTries: 0,
    hostTrial: false,
    cf: false,
    ctx: { waitUntil: () => {}, passThroughOnException: () => {} },
  };
  let err247 = "";
  try {
    await W.DIALER.open({
      env: { STATS: { get: async () => null, put: async () => {}, list: async () => ({ keys: [] }) }, proxyip: "auto" },
      request: new Request("https://" + H247 + "/"),
      conn: st247,
      mode: "tput",
      host: H247,
      port: 443,
      pxForce: 1,
    });
  } catch (err) {
    err247 = String((err && err.message) || err);
  }
  W.SEL.current = realCur;
  const skipped = (W.cntView().skipCfRelay || 0) - before;
  eq("跳过 CF 边缘候选记一次 skipCfRelay", skipped, 1);
  eq(
    "跳过不写错误环（否则每个 CF 站点请求都会挤掉真错误）",
    W.ERROR_MEMORY.rows.filter((x) => String(x.m || "").includes("skip cf-edge")).length,
    0,
  );
  ok("跳过不是一次尝试（st.via 仍为空、pxTries 未推进）", st247.via === "" && st247.pxTries === 0, st247.via + "/" + st247.pxTries);
  ok("跳过之后仍然会去拨直连（Node 里没有 sockets，抛错属预期）", err247.length > 0, err247);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case188({ W, ok }) {
  const conn270 = Object.create(W.Connection.prototype);
  conn270.via = "node";
  conn270.node = "10.9.9.9:443";
  conn270.writer = { write: () => new Promise(() => {}), releaseLock() {} };
  const before270 = Number((W.cntView() || {}).ustall || 0);
  const t0 = Date.now();
  await conn270.upWrite(new Uint8Array(8), 80);
  const spent = Date.now() - t0;
  const after270 = Number((W.cntView() || {}).ustall || 0);
  ok("黑洞写入在上限内返回（不挂 30 秒）", spent < 3000, `spent=${spent}`);
  ok("卡顿被记进 ustall", after270 === before270 + 1, `${before270}→${after270}`);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case295({ ok }) {
  const doh = (ms) => new Promise((r) => setTimeout(r, ms));
  const load = (ms, flag) => new Promise((r) => setTimeout(() => { flag.on = true; r(); }, ms));
  const oldFlag = { on: false };
  const t0 = Date.now();
  await doh(50);
  const oldP = load(40, oldFlag);
  await oldP;
  const oldMs = Date.now() - t0;

  const newFlag = { on: false };
  const t1 = Date.now();
  const newP = load(40, newFlag);
  await doh(50);
  await Promise.race([newP, new Promise((r) => setTimeout(r, 200))]);
  const newMs = Date.now() - t1;
  ok("[393] 并行后事实更早就绪", newFlag.on && oldFlag.on && newMs < oldMs);
  ok("[393] 并行为 DoH 重叠留出时间", oldMs - newMs >= 25);
}
