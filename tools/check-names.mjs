// 命名门禁：类字段 / 接口成员的名字必须能看出含义。
//
// 规则：成员名长度 ≤ 2 一律不合格，例外只有下面 ALLOW 里逐条写明理由的那几个
// （领域内通用缩写、以及跨 isolate 线协议/DO 存储的键 —— 那些改名要连带迁移旧数据）。
// 这是一个「棘轮」：当前剩余数量记在 tools/naming-baseline.json，只允许下降。
import fs from "node:fs";
import path from "node:path";

/** 允许的短成员名：每一条都要说清为什么短是对的 */
const ALLOW = new Map([
  ["id", "标识符（`id` 就是这个意思，没有更短更明确的写法）"],
  ["ip", "中继地址（线协议里就是 `ip`，面板与事实表同名）"],
  ["cf", "CF 托管标记（`cf` 是 Cloudflare 的公认缩写）"],
  ["ok", "布尔成功标记（判定表 `state === St.Reachable` 之外只有它）"],
  ["up", "上行字节数（与 `down` 成对，量词在字段类型注释里）"],
  ["ms", "毫秒数（单位写在名字里了，等于 `millis`）"],
  ["vt", "判定事实表（五类事实的线协议键之一，改名要迁移 DO 存储）"],
  ["hl", "中继存活事实表（同上）"],
  ["eg", "出口族事实表（同上）"],
  ["ps", "站点成功事实表（同上）"],
  ["dns", "DNS 事实表（同上）"],
  ["cl", "连接样本事实表（同上）"],
  // 以下都是「线协议键」：同时是 JSON 字段名与 DO/KV 存储键，改名要做「新名为主 + 读端接受旧名」的数据迁移。
  // 含义统一写在 docs/命名约定.md §7 的表里，这里不再重复（门禁会检查文档里确实写了）。
  ["at", "观测时刻（线协议键）"],
  ["n", "次数或计数（线协议键）"],
  ["t", "时间戳或到期时间（线协议键）"],
  ["s", "状态或结构体（线协议键）"],
  ["c", "计数或通道（线协议键）"],
  ["k", "键（线协议键）"],
  ["i", "标识（线协议键）"],
  ["j", "JSON 载荷（线协议键）"],
  ["v", "值（线协议键）"],
  ["h", "主机键（线协议键）"],
  ["f", "族或因子（线协议键）"],
  ["q", "质量（线协议键）"],
  ["o", "好计数（线协议键）"],
  ["b", "坏计数（线协议键）"],
  ["d", "死计数（线协议键）"],
  ["e", "错误数组（线协议键）"],
  ["g", "计数器文档（线协议键）"],
  ["v6", "IPv6 观测计数（线协议键）"],
  ["fs", "存储格式代号（线协议键）"],
]);

const walk = (d, a = []) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p, a);
    else if (p.endsWith(".ts")) a.push(p);
  }
  return a;
};

/**
 * 扫出所有过短的类字段 / 接口成员。
 * @returns 形如 `{ file, line, name, line text }` 的清单
 */
function scan() {
  const found = [];
  for (const file of walk("src")) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    let inDecl = false;
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      const t = text.trim();
      if (/^(export\s+)?(abstract\s+)?class\b/.test(t) || /^(export\s+)?interface\b/.test(t) || /^(export\s+)?type\s+\w+\s*=\s*\{/.test(t)) {
        inDecl = true;
      }
      if (inDecl) {
        const m = t.match(/^(?:private\s+|protected\s+|public\s+|readonly\s+|static\s+)*([A-Za-z_$][\w$]*)\??\s*[:=]/);
        if (m) {
          const name = m[1];
          // 关键字与类型名会被同一个正则误命中，这里排除掉
          const isKeyword = /^(if|for|while|new|let|const|var|return|class|interface|type|export|extends)$/.test(name);
          if (!isKeyword && name.length <= 2 && !ALLOW.has(name)) {
            found.push({ file, line: i + 1, name, text: t.slice(0, 80) });
          }
        }
      }
      if (/^\}/.test(t)) inDecl = false;
    }
  }
  return found;
}

const found = scan();
const baselinePath = path.join("tools", "naming-baseline.json");
const limit = fs.existsSync(baselinePath) ? Number(JSON.parse(fs.readFileSync(baselinePath, "utf8")).opaque) : 0;

console.log(`命名门禁：过短成员 ${found.length} 处（基线上限 ${limit}）`);
for (const f of found) console.log(`  ${f.file}:${f.line}  ${f.name}  ${f.text}`);

if (found.length > limit) {
  console.log(`\n命名门禁失败：过短成员比基线多 ${found.length - limit} 处。成员名要能看出含义（≥3 字符），或加进 ALLOW 并写清理由。`);
  process.exitCode = 1;
} else if (found.length < limit) {
  console.log(`\n命名门禁：比基线少了 ${limit - found.length} 处 —— 把 tools/naming-baseline.json 的 opaque 下调到 ${found.length}（棘轮只许往下走）。`);
  process.exitCode = 1;
} else {
  console.log("\n命名门禁通过（与基线一致）");
}

// 与 docs/命名约定.md 的双向一致：ALLOW 里放行的每个短名都必须在文档里有一条解释。
// 只查「代码 → 文档」这一个方向：文档里多写几个普通词不算错，代码里偷偷放行一个没解释的短名才是错。
const convPath = process.env.NAMES_DOC || path.join("docs", "命名约定.md");
const conv = fs.existsSync(convPath) ? fs.readFileSync(convPath, "utf8") : "";
if (!conv) {
  console.log("\n命名门禁失败：找不到 docs/命名约定.md —— ALLOW 的每一条理由都写在那里，文件没了就没法校对。");
  process.exitCode = 1;
} else {
  const missing = [...ALLOW.keys()].filter((k) => !conv.includes("`" + k + "`"));
  if (missing.length) {
    console.log(`\n命名门禁失败：${missing.length} 个放行的短名在 docs/命名约定.md 里没有解释：${missing.join(" / ")}`);
    process.exitCode = 1;
  } else {
    console.log(`命名门禁：ALLOW 的 ${ALLOW.size} 条短名都已在 docs/命名约定.md 里写明理由`);
  }
}

/**
 * 扫「判定状态用裸数字比较」：`v.state === 1` / `state: 2` 这类写法。
 *
 * 为什么要单独一条：`St` 是 7.250 建立的唯一闭集合，但同一批只改了判定表自身，
 * 消费端（policy / prefs / verdictsync / debug）继续写 `state >= 2` —— 一旦枚举增删成员，
 * 这些地方不会报错，只会静默按旧数字走（7.162 / 7.164 的 `dead` 被降级成 `blocked` 就是这么来的）。
 * @returns 违规点列表（文件 / 行 / 原文）
 */
function rawStateLiterals() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!p.endsWith(".ts") || p.replace(/\\/g, "/") === "src/core/enums.ts") continue;
      const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        const t = line.trim();
        // 注释行不算：这些判据的说明里本来就要举例
        if (t.startsWith("//") || t.startsWith("*")) return;
        if (/(?:^|[^.\w])state\s*(?:===|!==|==|<|<=|>|>=)\s*[0123]\b/.test(t) || /\bstate\s*:\s*[0123]\b/.test(t)) {
          out.push({ file: p.replace(/\\/g, "/"), line: i + 1, text: t.slice(0, 100) });
        }
      });
    }
  };
  walk("src");
  return out;
}

const rawState = rawStateLiterals();
if (rawState.length) {
  console.log(`\n命名门禁失败：${rawState.length} 处判定状态用裸数字（改用 St.Reachable / St.Blocked / St.Dead）：`);
  for (const r of rawState) console.log(`  ${r.file}:${r.line}  ${r.text}`);
  process.exitCode = 1;
} else {
  console.log("命名门禁：判定状态没有裸数字");
}
