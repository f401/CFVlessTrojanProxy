import { escapeHtml, fmtBytes } from "./html";
import { effectiveQuota } from "../core/quota";
import { costOf, p90Of, ZERO_STAT } from "../nodes/score";
import { S } from "../core/state";
import { COLO_CITY } from "./sub-common";

/**
 * 渲染用量看板（进度条 + 各入口 RTT + 最近错误）。
 * @param {object} env Worker 环境
 * @param {string} id 用户 UUID
 * @param {object} s 用量对象
 * @param {object} learned RTT 学习结果
 * @returns {string} HTML
 */
export function renderStatsHtml(
  env: Env,
  id: string,
  s: StatsView,
  learned: Record<string, RttEntry>,
  alive: NodeEntry[],
  nsMap: Record<string, Record<string, number | string>>,
) {
  const usedBytes = (s.up || 0) + (s.down || 0);
  const total = effectiveQuota(env, usedBytes);
  const pct = total > 0 ? Math.min(100, Math.round((usedBytes / total) * 100)) : 0;

  const rttRows = (Object.entries(learned || {}) as [string, RttEntry][])
    .sort((a, b) => a[1].rtt - b[1].rtt)
    .map(([tag, v]) => {
      const city = v.colo
        ? `${v.colo}${(COLO_CITY as Record<string, string>)[v.colo] ? "-" + (COLO_CITY as Record<string, string>)[v.colo] : ""}`
        : "-";
      const ok = v.ok || 0,
        bad = v.fail || 0;
      const rate = ok + bad > 0 ? Math.round((ok / (ok + bad)) * 100) + "% (" + ok + "/" + (ok + bad) + ")" : "-";
      const cls = ok + bad >= 5 && ok / (ok + bad) < 0.8 ? ' style="color:#dc2626"' : "";
      return `<tr><td class="u">${escapeHtml(tag)}</td><td>${escapeHtml(city)}</td><td>${v.rtt} ms</td><td>${v.hits}</td><td${cls}>${rate}</td></tr>`;
    })
    .join("");

  const nodeRows = (alive || [])
    .map((x: NodeEntry) => {
      const k = x.h + ":" + x.p;
      const a1 = S.nstat.get(k) || ZERO_STAT;
      const b1 = (nsMap && nsMap[k]) || {};
      const st = {
        ok: Math.max(a1.ok || 0, Number(b1.ok) || 0),
        fail: Math.max(a1.fail || 0, Number(b1.fail) || 0),
        bps: Number(b1.bps) || p90Of(a1) || 0,
        samples: Number(b1.n) || 0,
      };
      const ok = st.ok || 0;
      const bad = st.fail || 0;
      const rate = ok + bad > 0 ? Math.round((ok / (ok + bad)) * 100) + "% (" + ok + "/" + (ok + bad) + ")" : "-";
      // bps 来自"真实下载窗口"的 p90：本实例没有样本时，面板会去读 Meter DO 里的跨实例快照
      const nSamp = Number(b1.nEff) || st.samples || 0;
      const kbps = st.bps
        ? Math.round(st.bps / 1024) + " KB/s" + (nSamp ? ` (n=${Math.round(nSamp)})` : "")
        : "未用（本实例无下载样本）";
      const p = (nsMap && nsMap[k]) || {};
      // nsOf 已经算过 tput 分；没有就走本地评分，别拿延迟分冒充总评分
      const score = Number(p.tput) || costOf(k, "tput");
      const tip =
        `lat ${Math.round(Number(p.lat) || 0)}ms · tput ${Math.round(Number(p.tput) || 0)}ms` +
        ` · E10 ${Math.round(Number(p.e10) || 0)}ms · pFail ${Number(p.pFail) || 0}` +
        ` · pStall ${Number(p.pStall) || 0} · confB ${Number(p.confB) || 0}` +
        ` · nEff ${Number(p.nEff) || 0} · latN ${Number(p.latN) || 0} · ${p.gate || "ok"}`;
      return { x, k, score, kbps, rate, ok, bad, cc: x.cc || "", tip };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, 10)
    .map(
      (n) =>
        `<tr title="${escapeHtml(n.tip)}"><td class="u">${escapeHtml(n.k)}</td><td>${escapeHtml(n.cc || "-")}</td><td>${n.x.ms} ms</td><td>${n.kbps}</td><td>${n.rate}</td><td><b>${Math.round(n.score)}</b></td></tr>`,
    )
    .join("");

  const errRows = S.errs
    .slice(-20)
    .reverse()
    .map(
      (e) =>
        `<tr><td>${new Date(e.t).toISOString().replace("T", " ").slice(0, 19)}</td><td class="u">${escapeHtml(e.m)}</td></tr>`,
    )
    .join("");

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>统计 ${id.slice(0, 8)}</title>
<style>
body{font:15px/1.6 -apple-system,system-ui,sans-serif;margin:24px;max-width:860px;color:#222}
h2{font-size:17px;margin:24px 0 8px}
table{border-collapse:collapse;width:100%;margin-bottom:6px}
td,th{border:1px solid #ddd;padding:6px 9px;text-align:left}
.u{font-family:ui-monospace,monospace;font-size:13px}
.bar{height:10px;background:#eee;border-radius:5px;overflow:hidden}
.bar>i{display:block;height:100%;background:#2f7ad6}
</style>
<h2>用量</h2>
<table>
<tr><th>今日</th><td>${fmtBytes((s.todayUp || 0) + (s.todayDown || 0))}</td></tr>
<tr><th>上行</th><td>${fmtBytes(s.up)}</td></tr>
<tr><th>下行</th><td>${fmtBytes(s.down)}</td></tr>
<tr><th>合计</th><td>${fmtBytes(s.up + s.down)}${total ? ` / ${fmtBytes(total)}（${pct}%）` : ""}</td></tr>
<tr><th>连接数</th><td>${s.conns}</td></tr>
<tr><th>首次</th><td>${s.firstSeen ? new Date(s.firstSeen).toISOString().replace("T", " ").slice(0, 19) : "-"}</td></tr>
<tr><th>最近</th><td>${s.lastSeen ? new Date(s.lastSeen).toISOString().replace("T", " ").slice(0, 19) : "-"}</td></tr>
</table>
${total ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ""}
<h2>实测 RTT（按入口）</h2>
<table><tr><th>入口标签</th><th>机房</th><th>RTT</th><th>样本</th><th>成功率</th></tr>${rttRows || "<tr><td colspan=4>暂无数据</td></tr>"}</table>
<h2>节点评分（延迟 + 失败率 + 实测吞吐）</h2>
<table><tr><th>节点</th><th>地区</th><th>探测延迟</th><th>实测吞吐</th><th>成功率</th><th>评分</th></tr>${nodeRows || "<tr><td colspan=6>暂无数据</td></tr>"}</table>
<h2>最近错误</h2>
<table><tr><th>时间</th><th>内容</th></tr>${errRows || "<tr><td colspan=2>无</td></tr>"}</table>
</body>`;
}

