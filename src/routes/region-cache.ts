import type { RegionNodeRow } from "../views/regions";

/** 地区页面单槽类型化缓存；行与 JSON 分开，均允许 30 秒展示陈旧。 */
export class RegionPageCache {
  /** 节点行缓存（30 秒）：站点相关列在渲染前才补算 */
  rows: { t: number; rows: RegionNodeRow[] } | null = null;
  /** JSON 文本缓存（5 秒）：同一份结果不重复序列化 */
  json: { t: number; key: string; text: string } | null = null;

  /** 功能：在寿命内返回基础行，站点投影由调用方复制。@param now 当前时间。@returns 行或 null */
  freshRows(now: number): RegionNodeRow[] | null {
    return this.rows && now - this.rows.t < 30000 ? this.rows.rows : null;
  }

  /** 功能：按目标与条数命中序列化缓存。@param key 请求键。@param now 当前时间。@returns JSON 或 null */
  freshJson(key: string, now: number): string | null {
    return this.json && this.json.key === key && now - this.json.t < 30000 ? this.json.text : null;
  }
}

/** 地区展示缓存所有者，不保存用户上下文或口令。 */
export const REGION_CACHE = new RegionPageCache();
