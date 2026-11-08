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

import { connect } from "cloudflare:sockets";
import "./util";
import "./proto";
import "./net";
import "./store";
import "./px";
import "./metrics";
import "./data";
import "./sub";
import "./panel";
import "./do";

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

      const json = (obj, extra = undefined) =>
        new Response(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2), {
          headers: { "content-type": "application/json;charset=utf-8", ...(extra || {}) },
        });
      const text = (s, extra) =>
        new Response(s, { headers: { "content-type": "text/plain;charset=utf-8", ...(extra || {}) } });

      /* ---------- 健康检查 ---------- */
      if (first === "health") {
        if (pageKey && !keyOk) return new Response("Forbidden", { status: 403 });
        return json({
          ok: true,
          ts: Date.now(),
          uuids: auth.uuids.size,
          [P_T]: auth.trojan.size,
          statEntries: S.stats.size,
          rttBuckets: S.rtt.size,
          errors: S.errs.length,
          colo: cf.colo || "",
          cnt: cntView(),
          kvWrites: S.kvw,
          doCalls: S.doCalls,
          pendSize: S.pend.size,
          pendMs: S.pendMs,
          kvLastWrite: S.kvStat,
          version: VERSION,
        });
      }

      /* ---------- 管理面板（会话登录） ---------- */
      if (first === "admin") {
        const adminKey = String(env.adminKey || "");
        const safeHtml = (body: any, status: any = 200) =>
          new Response(body, {
            status: status || 200,
            headers: {
              "content-type": "text/html;charset=utf-8",
              "cache-control": "no-store",
              "content-security-policy":
                "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
              "x-frame-options": "DENY",
              "x-content-type-options": "nosniff",
              "referrer-policy": "no-referrer",
            },
          });

        if (!adminKey) return safeHtml(renderAdminHint(), 503);
        if (adminKey.length < 12) {
          return new Response("adminKey 太短：请改用 16 位以上随机字符", { status: 503 });
        }

        const sub = (seg[1] || "").toLowerCase();

        // 登出
        if (sub === "logout") {
          return new Response(null, {
            status: 303,
            headers: {
              location: "/admin",
              "set-cookie": "adm=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
            },
          });
        }

        // 登录提交：只收 nonce + sha256(nonce:密码)
        if (sub === "login" && request.method === "POST") {
          const ip = request.headers.get("cf-connecting-ip") || "unknown";
          // 内存计数优先（同一 isolate 内精确），KV 只做跨 isolate 的粗粒度兜底
          if (!rlTake(ip, 10)) {
            return safeHtml(renderLogin(newNonce(), "尝试次数过多，请 10 分钟后再试"), 429);
          }

          const f = await request.formData();
          const n = String(f.get("n") || "");
          const p = String(f.get("p") || "").toLowerCase();
          const ts = parseInt(n.split(".")[0], 16);
          if (!n || !p) return safeHtml(renderLogin(newNonce(), "缺少参数"), 400);
          if (!ts || Date.now() - ts > 300000) {
            return safeHtml(renderLogin(newNonce(), "登录已过期，请重试"), 400);
          }
          const want = await sha256Hex(`${n}:${adminKey}`);
          if (p !== want) {
            return safeHtml(renderLogin(newNonce(), "密码错误"), 401);
          }
          rlReset(ip);

          const tok = await sessionToken(env);
          return new Response(null, {
            status: 303,
            headers: {
              location: "/admin",
              "set-cookie": `adm=${tok}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
            },
          });
        }

        // 其余都要已登录
        if (!(await adminAuthed(request, url, env))) {
          if (request.method === "POST") return new Response("Forbidden", { status: 403 });
          return safeHtml(renderLogin(newNonce(), ""));
        }

        // 用户操作
        if (sub === "op" && request.method === "POST") {
          const f = await request.formData();
          const op = String(f.get("op") || "");
          const target = String(f.get("id") || "").toLowerCase();
          const cur = await loadUsers(env);
          let list = cur.list.filter((x) => x.managed).map((x) => ({ ...x }));

          if (op === "add") {
            list.push({
              id: crypto.randomUUID(),
              pwd: randomPwd(16),
              note: String(f.get("note") || "").slice(0, 40),
              enabled: true,
              managed: true,
              ts: Date.now(),
            });
          } else if (op === "del") {
            list = list.filter((x) => x.id !== target);
          } else if (op === "toggle") {
            list = list.map((x) => (x.id === target ? { ...x, enabled: x.enabled === false } : x));
          } else if (op === "reset") {
            list = list.map((x) => (x.id === target ? { ...x, pwd: randomPwd(16) } : x));
          }

          await saveUsers(env, list);
          return new Response(null, { status: 303, headers: { location: "/admin" } });
        }

        // 面板
        const users = await loadUsers(env);
        // 用量从 Meter DO 取（和 /stats 同一个口径）。
        // 以前读的是 `stats:<date>` 这个早已废弃的键 —— 迁移到 snap/DO 之后
        // 它再也没人写，"今日用量" 永远是 0。
        const statsMap = {};
        for (const u of users.list) {
          try {
            const s = await readStats(env, u.id);
            statsMap[u.id] = {
              up: s.up || 0, down: s.down || 0,
              todayUp: s.todayUp || 0, todayDown: s.todayDown || 0,
            };
          } catch (e) {}
        }
        return safeHtml(renderAdmin(url, users, statsMap));
      }

      /* ---------- 需要合法 UUID 的路由 ---------- */
      if (!auth.uuids.has(first)) return new Response("Not Found", { status: 404 });
      if (!keyOk) return new Response("Forbidden", { status: 403 });

      const id = first;
      const sub = (seg[1] || "").toLowerCase();
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
        case "": {
          // 注意：不要写成 (await pxGet(env)).cur —— 那会在数组字面量里
          // 先串行 await 一次，Promise.all 就只剩两个成员了。
          const px0 = pxGet(env).then((x) => x.cur);
          const [st, curPx, alive] = await Promise.all([
            readStatsCached(env, id),
            px0,
            aliveList(env),
          ]);
          const f: any = S.funnel || {};
          const ftot = (f.direct || 0) + (f.node || 0) + (f.v6 || 0);
          const pctOf = (x) => (ftot > 0 ? Math.round((x / ftot) * 1000) / 10 + "%" : "-");
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
            [P_T + "Pwd"]: trojanPasswordOf(env, id),
            policy: `滞回 15% · 驻留 ${Math.round(SC.DWELL / 60000)} 分钟 · 每小时最多 ${SC.BUDGET} 次切换 · 影子 ${Math.round((Number(env.pxShadow) || 0.1) * 100)}%`,
          };
          return new Response(renderHtml(env, url, id, host, pageKey, info), {
            headers: {
              "content-type": "text/html;charset=utf-8",
              "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
              "x-frame-options": "DENY",
              "x-content-type-options": "nosniff",
              "referrer-policy": "no-referrer",
            },
          });
        }

        case "cl":
        case "pcl": {
          const s = await readStatsCached(env, id);
          return text(renderClash(env, url, id, host, learned, regions), subHeaders(env, s));
        }

        case "sb":
        case "psb": {
          const s = await readStatsCached(env, id);
          return json(renderSingbox(env, url, id, host, learned, regions), subHeaders(env, s));
        }

        case "ty":
        case "pty": {
          const s = await readStatsCached(env, id);
          return text(renderLinks(env, url, id, host, learned, regions), subHeaders(env, s));
        }

        case "stats": {
          const s = await readStatsCached(env, id);
          if (url.searchParams.get("format") === "html") {
            const alive = await aliveList(env);
            // 明细只算要展示的节点（以前是为整张 nstat 生成，能到几千条）
            const nsMap = nsOf(alive.map((x: any) => x.h + ":" + x.p));
            return new Response(renderStatsHtml(env, id, s, learned, alive, nsMap), {
              headers: { "content-type": "text/html;charset=utf-8" },
            });
          }
          return json(s);
        }

        case "logs": {
          let stored = [];
          try {
            const snap = await getSnap(env);
            stored = snap.errs || [];
          } catch (e) {}
          // 再并上 DO 里那份（跨 isolate），否则永远只能看到"当前这个实例"的 50 条
          let fromDo = [];
          if (env.METER) {
            try {
              const stub = env.METER.get(env.METER.idFromName(id));
              const r = await stub.fetch("https://meter/cnt");
              const j = await r.json();
              fromDo = (j && j.e) || [];
            } catch (e) {}
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
          // 全局日计数（从 snap 快照读，最多 1 小时延迟）
          if (url.searchParams.get("day") === "1") {
            let g = null;
            let nodesSnap = {};
            if (env.METER) {
              try {
                const stub = env.METER.get(env.METER.idFromName(id));
                const r = await stub.fetch("https://meter/cnt");
                const j = await r.json();
                g = j && j.g;
                nodesSnap = (j && j.s) || {};
              } catch (e) {}
            }
            return json({ date: (g && g.d) || "", cnt: g || {}, nodes: nodesSnap, local: cntView(), localSpd: spdSnapshot(), now: Date.now() });
          }
          // 清空 alive，让下一轮扫描重新挑（用于洗掉早期误判进来的节点）
          if (url.searchParams.get("reset") === "1") {
            S.alive = new Map();
            S.nstat = new Map();
            S.curs = { lat: "", tput: "" };
            S.prev = { lat: "", tput: "" };
            S.lastSwitch = { lat: 0, tput: 0 };
            S.switchHits = { lat: [], tput: [] };
            S.lastUp = 0;
            S.lastManual = 0;
            S.funnel = { direct: 0, node: 0, v6: 0 };
            return json({ ok: true, alive: 0, curs: S.curs });
          }

          if (url.searchParams.get("refresh") === "1") {
            const sn = Number(url.searchParams.get("scan"));
            S.scanN = Number.isFinite(sn) && sn > 12 ? sn : 12;
            if (Date.now() - S.lastManual > 5000) {
              S.lastManual = Date.now();
              await cronScan(env).catch((e) => logErr("cron: " + (e && e.message ? e.message : e)));
            }
          }
          const px = await pxGet(env);
          const alive = px.alive || [];
          const stat: any = px.state || {};
          const aliveKeys = (alive || []).map((x) => x.h + ":" + x.p);
          const nsMap = nsOf(aliveKeys);
          const modeQ = url.searchParams.get("mode") === "lat" ? "lat" : "tput";
          const poolSize = Number(stat.poolN) || 0;
          const blacklist = [...S.nstat.entries()].filter(([, s]) => s.blackUntil > Date.now()).map(([k]) => k);
          const rows = (alive || []).map((x) => {
            const k = x.h + ":" + x.p;
            const ns = nsMap[k] || {};
            return {
              node: k,
              ms: x.ms,
              cc: x.cc || "",
              score: Math.round(costOf(k, "lat") * 10) / 10,
              lat: Math.round(costOf(k, "lat")),
              tput: Math.round(costOf(k, "tput")),
              kbps: ns.bps ? Math.round(ns.bps / 1024) : 0,
              kbpsMed: ns.bpsMed ? Math.round(ns.bpsMed / 1024) : 0,
              n: ns.n || 0,
              bytes: ns.bytes || 0,
              pFail: ns.pFail || 0,
              pStall: ns.pStall || 0,
              ok: ns.ok || 0,
              fail: ns.fail || 0,
              black: blacklist.includes(k),
              cur: S.curs.lat === k || S.curs.tput === k,
            };
          }).sort((a, b) => (modeQ === "lat" ? a.lat - b.lat : a.tput - b.tput));

          const out: any = {
            mode: String(env.proxyip || "").trim().toLowerCase() === "auto" ? "auto" : "manual",
            colo: stat.colo || "??",
            cnt: cntView(),
            current: S.curs.tput || S.curs.lat || "",
            curs: { ...S.curs },
            failCount: S.pxFailMem,
            funnel: stat.funnel || { direct: 0, node: 0, v6: 0 },
            rotatePolicy: { minDwellSec: Math.round(SC.DWELL / 1000), budgetPerHour: SC.BUDGET, shadow: Number(env.pxShadow) || 0.1 },
            alive: rows,
            regions: await regionListAsync(env),
            blacklist,
            pool: {
              size: poolSize,
              gen: Number(stat.gen) || 0,
              poolKey: stat.poolKey || "",
              builtAt: Number(stat.builtAt) || 0,
              memOnly: true,
            },
            stat: stat || {},
          };

          if (url.searchParams.get("why") === "1") {
            // 站点级偏好：哪些站被钉在了哪个节点上（最多 12 条，按样本数排）
            const hp = [...S.hostNode.entries()]
              .map(([h, m]) => {
                let n = 0, ok = 0, bad = 0, ttfb = 0;
                for (const s of m.values()) {
                  n += s.n; ok += s.ok; bad += s.bad;
                  if (s.ttfb && (!ttfb || s.ttfb < ttfb)) ttfb = s.ttfb;
                }
                const rank = hostRank(h, modeQ);
                return {
                  host: h, nodes: m.size, n, ok, bad, bestTtfb: ttfb,
                  pick: rank.length ? rank[0].k : "",
                  pickV: rank.length ? Math.round(rank[0].v) : 0,
                };
              })
              .sort((a, b) => b.n - a.n)
              .slice(0, 12);
            out.hostPref = hp;
            out.explain = rows.slice(0, 8).map((r) => {
              const s = S.nstat.get(r.node) || {};
              const tcp = Math.round(s.tcp || r.ms || SC.P_TCP);
              const tls = Math.round(s.tls || SC.P_TLS);
              const pf = pFailOf(s), pst = pStallOf(s);
              const bps = capOf(s);
              const e10 = bps > 0 ? Math.round((10 * 1048576 / bps) * 1000) : Math.round((10 * 1048576 / SC.PRIOR_BPS) * 1000);
              const terms = modeQ === "tput"
                ? { e10mb: e10, tcp: Math.round(tcp * 0.5), fail: Math.round(pf * SC.FAIL), stall: Math.round(pst * SC.STALL), gate: 0 }
                : { tcp, tls: Math.round(tls * SC.TLS_G), loss: Math.round(Math.max(0, tls - 2 * tcp - SC.LOSS_SLACK) * SC.LOSS_G), fail: Math.round(pf * SC.FAIL), stall: Math.round(pst * SC.STALL), gate: 0 };
              return {
                k: r.node,
                v: modeQ === "lat" ? r.lat : r.tput,
                chosen: S.curs[modeQ] === r.node,
                terms,
                n: r.n,
                bytes: r.bytes,
                pFail: Math.round(pf * 1000) / 1000,
                pStall: Math.round(pst * 1000) / 1000,
                bps_p90: Math.round(p90Of(s) || s.seedBps || 0),
                bps_med: Math.round(pctOf(s, 0.5) || 0),
                bps_cap: Math.round(bps),
              };
            });
          }

          return json(out);
        }

        case "debug": {
          /* ---------- 站点诊断：这个站该用哪个节点 / 为什么被拦 ---------- */
          const diagHost = String(url.searchParams.get("diag") || "").trim().toLowerCase();
          if (diagHost) {
            if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(diagHost)) {
              return json({ ok: false, error: "域名格式不对" });
            }
            const port = Number(url.searchParams.get("port")) || 443;
            const alive = await aliveList(env);
            const ccOf: Record<string, string> = {};
            for (const a of alive) ccOf[a.h + ":" + a.p] = a.cc || "";

            const rows: any[] = [];
            const m = S.hostNode.get(diagHost);
            if (m) {
              for (const [node, s] of m) {
                rows.push({ node, cc: ccOf[node] || "", ...s });
              }
            }
            rows.sort((a, b) => b.n - a.n);

            const direct = S.hostDirect.get(diagHost) || { ok: 0, bad: 0, at: 0 };

            // 主动探测：不信历史样本时，直接拿每个节点试一次
            // （只验"能不能把这个 SNI 转出去"，看不到 HTTP 状态）
            let probe: any[] | null = null;
            if (url.searchParams.get("probe") === "1") {
              probe = await Promise.all(
                alive.slice(0, 8).map(async (a) => {
                  const r = await probeSni(a.h, a.p, diagHost, port);
                  return { node: a.h + ":" + a.p, cc: a.cc || "", ...r };
                })
              );
            }

            // 有真实样本就用真实样本；没有就退化成这一轮探测的结果
            let basis = rows;
            let basisLabel = "真实流量";
            if (!rows.length && probe) {
              basis = probe.map((p) => ({
                node: p.node, cc: p.cc, n: 1,
                ok: p.err ? 0 : 1, bad: p.err ? 1 : 0,
                bytes: 0, ttfb: p.hs || 0,
              }));
              basisLabel = "主动探测";
            }
            const v = diagVerdict(basis, direct);

            return json({
              host: diagHost,
              port,
              kind: v.kind,
              verdict: v.verdict,
              suspect: v.suspect,
              basis: basisLabel,
              direct,
              samples: rows,
              probe,
              alive: alive.length,
              note: "Worker 看不到 HTTP 状态码（TLS 端到端），这里靠的是连接结果与对照",
            });
          }

          const pr = url.searchParams.get("probe");
          if (pr) {
            const idx = pr.lastIndexOf(":");
            const ph = idx > 0 ? pr.slice(0, idx) : pr;
            const pp = Number(idx > 0 ? pr.slice(idx + 1) : 443) || 443;
            const bad = checkTarget(ph, pp);
            if (bad) return json({ probe: pr, ok: false, error: bad });
            const r = await probeProxy(ph, pp);
            return json({ probe: pr, ok: !!r, result: r });
          }
          if (url.searchParams.get("refill") === "1") {
            const counts = {};
            const merged = new Map();
            let total = 0;
            for (const src of POOL_SOURCES) {
              const one = new Map();
              let lines = 0;
              try {
                const r = await fetch(src, { headers: { "user-agent": "curl/8" } });
                if (r.ok) {
                  const txt = await r.text();
                  for (const l of txt.split("\n")) {
                    if (PX_LINE.test(l.trim())) lines++;
                    takePoolLine(l, src, one);
                  }
                } else {
                  lines = -r.status;
                }
              } catch (e) {
                lines = -1;
              }
              counts[src] = { lines, ok: one.size };
              total += one.size;
              for (const [k, v] of one) if (!merged.has(k)) merged.set(k, v);
            }
            for (const h of EXTRA_HOSTS) {
              if (!merged.has(h + ":443")) merged.set(h + ":443", { h, p: 443, src: "builtin" });
            }
            // 默认提交（debug 端点已有 UUID 鉴权）；&dry=1 只看不写，&force=1 无视线池 60% 守卫
            let commit: any = { ok: true, skipped: true };
            if (merged.size && url.searchParams.get("dry") !== "1") {
              commit = await commitPool(env, [...merged.values()], url.searchParams.get("force") === "1");
            }
            return json({
              sources: counts,
              merged: total,
              pool: merged.size,
              committed: !!commit.ok && !commit.skipped,
              gen: commit.gen || 0,
              reason: commit.reason || "",
              kvLastWrite: S.kvStat,
              extra: EXTRA_HOSTS,
            });
          }

          // 手动指定当前节点：?cur=1.2.3.4:443（用于对比不同节点的真实速度）
          if (url.searchParams.get("cur")) {
            const want = String(url.searchParams.get("cur")).trim();
            if (!/^[0-9a-zA-Z.\-]+:\d+$/.test(want)) return json({ ok: false, error: "格式应为 host:port" });
            await pxSet(env, { cur: want });
            const s0 = nsGet(want);
            s0.blackUntil = 0; s0.freeUntil = 0; s0.streak = 0;
            await flushPx(env, true);
            S.pxFailMem = 0;
            return json({ ok: true, cur: want, curs: S.curs });
          }

          // 手动把 KV 快照续回 DO
          if (url.searchParams.get("restore") === "1") {
            const v = await restoreUsage(env, id);
            return json({ ok: !!v, restored: v || null });
          }

          // 手动回填用量（仅在 DO 累计为 0 时生效，用于重建脚本后恢复历史数字）
          if (url.searchParams.get("seed")) {
            const [u0, d0, c0] = String(url.searchParams.get("seed")).split(",").map((x) => Number(x) || 0);
            const px0 = await pxGet(env);
            void px0;
            let seeded = null;
            try {
              const stub = env.METER.get(env.METER.idFromName(id));
              const r = await stub.fetch("https://meter/seed", {
                method: "POST",
                body: JSON.stringify({ up: u0, down: d0, conns: c0, first: Date.now() }),
              });
              seeded = await r.json();
              S.meterCache.set(id, { v: seeded, t: Date.now() });
            } catch (e) {
              return json({ ok: false, error: String((e && e.message) || e) });
            }
            return json({ ok: true, seeded });
          }

          const h = url.searchParams.get("host") || "x.com";
          const out = { host: h, aaaa: null, a: null, v6Connect: null };
          try { out.aaaa = await resolveAAAA(h); } catch (e) { out.aaaa = "ERR " + e.message; }
          try { out.a = await dohQuery(h, "A"); } catch (e) { out.a = "ERR " + e.message; }
          if (out.aaaa && typeof out.aaaa === "string" && out.aaaa.includes(":")) {
            try {
              const s6 = await connect({ hostname: expandV6(out.aaaa), port: 443 });
              out.v6Connect = "ok";
              try { s6.close(); } catch (e) {}
            } catch (e) {
              out.v6Connect = "ERR " + (e && e.message ? e.message : e);
            }
          }
          return json(out);
        }

        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (e) {
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
        } catch (e) {
          logErr(`cron: ${e && e.message ? e.message : e}`);
        }
        // 定时持久化的唯一入口：每轮 cron 最多各写 1 次
        try { await pendFlush(env, true); } catch (e) {}
        // cronScan 内部已经落过一次 seed（且自带 55 分钟节流），这里只补写脏数据
        try { if (S.seedDirty) await flushPx(env); } catch (e) {}
        try {
          // 先把快照续回 DO（重建脚本后不会从 0 开始），再写新快照
          const snap = await usageSnapGet(env);
          if (snap && snap.users) {
            for (const id of Object.keys(snap.users)) await restoreUsage(env, id, snap);
          }
          await usageSnapWrite(env);
        } catch (e) {}
        // 不传 force：让 flushSnap 走「1h/2h + 全局 45 分钟闸门」的节奏
        try { await flushSnap(env); } catch (e) {}
      })()
    );
  },
};

/* 供单测导出（Workers 运行时忽略额外导出） */
