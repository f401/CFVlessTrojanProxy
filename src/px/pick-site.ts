// 站点画像这一层：这个站历史上哪条最好、要不要给没试过的节点一次机会、以及抽到之后怎么避开在途过多的那条。
// 「候选池准备」（pick-ready）、「通道/入口偏好」（pick-pref）与「地区硬要求」（pickpath）都不在这里。

import { shadowRate } from "../core/util";
import { hostKey, hostRank, hostUntried } from "../nodes/metrics";
import { cnt } from "../core/counter";
import { bestFor, candsFor, costOf, isBlack, isFrozen, nsGet } from "../nodes/score";
import { S } from "../core/state";
import type { PickState } from "./pick-types";
import { pickThom } from "./ts";

/**
 * 按站点画像挑一个候选：站点样本优先，其次冷启动影子，最后交给单层抽样器。
 * 收成类是为了让每一步能被单独观察（站点偏好 / 影子 / 抽样 / 粘滞），状态全在 `S` 里。
 */
export class SitePick {
  /**
   * 功能：选一个节点。
   *   ① 先看「这个站」的历史：有样本就按站点分选（hostRank）
   *   ② 冷启动（这个站试过的节点 <3）：按影子预算去试一个没试过的
   *   ③ 都没有 → 单层抽样器（分数 ± 不确定性，两种模式共用）
   * @param {object} env Worker 环境
   * @param {'lat'|'tput'} mode 选路模式
   * @param {object|null} st 连接状态（会写 st.node / st.hostTrial）
   * @returns {string} 候选键 `host:port`，全池不可用时返回「最不坏」的那条（不会是空串）
   */
  pick(env: Env, mode: Mode, st: PickState | null): string {
    const m = mode === "lat" ? "lat" : "tput";
    const now = Date.now();
    let cur = S.curs[m];
    // 游标可能是上一代候选池里的节点：池子刷新后 alive 里已经没有它了。
    // 以前会一直把连接拨到这个死地址，直到 cron 的 maybeSwitch 才发现。
    // 游标只做面板/健康展示：真正走谁由 ③ 的单层抽样器决定。
    if (!cur || !S.alive.has(cur) || isBlack(cur) || isFrozen(cur)) {
      cur = bestFor(m);
      S.curs[m] = cur;
    }
    if (!cur) cnt("noCand");
    const host = st && st.host ? String(st.host) : "";
    if (st) st.hostTrial = false;

    // 画像按「域名族」存（api.x.com 与 pbs.twimg.com 共用 x.com），读写必须用同一个键
    const fam = host ? hostKey(host) : "";
    if (host && fam) {
      const hm = S.hostNode.get(fam);
      const tried = hm ? hm.size : 0;

      // ① 有站点样本 → 按站点分选。
      //    少于 3 个节点有样本时排序没有比较意义（门槛在下面也要求 sampled>=3），
      //    直接跳过：省掉一次遍历全部节点的 hostRank 构建。
      if (tried >= 3) {
        const rank = hostRank(host, m);
        if (rank.length) {
          const best = rank[0].k;
          const bs = hm!.get(best);
          // 至少 3 个节点有样本、且首选样本不超过 2 小时，才敢用站点偏好覆盖全局
          let sampled = 0;
          for (const s of hm!.values()) if (s.n > 0) sampled++;
          const fresh = now - (bs ? bs.at || 0 : 0) <= 2 * 3600e3;
          if (bs && bs.n > 0 && sampled >= 3 && fresh) {
            // 稳定期留 2% 给次优节点，保持样本新鲜（不然一次侥幸定终身）。
            // 但次优和首选差太多时不换：那不是「保持新鲜」，是主动跳坑。
            const second = rank[1];
            if (second && second.v <= rank[0].v * 1.3 + 100 && !(st && st.retried) && Math.random() < 0.02) {
              if (st) st.node = second.k;
              return second.k;
            }
            if (st) st.node = best;
            return best;
          }
        }
      }
    }

    // ② 冷启动：这个站还没攒够节点样本时，用影子流量补几条（只为站点画像，不参与选路）
    //    抽样器本身就带探索（样本少 ⇒ 乐观面大 ⇒ 自然被抽），这里只解决「新域名前几条连接
    //    全打同一个节点、画像建不起来」的问题，所以跟的是同一个 pxShadow 预算。
    const base = shadowRate(env);
    if (cur && base > 0 && !(st && st.retried) && host && fam && Math.random() < base) {
      const hm = S.hostNode.get(fam);
      if (!hm || hm.size < 3) {
        const t0 = hostUntried(host, m);
        if (t0) {
          nsGet(t0).lastTry = Date.now();
          if (st) {
            st.hostTrial = true;
            st.node = t0;
          }
          return t0;
        }
      }
    }

    // ③ 选路：单层抽样器（完整分数 ± 不确定性，两种模式共用同一套）
    const pick = pickThom(m, (st && st.targetBytes) || 0);
    if (pick) {
      let chosen = pick;
      // 负载感知：抽中的节点在途多时，换到分数接近、在途更少的候选
      const alt = this.spill(chosen, m);
      if (alt) chosen = alt;
      if (st) st.node = chosen;
      return chosen;
    }
    // ④ 兜底：粘滞游标 + 负载溢出
    const spill = cur ? this.spill(cur, m) : "";
    if (spill) cur = spill;
    if (st) st.node = cur;
    if (cur) return cur;
    // ⑤ 全池都在冷却/冻结时的兜底：返回「最早能恢复、且代价最低」的那个，
    //    不能返回空串——空串会让 session 直接放弃这条连接（cnt("dead")），
    //    哪怕池子里还有一堆节点只是暂时被罚。宁可试一次再失败，也不要凭空判死。
    const last = this.leastBad(m);
    if (st) st.node = last;
    return last;
  }

  /**
   * 功能：负载溢出 —— 指定节点在途 ≥2 时换到代价相近、在途更少的候选。
   * @param {string} key 当前选中的候选键
   * @param {'lat'|'tput'} mode 选路模式
   * @returns {string} 替代候选键；不需要换或换不到时返回空串
   */
  private spill(key: string, mode: Mode): string {
    // 在途少于 2 条时不用管：两条并发的上限就是免费计划的常态
    if (!key || (S.inflight.get(key) || 0) < 2) return "";
    const cur = costOf(key, mode);
    let alt = "";
    let bv = Infinity;
    // 只在候选表前 8 条里找：更靠后的候选本来就慢，换过去是「换个人排队」不是「少排队」
    for (const x of candsFor(mode).slice(0, 8)) {
      if (x.k === key) continue;
      // 代价超过 1.5 倍就宁可排队：溢出的目的是削峰，不是把流量送给慢节点
      if (x.v > cur * 1.5) continue;
      // 只在「确实比当前更空」时换，否则会在两个同样忙的节点间来回弹
      if ((S.inflight.get(x.k) || 0) >= (S.inflight.get(key) || 0)) continue;
      if (x.v < bv) {
        bv = x.v;
        alt = x.k;
      }
    }
    return alt;
  }

  /**
   * 功能：兜底 —— 冷却期里挑最不坏的（先比恢复时间，再比代价）。
   * @param {'lat'|'tput'} mode 选路模式
   * @returns {string} 候选键；池子为空时返回空串
   */
  private leastBad(mode: Mode): string {
    let best = "";
    let bk = Infinity;
    let bs = Infinity;
    // 遍历存活表而不是候选表：候选表是「可用」的排序结果，这里恰恰是它们全都不可用的时候
    for (const k of S.alive.keys()) {
      const s = S.nstat.get(k);
      // 冷却有两种（判死 / 冻结），取更晚的那个作为「最早能再试」的时刻
      const until = Math.max(s ? s.blackUntil : 0, s ? s.freeUntil : 0);
      const v = costOf(k, mode);
      // 先比恢复时间（早恢复的先试），同刻再比代价 —— 与 `ranked` 的口径一致，只是不看可用性
      if (until < bk || (until === bk && v < bs)) {
        best = k;
        bk = until;
        bs = v;
      }
    }
    return best;
  }
}

/** 进程内唯一实例 */
export const SITE = new SitePick();
