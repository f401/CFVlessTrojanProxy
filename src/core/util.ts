/* 闁氨鏁ゅ銉ュ徔閿涙氨绱惍?閸濆牆绗?鐎涙濡径鍕倞/WS 閸欐垿鈧?*/
export const WS_OPEN = 1;
export const WS_BUFFER_LIMIT = 1024 * 1024; // 娑撳顢戦崣鎴︹偓浣虹处閸愯尪绉存潻?1MB 鐏忓崬绱戞慨瀣剹閸?
export const WS_STALL_MS = 60000; // 鐎广垺鍩涚粩顖欑閺冭埖鏁规稉宥呭З瀵板牆鐖剁憴渚婄礉缂佹瑥鍩?60 缁?
export const WS_MAX_BUFFER = 16 * 1024 * 1024; // 绾兛绗傞梽鎰剁窗閸掝偄娲滄稉鍝勵吂閹撮顏幈銏犳皑閹跺﹣绗呮潪鑺ュ笌娴?
export const VERSION = "7.29";
export const enc = new TextEncoder();
export const dec = new TextDecoder();

/* ==================================================================
 * 鎼?  鐢悂鍣烘稉搴′紣閸?
 * ================================================================== */

export const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

// 鐎靛棛鐖滅紒鎴濈暰閻ㄥ嫯顕伴崣鏍电窗娴兼ê鍘?env.pwd閿涘牅鑵戦幀褍鎮曢敍澶涚礉閸忕厧顔愰懓浣烘畱 env[P_T]
export const secretPwd = (env: Env) => String((env && (env.pwd || env[P_T])) || "").trim();

/** 瑜板崬鐡欏ù渚€鍣烘妯款吇濮ｆ柧绶ラ敍姘涧閸︺劊鈧苯缍嬮崜宥堝Ν閻愯鐗遍張顑跨瑝鐡掔偨鈧秵妞傞幍宥嗗絹閸楀洤鍩?SC.EXPLORE_MAX */
export const SHADOW_DEFAULT = 0.05;

/**
 * 鐟欙絾鐎?pxShadow閵嗗倷绗佹径鍕剁礄闁瀚ㄩ崳?/ 閹貉冨煑妞?/ /proxyip閿涘绻€妞よ崵鏁ら崥灞肩婵傛顫夐崚娆欑礉
 * 閸氾箑鍨棃銏℃緲閺勫墽銇?10%閵嗕礁鐤勯梽鍛扮獓 5%閿涘本鍨ㄩ懓?pxShadow=0 閺冭埖妯夌粈鐑樺灇 10%閵?
 *   閺堫亣顔曠純?/ 闂堢偞纭?閳?姒涙顓?5%
 *   閺勬儳绱?0       閳?0閿涘牆鍙ч梻顓熷赴缁鳖澁绱?
 *   >1           閳?1閿涘牆鐨濇い璁圭礆
 */
export function shadowRate(env: Env) {
  const raw = env ? env.pxShadow : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === "") return SHADOW_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SHADOW_DEFAULT;
  return Math.min(1, n);
}

/**
 * 閸欘垶鈧娈戠拠閿嬬湴鐡掑懏妞傛穱鈥冲娇閿涙俺绻嶇悰灞炬濞屸剝婀?AbortSignal.timeout 閺冩儼绻戦崶?undefined閿涘牅绗夎ぐ鍗炴惙鐠囬攱鐪伴敍澶堚偓?
 * 閸欘亞鏁ゆ禍?cron / 鐠囧﹥鏌囨潻娆戣"閹鳖澀绔撮悙瑙勭梾閸忓磭閮撮敍灞肩稻娑撳秷鍏橀弮鐘绘缁?閻ㄥ嫬顦婚柈?fetch閵?
 */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  const AS =
    typeof AbortSignal === "undefined" ? null : (AbortSignal as unknown as { timeout?: (n: number) => AbortSignal });
  return AS && typeof AS.timeout === "function" ? AS.timeout(Math.max(1, ms)) : undefined;
}

/**
 * 缂?Promise 閸旂姾绉撮弮璁圭礉楠炶泛婀紒鎾存将閺冭埖绔婚幒澶婄暰閺冭泛娅掗妴?
 * 閻╁瓨甯撮悽?Promise.race 娴兼碍濡?setTimeout 閻ｆ瑥婀柇锝夊櫡閿涙矮绔存潪?cron 閹?60 娑擃亣濡悙鐧哥礉
 * 鐏忚鲸妲?60 娑擃亜顦挎担娆戞畱 4 缁夋帒鐣鹃弮璺烘珤閿涘本妫﹂崡?CPU 閸欏牊瀚嬮梹鑳嚞濮瑰倻鏁撻崨钘夋噯閺堢喆鈧?
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
 * 閺堝妾洪獮璺哄絺閸︽媽绐囧鍌涱劄娴犺濮熼敍姘＆娑撳秷顔€ 50 娑擃亞鏁ら幋宄版倱閺冭埖澧?DO閿涘奔绡冩稉宥夆偓鈧崠鏍ㄥ灇娑撹尪顢戦妴?
 * 妞ゅ搫绨稉宥勭箽鐠囦緤绱濈拫鍐暏閺傜懓褰ч崗鍐茬妇閵嗗苯鍙忛柈銊ョ暚閹存劑鈧秲鈧?
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

// 閸楀繗顔呴崥宥呮躬鏉╂劘顢戦弮鑸靛鐟佸拑绱濆┃鎰垳闁插奔绗夐崙铏瑰箛閺勫孩鏋冮敍灞捐穿濞ｅ棗鎮楁稊鐔剁瑝娴兼碍鐣悾?
export const P_V = String.fromCharCode(118, 108, 101, 115, 115); // 118 108 101 115 115
export const P_T = String.fromCharCode(116, 114, 111, 106, 97, 110); // 116 114 111 106 97 110

/**
 * 鐎涙濡弫鎵矋 閳?鐏忓繐鍟撻崡浣稿彋鏉╂稑鍩楃€涙顑佹稉灞傗偓?
 * @param {Uint8Array|ArrayBuffer|number[]} u8 鐎涙濡惔蹇撳灙
 * @returns {string} 閸椾礁鍙氭潻娑樺煑娑撹绱濋梹鍨娑撳搫鐡ч懞鍌涙殶 鑴?2
 */
export function toHex(u8: Uint8Array) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += HEX[u8[i]];
  return s;
}

/**
 * 閹?WebSocket 濞戝牊浼?ArrayBuffer/TypedArray 缂佺喍绔撮幋?Uint8Array閵?
 * @param {unknown} d 閸樼喎顫愬☉鍫熶紖娴?
 * @returns {Uint8Array} 鐎涙濡憴鍡楁禈
 */
export function toU8(d: unknown) {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (typeof d === "string") return enc.encode(d);
  return new Uint8Array(0);
}

/**
 * 16 鐎涙濡?閳?閺嶅洤鍣?UUID 鐎涙顑佹稉璇х礄8-4-4-4-12閿涘鈧?
 * @param {Uint8Array} b 闂€鍨閼峰啿鐨?16 閻ㄥ嫬鐡ч懞鍌涙殶缂?
 * @returns {string} 鐏忓繐鍟?UUID
 */
export function uuidFromBytes(b: Uint8Array) {
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * 閸?WebSocket 閸欐垿鈧焦鏆熼幑顕嗙幢鏉╃偞甯村鎻掑彠闂傤厽鍨ㄩ崣鎴︹偓浣搞亼鐠愩儲妞傞棃娆撶帛韫囩晫鏆愰妴?
 * @param {WebSocket} ws 閻╊喗鐖ｆ潻鐐村复
 * @param {Uint8Array|ArrayBuffer} data 瀵板懎褰傞柅浣规殶閹?
 * @returns {void}
 */
export const WS_MSG_MAX = 256 * 1024; // 閸楁洖鎶氭稉濠囨閿涙F 鐎电绉存径?WS 濞戝牊浼呮导姘辨纯閹恒儲鏌囬柧?

export function safeSend(ws: WebSocketLike, data: Uint8Array) {
  try {
    if (!ws || ws.readyState !== WS_OPEN) return;
    // 婢堆冩健閹峰棗鎶氶敍姘濞?send 鐡掑懓绻冪痪?1 MB 閺冩儼绻嶇悰灞炬閸欘垵鍏橀惄瀛樺复闁插秶鐤嗘潻鐐村复閿?
    // 鐞涖劎骞囩亸杈ㄦЦ"娑撳娴囬崚?1 MB 瀹革箑褰歌箛鍛焽"閵?
    if (data && data.length > WS_MSG_MAX) {
      for (let i = 0; i < data.length; i += WS_MSG_MAX) {
        ws.send(data.subarray(i, Math.min(i + WS_MSG_MAX, data.length)));
      }
    } else {
      ws.send(data);
    }
  } catch (e) {
    /* 鐎靛湱顏鎻掑彠闂傤叏绱濊箛鐣屾殣 */
  }
}

/**
 * 闁插﹥鏂佹稉鈧▎陇绻涢幒銉﹀瘮閺堝娈戦崗銊╁劥鐠у嫭绨敍鍫濆晸闁?+ 娑撳﹥鐖?socket閿涘鈧?
 * @param {object} st 鏉╃偞甯撮悩鑸碘偓浣割嚠鐠?
 * @returns {void}
 */
export function releaseAll(st: { writer: { releaseLock(): void } | null; sock: { close(): void } | null } | null) {
  if (!st) return;
  try {
    if (st.writer) st.writer.releaseLock();
  } catch (e) {
    /* 娴犲秵婀侀張顏勭暚閹存劗娈戦崘娆欑礉韫囩晫鏆?*/
  }
  st.writer = null;
  closeQuietly(st.sock);
  st.sock = null;
}

/**
 * 闂堟瑩绮崗鎶芥４ socket閿涘苯鎷烽悾銉╁櫢婢跺秴鍙ч梻顓濋獓閻㈢喓娈戝鍌氱埗閵?
 * @param {Socket|null} sock 瀵板懎鍙ч梻顓犳畱鏉╃偞甯?
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
 * 鎼?  SHA-224閿涘湵rojan 闁村瓨娼堥悽顭掔幢WebCrypto 娑撳秵褰佹笟?SHA-224閿?
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
 * 鐠侊紕鐣?SHA-224 閹芥顩﹂敍鍫㈠嚱 JS 鐎圭偟骞囬敍宀€鏁ゆ禍?Trojan 鐎靛棛鐖滈弽锟犵崣閿涘鈧?
 * @param {Uint8Array} data 瀵板懏鎲崇憰浣规殶閹?
 * @returns {Uint8Array} 28 鐎涙濡幗妯款洣
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
 * 鎼?  闁村瓨娼?
 *    VLESS : env.uuids / env.uuid  閳ユ柡鈧?闁褰块崚鍡涙閻?UUID 閸掓銆?
 *    鐎靛棛鐖滅紒鎴濈暰: env.pwd            閳ユ柡鈧?"uuid:password,uuid:password"
 *            鐎靛棛鐖滈崷?isolate 妫ｆ牗顐兼担璺ㄦ暏閺冨墎鐣婚幋?sha224 閸濆牆绗囬敍灞炬Ё鐏忓嫬娲?uuid
 * ================================================================== */

/**
 * 閹?catch 閸掓壆娈戞禒缁樺壈閸婅壈娴嗛幋鎰閸欍儱褰茬拠鑽ゆ畱闁挎瑨顕ら弬鍥ㄦ拱閵?
 * 缂佺喍绔撮崗銉ュ經閿涘矂浼╅崗宥嗙槨娑?catch 闁插苯鍟?`errMsg(e)`閵?
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
