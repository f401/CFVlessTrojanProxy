import { connect } from "cloudflare:sockets";
import { Client } from "tunnelfetch";
import { splitRelay } from "./http80";
import { withTimeout } from "./util";

// ---- 并入自 transport-types.ts ----
// 探测传输的契约：诊断路径要的是「给一个目标（可选中继），发一次请求并回报结果」，
// 而不关心底下用的是 userland TLS、运行时自带 fetch，还是将来某个别的库。
//
// 7.309 之前这些类型单独占一个 `transport-types.ts`，理由是「实现文件与注册表互相需要，
// 分开可以避免循环 import」。合回一个文件后发现那个理由不成立：两个实现与注册表现在同住
// 本文件，import 关系只剩 `transport → http80/util`（外加两个外部依赖），没有任何环。
/** 一次探测成功时的结果：只留诊断需要看的几项，不把完整响应体带出去 */
export interface TransportProbe {
  /** HTTP 状态码 */
  status: number;
  /** 响应头里的 `server`（CF 的托管站点会暴露这一项） */
  server: string;
  /** 响应体字节数 */
  bytes: number;
  /** 响应体开头 64 字节的可打印形式（用来一眼认出「4 字节 IPv6」这种封锁页） */
  head: string;
  /** 从建连到读完这段的总耗时 */
  ms: number;
}

/** 一次探测的结果：成功带 `probe`，失败带 `err`，两者都带 `ms` */
export type TransportOutcome = ({ ok: true } & TransportProbe) | { ok: false; err: string; ms: number };

/** 探测传输的契约：一个实现只负责「怎么把请求送到目标」 */
export interface ProbeTransport {
  /** 传输名，注册表用它索引，诊断端点也用它告诉调用方当前是谁 */
  readonly transportName: string;
  /** 能否把 TCP 落到指定中继上；直连型实现为 false（调用方据此判断「这条结论能不能代表中继」） */
  readonly relayAware: boolean;
  /**
   * 功能：对目标发一次请求。
   * @param host 目标主机名（会用于 SNI 与 Host 头）
   * @param relay 中继 `host:port`；空串表示直连
   * @param path 请求路径
   * @param timeoutMs 整段预算（含建连、请求、读体）
   * @returns 探测结果（从不 reject：失败包成 `{ ok: false, err }`，诊断路径不该抛异常）
   */
  probe(host: string, relay: string, path: string, timeoutMs: number): Promise<TransportOutcome>;
}

// ---- 并入自 transport-tunnelfetch.ts ----
/**
 * 功能：用 `tunnelfetch`（userland TLS 1.3）做探测，能把 TCP 落到指定中继上。
 *
 * 为什么这个实现值钱：Worker 自己发 HTTPS 请求时用的是运行时出口，看得到的只是「运行时能不能
 * 到目标」，看不到「某条中继能不能到目标」；只有把 TCP 落到中继上、在用户态自己跑 TLS，
 * 才能拿到那条腿的真实状态码。代价是它必须被包在超时里（卡住时不会自己回来）。
 */
export class TunnelFetchTransport implements ProbeTransport {
  /** 注册表索引名 */
  readonly transportName = "tunnelfetch";
  /** 能落到中继上 —— 这是唯一能回答「这条中继到目标行不行」的实现 */
  readonly relayAware = true;

  /**
   * 功能：对目标发一次请求（中继为空则直连），整段包在超时里。
   * @param host 目标主机名
   * @param relay 中继 `host:port`；空串表示直连
   * @param path 请求路径
   * @param timeoutMs 整段预算
   * @returns 探测结果
   */
  async probe(host: string, relay: string, path: string, timeoutMs: number): Promise<TransportOutcome> {
    const startedAt = Date.now();
    // 拆 `host:port` 必须走 splitRelay：IPv6 字面量自带冒号，`lastIndexOf(":")` 会把
    // `2a06:98c0::1:443` 拆成 host=`2a06`、port=`98c0`（7.180 在 http80 修过同一处）
    const [relayHost, relayPort] = relay ? splitRelay(relay, 443) : ["", 443];
    const dial = relay ? () => connect({ hostname: relayHost, port: relayPort }) : undefined;
    const client = new Client({ connect: dial } as unknown as ConstructorParameters<typeof Client>[0]);
    // 抓「请求 + 读体」这整段：只给 fetch 加超时，读体阶段照样能挂住
    let work: Promise<{ status: number; server: string; body: ArrayBuffer }> | null = null;
    try {
      work = (async () => {
        const response = await client.fetch(`https://${host}${path}`, { redirect: "manual" });
        const body = await response.arrayBuffer();
        return { status: response.status, server: response.headers.get("server") || "", body };
      })();
      const { status, server, body } = await withTimeout(work, timeoutMs, "tf timeout");
      const head = new TextDecoder().decode(new Uint8Array(body).slice(0, 64)).replace(/\s+/g, " ");
      return { ok: true, status, server, bytes: body.byteLength, head, ms: Date.now() - startedAt };
    } catch (e) {
      // 超时之后那一半还在跑：不让它变成 unhandled rejection（1101 的老坑）
      if (work) void work.catch(() => {});
      return { ok: false, err: String(e).slice(0, 220), ms: Date.now() - startedAt };
    } finally {
      // 关闭也要吞异常：连接可能已经被超时那一半关掉了
      try {
        await client.close();
      } catch (e) {
        /* 已关闭 */
      }
    }
  }
}

/**
 * 功能：用运行时自带的 `fetch` 做探测 —— 只能直连，用来看「运行时出口 到目标」这一条腿。
 *
 * 为什么保留它：`tunnelfetch` 只回答「中继到目标」，而排障时经常需要同一个目标的直连对照。
 * 两条腿并排看，才能分清「目标拒绝了这个出口族」与「这条中继不可用」。
 */
export class GatewayFetchTransport implements ProbeTransport {
  /** 注册表索引名 */
  readonly transportName = "gateway";
  /** 运行时 fetch 不接受自定义 dial，落不到中继上 */
  readonly relayAware = false;

  /**
   * 功能：对目标发一次直连请求（忽略 `relay`，并在结果里如实标记）。
   * @param host 目标主机名
   * @param relay 中继（本实现会忽略它）
   * @param path 请求路径
   * @param timeoutMs 整段预算
   * @returns 探测结果
   */
  async probe(host: string, relay: string, path: string, timeoutMs: number): Promise<TransportOutcome> {
    const startedAt = Date.now();
    // 不静默忽略：中继传进来了却用不了，必须让调用方看得出这条结论代表的是直连
    if (relay) return { ok: false, err: "gateway transport cannot dial a relay", ms: Date.now() - startedAt };
    let work: Promise<{ status: number; server: string; body: ArrayBuffer }> | null = null;
    try {
      work = (async () => {
        const response = await fetch(`https://${host}${path}`, { redirect: "manual" });
        const body = await response.arrayBuffer();
        return { status: response.status, server: response.headers.get("server") || "", body };
      })();
      const { status, server, body } = await withTimeout(work, timeoutMs, "tf timeout");
      const head = new TextDecoder().decode(new Uint8Array(body).slice(0, 64)).replace(/\s+/g, " ");
      return { ok: true, status, server, bytes: body.byteLength, head, ms: Date.now() - startedAt };
    } catch (e) {
      if (work) void work.catch(() => {});
      return { ok: false, err: String(e).slice(0, 220), ms: Date.now() - startedAt };
    }
  }
}

// ---- 并入自 tf.ts ----
/** 一次探测的总预算：userland TLS 走中继，卡住的那一刻不会自己回来。
 * 不设上限时，DO 里那个请求会一直挂着 —— 探测是诊断路径，绝不能拖住计量端点。 */
const PROBE_BUDGET_MS = 8000;

/**
 * 功能：探测「目标（可选中继）能不能拿到响应」，实现由 `TRANSPORTS` 决定。
 *
 * 这里只留一层门面：具体怎么送（userland TLS 落中继 / 运行时自带 fetch 直连）在
 * `src/core/transport-tunnelfetch.ts` 的两个实现里，注册表在 `src/core/transport.ts`。
 * 这样加一个新的探测方式不需要改调用点，也不需要在这个文件里塞分支。
 *
 * @param host 目标主机名
 * @param relay 中继 `host:port`（空串表示直连）
 * @param path 请求路径
 * @param transportName 可选：指定用哪个传输（默认取注册表当前的；拼错则回落到默认）
 * @returns 结果（ok/status/server/bytes/head/ms 或 ok:false/err/ms）
 */
export async function probeTf(
  host: string,
  relay = "",
  path = "/",
  transportName?: string,
): Promise<TransportOutcome> {
  // 传输选择放在门面里做：调用点只关心「探测这件事」，不关心谁去送
  const transport = TRANSPORTS.get(transportName);
  return transport.probe(host, relay, path, PROBE_BUDGET_MS);
}

// ---- 门面（对外导出面保持不变） ----
/**
 * 功能：按名字保存「探测传输」的实例，让诊断路径可以换实现而不改调用点。
 *
 * 为什么要有这一层：`probeTf` 原先直接 `new Client(...)`，把 tunnelfetch 写死在调用点上 ——
 * 想加一个「运行时自带 fetch 只做直连对照」的实现，就得在业务函数里塞分支。现在业务侧只说
 * 「要一个能探测的传输」，具体是谁由这张表决定（依赖注入，实现各自独立成类）。
 */
export class TransportRegistry {
  /** 已注册的传输：名字 → 实例（实例可复用，没必要每轮新建） */
  private readonly byId = new Map<string, ProbeTransport>();
  /** 当前使用的传输名；`use()` 改了它，`get()` 不带名字时就取这个 */
  private currentName: string;

  /**
   * 功能：建注册表并预置实现。
   * @param defaultName 默认传输名（必须出现在 entries 里，否则取用时抛错而不是静默降级）
   * @param entries 名字与实例的清单
   */
  constructor(defaultName: string, entries: Array<[string, ProbeTransport]>) {
    // 默认名先落位，再灌实现：构造完就该是自洽的，不留「表空但 current 指向空」的窗口
    this.currentName = defaultName;
    for (const [name, transport] of entries) this.byId.set(name, transport);
  }

  /**
   * 功能：列出已注册的传输名（诊断端点用它告诉调用方「能选哪些」）。
   * @returns 名字数组，按注册顺序
   */
  names(): string[] {
    return [...this.byId.keys()];
  }

  /**
   * 功能：读当前传输名。
   * @returns 名字
   */
  current(): string {
    return this.currentName;
  }

  /**
   * 功能：切换当前传输。
   * @param name 目标名字
   * @returns 切换成功与否（名字不存在时保持原状：诊断端点不该被一个拼错的查询参数打成 500）
   */
  use(name: string): boolean {
    if (!this.byId.has(name)) return false;
    this.currentName = name;
    return true;
  }

  /**
   * 功能：取传输实例；不传名字则取当前的。
   * @param name 可选名字
   * @returns 传输实例；名字不存在时回落到当前的
   */
  get(name?: string): ProbeTransport {
    const hit = name ? this.byId.get(name) : undefined;
    if (hit) return hit;
    const current = this.byId.get(this.currentName);
    // 构造时校验过默认名，这里只防「表被清空」这类意外，避免解引用 undefined
    if (!current) throw new Error("transport registry is empty");
    return current;
  }
}

/** 运行时自带 fetch 的传输名：只做直连对照 */
export const GATEWAY_TRANSPORT = "gateway";
/** 默认传输名：userland TLS，能落到中继上 */
export const TUNNEL_TRANSPORT = "tunnelfetch";

/**
 * 进程内唯一的传输注册表。
 *
 * 默认 tunnelfetch —— 只有它能把 TCP 落到中继上；gateway 那个实现留着是为了「同一目标、两条腿」
 * 的并排对照，不是替代品。
 */
export const TRANSPORTS = new TransportRegistry(TUNNEL_TRANSPORT, [
  [TUNNEL_TRANSPORT, new TunnelFetchTransport()],
  [GATEWAY_TRANSPORT, new GatewayFetchTransport()],
]);
