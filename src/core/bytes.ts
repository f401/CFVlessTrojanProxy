// 字节与文本互转：WS 负载归一、十六进制、UUID 文本。
// 单独成文件的原因：全仓十几处只想拿 `toU8`/`toHex`，却必须 import 整个 `util` 门面才拿得到。

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/**
 * 字节数组 → 小写十六进制字符串。
 * @param {Uint8Array|ArrayBuffer|number[]} u8 待转换的字节
 * @returns {string} 十六进制串，长度为字节数 × 2
 */
export function toHex(u8: Uint8Array) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += HEX[u8[i]];
  return s;
}

/**
 * 把 WebSocket 消息（ArrayBuffer / TypedArray / 字符串）统一成 Uint8Array。
 * @param {unknown} d WebSocket 收到的原始负载
 * @returns {Uint8Array} 统一后的字节
 */
export function toU8(d: unknown) {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (typeof d === "string") return enc.encode(d);
  return new Uint8Array(0);
}

/**
 * 16 字节摘要 → 标准 UUID 文本（8-4-4-4-12 分组）
 * @param {Uint8Array} b 长度至少 16 的字节数组
 * @returns {string} 格式化后的 UUID
 */
export function uuidFromBytes(b: Uint8Array) {
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
