/**
 * 「站点 × 中继」的实测性能记忆（只在本 isolate 内，不跨 isolate 共享）。
 *
 * 为什么要它：同一个中继对不同站点的表现可能差一个数量级 —— 出口在哪个地区、
 * 到目标之间经过哪些中转、目标是否同机房，都会让「能通」和「快」两件事分开。
 * 只看站点无关的中继健康度（RelayHealth）会把「对 A 站很快、对 B 站很慢」的中继
 * 平均成一个中位数，选路就没法按站点选对。
 *
 * 数据从真实连接来（`Connection.flush` 里的首字节耗时与下行速率），用 EWMA 收敛；
 * 条目 10 分钟不用就失效（链路质量会变，旧样本没意义）。两张表都有上限，
 * 满了先清过期、再按最旧淘汰 —— 这条规则本身由 `BoundedMap` 统一提供（7.251）。
 */
import { Mode } from "../core/enums";
import { BoundedMap } from "../core/table";
import type { DurationMs, EpochMs, KiloBytesPerSec, RelayIp, SampleCount } from "../core/types";

/** 一条样本多久不用就失效 */
export const REL_SAMPLE_TTL: DurationMs = 600_000;

/** 单条「站点 × 中继」样本 */
export interface RelSample {
  /** 样本条数（EWMA 的有效权重，最多按 8 算） */
  samples: SampleCount;
  /** 首字节耗时（毫秒） */
  firstByteMs: DurationMs;
  /** 下行速率（KB/s）；`<= 0` 表示这次只量到首字节、没量到吞吐 */
  kiloBytesPerSec: KiloBytesPerSec;
  /** 最后一次更新的时刻 */
  updatedAt: EpochMs;
}

/** `snap()` 输出的行（诊断端点的 JSON 形状） */
export interface RelRow {
  /** 中继出口地址 */
  relayIp: RelayIp;
  /** 样本条数 */
  samples: SampleCount;
  /** 首字节耗时（毫秒，已取整） */
  firstByteMs: DurationMs;
  /** 下行速率（KB/s，已取整） */
  kiloBytesPerSec: KiloBytesPerSec;
  /** 距最后一次更新过了多久（毫秒） */
  ageMs: DurationMs;
  /** 折算后的排序代价（毫秒） */
  costMs: DurationMs;
}

/** 站点无关的聚合表最多保留多少条（键是中继 IP，池子轮换会一直产生新 IP） */
const BY_MAX = 256;

/** 表内最多保留多少条「站点 × 中继」 */
const MAX = 512;

/**
 * 把样本折算成「512KB 需要多久」的预计耗时，用于排序。
 * @param sample 样本（null 表示没量过）
 * @returns 毫秒；没量过返回 1e6（永远排最后，由上层决定要不要试）
 */
export function relCostOf(sample: RelSample | null): number {
  if (!sample) return 1e6;
  // kiloBytesPerSec <= 0 表示「这次只量到首字节，没量到吞吐」（小响应 / 4 字节 403 页 / 连接被掐断）：
  // 不能按小带宽重罚——一个 45KB 的正常首页在 2.5 秒里只有 ~18KB/s，
  // 按 1024KB 折算会得 5.7 万毫秒，比「4 字节 403 页」还贵，排序就会把能用的中继排到最后。
  // 这种样本只给首字节 + 一个固定惩罚，真正的失败信号由负面记忆（JUDGE.negOn）负责。
  if (sample.kiloBytesPerSec <= 0) return sample.firstByteMs + 2000;
  // 512 KB / (KB/s) 换成 ms，再加首字节；速率下限 32 防止除零与「0.1 KB/s 的假样本」爆表
  return sample.firstByteMs + 512_000 / Math.max(32, sample.kiloBytesPerSec);
}

/**
 * 按模式折算代价：吞吐模式看「拉 512KB 要多久」，延迟模式只看首字节。
 * 为什么分开：同一对（站点, 中继）可能「首字节很快但带宽很小」，反过来也有；
 * 用同一个代价函数会让延迟优先模式被大文件吞吐的样本带偏，吞吐优先模式又会忽略首字节。
 * @param modeToken 传输模式（`tput` / `lat`，与 `Mode` 枚举同值）
 * @param sample 样本（null 表示没量过）
 * @returns 毫秒；没量过返回 1e6
 */
export function relCostFor(modeToken: string, sample: RelSample | null): number {
  if (!sample) return 1e6;
  if (modeToken === Mode.Latency) return sample.firstByteMs;
  if (sample.kiloBytesPerSec <= 0) return sample.firstByteMs + 2000;
  return sample.firstByteMs + 512_000 / Math.max(32, sample.kiloBytesPerSec);
}

/**
 * 站点 × 中继的实测性能表。
 */
export class RelPerfTable {
  /** 站点 × 中继的样本（键 `站点|中继`） */
  private rows = new BoundedMap<string, RelSample>({ max: MAX, ttlMs: REL_SAMPLE_TTL, timeOf: (row) => row.updatedAt });
  /** 站点无关的聚合样本（同一条中继在所有站点上的表现），用来在新站点上先给个底 */
  private byRelay = new BoundedMap<string, RelSample>({ max: BY_MAX, ttlMs: REL_SAMPLE_TTL, timeOf: (row) => row.updatedAt });

  /**
   * 记一条样本。
   * @param host 站点（`Connection.host`）
   * @param relayIp 中继出口地址
   * @param firstByteMs 首字节耗时（毫秒）
   * @param kiloBytesPerSec 下行速率（KB/s，0 表示这次没量到）
   * @param now 当前时刻（测试可注入）
   * @returns 无
   */
  note(host: string, relayIp: RelayIp, firstByteMs: DurationMs, kiloBytesPerSec: KiloBytesPerSec, now: EpochMs = Date.now()): void {
    if (!host || !relayIp) return;
    if (!(firstByteMs >= 0) || !(kiloBytesPerSec >= 0)) return;
    const key = host + "|" + relayIp;
    const previous = this.rows.get(key);
    if (!previous || now - previous.updatedAt > REL_SAMPLE_TTL) {
      this.rows.set(key, { samples: 1, firstByteMs, kiloBytesPerSec, updatedAt: now });
    } else {
      // EWMA：首字节 0.5 权重（抖动大），速率 0.35（变化慢但也要跟得上）
      this.rows.set(key, {
        samples: Math.min(8, previous.samples + 1),
        firstByteMs: previous.firstByteMs * 0.5 + firstByteMs * 0.5,
        kiloBytesPerSec: this.mixRate(previous.kiloBytesPerSec, kiloBytesPerSec),
        updatedAt: now,
      });
    }
    // 站点无关的聚合：新站点第一次命中时才有底可用（见 costFor 的说明）
    const aggregate = this.byRelay.get(relayIp);
    if (!aggregate || now - aggregate.updatedAt > REL_SAMPLE_TTL) {
      this.byRelay.set(relayIp, { samples: 1, firstByteMs, kiloBytesPerSec, updatedAt: now });
    } else {
      this.byRelay.set(relayIp, {
        samples: Math.min(8, aggregate.samples + 1),
        firstByteMs: aggregate.firstByteMs * 0.5 + firstByteMs * 0.5,
        kiloBytesPerSec: this.mixRate(aggregate.kiloBytesPerSec, kiloBytesPerSec),
        updatedAt: now,
      });
    }
    // 上限必须在插入**之后**判断（BoundedMap.prune 的文档里写了原因），
    // 而且一次收下 1/8 的低水位，把「每条样本排一遍整表」摊薄成「每 64 条一次」。
    this.rows.prune(now);
    this.byRelay.prune(now);
  }

  /**
   * 功能：把一次吞吐样本并进 EWMA，但把「没量到吞吐」当成没有证据而不是 0。
   * @param previousRate 表里已有的速率（KB/s，`<= 0` 表示还没量到过）
   * @param measuredRate 这次的速率（KB/s，`<= 0` 表示这次没量到：小响应 / 只量到首字节）
   * @returns 合并后的速率（KB/s，可能仍是 0）
   */
  private mixRate(previousRate: KiloBytesPerSec, measuredRate: KiloBytesPerSec): KiloBytesPerSec {
    // `Connection` 只在真正传了 ≥1MB 时才给出速率，其余一律记 0（见 connection.ts 的注释）。
    // 如果把 0 当测量值参与加权，一次大下载之后每来一个普通页面就会把速率往下拽：
    // 800 → 520 → 338 → 220（三次小响应）→ 8 次之后贴着 32KB/s 的下限，
    // 代价从「首字节+640」变成「首字节+16000」，吞吐模式的吞吐维度就被静默关掉了。
    if (measuredRate <= 0) return previousRate;
    // 反过来，第一次量到吞吐时也不能拿旧的 0 去稀释（0.35 权重会让 800 变成 280）
    if (previousRate <= 0) return measuredRate;
    return previousRate * 0.65 + measuredRate * 0.35;
  }

  /**
   * 取某站点在某中继上的样本。
   * @param host 站点
   * @param relayIp 中继出口
   * @param now 当前时刻
   * @returns 样本；没有或已过期返回 null
   */
  get(host: string, relayIp: RelayIp, now: EpochMs = Date.now()): RelSample | null {
    const key = host + "|" + relayIp;
    const sample = this.rows.get(key);
    if (!sample) return null;
    if (now - sample.updatedAt > REL_SAMPLE_TTL) {
      this.rows.delete(key);
      return null;
    }
    return sample;
  }

  /**
   * 站点无关的该中继聚合样本（任何站点上量到的都算）。
   * @param relayIp 中继出口
   * @param now 当前时刻
   * @returns 样本；没有或已过期返回 null
   */
  agg(relayIp: RelayIp, now: EpochMs = Date.now()): RelSample | null {
    const sample = this.byRelay.get(relayIp);
    if (!sample) return null;
    if (now - sample.updatedAt > REL_SAMPLE_TTL) {
      this.byRelay.delete(relayIp);
      return null;
    }
    return sample;
  }

  /**
   * 排序代价：没有样本一律 1e6。只认本站点样本（测试与调试用，口径干净）。
   * @param host 站点
   * @param relayIp 中继出口
   * @param now 当前时刻
   * @returns 预计 512KB 耗时（毫秒）
   */
  cost(host: string, relayIp: RelayIp, now: EpochMs = Date.now()): number {
    return relCostOf(this.get(host, relayIp, now));
  }

  /**
   * 按传输模式取排序代价。
   * @param modeToken 传输模式（`tput` / `lat`）
   * @param host 站点
   * @param relayIp 中继出口
   * @param now 当前时刻
   * @returns 毫秒；没量过返回 1e6
   */
  costFor(modeToken: string, host: string, relayIp: RelayIp, now: EpochMs = Date.now()): number {
    const sample = this.get(host, relayIp, now);
    if (sample) return relCostFor(modeToken, sample);
    // 本站点还没量过这条中继：用它在别的站点上的表现兜底（+200ms 表示「不是本站点的亲测」）。
    // 为什么要兜底：新站点第一次命中时，若所有中继都是 1e6，排序退化成「按池子顺序」，
    // 等于把已经量到的快中继扔掉重学一遍；而中继出口的容量大体与目标站点无关。
    const aggregate = this.agg(relayIp, now);
    if (aggregate) return relCostFor(modeToken, aggregate) + 200;
    return 1e6;
  }

  /**
   * 调试快照：按代价升序列出该站点已经量过的中继。
   * @param host 站点
   * @param now 当前时刻
   * @returns 行数组（中继地址 / 样本数 / 首字节 / 速率 / 年龄 / 代价）
   */
  snap(host: string, now: EpochMs = Date.now()): RelRow[] {
    const out: RelRow[] = [];
    for (const [key, sample] of this.rows) {
      if (!key.startsWith(host + "|")) continue;
      if (now - sample.updatedAt > REL_SAMPLE_TTL) continue;
      out.push({
        relayIp: key.slice(host.length + 1),
        samples: sample.samples,
        firstByteMs: Math.round(sample.firstByteMs),
        kiloBytesPerSec: Math.round(sample.kiloBytesPerSec),
        ageMs: now - sample.updatedAt,
        costMs: Math.round(relCostOf(sample)),
      });
    }
    out.sort((left, right) => left.costMs - right.costMs);
    return out;
  }

  /**
   * 清空（测试用）。
   * @returns 无
   */
  clear(): void {
    this.rows.clear();
    this.byRelay.clear();
  }

  /**
   * 当前表规模（测试与面板用）。
   * @returns 站点×中继的条数与聚合表的条数
   */
  size(): { rows: number; byRelay: number } {
    return { rows: this.rows.size, byRelay: this.byRelay.size };
  }
}

/** 全局唯一实例（服务 route 层） */
export const RELPERF = new RelPerfTable();

/**
 * 薄包装：记样本（`src/proxy/connection.ts` 通过 HOOK.relPerf 调到）。
 * @param host 站点
 * @param relayIp 中继出口
 * @param firstByteMs 首字节耗时（毫秒）
 * @param kiloBytesPerSec 下行速率（KB/s）
 * @returns 无
 */
export function relNote(host: string, relayIp: RelayIp, firstByteMs: DurationMs, kiloBytesPerSec: KiloBytesPerSec): void {
  RELPERF.note(host, relayIp, firstByteMs, kiloBytesPerSec);
}
