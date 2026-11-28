/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case020({ W, eq }) {
  let fail = true;
  const store = new Map();
  const state = {
    blockConcurrencyWhile: (fn) => Promise.resolve().then(fn),
    storage: {
      get: async (k) => store.get(k),
      put: async (k, v) => {
        if (fail) throw new Error("put down");
        store.set(k, v);
      },
      delete: async (k) => store.delete(k),
    },
  };
  const m = new W.Meter(state, {});
  await Promise.resolve();
  let threw = false;
  try {
    await m.fetch(
      new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 10, down: 20, conns: 1 }) }),
    );
  } catch (e) {
    threw = true;
  }
  eq("DO 落盘失败会抛错", threw, true);
  eq("DO 落盘失败回滚内存", m.ledger.usage.up, 0);
  fail = false;
  await m.fetch(new Request("https://m/add", { method: "POST", body: JSON.stringify({ up: 10, down: 20, conns: 1 }) }));
  eq("恢复后只记一次", m.ledger.usage.up, 10);
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case077({ mkDO, W, eq }) {
  const doS = mkDO();
  // Meter 收的是 Request；真实运行时由 DO 桩转换，这里补一层字符串 URL 适配
  const stubOf = { fetch: (u, init) => doS.m.fetch(typeof u === "string" ? new Request(u, init) : u) };
  const envS = { uuid: "u-test", METER: { idFromName: (x) => x, get: () => stubOf } };
  const id = "u-flush-view";
  // 干净起点：账本、DO 读缓存、本地即时视图都清空
  W.PEND.rows.clear();
  W.METER_CLIENT.cache.clear();
  W.USAGE_MEMORY.rows.clear();
  W.PEND.add(id, 100, 200, true);
  const before = await W.readStats(envS, id);
  eq("flush 前：还没上报的增量直接算进读数", [before.up, before.down], [100, 200]);
  await W.PEND.flush(envS, true);
  eq("flush 后：待上报账本已清空", W.PEND.rows.has(id), false);
  const after = await W.readStats(envS, id);
  eq("flush 后读数不倒退", [after.up, after.down], [100, 200]);
  // 这两条守的是「同一个数不要有两个真源」：旧的 60 秒读缓存被它自己的失效点架死了
  eq("统计读缓存已删除（不再有 60 秒陈旧窗口）", W.S?.statCache, undefined);
  eq("store 门面已退场（7.357 删掉 Store/STORE）", W.STORE, undefined);
  // 「要不要先推增量」只认路由表：装配根里那份硬编码子路径列表已删（v7.135）
  eq("路由表是 stats 的唯一真源：订阅要推增量", W.RouteTable.needsStats("cl"), true);
  eq("调试路由不推增量", W.RouteTable.needsStats("debug"), false);
  W.PEND.rows.clear();
  W.METER_CLIENT.cache.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case090({ W, eq, ok }) {
  const cg = W.TRAFFIC_MEMORY.aggregates;
  cg.clear();
  // 45 个节点键，一次只发 40 行：多出来的 5 个必须留着，不能被清掉
  for (let i = 0; i < 45; i++) cg.set("n" + i + ":443", { n: 5, ok: 4, dn: 500, v: [100, 120] });
  const rows = W.PEND.clSnap(40);
  eq("45 个节点键一次只发 40 行", rows.length, 40);
  W.PEND.clAck(rows);
  eq("没被发出去的那 5 个键原样留着（不再被整表清空）", cg.size, 5);
  ok("发出去的键减到 0 就删掉", !cg.has(rows[0].k));
  // 在途期间新结束的连接：快照之后 cagg 又涨了 2 条，确认时不能把它一起抹掉
  cg.clear();
  cg.set("a:443", { n: 3, ok: 3, dn: 300, v: [90] });
  const one = W.PEND.clSnap(40);
  eq("快照这一行是 3 个样本", one[0].n, 3);
  cg.get("a:443").n += 2;
  cg.get("a:443").dn += 200;
  W.PEND.clAck(one);
  eq("在途期间新增的观测不会被抹掉", cg.get("a:443") && cg.get("a:443").n, 2);
  W.PEND.clAck(W.PEND.clSnap(40));
  eq("再确认一次就清干净", cg.size, 0);
  cg.clear();
}

/** 顺序由 test_score.mjs 保持；共享夹具显式传入，不在模块加载时执行。 */
export async function case112({ W, eq }) {
  const mkMeter = (failIds) => ({
    idFromName: (x) => x,
    get: (id) => ({
      fetch: async () =>
        failIds.includes(id)
          ? new Response("x", { status: 500 })
          : new Response("{}", { status: 200 }),
    }),
  });
  W.PEND.rows.clear();
  W.TRAFFIC_MEMORY.aggregates.clear();
  W.PEND.rows.set("u1", { up: 10, down: 20, conns: 1 });
  W.PEND.rows.set("u2", { up: 30, down: 40, conns: 2 });
  W.PEND.rows.set("u3", { up: 50, down: 60, conns: 3 });
  W.TRAFFIC_MEMORY.aggregates.set("9.9.9.9:443", { n: 5, ok: 5, dn: 5000, v: [100, 110] });
  let clAckCalls = 0;
  let nackCalls = 0;
  const oldClAck = W.PEND.clAck.bind(W.PEND);
  W.PEND.clAck = (rows) => {
    clAckCalls += 1;
    return oldClAck(rows);
  };
  const oldNack = W.HOOK.syncNack;
  W.HOOK.syncNack = () => {
    nackCalls += 1;
  };
  await W.PEND.flush({ METER: mkMeter(["u2"]), uuid: "u1" }, true);
  W.PEND.clAck = oldClAck;
  W.HOOK.syncNack = oldNack;
  eq("连接观测只按发出去的那一批相减一次", clAckCalls, 1);
  eq("别的用户批次失败不会退回主批次的增量", nackCalls, 0);
  eq("失败用户的增量原样回到账本", (W.PEND.rows.get("u2") || {}).up, 30);
  W.PEND.rows.clear();
  W.TRAFFIC_MEMORY.aggregates.clear();
}
