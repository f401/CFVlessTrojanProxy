// 出口族事实（`eg`）：这条中继出站用的是 IPv4 还是 IPv6。
//
// 为什么值得单独一层：同一个站点对两种族的接受率差一个数量级（实测 x.com：v4 出口 6/6、
// 两边都 200 整页；v6 出口 2/16，其余是 737B 的拒绝页）。而这个差别是**中继出口地址**的属性，
// 与用户位置、与 isolate 无关 —— 所以它可以跨 isolate 共享（v8 §16.5 的共享边界）。
//
// 纪律（v8 §15 的 I2）：这里只产出**代价偏置**，永远不参与「能不能用」的判定。
// 一个 `eg=6` 的中继仍然可能在别的站点头等好使，把它从候选里删掉就是 7.57 的老路
// （通配硬封锁 → 可用池变薄 → 失败率 10%→50%）。
//
// 生命周期（有界化、分批上行、ack/nack 的纪律）全部继承自 `FactTable`：这张表原来自己也抄过
// 一份 `pend`/`sent` + `delta`/`ack`/`nack`，与 `ps`/`blk`/`dead`/`dns` 一字不差 —— 抄四遍就会
// 修两遍（7.143、7.177）。现在子类只回答「行长什么样」和「三个刻度是多少」。
import { cnt } from "../core/counter";
import { FACT_TTL, PAGE_ABS } from "../core/facts";
import { BoundedMap } from "../core/table";
import { FactTable } from "./fact-table";

/** 一条出口族事实的线格式：`i` 中继 IP，`f` 族（4 或 6），`at` 观测时间 */
export interface EgRow {
  i: string;
  f: number;
  at: number;
}

/** 表内一行：键已经是 IP，所以行里只留族与时间 */
interface EgEntry {
  /** 出口族：4 或 6 */
  f: number;
  /** 最后一次观测时间 */
  at: number;
}

/** 事实寿命：实测 1.5 小时后出口族仍一致，但中继会换线路，6 小时足够保守 */
export const EG_TTL = FACT_TTL.eg;

/** 表上限：池子 1600 条，这里只留最常出现的几百条，避免内存与上报体积失控 */
const EG_MAX = 512;

/**
 * 功能：出口族事实表 —— 持有 (中继 IP → 族) 的记忆，增量上行与合并交给基类。
 *
 * 为什么要有待上报（pending）而不是「记下就算数」：增量是搭 `/meter/add` 的车上去的，
 * 一次 POST 失败（1102、超时）如果已经把本地标记成「已发送」，这条事实就永久丢了。
 * 所以取增量时不清理，等 DO 回 200 后由 `ack()` 统一清理，失败走 `nack()` 重发。
 */
export class EgFacts extends FactTable<EgEntry, EgRow> {
  /** 寿命：出口族一条事实的有效期 */
  protected get ttlMs(): number {
    return EG_TTL;
  }

  /** 上限：超出就按观测时间淘汰最旧的 */
  protected get maxRows(): number {
    return EG_MAX;
  }

  /** 每批上限：`/meter/add` 的车身要小，一次最多交 16 行 */
  protected get batchMax(): number {
    return 16;
  }

  /**
   * 功能：把一行编成线格式（键已经是 IP）。
   * @param {string} key 中继 IP
   * @param {EgEntry} row 行
   * @returns {EgRow} 线格式
   */
  protected toWire(key: string, row: EgEntry): EgRow {
    return { i: key, f: row.f, at: row.at };
  }

  /**
   * 功能：把线格式解码成一行（坏行返回 null）。
   * @param {EgRow} wire 线格式
   * @returns {{ key: string; row: EgEntry } | null} 键与行；族不是 4/6 或时间缺失就整条跳过
   */
  protected parseWire(wire: EgRow): { key: string; row: EgEntry } | null {
    if (!wire || typeof wire.i !== "string" || (wire.f !== 4 && wire.f !== 6)) return null;
    if (typeof wire.at !== "number") return null;
    return { key: wire.i, row: { f: wire.f, at: wire.at } };
  }

  /**
   * 功能：记一条出口族事实。
   * @param {string} ip 中继 IP（不带端口）
   * @param {number} fam 出口族：4 或 6，其他值直接忽略
   * @param {number} at 观测时间（毫秒时间戳），默认当前时间
   * @returns {void}
   */
  note(ip: string, fam: number, at = Date.now()): void {
    if (!ip || (fam !== 4 && fam !== 6)) return;
    const cur = this.getNow(ip);
    // 同族且不比已知的新：什么都不用做（避免每次请求都刷新 at，把过期时间无限推后）
    if (cur && cur.f === fam && cur.at >= at) return;
    this.put(ip, { f: fam, at }, at);
  }

  /**
   * 功能：读本地那一行，不做过期删除之外的副作用（供 `note` 判「要不要重写」）。
   * @param {string} ip 中继 IP
   * @returns {EgEntry | null} 仍然有效的行
   */
  private getNow(ip: string): EgEntry | null {
    return this.get(ip, Date.now());
  }

  /**
   * 功能：取待上报的增量（不清空，等 ack），顺带记一条「这批发了多少」的计数。
   * @returns {EgRow[]} 最多 16 行：`/meter/add` 的车身要小，剩下的下一轮再发
   */
  delta(): EgRow[] {
    const out = super.delta();
    // 计数只在这里：面板上「eg 上行量」要能看出是不是每轮都在发，而不是只有失败时才有信号
    if (out.length) cnt("egSent", out.length);
    return out;
  }

  /**
   * 功能：查一条中继的出口族，过期的当「未知」。
   * @param {string} ip 中继 IP
   * @param {number} now 当前时间（便于单测注入）
   * @returns {number} 4 / 6 / 0（0 表示未知或已过期）
   */
  famOf(ip: string, now = Date.now()): number {
    const e = this.get(ip, now);
    return e ? e.f : 0;
  }

  /**
   * 功能：按出口族给代价乘数。**CF 托管站点按族分层**，其余站点只做轻微偏置。
   * 为什么分层：同一分钟的钉中继实测是 3 条 v4 全 200（9/9）、3 条 v6 全 403（0/9），族几乎完全决定能否通过；
   * 而 0.95/1.05 这种「轻微偏置」会被 relCost/psFactor 的差异淹没，等于没上线（三轮 A/B 差异都在噪声内）。
   * 为什么未知族不能压太狠：未知里也可能有 v4，压到最底会让探索永远学不到新 v4（`egUnk` 一直是 5/8）。
   * 为什么是乘数不是过滤：v8 §15 的 I1 —— `eg` 只改排序，永不剔除候选；唯一硬排除是 `dead`。
   * @param {string} ip 中继 IP
   * @param {boolean} cf 目标是否 CF 托管（只有这类站点对出口族敏感）
   * @param {number} now 当前时间
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
   * 功能：按「站点×出口族」实测成功率给代价乘数（famfacts），取代 CF 目标 v6 的一刀切 ×40。
   * 为什么：v6 出口对部分 CF 站点必拒（737B），但对另一些能出整页；一刀切会把后者也永远压掉。
   * 只用本 isolate 的真实连接样本；样本不足 2 条回退旧分层偏置，冷启动行为完全不变。
   * 纪律：只乘代价、永不剔除候选（v8 §15 I1）；只会放松 v6 罚，不会给 v4 加新罚。
   * @param host 目标站点
   * @param ip 中继 IP
   * @param cf 目标是否 CF 托管
   * @param now 当前时间
   * @returns 代价乘数
   */
  biasFor(host: string, ip: string, cf = false, now = Date.now()): number {
    const base = this.bias(ip, cf, now);
    if (!cf || !host) return base;
    const fam = this.famOf(ip, now);
    if (fam !== 4 && fam !== 6) return base; // 未知族保持探索偏置（×2），避免冷启动死锁
    const s = FAM.rate(host, fam, now);
    if (s.n < 2) return base; // 样本不足：回退旧口径，冷启动不回归
    // 实测成功率 r → 乘数 1+39*(1-r)：r=1→1（旧 v4）、r=0→40（旧 v6），中间线性放松
    return Math.max(1, Math.min(base, 1 + 39 * (1 - s.r)));
  }

  /**
   * 功能：列出已知 v4 出口，最近的在前。
   * 用途：冷 isolate 里 `S.alive` 还是空的时候，用它兜底挑一条「已验证能把页面送回来」的中继，
   * 而不是退回直连（CF→CF 直连几乎必被自家边缘拒）。
   * @param {number} now 当前时间（用于过滤过期行）
   * @returns {string[]} 中继 IP 列表
   */
  v4List(now = Date.now()): string[] {
    const out = this.entries(now)
      .filter(([, row]) => row.f === 4)
      .map(([ip, row]) => ({ ip, at: row.at }));
    out.sort((a, b) => b.at - a.at);
    return out.map((x) => x.ip);
  }

  /**
   * 功能：导出当前有效的 `eg` 行（供 `/health` 与调试口展示）。
   * @returns {EgRow[]} 出口族事实行（最近的 64 条，最新的在前）
   */
  snap(): EgRow[] {
    const rows = this.entries(Date.now()).map(([ip, row]) => ({ i: ip, f: row.f, at: row.at }));
    rows.sort((a, b) => b.at - a.at);
    return rows.slice(0, 64);
  }
}

/** 进程内唯一的出口族事实表（每个 isolate 一份，读到的远端事实会在冷启动时灌进来） */
export const EG = new EgFacts();

/** 站点×出口族的一条实测样本：成功数 / 总数 / 最后观测时刻 */
interface FamRow {
  ok: number;
  n: number;
  at: number;
}

/**
 * 功能：站点×出口族的实测成功率（本 isolate 内存派生表，不进线协议）。
 * 为什么不扩线协议：七表→八表会牵动 vtShape/golden/DO/FactTables，blast 大；这张表是从真实连接
 * 派生的软定价依据，和 `eg`（中继→族、可跨 isolate 共享的客观事实）不是一类东西。
 * 有界化继承 BoundedMap：先 set 后 prune（7.227 教训），TTL 与 eg 同源。
 */
export class FamFacts {
  private readonly rows = new BoundedMap<string, FamRow>({
    max: 512,
    ttlMs: FACT_TTL.eg,
    timeOf: (row) => row.at,
  });

  /**
   * 功能：记一条「该站点从该族出口的结果」。
   * @param host 目标站点
   * @param fam 出口族（4 或 6，其它值忽略）
   * @param ok 是否拿到整页（小页/业务 403 不算成功）
   * @param now 当前时间
   * @returns 无
   */
  note(host: string, fam: number, ok: boolean, now = Date.now()): void {
    if (!host || (fam !== 4 && fam !== 6)) return;
    const key = host + "|" + fam;
    const row = this.rows.get(key) || { ok: 0, n: 0, at: now };
    row.n += 1;
    if (ok) row.ok += 1;
    row.at = now;
    this.rows.set(key, row);
    if (this.rows.size > this.rows.capacity()) this.rows.prune(now, false);
  }

  /**
   * 功能：读该站点该族的实测成功率与样本数。
   * @param host 目标站点
   * @param fam 出口族
   * @param now 当前时间
   * @returns 成功率 r 与样本数 n；无样本或过期时 n=0
   */
  rate(host: string, fam: number, now = Date.now()): { r: number; n: number } {
    if (!host || (fam !== 4 && fam !== 6)) return { r: 0, n: 0 };
    const row = this.rows.get(host + "|" + fam);
    if (!row || now - row.at > FACT_TTL.eg) return { r: 0, n: 0 };
    return { r: row.n > 0 ? row.ok / row.n : 0, n: row.n };
  }

  /**
   * 功能：当前样本对数（调试与测试隔离用）。
   * @returns 表内行数
   */
  size(): number {
    return this.rows.size;
  }

  /**
   * 功能：清空全部样本（测试隔离用）。
   * @returns 无
   */
  clear(): void {
    this.rows.clear();
  }
}

/** 进程内唯一的站点×出口族实测表（每个 isolate 一份，不跨 isolate 共享统计） */
export const FAM = new FamFacts();

/** 「整页」门槛：CF 托管站点对 v6 出口一律回 737B 左右的小页，能出 20KB 说明这条通道确实走了 v4 */
export const EG_BIG = PAGE_ABS.big;

/** `tiny` 上限：与 `commitfact` 的 `TINY_ABS` 同源，避免两处口径漂移 */
export const EG_TINY = PAGE_ABS.tiny;

/** 推导 `eg` 时可用的旁证：都是「数据面已经发生的事实」，不需要任何额外探测 */
interface EgEv {
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
  // 「送到了真实内容 ⇒ v4」只在 CF 托管站点上成立：别的站点 v6 出口也能出整页，拿它判族会把 v6 中继标成 v4，
  // 之后打 CF 站点时按 ×1 优先选它（本地闭环证明里正是这种反向标注最伤）。
  // 门槛用 EG_TINY 而不是 EG_BIG：v6 出口在 x.com 这类 CF 站点固定回 737B 的族拒绝页，
  // 真实业务页哪怕只有 4KB（x.com 隧道首页实测 4107B）也明显更大。旧口径要 ≥EG_BIG 才算 v4，
  // 结果 x.com 的 4107B 落在 EG_TINY~EG_BIG 的灰色地带两条规则都不满足 → EG 表恒空（线上 egSent=0/egDO=0），
  // 冷 isolate 无法区分 v4/v6 中继只能随机选，8 条里 4 条是 v6 出口 → 全分组偶发 737B IPv6 403。
  if (down > EG_TINY && ev.cf) {
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
 * @param {string[]} ips 中继 IP 列表
 * @param {number} now 当前时间
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
