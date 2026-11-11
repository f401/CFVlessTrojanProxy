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

// 运行时由入口 import { connect } from "cloudflare:sockets" 提供；类型指向模块导出
declare const connect: (o: { hostname: string; port: number }) => import("cloudflare:sockets").Socket;
declare const WebSocketPair: { new (): { 0: WebSocketLike; 1: WebSocketLike } };
