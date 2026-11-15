import type { Connection } from "./connection";
import { safeSend, timeoutSignal } from "../core/util";

/** DNS over UDP 的实践上限（不切分）：单帧负载最大 4096 字节 */
const DNS_MAX = 4096;
/** 跨消息残留的上限：最长合法帧头是 1+16+2+2=21，加上负载再留点余量 */
const DNS_CARRY_MAX = DNS_MAX + 64;

/**
 * 拆一个 Trojan UDP 包：[ATYP][ADDR][PORT][LEN][PAYLOAD]。
 * 返回 head（原样回显的地址前缀）、msg、rest。
 * 三种结果必须分开：格式非法（null，调用方直接关连接）与数据还没到齐（"short"，
 * 调用方要把这一截留下来等下一帧）—— 混成 null 会让「分两条 WS 消息发来的包」
 * 被判成协议错误并断连。
 */
export function trojanUdpFrame(
  buf: Uint8Array,
): { head: Uint8Array; msg: Uint8Array; rest: Uint8Array } | "short" | null {
  if (buf.length < 1) return "short";
  const atyp = buf[0];
  let alen = 0;
  // ATYP：1=IPv4(4 字节)、4=IPv6(16 字节)、3=域名(1 字节长度 + 内容)；其他值直接判非法
  if (atyp === 1) alen = 4;
  else if (atyp === 4) alen = 16;
  else if (atyp === 3) {
    if (buf.length < 2) return "short";
    alen = 1 + buf[1];
  } else return null;
  // 头部 = ATYP(1) + 地址(alen) + 端口(2)，紧跟 2 字节负载长度
  const hlen = 1 + alen + 2;
  if (buf.length < hlen + 2) return "short";
  const n = (buf[hlen] << 8) | buf[hlen + 1];
  // 小于 12 字节说明多半是流量事件而不是应答；超过 DNS_MAX 的帧一定不是 DNS
  if (n < 12 || n > DNS_MAX) return null;
  if (buf.length < hlen + 2 + n) return "short";
  return {
    head: buf.slice(0, hlen),
    msg: buf.slice(hlen + 2, hlen + 2 + n),
    rest: buf.slice(hlen + 2 + n),
  };
}

/**
 * 处理 UDP/53 的 DNS 查询：转发到 DoH 再把响应回写给客户端。
 * @param {WebSocket} ws 客户端连接
 * @param {Uint8Array} firstBody 这一条 WS 消息里的 DNS 字节（可能是上一帧的续片）
 * @param {object} st 连接状态（读 `header`，读写 `udpBuf`，累加 `down`）
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

  // 上一帧没拆完的字节先接回来：WS 是分帧的，但客户端完全可以把一个 UDP 包
  // 拆到两条消息里发（大响应/拥塞窗口都会这样），丢了就等于这条 DNS 永久无应答。
  const prev = st.udpBuf;
  let buf: Uint8Array;
  if (prev && prev.length) {
    buf = new Uint8Array(prev.length + firstBody.length);
    buf.set(prev, 0);
    buf.set(firstBody, prev.length);
  } else {
    buf = firstBody;
  }
  st.udpBuf = null;

  /**
   * 把拆不完的字节留到下一帧。
   * @param {Uint8Array} rest 剩余字节
   * @returns {boolean} false 表示残留已经超过上限（调用方必须关连接）
   */
  const carry = (rest: Uint8Array): boolean => {
    if (!rest.length) return true;
    if (rest.length > DNS_CARRY_MAX) return false;
    st.udpBuf = rest.slice();
    return true;
  };

  let queries = 0;
  if (trojan) {
    // Trojan UDP：每个包都带地址前缀；响应的前缀必须原样带回
    while (buf.length >= 7 && queries < 32) {
      const f = trojanUdpFrame(buf);
      // 只差尾巴：留着等下一帧，别把整条连接判死
      if (f === "short") {
        if (!carry(buf)) {
          try {
            ws.close(1003, "udp overflow");
          } catch (e) {}
        }
        return;
      }
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
    // 收尾：剩下的可能是不够拆头的碎片（<7 字节），也可能是这一轮 32 条配额用完
    if (buf.length && !carry(buf)) {
      try {
        ws.close(1003, "udp overflow");
      } catch (e) {}
    }
    return;
  }
  // VLESS UDP：[len][msg]；恶意客户端声明超长帧会让缓冲无限堆积
  while (buf.length >= 2 && queries < 32) {
    const n = (buf[0] << 8) | buf[1];
    if (n < 12 || n > DNS_MAX) {
      try {
        ws.close(1003, "bad dns frame");
      } catch (e) {}
      return;
    }
    // 声明长度还没到齐：留存，下一帧接着拼（原来是直接 break 丢掉）
    if (buf.length < 2 + n) break;
    await send(buf.slice(2, 2 + n)).catch(() => {});
    queries++;
    buf = buf.slice(2 + n);
  }
  if (buf.length && !carry(buf)) {
    try {
      ws.close(1003, "udp overflow");
    } catch (e) {}
  }
}
/* ==================================================================
 * §8  配置下发
 * ================================================================== */
