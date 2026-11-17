import { SAMPLE_MIN_BYTES, SITE_MIN_BYTES, stalledWindow } from "./conn-sample";

/** 节点级采样窗口的最小长度：tick 可能比这更密（每次 tick 都结算会把短窗口算成低带宽） */
export const NODE_WIN_MS = 800;

/** 节点级样本的最小间隔：一次十几秒的大下载只够交 5 秒一个样本，再密就是同一段流量重复计分 */
export const NODE_EMIT_GAP_MS = 5000;

/** 站点级窗口的长度：长连接（看视频）不必等到结束才有第一个站点级样本 */
export const SITE_WIN_MS = 60000;

/** 一个可以交给评分层的节点级窗口 */
export interface NodeWindow {
  /** 窗口内下行字节 */
  bytes: number;
  /** 窗口时长（毫秒） */
  elapsedMs: number;
}

/** 一个可以交给站点画像的站点级窗口 */
export interface SiteWindow {
  /** 窗口内下行字节 */
  bytes: number;
  /** 窗口时长（毫秒） */
  elapsedMs: number;
}

/**
 * 一条连接上的两个采样窗口（节点级 5 秒 / 站点级 60 秒）。
 *
 * 为什么单独成类：窗口边界是「上一次结算的时刻与字节数」这一对状态，一共七个字段，
 * 全都只在采样路径上读写。放在 `Connection` 里时，它们与热路径的 `down`/`up` 混在一起，
 * 读代码的人分不清「哪个字段每 chunk 变、哪个每 5 秒变」。
 *
 * 三条纪律（挪动窗口时最容易踩的）：
 * 1) 窗口边界**无论能不能出样本都要推进**，否则短窗口会把下一次的 dt 越拖越长；
 * 2) 只有真的交出一个样本才推进 `lastEmit`（否则「样本太短」会被算成「刚采过」，
 *    高带宽连接反而被自己的短窗口饿死）；
 * 3) 背压占比用**本连接累计**的背压毫秒来算，不是窗口内的增量（`stallMark` 就是那条基线）。
 */
export class SampleWindow {
  /** 节点级：上一次结算的时刻（0 = 还没建立窗口起点） */
  at = 0;
  /** 节点级：上一次结算时的累计下行字节 */
  down = 0;
  /** 节点级：上一次真的交出样本的时刻（用来压「5 秒一个样本」的间隔） */
  lastEmit = 0;
  /** 节点级：上一次结算时的累计背压毫秒（算窗口内背压占比的基线） */
  stallMark = 0;
  /** 站点级：上一次结算的时刻 */
  siteAt = 0;
  /** 站点级：上一次结算时的累计下行字节 */
  siteDown = 0;
  /** 站点级：已经写出过几次样本（写过就别再用「一生平均」覆盖） */
  siteEmitted = 0;

  /**
   * 功能：建立窗口起点（第一次 tick 专用）。
   * @param {number} now 当前毫秒时间
   * @param {number} total 当前累计下行字节
   * @param {number} stallMs 当前累计背压毫秒
   * @returns {void}
   */
  begin(now: number, total: number, stallMs: number): void {
    // 第一次 tick 只记起点：否则第一段速率会把建连耗时一起算进分母
    this.at = now;
    this.down = total;
    this.stallMark = stallMs;
  }

  /**
   * 功能：推进节点级窗口，够格就交出样本。
   * @param {number} now 当前毫秒时间
   * @param {number} total 当前累计下行字节
   * @param {number} stallMs 当前累计背压毫秒
   * @returns {NodeWindow | null} 样本；窗口太短或样本太小返回 null
   */
  node(now: number, total: number, stallMs: number): NodeWindow | null {
    const dt = now - this.at;
    // 没有起点、窗口短于 800ms、或距上次出样本不足 5 秒：三种情况都直接跳过，边界不动
    if (!this.at || dt < NODE_WIN_MS || now - this.lastEmit < NODE_EMIT_GAP_MS) return null;
    const bytes = total - this.down;
    // 小样本不构成带宽证据：少于 64KB 的窗口会被建连耗时主导，交给连接是「噪声当样本」
    const out = bytes >= SAMPLE_MIN_BYTES ? { bytes, elapsedMs: dt } : null;
    // 边界无条件推进（纪律 1）：这次没出样本，下次的 dt 也必须是干净的
    this.at = now;
    this.down = total;
    this.stallMark = stallMs;
    return out;
  }

  /**
   * 功能：记下「刚才那个样本真的交出去了」，用于压住采样间隔。
   * @param {number} now 交出样本的时刻
   * @returns {void}
   */
  emitted(now: number): void {
    // 只有真的交给评分层才算采过（纪律 2）：算出来权重为 0 的样本不该占用间隔
    this.lastEmit = now;
  }

  /**
   * 功能：推进站点级窗口，够格就交出样本。
   * @param {number} now 当前毫秒时间
   * @param {number} total 当前累计下行字节
   * @returns {SiteWindow | null} 样本；没到 60 秒或样本太小时返回 null
   */
  site(now: number, total: number): SiteWindow | null {
    // 第一次进窗口只记起点：站点级要的是「这一段」而不是「这一生」
    if (!this.siteAt) {
      this.siteAt = now;
      this.siteDown = total;
      return null;
    }
    if (now - this.siteAt < SITE_WIN_MS) return null;
    const bytes = total - this.siteDown;
    const dt = now - this.siteAt;
    // 256KB 以下不报：小响应用「一生平均」算出的速率会反向排序（D5，7.83 的同一口径）
    const out = bytes >= SITE_MIN_BYTES ? { bytes, elapsedMs: dt } : null;
    if (out) this.siteEmitted++;
    this.siteAt = now;
    this.siteDown = total;
    return out;
  }

  /**
   * 功能：判断这个节点窗口里是不是有一半以上时间卡在背压（瓶颈在客户端）。
   * @param {number} dt 窗口时长（毫秒）
   * @param {number} stallMs 当前累计背压毫秒
   * @returns {boolean} 真表示「这段速率不代表节点能力」
   */
  stalled(dt: number, stallMs: number): boolean {
    // 用累计背压差值除以窗口长度：单看「这辈子卡过多久」会让老连接的每个窗口都被降权
    return stalledWindow(stallMs, this.stallMark, dt);
  }
}
