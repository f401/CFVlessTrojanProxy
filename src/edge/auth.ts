import { enc, toHex } from "../core/util";
import type { RouteCtx } from "./types";

/* 面板鉴权：cookie / 挑战-应答会话 / 登录限流 */

/** 限流表最多记多少个来源 IP：超了只淘汰一条，不整体清空（见 `RateLimiter.take` 里的说明） */
const RL_MAX = 500;

/**
 * 功能：从 Cookie 头里取指定名字的值。
 * @param req 请求
 * @param name cookie 名
 * @returns 值；没有时返回空串
 */
export function getCookie(req: Request, name: string) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

/**
 * 功能：SHA-256 摘要，小写 hex（用于管理密钥的摘要比较）。
 * @param str 待摘要字符串
 * @returns 64 位 hex
 */
export async function sha256Hex(str: string) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return toHex(new Uint8Array(d));
}

/** 会话令牌：exp 参与签名，过期即失效（以前是永久不变的静态值）。 */
export async function sessionToken(env: Env, exp?: number) {
  const e = Math.floor(exp || Date.now() + 12 * 3600e3);
  // 只用 adminKey：adminHash 从来没参与过认证（见 types/env.d.ts 的说明），留在签名里只会让
  // 「配了 adminHash 但没配 adminKey」的部署得到一个签名不同、却谁也进不去的会话。
  const sig = await sha256Hex(`adm|${e}|${env.adminKey || ""}`);
  return `${e.toString(36)}.${sig.slice(0, 40)}`;
}

/** 管理员密钥的摘要（sha256 hex）：URL/日志里只放摘要，明文密钥不外出。
 *  不缓存：admin 请求本来就少，算一次 sha256 只有微秒级，省掉模块级可变状态。 */
async function adminDigest(env: Env): Promise<string> {
  const key = String(env.adminKey || "");
  return key ? await sha256Hex(key) : "";
}

/**
 * 功能：管理端鉴权。优先读 X-Admin-Key / Authorization 头（URL 里的 k= 会留在日志与历史里），同时接受原文与 sha256 摘要。
 * @param request 请求
 * @param url 解析后的 URL（兼容 ?k= 旧用法）
 * @param env 环境变量（adminKey）
 * @returns 通过为 true
 */
export async function adminAuthed(request: Request, url: URL, env: Env) {
  // 优先用请求头：URL 里的 k= 会留在访问日志、浏览器历史、Referer 里，等于明文外泄
  const hdr = request.headers.get("x-admin-key") || "";
  // 剥 "Bearer " 前缀：这里曾经写成 /^Bearers+/i（`\s` 掉了反斜杠），于是只匹配
  // 「Bearer」后面跟一串字母 s 的怪串，真正的 `Authorization: Bearer <key>` 原样带着
  // 前缀去比较、永远不相等 —— 文档宣称支持的 Bearer 鉴权从来没生效过，只是静默落到
  // Cookie 分支（表现为「我明明带了 Bearer 还是 403」）。
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
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

/**
 * 登录尝试的固定窗口限流（每来源 IP 每窗口 `limit` 次）。
 *
 * 为什么是类：这张表是**跨请求**的可变状态（同一 isolate 里所有登录尝试共用），
 * 而「窗口怎么算、表满了淘汰谁」是它的内部细节 —— 散成模块级 `Map` + 两个函数时，
 * 读 `admin.ts` 的人只知道「有个 rlTake」，看不到背后那张带淘汰策略的表。
 */
export class RateLimiter {
  /** 来源 IP → 本窗口内的次数与窗口起点 */
  private readonly rows = new Map<string, { n: number; t: number }>();

  /**
   * 功能：记一次尝试，并回答这次是否放行。
   * @param ip 客户端标识（来源 IP）
   * @param limit 窗口内允许次数
   * @param now 当前时间，默认 `Date.now()`
   * @returns 放行 true；本窗口额度用尽 false
   */
  take(ip: string, limit: number, now: number = Date.now()): boolean {
    const WINDOW_MS = 600000;
    const e = this.rows.get(ip);
    // 窗口还没过：额度没用尽就 +1；用尽了就挡掉（不推进起点，连续尝试不能给自己续窗口）
    if (e && now - e.t < WINDOW_MS) {
      if (e.n >= limit) return false;
      e.n += 1;
      return true;
    }
    // 新窗口（或第一次见到这个来源）：记一条，起点记成现在
    this.rows.set(ip, { n: 1, t: now });
    this.trim(ip);
    return true;
  }

  /**
   * 功能：清掉某个来源的计数（登录成功后调用，让下一次失败重新计数）。
   * @param ip 客户端标识
   * @returns 无
   */
  reset(ip: string): void {
    this.rows.delete(ip);
  }

  /**
   * 功能：当前记了多少个来源（只读，给面板与单测看有界性）。
   * @returns 行数
   */
  get size(): number {
    return this.rows.size;
  }

  /**
   * 功能：清空整张表（只有单测与本地调试会调用）。
   * @returns 无
   */
  clear(): void {
    this.rows.clear();
  }

  /**
   * 功能：超上限时淘汰一条，绝不整体清空、绝不淘汰刚写进来的这条。
   *
   * 为什么不 `clear()`：来源 IP 是攻击者可以换的（IPv6 一个 /64 就有海量地址），
   * 拿 501 个来源刷一遍就等于把自己刚被限住的计数重置掉 —— 这张表本来就是为了挡这件事。
   * 淘汰「计数最小、且最旧」的那条：正被限住的来源计数会涨上去自然留下，
   * 而拿一次性来源刷表的攻击者只会把自己刷进去的那批删掉。
   * @param keep 刚被写入、不许淘汰的那个来源
   * @returns 无
   */
  private trim(keep: string): void {
    // 没超上限就什么都不做：这张表大多数时候只有几十行
    if (this.rows.size <= RL_MAX) return;
    // 一次只淘汰一条：本轮只多了一行，多删会把正当用户的计数也抹掉
    let victim = "";
    let minN = Infinity;
    let minT = Infinity;
    for (const [k, v] of this.rows) {
      // 跳过刚写进来的来源（`keep`）：否则「刷 501 个来源」就能把攻击者自己的计数重置
      if (k === keep || !v) continue;
      // 先比计数（小的先走，正被限住的来源计数已经涨上去），计数相同再比时间（更旧的先走）
      if (v.n < minN || (v.n === minN && v.t < minT)) {
        minN = v.n;
        minT = v.t;
        victim = k;
      }
    }
    // 全是 `keep` 的行时 `victim` 为空，那就这轮先不淘汰（下一轮会有一条可淘汰的）
    if (victim) this.rows.delete(victim);
  }
}

/** 进程内唯一限流器：登录尝试是跨请求的，必须由模块级实例持有（不能挂在每个请求的对象上） */
export const RATE_LIMIT = new RateLimiter();

/**
 * 功能：生成一次性随机串（时间前缀 + 12 字节随机），用于防重放。
 * @returns 字符串
 */
export function newNonce() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Date.now().toString(16) + "." + toHex(b);
}

/**
 * 功能：生成易读随机密码（去掉 l/I/1/0/O 之类易混字符）。
 * @param n 长度，非法值回退 16
 * @returns 密码字符串
 */
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

