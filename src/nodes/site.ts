/**
 * 站点画像：同一站点族在不同节点上的成败、字节、首字节与带宽样本，以及直连对照。
 *
 * 与全局节点分的区别：全局分回答「这台节点好不好」，站点画像回答「这台节点打这个站好不好」。
 * 有些节点整体很快，但某个站一直被它挡（IP 级封锁），只有站点级样本才看得出来。
 */
import { SC } from "../core/const";
import { S } from "../core/state";
import { TEN_MB, candsFor, costOf, isBlack, isFrozen } from "./score";

/** 最多记 120 个域名：键来自客户端请求的目标站点名，不设上限会被历史站点撑爆内存 */
export const HN_MAX_HOSTS = 120;
/** 每个域名最多记 12 个节点：超过就淘汰最久未更新的那条 */
export const HN_MAX_NODES = 12;

/**
 * 域名 → 站点族。
 * 目的：x.com / api.x.com / pbs.twimg.com 共享一份样本，否则每个域名
 * 各自只有一两条样本，永远学不出来。少数大厂手工归并，其余按可注册域。
 * @param {string} host 目标域名
 * @returns {string} 族名
 */
export function hostKey(host: string): string {
  const h = String(host || "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (!h) return "";
  if (/^[\d.]+$/.test(h) || h.includes(":")) return h; // IP 字面量原样

  // 站点族键统一由 siteKey 推导：同一套基础设施的域名会自然落到同一个 eTLD+1 上
  return siteKey(h);
  // 归并规则已统一到 siteKey（eTLD+1 近似），这里不再维护第二套表
}

/**
 * 站点画像打分。返回 -1 表示"这个模式没有站点级样本"，调用方回退全局分。
 *   lat  → 首字节 + 失败风险
 *   tput → 站点级 10MB 估算 + 0.5×首字节 + 失败风险（没有吞吐样本就不要拿 TTFB 冒充）
 */
export function hostScore(s: HNStat, mode: Mode, now: number): number {
  const fail = (s.bad + 1) / (s.n + 6); // 小样本往坏里估
  const stale = now - (s.at || 0) > 6 * 3600e3 ? 300 : 0; // 6 小时没更新就降权
  const ttfb = s.ttfb > 0 ? s.ttfb : 800;
  if (mode === "tput") {
    const bpsAge = now - (s.bpsAt || 0);
    if (!(s.bpsN && s.bps && s.bps > 0) || bpsAge > SC.SAMPLE_TTL) return -1;
    return (TEN_MB / s.bps) * 1000 + 0.5 * ttfb + fail * 4000 + stale;
  }
  return ttfb + fail * 4000 + (s.n < 2 ? 150 : 0) + stale;
}

/**
 * 功能：站点画像表：每个站点族在一台节点上的成败/字节/首字节/带宽样本，以及直连对照。
 *
 * 它与全局节点分的区别：全局分回答「这台节点好不好」，站点画像回答「这台节点打这个站好不好」。
 * 有些节点整体很快，但某个站一直被它挡（IP 级封锁），只有站点级样本能看出来。
 * 内存表都在 S.hostNode / S.hostDirect 里，本类只负责读写与淘汰，不跨 isolate 共享。
 */
export class HostProfile {
  /**
   * 功能：记一次（站点, 节点）的连接结果，必要时淘汰最久未更新的域名/节点。
   * @param host 目标域名（内部转成站点族）
   * @param node 节点 key（"host:port"）
   * @param o 本次结果（ok/bad/bytes/ttfb/bps 都是可选）
   * @returns 无
   */
  markNode(host: string, node: string, o: Partial<HNStat>): void {
    if (!host || !node) return;
    const fam = hostKey(host);
    if (!fam) return;
    let m = S.hostNode.get(fam);
    if (!m) {
      if (S.hostNode.size >= HN_MAX_HOSTS) {
        // 淘汰最久没更新过的域名（120 条，线性扫可接受）
        let oldK = "",
          oldT = Infinity;
        for (const [k, v] of S.hostNode) {
          let t = 0;
          for (const s of v.values()) if (s.at > t) t = s.at;
          if (t < oldT) {
            oldT = t;
            oldK = k;
          }
        }
        if (oldK) S.hostNode.delete(oldK);
      }
      m = new Map<string, HNStat>();
      S.hostNode.set(fam, m);
    }
    let s = m.get(node);
    if (!s) {
      if (m.size >= HN_MAX_NODES) {
        let oldN = "",
          oldT = Infinity;
        for (const [k, v] of m)
          if (v.at < oldT) {
            oldT = v.at;
            oldN = k;
          }
        if (oldN) m.delete(oldN);
      }
      s = { n: 0, ok: 0, bad: 0, bytes: 0, ttfb: 0, at: 0 };
      m.set(node, s);
    }
    // 站点封禁是"临时事实"而不是判决书：6 小时没再更新过的坏样本减半。
    // 以前 bad 只增不减，一个站偶尔封过一次，这条 (站,节点) 记录就被永久钉在下面，
    // 而节点全局分早就恢复了 —— 站点排行却再也不会给它机会。
    if (s.bad > 0 && s.at && Date.now() - s.at > 6 * 3600e3) {
      s.bad *= 0.5;
      s.n = s.ok + s.bad;
    }
    // 只带 bps 的调用是"中途采样"，0 字节 0 失败的收尾也不是有效站点样本
    const isConn = o.ok !== undefined || o.bad !== undefined;
    if (isConn && (o.ok || o.bad)) {
      s.n += 1;
      if (o.ok) s.ok += 1;
      if (o.bad) s.bad += 1;
      // 缓存失效（两个模式各一份）。中途 bps 采样不失效：
      // 一次视频播放每 60 秒就刷一次，排行 30 秒本来也会过期。
      S.hostRankCache.delete(fam + "|lat");
      S.hostRankCache.delete(fam + "|tput");
    }
    s.bytes += o.bytes || 0;
    const ttfb = o.ttfb || 0;
    if (ttfb > 0) s.ttfb = s.ttfb ? Math.round(s.ttfb * 0.6 + ttfb * 0.4) : Math.round(ttfb);
    const bps = o.bps || 0;
    if (bps > 0) {
      s.bps = s.bps ? Math.round(s.bps * 0.6 + bps * 0.4) : bps;
      s.bpsN = (s.bpsN || 0) + 1;
      s.bpsAt = Date.now();
    }
    s.at = Date.now();
  }

  /**
   * 功能：记一次直连结果（判断「是节点的锅还是站点/指纹的锅」）。
   * @param host 目标域名（与 markNode 用同一个族键）
   * @param ok 直连是否成功拿到数据
   * @returns 无
   */
  markDirect(host: string, ok: boolean): void {
    if (!host) return;
    // 和 hostNodeMark 用同一个族键：写 www.x.com、读 x.com 时不能对不上
    const fam = hostKey(host);
    if (!fam) return;
    if (S.hostDirect.size >= HN_MAX_HOSTS) {
      let oldK = "",
        oldT = Infinity;
      for (const [k, v] of S.hostDirect)
        if (v.at < oldT) {
          oldT = v.at;
          oldK = k;
        }
      if (oldK) S.hostDirect.delete(oldK);
    }
    const e = S.hostDirect.get(fam) || { ok: 0, bad: 0, at: 0 };
    if (ok) e.ok += 1;
    else e.bad += 1;
    e.at = Date.now();
    S.hostDirect.set(fam, e);
  }

  /**
   * 功能：某个站点上的节点排行（跳过黑名单/冻结），30 秒缓存，升序。
   * @param host 目标域名（内部转成族）
   * @param mode "lat" | "tput"
   * @returns 按分数升序的 { k, v } 列表
   */
  rank(host: string, mode: Mode): RankRow[] {
    const fam = hostKey(host);
    if (!fam) return [];
    const mkey = fam + "|" + (mode === "lat" ? "lat" : "tput");
    const now = Date.now();
    const hit = S.hostRankCache.get(mkey);
    if (hit && now - hit.t < 30000) return hit.v;

    const m = S.hostNode.get(fam);
    const out: RankRow[] = [];
    if (m) {
      for (const [k, s] of m) {
        if (!S.alive.has(k) || isBlack(k) || isFrozen(k)) continue;
        const hs = hostScore(s, mode, now);
        // 站点级没有该模式的样本：回退全局同模式分数，别用另一种模式冒充
        out.push({ k, v: hs >= 0 ? hs : costOf(k, mode) });
      }
    }
    // 只有样本少于 2 个时才把"没试过的节点"按全局分补进来（冷启动用）
    if (out.length < 2) {
      for (const r of candsFor(mode)) {
        if (m && m.has(r.k)) continue;
        out.push({ k: r.k, v: r.v + 300 });
      }
    }
    out.sort((a, b) => a.v - b.v);
    if (S.hostRankCache.size > 80) S.hostRankCache.clear();
    S.hostRankCache.set(mkey, { t: now, v: out });
    return out;
  }

  /**
   * 功能：这个站还没试过、且全局分最好的节点（冷启动用）。
   * @param host 目标域名
   * @param mode 模式
   * @returns 节点 key；没有候选时返回空串
   */
  untried(host: string, mode: Mode): string {
    const m = S.hostNode.get(hostKey(host));
    // 直接用全局排行（20 秒缓存）：它就是按 costOf 升序排好的，
    // 取第一个没在这个站试过的即可。以前这里对每个节点现算 costOf，
    // 200 个候选时单次 pick 要 1 ms，全花在重复计算上。
    //
    // 「刚试过」也要跳过：站点画像是在连接结束时才写 S.hostNode，而冷启动的
    // 影子试探可能在同一秒里并发两三条 —— 只看 hostNode 会让它们挑到同一个节点，
    // 试探就白做了（这个站只多了一行样本）。lastTry 正是为此写的，7.212 接上。
    const now = Date.now();
    let recent = "";
    for (const r of candsFor(mode)) {
      if (m && m.has(r.k)) continue;
      const s = S.nstat.get(r.k);
      if (s && now - (s.lastTry || 0) < SC.UNTRIED_GAP) {
        if (!recent) recent = r.k;
        continue;
      }
      return r.k;
    }
    // 全都在窗口内（池子很小）时退回第一个：宁可在同一条上再试，也不要返回空串
    return recent;
  }
}

/** 进程内单例：站点画像表（每个 isolate 各自维护） */
export const HOSTS = new HostProfile();

/**
 * 功能：记一次（站点, 节点）连接结果（薄包装，委托 HOSTS.markNode）。
 * @param host 目标域名
 * @param node 节点 key
 * @param o 本次结果
 * @returns 无
 */
export function hostNodeMark(host: string, node: string, o: Partial<HNStat>): void {
  HOSTS.markNode(host, node, o);
}

/**
 * 功能：记一次直连结果（薄包装，委托 HOSTS.markDirect）。
 * @param host 目标域名
 * @param ok 是否成功
 * @returns 无
 */
export function hostDirectMark(host: string, ok: boolean): void {
  HOSTS.markDirect(host, ok);
}

/**
 * 站点族键：同一站点的不同子域共享一份样本。
 * 通用规则（不针对任何具体网站）：取可注册域，即 host 的最后两段；
 * 若倒数第二段是常见二级后缀（co/com/net/org/gov/edu/ac），则保留三段。
 */
export function siteKey(h: string): string {
  const parts = String(h || "").toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const last = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (parts.length >= 3 && /^(co|com|net|org|gov|edu|ac)$/.test(sld)) {
    return parts.slice(-3).join(".");
  }
  return sld + "." + last;
}
