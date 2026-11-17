// 候选池准备：冷 isolate 里内存池是空的（新机房 / 刚回收），而候选池早就由别的机房提交进了 KV。
// 这一步只做「让池子能用」，不参与挑谁 —— 挑在 pick-site / pick-pref / pickpath 三处。

import { ensurePool, pxGet } from "./pool";
import { seedAlive } from "./warm";
import { S } from "../core/state";

/**
 * 功能：按需把候选池拉起来，并保证存活表至少被起搏过一次。
 * 所有等待都有上限：这里任何一秒都是用户等首字节的秒数。
 * @param {object} env Worker 环境
 * @returns {Promise<void>} 池子可用（或已尽力）时 resolve
 */
export async function ensureReady(env: Env): Promise<void> {
  // 只看「池子确实没有」且距上次尝试超过 60 秒：池子有就绝不读 KV，冷启动也不会每个请求都读一次
  if (!S.pool.length && Date.now() - (S.poolAt || 0) > 60000) {
    S.poolAt = Date.now();
    // 最多等 700ms：ensurePool 会读 KV 代际键，必要时还要去公开源抓列表，
    // 实测在冷 isolate 上能拖到 2–4 秒——那是用户已经在等首字节的时间，
    // 不能整段押在这里。超时就先放行（有 S.alive 就用，没有就走直连），
    // 让后台继续把池子补齐，下一条连接就能用上。
    await Promise.race([
      ensurePool(env).catch(() => 0),
      new Promise<void>((r) => setTimeout(r, 700)),
    ]);
  }
  // 池子有了但一条都没探活过：就地起搏几个（5 分钟节流），否则 relays() 只能回空，
  // CF 托管目标会一路直连下去。**不 await**：探活会占 300–2200ms，挡在首字节前面
  // 会把 p50 拖到 6 秒（实测 7.63）。7.67 曾试过「最多等 1500ms」，tput 仍是 10/20 而
  // p50 从 1.9s 涨到 3.1s —— 说明探活成功只证明「TCP 通」，不证明「出口是 v4」，
  // 等它没用。要按出口地址族排中继，得在探测时顺便问中继「你出去是什么地址」。
  if (!S.alive.size) void seedAlive(env).catch(() => {});
  // 补游标（`S.curs`）与两代候选的关系：pxGet 是唯一入口，挑路之前必须调过一次
  await pxGet(env);
}
