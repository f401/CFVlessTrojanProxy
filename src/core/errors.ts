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
