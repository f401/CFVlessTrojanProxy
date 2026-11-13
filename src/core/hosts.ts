/**
 * 目标站 → 走不走 proxyip 的策略。
 *
 * 背景：Cloudflare 托管的站点（x.com / twitter.com 等）从 Worker 里直连会被自家边缘
 * 当成回环，典型表现是「首个 TLS 记录被静默丢弃（0 字节关闭）」或「偶发 403」。
 * 这类站点的正确做法是**一开始就走 proxyip**，不要先赌一次直连：
 *   · 赌输的代价是用户看到的第一屏白等 0.3~1s 甚至超时；
 *   · 而 proxyip 这一跳本身对 CF 托管站是等效的（SNI 由客户端 TLS 携带）。
 *
 * 策略（v6.45 起不再写死域名）：
 *   ① 通用判据：目标解析到 Cloudflare 网段 → 一开始就走中转（isCfHost，见 proxy/dial.ts）；
 *   ② 失败学习：直连 0 字节关闭过的站点，6 小时内直接走中转（S.needPx）；
 *   ③ 手动覆盖：pxHosts 名单 / "*" 全开 / 空串只用 ① ②；
 *   ④ 调试参数：?px=1 强制中转，?px=0 强制直连。
 */


/**
 * 解析生效的中转名单。
 * @param {object} env Worker 环境
 * @returns {string[]} 域名数组（已小写、去空项）
 */
export function pxHostList(env: Env): string[] {
  const raw = env.pxHosts;
  // 未配置 → 空名单：是否走中转由「目标是否 CF 托管」和失败学习决定
  if (raw === undefined || raw === null) return [];
  const out: string[] = [];
  for (const part of String(raw).split(",")) {
    const h = part.trim().toLowerCase().replace(/\.$/, "");
    if (h) out.push(h);
  }
  return out;
}

/**
 * 这个目标是否属于「必须先走中转」。
 * @param {object} env Worker 环境
 * @param {string} host 目标域名/IP
 * @returns {boolean} 命中名单返回 true
 */
export function isPxHost(env: Env, host: string): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/\.$/, "");
  for (const d of pxHostList(env)) {
    if (d === "*") return true;
    if (d.startsWith(".")) {
      // 只匹配子域：.x.com 命中 www.x.com，不命中 x.com
      if (h.endsWith(d)) return true;
      continue;
    }
    // 普通条目：既匹配自身，也匹配它的子域（x.com 命中 x.com / www.x.com）
    if (h === d || h.endsWith("." + d)) return true;
  }
  return false;
}
