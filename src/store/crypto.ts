import { enc } from "../core/util";

/* 存储加密：AES-GCM 封装 + base64 */

const KEY_BOX: { aek: CryptoKey | null } = { aek: null };

export function b64e(u8: Uint8Array) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH) as unknown as number[]);
  return btoa(s);
}

export function b64d(str: string) {
  const bin = atob(str);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export async function aesKey(env: Env) {
  if (KEY_BOX.aek) return KEY_BOX.aek;
  const raw = String((env && env.kek) || "");
  if (!raw) return null;
  const dig = await crypto.subtle.digest("SHA-256", enc.encode(raw));
  KEY_BOX.aek = await crypto.subtle.importKey("raw", dig, "AES-GCM", false, ["encrypt", "decrypt"]);
  return KEY_BOX.aek;
}

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
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  const k = await aesKey(env);
  if (!k) return null;
  const parts = raw.split(":");
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64d(parts[1]) },
      k,
      b64d(parts[2])
    );
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (e) {
    return null;
  }
}
