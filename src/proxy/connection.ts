import { SC } from "../core/const";
import { HOOK } from "../core/hook";
import type { Socket } from "cloudflare:sockets";
import { errMsg } from "../core/util";
import { hostDirectMark, hostNodeMark, logErr } from "../nodes/metrics";
import { cnt } from "../core/counter";
import { FO } from "../core/firstobs";
import { nsLatency, nsOk, nsSpeed, nsStall } from "../nodes/score";
import { markSeedDirty } from "../px/seed";
import { S } from "../core/state";
import { PEND_FLUSH_BYTES, scheduleFlush, statBump } from "../store/index";
import { WS_BUFFER_LIMIT, WS_MAX_BUFFER, WS_OPEN, WS_STALL_MS, closeQuietly, releaseAll } from "../core/util";

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
export const TICK_BYTES = 512 * 1024;

export class Connection {
  // —— 归属 ——
  ipTag: string;
  node = "";
  host = ""; // 目标域名（按站点的节点画像用）
  mode: Mode;
  trial = false;
  via = "direct";
  udp = false; // 首包已判定为 UDP/53：后续帧直接当 DNS 报文
  udpTrojan = false; // Trojan UDP 的后续帧带 [ATYP][ADDR][PORT] 前缀
  dead = false; // 已经明确失败并关闭：后续帧不要再解析

  // —— 热路径计数 ——
  down = 0;
  up = 0;
  mark = TICK_BYTES; // 下一个 tick 的字节水位

  // —— 采样窗口 ——
  sampleAt = 0;
  sampleDown = 0;
  lastEmit = 0;
  sampleW = 0; // 本连接已贡献给直方图的权重（上限 SC.CONN_W_CAP）
  inflightKey = ""; // 已经计入在途的节点（变更时迁移）
  stallMark = 0; // 上次采样时的累计背压毫秒（算窗口 stall 占比）
  siteAt = 0; // 站点吞吐：上一次采样时刻
  siteDown = 0; // 站点吞吐：上一次采样时的下行字节
  siteEmitted = 0; // 已写过几次站点级 bps（写过就别再用"一生平均"覆盖）

  // —— 生命周期 ——
  markedOk = false;
  markedFail = false;
  failed = false; // 中途断流/异常（由 pipeBack 的 catch 置位），不算成功
  siteFail = false; // 失败归因：连上了节点但目标侧拒绝（只轻记全局）
  hostTrial = false; // 站点级试探：失败只记账，不动全局游标/不冻结
  retried = false;
  pxTries = 0;
  triedV6 = false;
  counted = 0;

  // —— 上游 ——
  sock: Socket | null = null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  header: Uint8Array | null = null;
  headerSent = false;

  // —— 结算 ——
  reportedUp = 0;
  reportedDown = 0;
  stallMs = 0;

  // —— 观测 ——
  tAttach = 0; // 连上上游的时刻
  ttfb = 0; // 首字节耗时（ms），按站点的画像就靠它
  sz = 0;
  /** 目标站点是否托管在 CF 上（决定中继只能用非 CF 出口） */
  cf = false; // 目标流量（字节，0 = 按模式默认）：决定"传完一个请求"要算多少流量
  /** 调试用：`?rx=<ip>` 强制这一条连接走指定中继（只给诊断脚本用，正常流量留空） */
  rx = "";
  directFail = false; // 直连阶段 0 字节关闭过（用于"直连对照"）

  // —— 身份与上下文 ——
  t0 = Date.now();
  id: string | null = null;
  env: Env;
  ctx: ExecutionContext;

  constructor(env: Env, ctx: ExecutionContext, mode: Mode, ipTag: string) {
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
      // 采样窗口：至少 800ms 才结算一次（tick 可能比这更密）。
      // 两次结算的间隔从 15 秒降到 5 秒：一次十几秒的大文件下载原来只够结算一个样本，
      // 带宽估计长期停在中继先验上，tput 模式分不出「这条中继有 2MB/s」还是「只有 200KB/s」。
      const dt = now - this.sampleAt;
      if (this.sampleAt && dt >= 800 && now - this.lastEmit >= 5000) {
        const bytes = this.down - this.sampleDown;
        if (this.node && bytes >= 65536) {
          let w = this.takeWeight(bytes, dt);
          // 窗口里一半以上时间在背压 = 瓶颈在客户端，这个样本不代表节点能力
          const stallWin = this.stallMs - this.stallMark;
          if (stallWin > dt * 0.5) w *= 0.3;
          if (w > 0) {
            this.lastEmit = now;
            nsSpeed(this.node, (bytes * 1000) / dt, bytes, this.env, w);
            S.cnt.tput = (S.cnt.tput || 0) + 1;
          }
        }
        this.sampleAt = now;
        this.sampleDown = this.down;
        this.stallMark = this.stallMs;
      }
      // 站点级吞吐：长连接（看视频）每 60 秒补一个窗口，别等连接结束
      if (this.node && this.host) {
        if (!this.siteAt) {
          this.siteAt = now;
          this.siteDown = this.down;
        } else if (now - this.siteAt >= 60000) {
          const sb = this.down - this.siteDown;
          const sdt = now - this.siteAt;
          if (sb >= 262144) {
            hostNodeMark(this.host, this.node, { bps: Math.round((sb * 1000) / sdt), bytes: sb });
            this.siteEmitted++;
          }
          this.siteAt = now;
          this.siteDown = this.down;
        }
      }
      if (!this.sampleAt) {
        this.sampleAt = now;
        this.sampleDown = this.down;
        this.stallMark = this.stallMs;
      }

      this.flush(false);
      return await this.backpressure(ws);
    } catch (e) {
      logErr("tick: " + errMsg(e), this.node || "");
      return true; // 统计出错绝不影响数据面
    }
  }

  /** 客户端收不动时暂停读上游；超时或爆缓冲则主动断 */
  async backpressure(ws: WebSocketLike): Promise<boolean> {
    const buffered = ws.bufferedAmount || 0;
    if (buffered <= WS_BUFFER_LIMIT) return true;

    const t0 = Date.now();
    // 超限之后不立刻断：客户端可能只是瞬时抖动，给它 60 秒的恢复窗口
    const deadline = t0 + WS_STALL_MS;
    // 每 10ms 看一次：ws 关了说明客户端彻底走了（cut）；
    // 缓冲涨到 16MB 上限或等满 60 秒则判定真卡死（stall）——两种情况都主动断，别让一个连接拖住整个 isolate
    while ((ws.bufferedAmount || 0) > WS_BUFFER_LIMIT) {
      if (ws.readyState !== WS_OPEN) {
        cnt("cut");
        closeQuietly(this.sock);
        return false;
      }
      if ((ws.bufferedAmount || 0) > WS_MAX_BUFFER || Date.now() > deadline) {
        cnt("stall");
        this.stallMs += Date.now() - t0;
        try {
          ws.close(1011, "stall");
        } catch (e) {}
        closeQuietly(this.sock);
        return false;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    this.stallMs += Date.now() - t0;
    return true;
  }

  /** 把"在途连接数"对齐到当前节点（切换节点时会迁移） */
  syncInflight(): void {
    const k = this.node;
    if (k === this.inflightKey) return;
    if (this.inflightKey) {
      const n = (S.inflight.get(this.inflightKey) || 1) - 1;
      if (n > 0) S.inflight.set(this.inflightKey, n);
      else S.inflight.delete(this.inflightKey);
    }
    this.inflightKey = k || "";
    if (k) S.inflight.set(k, (S.inflight.get(k) || 0) + 1);
  }

  /**
   * 功能：连接结束时把该目标的 inflight 计数减一（并发场景用于观测并发度）。
   * @returns 无
   */
  clearInflight(): void {
    if (!this.inflightKey) return;
    const n = (S.inflight.get(this.inflightKey) || 1) - 1;
    if (n > 0) S.inflight.set(this.inflightKey, n);
    else S.inflight.delete(this.inflightKey);
    this.inflightKey = "";
  }

  /**
   * 本次窗口应贡献多少直方图权重。
   * 512KB / 1s 是"一个标准样本"；短窗口或小样本按比例降权，单连接累计封顶。
   */
  takeWeight(bytes: number, dt: number): number {
    const room = SC.CONN_W_CAP - this.sampleW;
    if (room <= 0) return 0;
    const w = Math.min(1, bytes / (512 * 1024)) * Math.min(1, dt / 1000);
    const use = Math.min(room, w);
    this.sampleW += use;
    return use;
  }

  /** 把"尚未上报"的字节推给 PEND；closing=true 时补一个收尾样本 */
  flush(closing?: boolean): void {
    if (closing) this.clearInflight();
    if (!this.id) return;

    // 收尾逻辑必须在"零字节"提前返回之前：
    // 鉴权成功但一个字节都没传的连接（探测、被客户端立刻取消）也要计入
    // node/direct 与种子刷新，否则计数和信誉表会漏掉这一整类连接。
    if (closing) {
      const now = Date.now();
      const dt = now - this.sampleAt;
      const bytes = this.down - this.sampleDown;
      // 快速节点（10MB 在 300ms 内传完，>33MB/s）以前永远进不了直方图：
      // dt>=300ms 的闸门把它们全挡了，e10 只能停在 51 秒先验上。
      // 字节够多（≥1MB）时不再要求 300ms —— 1MB 已经过了慢启动。
      if (
        this.node &&
        this.sampleAt &&
        dt >= 50 &&
        (dt >= 300 || bytes >= 1048576) &&
        bytes >= 32768 &&
        now - this.lastEmit >= 5000
      ) {
        let w = this.takeWeight(bytes, dt);
        const stallWin = this.stallMs - this.stallMark;
        if (stallWin > dt * 0.5) w *= 0.3;
        if (w > 0) {
          nsSpeed(this.node, (bytes * 1000) / dt, bytes, this.env, w);
          S.cnt.tput = (S.cnt.tput || 0) + 1;
        }
      }
      // 分母必须是"所有连接的总时长"：pStall = (stallMs + 50) / (runMs + 1000)。
      // 原来只在"这条连接卡过"时才累加 runMs，等于把分母缩成"卡过的那几条连接的时长"：
      // 一条 5 秒连接卡 2 秒 → pStall 0.34（真实占比 0.001），单次卡顿白送 800+ ms 分，
      // 还会踩中 pStall>0.25 的 +400 重罚档，节点一晚上翻不了身。
      if (this.node) {
        nsStall(this.node, this.stallMs, Math.max(1000, now - this.t0));
      }
      // 连接观测按节点聚合（n/ok/p50/p95）：40 条原始记录只能盖住 40 个节点，
      // 聚合后同样载重能覆盖全池（2000 个节点也就 400 条聚合记录）。
      if (this.node || this.host) {
        const ck = this.node || "direct";
        let g = S.cagg.get(ck);
        if (!g) {
          g = { n: 0, ok: 0, dn: 0, v: [] };
          if (S.cagg.size >= 400) {
            let worst = "";
            let wn = Infinity;
            for (const [k2, g2] of S.cagg) if (g2.n < wn) { wn = g2.n; worst = k2; }
            if (worst) S.cagg.delete(worst);
          }
          S.cagg.set(ck, g);
        }
        g.n += 1;
        if (!this.failed) g.ok += 1;
        g.dn += this.down;
        const ms = Math.round(this.ttfb);
        if (ms > 0) {
          g.v.push(ms);
          if (g.v.length > 64) g.v.shift();
        }
      }
      if (!this.counted) {
        this.counted = 1;
        cnt(this.node ? "node" : "direct");
        // 前 3 条用户连接的质量：低流量客户端几乎每条请求都落冷 isolate，这是唯一能看到的「第一眼」
        FO.note(this.down);
        // 真实流量的"成功"样本：可用性(pFail/availOf)、面板成功率全靠它。
        // 早先只有失败才记账（nsFail），成功只走 SEL.resetFail()，而那里
        // 第一行就是 `if (!S.pxFailSeen) return` —— 健康节点永远 n=0，
        // 面板显示"一个连接都没有"，可用性门槛也永远不触发。
        if (this.node && !this.failed && this.down > 0) nsOk(this.node, 0, 0);
        // 「站点 × 中继」实测：同一中继对不同站点快慢可能差一个数量级（出口地区/中转路径不同），
        // 记下这次的首字节与下行速率，供决策层按站点挑中继；只在本 isolate 内，不跨 isolate 共享。
        if (this.node && this.host && this.down > 0) {
          const ms = Math.max(1, Date.now() - this.tAttach);
          const ip = this.node.includes(":") ? this.node.slice(0, this.node.lastIndexOf(":")) : this.node;
          const t0 = this.ttfb > 0 ? this.ttfb : ms;
          // 吞吐只在「真的传了一大段」时才有意义：45KB 的正常首页在 2.5 秒里只有 18KB/s，
          // 而 4 字节的 403 页在 80 毫秒里也有 46KB/s —— 小样本算出来的速率会反向排序。
          // 1MB 以上才算「过了慢启动」；其余样本 kbs 记 0（只保留首字节），由代价函数特殊处理。
          const xfer = Math.max(1, ms - t0);
          const kbs = this.down >= 1048576 ? (this.down / 1024) * 1000 / xfer : 0;
HOOK.relPerf?.(this.host, ip, t0, kbs);
          // 「站点 × 中继」成功率（v8 §5 的 ps）：拿到完整响应（>64B）才算过。
          // 64B 这条线来自实测：旧的「4 字节 IPv6 拒绝页」已变成 737B HTML（§19.2），
          // 所以不能只排除 4 字节；而正常页面哪怕再小也有几百字节（example.com 932B）。
          HOOK.psNote?.(this.host, ip, this.down > 64 && !this.failed);
        }
      // 通道证据：交给决策层（弱证据只可能把 unknown 提成 ok；判死只有 probe 能下）
      if (this.host && HOOK.traffic) {
        HOOK.traffic({ cf: this.cf, host: this.host, via: this.via as "node" | "direct" | "v6", node: this.node || "", down: this.down, ok: !this.failed && this.down > 0, life: Date.now() - this.t0, up: this.up });
      const vf = HOOK.verify;
      if (vf && S.vtQ.length && SC.PROBE_REQ > 0) this.ctx.waitUntil(vf().catch(() => 0));
      }
      // 真实首字节回流：探活只能证明连得上，转发快不快只有这条路径知道
      if (this.node && this.ttfb > 0) nsLatency(this.node, this.ttfb);
        if (this.host) {
          if (this.node) {
            const life = this.tAttach ? Math.max(1, Date.now() - this.tAttach) : 0;
            const siteBps =
              !this.siteEmitted && life > 500 && this.down >= 512 * 1024 ? Math.round((this.down * 1000) / life) : 0;
            hostNodeMark(this.host, this.node, {
              ok: !this.failed && this.down > 0 ? 1 : 0,
              bad: this.failed ? 1 : 0,
              bytes: this.down,
              ttfb: this.ttfb,
              bps: siteBps,
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

