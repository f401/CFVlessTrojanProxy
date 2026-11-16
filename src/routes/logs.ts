import { S } from "../core/state";
import { getSnap, primaryId } from "../store/index";
import { json } from "../edge/respond";
import { logErr } from "../nodes/errlog";
import type { RouteCtx } from "../edge/types";

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
  if (env.METER) {
    try {
      // 错误环形只挂在主 uuid 的 DO 上：用别人的 id 读永远为空
      const stub = env.METER.get(env.METER.idFromName(primaryId(env) || id));
      const r = await stub.fetch("https://meter/cnt");
      const j = await r.json();
      fromDo = (j && j.e) || [];
    } catch (e) {}
  }
  // 去重按「时间 + 内容 + 标签」：只按时间去重会把 DO/KV/本地三份里的同一条保留成三条；
  // 超过 48 小时的残留（旧版本留下的噪声）不再回放。
  const MAX_AGE = 48 * 3600_000;
  const now0 = Date.now();
  const seen = new Set<string>();
  const all: ErrItem[] = [];
  for (const x of [...fromDo, ...stored, ...S.errs]) {
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
  return json({ count: out.length, persisted: stored.length, fromDo: fromDo.length, items: out });
}

