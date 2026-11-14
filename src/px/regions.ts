import { aliveList } from "./pool";

/**
 * 得出订阅里要输出的地区列表（配置固定值或按 alive 自动推断）。
 * @param {object} env Worker 环境
 * @returns {Promise<string[]>} 最多 6 个两位国家码
 */
export async function regionListAsync(env: Env) {
  const raw = String(env.regions || "").trim();
  if (raw && raw.toLowerCase() !== "auto") {
    const out: string[] = [];
    for (const x of raw.split(",")) {
      const cc = x.trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(cc) && !out.includes(cc)) out.push(cc);
      if (out.length >= 6) break;
    }
    return out;
  }
  const list = await aliveList(env);
  const set: string[] = [];
  for (const x of list) {
    const cc = (x.cc || "").toUpperCase();
    if (cc && !set.includes(cc)) set.push(cc);
  }
  return set.slice(0, 6);
}

