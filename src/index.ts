import { SC } from "./core/const";
import { handleUpgrade } from "./proxy/session";
import { Meter } from "./store/meter";
import { health } from "./routes/health";
import { subscription } from "./routes/subscription";
import { admin } from "./routes/admin";
import { proxyip, debug } from "./routes/tools";
import { json, text } from "./edge/respond";
import { diagVerdict, hostKey, hostRank, loadRtt, logErr } from "./nodes/metrics";
import { checkTarget, dohQuery, expandV6, resolveAAAA } from "./proxy/dial";
import { adminAuthed, effectiveQuota, fmtBytes, newNonce, randomPwd, renderAdmin, renderAdminHint, renderHtml, renderLogin, renderStatsHtml, rlReset, rlTake, sessionToken, sha256Hex, subHeaders } from "./views/panel";
import { loadUsers, saveUsers } from "./proxy/protocol";
import { aliveList, cnt, cntView, commitPool, cronScan, flushPx, nsOf, pxGet, pxSet, spdSnapshot } from "./px/pool";
import { EXTRA_HOSTS, POOL_SOURCES, PX_LINE, probeProxy, probeSni, regionListAsync, takePoolLine } from "./px/probe";
import { capOf, costOf, nsGet, p90Of, pFailOf, pStallOf, pctOf, ZERO_STAT } from "./nodes/score";
import { S } from "./core/state";
import { flushSnap, getSnap, pendFlush, readStats, readStatsCached, restoreUsage, usageSnapGet, usageSnapWrite } from "./store/index";
import { renderClash, renderLinks, renderSingbox, trojanPasswordOf } from "./views/sub";
import { P_T, VERSION } from "./core/util";
import { connect } from "cloudflare:sockets";

/**
 * ============================================================================
 *  VLESS + Trojan over WebSocket  ——  Cloudflare Workers 单文件实现
 * ============================================================================
 *
 *  数据面：客户端 ──wss──► 本 Worker ──connect()──► 目标
 *                          直连失败（CF 托管站点）→ proxyip 中转
 *                          带 &rg=xx → 强制走该国代理出口
 *
 *  控制面：/<uuid> 控制台 · /cl|/sb|/ty 订阅 · /stats 用量 · /proxyip 池
 *          /admin 登录式用户管理（挑战-应答，密码不出浏览器）
 *
 *  ── 目录 ──────────────────────────────────────────────────────────────
 *  §1   常量与工具
 *  §2   SHA-224（Trojan 鉴权；WebCrypto 无此算法）
 *  §3   用户与鉴权（env + KV 合并）
 *  §4   协议侦测与解析（VLESS / Trojan）
 *  §5   出口策略与拨号（私网拦截、sslip、NAT64）
 *  §6.1 流量统计
 *  §6.2 proxyip 代理池（探测 / 轮换 / Cron）
 *  §6.3 RTT 学习 + 错误日志
 *  §7   WebSocket 数据面
 *  §8   配置下发（clash / sing-box / base64 / html）
 *  §8b  用户管理面板（登录 + 增删改）
 *  §9   路由与响应
 *
 *  ── 环境变量 ──────────────────────────────────────────────────────────
 *  uuid / uuids    必填   VLESS 身份，逗号分隔多用户
 *  trojan          可选   "uuid:password,uuid:password"
 *  nodes           可选   "host:port:tls[:name],..."（订阅里用的入口）
 *  regions         可选   "auto" 或 "JP,US,HK"（地区出口节点）
 *  proxyip         可选   "auto" 自动池 / "h:p" 手动 / "" 关闭
 *  adminKey        可选   管理面板登录密码（未设则面板不可用）
 *  pageKey         可选   控制页/订阅的访问口令 ?k=
 *  quotaBytes      可选   订阅头里显示的总量
 *  expireAt        可选   到期时间（ISO 或 unix 秒）
 *  pxDwellMin      可选   切换后最少驻留分钟数（默认 360）
 *  pxFailMax       可选   连续失败多少次才允许换（默认 5）
 *  pxForceAt       可选   失败到多少强制换（默认 8）
 *  pxSchedH        可选   定时轮换周期小时数（0 关闭，默认 6）
 *  STATS           KV     统计 / RTT / 代理池 / 用户表
 *
 *  ── 安全基线 ──────────────────────────────────────────────────────────
 *  · 无硬编码凭据；未知路径 404，不泄露 request.cf
 *  · 出站拦截私网/保留/元数据地址与危险端口（含外部候选池）
 *  · 管理面板：nonce + SHA-256 挑战应答，HttpOnly 会话 cookie，失败限速
 *  · 所有异步链路均有 catch，KV 不可用时降级为内存模式
 * ============================================================================
 */

/* ==================================================================
 * §6.3  RTT 学习 + 错误环形缓冲
 *   客户端连的是哪个入口 IP，由订阅里的 path 标签带上来；
 *   真实延迟由 request.cf.clientTcpRtt 提供。
 *   按「运营商 ASN + 城市」聚合，同一个地方的同运营商共享统计。
 * ================================================================== */

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
          let stored = [];
          try {
            const snap = await getSnap(env);
            stored = snap.errs || [];
          } catch (e: any) {}
          // 再并上 DO 里那份（跨 isolate），否则永远只能看到"当前这个实例"的 50 条
          let fromDo = [];
          if (env.METER) {
            try {
              const stub = env.METER.get(env.METER.idFromName(id));
              const r = await stub.fetch("https://meter/cnt");
              const j = await r.json();
              fromDo = (j && j.e) || [];
            } catch (e: any) {}
          }
          const seen = new Set();
          const all = [];
          for (const x of [...fromDo, ...stored, ...S.errs]) {
            if (!x || !x.t || seen.has(x.t)) continue;
            seen.add(x.t);
            all.push(x);
          }
          all.sort((a2, b2) => a2.t - b2.t);
          const out = all.slice(-50);
          return json({ count: out.length, persisted: stored.length, fromDo: fromDo.length, items: out });
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

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          await cronScan(env);
        } catch (e: any) {
          logErr(`cron: ${e && e.message ? e.message : e}`);
        }
        // 定时持久化的唯一入口：每轮 cron 最多各写 1 次
        try { await pendFlush(env, true); } catch (e: any) {}
        // cronScan 内部已经落过一次 seed（且自带 55 分钟节流），这里只补写脏数据
        try { if (S.seedDirty) await flushPx(env); } catch (e: any) {}
        try {
          // 先把快照续回 DO（重建脚本后不会从 0 开始），再写新快照
          const snap = await usageSnapGet(env);
          if (snap && snap.users) {
            for (const id of Object.keys(snap.users)) await restoreUsage(env, id, snap);
          }
          await usageSnapWrite(env);
        } catch (e: any) {}
        // 不传 force：让 flushSnap 走「1h/2h + 全局 45 分钟闸门」的节奏
        try { await flushSnap(env); } catch (e: any) {}
      })()
    );
  },
};

/* 供单测导出（Workers 运行时忽略额外导出） */

export { Meter } from "./store/meter";
