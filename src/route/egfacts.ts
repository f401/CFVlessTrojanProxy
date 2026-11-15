// 出口族事实（`eg`）：这条中继出站用的是 IPv4 还是 IPv6。
//
// 为什么值得单独一层：同一个站点对两种族的接受率差一个数量级（实测 x.com：v4 出口 6/6、
// 两边都 200 整页；v6 出口 2/16，其余是 737B 的拒绝页）。而这个差别是**中继出口地址**的属性，
// 与用户位置、与 isolate 无关 —— 所以它可以跨 isolate 共享（v8 §16.5 的共享边界）。
//
// 纪律（v8 §15 的 I2）：这里只产出**代价偏置**，永远不参与「能不能用」的判定。
// 一个 `eg=6` 的中继仍然可能在别的站点头等好使，把它从候选里删掉就是 7.57 的老路
// （通配硬封锁 → 可用池变薄 → 失败率 10%→50%）。
import { cnt } from "../core/counter";

/** 一条出口族事实：`i` 中继 IP，`f` 族（4 或 6），`at` 观测时间 */
export interface EgRow {
  i: string;
  f: number;
  at: number;
}

/** 事实寿命：实测 1.5 小时后出口族仍一致，但中继会换线路，6 小时足够保守 */
export const EG_TTL = 21600000;

/** 表上限：池子 1600 条，这里只留最常出现的几百条，避免内存与上报体积失控 */
const EG_MAX = 512;

/**
 * 功能：出口族事实表。持有 (中继 IP → 族) 的记忆、待上报增量与合并逻辑。
 *
 * 为什么要有待上报（pending）而不是「记下就算数」：增量是搭 `/meter/add` 的车上去的，
 * 一次 POST 失败（1102、超时）如果已经把本地标记成「已发送」，这条事实就永久丢了。
 * 所以取增量时不清理，等 DO 回 200 后由 `ack()` 统一清理，失败走 `nack()` 重发。
 */
export class EgFacts {
  /** 已知事实：IP → { f, at } */
  private m = new Map<string, { f: number; at: number }>();
  /** 尚未确认送达的增量：IP → { f, at } */
  private pend = new Map<string, { f: number; at: number }>();

  /**
   * 功能：记一条出口族事实。
   * @param {string} ip 中继 IP（不带端口）
   * @param {number} fam 出口族：4 或 6，其他值直接忽略
   * @param {number} at 观测时间（毫秒时间戳），默认当前时间
   * @returns {void}
   */
  note(ip: string, fam: number, at = Date.now()): void {
    if (!ip || (fam !== 4 && fam !== 6)) return;
    const cur = this.m.get(ip);
    // 同族且不比已知的新：什么都不用做（避免每次请求都刷新 at，把过期时间无限推后）
    if (cur && cur.f === fam && cur.at >= at) return;
    this.m.set(ip, { f: fam, at });
    this.pend.set(ip, { f: fam, at });
    this.trim(at);
  }

  /**
   * 功能：查一条中继的出口族，过期的当「未知」。
   * @param {string} ip 中继 IP
   * @param {number} now 当前时间（便于单测注入）
   * @returns {number} 4 / 6 / 0（0 表示未知或已过期）
   */
  famOf(ip: string, now = Date.now()): number {
    const e = this.m.get(ip);
    if (!e) return 0;
    if (now - e.at > EG_TTL) {
      this.m.delete(ip);
      return 0;
    }
    return e.f;
  }

  /**
   * 功能：按出口族给代价乘数。**CF 托管站点按族分层**，其余站点只做轻微偏置。
   * 为什么分层：同一分钟的钉中继实测是 3 条 v4 全 200（9/9）、3 条 v6 全 403（0/9），族几乎完全决定能否通过；
   * 而 0.95/1.05 这种「轻微偏置」会被 relCost/psFactor 的差异淹没，等于没上线（三轮 A/B 差异都在噪声内）。
   * 为什么未知族不能压太狠：未知里也可能有 v4，压到最底会让探索永远学不到新 v4（`egUnk` 一直是 5/8）。
   * 为什么是乘数不是过滤：v8 §15 的 I1 —— `eg` 只改排序，永不剔除候选；唯一硬排除是 `dead`。
   * @param ip 中继 IP
   * @param cf 目标是否 CF 托管（只有这类站点对出口族敏感）
   * @param now 当前时间
   * @returns {number} 代价乘数
   */
  bias(ip: string, cf = false, now = Date.now()): number {
    const f = this.famOf(ip, now);
    if (f === 4) return cf ? 1 : 0.95;
    if (f === 6) return cf ? 40 : 1.05;
    // 未知族在 CF 站点上只轻罚（×2）：本地闭环证明（`tools/exp-v8proof.mjs`）显示，把未知也压到 40 会死锁 ——
    // 冷启动第一条连接被 `cold-pin` 钉在 v6 上，之后「没量过的 v4」与「已知是 v6」同价，探索压力消失，
    // 400 条连接全卡在 10.8%。轻罚后未测的 v4 会排在已知 v6 前面，先被采样、随后靠整页证据升到 ×1。
    return cf ? 2 : 1;
  }

  /**
   * 功能：取待上报的增量（不清空，等 ack）。
   * @returns {EgRow[]} 最多 16 行：`/meter/add` 的车身要小，剩下的下一轮再发
   */
  delta(): EgRow[] {
    const out: EgRow[] = [];
    for (const [i, e] of this.pend) {
      out.push({ i, f: e.f, at: e.at });
      if (out.length >= 16) break;
    }
    if (out.length) cnt("egSent", out.length);
    return out;
  }

  /** 功能：上报成功 —— 待发增量正式生效。@returns {void} */
  ack(): void {
    this.pend.clear();
  }

  /** 功能：上报失败 —— 丢弃待发标记，下一轮重新登记（值仍在 `m` 里，重发不会丢数据）。@returns {void} */
  nack(): void {
    // 保留 pending：上报失败时下一轮 delta() 会把同一批原样再给一次（重发 = 重试，幂等靠 at）。
    // 清掉它就等于「这条证据从此不会送到 DO」—— 与 v8 §3 的 pending 语义相反（只有 ack 才清）。
  }

  /**
   * 功能：合并远端事实（冷启动拉回来的那份）。
   * @param {EgRow[]} rows 远端行
   * @returns {number} 真正被采纳的行数（更旧的忽略，便于观察合并效果）
   */
  load(rows: EgRow[]): number {
    let n = 0;
    for (const r of rows) {
      if (!r || typeof r.i !== "string" || (r.f !== 4 && r.f !== 6) || typeof r.at !== "number") continue;
      const cur = this.m.get(r.i);
      if (cur && cur.at >= r.at) continue;
      this.m.set(r.i, { f: r.f, at: r.at });
      n += 1;
    }
    this.trim(0);
    return n;
  }

  /**
   * 功能：调试快照（按 `at` 降序）。
   * @returns {EgRow[]} 未过期的行，最多 64 条
   */
  /**
   * 功能：列出已知 v4 出口，最近的在前。
   * 用途：冷 isolate 里 `S.alive` 还是空的时候，用它兜底挑一条「已验证能把页面送回来」的中继，
   * 而不是退回直连（CF→CF 直连几乎必被自家边缘拒）。
   * @param now 当前时间（用于过滤过期行）
   * @returns {string[]} 中继 IP 列表
   */
  v4List(now = Date.now()): string[] {
    this.trim(now);
    const out: Array<{ i: string; at: number }> = [];
    for (const [i, r] of this.m) if (r.f === 4) out.push({ i, at: r.at });
    out.sort((a2, b2) => b2.at - a2.at);
    return out.map((x) => x.i);
  }

  /**
   * 功能：导出当前有效的 `eg` 行（供 `/health` 与调试口展示）。
   * @returns {EgRow[]} 出口族事实行
   */
  snap(): EgRow[] {
    const now = Date.now();
    const out: EgRow[] = [];
    for (const [i, e] of this.m) if (now - e.at <= EG_TTL) out.push({ i, f: e.f, at: e.at });
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, 64);
  }

  /** 功能：清零（单测用）。@returns {void} */
  clear(): void {
    this.m.clear();
    this.pend.clear();
  }

  /**
   * 功能：有界化 —— 清掉过期行，仍超上限就按观测时间淘汰最旧的。
   * @param {number} now 当前时间
   * @returns {void}
   */
  private trim(now: number): void {
    if (this.m.size <= EG_MAX) {
      if (now > 0) for (const [ip, e] of this.m) if (now - e.at > EG_TTL) this.m.delete(ip);
      return;
    }
    if (now > 0) for (const [ip, e] of this.m) if (now - e.at > EG_TTL) this.m.delete(ip);
    if (this.m.size <= EG_MAX) return;
    const rows = [...this.m.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < rows.length - EG_MAX; i++) this.m.delete(rows[i][0]);
  }
}

/** 进程内唯一的出口族事实表（每个 isolate 一份，读到的远端事实会在冷启动时灌进来） */
export const EG = new EgFacts();

/** 「整页」门槛：CF 托管站点对 v6 出口一律回 737B 左右的小页，能出 20KB 说明这条通道确实走了 v4 */
export const EG_BIG = 20000;

/** `tiny` 上限：与 `commitfact` 的 `TINY_ABS` 同源，避免两处口径漂移 */
export const EG_TINY = 2048;

/** 推导 `eg` 时可用的旁证：都是「数据面已经发生的事实」，不需要任何额外探测 */
export interface EgEv {
  /** 同窗口是否另有通道对本站出过 ≥20KB 整页（小页 ⇒ 族级拒绝的必要对照） */
  peerBig?: boolean;
  /** 站点「确实能出内容」的旁证（本出口 fetch 200 或同站点别的通道出过整页） */
  known?: boolean;
  /** 本站点已被 DNS 事实确证为纯 v4（有 A 无 AAAA）：此时送到页面就证明中继有 v4 出口 */
  siteV4?: boolean;
  /** 目标是否 CF 托管：只有这类站点会用「20KB 整页」区分出口族（见下面三条规则） */
  cf?: boolean;
}

/**
 * 功能：从一次真实连接的响应推导中继出口族，并写进事实表（`eg` 的**唯一**生产来源）。
 * 为什么不用主动探测：实测 `probeTf` 的自定义 `dial` 连到的是探测器自己的出口（本机返回本机公网 IP、
 * 生产 DO 返回 Cloudflare 自有网段），据此判族会把 v4 中继反向加权，比不判更差（清单 §I）。
 * 三条规则，按证据强度排：整页 ⇒ v4（硬）；`known` 成立时的小页 ⇒ v6（族级拒绝）；纯 v4 站点送页 ⇒ v4。
 * @param {string} ip 中继 IP（不带端口）
 * @param {number} down 本次下行字节数
 * @param {EgEv} ev 旁证（缺省为空对象，任一成立才可能写）
 * @param {number} now 观测时间
 * @returns {number} 本次写入的族（4 或 6），没写返回 0
 */
export function egDerive(ip: string, down: number, ev: EgEv = {}, now = Date.now()): number {
  if (!ip) return 0;
  // 整页是硬证据：v6 出口在 737B 的小页上就停住了，拿不到 20KB 以上
  // 「整页 ⇒ v4」只在 CF 托管站点上成立：别的站点 v6 出口也能出整页，拿它判族会把 v6 中继标成 v4，
  // 之后打 CF 站点时按 ×1 优先选它（本地闭环证明里正是这种反向标注最伤）。
  if (down >= EG_BIG && ev.cf) {
    EG.note(ip, 4, now);
    return 4;
  }
  // 小页 + 「站点能出内容」的旁证 ⇒ 差分成因明确：站点没拒绝所有人，是这条通道的出口被拒
  if (down > 0 && down <= EG_TINY && ev.cf && (ev.peerBig || ev.known)) {
    EG.note(ip, 6, now);
    return 6;
  }
  // 纯 v4 站点（DNS 确证无 AAAA）能送到页面 ⇒ 这条中继一定走 v4（v6-only 中继到不了它）
  if (down > 0 && ev.siteV4) {
    EG.note(ip, 4, now);
    return 4;
  }
  return 0;
}


/**
 * 功能：统计一组中继的出口族分布 —— `alive` 里到底有几条 v4 出口，是 v8 的一等预算项。
 * 为什么要它：好出口为 0 条时排序再好也只有个位数成功率（0→1 条值 82 个点），
 * 所以「有几条 v4 出口」必须能在 `/health` 上直接看到，而不是靠猜。
 * @param ips 中继 IP 列表
 * @param now 当前时间
 * @returns {{ v4: number, v6: number, unk: number }} 分布
 */
export function egCounts(ips: string[], now = Date.now()): { v4: number; v6: number; unk: number } {
  let v4 = 0;
  let v6 = 0;
  let unk = 0;
  for (const ip of ips) {
    const f = EG.famOf(ip, now);
    if (f === 4) v4 += 1;
    else if (f === 6) v6 += 1;
    else unk += 1;
  }
  return { v4, v6, unk };
}

/**
 * 功能：这一轮该花几个 connect 名额去测「出口族未知」的中继。
 * 依据（v8 §7.3）：v4 出口 <3 条时把更多预算给未知项 —— 每轮 4 条；够 3 条就回到 2 条，
 * 因为再多的 v4 出口只值 0.9 个点，而 connect 名额是全局 6 个的硬上限。
 * @param v4 当前已知 v4 出口条数
 * @returns {number} 本轮探测条数
 */
export function egQuota(v4: number): number {
  return v4 < 3 ? 4 : 2;
}
