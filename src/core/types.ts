/**
 * 语义别名：把「单位」与「含义」写进类型名里，让签名自己解释自己。
 *
 * 为什么用别名而不是 branded type：这些量几乎都会穿过 JSON / KV / DO 存储边界
 * （`JSON.parse` 回来是 `number`），branded type 会在每个边界上要求一次断言，
 * 断言多了反而没人看。别名只求「读签名时知道这是毫秒还是秒、是地址还是主机名」；
 * 单位错配靠 `tools/check-units` 一类的肉眼扫描与判据锁，不靠类型系统。
 */

/** 绝对时刻（`Date.now()` 的口径，毫秒） */
export type EpochMs = number;

/** 一段时长（毫秒），不能与 `EpochMs` 相加混用同一个变量名 */
export type DurationMs = number;

/** 每秒千字节（`Connection` 只在真正传了 ≥1MB 时才算得出来） */
export type KiloBytesPerSec = number;

/** 样本条数（EWMA 的有效权重，通常按 8 封顶） */
export type SampleCount = number;

/** 中继出口地址（IPv4 字面量，或 `[v6]` 里那段地址；不带端口） */
export type RelayIp = string;

/** 目标站点：主机名或 IP 字面量（客户端在 CONNECT / ClientHello 里给的） */
export type HostName = string;

/** 节点键：`地址:端口`（池子与存活表的键形状） */
export type NodeKey = string;

/** 通道键：`d` 表示直连，`r:<ip>` 表示经某条中继（与 `src/route/channel.ts` 同义） */
export type ChanToken = string;
