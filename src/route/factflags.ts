


/** 五类会影响选路的事实（`dns` 也在这里：它只在本 isolate 生效，但同样是乘数）。 */
type FactName = "eg" | "ps" | "cap" | "blk" | "dns";

/** 事实开关的 isolate 配置缓存，解析与其生命周期由同一对象管理。 */
export class FactSwitches {
  current: Set<FactName> | null = null;

  /** 功能：首次读取时解析环境开关。@param raw 配置。@returns 打开的事实名 */
  read(raw: unknown): Set<FactName> {
    if (!this.current) this.current = factParse(raw);
    return this.current;
  }
}

/** 事实开关配置所有者。 */
export const FACT_SWITCHES = new FactSwitches();

/** 全部事实名，按「上线顺序」排列（与清单 §H4 的批次一致）。 */
export const FACT_ALL: FactName[] = ["eg", "ps", "cap", "blk", "dns"];

/**
 * 功能：解析 `env.facts` 的开关串。
 * 语法：逗号/空白分隔的名字；`all` = 全开、`none`/空串 = 全关；未知名字忽略。
 * @param raw 绑定值（未配置时为 undefined）
 * @returns {Set<FactName>} 打开的事实集合
 */
export function factParse(raw: unknown): Set<FactName> {
  const out = new Set<FactName>();
  if (raw === undefined || raw === null) {
    // 没配置 = 全开：保持代码里的默认行为，避免「升级即变慢」这种意外
    for (const f of FACT_ALL) out.add(f);
    return out;
  }
  const s = String(raw).trim().toLowerCase();
  if (s === "none" || s === "") return out;
  if (s === "all") {
    for (const f of FACT_ALL) out.add(f);
    return out;
  }
  for (const tok of s.split(/[,\s]+/)) {
    const t = tok.trim();
    if (!t) continue;
    const hit = FACT_ALL.find((f) => f === t);
    if (hit) out.add(hit);
  }
  return out;
}

/**
 * 功能：解析「只对这一条连接生效」的临时开关（`?fx=` 查询串）。
 *
 * 为什么要这个入口：事实层的收益一直测不出来，因为链路的读数漂移比任何代码差别都大；
 * 想在**同一条命令内交替**比较「有事实 / 无事实」，就必须能按请求粒度切换，而不是改绑定
 * （改绑定要等缓存过期，两次测量已经不同天了）。
 * @param raw 查询串（`none` / `all` / 逗号分隔的名字）
 * @returns {ReadonlySet<FactName>} 本次请求生效的事实
 */
export function factOnce(raw: string): ReadonlySet<FactName> {
  return factParse(raw) as ReadonlySet<FactName>;
}

/**
 * 功能：读当前 isolate 的事实开关（每个 isolate 只解析一次）。
 *
 * 为什么要有它：清单 §H4 要求「先上只观测的、选路类事实按单条可回滚粒度上」。
 * 如果开关写死在代码常量里，回滚就得重新部署；放在 plain_text 绑定上，
 * 出问题改一行配置即可关掉某类事实，而代码与已学到的数据都还在。
 * @param env 环境绑定
 * @returns {Set<FactName>} 打开的事实集合
 */
export function factOn(env: { facts?: string }): Set<FactName> {
  return FACT_SWITCHES.read(env.facts);
}

/**
 * 功能：给 `/health` 用的可读形式（哪些事实在生效）。
 * @param env 环境绑定
 * @returns {string[]} 打开的事实名
 */
export function factList(env: { facts?: string }): string[] {
  return [...factOn(env)];
}
