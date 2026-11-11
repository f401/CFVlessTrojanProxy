import { P_T, shadowRate } from "../core/util";
import { S } from "../core/state";
import { SC } from "../core/const";
import { renderStatsHtml, renderHtml } from "../views/panel";
import { fmtBytes } from "../views/html";
import { effectiveQuota, subHeaders } from "../core/quota";
import { renderClash, renderSingbox, renderLinks, trojanPasswordOf } from "../views/sub";
import { readStatsCached, nodeSnapGet } from "../store/index";
import { aliveList, nsOf, pxGet } from "../px/pool";
import { cntView } from "../core/counter";
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
      // 注意：不要写成 (await pxGet(env)).cur —— 那会在数组字面量里
      // 先串行 await 一次，Promise.all 就只剩两个成员了。
      const px0 = pxGet(env).then((x) => x.cur);
      const [st, curPx, alive] = await Promise.all([readStatsCached(env, id), px0, aliveList(env)]);
      const f: Record<string, number> = S.funnel || {};
      const ftot = (f.direct || 0) + (f.node || 0) + (f.v6 || 0);
      const pctOf = (x: number) => (ftot > 0 ? Math.round((x / ftot) * 1000) / 10 + "%" : "-");
      const info = {
        regions,
        curPx,
        curLat: S.curs.lat || "（未定）",
        curTput: S.curs.tput || "（未定）",
        colo: S.colo || "??",
        cnt: cntView(),
        funnel: `直连 ${pctOf(f.direct || 0)} · 中转 ${pctOf(f.node || 0)}` + (f.v6 ? ` · v6 ${pctOf(f.v6)}` : ""),
        aliveCount: alive.length,
        used: fmtBytes((st.up || 0) + (st.down || 0)),
        today: fmtBytes((st.todayUp || 0) + (st.todayDown || 0)),
        quota: fmtBytes(effectiveQuota(env, (st.up || 0) + (st.down || 0))) + "（到顶自动翻倍）",
        expire: env.expireAt ? String(env.expireAt).slice(0, 10) : "长期",
        [P_T + "Pwd"]: trojanPasswordOf(env, id, c.auth),
        policy: `滞回 15% · 驻留 ${Math.round(SC.DWELL / 60000)} 分钟 · 每小时最多 ${SC.BUDGET} 次切换 · 影子 ${Math.round(shadowRate(env) * 100)}%`,
      };
      return html(renderHtml(env, url, id, host, pageKey, info), 200, { "content-security-policy": CSP_STATIC });
    }

    case "cl":
    case "pcl": {
      const s = await readStatsCached(env, id);
      return text(renderClash(env, url, id, host, learned, regions, c.auth), subHeaders(env, s));
    }

    case "sb":
    case "psb": {
      const s = await readStatsCached(env, id);
      return json(renderSingbox(env, url, id, host, learned, regions, c.auth), subHeaders(env, s));
    }

    case "ty":
    case "pty": {
      const s = await readStatsCached(env, id);
      return text(renderLinks(env, url, id, host, learned, regions, c.auth), subHeaders(env, s));
    }

    case "stats": {
      const s = await readStatsCached(env, id);
      if (url.searchParams.get("format") === "html") {
        const alive = await aliveList(env);
        // 明细只算要展示的节点（以前是为整张 nstat 生成，能到几千条）
        const nsMap = nsOf(alive.map((x) => x.h + ":" + x.p));
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
        return html(renderStatsHtml(env, id, s, learned, alive, nsMap));
      }
      return json(s);
    }
  }
  return new Response("Not Found", { status: 404 });
}
