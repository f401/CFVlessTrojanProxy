// 模块级单例准入门禁：docs/命名约定.md 的清单必须与实际 `export const X = new Y()` 一一对应。
// 为什么需要：命名约定.md 曾写「只剩 29 个」，而实际有 47 个自定义类单例 —— 准入测试
// （「新加一个前先回答属于哪类」）因此形同虚设，新增一个未登记的单例不会有任何门禁变红。
// 与 check-names 同款棘轮：清单在 START/END 之间，代码里冒出新名字或清单写了已删的名字都 exit(1)。
import fs from "node:fs";
import path from "node:path";

/** 内置类不算「自定义的跨请求状态持有者」，无需登记。 */
const BUILTIN = new Set(["Set", "Map", "TextEncoder", "TextDecoder", "Uint32Array", "Array", "Date", "URL", "RegExp", "Error", "WeakMap"]);

/**
 * 递归收集目录下所有 .ts 文件。
 * @param {string} d 起始目录
 * @param {string[]} out 累积结果
 * @returns {string[]} 文件路径数组
 */
function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const found = new Map(); // name -> file(cls)[]
for (const f of walk("src")) {
  const s = fs.readFileSync(f, "utf8");
  const re = /export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*new\s+([A-Za-z_$][\w$]*)\s*[\(<]/g;
  let m;
  while ((m = re.exec(s))) {
    if (BUILTIN.has(m[2])) continue;
    if (!found.has(m[1])) found.set(m[1], []);
    found.get(m[1]).push(`${f.replace(/\\/g, "/")}(${m[2]})`);
  }
}

// 文档用显式标记包住当前实例清单（反面清单/已删实例在标记之外，不参与比对）。
// DOC 环境变量供单测指向临时副本，验证门禁真的会抓漂移。
const docPath = process.env.SINGLETON_DOC || "docs/命名约定.md";
const doc = fs.readFileSync(docPath, "utf8");
const OPEN = "<!-- singleton-list:start -->";
const CLOSE = "<!-- singleton-list:end -->";
const a = doc.indexOf(OPEN);
const b = doc.indexOf(CLOSE);
if (a < 0 || b < 0 || b < a) {
  console.error("SINGLETON_DOC_MARKER_MISSING: docs/命名约定.md 缺少 singleton-list 起止标记");
  process.exit(1);
}
const section = doc.slice(a + OPEN.length, b);
const listed = new Set([...section.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]));

let bad = 0;
const names = [...found.keys()].sort();
for (const n of names) {
  if (!listed.has(n)) {
    console.error(`SINGLETON_UNDOCUMENTED: ${n} (${found.get(n).join(", ")}) 未登记在 docs/命名约定.md 清单`);
    bad++;
  }
}
for (const n of [...listed].sort()) {
  if (!found.has(n)) {
    console.error(`SINGLETON_STALE_DOC: 清单列了 \`${n}\` 但代码里已无此模块级实例`);
    bad++;
  }
}
if (bad) {
  console.error(`单例门禁失败：${bad} 处不一致（实际 ${names.length} 个自定义类单例，清单 ${listed.size} 个）`);
  process.exit(1);
}
console.log(`单例门禁通过：${names.length} 个自定义类单例与清单一一对应`);
