import { errMsg } from "./core/util";

import { handleUpgrade } from "./proxy/session";
import { health } from "./routes/health";
import { runCron } from "./routes/cron";
import { admin } from "./routes/admin";
import { ROUTES } from "./routes/table";

import { loadRtt, logErr } from "./nodes/metrics";

import { loadUsers } from "./proxy/protocol";

import { regionListAsync } from "./px/regions";

import { S } from "./core/state";
import { pendFlush } from "./store/index";

/**
 * 组装根：只做三件事 —— HTTP 分发、WebSocket 升级、cron 入口。
 * 具体实现全在 routes/ 与 proxy/ 里，这个文件不应该再长出业务逻辑。
 */
export default {
  /**
   * 功能：Worker 入口。按路径把请求分派给边缘页、管理端、订阅、代理升级与 DO 内部路由。
   * @param request 请求
   * @param env 环境变量
   * @param ctx 执行上下文
   * @returns 响应
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      const url = new URL(request.url);
      // 用 URL 的 hostname：Host 头可能带 :port，直接拿去当节点 server 会生成
      // "edge.example.com:443:443" 这种坏地址；hostname 已经去掉端口
      const host = url.hostname || request.headers.get("Host") || "";
      const cf = request.cf || {};
      S.colo = (cf && cf.colo) || S.colo || "??"; // 本 isolate 的机房：所有统计按它分桶
    S.site = host;

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

      /* ---------- 健康检查 ---------- */
      // 放在 uuid 检查之前：全新部署还没配 uuid 时也要能自检（否则只会看到 500）
      if (first === "health") {
        return health({ request, env, ctx, url, host, seg, first, auth, pageKey, keyOk, cf });
      }

      if (auth.uuids.size === 0) {
        return new Response("未配置 uuid（请设置环境变量 uuid 或 uuids）", { status: 500 });
      }

      /* ---------- 需要合法 UUID 的路由 ---------- */
      if (!auth.uuids.has(first)) return new Response("Not Found", { status: 404 });
      if (!keyOk) return new Response("Forbidden", { status: 403 });

      const id = first;
      const sub = (seg[1] || "").toLowerCase();
      const base = { request, env, ctx, url, host, seg, first, auth, pageKey, keyOk, cf };

      // 路由表分发：表决定「要不要先推增量 / 读 RTT」，组装根只负责按表调用
      const def = ROUTES.route(sub);
      if (!def) return new Response("Not Found", { status: 404 });

      // 订阅 / 看用量之前：把本 isolate 还没送达的增量推给 DO，并把 DO 读缓存作废。
      // 用 pendFlush 自带的 30 秒节流，不再 force —— 订阅刷新再快也不该每 10 秒打一次 DO；
      // 而且 readStats 会把尚未推上去的 S.pend 直接加回来，数字本来就是准的。
      // 只以路由表的 stats 标志为准：这里以前还抄了一份硬编码子路径列表，两处一旦漂移
      // 就会出现「表里标了 stats、装配根没推增量」的静默陈旧读数（v7.135 删掉那份副本）。
      if (env.METER && def.stats) {
        await pendFlush(env);
        S.meterCache.delete(id);
      }

      if (def.rtt) {
        const learned = await loadRtt(env, id);
        const regions = await regionListAsync(env);
        return def.handle({ ...base, id, learned, regions }, sub);
      }
      return def.handle({ ...base, id, learned: {}, regions: [] }, sub);
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

  /** 功能：scheduled 是薄包装，直接委托 runCron。@param _event ScheduledEvent。@param env Env。@param ctx ExecutionContext。@returns 无（runCron 无返回值） */
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    return runCron(env, ctx);
  },
};

/* 供单测导出（Workers 运行时忽略额外导出） */
import "./route/policy";

export { Meter } from "./store/meter";

