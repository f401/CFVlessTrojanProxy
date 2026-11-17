import { connect } from "cloudflare:sockets";
import { Client } from "tunnelfetch";
import { splitRelay } from "./http80";
import { withTimeout } from "./util";
import type { ProbeTransport, TransportOutcome } from "./transport-types";

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
