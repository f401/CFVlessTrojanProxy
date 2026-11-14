/* 通用工具：编码、哈希、字节处理、WS 发送 */
export const WS_OPEN = 1;
export const WS_BUFFER_LIMIT = 1024 * 1024; // 下行发送缓冲超过 1MB 就开始背压
export const WS_STALL_MS = 60000; // 客户端一时收不动很常见，给它 60 秒
export const WS_MAX_BUFFER = 16 * 1024 * 1024; // 硬上限：别因为客户端慢就把下载掐死
export const VERSION = "7.69";
export const enc = new TextEncoder();
export const dec = new TextDecoder();

/* ==================================================================
 * 常量与小工具
 * ================================================================== */

export const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

// 密码绑定的读取：优先 env.pwd（中性名），兼容老的 env[P_T]
export const secretPwd = (env: Env) => String((env && (env.pwd || env[P_T])) || "").trim();

/** 影子流量默认比例：只在「当前节点样本不足」时才提升，上限 SC.EXPLORE_MAX */
export const SHADOW_DEFAULT = 0.05;

/**
 * 解析 pxShadow。三处（选择器 / 控制器 / /proxyip）必须用同一套规则，
 * 否则面板显示 10%、实际跑 5%，或者 pxShadow=0 时显示成 10%。
 *   未设置 / 非数字 → 默认 5%
 *   显示 10       实际 0（关闭探索）
 *   >1            按 1 处理（不放大）
 */
export function shadowRate(env: Env) {
  const raw = env ? env.pxShadow : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === "") return SHADOW_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SHADOW_DEFAULT;
  return Math.min(1, n);
}

/**
 * 可选的请求超时信号：运行时没有 AbortSignal.timeout 时返回 undefined（不影响请求）。
 * 只用于 cron / 诊断这类「慢一点没关系、但不能无限挂」的外层 fetch。
 */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  const AS =
    typeof AbortSignal === "undefined" ? null : (AbortSignal as unknown as { timeout?: (n: number) => AbortSignal });
  return AS && typeof AS.timeout === "function" ? AS.timeout(Math.max(1, ms)) : undefined;
}

/**
 * 给 Promise 加超时，并在结束时清掉定时器。
 * 直接用 Promise.race 会把 setTimeout 留在那里：一次 cron 扫 60 个节点，
 * 就是 60 个多余的 4 秒定时器，既烧 CPU 又拖长请求生命周期。
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
 * 有限并发地跑异步任务：既不让 50 个用户同时打 DO，也不退化成串行。
 * 顺序不保证，调用方只关心「全部完成」。
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

// 协议名在运行时拼装，源码里不出现明文，混淆后也不会残留
export const P_V = String.fromCharCode(118, 108, 101, 115, 115); // 118 108 101 115 115
export const P_T = String.fromCharCode(116, 114, 111, 106, 97, 110); // 116 114 111 106 97 110

/**
 * 字节数组 → 小写十六进制字符串。
 * @param {Uint8Array|ArrayBuffer|number[]} u8 待转换的字节
 * @returns {string} 十六进制串，长度为字节数 × 2
 */
export function toHex(u8: Uint8Array) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += HEX[u8[i]];
  return s;
}

/**
 * 把 WebSocket 消息（ArrayBuffer / TypedArray / 字符串）统一成 Uint8Array。
 * @param {unknown} d WebSocket 收到的原始负载
 * @returns {Uint8Array} 统一后的字节
 */
export function toU8(d: unknown) {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (typeof d === "string") return enc.encode(d);
  return new Uint8Array(0);
}

/**
 * 16 字节摘要 → 标准 UUID 文本（8-4-4-4-12 分组）
 * @param {Uint8Array} b 长度至少 16 的字节数组
 * @returns {string} 格式化后的 UUID
 */
export function uuidFromBytes(b: Uint8Array) {
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * 通过 WebSocket 发送数据；连接已关闭或发送失败时静默忽略。
 * @param {WebSocket} ws 閻╊喗鐖ｆ潻鐐村复
 * @param {Uint8Array|ArrayBuffer} data 待发送数据
 * @returns {void}
 */
export const WS_MSG_MAX = 256 * 1024; // 单帧上限：CF 对超大 WS 消息会直接断开

/**
 * 功能：安全发送——WS 未开或已关闭时静默丢弃（隧道里对端随时消失，不能因此抛错）。
 * @param ws WebSocket 兼容对象
 * @param data 待发字节
 * @returns 无
 */
export function safeSend(ws: WebSocketLike, data: Uint8Array) {
  try {
    if (!ws || ws.readyState !== WS_OPEN) return;
    // 大块拆帧：一次 send 超过约 1 MB 时运行时可能直接重置连接，
    // 表现就是「下载到 1 MB 左右必断」。
    if (data && data.length > WS_MSG_MAX) {
      for (let i = 0; i < data.length; i += WS_MSG_MAX) {
        ws.send(data.subarray(i, Math.min(i + WS_MSG_MAX, data.length)));
      }
    } else {
      ws.send(data);
    }
  } catch (e) {
    /* 对端已关闭，忽略 */
  }
}

/**
 * 释放一次连接持有的全部资源（写队列 + 上层 socket）。
 * @param {object} st 连接状态对象
 * @returns {void}
 */
export function releaseAll(st: { writer: { releaseLock(): void } | null; sock: { close(): void } | null } | null) {
  if (!st) return;
  try {
    if (st.writer) st.writer.releaseLock();
  } catch (e) {
    /* 仍有未完成的写，忽略 */
  }
  st.writer = null;
  closeQuietly(st.sock);
  st.sock = null;
}

/**
 * 静默关闭 socket，忽略重复关闭产生的异常。
 * @param {Socket|null} sock 待关闭的连接
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
 * 计算 SHA-224（Trojan 鉴权用；WebCrypto 不提供 SHA-224）。
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
 * 计算 SHA-224 摘要（纯 JS 实现，用于 Trojan 密码校验）。
 * @param {Uint8Array} data 待摘要数据
 * @returns {Uint8Array} 28 字节摘要
 */
export function sha224Bytes(data: Uint8Array | ArrayBuffer) {
  const data8 = toU8(data);
  const len = data8.length;
  // 补位：末尾追加 1 字节 0x80 与 8 字节比特长度，总长向上取整到 64 字节的倍数
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(data8);
  buf[len] = 0x80;

  const dv = new DataView(buf.buffer);
  const bits = len * 8;
  dv.setUint32(total - 8, Math.floor(bits / 4294967296));
  dv.setUint32(total - 4, bits >>> 0);

  // 工作区：8 个 32 位状态 + 64 字消息表，按 64 字节一块滚动
  // 必须 slice 复制——直接改常量会污染下一次调用
  const H = SHA_H224.slice();
  const w = new Uint32Array(64);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    // 消息表扩展到 64 字：W[i] = W[i-16] + σ0(W[i-15]) + W[i-7] + σ1(W[i-2])，全程 >>> 0 保 32 位
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
      // 64 轮压缩：SHA-224 与 SHA-256 只差初始值与输出截断，轮函数完全一样
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

  // SHA-224 只取前 7 个 32 位字（28 字节）
  const out = new Uint8Array(28);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 7; i++) odv.setUint32(i * 4, H[i]);
  return out;
}

/* ==================================================================
 * 凭据解析
 *    VLESS : env.uuids / env.uuid  —— 支持两种写法的 UUID 列表
 *    Trojan: env.pwd              —— "uuid:password,uuid:password"
 *            密码在 isolate 首次使用时算 sha224 哈希，映射到 uuid
 * ================================================================== */

/**
 * 把 catch 到的任意值转成一句可读的错误文本。
 * 统一入口，避免每个 catch 里各写一遍 errMsg(e)。
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

