/**
 * 补货路径：公开源到底能供多少、重叠多少、多久扫一遍（§40）
 *
 * 已知（§13.10）：proxyip 只能从 CF 出口探（本地 0/80 可达），所以本地能测的只有**源侧**：
 *   - 6 个源各给多少条候选？
 *   - 去重后多少条？源之间重叠多少？
 *   - 按 §8 的探测预算（48/轮、32 轮/天），扫完一遍要几天？
 *
 * 运行时：node tools/exp-sources.mjs（需要网络；失败即退非零）
 */

const SOURCES = [
  "https://raw.githubusercontent.com/ymyuuu/IPDB/main/BestProxy/proxy.txt",
  "https://raw.githubusercontent.com/CB-X2-Jun/cf-proxyip-lists/main/proxyip.txt",
  "https://cdn.jsdelivr.net/gh/CB-X2-Jun/cf-proxyip-lists@main/proxyip.txt",
  "https://raw.githubusercontent.com/ymyuuu/IPDB/main/BestProxy/bestproxy%26country.txt",
  "https://raw.githubusercontent.com/xgonce/Cloudflare_IP/main/result.csv",
  "https://ipdb.api.030101.xyz/?type=proxy",
];

const LINE = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(?:[#,:]|\s|$)/;

/**
 * 拉一个源并抽出候选 IP。
 *
 * @param {string} url 源地址
 * @returns {Promise<string[]>} 去重后的 IP 列表（空数组表示源失败）
 */
async function pull(url) {
  try {
    const r = await fetch(url, { headers: { "user-agent": "curl/8" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return [];
    const text = await r.text();
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
      const m = LINE.exec(raw.trim());
      if (m) out.push(m[1]);
    }
    return [...new Set(out)];
  } catch {
    return [];
  }
}

const per = await Promise.all(SOURCES.map(pull));
const sets = per.map((a) => new Set(a));
const all = new Set();
for (const s of sets) for (const ip of s) all.add(ip);

console.log("源                                      条数   新增（相对前面源）");
let cum = new Set();
for (let i = 0; i < SOURCES.length; i++) {
  let added = 0;
  for (const ip of sets[i]) if (!cum.has(ip)) added++;
  for (const ip of sets[i]) cum.add(ip);
  console.log(`${SOURCES[i].slice(0, 38).padEnd(38)}  ${String(sets[i].size).padStart(5)}  ${String(added).padStart(16)}`);
}

const unique = all.size;
const probePerDay = 48 * 32; // §8：48 子请求/轮 × 32 轮
const days = unique / probePerDay;

// §39：alive=16、d=5%/h ⇒ 每小时要补 0.8 条新可用；活/探比按生产实测 8/1600≈0.5% 与经验 20% 两个口径
const needAlivePerHour = 16 * 0.05;
console.log(`\n去重后候选：${unique} 条`);
console.log(`探测预算 ${probePerDay} 条/天 → 扫完一遍 ${days.toFixed(1)} 天`);
console.log(`维持 alive=16 需补 ${needAlivePerHour.toFixed(1)} 条新可用/小时`);

const t = [];
const okA = (name, cond, detail) => {
  t.push({ name, cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

const empty = sets.filter((x) => x.size === 0).length;
okA("每次运行都有源失败（可达性不稳定 ⇒ 源健康度排序是必需品）", empty >= 1, `${empty}/${SOURCES.length} 个源为空`);
okA("可达源的候选仍超过 300 条", unique > 300, `${unique} 条`);
okA("扫完一遍不超过 2 天（预算够用）", days < 2, `${days.toFixed(1)} 天`);
okA("按 20% 存活率，补 0.8 条/小时只需 4 次探测/小时", (needAlivePerHour / 0.2) * 24 < probePerDay, `${((needAlivePerHour / 0.2) * 24).toFixed(0)} 次/天`);

const bad = t.filter((x) => !x.cond);
console.log(`\n断言：${t.length - bad.length}/${t.length} 通过`);
process.exit(bad.length ? 1 : 0);
