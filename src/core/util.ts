// 通用工具门面：`VERSION` 与「历史 import 路径」的再导出。
//
// 拆分前这里是一个 339 行的杂物抽屉（WS 常量、超时预算、字节编解码、SHA-224、密码解析、
// 影子比例、错误文本全挤在一起），拿一个字节转换也要 import 整个 util 门面，读不出「我要的是字节层」。
// 现在按「谁在用、解决什么问题」分成八个文件，这个名字只保留两件事：
// 1) 对外导出面不变（六十多个调用点零改动，「行为不变」由测试证明）；
// 2) `VERSION` 仍然只有这一处真源（`doc-audit` 与发版脚本都读它）。

export const VERSION = "7.291";

export * from "./bytes";
export * from "./concurrency";
export * from "./env-parse";
export * from "./errors";
export * from "./proto-names";
// `sha224` 单独一行：它 `import { toU8 } from "./bytes"`，若挂在 `bytes.ts` 的再导出里
// 就会形成 `bytes → sha224 → bytes` 的真循环（`tools/check-arch.js` 会报文件级循环）。
export * from "./sha224";
export * from "./timeouts";
export * from "./ws";
