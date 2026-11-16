import { P_T, shadowRate } from "../core/util";
import { S } from "../core/state";
import { dwellOf } from "../px/selector";
import { SC } from "../core/const";
import { PAGES } from "../views/pageview";
import { fmtBytes } from "../views/html";
import { effectiveQuota, subHeaders } from "../core/quota";
import { trojanPasswordOf } from "../views/sub";
import { SUBVIEW } from "../views/subview";
import { readStats, nodeSnapGet } from "../store/index";
import { statsNodeRows } from "../nodes/stats-rows";
import { aliveList, nsOf } from "../px/pool";
import { CSP_STATIC, html, json, text } from "../edge/respond";
import type { UserCtx } from "../edge/types";

/**
 * 用户可见的页面与订阅。
 *   page  控制页 /
 *   cl    订阅（Clash）
 *   sb    订阅（sing-box）
 *   ty    订阅（明文链接）
 *   stats 用量 JSON / HTML
 */
export async function subscription(c: UserCtx, kind: string): Promise<Response> {
  const { env, url, id, host, pageKey, learned, regions } = c;
  switch (kind) {
    case "page": {
      // 面板只显示「本 isolate 各自的当前节点」（`S.curs`，见下面两行）与存活条数。
      // 池子的 `px:cur` 曾经也取来放进 info，但面板从来没渲染过它 —— 那个字段等于
      // 让每次打开控制页都白付一次 KV/DO 往返（免费计划只有一个调用的子请求预算），7.205 去掉。
      const [st, alive] = await Promise.all([readStats(env, id), aliveList(env)]);
      const f: Record<string, number> = S.funnel || {};
      const ftot = (f.direct || 0) + (f.node || 0) + (f.v6 || 0);
      const pctOf = (x: number) => (ftot > 0 ? Math.round((x / ftot) * 1000) / 10 + "%" : "-");
      const info = {
        regions,
        curLat: S.curs.lat || "（未定）",
        curTput: S.curs.tput || "（未定）",
        colo: S.colo || "??",
        funnel: `直连 ${pctOf(f.direct || 0)} · 中转 ${pctOf(f.node || 0)}` + (f.v6 ? ` · v6 ${pctOf(f.v6)}` : ""),
        aliveCount: alive.length,
        used: fmtBytes((st.up || 0) + (st.down || 0)),
        today: fmtBytes((st.todayUp || 0) + (st.todayDown || 0)),
        quota: fmtBytes(effectiveQuota(env, (st.up || 0) + (st.down || 0))) + "（到顶自动翻倍）",
        expire: env.expireAt ? String(env.expireAt).slice(0, 10) : "长期",
        [P_T + "Pwd"]: trojanPasswordOf(env, id, c.auth),
        policy: `滞回 15% · 驻留 ${Math.round(Math.min(dwellOf(env, "lat"), dwellOf(env, "tput")) / 60000)} 分钟 · 每小时最多 ${SC.BUDGET} 次切换 · 影子 ${Math.round(shadowRate(env) * 100)}%`,
      };
      return html(PAGES.panel(env, url, id, host, pageKey, info), 200, { "content-security-policy": CSP_STATIC });
    }

    case "cl":
    case "pcl": {
      const s = await readStats(env, id);
      await aliveList(env); // 中继优选条目要列本机房存活中继（冷 isolate 从这里恢复）
      return text(SUBVIEW.render({ env, url, id, host, learned, regions, auth: c.auth }, "clash"), subHeaders(env, s));
    }

    case "sb":
    case "psb": {
      const s = await readStats(env, id);
      await aliveList(env);
      return json(SUBVIEW.render({ env, url, id, host, learned, regions, auth: c.auth }, "singbox"), subHeaders(env, s));
    }

    case "ty":
    case "pty": {
      const s = await readStats(env, id);
      await aliveList(env);
      return text(SUBVIEW.render({ env, url, id, host, learned, regions, auth: c.auth }, "links"), subHeaders(env, s));
    }

    case "stats": {
      const s = await readStats(env, id);
      if (url.searchParams.get("format") === "html") {
        const alive = await aliveList(env);
        // 明细只算要展示的节点（以前是为整张 nstat 生成，能到几千条）
        const nsMap = nsOf(
          alive.map((x) => x.h + ":" + x.p),
          alive.length,
        );
        // 吞吐是 isolate 本地样本：再并上 Meter DO 里的跨 isolate 快照，
        // 否则换一个 isolate 打开面板就全是"未用"
        const snap = await nodeSnapGet(env, id);
        for (const [k, v] of Object.entries(snap)) {
          if (!v) continue;
          const cur = nsMap[k] || {};
          nsMap[k] = {
            ...cur,
            bps: Math.max(Number(cur.bps) || 0, v.p90 || 0),
            bpsMed: Math.max(Number(cur.bpsMed) || 0, v.med || 0),
            bpsCap: Math.max(Number(cur.bpsCap) || 0, v.cap || 0),
            n: Math.max(Number(cur.n) || 0, v.n || 0),
          };
        }
        const nodeRows = statsNodeRows(alive, nsMap);
        const errs = S.errs.slice(-20).reverse();
        return html(PAGES.stats({ env, id, s, learned, nodeRows, errs }));
      }
      return json(s);
    }
  }
  return new Response("Not Found", { status: 404 });
}

