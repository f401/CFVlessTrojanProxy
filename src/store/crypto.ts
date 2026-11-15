import { enc } from "../core/util";

/* 存储加密：AES-GCM 封装 + base64 */

const KEY_BOX: { aek: CryptoKey | null; raw: string } = { aek: null, raw: "" };

/**
 * 功能：Uint8Array → base64（分块处理，避免大数组爆栈）。
 * @param u8 字节数组
 * @returns base64 字符串
 */
export function b64e(u8: Uint8Array) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH)
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CH) as unknown as number[]);
  return btoa(s);
}

/**
 * 功能：base64 → Uint8Array。
 * @param str base64 字符串
 * @returns 字节数组
 */
export function b64d(str: string) {
  const bin = atob(str);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/**
 * 功能：由 env.kek 派生 AES-GCM 密钥（进程内缓存；没有 kek 时返回 null，调用方按明文 JSON 存）。
 * @param env 环境变量
 * @returns CryptoKey；env.kek 为空时返回 null
 */
export async function aesKey(env: Env) {
  const raw = String((env && env.kek) || "");
  // 缓存必须记住它是用哪一份 kek 派生的。换 kek（面板改了 secret）之后，旧 isolate 里
  // 缓存的 aek 会继续拿旧密钥去解新数据，表现为「所有 KV 读都解不开」：kvGetStrict 抛错
  //（写路径被拒，池子锚点写不进去）、kvGet 返回 null（快照被当成空表）——直到 isolate
  // 被回收为止，而且没有任何日志能看出是密钥换了。
  if (KEY_BOX.aek && KEY_BOX.raw === raw) return KEY_BOX.aek;
  if (!raw) {
    KEY_BOX.aek = null;
    KEY_BOX.raw = "";
    return null;
  }
  const dig = await crypto.subtle.digest("SHA-256", enc.encode(raw));
  KEY_BOX.aek = await crypto.subtle.importKey("raw", dig, "AES-GCM", false, ["encrypt", "decrypt"]);
  KEY_BOX.raw = raw;
  return KEY_BOX.aek;
}

/**
 * 功能：用 AES-GCM 加密并编码成可存 KV 的字符串（ENC1 前缀 + base64）。
 * @param env 环境变量
 * @param obj 待加密对象或字符串
 * @returns 加密串
 */
export async function seal(env: Env, obj: unknown): Promise<string> {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj);
  const k = await aesKey(env);
  if (!k) return text;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, enc.encode(text)));
  return "ENC1:" + b64e(iv) + ":" + b64e(ct);
}

export async function unseal<T = unknown>(env: Env, raw: unknown): Promise<T | null> {
  if (raw == null) return null;
  if (typeof raw !== "string") return raw as T;
  if (!raw.startsWith("ENC1:")) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  const k = await aesKey(env);
  if (!k) return null;
  const parts = raw.split(":");
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(parts[1]) }, k, b64d(parts[2]));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (e) {
    return null;
  }
}

