// 兼容垫片：真实实现在 core/tlsprobe.ts（DO 也要用，store 不能依赖 route）。
export { probeTls } from "../core/tlsprobe";
export type { TlsProbeResult } from "../core/tlsprobe";
