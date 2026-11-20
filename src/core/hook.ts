// 决策层的注入点：proxy 在编译期只依赖 core，运行期由 route 注册实现。
// 这样保持分层单向（core → store → nodes → px → proxy → route → views → edge → routes）。
export interface DecisionIn {
  host: string;
  cfHost: boolean; // 目标托管在 CF 上
  clientV6: boolean; // 客户端出口是 IPv6（cf-connecting-ip）
  legacyWantsRelay: boolean; // 现状（wantPx），用于影子统计
  /** 传输模式（`tput` / `lat`）：两种模式对「快」的定义不同，选路要能区分 */
  mode?: string;
  /** 启用的事实集合（`env.facts` 的解析结果）；缺省视为全开。 */
  facts?: ReadonlySet<string>;
}

/**
 * 决策理由的封闭集合。
 *
 * 为什么必须是联合类型而不是裸 string：proxy 侧的硬规则（`src/proxy/pxhook.ts`）
 * 过去直接拿字符串字面量比对 `out.why`，而 route 侧负责产生这些字面量。两边分家后，
 * 任何一边改了拼写都不会有编译错——7.123 的 `HOOK.facts` 就是这样静默失效的。
 * 把字面量收进 core、两侧都引用同一份常量，拼错会在 tsc 阶段被拦住。
 */
export const DECISION_WHY = {
  V6Cf: "v6-cf",
  V6CfNone: "v6-cf-none",
  Http403: "http403",
  Http200: "http200",
  DirBlocked: "dir-blocked",
  Explore: "explore",
  RelRot: "rel-rot",
  ColdPin: "cold-pin",
  CfNonCf: "cf-noncf",
  CfAny: "cf-any",
  EgPin: "eg-pin",
  Rehab: "rehab",
  DirectOk: "direct-ok",
  Direct: "direct",
} as const;

/** 决策理由的封闭类型：拼错的成员名过不了 tsc。 */
export type DecisionWhy = (typeof DECISION_WHY)[keyof typeof DECISION_WHY];

/**
 * 「CF 托管目标必须走中继」的硬规则理由集合。
 * 放在 core 而不是 proxy：proxy 只引用这份集合，不再自己抄一遍字面量。
 */
export const HARD_DECISION_WHY: ReadonlySet<DecisionWhy> = new Set<DecisionWhy>([
  DECISION_WHY.V6Cf,
  DECISION_WHY.V6CfNone,
  DECISION_WHY.Http403,
  DECISION_WHY.Http200,
  DECISION_WHY.DirBlocked,
  DECISION_WHY.Explore,
]);

export interface DecisionOut {
  via: "d" | "r"; // 直连 / 走中继（含入口 IP 偏好时不改变这个值）
  ip?: string;
  why: DecisionWhy;
}

interface Hooks {
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
  /** 该站点最近哪条通道成功过（弱证据来源）：直连 / 中继 */
  win: ((host: string) => { d: boolean; r: boolean }) | null;
  /** 中继存活度的未上报增量（由 route 注册，store 在上报批次里取用） */
  healthDelta: (() => Array<{ i: string; o: number; b: number; d: number; t?: number }>) | null;
  /** 四类同步事实的增量（eg/ps/dead/blk2）；未 ack 前重发等于重试，不是重复计数 */
  factsDelta: (() => {
    eg?: Array<{ i: string; f: number; at: number }>;
    ps?: Array<{ k: string; q: number; n: number; at: number }>;
    dead?: Array<{ i: string; n: number; at: number }>;
    blk2?: Array<{ k: string; n: number; at: number }>;
    dns?: Array<{ h: string; v: number; at: number }>;
  }) | null;
  /** 中继连接层结果（连上=true 会清零失败计数） */
  deadNote: ((ip: string, ok: boolean) => void) | null;
  /** 判定/中继增量确认送达（成功）或退回（失败） */
  syncAck: (() => void) | null;
  syncNack: (() => void) | null;
  /** 是否该优先非 CF 出口（原来由池子的 relayOff 集合表达，现由判定层决定） */
  nonCfFirst: (() => boolean) | null;
  /** 一条连接结束时的「站点 × 中继」实测（首字节 ms、下行 KB/s），由 route 层记录 */
  relPerf: ((host: string, ip: string, ttfb: number, kbs: number) => void) | null;
  /** 吞吐取样（v8 §5.1 的 R1 噪声门）：capacity 只记相对比值，与站点无关。 */
  capNote: ((ip: string, kbs: number) => void) | null;
  /** 取当前启用的事实集合（由 route 层注册：它知道 `env.facts` 的语义）。 */
  facts: (() => ReadonlySet<string>) | null;
  /** 按查询串临时切换事实集合（`?fx=none`）：只影响当前请求，配对测量用。 */
  factsFor: ((raw: string) => ReadonlySet<string>) | null;
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
  /** 事件时间（毫秒）。缺省按处理时刻算；回放/聚合时必须显式传，否则三批会被压成一批 */
  at?: number;
}

export const HOOK: Hooks = { decide: null, veto: null, traffic: null, relayProbe: null, prefer: null, chanPref: null,
  vtDelta: null, vtLoad: null, win: null, nonCfFirst: null, healthDelta: null, factsDelta: null, deadNote: null, syncAck: null, syncNack: null, relPerf: null, capNote: null, facts: null, factsFor: null };

