// 判定表的跨 isolate 同步：只同步「强证据」（blocked/dead），带 30 分钟 TTL。
// 目标 isolate 冷启动时拉一次，之后靠本地的记录增量回传，避免每请求都读 DO。
import { S } from "../core/state";
import { vAll, vImport } from "./verdict";

export interface VtRow {
  k: string; // `target|chan`
  s: number; // state
  t: number; // 到期时间
}

/** 自上次上报以来新学到的强证据（只发增量） */
export function vtDelta(): VtRow[] {
  const out: VtRow[] = [];
  const now = Date.now();
  for (const v of vAll()) {
    if (v.state < 2) continue;
    const k = v.t + "|" + v.c;
    const exp = v.at + 1800000;
    if (exp <= now) continue;
    if ((S.vtSent.get(k) || 0) >= exp) continue;
    S.vtSent.set(k, exp);
    out.push({ k, s: v.state, t: exp });
    if (out.length >= 60) break;
  }
  return out;
}

/** 冷启动拉一次远端强证据（失败静默：判定表本来就是「本 isolate 先信自己」） */
export async function vtLoad(env: Env): Promise<void> {
  if (S.vtLoaded) return;
  S.vtLoaded = true;
  try {
    const raw = String(env.uuid || env.uuids).split(",")[0].trim().toLowerCase();
    const rr = await env.METER.get(env.METER.idFromName(raw)).fetch("https://meter/vt");
    const jj = (await rr.json()) as { vt?: VtRow[] };
    if (Array.isArray(jj.vt)) vImport(jj.vt);
  } catch {
    // 读不到就当没有：不阻塞连接
  }
}
