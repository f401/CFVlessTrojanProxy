import type { Connection } from "./connection";
import { safeSend, timeoutSignal } from "../core/util";

/**
 * 拆一个 Trojan UDP 包：[ATYP][ADDR][PORT][LEN][PAYLOAD]。
 * 返回 head（原样回显的地址前缀）、msg、rest；不完整/非法返回 null。
 */
export function trojanUdpFrame(buf: Uint8Array): { head: Uint8Array; msg: Uint8Array; rest: Uint8Array } | null {
  if (buf.length < 1) return null;
  const atyp = buf[0];
  let alen = 0;
  if (atyp === 1) alen = 4;
  else if (atyp === 4) alen = 16;
  else if (atyp === 3) {
    if (buf.length < 2) return null;
    alen = 1 + buf[1];
  } else return null;
  const hlen = 1 + alen + 2;
  if (buf.length < hlen + 2) return null;
  const n = (buf[hlen] << 8) | buf[hlen + 1];
  if (n < 12 || n > 4096) return null;
  if (buf.length < hlen + 2 + n) return null;
  return {
    head: buf.slice(0, hlen),
    msg: buf.slice(hlen + 2, hlen + 2 + n),
    rest: buf.slice(hlen + 2 + n),
  };
}
/**
 * 处理 UDP/53 的 DNS 查询：转发到 DoH 再把响应回写给客户端。
 * @param {WebSocket} ws 客户端连接
 * @param {Uint8Array} firstBody 首个 DNS 报文
 * @param {object} st 连接状态
 * @param {boolean} trojan Trojan UDP 与会话首包之后的分帧：
 *   每包是 [ATYP][ADDR][PORT][LEN][PAYLOAD]，响应要把地址前缀原样带回；
 *   VLESS 则是 [LEN][PAYLOAD]，响应头（ver,0）只在第一包前出现一次。
 * @returns {Promise<void>}
 */
export async function handleDns(
  ws: WebSocketLike,
  firstBody: Uint8Array,
  st: Connection,
  trojan = false,
): Promise<void> {
  const send = async (dnsMsg: Uint8Array, head?: Uint8Array) => {
    const resp = await fetch("https://1.1.1.1/dns-query", {
      signal: timeoutSignal(5000),
      method: "POST",
      headers: { "content-type": "application/dns-message" },
      body: dnsMsg,
    });
    const ab = await resp.arrayBuffer();
    const u8 = new Uint8Array(ab);
    // DNS 响应也要计入下行：否则 UDP/53 的流量完全不计费/不进面板
    st.down += u8.length;
    const len = new Uint8Array([(u8.length >> 8) & 0xff, u8.length & 0xff]);
    const pre = head && head.length ? head : null;
    const out = new Uint8Array((pre ? pre.length : 0) + 2 + u8.length);
    let off = 0;
    if (pre) {
      out.set(pre, 0);
      off = pre.length;
    }
    out.set(len, off);
    out.set(u8, off + 2);
    const merged = st.header
      ? (() => {
          const m = new Uint8Array(st.header.length + out.length);
          m.set(st.header, 0);
          m.set(out, st.header.length);
          return m;
        })()
      : out;
    safeSend(ws, merged);
    st.header = null;
  };
  let buf = firstBody;
  let queries = 0;
  if (trojan) {
    // Trojan UDP：每个包都带地址前缀；响应的前缀必须原样带回
    while (buf.length >= 7 && queries < 32) {
      const f = trojanUdpFrame(buf);
      if (!f) {
        try {
          ws.close(1003, "bad udp frame");
        } catch (e) {}
        return;
      }
      await send(f.msg, f.head).catch(() => {});
      queries++;
      buf = f.rest;
    }
    return;
  }
  // VLESS UDP：[len][msg]；恶意客户端声明超长帧会让缓冲无限堆积
  while (buf.length >= 2 && queries < 32) {
    const n = (buf[0] << 8) | buf[1];
    if (n < 12 || n > 4096) {
      try {
        ws.close(1003, "bad dns frame");
      } catch (e) {}
      return;
    }
    if (buf.length < 2 + n) break;
    await send(buf.slice(2, 2 + n)).catch(() => {});
    queries++;
    buf = buf.slice(2 + n);
  }
}
/* ==================================================================
 * §8  配置下发
 * ================================================================== */
