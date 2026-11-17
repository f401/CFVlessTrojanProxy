import type { ProbeTransport } from "./transport-types";
import { GatewayFetchTransport, TunnelFetchTransport } from "./transport-tunnelfetch";

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
