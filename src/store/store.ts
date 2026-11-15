// store 层的门面（OOP P3）：把 KV / 快照 / 用量累积 / Meter 客户端收成一个入口，
// 上层只跟 STORE 打交道，换实现（KV→DO、快照格式）不用改调用方。
import { kvGet, kvGetStrict, kvSet } from "./kv";
import { clSnapshot, kickFlush, pendAdd, pendFlush, primaryId, scheduleFlush } from "./pend";
import { flushSnap, getSnap, restoreUsage, usageSnapGet } from "./snapshot";
import { nodeSnapGet, readStats, statBump } from "./stats";

export class Store {
  // —— KV ——
  get<T = unknown>(env: Env, key: string): Promise<T | null> {
    return kvGet<T>(env, key);
  }

  /** 落盘前读旧值必须用这个：区分「空表」与「读不到」 */
  strict<T = unknown>(env: Env, key: string): Promise<T | null> {
    return kvGetStrict<T>(env, key);
  }

  /** 功能：put 是薄包装，直接委托 kvSet。@param env Env。@param key string。@param obj unknown。@param opts? { expirationTtl?: number }。@returns 转发 kvSet 的返回值（Promise<void>） */
  put(env: Env, key: string, obj: unknown, opts?: { expirationTtl?: number }): Promise<void> {
    return kvSet(env, key, obj, opts);
  }

  // —— 用量（连接收尾一次结算） ——
  /** 功能：addUsage 是薄包装，直接委托 pendAdd。@param id string。@param up number。@param down number。@param isNew? boolean。@returns 无（pendAdd 无返回值） */
  addUsage(id: string, up: number, down: number, isNew?: boolean): void {
    pendAdd(id, up, down, isNew);
  }

  /** 功能：bump 是薄包装，直接委托 statBump。@param id string。@param up number。@param down number。@param isNewConn? boolean。@returns 无（statBump 无返回值） */
  bump(id: string, up: number, down: number, isNewConn?: boolean): void {
    statBump(id, up, down, isNewConn);
  }

  /** 功能：schedule 是薄包装，直接委托 scheduleFlush。@param env Env。@param delay? number。@returns 无（scheduleFlush 无返回值） */
  schedule(env: Env, delay?: number): void {
    scheduleFlush(env, delay);
  }

  /** 功能：kick 是薄包装，直接委托 kickFlush。@param env Env。@param id string | null。@returns 无（kickFlush 无返回值） */
  kick(env: Env, id: string | null): void {
    kickFlush(env, id);
  }

  /** 功能：flush 是薄包装，直接委托 pendFlush。@param env Env。@param force? boolean。@returns 转发 pendFlush 的返回值（Promise<void>） */
  flush(env: Env, force?: boolean): Promise<void> {
    return pendFlush(env, force);
  }

  /** 功能：primary 是薄包装，直接委托 primaryId。@param env Env。@returns 转发 primaryId 的返回值（string） */
  primary(env: Env): string {
    return primaryId(env);
  }

  // —— 快照 ——
  /** 功能：snap 是薄包装，直接委托 getSnap。@param env Env。@param fresh? boolean。@returns 合并后的快照文档（SnapDoc，缓存在 S.snapCache） */
  snap(env: Env, fresh?: boolean): Promise<SnapDoc> {
    return getSnap(env, fresh);
  }

  /** 功能：snapFlush 是薄包装，直接委托 flushSnap。@param env Env。@param force? boolean。@returns 转发 flushSnap 的返回值（Promise<void>） */
  snapFlush(env: Env, force?: boolean): Promise<void> {
    return flushSnap(env, force);
  }

  /** 功能：usageSnap 是薄包装，直接委托 usageSnapGet。@param env Env。@returns 灾备用量的快照，读不到为 null */
  usageSnap(env: Env): Promise<UsageSnap | null> {
    return usageSnapGet(env);
  }

  // 这里原本有一个 usageSnapWrite 门面方法，v7.142 删掉：模块函数要求传入用户表
  // （`usageSnapWrite(env, users)`），门面只给 env ⇒ `list = []` ⇒ 立刻走到
  // `if (!Object.keys(out.users).length) return;`，**永远不会写任何东西**，
  // 却返回一个 resolved 的 Promise，调用方无从察觉。想写快照就直接调模块函数并给出用户表。

  /** 功能：restore 是薄包装，直接委托 restoreUsage。@param env Env。@param id string。@param snap? UsageSnap。@returns 恢复进 DO 后的用量记录；没快照或写失败为 null */
  restore(env: Env, id: string, snap?: UsageSnap): Promise<UsageMeter | null> {
    return restoreUsage(env, id, snap);
  }

  // —— 统计 ——
  stats<T = unknown>(env: Env, id: string): Promise<T> {
    return readStats(env, id) as Promise<T>;
  }

  /** 功能：nodeSnap 是薄包装，直接委托 nodeSnapGet。@param env Env。@param id string。@returns 该用户的节点快照表（键是节点，值含存活/延迟/吞吐） */
  nodeSnap(env: Env, id: string): Promise<Record<string, NodeSnap>> {
    return nodeSnapGet(env, id);
  }

  // —— 观测 ——
  /** 功能：conns 是薄包装，直接委托 clSnapshot。@param max。@returns 转发 clSnapshot 的返回值（ClRec[]） */
  conns(max = 40): ClRec[] {
    return clSnapshot(max);
  }
}

/** 进程内唯一门面 */
export const STORE = new Store();

