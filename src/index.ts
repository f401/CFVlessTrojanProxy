import { errMsg } from "./core/util";

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
      // 用 URL 的 hostname：Host 头可能带 :port，直接拿去当节点 server 会生成
      // "edge.example.com:443:443" 这种坏地址；hostname 已经去掉端口
      const host = url.hostname || request.headers.get("Host") || "";
      const cf = request.cf || {};
      S.colo = (cf && cf.colo) || S.colo || "??"; // 本 isolate 的机房：所有统计按它分桶

      if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
        return await handleUpgrade(request, env, ctx);
      }

      const auth = await loadUsers(env);
      const seg = url.pathname.split("/").filter(Boolean);
      const first = (seg[0] || "").toLowerCase();
      const pageKey = env.pageKey || "";
      const keyOk = !pageKey || url.searchParams.get("k") === pageKey;

      /* ---------- 管理面板（会话登录） ---------- */
      // 放在 uuid 检查之前：全新部署没有 uuid 时也要能进 /admin 建第一个用户
      if (first === "admin") {
        return admin({ request, env, ctx, url, host, seg, first, auth, pageKey, keyOk, cf });
      }

      if (auth.uuids.size === 0) {
        return new Response("未配置 uuid（请设置环境变量 uuid 或 uuids）", { status: 500 });
      }

      /* ---------- 健康检查 ---------- */
      if (first === "health") {
        return health({ request, env, ctx, url, host, seg, first, auth, pageKey, keyOk, cf });
      }

      /* ---------- 需要合法 UUID 的路由 ---------- */
      if (!auth.uuids.has(first)) return new Response("Not Found", { status: 404 });
      if (!keyOk) return new Response("Forbidden", { status: 403 });

      const id = first;
      const sub = (seg[1] || "").toLowerCase();
      const base = { request, env, ctx, url, host, seg, first, auth, pageKey, keyOk, cf };

      // 订阅 / 看用量之前：把本 isolate 还没送达的增量推给 DO，并跳过 60s 读缓存。
      // 用 pendFlush 自带的 30 秒节流，不再 force —— 订阅刷新再快也不该每 10 秒打一次 DO；
      // 而且 readStats 会把尚未推上去的 S.pend 直接加回来，数字本来就是准的。
      if (env.METER && ["", "cl", "pcl", "sb", "psb", "ty", "pty", "stats"].includes(sub)) {
        await pendFlush(env);
        S.statCache.delete(id);
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
          // 只有订阅/统计需要 RTT 与地区列表：/logs、/debug 不再白读 KV
          const learned = await loadRtt(env, id);
          const regions = await regionListAsync(env);
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
    } catch (e) {
      const msg = errMsg(e);
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
