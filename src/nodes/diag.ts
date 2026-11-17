/**
 * 诊断结论推导：把「站点 × 节点」样本与直连对照读成一句人话。
 *
 * 纯函数：没有 IO、不读 `S`，所以可以直接喂样本单测 —— 它是 `/<uuid>/debug?diag=` 的唯一判定入口，
 * 改规则时要能单独验证（这也是它独立成文件的原因）。
 */

/**
 * 由样本推出结论（纯函数，便于单测）。
 * @param {Array} rows [{node, cc, n, ok, bad, bytes, ttfb}]
 * @param {{ok:number,bad:number}} direct 直连对照
 * @returns {{kind:string, verdict:string, suspect:string[]}}
 */
export function diagVerdict(
  rows: Array<{ node: string; n: number; ok: number; bad: number; cc?: string }> | null,
  direct: HDirect | null,
) {
  const tested = (rows || []).filter((r) => r.n > 0);
  const suspect = tested.filter((r) => r.bad >= 1 && r.bad * 2 >= r.n);
  const d = direct || { ok: 0, bad: 0 };

  if (!tested.length) {
    return {
      kind: "empty",
      verdict: "还没有样本：先访问一次这个站，或者加 &probe=1 做一轮主动探测",
      suspect: [],
    };
  }
  if (!suspect.length) {
    return {
      kind: "ok",
      verdict: `正常：${tested.length} 个节点有样本，没有可疑的`,
      suspect: [],
    };
  }
  const names = suspect.map((r) => r.node);
  if (suspect.length < tested.length) {
    const ccs = [...new Set(suspect.map((r) => String(r.cc || "").toUpperCase()).filter(Boolean))];
    if (ccs.length === 1 && suspect.length >= 2) {
      return {
        kind: "geo",
        verdict: `${suspect.length}/${tested.length} 个节点可疑，且都集中在 ${ccs[0]}：疑似地区 / ASN 规则，避开该地区即可`,
        suspect: names,
      };
    }
    return {
      kind: "ip",
      verdict: `${suspect.length}/${tested.length} 个节点可疑，分散在不同地区：疑似单 IP 信誉被拉黑（已按站避开）`,
      suspect: names,
    };
  }
  if (d.ok > 0 && d.ok >= d.bad) {
    return {
      kind: "pool",
      verdict: "全部节点都被拦，但直连正常：整个中转池的 IP 段被这个站拉黑了，换节点没用，得换出口类型",
      suspect: names,
    };
  }
  return {
    kind: "unknown",
    verdict: "全部节点都被拦，直连也不通：大概率是站点自身规则（地区封锁 / 登录态）或 TLS 指纹，需用浏览器直连验证一次",
    suspect: names,
  };
}
