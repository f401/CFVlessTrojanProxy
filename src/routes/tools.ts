import { errMsg } from "../core/util";

import { SC } from "../core/const";
import { S } from "../core/state";
import { dial } from "../proxy/dial";

import { json, text } from "../edge/respond";
import { diagVerdict, hostKey, hostRank, logErr } from "../nodes/metrics";
import { ZERO_STAT, capOf, costOf, scoreParts, nsGet, p90Of, pFailOf, pStallOf, pctOf } from "../nodes/score";
import { nodeSnapGet } from "../store/index";
import { checkTarget, dohQuery, expandV6, resolveAAAA } from "../proxy/dial";
import { aliveList, cnt, cntView, commitPool, cronScan, flushPx, nsOf, pxGet, pxSet, spdSnapshot } from "../px/pool";
import { EXTRA_HOSTS, POOL_SOURCES, PX_LINE, probeProxy, probeSni, regionListAsync, takePoolLine } from "../px/probe";
import { restoreUsage, primaryId } from "../store/index";
import { adminAuthed } from "../views/auth";

import type { RouteCtx } from "../edge/types";

type UserCtx = RouteCtx & { id: string };

/** 会改全局状态/花 KV 额度的调试动作：要求管理员会话或 &k=adminKey */
async function adminOnly(c: UserCtx): Promise<Response | null> {
  if (await adminAuthed(c.request, c.url, c.env)) return null;
  return new Response(JSON.stringify({ ok: false, error: "需要管理员登录 /admin，或加 &k=<adminKey>" }), {
    status: 403,
    headers: { "content-type": "application/json;charset=utf-8" },
  });
}

/** /<uuid>/proxyip：中转池现状（?why=1 带选择原因） */
export async function proxyip(c: UserCtx): Promise<Response> {
  const { env, url, host, id } = c;

          // 全局日计数（从 snap 快照读，最多 1 小时延迟）
          if (url.searchParams.get("day") === "1") {
            let g = null;
            let nodesSnap = {};
            if (env.METER) {
              try {
                const stub = env.METER.get(env.METER.idFromName(primaryId(env) || id));
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
            const deny = await adminOnly(c);
            if (deny) return deny;
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
            const deny = await adminOnly(c);
            if (deny) return deny;
            const sn = Number(url.searchParams.get("scan"));
            S.scanN = Number.isFinite(sn) && sn > 12 ? sn : 12;
            if (Date.now() - S.lastManual > 5000) {
              S.lastManual = Date.now();
              await cronScan(env).catch((e) => logErr("cron: " + (errMsg(e))));
            }
          }
          const px = await pxGet(env);
          const alive = px.alive || [];
          const stat: Record<string, unknown> = px.state || {};
          const aliveKeys = (alive || []).map((x) => x.h + ":" + x.p);
          const nsMap = nsOf(aliveKeys);
          // 并上 DO 里的跨 isolate 快照：否则换 isolate 看就是一片 kbps=0
          const snapS = await nodeSnapGet(env, id);
          for (const [k, v] of Object.entries(snapS)) {
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
          const modeQ = url.searchParams.get("mode") === "lat" ? "lat" : "tput";
          const poolSize = Number(stat.poolN) || 0;
          const blacklist = [...S.nstat.entries()].filter(([, s]) => s.blackUntil > Date.now()).map(([k]) => k);
          const rows = (alive || []).map((x) => {
            const k = x.h + ":" + x.p;
            const ns: Record<string, number> = (nsMap as Record<string, Record<string, number>>)[k] || {};
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

          const out: Record<string, unknown> = {
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
              const sp = scoreParts(r.node, modeQ);
              return {
                k: r.node,
                v: Math.round(sp.score),
                chosen: S.curs[modeQ] === r.node,
                // 与排序用的是同一份分项，不再另写一套诊断公式
                parts: {
                  latencyMs: Math.round(sp.latencyMs),
                  e10Ms: Math.round(sp.e10Ms),
                  pFailRisk: Math.round(sp.pFailRisk * 1000) / 1000,
                  pStall: Math.round(sp.pStall * 1000) / 1000,
                  capBps: Math.round(sp.capBps),
                  confB: Math.round(sp.confB * 1000) / 1000,
                  nEff: Math.round(sp.nEff * 10) / 10,
                  latN: Math.round(sp.latN * 10) / 10,
                  sampleAgeMs: sp.sampleAgeMs < 0 ? -1 : Math.round(sp.sampleAgeMs),
                  priorSource: sp.priorSource,
                  gate: sp.gate,
                },
                n: r.n,
                bytes: r.bytes,
              };
            });
          }

          return json(out);
        
}

/** /<uuid>/debug：站点诊断（?diag=<host>&probe=1 做一次 SNI 探测） */
export async function debug(c: UserCtx): Promise<Response> {
  const { env, url, host, id, first, ctx } = c;

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

            const fam = hostKey(diagHost);
            const rows: DiagRow[] = [];
            const m = S.hostNode.get(fam);
            if (m) {
              for (const [node, s] of m) {
                rows.push({ node, cc: ccOf[node] || "", ...s });
              }
            }
            rows.sort((a, b) => b.n - a.n);

            const direct = S.hostDirect.get(diagHost) || { ok: 0, bad: 0, at: 0 };

            // 主动探测：不信历史样本时，直接拿每个节点试一次
            // （只验"能不能把这个 SNI 转出去"，看不到 HTTP 状态）
            let probe: Array<{ node: string; cc: string } & SniProbe> | null = null;
            if (url.searchParams.get("probe") === "1") {
              probe = await Promise.all(
                alive.slice(0, 8).map(async (a) => {
                  // 第 4 个参数是探测超时（ms），不是目标端口；以前把 port 传进去，
                  // 默认 443 会把超时压到 443ms，正常的慢站全被判死。
                  const r = await probeSni(a.h, a.p, diagHost);
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
              family: fam,
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
            const deny = await adminOnly(c);
            if (deny) return deny;
            const counts: Record<string, { lines: number; ok: number }> = {};
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
            let commit: Record<string, unknown> = { ok: true, skipped: true };
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
            const deny = await adminOnly(c);
            if (deny) return deny;
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
            const deny = await adminOnly(c);
            if (deny) return deny;
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
              return json({ ok: false, error: String(errMsg(e)) });
            }
            return json({ ok: true, seeded });
          }

          const h = url.searchParams.get("host") || "x.com";
          const out: Record<string, unknown> = { host: h, aaaa: null, a: null, v6Connect: null };
          try { out.aaaa = await resolveAAAA(h); } catch (e) { out.aaaa = "ERR " + errMsg(e); }
          try { out.a = await dohQuery(h, "A"); } catch (e) { out.a = "ERR " + errMsg(e); }
          if (out.aaaa && typeof out.aaaa === "string" && out.aaaa.includes(":")) {
            const bad6 = checkTarget(out.aaaa, 443);
            if (bad6) out.v6Connect = "denied: " + bad6;
            else try {
              const s6 = await connect({ hostname: expandV6(out.aaaa), port: 443 });
              out.v6Connect = "ok";
              try { s6.close(); } catch (e) {}
            } catch (e) {
              out.v6Connect = "ERR " + (errMsg(e));
            }
          }
          return json(out);
        
}
