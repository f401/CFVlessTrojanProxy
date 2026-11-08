import { S } from "../core/state";
import { getSnap } from "../store/index";
import { json } from "../edge/respond";
import type { RouteCtx } from "../edge/types";

type UserCtx = RouteCtx & { id: string };

/** /<uuid>/logs：合并「KV 快照 + DO + 本 isolate」三处的错误，按时间去重 */
export async function logs(c: UserCtx): Promise<Response> {
  const { env, id } = c;
          let stored: ErrItem[] = [];
          try {
            const snap = await getSnap(env);
            stored = snap.errs || [];
          } catch (e) {}
          // 再并上 DO 里那份（跨 isolate），否则永远只能看到"当前这个实例"的 50 条
          let fromDo: ErrItem[] = [];
          if (env.METER) {
            try {
              const stub = env.METER.get(env.METER.idFromName(id));
              const r = await stub.fetch("https://meter/cnt");
              const j = await r.json();
              fromDo = (j && j.e) || [];
            } catch (e) {}
          }
          const seen = new Set();
          const all = [];
          for (const x of [...fromDo, ...stored, ...S.errs]) {
            if (!x || !x.t || seen.has(x.t)) continue;
            seen.add(x.t);
            all.push(x);
          }
          all.sort((a2, b2) => a2.t - b2.t);
          const out = all.slice(-50);
          return json({ count: out.length, persisted: stored.length, fromDo: fromDo.length, items: out });
        }
