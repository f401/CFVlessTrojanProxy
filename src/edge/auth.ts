import { enc, toHex } from "../core/util";
import type { RouteCtx } from "./types";

/* 面板鉴权：cookie / 挑战-应答会话 / 登录限流 */

export const RL_MEM = new Map(); // ip -> { n, t }

export function getCookie(req: Request, name: string) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

export async function sha256Hex(str: string) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return toHex(new Uint8Array(d));
}

/** 会话令牌：exp 参与签名，过期即失效（以前是永久不变的静态值）。 */
export async function sessionToken(env: Env, exp?: number) {
  const e = Math.floor(exp || Date.now() + 12 * 3600e3);
  const sig = await sha256Hex(`adm|${e}|${env.adminKey || ""}|${env.adminHash || ""}`);
  return `${e.toString(36)}.${sig.slice(0, 40)}`;
}

/** 管理员密钥的摘要（sha256 hex）：URL/日志里只放摘要，明文密钥不外出。
 *  不缓存：admin 请求本来就少，算一次 sha256 只有微秒级，省掉模块级可变状态。 */
async function adminDigest(env: Env): Promise<string> {
  const key = String(env.adminKey || "");
  return key ? await sha256Hex(key) : "";
}

export async function adminAuthed(request: Request, url: URL, env: Env) {
  // 优先用请求头：URL 里的 k= 会留在访问日志、浏览器历史、Referer 里，等于明文外泄
  const hdr = request.headers.get("x-admin-key") || "";
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearers+/i, "");
  const given = hdr || bearer || url.searchParams.get("k") || "";
  if (given && env.adminKey) {
    if (given === env.adminKey) return true; // 兼容旧用法
    if (given.toLowerCase() === (await adminDigest(env))) return true; // sha256(adminKey) 等价凭证
  }
  const tok = getCookie(request, "adm");
  if (!tok) return false;
  const dot = tok.indexOf(".");
  if (dot <= 0) return false;
  const exp = parseInt(tok.slice(0, dot), 36);
  if (!(exp > Date.now())) return false;
  return tok === (await sessionToken(env, exp));
}

export function rlTake(ip: string, limit: number) {
  const now = Date.now();
  const e = RL_MEM.get(ip);
  if (e && now - e.t < 600000) {
    if (e.n >= limit) return false;
    e.n += 1;
    return true;
  }
  RL_MEM.set(ip, { n: 1, t: now });
  if (RL_MEM.size > 500) RL_MEM.clear();
  return true;
}

/** 功能：rlReset 是薄包装，直接委托 RL_MEM.delete。@param ip string。@returns 无（RL_MEM.delete 无返回值） */
export function rlReset(ip: string) {
  RL_MEM.delete(ip);
}

export function newNonce() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Date.now().toString(16) + "." + toHex(b);
}

export function randomPwd(n: number) {
  const A = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const len = Math.floor(Number(n)) > 0 ? Math.floor(Number(n)) : 16;
  let s = "";
  // 256 % 56 = 32：直接取模会让前 32 个字符出现概率高 1/4，
  // 用拒绝采样把这 224..255 丢掉，字符分布才是均匀的。
  const max = 256 - (256 % A.length);
  while (s.length < len) {
    const b = crypto.getRandomValues(new Uint8Array(len - s.length + 8));
    for (let i = 0; i < b.length && s.length < len; i++) {
      if (b[i] < max) s += A[b[i] % A.length];
    }
  }
  return s;
}

/** 会改全局状态 / 花 KV 额度的调试动作：要求管理员会话或 &k=adminKey */
export async function adminOnly(c: RouteCtx): Promise<Response | null> {
  if (await adminAuthed(c.request, c.url, c.env)) return null;
  return new Response(JSON.stringify({ ok: false, error: "需要管理员登录 /admin，或加 &k=<adminKey>" }), {
    status: 403,
    headers: { "content-type": "application/json;charset=utf-8" },
  });
}

