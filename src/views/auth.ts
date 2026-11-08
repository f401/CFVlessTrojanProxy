import { enc, toHex } from "../core/util";

/* 面板鉴权：cookie / 挑战-应答会话 / 登录限流 */

export const RL_MEM = new Map();   // ip -> { n, t }

export function getCookie(req: any, name: any) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

export async function sha256Hex(str: any) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return toHex(new Uint8Array(d));
}

export async function sessionToken(env: Env) {
  const t = await sha256Hex(`adm|${env.adminKey || ""}|${env.adminHash || ""}`);
  return t.slice(0, 40);
}

export async function adminAuthed(request: any, url: any, env: any) {
  const k = url.searchParams.get("k");
  if (k && env.adminKey && k === env.adminKey) return true;
  const tok = getCookie(request, "adm");
  if (!tok) return false;
  return tok === (await sessionToken(env));
}

export function rlTake(ip: any, limit: any) {
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

export function rlReset(ip: any) {
  RL_MEM.delete(ip);
}

export function newNonce() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Date.now().toString(16) + "." + toHex(b);
}

export function randomPwd(n: any) {
  const A = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(n || 16));
  let s = "";
  for (let i = 0; i < b.length; i++) s += A[b[i] % A.length];
  return s;
}
