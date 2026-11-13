// 决策层的注入点：proxy 在编译期只依赖 core，运行期由 route 注册实现。
// 这样保持分层单向（core → store → nodes → px → proxy → route → views → edge → routes）。
export interface DecisionIn {
  host: string;
  cfHost: boolean; // 目标托管在 CF 上
  clientV6: boolean; // 客户端出口是 IPv6（cf-connecting-ip）
  legacyWantsRelay: boolean; // 现状（wantPx），用于影子统计
}

export interface DecisionOut {
  via: "d" | "r"; // 直连 / 走中继（含入口 IP 偏好时不改变这个值）
  ip?: string;
  why: string;
}

export interface Hooks {
  decide: ((x: DecisionIn) => DecisionOut) | null;
  /** 该站点 × 该中继出口是否已被判定为不可用（blocked/dead），由 route 层实现 */
  veto: ((host: string, ip: string) => boolean) | null;
  /** 连接收尾的通道证据（弱证据：只可能把 unknown 提成 ok） */
  traffic: ((e: TrafficEvt) => void) | null;
  /** 池子的中继实测（握手能不能替该站点转出去）：host, 中继 IP, 是否成功, 耗时 */
  relayProbe: ((host: string, ip: string, ok: boolean, ms: number) => void) | null;
  /** 该站点 × 该中继是否已被实测判为可用（ok），选路优先 */
  prefer: ((host: string, ip: string) => boolean) | null;
  /** 判定表的强证据增量（随 /add 上 DO） */
  vtDelta: (() => Array<{ k: string; s: number; t: number }>) | null;
  /** 冷启动拉一次远端强证据 */
  vtLoad: ((env: Env) => Promise<void>) | null;
  /** 通道偏好：0 实测能打通 / 1 未测 / 2 实测打不通（按中继或入口 IP） */
  chanPref: ((ip: string, host?: string) => number) | null;
  /** 判定复核：对排队中的可疑组合做同站点双通道实测（由 ctx.waitUntil 触发） */
  verify: (() => Promise<number>) | null;
  /** 该站点最近哪条通道成功过（弱证据来源）：直连 / 中继 */
  win: ((host: string) => { d: boolean; r: boolean }) | null;
}

export interface TrafficEvt {
  /** 目标是 CF 托管站点（这类站点直连被自家边缘按 IP 族拒的概率极高） */
  cf?: boolean;
  host: string;
  via: "node" | "direct" | "v6";
  node: string; // 节点键 host:port（直连时为空）
  down: number;
  ok: boolean;
  /** 连接存活毫秒：小响应 + 短寿命 = 大概率是被拒（403/风控） */
  life: number;
  /** 客户端上传字节：上传得多说明是真实业务请求，别按「被拒」处理 */
  up: number;
}

export const HOOK: Hooks = { decide: null, veto: null, traffic: null, relayProbe: null, prefer: null, chanPref: null,
  verify: null, vtDelta: null, vtLoad: null, win: null };
