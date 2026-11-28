/** 两种选路模式的游标、切换窗口与失败记忆。 */
export class SelectionMemory {
  current: Record<string, string> = { lat: "", tput: "" };
  previous: Record<string, string> = { lat: "", tput: "" };
  switchedAt: Record<string, number> = { lat: 0, tput: 0 };
  switches: Record<string, number[]> = { lat: [], tput: [] };
  failCount = 0;
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
