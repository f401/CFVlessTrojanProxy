/** 单个请求的上下文：路由函数只认这个对象，不再各自从 fetch 里抓变量 */
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
}

/** 已通过 UUID 校验的上下文 */
export interface UserCtx extends RouteCtx {
  id: string;
  /** RTT 学习表：订阅排序用 */
  learned: Record<string, RttEntry>;
  /** 地区列表 */
  regions: string[];
}

