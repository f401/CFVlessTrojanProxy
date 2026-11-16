import { escapeHtml, fmtBytes } from "./html";
import { effectiveQuota } from "../core/quota";
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
  nodeRows: StatsNodeRow[],
  errs: ErrItem[],
) {
  const usedBytes = (s.up || 0) + (s.down || 0);
  const total = effectiveQuota(env, usedBytes);
  // 用量百分比：配额不可知时显示 0 而不是 100（旧版这里只有一个 `pct`，看不出是谁的百分比）
  const usedPercent = total > 0 ? Math.min(100, Math.round((usedBytes / total) * 100)) : 0;

  const rttRows = (Object.entries(learned || {}) as [string, RttEntry][])
    .sort((a, b) => a[1].rtt - b[1].rtt)
    .map(([edgeTag, row]) => {
      // 机房展示名：`COLO_CITY` 里没有的机场就只显示三字码，不要拼一个空破折号
      const cityText = row.colo
        ? `${row.colo}${(COLO_CITY as Record<string, string>)[row.colo] ? "-" + (COLO_CITY as Record<string, string>)[row.colo] : ""}`
        : "-";
      const okCount = row.ok || 0;
      const failCount = row.fail || 0;
      const sampleCount = okCount + failCount;
      const successText = sampleCount > 0 ? Math.round((okCount / sampleCount) * 100) + "% (" + okCount + "/" + sampleCount + ")" : "-";
      // 样本 ≥5 且成功率 <80% 才标红：一两次失败不足以说明入口坏了
      const alertStyle = sampleCount >= 5 && okCount / sampleCount < 0.8 ? ' style="color:#dc2626"' : "";
      return `<tr><td class="u">${escapeHtml(edgeTag)}</td><td>${escapeHtml(cityText)}</td><td>${row.rtt} ms</td><td>${row.hits}</td><td${alertStyle}>${successText}</td></tr>`;
    })
    .join("");

  const nodeRowsHtml = (nodeRows || [])
    .map(
      (n) =>
        `<tr title="${escapeHtml(n.tip)}"><td class="u">${escapeHtml(n.k)}</td><td>${escapeHtml(n.cc || "-")}</td><td>${n.ms} ms</td><td>${n.kbps}</td><td>${n.rate}</td><td><b>${Math.round(n.score)}</b></td></tr>`,
    )
    .join("");

  const errRows = (errs || [])
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
<tr><th>合计</th><td>${fmtBytes(usedBytes)}${total ? ` / ${fmtBytes(total)}（${usedPercent}%）` : ""}</td></tr>
<tr><th>连接数</th><td>${s.conns}</td></tr>
<tr><th>首次</th><td>${s.firstSeen ? new Date(s.firstSeen).toISOString().replace("T", " ").slice(0, 19) : "-"}</td></tr>
<tr><th>最近</th><td>${s.lastSeen ? new Date(s.lastSeen).toISOString().replace("T", " ").slice(0, 19) : "-"}</td></tr>
</table>
${total ? `<div class="bar"><i style="width:${usedPercent}%"></i></div>` : ""}
<h2>实测 RTT（按入口）</h2>
<table><tr><th>入口标签</th><th>机房</th><th>RTT</th><th>样本</th><th>成功率</th></tr>${rttRows || "<tr><td colspan=5>暂无数据</td></tr>"}</table>
<h2>节点评分（延迟 + 失败率 + 实测吞吐）</h2>
<table><tr><th>节点</th><th>地区</th><th>探测延迟</th><th>实测吞吐</th><th>成功率</th><th>评分</th></tr>${nodeRowsHtml || "<tr><td colspan=6>暂无数据</td></tr>"}</table>
<h2>最近错误</h2>
<table><tr><th>时间</th><th>内容</th></tr>${errRows || "<tr><td colspan=2>无</td></tr>"}</table>
</body>`;
}

