
// ---- 并入自 bytes.ts ----
// 字节与文本互转：WS 负载归一、十六进制、UUID 文本。
// 单独成文件的原因：全仓十几处只想拿 `toU8`/`toHex`，却必须 import 整个 `util` 门面才拿得到。

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

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

// ---- 并入自 sha224.ts ----
// SHA-224 的纯 JS 实现（Trojan 密码校验用；WebCrypto 不提供 SHA-224）。
// 与其它工具分开：64 字常量表 + 近 80 行位运算，读别的工具函数时不该被它挡住。

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
 * 功能：SHA-224 的补位——末尾追加 1 字节 0x80 与 8 字节大端比特长度，总长补齐到 64 的倍数。
 *
 * 为什么单独成一步：补位只取决于**输入长度**，与 64 字消息表、压缩轮函数完全无关；
 * 三步混在一条函数里时，想验证「长度换算有没有溢出」必须构造一份完整摘要再看结果。
 * 比特长度按两个 32 位字写（`len * 8` 超过 2^32 时必须进位到高字）。
 * @param {Uint8Array} data8 原始消息
 * @returns {Uint8Array} 补位后的消息（长度是 64 的整数倍）
 */
export function sha224Pad(data8: Uint8Array): Uint8Array {
  const len = data8.length;
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(data8);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  const bits = len * 8;
  // 高 32 位用除法（`>>> 0` 只能拿低 32 位），低 32 位直接截断
  dv.setUint32(total - 8, Math.floor(bits / 4294967296));
  dv.setUint32(total - 4, bits >>> 0);
  return buf;
}

/**
 * 功能：把一块 64 字节展开成 64 字消息表（前 16 字直接读，其余按递推式生成）。
 *
 * 递推式：`W[i] = W[i-16] + σ0(W[i-15]) + W[i-7] + σ1(W[i-2])`，全程 `>>> 0` 保 32 位。
 * @param {DataView} view 补位后消息的视图
 * @param {number} off 本块的起始字节偏移
 * @param {Uint32Array} words 复用同一块 64 字工作区（避免每块都分配）
 * @returns {void}
 */
export function sha224Words(view: DataView, off: number, words: Uint32Array): void {
  for (let i = 0; i < 16; i++) words[i] = view.getUint32(off + i * 4);
  for (let i = 16; i < 64; i++) {
    const a15 = words[i - 15];
    const a2 = words[i - 2];
    const s0 = (rotr(a15, 7) ^ rotr(a15, 18) ^ (a15 >>> 3)) >>> 0;
    const s1 = (rotr(a2, 17) ^ rotr(a2, 19) ^ (a2 >>> 10)) >>> 0;
    words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
  }
}

/**
 * 功能：64 轮压缩，把一块消息混进 8 字状态（就地更新）。
 *
 * SHA-224 与 SHA-256 只差初始值与输出截断，轮函数完全一样：这里不需要知道摘要长度。
 * @param {Uint32Array} state 8 字状态（会被就地修改）
 * @param {Uint32Array} words 本块的 64 字消息表
 * @returns {void}
 */
export function sha224Mix(state: Uint32Array, words: Uint32Array): void {
  // 8 个工作寄存器：整块只在末尾写回 state 一次，避免 64 轮里反复读写同一块内存
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  let f = state[5];
  let g = state[6];
  let h = state[7];

  for (let i = 0; i < 64; i++) {
    // Σ1 与选择函数 ch 走 e/f/g；T1 里加上本轮常量与消息字，全部 >>> 0 截回 32 位
    const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const ch = ((e & f) ^ (~e & g)) >>> 0;
    const t1 = (h + s1 + ch + SHA_K[i] + words[i]) >>> 0;
    // Σ0 与多数函数 maj 走 a/b/c；T2 只由这两位决定，与消息无关
    const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    const t2 = (s0 + maj) >>> 0;
    // 寄存器整体右移一格：d + T1 成为新的 e，T1 + T2 成为新的 a
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }

  // 与块起始状态按 32 位模加，得到本块之后的状态（就地更新调用方的数组）
  state[0] = (state[0] + a) >>> 0;
  state[1] = (state[1] + b) >>> 0;
  state[2] = (state[2] + c) >>> 0;
  state[3] = (state[3] + d) >>> 0;
  state[4] = (state[4] + e) >>> 0;
  state[5] = (state[5] + f) >>> 0;
  state[6] = (state[6] + g) >>> 0;
  state[7] = (state[7] + h) >>> 0;
}

/**
 * 功能：计算 SHA-224 摘要（纯 JS 实现，用于 Trojan 密码校验）。
 *
 * 三步各自成函数（补位 / 展开 / 压缩），这里只剩「按 64 字节滚动、取前 7 字输出」：
 * 状态必须 `slice()` 复制，直接改 `SHA_H224` 会污染下一次调用；取前 7 个字就是
 * SHA-224 与 SHA-256 的唯一差别（28 字节而不是 32 字节）。
 * @param {Uint8Array|ArrayBuffer} data 待摘要数据
 * @returns {Uint8Array} 28 字节摘要
 */
export function sha224Bytes(data: Uint8Array | ArrayBuffer) {
  // 补位后长度必是 64 的整数倍，按块滚动即可，不需要再判尾块
  const buf = sha224Pad(toU8(data));
  const view = new DataView(buf.buffer);
  // 状态按初值复制一份；工作区复用同一个 64 字数组
  const state = SHA_H224.slice();
  const words = new Uint32Array(64);
  for (let off = 0; off < buf.length; off += 64) {
    sha224Words(view, off, words);
    sha224Mix(state, words);
  }
  // 输出前 7 个 32 位字（大端），第 8 个字属于 SHA-256 的部分直接被丢掉
  const out = new Uint8Array(28);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 7; i++) odv.setUint32(i * 4, state[i]);
  return out;
}


// ---- 并入自 ws.ts ----
// 客户端 WS 那一侧的常量与生命周期动作：发送（含拆帧）、释放写锁与 socket。
// 名字说明用途 —— 这些以前都叫 `util`，读代码时看不出它们只服务 WS 出口。

export const WS_OPEN = 1;
export const WS_BUFFER_LIMIT = 4 * 1024 * 1024; // 下行缓冲 4MB 才背压（原 1MB 对慢客户端过严）
export const WS_STALL_MS = 180000; // 3 分钟没排空才判停滞（原 60 秒会误杀慢速大文件）
export const WS_MAX_BUFFER = 64 * 1024 * 1024; // 硬上限 64MB：7.425 的 A/B 证明断流与排队内存无关（64MB 与 16MB 同样 100% 中断），故保留对慢下载的容忍

/** 单帧上限：CF 对超大 WS 消息会直接断开，safeSend 按这个尺寸切片 */
export const WS_MSG_MAX = 256 * 1024;

/**
 * 功能：安全发送——WS 未开或已关闭时返回 false，由调用方决定收尾。
 * 以前这里静默 return：管道还得再搬最多 512 KB 才发现客户端走了，
 * 那段时间的 CPU 全白烧，断流归因也看不出是"谁先走"。
 * @param ws WebSocket 兼容对象
 * @param data 待发字节
 * @returns 是否真的发出去了（false = 客户端已经不在）
 */
export function safeSend(ws: WebSocketLike, data: Uint8Array): boolean {
  try {
    if (!ws || ws.readyState !== WS_OPEN) return false;
    // 大块拆帧：一次 send 超过约 1 MB 时运行时可能直接重置连接，
    // 表现就是「下载到 1 MB 左右必断」。
    if (data && data.length > WS_MSG_MAX) {
      for (let i = 0; i < data.length; i += WS_MSG_MAX) {
        ws.send(data.subarray(i, Math.min(i + WS_MSG_MAX, data.length)));
      }
    } else {
      ws.send(data);
    }
    return true;
  } catch (e) {
    /* 对端已关闭：与 readyState 检查同等语义，交给调用方收尾 */
    return false;
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

// ---- 并入自 timeouts.ts ----
// 三个「等多久算失败」的预算，以及给 Promise 加超时的唯一实现。
// 为什么集中：7.169–7.171 修「谁漏了超时」时每次都在调用点写一遍 `2500`，同一个预算散在十处；
// 集中之后「建连预算」只有一个可改点。

/**
 * 连接（`connect()`）与单发探活的统一上限，单位毫秒。
 *
 * 为什么要有这个常量：`connect()` 自身没有超时（Workers 的 socket 建连会一直挂着），
 * 而免费计划全局只有 6 个并发 `connect()` 名额 —— 一条挂死的连接会把名额吃到
 * 客户端放弃为止。7.169–7.171 修「谁漏了超时」时每次都在调用点写一遍 `2500`，
 * 于是同一个预算散在 10 处：改一处必然漏一处（与 7.154 的 `VT_TTL`、7.226 的
 * `PX_TTL` 是同一形状）。注意 `SC.STALL = 2500` 只是数字相同，语义是「卡顿当量」，
 * 不要拿它当建连上限。
 */
export const CONNECT_MS = 2500;

/**
 * 上游写（客户端 → 中继/源站）的单次分片上限。
 *
 * 数据面上唯一没有上限的操作就是它：中继接了 TCP 却从不读走数据时 socket.write() 永不返回，
 * 而客户端在上行一直在推、WS 缓冲一直涨 —— 这条连接会既不发数据也不结束，
 * 直到客户端自己放弃（服务端这边 socket、writer、inflight 计数全都留着）。
 * 30 秒足够覆盖正常慢上传的单个分片（分片上限 16MB 但要写进内核缓冲，不会卡这么久），
 * 超出就按黑洞出口处理。
 */
export const UP_STALL_MS = 30000;

/**
 * 首包写入的上限：**比数据面的 30 秒短得多**。
 *
 * 黑洞中继会接受 TCP 连接却永不读取，`write` 就此悬停；而客户端的耐心通常只有十几秒
 * （实测默认配置下 17.5 秒就放弃并重试）。首包只需要把 ClientHello/请求头送达，正常中继是毫秒级，
 * 8 秒还没写进去就说明这条中继不可用 —— 早失败让客户端有机会换一条，也让免费计划的
 * `connect()` 名额（全局 6 个）早点释放。数据面继续用 `UP_STALL_MS`：大块上传确实可能慢。
 */
export const FIRST_UP_MS = 8000;

/**
 * 首字节看门狗：从 `tAttach`（上游 socket 接上）到收到第一个下行字节的上限，单位毫秒。
 *
 * 为什么需要它：`pipeTo` 只有在流 close/error 时才回调 onClose，而「上游连上却一个字节
 * 都不转发」的黑洞出口会让流一直挂着 —— 补救链（换中继 / 直连兜底）永远不启动，
 * 客户端只能干等到自己的 30 秒定时器，表现为「TLS 握手阶段无任何下行字节」的长超时。
 * 实测 x.com 的失败几乎全是这一种。10 秒比客户端的 30 秒短得多，给补救链留足换路时间。
 * 收到任意字节或流一旦结束就撤销，正常连接完全不受影响。
 */
export const FIRST_BYTE_MS = 10000;

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

// ---- 并入自 concurrency.ts ----
// 有限并发地跑异步任务：既不让几十个用户同时打 DO，也不退化成串行。

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

// ---- 并入自 env-parse.ts ----
// 从 `Env` 里读配置的两个口子（密码绑定、影子流量比例）。
// 单独成文件的原因：它们都带「历史绑定名 / 非法值回落」这类必须解释的规则，混进通用工具里没人会读。

// 密码绑定的读取：优先 env.pwd（中性名），兼容老的 env[P_T]（历史绑定名见 P_T 的构造）。
// `Env` 故意没有索引签名（见 types/env.d.ts 末尾说明），所以这条历史别名必须显式转型取，
// 而不是靠 `env[P_T]` 从索引签名里混过去 —— 那个签名会让所有拼错的绑定名一起编译通过。
export const secretPwd = (env: Env) => {
  const legacy = (env as unknown as Record<string, unknown>)[P_T];
  return String((env && (env.pwd || legacy)) || "").trim();
};

/**
 * 影子流量默认比例（`env.pxShadow` 没配时用它）。
 * 这里**不**做「样本不足就抬比例」：探索由单层抽样自己负责（样本少 ⇒ 乐观面大 ⇒ 天然被抽），
 * 比例只决定「给站点画像补样本」的那点点流量。
 */
export const SHADOW_DEFAULT = 0.05;

/**
 * 解析 pxShadow。三处（选择器 / 控制器 / /proxyip）必须用同一套规则，
 * 否则会出现「面板写一个数、实际跑另一个数」的老毛病（7.x 之前就踩过）。
 *   未设置 / 非数字 → 默认 5%
 *   0            关闭探索（面板也显示 0%，两边一致）
 *   >1            按 1 处理（不放大）
 */
export function shadowRate(env: Env) {
  const raw = env ? env.pxShadow : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === "") return SHADOW_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SHADOW_DEFAULT;
  return Math.min(1, n);
}

// ---- 并入自 proto-names.ts ----
// 协议名在运行时拼装：源码里不出现明文，混淆后也不会残留（`tools/check-obf.js` 会查残留）。

// 协议名在运行时拼装，源码里不出现明文，混淆后也不会残留
export const P_V = String.fromCharCode(118, 108, 101, 115, 115); // 118 108 101 115 115
export const P_T = String.fromCharCode(116, 114, 111, 106, 97, 110); // 116 114 111 106 97 110

// ---- 并入自 errors.ts ----
// 把 catch 到的任意值转成一句可读文本（统一长度上限与 `unknown` 兜底）。

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

/**
 * 订阅默认 url-test 探测目标：gstatic（非 CF 托管）对 IPv6 出口也回 204，
 * 于是 v6 黑洞/被拒通道在测速里显示绿色、被默认组选中，打 CF 站就撞 737B 拒绝页。
 * 改用一个「对 v6 出口返回非 200」的 CF 托管站点做探测，v6 通道在测速阶段即被淘汰。
 * ?pu=<https-url> 可覆盖，避免把单一站点写死进逻辑。放在 core：clash 与 sing-box 两个渲染器共用。
 * @param url 订阅请求 URL（读 ?pu=）
 * @returns 探测 URL（非法/缺省回落到默认 CF 站点）
 */
export function probeUrlOf(url: URL): string {
  const raw = url.searchParams.get("pu") || "";
  return /^https:\/\/[^\s"]+$/.test(raw) ? raw : "https://x.com/";
}

// ---- 门面（对外导出面保持不变） ----
// 通用工具门面：`VERSION` 与「历史 import 路径」的再导出。
//
// 拆分前这里是一个 339 行的杂物抽屉（WS 常量、超时预算、字节编解码、SHA-224、密码解析、
// 影子比例、错误文本全挤在一起），拿一个字节转换也要 import 整个 util 门面，读不出「我要的是字节层」。
// 现在按「谁在用、解决什么问题」分成八个文件，这个名字只保留两件事：
// 1) 对外导出面不变（六十多个调用点零改动，「行为不变」由测试证明）；
// 2) `VERSION` 仍然只有这一处真源（`doc-audit` 与发版脚本都读它）。

export const VERSION = "7.432";

// `sha224` 单独一行：它 `import { toU8 } from "./bytes"`，若挂在 `bytes.ts` 的再导出里
// 就会形成 `bytes → sha224 → bytes` 的真循环（`tools/check-arch.js` 会报文件级循环）。
