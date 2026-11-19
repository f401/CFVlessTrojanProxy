/**
 * 全仓共用的枚举：把此前散落在各文件里的「魔法数字 / 魔法字符串」收成一处。
 *
 * 为什么要有这个文件：判定状态 0/1/2/3 在 7.162 与 7.164 两轮各丢过一次维度 ——
 * 症状相同：某个跨层传值的点写死了 `2`，把 `dead`(3，硬排除) 静默降级成 `blocked`(2，×6 降权)，
 * 一条连不上的中继于是继续占着 `connect()` 名额。裸数字读不出这层语义，改一行的代价
 * 看起来是「等价重写」，而单测与类型都拦不住。用枚举之后，比较处读作 `St.Dead`，
 * 传错层会被 `tsc` 抓住（`St` 是值也是类型）。
 *
 * 为什么曾经保留 `StLike` / `ModeLike` 这类宽松联合类型：仓库里还有几十处调用点按数字（`2`）
 * 或字符串（`"lat"`）传参，一次性改成枚举成员会把改动面扩到整仓 —— 那一轮的 diff 就不再是
 * 「修一条缺陷」，而是一次无法逐行复核的重构。到 7.362 这些调用点已经全部收敛成枚举比较，
 * 两个别名不再有使用者，因此删掉（保留这段说明，避免后来者再把它们加回来）。
 */

/** 判定状态：0 未知 / 1 可用 / 2 被拦 / 3 连不上 */
export enum St {
  Unknown = 0,
  Reachable = 1,
  Blocked = 2,
  Dead = 3,
}

/** 传输模式：吞吐优先 / 延迟优先 */
export enum Mode {
  Throughput = "tput",
  Latency = "lat",
}

/**
 * 节点 IP 的线路类型（6 源质量探测的归一化结果）。
 *
 * 为什么用枚举而不是裸字符串：`residential`/`hosting` 这类值要在「探测 → seed 落盘 →
 * 订阅命名 → 选路分层」四个环节之间传递，任何一处写错字符串都会静默退化成 Unknown。
 * 用枚举后 `tsc` 能拦住拼错的成员名。
 */
export enum IpKind {
  Residential = "residential",
  Mobile = "mobile",
  Business = "business",
  Hosting = "hosting",
  Unknown = "unknown",
}

/**
 * 节点 IP 的质量等级。判定口径（与 FlClash 一致）：
 * - residential / mobile / business → Good
 * - hosting → Normal
 * - isTor / isAbuser → Risky（硬排除）
 * - isProxy / isVpn 只标记、不降级（很多住宅出口本身就是代理）
 */
export enum IpLevel {
  Good = "good",
  Normal = "normal",
  Risky = "risky",
}

/**
 * 地址族。成员名写成 `IPv4`/`IPv6` 而不是 `V4`/`V6`：仓库的命名门禁要求成员名 ≥3 字符，
 * 两字符名会被拦（历史上有 `op` → `action` 的先例）。值仍用短写 `v4`/`v6` 便于落盘。
 */
export enum IpFamily {
  IPv4 = "v4",
  IPv6 = "v6",
}

