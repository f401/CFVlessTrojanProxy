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
  pxShadow?: string;
  defaultMode?: string;
  cfIpv6?: string;

  // —— 存储 ——
  STATS: KVNamespace;
  METER: DurableObjectNamespace;
  kek?: string;

  adminHash?: string;
  [k: string]: unknown;
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
