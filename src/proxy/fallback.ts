
import { connect } from "cloudflare:sockets";
import { nextNode } from "../nodes/score";
import { logErr } from "../nodes/metrics";
import type { Connection } from "./connection";

export async function dialAnother(env: Env, st: Connection, mode: string, tag?: string): Promise<any> {
  const alt = nextNode(mode, st.node);
  if (!alt) return null;
  const i = alt.lastIndexOf(":");
  const host = alt.slice(0, i);
  const port = Number(alt.slice(i + 1)) || 443;
  try {
    const s = await connect({ hostname: host, port });
    st.node = alt;
    st.via = "node";
    st.pxTries = (st.pxTries || 1) + 1;
    logErr(`retry another node ${alt}`, tag || "");
    return s;
  } catch (e: any) {
    return null;
  }
}
