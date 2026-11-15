import { SC } from "./const";

/**
 * 功能：把「值是最早使用时间」的按站点表压回上限，防止客户端可控的站点名把内存撑大。
 *
 * 为什么需要：`S.bigByHost`、`S.bigChan`、`S.cfHost`、`S.vtSent` 的键都是客户端
 * 请求里的目标站点名（`CONNECT`/ClientHello 带过来的），不是有限集合。一个长期
 * 存活的 isolate 见够几万个不同站点就会一直涨，而且没有任何一条读路径会因此报错，
 * 只有内存水位慢慢上去。`Policy.pin/seq` 在 7.140 已经这样处理过，这里把同一套
 * 规则抽出来给其余几张表复用。
 * @param m 目标表（值越小 = 越旧 / 越早过期）
 * @param cap 最多保留几行，默认 `SC.HOST_MEM_MAX`
 * @returns 无
 */
export function trimAged<K>(m: Map<K, number>, cap: number = SC.HOST_MEM_MAX): void {
  const over = m.size - cap;
  if (over <= 0) return;
  // 值升序 = 最旧在前：按顺序删掉超出的那几条，剩下的就是最近活跃的
  const byAge = [...m.entries()].sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < over && i < byAge.length; i++) m.delete(byAge[i][0]);
}

/**
 * 功能：删掉「值是过期时刻」的表里已经过期的键。
 *
 * 与 `trimAged` 的区别：那种表的值是**过去**的时间戳（越大越新），这种表的值是
 * **未来**的时间戳（越小越早过期）；判断过期必须 `<= now`，不能按大小排序混用。
 * @param m 目标表（值 = 过期时刻的毫秒时间戳）
 * @param now 当前时间，默认 `Date.now()`
 * @returns 删掉的行数
 */
export function dropExpired<K>(m: Map<K, number>, now: number = Date.now()): number {
  let n = 0;
  for (const [k, exp] of m) {
    if (exp <= now) {
      m.delete(k);
      n += 1;
    }
  }
  return n;
}
