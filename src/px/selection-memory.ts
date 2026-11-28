/** 两种选路模式的游标、切换窗口与失败记忆。 */
export class SelectionMemory {
  /** 每个模式当前选中的节点 key */
  current: Record<string, string> = { lat: "", tput: "" };
  /** 上一个被选中的节点：切换抖动与回退统计用 */
  previous: Record<string, string> = { lat: "", tput: "" };
  /** 上次切换的时刻（驻留时长按它算） */
  switchedAt: Record<string, number> = { lat: 0, tput: 0 };
  /** 最近的切换时刻序列（算每小时切换次数） */
  switches: Record<string, number[]> = { lat: [], tput: [] };
  /** 连续失败次数（达到阈值触发换节点） */
  failCount = 0;
  /** 已经记过的失败次数（去重用） */
  failSeen = 0;

  /** 功能：切换时同时更新旧节点、当前节点与时刻。@param mode 模式。@param key 新节点。@param now 时刻。@returns 无 */
  switchTo(mode: Mode, key: string, now: number): void {
    this.previous[mode] = this.current[mode];
    this.current[mode] = key;
    this.switchedAt[mode] = now;
  }
}

/** 选路切换窗口的 isolate 所有者。 */
export const SELECTION_MEMORY = new SelectionMemory();
