// 判定表的跨 isolate 同步：只同步「强证据」（blocked/dead），带 30 分钟 TTL。
// 目标 isolate 冷启动时拉一次，之后靠本地的记录增量回传，避免每请求都读 DO。
import { S } from "../core/state";
import { vAll, vImport } from "./verdict";
import { HEALTH } from "./relay-health";
import { EG, EgRow } from "./egfacts";
import { PS } from "./psfacts";
import { cnt } from "../core/counter";

export interface VtRow {
  k: string; // `target|chan`
  s: number; // state
  t: number; // 到期时间
}

/** 自上次上报以来新学到的强证据（只发增量） */
export function vtDelta(): VtRow[] {
  const out: VtRow[] = [];
  const now = Date.now();
  // 上次交出去、还没 ack 的强证据：原样再带上（DO 可能没收到）
  for (const [k, t] of S.vtPend) {
    const bar = k.indexOf("|");
    if (bar <= 0 || t <= now) continue;
    if (k.startsWith("*|")) continue; // 通配封锁不外发：见下方 vtDelta 里的说明
    out.push({ k, s: 2, t });
  }
  for (const v of vAll()) {
    if (v.state < 2) continue;
    // 通配封锁（`*|通道`）**不跨 isolate 共享**：它 30 分钟才过期，几轮突发就能把大半中继在别的
    // isolate 里标死，可用池变薄后连接反而更差（实测失败率 10% → 50%）。站点级证据（`站点|通道`）
    // 仍然同步 —— 那才是「这个站点这条通道被封」的可信事实。
    if (v.t === "*") continue;
    const k = v.t + "|" + v.c;
    const exp = v.at + 1800000;
    if (exp <= now) continue;
    if ((S.vtSent.get(k) || 0) >= exp) continue;
    if ((S.vtPend.get(k) || 0) >= exp) continue;
    // 只登记 pending：DO 没收到时由调用方 nack，下轮还能再发一次
    S.vtPend.set(k, exp);
    out.push({ k, s: v.state, t: exp });
    if (out.length >= 60) break;
  }
  if (out.length) cnt("vtSent", out.length);
  return out;
}


/** 上报成功：pending 正式生效 */
export function vtAck(): void {
  for (const [k, exp] of S.vtPend) S.vtSent.set(k, exp);
  S.vtPend.clear();
}

/** 上报失败：丢掉 pending，下一轮重新登记 */
export function vtNack(): void {
  S.vtPend.clear();
}
/** 冷启动拉一次远端强证据（失败静默：判定表本来就是「本 isolate 先信自己」） */
export async function vtLoad(env: Env): Promise<void> {
  if (S.vtLoaded) return;
  S.vtLoaded = true;
  try {
    const raw = String(env.uuid || env.uuids).split(",")[0].trim().toLowerCase();
    const rr = await env.METER.get(env.METER.idFromName(raw)).fetch("https://meter/vt");
    const jj = (await rr.json()) as {
      vt?: VtRow[];
      hl?: Array<{ i: string; o: number; b: number; d: number }>;
      eg?: EgRow[];
      ps?: Array<{ k: string; q: number; n: number; at: number }>;
    };
    if (Array.isArray(jj.vt)) {
      // 过滤掉历史版本外发出去的通配封锁：它们已经在别的 isolate 里造成过大面积误封，重新导入只会复发。
      const rows = jj.vt.filter((r) => !r.k.startsWith("*|"));
      vImport(rows);
      cnt("vtDO", rows.length);
    }
    if (Array.isArray(jj.hl)) HEALTH.merge(jj.hl);
    // 出口族事实：冷启动一次灌进来，之后靠本地增量回传（与强证据同一条管道）
    if (Array.isArray(jj.eg)) cnt("egDO", EG.load(jj.eg));
    // 成功率事实：冷启动一次灌入，之后靠本地增量回传
    if (Array.isArray(jj.ps)) cnt("psDO", PS.load(jj.ps));
  } catch {
    // 读不到就当没有：不阻塞连接
  }
}

