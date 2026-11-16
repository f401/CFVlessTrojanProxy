/**
 * 环境绑定与请求元数据（env / request.cf）
 * 全局 ambient 声明：不 import/export，保持全仓库可见
 */

interface Env {
  // —— 身份 ——
  uuid: string;
  uuids?: string;
  pwd?: string; // Trojan 密码（裸密码或 uuid:密码）
  adminKey?: string;
  pageKey?: string;
  expireAt?: string;
  quotaBytes?: string;

  // —— 入口与订阅 ——
  nodes?: string;
  regions?: string;

  // —— 中转池 ——
  proxyip?: string;
  pxHosts?: string; // 强制走中转的域名名单（默认推特全系；空 = 关闭；* = 全部）
  pxDwellMin?: string;
  pxFailMax?: string;
  pxForceAt?: string;
  pxSchedH?: string;
  /** 事实开关（plain_text）：all / none / 逗号分隔的 eg,ps,cap,blk,dns；未配置 = 全开 */
  facts?: string;
  pxShadow?: string;
  defaultMode?: string;
  cfIpv6?: string;

  // —— 存储 ——
  STATS: KVNamespace;
  METER: DurableObjectNamespace;
  kek?: string;

  // —— 付费计划/自建调优（免费计划不用配）——
  /**
   * 抬高一轮的探活子请求上限（默认 `SC.SCAN_SUB = 48`，免费计划硬顶 50）。
   * 只在付费计划下有意义：`src/px/pool.ts` 的 `cronScan` 会把它夹进 `[12, SCAN_MAX]`。
   */
  scanSub?: string;
  /**
   * 覆盖池子源列表（逗号分隔的 URL）：`src/px/probe.ts` 的 `sources` 优先用它，
   * 非法项回退内置的 6 个源。
   */
  poolSrc?: string;
  // 这里**故意不加** k 索引签名（string → unknown）：它会让 `env.scanSub` 这种拼错/未声明的
  // 绑定也编译通过，运行时读到 undefined、功能静默失效（v7.207）。新增绑定必须先在这里声明。
}

/** request.cf 里我们用到的字段 */
interface CfMeta {
  colo?: string;
  clientTcpRtt?: number;
  asn?: number;
  city?: string;
  edgeL4?: { deliveryRate?: number };
  [k: string]: unknown;
}
