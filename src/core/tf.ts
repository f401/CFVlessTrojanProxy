import { connect } from "cloudflare:sockets";
import { Client } from "tunnelfetch";
import { withTimeout } from "./util";
import { splitRelay } from "./http80";

/** 一次探测的总预算：userland TLS 走中继，卡住的那一刻不会自己回来。
 * 不设上限时，DO 里那个请求会一直挂着 —— 探测是诊断路径，绝不能拖住计量端点。 */
const TF_MS = 8000;

/**
 * 功能：tunnelfetch 探测（实验）：userland TLS 1.3，可把 TCP 落到中继上。
 * 只用于诊断（不验证书），结论按「旁证」处理。
 * @param {string} host 目标主机名
 * @param {string} relay 中继 `host:port`（空串表示直连）
 * @param {string} path 请求路径
 * @returns {Promise<Record<string, unknown>>} 结果（ok/status/bytes/ms 或 err）
 */
export async function probeTf(host: string, relay = "", path = "/"): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  // 拆 `host:port` 必须走 splitRelay：IPv6 字面量自带冒号，`lastIndexOf(":")` 会把
  // `2a06:98c0::1:443` 拆成 host=`2a06`、port=`98c0`（7.180 在 http80 修过同一处，这是第二处）
  const [rh, rp] = relay ? splitRelay(relay, 443) : ["", 443];
  const dial = relay
    ? () => connect({ hostname: rh, port: rp })
    : (o: { hostname: string; port: number }) => connect(o);
  const opts = {
    connect: dial,

  } as unknown as ConstructorParameters<typeof Client>[0];
  const c = new Client(opts);
  // 抓「请求 + 读体」这整段：只给 fetch 加超时，读体阶段照样能挂住
  let work: Promise<{ r: Response; buf: ArrayBuffer }> | null = null;
  try {
    work = (async () => {
      const r = await c.fetch(`https://${host}${path}`, { redirect: "manual" });
      const buf = await r.arrayBuffer();
      return { r, buf };
    })();
    const { r, buf } = await withTimeout(work, TF_MS, "tf timeout");
    const head = new TextDecoder().decode(new Uint8Array(buf).slice(0, 64)).replace(/\s+/g, " ");
    return {
      ok: true,
      status: r.status,
      server: r.headers.get("server") || "",
      bytes: buf.byteLength,
      head,
      ms: Date.now() - t0,
    };
  } catch (e) {
    // 超时之后那一半还在跑：不让它变成 unhandled rejection（1101 的老坑）
    if (work) void work.catch(() => {});
    return { ok: false, err: String(e).slice(0, 220), ms: Date.now() - t0 };
  } finally {
    try {
      await c.close();
    } catch {
      /* 已关 */
    }
  }
}
