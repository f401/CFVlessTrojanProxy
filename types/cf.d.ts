// 最小 Cloudflare Workers 类型声明（不依赖 @cloudflare/workers-types）
declare module "cloudflare:sockets" {
  export interface Socket {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    close(): void;
    closed?: Promise<void>;
  }
  export function connect(o: { hostname: string; port: number }): Socket;
}

interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
  passThroughOnException(): void;
}
interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}
interface DurableObjectStorage {
  get<T = unknown>(k: string): Promise<T | undefined>;
  put(k: string, v: unknown): Promise<void>;
  delete(k: string): Promise<boolean>;
}
interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile(fn: () => Promise<void>): void;
}
interface DurableObjectId {
  toString(): string;
}
interface DurableObjectStub {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: unknown): Promise<{ keys: Array<{ name: string }> }>;
}

// Workers 会在 Request 上挂 cf 字段（机房、ASN、clientTcpRtt 等）
interface Request {
  cf?: CfMeta;
}

interface SocketLike {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void;
  closed?: Promise<void>;
}
interface ResponseInitLike {
  status?: number;
  webSocket?: WebSocketLike;
  headers?: Record<string, string>;
}

// WebSocketPair 是 Workers 的运行时全局；connect 必须从 "cloudflare:sockets" import，
// 不要在这里 declare —— 否则漏 import 会被 tsc 放过，线上才炸。
declare const WebSocketPair: { new (): { 0: WebSocketLike; 1: WebSocketLike } };
