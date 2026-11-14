import { connect } from "cloudflare:sockets";
import { Client } from "tunnelfetch";

/** tunnelfetch 探测（实验）：userland TLS 1.3，可把 TCP 落到中继上。
 *  只用于诊断（不验证书），结论按「旁证」处理。 */
export async function probeTf(host: string, relay = "", path = "/"): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const i = relay.lastIndexOf(":");
  const rh = i > 0 ? relay.slice(0, i) : relay;
  const rp = i > 0 ? Number(relay.slice(i + 1)) : 443;
  const dial = relay
    ? () => connect({ hostname: rh, port: rp })
    : (o: { hostname: string; port: number }) => connect(o);
  const opts = {
    connect: dial,

  } as unknown as ConstructorParameters<typeof Client>[0];
  const c = new Client(opts);
  try {
    const r = await c.fetch(`https://${host}${path}`, { redirect: "manual" });
    const buf = await r.arrayBuffer();
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
    return { ok: false, err: String(e).slice(0, 220), ms: Date.now() - t0 };
  } finally {
    try {
      await c.close();
    } catch {
      /* 已关 */
    }
  }
}
