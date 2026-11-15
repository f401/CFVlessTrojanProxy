/** 只用到 env（DO 存根），不引 edge 层类型，避免 route -> edge 反向依赖。 */
type RouteCtx = { env: Env };
import { S } from "../core/state";
import { withTimeout } from "../core/util";
import { vAt, vSet, vSetState } from "./verdict";
import { splitRelay } from "../core/http80";
import { logErr } from "../nodes/metrics";
/**
 * 功能：把主机拼成 `host:port`（IPv6 要加方括号，否则下游拆分会把它当裸地址）。
 * @param h 主机（IPv4 或 IPv6 字面量）
 * @returns 带端口的地址串
 */
const relayAddr = (h: string): string => (h.includes(":") ? "[" + h + "]:443" : h + ":443");

/** 站点 → 上一批判定标签的容量上限：站点名来自客户端 ClientHello，不是有限集合。 */
const TFB_MEM_MAX = 256;

/**
 * 功能：判断这一批 `chan` 证据能不能落封锁（两批共识）。
 * @param {string} prevTag 上一批的判定标签（`verdict/escalate`，空串表示没探过）
 * @param {string} verdict 这一批的判定
 * @returns {boolean} true = 上一批也是 `chan`，可以把 403 的通道写进判定表
 */
export function tfBlockOk(prevTag: string, verdict: string): boolean {
  // 单批「有 2xx + 这条 403」可能只是一次限流或页面差异；cron 对同一站点间隔 ≥10 分钟，
  // 两批都看到同样的分裂才落封锁。这也让 `S.tfbV` 从「只删不写」变成真的有读者。
  return verdict === "chan" && prevTag.startsWith("chan/");
}

/**
 * 功能：记下这一批的判定标签（给「两批共识」与日志去重用），超过上限就丢最旧的键。
 * @param {string} host 站点
 * @param {string} tag 判定标签
 * @returns {void}
 */
export function tfRemember(host: string, tag: string): void {
  S.tfbV.set(host, tag);
  // Map 保持插入顺序：从头删就是「最久没更新的站点」，不必排序
  while (S.tfbV.size > TFB_MEM_MAX) {
    const first = S.tfbV.keys().next();
    if (first.done) break;
    S.tfbV.delete(first.value);
  }
}

/** 兜底中继：本 isolate 还没跑过 cron 时 S.alive 为空，用几个已知可用的顶一下。 */
const SEED = ["185.253.117.147", "45.136.117.194", "91.215.154.80"];

const stub0 = (c: RouteCtx) => c.env.METER.get(c.env.METER.idFromName("tf-probe"));

/**
 * 判定收敛：200 与 403 并存才升级为 IP 级封锁证据；全 403 说明是站点级，不写封禁。
 *  · 全部 200        → ok（站点可达）
 *  · 200 与 403 并存 → 403 的那些通道判被封（这才是「IP 级」证据）
 *  · 全部 403        → 站点层面的拒绝（业务 403 常见形态），**不写任何封禁**，只记 suspect
 *  · 全部失败        → unknown（中继或网络问题，不冤枉任何一方）
 */
export function tfVerdict(rows: Array<{ ok: boolean; status?: number; bytes?: number }>): "ok" | "chan" | "site" | "unknown" {
  const okN = rows.filter((x) => x.ok && x.status === 200).length;
  const badN = rows.filter((x) => (x.status || 0) >= 400).length;
  return okN > 0 && badN > 0 ? "chan" : okN > 0 ? "ok" : badN > 0 ? "site" : "unknown";
}

/**
 * 「全通道 4xx」的处置：CF 托管站点上的全 403 往往不是站点级拒绝，
 * 而是我们采样到的每条出口都落在被封的 IP 族里 —— 这时**不写封禁**，
 * 改为「换一批出口继续探」（rotate）。业务 4xx（非 CF 目标）保持 none。
 */
export function tfEscalate(verdict: string): "rotate" | "none" {
  // 行为只由「有没有通道拿到 2xx」决定：ok/chan 有定论，其余一律继续换出口采样。
  // site / ipfam 只是诊断标签（body 特征不普适，不能拿来决定行为）。
  return verdict === "ok" || verdict === "chan" ? "none" : "rotate";
}

/**
 * 五态收敛：在 tfVerdict 的「全 4xx」里再按响应字节分一层。
 * CF 的 IP 族拒绝页 body 只有 4 字节；业务 4xx 会带内容体（实测 265 B JSON）。
 * 注意：ipfam 与 site 都不写封禁，分错只是标签差异，永不误伤业务 403。
 */
export function tfClass(rows: Array<{ ok: boolean; status?: number; bytes?: number }>): string {
  const base = tfVerdict(rows);
  // 一行状态码都没有 = 连不上/被重置，既不是 ipfam 也不是 site
  const hasCode = rows.some((x) => Number(x.status || 0) > 0);
  if (!hasCode) return "unknown";
  if (base !== "site") return base;
  // 字节数未知（/meter/tf 没回 bytes 时全是 0）不能冒充 ipfam，只能叫 site
  const sized = rows.every((x) => (x.status || 0) >= 400 && Number(x.bytes || 0) > 0);
  if (!sized) return "site";
  const tiny = rows.every((x) => Number(x.bytes || 0) <= 32);
  return tiny ? "ipfam" : "site";
}

/**
 * 换出口策略：优先挑「该站点还没探过」的中继，其次挑最久没探过的。
 * 这是 rotate 的真正消费者 —— 全 4xx 时不写封禁，而是扩大采样面。
 */
export function pickFresh(host: string, ips: string[], n: number): string[] {
  const seen = (ip: string) => vAt(host, "r:" + ip);
  const fresh = ips.filter((ip) => !seen(ip));
  const rest = ips.filter((ip) => seen(ip)).sort((a, b) => seen(a) - seen(b));
  // 全部没探过时，按 10 分钟一档轮转起点：否则小池子永远取数组前 n 条，"换出口"名存实亡
  const list = [...fresh, ...rest];
  const rotAt = fresh.length === list.length ? Math.floor(Date.now() / 600000) % Math.max(1, list.length) : 0;
  return [...list.slice(rotAt), ...list.slice(0, rotAt)].slice(0, Math.max(0, n));
}

/**
 * 功能：在同一时间窗内对目标打「直连 + n 条中继」，按共识判定：有 2xx 且失败共存 → 只封失败通道；全 4xx → 站点级（不写封禁）；无状态码 → unknown 且只换出口。
 * @param c 路由上下文（提供 DO 调用与预算）
 * @param host 目标主机
 * @param n 中继条数（1~3）
 * @param list 指定中继列表（逗号分隔），空串表示自动挑
 * @returns JSON 响应：verdict / escalate / rows
 */
export async function runTfb(c: RouteCtx, host: string, n: number, list = ""): Promise<Response> {
  const own = [...S.alive.values()].map((x) => x.h);
  const pool = (list ? list.split(",") : own.length ? own : SEED)
.map((x) => splitRelay(x.trim(), 443)[0])
    .filter((h, i, arr) => h && arr.indexOf(h) === i);
  const ips = pickFresh(host, pool, Math.max(1, Math.min(3, n)));
  // 直连也算一条通道：DO 的出口族与中继不同，常常正好一个 403 一个 200（真混采样）
  const dq = "https://meter/tf?h=" + encodeURIComponent(host) + "&r=";
  const dres = (await withTimeout(stub0(c).fetch(dq), 8000)) as Response | undefined;
  const direct = dres ? ((await withTimeout(dres.json(), 4000)) as { ok: boolean; status?: number; bytes?: number; ms?: number }) : { ok: false };
  const q =
"https://meter/tfb?h=" + encodeURIComponent(host) + "&r=" + encodeURIComponent(ips.map(relayAddr).join(","));
  const stub = stub0(c);
  const r = (await withTimeout(stub.fetch(q), 20000)) as Response | undefined;
  const body = r
    ? ((await withTimeout(r.json(), 5000)) as { rows?: Array<{ relay: string; ok: boolean; status?: number; ms?: number }> })
    : { rows: [] };
  const rows = (body.rows || []) as Array<{ relay: string; ok: boolean; status?: number; bytes?: number; ms?: number }>;
  if (direct.ok || (direct as { status?: number }).status) rows.unshift({ relay: "direct", ok: !!direct.ok, status: direct.status, bytes: direct.bytes, ms: direct.ms });
  const okN = rows.filter((x) => x.ok && x.status === 200).length;
  const badN = rows.filter((x) => (x.status || 0) >= 400).length;
  const verdict = tfClass(rows as Array<{ ok: boolean; status?: number; bytes?: number }>);
  const prevTag = S.tfbV.get(host) || "";
  // 两批共识：单批 `chan` 只当「怀疑」，不写判定表（写进去等于让这条中继 30 分钟不可用）
  const mayBlock = tfBlockOk(prevTag, verdict);
  for (const row of rows) {
const ip = splitRelay(row.relay, 443)[0];
    if (verdict === "chan" && row.status === 403 && mayBlock) vSetState(host, ip === "direct" ? "d" : "r:" + ip, 2, 1);
    else if (row.ok && row.status === 200) vSet(host, ip === "direct" ? "d" : "r:" + ip, 200, Number(row.ms || 0), 1);
  }
  const escalate = tfEscalate(verdict);
  const tag = verdict + "/" + escalate;
  const same = prevTag === tag;
  tfRemember(host, tag);
  if (!same) logErr(`tfb ${host} ${verdict} ok=${okN} bad=${badN} esc=${escalate} n=${rows.length}`);
  return Response.json({ host, probed: rows.length, okN, badN, verdict, escalate, rows });
}

