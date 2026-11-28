import { PEND } from "../store/pend";
import { METER_CLIENT } from "../store/meter-client";
import { KV_WRITES } from "../store/kv";
import { NODE_MEMORY } from "../core/node-memory";
import { ENTRY_MEMORY, ERROR_MEMORY } from "../core/client-memory";
import { USAGE_MEMORY } from "../store/usage-memory";
import { P_T, VERSION } from "../core/util";
import { ERRS, HOSTS } from "../nodes/metrics";
import { cntView, cnt } from "../core/counter";
import { FACT } from "../facts/factshadow";
import { json, forbidden } from "../edge/respond";
import type { RouteCtx } from "../edge/types";
import { PS } from "../facts/psfacts";
import { EG } from "../facts/egfacts";
import { DEAD } from "../facts/deadfacts";
import { FO, LAT } from "../core/obs";
import { DNS } from "../facts/dnsfacts";
import { egCounts } from "../facts/egfacts";
import { SOURCES } from "../px/probe";
import { CAP } from "../facts/capfacts";
import { ALIVE_TARGET } from "../core/const";
import { factList } from "../facts/factflags";
import { BLK } from "../facts/blkfacts";
import { getSnap } from "../store/index";
import { logErr } from "../nodes/errlog";

/** /health：进程自述。带 pageKey 时要求 ?k= */
export function health(c: RouteCtx): Response {
  if (c.pageKey && !c.keyOk) return forbidden();
  // 只报计数与版本，不回显任何凭据；这些数字就是线上排障的全部入口
  return json({
    ok: true,
    ts: Date.now(),
    uuids: c.auth.uuids.size,
    [P_T]: c.auth.trojan.size,
    statEntries: USAGE_MEMORY.rows.size,
    rttBuckets: ENTRY_MEMORY.rows.size,
    hostPrefs: HOSTS.nodes.size,
    candidates: NODE_MEMORY.candidateCount,
    errors: ERROR_MEMORY.rows.length,
    errsByKind: ERRS.hist(),
    errsDup: ERRS.dropped(),
cf: FACT.snap(),
    eg: EG.snap(),
    ps: PS.snap(),
    dead: DEAD.snap(),
    first: FO.snap(),
    lat: LAT.snap(),
    dns: DNS.snap(),
    cap: CAP.snap(),
    src: SOURCES.stat(),
    facts: factList(c.env),
    // short 是唯一的「池子够不够」判据：低于目标时 cron 那套扫描已经在满预算跑（7.179）
    relays: (() => { const ips = [...NODE_MEMORY.alive.values()].map((x) => String(x.h || "")).filter(Boolean); const c = egCounts(ips); return { alive: ips.length, target: ALIVE_TARGET, short: ips.length < ALIVE_TARGET, eg4: c.v4, eg6: c.v6, egUnk: c.unk }; })(),
    blk: BLK.snap(),
    colo: (c.cf && c.cf.colo) || "",
    cnt: cntView(),
    kvWrites: KV_WRITES.writes,
    doCalls: METER_CLIENT.calls,
    pendSize: PEND.rows.size,
    pendMs: PEND.intervalMs,
    kvLastWrite: KV_WRITES.status,
    version: VERSION,
  });
}

/** /<uuid>/logs 的用户上下文：路由层已确认 uuid，所以这里把 id 收紧成必有 */
type UserCtx = RouteCtx & { id: string };

/** /<uuid>/logs：合并「KV 快照 + DO + 本 isolate」三处的错误，按时间去重 */
export async function logs(c: UserCtx): Promise<Response> {
  const { env, id } = c;
  let stored: ErrItem[] = [];
  try {
    const snap = await getSnap(env);
    stored = snap.errs || [];
  } catch (e) {
    // 快照读失败只是少一份来源（DO 与本 isolate 仍会并进来），但必须留痕：
    // 否则「错误列表突然只剩几十条」查不出原因（ErrRing 自己 5 秒去重，不会刷屏）
    logErr("logs snap read failed", "kv");
  }
  // 再并上 DO 里那份（跨 isolate），否则永远只能看到"当前这个实例"的 50 条
  let fromDo: ErrItem[] = [];
  // 跨 isolate 那份到底读没读到，必须让外部看得出：`fromDo: 0` 同时能是
  // 「DO 里没有错误」和「这次压根没读到」，两者对排障的含义完全相反
  // （7.188 的 `ringBlk` 就是这么把「空表」当成了「没被封锁」）。
  let doSrc: "ok" | "fail" | "none" = env.METER ? "ok" : "none";
  if (env.METER) {
    try {
      // 错误环形只挂在主 uuid 的 DO 上：用别人的 id 读永远为空
      const stub = env.METER.get(env.METER.idFromName(PEND.id(env) || id));
      const r = await stub.fetch("https://meter/cnt");
      const j = await r.json();
      fromDo = (j && j.e) || [];
    } catch (e) {
      // 与上面那条快照失败同一个口径：少一份来源必须留痕，否则错误列表
      // 突然变短时查不出原因（ErrRing 自己 5 秒去重，不会刷屏）。
      doSrc = "fail";
      cnt("logsDoFail");
      logErr("logs do read failed", "kv");
    }
  }
  // 去重按「时间 + 内容 + 标签」：只按时间去重会把 DO/KV/本地三份里的同一条保留成三条；
  // 超过 48 小时的残留（旧版本留下的噪声）不再回放。
  const MAX_AGE = 48 * 3600_000;
  const now0 = Date.now();
  const seen = new Set<string>();
  const all: ErrItem[] = [];
  for (const x of [...fromDo, ...stored, ...ERROR_MEMORY.rows]) {
    if (!x || !x.t) continue;
    if (now0 - x.t > MAX_AGE) continue;
    const k = x.t + "|" + x.m + "|" + (x.tag || "");
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(x);
  }
  all.sort((a2, b2) => a2.t - b2.t);
  // 同类噪声限量：同一前缀（前两个词，如 "forced _Rd" / "tfb x.com"）最多保留 8 条，
  // 否则一批出口 IP 的日志会把真正的错误挤出 50 条环。
  const PREFIX_CAP = 8;
  const byPrefix = new Map<string, number>();
  const kept: ErrItem[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const x = all[i];
    const pre = String(x.m).split(/\s+/).slice(0, 2).join(" ");
    const n = byPrefix.get(pre) || 0;
    if (n >= PREFIX_CAP) continue;
    byPrefix.set(pre, n + 1);
    kept.push(x);
  }
  kept.reverse();
  const out = kept.slice(-50);
  return json({ count: out.length, persisted: stored.length, fromDo: fromDo.length, doSrc, items: out });
}
