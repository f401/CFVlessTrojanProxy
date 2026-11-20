import { P_T, shadowRate } from "../core/util";
import { S } from "../core/state";
import { dwellOf } from "../px/selector";
import { SC } from "../core/const";
import { PageView, fmtBytes } from "../views/panel";
import { effectiveQuota, subHeaders } from "../core/quota";
import { SubscriptionView, trojanPasswordOf } from "../views/sub";
import type { SubKind } from "../views/sub";
import { readStats, mergeNodeSnap, nodeSnapGet } from "../store/index";
import { statsNodeRows } from "../nodes/stats-rows";
import { aliveList, nsOf } from "../px/pool";
import { CSP_STATIC, html, json, text } from "../edge/respond";
import type { UserCtx } from "../edge/types";

/**
 * 用户可见的页面与订阅的入口。
 *
 * 只做一件事：把请求交给 `SubscriptionRoutes`。分派与渲染都在那个类里，
 * 因为同一条路由的五个分支代价差别很大（控制页要读用量 + 存活表两次往返、
 * 订阅要读用量 + 存活表、`/stats` 的 JSON 分支一次都不多花），
 * 混在一条 switch 里时「哪个分支多花了一次子请求」读不出来。
 * @param c 用户上下文（env / url / id / host / pageKey / learned / regions）
 * @param kind 路由种类（page / cl / sb / ty / stats 及其带口令变体 pcl / psb / pty）
 * @returns 响应
 */
export async function subscription(c: UserCtx, kind: string): Promise<Response> {
  return new SubscriptionRoutes(c).run(kind);
}

/**
 * 订阅这一族要发的三种格式 —— 渲染器与响应体类型。
 *
 * 三者唯一差别就是 `this.view.render` 的第二个参数与响应体的 content-type，
 * 所以一张表就够了；**口令变体**（`pcl`/`psb`/`pty`，路径里带 `k=`）与普通变体走同一条路。
 */
const FEEDS: Record<string, { fmt: SubKind; json: boolean }> = {
  cl: { fmt: "clash", json: false },
  pcl: { fmt: "clash", json: false },
  sb: { fmt: "singbox", json: true },
  psb: { fmt: "singbox", json: true },
  ty: { fmt: "links", json: false },
  pty: { fmt: "links", json: false },
};

/**
 * 控制页与订阅的五个分支。
 *
 * 为什么不写成一个 `switch`：五个分支的**代价**不同（往返次数、是否渲染 HTML、
 * 是否要并跨 isolate 快照），而「这条路由最多花几个子请求」是免费计划最硬的约束
 * （一次调用 50 个，见 AGENTS.md 第 5 条）。一个方法一个分支，代价就写在方法体里。
 */
export class SubscriptionRoutes {
  private readonly c: UserCtx;
  /**
   * 页面视图：控制页与统计页的 HTML 都从这一个对象出。
   *
   * 7.353 前它是模块级 `PAGES`（无状态的单例），由队列/路由持有之后，「谁渲染了页面」
   * 在 `SubscriptionRoutes` 里就能读到，不必跳到 `panel.ts` 的尾部找实例。
   */
  private readonly pages = new PageView();
  /**
   * 订阅渲染器：三种格式共用一张分派表。
   *
   * 7.358 前它是模块级 `SUBVIEW`。它是无字段的纯分派器，但订阅内容就是这个类的产出，
   * 挂模块上时读 `feed()` 的人看不出来走的是哪份渲染实现。
   */
  private readonly view = new SubscriptionView();

  /**
   * 功能：记下这次请求的上下文（构造期不做任何 I/O）。
   * @param c 用户上下文
   */
  constructor(c: UserCtx) {
    this.c = c;
  }

  /**
   * 功能：按路由种类分派。
   * @param kind 路由种类
   * @returns 响应；未知种类 404
   */
  async run(kind: string): Promise<Response> {
    if (kind === "page") return this.page();
    if (FEEDS[kind]) return this.feed(kind);
    if (kind === "stats") return this.stats();
    return new Response("Not Found", { status: 404 });
  }

  /**
   * 功能：控制页（面板 HTML）。
   *
   * 只取「本 isolate 的当前节点」与池子存活条数：池子的 `px:cur` 曾经也取来放进 info，
   * 但面板从来没渲染过它 —— 那个字段等于让每次打开控制页都白付一次 KV/DO 往返，7.205 去掉。
   * @returns 面板响应（带静态 CSP）
   */
  private async page(): Promise<Response> {
    const { env, url, id, host, pageKey, regions } = this.c;
    // 用量与存活表互不依赖，并行取：两个往返同时发出，面板首字节不叠加
    const [st, alive] = await Promise.all([readStats(env, id), aliveList(env)]);
    const f: Record<string, number> = S.funnel || {};
    const ftot = (f.direct || 0) + (f.node || 0) + (f.v6 || 0);
    // 漏斗分母只算三档已知出口；一档都没走过时显示「-」，不要拿 0% 冒充「全走直连」
    const pctOf = (x: number) => (ftot > 0 ? Math.round((x / ftot) * 1000) / 10 + "%" : "-");
    const info = {
      regions,
      // 当前节点是 isolate 本地的（不跨 isolate 共享）；没定过就写「未定」而不是空串
      curLat: S.curs.lat || "（未定）",
      curTput: S.curs.tput || "（未定）",
      colo: S.colo || "??",
      funnel: `直连 ${pctOf(f.direct || 0)} · 中转 ${pctOf(f.node || 0)}` + (f.v6 ? ` · v6 ${pctOf(f.v6)}` : ""),
      aliveCount: alive.length,
      used: fmtBytes((st.up || 0) + (st.down || 0)),
      today: fmtBytes((st.todayUp || 0) + (st.todayDown || 0)),
      quota: fmtBytes(effectiveQuota(env, (st.up || 0) + (st.down || 0))) + "（到顶自动翻倍）",
      expire: env.expireAt ? String(env.expireAt).slice(0, 10) : "长期",
      [P_T + "Pwd"]: trojanPasswordOf(env, id, this.c.auth),
      policy:
        `滞回 15% · 驻留 ${Math.round(Math.min(dwellOf(env, "lat"), dwellOf(env, "tput")) / 60000)} 分钟 · ` +
        `每小时最多 ${SC.BUDGET} 次切换 · 影子 ${Math.round(shadowRate(env) * 100)}%`,
    };
    return html(this.pages.panel(env, url, id, host, pageKey, info), 200, { "content-security-policy": CSP_STATIC });
  }

  /**
   * 功能：三种订阅格式（clash / sing-box / 明文链接）。
   *
   * 必须先 `await aliveList(env)`：中继优选条目要列本机房存活中继，
   * 而冷 isolate 正是从这里恢复的（不 await 会发出空的中继块，客户端那侧看起来像配置错）。
   * @param kind 路由种类（`FEEDS` 的键）
   * @returns 订阅响应（用量写进 `subscription-userinfo` 头）
   */
  private async feed(kind: string): Promise<Response> {
    const { env, url, id, host, learned, regions, auth } = this.c;
    const spec = FEEDS[kind];
    const s = await readStats(env, id);
    await aliveList(env);
    const body = this.view.render({ env, url, id, host, learned, regions, auth }, spec.fmt);
    return spec.json ? json(body, subHeaders(env, s)) : text(body, subHeaders(env, s));
  }

  /**
   * 功能：用量查询（JSON 或 HTML）。
   * @returns 用量响应
   */
  private async stats(): Promise<Response> {
    const s = await readStats(this.c.env, this.c.id);
    if (this.c.url.searchParams.get("format") !== "html") return json(s);
    return this.statsHtml(s);
  }

  /**
   * 功能：用量明细页（每个节点一行）。
   *
   * 明细只算要展示的节点（以前是为整张 `nstat` 生成，能到几千条）；吞吐是 isolate 本地样本，
   * 必须再并上 Meter DO 里的跨 isolate 快照，否则换一个 isolate 打开面板就全是「未用」。
   * @param s 用量视图（`readStats` 的结果）
   * @returns HTML 响应
   */
  private async statsHtml(s: Awaited<ReturnType<typeof readStats>>): Promise<Response> {
    const { env, id, learned } = this.c;
    // 明细要列存活节点，所以这一次必须等池子（控制页/JSON 分支都不等）
    const alive = await aliveList(env);
    // 本 isolate 的样本先摊平；等会儿按节点键与跨 isolate 快照逐项取大
    const nsMap = nsOf(
      alive.map((x) => x.h + ":" + x.p),
      alive.length,
    );
    const snap = await nodeSnapGet(env, id);
    // 合并口径是「取大」：本地只见过这一跳、别的 isolate 见过另一条路径，两个都是真实观测
    mergeNodeSnap(nsMap, snap);
    const nodeRows = statsNodeRows(alive, nsMap);
    // 错误环只留最近 20 条并倒序：面板上一次刷屏会把更早的挤压掉，那是刻意的
    const errs = S.errs.slice(-20).reverse();
    return html(this.pages.stats({ env, id, stats: s, learned, nodeRows, errs }));
  }
}
