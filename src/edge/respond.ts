/** 统一响应构造：所有 content-type / 安全头只在这里出现一次 */

/** 所有响应共用的安全头：JSON / 文本也要 nosniff，避免被当 HTML 嗅探 */
const SAFE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** 控制页/统计页没有脚本：比管理面板再收紧一档（不给 script-src） */
export const CSP_STATIC = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";

export const SEC_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  ...SAFE_HEADERS,
};

/** JSON 响应（对象自动 2 空格缩进，便于人眼看 /health） */
export function json(obj: unknown, extra?: Record<string, string>): Response {
  return new Response(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2), {
    headers: { "content-type": "application/json;charset=utf-8", ...SAFE_HEADERS, ...(extra || {}) },
  });
}

/** 纯文本响应（订阅 / 错误） */
export function text(s: string, extra?: Record<string, string>): Response {
  return new Response(s, {
    headers: { "content-type": "text/plain;charset=utf-8", ...SAFE_HEADERS, ...(extra || {}) },
  });
}

/** HTML 响应（面板类页面一律带安全头 + no-store） */
export function html(body: string, status = 200, extra?: Record<string, string>): Response {
  return new Response(body, {
    status: status || 200,
    headers: {
      "content-type": "text/html;charset=utf-8",
      ...SEC_HEADERS,
      ...(extra || {}),
    },
  });
}

/** 需要登录态的面板页：先给 403 文本 */
export function forbidden(): Response {
  return new Response("Forbidden", { status: 403, headers: SAFE_HEADERS });
}
