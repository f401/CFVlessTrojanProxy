/**
 * 一条 WebSocket 连接的全部状态与行为。
 *
 * 设计要点（CPU 优先）：
 *   热路径（每个 chunk）只做：加字节 → 比阈值 → 发送
 *   其余全部搬到 tick（每 512 KB 一次）：
 *     · 吞吐采样（用两次 tick 的字节/时间算 bps）
 *     · 结算给 PEND
 *     · 背压检查（唯一读 ws.bufferedAmount 的地方）
 *
 * 改造前每个 64KB chunk 要读 3 次 bufferedAmount、取 1 次时钟；
 * 4MB/s 下就是每秒 192 次跨边界调用。现在降到每秒 8 次。
 */

/** 每收到多少字节触发一次 tick */
const TICK_BYTES = 512 * 1024;

class Connection {
  // —— 归属 ——
  ipTag: string;
  node = "";
  host = "";              // 目标域名（按站点的节点画像用）
  mode: string;
  trial = false;
  via = "direct";

  // —— 热路径计数 ——
  down = 0;
  up = 0;
  mark = TICK_BYTES;      // 下一个 tick 的字节水位

  // —— 采样窗口 ——
  sampleAt = 0;
  sampleDown = 0;
  lastEmit = 0;

  // —— 生命周期 ——
  markedOk = false;
  markedFail = false;
  failed = false;         // 中途断流/异常（由 pipeBack 的 catch 置位），不算成功
  retried = false;
  pxTries = 0;
  triedV6 = false;
  counted = 0;

  // —— 上游 ——
  sock: any = null;
  writer: any = null;
  header: any = null;
  headerSent = false;

  // —— 结算 ——
  reportedUp = 0;
  reportedDown = 0;
  stallMs = 0;

  // —— 观测 ——
  tAttach = 0;            // 连上上游的时刻
  ttfb = 0;               // 首字节耗时（ms），按站点的画像就靠它
  directFail = false;     // 直连阶段 0 字节关闭过（用于"直连对照"）

  // —— 身份与上下文 ——
  t0 = Date.now();
  id: string | null = null;
  env: Env;
  ctx: ExecutionContext;

  constructor(env: Env, ctx: ExecutionContext, mode: string, ipTag: string) {
    this.env = env;
    this.ctx = ctx;
    this.mode = mode;
    this.ipTag = ipTag || "";
  }

  /** 上行字节（不做采样，只要计数） */
  onUp(n: number): void {
    this.up += n;
  }

  /**
   * 每 512 KB 触发一次。返回 false 表示连接应当中止。
   * @param ws 客户端连接
   */
  async tick(ws: WebSocketLike): Promise<boolean> {
    this.mark = this.down + TICK_BYTES;

    try {
      const now = Date.now();
      // 采样窗口：至少 800ms 才结算一次（tick 可能比这更密）
      const dt = now - this.sampleAt;
      if (this.sampleAt && dt >= 800 && now - this.lastEmit >= 15000) {
        const bytes = this.down - this.sampleDown;
        if (this.node && bytes >= 65536) {
          this.lastEmit = now;
          nsSpeed(this.node, (bytes * 1000) / dt, bytes, this.env);
          S.cnt.tput = (S.cnt.tput || 0) + 1;
        }
        this.sampleAt = now;
        this.sampleDown = this.down;
      } else if (!this.sampleAt) {
        this.sampleAt = now;
        this.sampleDown = this.down;
      }

      this.flush(false);
      return await this.backpressure(ws);
    } catch (e) {
      logErr("tick: " + ((e && e.message) || e), this.node || "");
      return true;   // 统计出错绝不影响数据面
    }
  }

  /** 客户端收不动时暂停读上游；超时或爆缓冲则主动断 */
  async backpressure(ws: WebSocketLike): Promise<boolean> {
    const buffered = ws.bufferedAmount || 0;
    if (buffered <= WS_BUFFER_LIMIT) return true;

    const t0 = Date.now();
    const deadline = t0 + WS_STALL_MS;
    while ((ws.bufferedAmount || 0) > WS_BUFFER_LIMIT) {
      if (ws.readyState !== WS_OPEN) {
        cnt("cut");
        closeQuietly(this.sock);
        return false;
      }
      if ((ws.bufferedAmount || 0) > WS_MAX_BUFFER || Date.now() > deadline) {
        cnt("stall");
        this.stallMs += Date.now() - t0;
        try { ws.close(1011, "stall"); } catch (e) {}
        closeQuietly(this.sock);
        return false;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    this.stallMs += Date.now() - t0;
    return true;
  }

  /** 把"尚未上报"的字节推给 PEND；closing=true 时补一个收尾样本 */
  flush(closing?: boolean): void {
    if (!this.id) return;

    // 收尾逻辑必须在"零字节"提前返回之前：
    // 鉴权成功但一个字节都没传的连接（探测、被客户端立刻取消）也要计入
    // node/direct 与种子刷新，否则计数和信誉表会漏掉这一整类连接。
    if (closing) {
      const now = Date.now();
      const dt = now - this.sampleAt;
      const bytes = this.down - this.sampleDown;
      if (this.node && this.sampleAt && dt >= 300 && bytes >= 32768 && now - this.lastEmit >= 5000) {
        nsSpeed(this.node, (bytes * 1000) / dt, bytes, this.env);
        S.cnt.tput = (S.cnt.tput || 0) + 1;
      }
      if (this.node && this.stallMs) {
        nsStall(this.node, this.stallMs, Math.max(1000, now - this.t0));
      }
      if (!this.counted) {
        this.counted = 1;
        cnt(this.node ? "node" : "direct");
        // 真实流量的"成功"样本：可用性(pFail/availOf)、面板成功率全靠它。
        // 早先只有失败才记账（nsFail），成功只走 SEL.resetFail()，而那里
        // 第一行就是 `if (!S.pxFailSeen) return` —— 健康节点永远 n=0，
        // 面板显示"一个连接都没有"，可用性门槛也永远不触发。
        if (this.node && !this.failed && this.down > 0) nsOk(this.node, 0, 0);
        // 按站点的节点画像：谁对这个站行、谁不行（诊断与站点级选路用）
        if (this.host) {
          if (this.node) {
            hostNodeMark(this.host, this.node, {
              ok: !this.failed && this.down > 0,
              bad: this.failed,
              bytes: this.down,
              ttfb: this.ttfb,
            });
            if (this.directFail) hostDirectMark(this.host, false);
          } else {
            hostDirectMark(this.host, !this.failed && this.down > 0);
          }
        }
        markSeedDirty(this.env);
      }
    }

    const du = this.up - this.reportedUp;
    const dd = this.down - this.reportedDown;
    if (du <= 0 && dd <= 0) return;

    const via = this.via === "node" || this.via === "v6" ? this.via : "direct";
    S.funnel[via] = (S.funnel[via] || 0) + du + dd;
    statBump(this.id, du, dd, false);
    this.reportedUp = this.up;
    this.reportedDown = this.down;
    scheduleFlush(this.env, S.pendBytes >= PEND_FLUSH_BYTES ? 0 : undefined);
  }

  /** 释放持有的 socket / 写锁 */
  release(): void {
    releaseAll(this);
  }
}
