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
