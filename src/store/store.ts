// store 层的门面（OOP P3）：把 KV / 快照 / 用量累积 / Meter 客户端收成一个入口，
// 上层只跟 STORE 打交道，换实现（KV→DO、快照格式）不用改调用方。
import { kvGet, kvGetStrict, kvSet } from "./kv";
import { clSnapshot, kickFlush, pendAdd, pendFlush, primaryId, scheduleFlush } from "./pend";
import { flushSnap, getSnap, restoreUsage, usageSnapGet, usageSnapWrite } from "./snapshot";
import { nodeSnapGet, readStats, readStatsCached, statBump } from "./stats";

export class Store {
  // —— KV ——
  get<T = unknown>(env: Env, key: string): Promise<T | null> {
    return kvGet<T>(env, key);
  }

  /** 落盘前读旧值必须用这个：区分「空表」与「读不到」 */
  strict<T = unknown>(env: Env, key: string): Promise<T | null> {
    return kvGetStrict<T>(env, key);
  }

  put(env: Env, key: string, obj: unknown, opts?: { expirationTtl?: number }): Promise<void> {
    return kvSet(env, key, obj, opts);
  }

  // —— 用量（连接收尾一次结算） ——
  addUsage(id: string, up: number, down: number, isNew?: boolean): void {
    pendAdd(id, up, down, isNew);
  }

  bump(id: string, up: number, down: number, isNewConn?: boolean): void {
    statBump(id, up, down, isNewConn);
  }

  schedule(env: Env, delay?: number): void {
    scheduleFlush(env, delay);
  }

  kick(env: Env, id: string | null): void {
    kickFlush(env, id);
  }

  flush(env: Env, force?: boolean): Promise<void> {
    return pendFlush(env, force);
  }

  primary(env: Env): string {
    return primaryId(env);
  }

  // —— 快照 ——
  snap(env: Env, fresh?: boolean) {
    return getSnap(env, fresh);
  }

  snapFlush(env: Env, force?: boolean): Promise<void> {
    return flushSnap(env, force);
  }

  usageSnap(env: Env) {
    return usageSnapGet(env);
  }

  usageSnapWrite(env: Env) {
    return usageSnapWrite(env);
  }

  restore(env: Env, id: string, snap?: UsageSnap) {
    return restoreUsage(env, id, snap);
  }

  // —— 统计 ——
  stats<T = unknown>(env: Env, id: string): Promise<T> {
    return readStats(env, id) as Promise<T>;
  }

  statsCached<T = unknown>(env: Env, id: string): Promise<T> {
    return readStatsCached(env, id) as Promise<T>;
  }

  nodeSnap(env: Env, id: string) {
    return nodeSnapGet(env, id);
  }

  // —— 观测 ——
  conns(max = 40): ClRec[] {
    return clSnapshot(max);
  }
}

/** 进程内唯一门面 */
export const STORE = new Store();
