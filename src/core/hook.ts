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
  /** 走直连还是走中继：唯一还需要注入的能力（策略要 import proxy 的 cfHttpCode，不能下移） */
  decide: ((x: DecisionIn) => DecisionOut) | null;
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

export const HOOK: Hooks = { decide: null };
