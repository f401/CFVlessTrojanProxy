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
