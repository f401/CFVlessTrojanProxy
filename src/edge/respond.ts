/** 统一响应构造：所有 content-type / 安全头只在这里出现一次 */

export const SEC_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** JSON 响应（对象自动 2 空格缩进，便于人眼看 /health） */
export function json(obj: any, extra?: Record<string, string>): Response {
  return new Response(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2), {
    headers: { "content-type": "application/json;charset=utf-8", ...(extra || {}) },
  });
}

/** 纯文本响应（订阅 / 错误） */
export function text(s: any, extra?: Record<string, string>): Response {
  return new Response(s, { headers: { "content-type": "text/plain;charset=utf-8", ...(extra || {}) } });
}

/** HTML 响应（面板类页面一律带安全头 + no-store） */
export function html(body: any, status = 200, extra?: Record<string, string>): Response {
  return new Response(body, {
    status: status || 200,
    headers: {
      "content-type": "text/html;charset=utf-8",
      "cache-control": "no-store",
      ...SEC_HEADERS,
      ...(extra || {}),
    },
  });
}

/** 需要登录态的面板页：先给 403 文本 */
export function forbidden(): Response {
  return new Response("Forbidden", { status: 403 });
}
