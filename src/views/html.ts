/* HTML 小工具：转义与字节格式化 */

/**
 * 功能：把字节数格式化成人类可读形式（KB/MB/GB，保留一位小数）。
 * @param n 字节数
 * @returns 字符串
 */
export function fmtBytes(n: number) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/**
 * 功能：HTML 转义（面板与错误页所有插值都必须过它）。
 * @param s 任意值（会先 String 化）
 * @returns 转义后的字符串
 */
export function escapeHtml(s: unknown) {
  const MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s).replace(/[&<>"']/g, (c) => MAP[c]);
}

