import { renderAdminHint, renderHtml, renderLogin } from "./panel";
import { renderAdmin } from "./panel-admin";
import { renderStatsHtml } from "./panel-stats";

export interface StatsIn {
  env: Env;
  id: string;
  s: StatsView;
  learned: Record<string, RttEntry>;
  nodeRows: StatsNodeRow[];
  errs: ErrItem[];
}

export interface AdminIn {
  url: URL;
  users: { list: UserRec[] };
  statsMap: Record<string, { up: number; down: number; todayUp: number; todayDown: number }>;
  pageKey?: string;
}

/**
 * 页面视图（P6-3）：面板 / 统计 / 登录 / 管理台都从这一个对象出。
 * 序列化全在 views 层，routes 只负责取数与包 header。
 */
export class PageView {
  /** 用户面板（/<uuid>/page） */
  panel(env: Env, url: URL, id: string, host: string, key: string, info: PanelInfo): string {
    return renderHtml(env, url, id, host, key, info);
  }

  /** 用量统计页（/<uuid>/stats?format=html） */
  stats(o: StatsIn): string {
    return renderStatsHtml(o.env, o.id, o.s, o.learned, o.nodeRows, o.errs);
  }

  /** 登录页 */
  login(nonce: string, err?: string | null): string {
    return renderLogin(nonce, err);
  }

  /** 管理台 */
  admin(o: AdminIn): string {
    return renderAdmin(o.url, o.users, o.statsMap, o.pageKey || "");
  }

  /** 未配置 adminKey 的提示页 */
  adminHint(): string {
    return renderAdminHint();
  }
}

/** 进程内唯一实例 */
export const PAGES = new PageView();

