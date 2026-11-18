/** 单个请求的上下文：路由函数只认这个对象，不再各自从 fetch 里抓变量 */
import type { BudgetedIO } from "../core/budgeted-io";

export interface RouteCtx {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  host: string;
  seg: string[];
  first: string;
  auth: Auth;
  pageKey: string;
  keyOk: boolean;
  cf: CfMeta;
  /** 本次请求的额度账本（connect / 子请求 / DO），交给拨号器与探测使用 */
  budget: BudgetedIO;
}

/** 已通过 UUID 校验的上下文 */
export interface UserCtx extends RouteCtx {
  id: string;
  /** RTT 学习表：订阅排序用 */
  learned: Record<string, RttEntry>;
  /** 地区列表 */
  regions: string[];
}

