
import { handleUpgrade } from "./proxy/session";
import { Meter } from "./store/meter";
import { health } from "./routes/health";
import { logs } from "./routes/logs";
import { runCron } from "./routes/cron";
import { subscription } from "./routes/subscription";
import { admin } from "./routes/admin";
import { proxyip, debug } from "./routes/tools";

import { loadRtt, logErr } from "./nodes/metrics";

import { loadUsers } from "./proxy/protocol";

import { regionListAsync } from "./px/probe";

import { S } from "./core/state";
import { pendFlush } from "./store/index";

/**
 * 组装根：只做三件事 —— HTTP 分发、WebSocket 升级、cron 入口。
 * 具体实现全在 routes/ 与 proxy/ 里，这个文件不应该再长出业务逻辑。
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      const url = new URL(request.url);
      const host = request.headers.get("Host") || url.hostname;
      const cf = request.cf || {};
      S.colo = (cf && cf.colo) || S.colo || "??";   // 本 isolate 的机房：所有统计按它分桶

      if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
        return await handleUpgrade(request, env, ctx);
      }

      const auth = await loadUsers(env);
      if (auth.uuids.size === 0) {
        return new Response("未配置 uuid（请设置环境变量 uuid 或 uuids）", { status: 500 });
      }

      const seg = url.pathname.split("/").filter(Boolean);
      const first = (seg[0] || "").toLowerCase();
      const pageKey = env.pageKey || "";
      const keyOk = !pageKey || url.searchParams.get("k") === pageKey;

      /* ---------- 健康检查 ---------- */
      if (first === "health") {
        return health({ request, env, ctx, url, host, seg, first, auth, pageKey, keyOk, cf });
      }

      /* ---------- 管理面板（会话登录） ---------- */
      if (first === "admin") {
        return admin({ request, env, ctx, url, host, seg, first, auth, pageKey, keyOk, cf });
      }

      /* ---------- 需要合法 UUID 的路由 ---------- */
      if (!auth.uuids.has(first)) return new Response("Not Found", { status: 404 });
      if (!keyOk) return new Response("Forbidden", { status: 403 });

      const id = first;
      const sub = (seg[1] || "").toLowerCase();
      const base = { request, env, ctx, url, host, seg, first, auth, pageKey, keyOk, cf };
      const learned = await loadRtt(env, id);
      const regions = await regionListAsync(env);

      // 订阅 / 看用量之前：先把本 isolate 还没送达的增量推给 DO，并跳过 60s 读缓存，
      // 这样客户端刷订阅看到的就是"截至此刻"的准数
      if (env.METER && ["", "cl", "pcl", "sb", "psb", "ty", "pty", "stats"].includes(sub)) {
        // 订阅场景要尽量新鲜，但 10 秒内的重复刷新就不必再打了（客户端轮询会放大请求量）
        await pendFlush(env, Date.now() - S.pendAt > 10000);
        S.statCache.clear();
        S.meterCache.delete(id);
      }

      switch (sub) {
        case "":
        case "cl":
        case "pcl":
        case "sb":
        case "psb":
        case "ty":
        case "pty":
        case "stats": {
          return subscription({ ...base, id, learned, regions }, sub === "" ? "page" : sub);
        }

        case "logs": {
          return logs({ ...base, id });
        }

        case "proxyip": {
          return proxyip({ ...base, id });
        }

        case "debug": {
          return debug({ ...base, id });
        }

        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (e: any) {
      const msg = e && e.message ? e.message : String(e);
      logErr(`router: ${msg}`);
      let dbg = "";
      try {
        if (new URL(request.url).searchParams.get("dbg") === "1") dbg = " " + msg;
      } catch (e2) {}
      return new Response("502" + dbg, { status: 502 });
    }
  },

  scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    return runCron(env, ctx);
  },
};

/* 供单测导出（Workers 运行时忽略额外导出） */

export { Meter } from "./store/meter";
