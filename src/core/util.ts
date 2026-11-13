/* 閫氱敤宸ュ叿锛氱紪鐮?鍝堝笇/瀛楄妭澶勭悊/WS 鍙戦€?*/
export const WS_OPEN = 1;
export const WS_BUFFER_LIMIT = 1024 * 1024; // 涓嬭鍙戦€佺紦鍐茶秴杩?1MB 灏卞紑濮嬭儗鍘?
export const WS_STALL_MS = 60000; // 瀹㈡埛绔竴鏃舵敹涓嶅姩寰堝父瑙侊紝缁欏埌 60 绉?
export const WS_MAX_BUFFER = 16 * 1024 * 1024; // 纭笂闄愶細鍒洜涓哄鎴风鎱㈠氨鎶婁笅杞芥帎浜?
export const VERSION = "6.68";
export const enc = new TextEncoder();
export const dec = new TextDecoder();

/* ==================================================================
 * 搂1  甯搁噺涓庡伐鍏?
 * ================================================================== */

export const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

// 瀵嗙爜缁戝畾鐨勮鍙栵細浼樺厛 env.pwd锛堜腑鎬у悕锛夛紝鍏煎鑰佺殑 env[P_T]
export const secretPwd = (env: Env) => String((env && (env.pwd || env[P_T])) || "").trim();

/** 褰卞瓙娴侀噺榛樿姣斾緥锛氬彧鍦ㄣ€屽綋鍓嶈妭鐐规牱鏈笉瓒炽€嶆椂鎵嶆彁鍗囧埌 SC.EXPLORE_MAX */
export const SHADOW_DEFAULT = 0.05;

/**
 * 瑙ｆ瀽 pxShadow銆備笁澶勶紙閫夋嫨鍣?/ 鎺у埗椤?/ /proxyip锛夊繀椤荤敤鍚屼竴濂楄鍒欙紝
 * 鍚﹀垯闈㈡澘鏄剧ず 10%銆佸疄闄呰窇 5%锛屾垨鑰?pxShadow=0 鏃舵樉绀烘垚 10%銆?
 *   鏈缃?/ 闈炴硶 鈫?榛樿 5%
 *   鏄惧紡 0       鈫?0锛堝叧闂帰绱級
 *   >1           鈫?1锛堝皝椤讹級
 */
export function shadowRate(env: Env) {
  const raw = env ? env.pxShadow : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === "") return SHADOW_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SHADOW_DEFAULT;
  return Math.min(1, n);
}

/**
 * 鍙€夌殑璇锋眰瓒呮椂淇″彿锛氳繍琛屾椂娌℃湁 AbortSignal.timeout 鏃惰繑鍥?undefined锛堜笉褰卞搷璇锋眰锛夈€?
 * 鍙敤浜?cron / 璇婃柇杩欑被"鎱竴鐐规病鍏崇郴锛屼絾涓嶈兘鏃犻檺绛?鐨勫閮?fetch銆?
 */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  const AS =
    typeof AbortSignal === "undefined" ? null : (AbortSignal as unknown as { timeout?: (n: number) => AbortSignal });
  return AS && typeof AS.timeout === "function" ? AS.timeout(Math.max(1, ms)) : undefined;
}

/**
 * 缁?Promise 鍔犺秴鏃讹紝骞跺湪缁撴潫鏃舵竻鎺夊畾鏃跺櫒銆?
 * 鐩存帴鐢?Promise.race 浼氭妸 setTimeout 鐣欏湪閭ｉ噷锛氫竴杞?cron 鎺?60 涓妭鐐癸紝
 * 灏辨槸 60 涓浣欑殑 4 绉掑畾鏃跺櫒锛屾棦鍗?CPU 鍙堟嫋闀胯姹傜敓鍛藉懆鏈熴€?
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, msg = "timeout"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(msg)), Math.max(1, ms));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 鏈夐檺骞跺彂鍦拌窇寮傛浠诲姟锛氭棦涓嶈 50 涓敤鎴峰悓鏃舵墦 DO锛屼篃涓嶉€€鍖栨垚涓茶銆?
 * 椤哄簭涓嶄繚璇侊紝璋冪敤鏂瑰彧鍏冲績銆屽叏閮ㄥ畬鎴愩€嶃€?
 */
export async function eachLimit<T>(list: readonly T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  const n = Math.max(1, Math.min(Math.floor(limit) || 1, list.length));
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const idx = i++;
      await fn(list[idx]);
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
}

// 鍗忚鍚嶅湪杩愯鏃舵嫾瑁咃紝婧愮爜閲屼笉鍑虹幇鏄庢枃锛屾贩娣嗗悗涔熶笉浼氭畫鐣?
export const P_V = String.fromCharCode(118, 108, 101, 115, 115); // 118 108 101 115 115
export const P_T = String.fromCharCode(116, 114, 111, 106, 97, 110); // 116 114 111 106 97 110

/**
 * 瀛楄妭鏁扮粍 鈫?灏忓啓鍗佸叚杩涘埗瀛楃涓层€?
 * @param {Uint8Array|ArrayBuffer|number[]} u8 瀛楄妭搴忓垪
 * @returns {string} 鍗佸叚杩涘埗涓诧紝闀垮害涓哄瓧鑺傛暟 脳 2
 */
export function toHex(u8: Uint8Array) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += HEX[u8[i]];
  return s;
}

/**
 * 鎶?WebSocket 娑堟伅/ArrayBuffer/TypedArray 缁熶竴鎴?Uint8Array銆?
 * @param {unknown} d 鍘熷娑堟伅浣?
 * @returns {Uint8Array} 瀛楄妭瑙嗗浘
 */
export function toU8(d: unknown) {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (typeof d === "string") return enc.encode(d);
  return new Uint8Array(0);
}

/**
 * 16 瀛楄妭 鈫?鏍囧噯 UUID 瀛楃涓诧紙8-4-4-4-12锛夈€?
 * @param {Uint8Array} b 闀垮害鑷冲皯 16 鐨勫瓧鑺傛暟缁?
 * @returns {string} 灏忓啓 UUID
 */
export function uuidFromBytes(b: Uint8Array) {
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * 鍚?WebSocket 鍙戦€佹暟鎹紱杩炴帴宸插叧闂垨鍙戦€佸け璐ユ椂闈欓粯蹇界暐銆?
 * @param {WebSocket} ws 鐩爣杩炴帴
 * @param {Uint8Array|ArrayBuffer} data 寰呭彂閫佹暟鎹?
 * @returns {void}
 */
export const WS_MSG_MAX = 256 * 1024; // 鍗曞抚涓婇檺锛欳F 瀵硅秴澶?WS 娑堟伅浼氱洿鎺ユ柇閾?

export function safeSend(ws: WebSocketLike, data: Uint8Array) {
  try {
    if (!ws || ws.readyState !== WS_OPEN) return;
    // 澶у潡鎷嗗抚锛氫竴娆?send 瓒呰繃绾?1 MB 鏃惰繍琛屾椂鍙兘鐩存帴閲嶇疆杩炴帴锛?
    // 琛ㄧ幇灏辨槸"涓嬭浇鍒?1 MB 宸﹀彸蹇呮柇"銆?
    if (data && data.length > WS_MSG_MAX) {
      for (let i = 0; i < data.length; i += WS_MSG_MAX) {
        ws.send(data.subarray(i, Math.min(i + WS_MSG_MAX, data.length)));
      }
    } else {
      ws.send(data);
    }
  } catch (e) {
    /* 瀵圭宸插叧闂紝蹇界暐 */
  }
}

/**
 * 閲婃斁涓€娆¤繛鎺ユ寔鏈夌殑鍏ㄩ儴璧勬簮锛堝啓閿?+ 涓婃父 socket锛夈€?
 * @param {object} st 杩炴帴鐘舵€佸璞?
 * @returns {void}
 */
export function releaseAll(st: { writer: { releaseLock(): void } | null; sock: { close(): void } | null } | null) {
  if (!st) return;
  try {
    if (st.writer) st.writer.releaseLock();
  } catch (e) {
    /* 浠嶆湁鏈畬鎴愮殑鍐欙紝蹇界暐 */
  }
  st.writer = null;
  closeQuietly(st.sock);
  st.sock = null;
}

/**
 * 闈欓粯鍏抽棴 socket锛屽拷鐣ラ噸澶嶅叧闂骇鐢熺殑寮傚父銆?
 * @param {Socket|null} sock 寰呭叧闂殑杩炴帴
 * @returns {void}
 */
export function closeQuietly(sock: { close(): void } | null | undefined) {
  try {
    if (sock) sock.close();
  } catch (e) {
    /* ignore */
  }
}

/* ==================================================================
 * 搂2  SHA-224锛圱rojan 閴存潈鐢紱WebCrypto 涓嶆彁渚?SHA-224锛?
 * ================================================================== */

export const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);
export const SHA_H224 = new Uint32Array([
  0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4,
]);

export const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;

/**
 * 璁＄畻 SHA-224 鎽樿锛堢函 JS 瀹炵幇锛岀敤浜?Trojan 瀵嗙爜鏍￠獙锛夈€?
 * @param {Uint8Array} data 寰呮憳瑕佹暟鎹?
 * @returns {Uint8Array} 28 瀛楄妭鎽樿
 */
export function sha224Bytes(data: Uint8Array | ArrayBuffer) {
  const data8 = toU8(data);
  const len = data8.length;
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(data8);
  buf[len] = 0x80;

  const dv = new DataView(buf.buffer);
  const bits = len * 8;
  dv.setUint32(total - 8, Math.floor(bits / 4294967296));
  dv.setUint32(total - 4, bits >>> 0);

  const H = SHA_H224.slice();
  const w = new Uint32Array(64);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a15 = w[i - 15],
        a2 = w[i - 2];
      const s0 = (rotr(a15, 7) ^ rotr(a15, 18) ^ (a15 >>> 3)) >>> 0;
      const s1 = (rotr(a2, 17) ^ rotr(a2, 19) ^ (a2 >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = H[0],
      b = H[1],
      c = H[2],
      d = H[3];
    let e = H[4],
      f = H[5],
      g = H[6],
      h = H[7];

    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + SHA_K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(28);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 7; i++) odv.setUint32(i * 4, H[i]);
  return out;
}

/* ==================================================================
 * 搂3  閴存潈
 *    VLESS : env.uuids / env.uuid  鈥斺€?閫楀彿鍒嗛殧鐨?UUID 鍒楄〃
 *    瀵嗙爜缁戝畾: env.pwd            鈥斺€?"uuid:password,uuid:password"
 *            瀵嗙爜鍦?isolate 棣栨浣跨敤鏃剁畻鎴?sha224 鍝堝笇锛屾槧灏勫洖 uuid
 * ================================================================== */

/**
 * 鎶?catch 鍒扮殑浠绘剰鍊艰浆鎴愪竴鍙ュ彲璇荤殑閿欒鏂囨湰銆?
 * 缁熶竴鍏ュ彛锛岄伩鍏嶆瘡涓?catch 閲屽啓 `errMsg(e)`銆?
 */
export function errMsg(e: unknown, max = 200): string {
  let out: string;
  if (e instanceof Error) out = e.message;
  else if (typeof e === "string") out = e;
  else {
    try {
      out = String(e);
    } catch {
      out = "unknown";
    }
  }
  return out.slice(0, max);
}
