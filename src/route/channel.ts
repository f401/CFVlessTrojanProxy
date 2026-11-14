// 通道模型：一次请求只有三种通道 —— 直连、中继（IP）、入口（IP，仅订阅侧使用）。
// 键统一为 `d` / `r:<ip>` / `e:<ip>`，判定表与选路都用它做键。
import { S } from "../core/state";

export type ChanKind = "d" | "r" | "e";

export interface Chan {
  kind: ChanKind;
  ip: string;
}

export const DIRECT: Chan = { kind: "d", ip: "" };

/**
 * 功能：把通道对象转成判定表用的键。
 * @param c 通道
 * @returns 直连为 d，其余为 kind:ip
 */
export function chanKey(c: Chan): string {
  return c.kind === "d" ? "d" : c.kind + ":" + c.ip;
}

/**
 * 功能：把判定表键解析回通道对象。
 * @param k 键字符串
 * @returns 通道对象；无法解析返回 null
 */
export function parseChan(k: string): Chan | null {
  if (k === "d") return DIRECT;
  const i = k.indexOf(":");
  if (i !== 2) return null;
  const kind = k.slice(0, 1);
  if (kind !== "r" && kind !== "e") return null;
  return { kind, ip: k.slice(2) };
}

/** 中继通道的节点键（池子统计用 `host:port`），直连/入口返回空串 */
export function nodeKeyOf(c: Chan): string {
  return c.kind === "r" ? c.ip + ":443" : "";
}

/** 池子里活着的节点 → 中继通道（最多 max 个） */
export function relayChans(max = 8): Chan[] {
  const out: Chan[] = [];
  for (const k of S.alive.keys()) {
    if (out.length >= max) break;
    const i = k.lastIndexOf(":");
    const ip = i > 0 ? k.slice(0, i) : k;
    out.push({ kind: "r", ip });
  }
  return out;
}

