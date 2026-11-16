// 死导出闸门：`src` 里声明的每个「导出函数 / 导出常量」必须在全仓有真实引用。
//
// 为什么要有这个闸门：`verdict.ts` 里曾有一份与 `VerdictTable.stateOf` 逐字同规则的导出副本
// （`stateOfCode`），`stat.ts` 里曾有一个没人读的 `E10_PRIOR`。两者都能通过 tsc、都能通过
// 单测、也都不会被「注释门禁」看见 —— 死导出不是无害的：同规则两份实现一旦分叉，改一份的
// 人以为改了全部（`VT_TTL` 分裂就是这么发生的）。判据只有一条：声明之外有没有人用它。
//
// 口径（与 `tools/check-wire.mjs` 的「有定义必有生产调用点」互补）：
//   - 引用 = 任意 `src/*.ts` 里有这个名字，排除「声明行本身」与 `import` 行；
//   - `src/test-surface.ts` 的引用**单独统计**：只被测试窗口引用的导出不算死代码（它是测试钩子），
//     但会以 INFO 列出，方便发现「只为了测试而存在的生产代码」；
//   - 只有「全仓零引用」才报红。
import fs from "node:fs";
import path from "node:path";

const root = "src";
const walk = (d, a = []) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p, a);
    else if (p.endsWith(".ts")) a.push(p);
  }
  return a;
};
const files = walk(root).map((p) => [p, fs.readFileSync(p, "utf8").split(/\r?\n/)]);

// 声明：`export function f` 与 `export const c = (`（后者覆盖箭头函数；对象/单例同样计入）
const decl = [];
for (const [p, lines] of files) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^export (?:async )?function ([A-Za-z_$][\w$]*)/) || lines[i].match(/^export const ([A-Za-z_$][\w$]*) = (?:async )?\(/);
    if (m) decl.push({ name: m[1], file: p, line: i + 1 });
  }
}

const dead = [];
const testOnly = [];
for (const d of decl) {
  const re = new RegExp(`\\b${d.name}\\b`);
  let prod = 0;
  let surf = 0;
  for (const [p, lines] of files) {
    for (let i = 0; i < lines.length; i++) {
      if (p === d.file && i + 1 === d.line) continue;
      const l = lines[i];
      if (!re.test(l)) continue;
      // import 行只是搬运，不算使用
      if (/^\s*import\b/.test(l)) continue;
      // 注释里的名字不算使用（文档提到名字不等于调用）
      if (/^\s*(\*|\/\/)/.test(l)) continue;
      if (p === path.join(root, "test-surface.ts")) surf += 1;
      else prod += 1;
    }
  }
  if (prod === 0 && surf === 0) dead.push(d);
  else if (prod === 0) testOnly.push(d);
}

console.log(`死导出扫描：${decl.length} 个导出函数/常量，生产零引用 ${dead.length} 个，仅测试窗口引用 ${testOnly.length} 个`);
for (const t of testOnly) console.log(`  仅测试窗口引用：${t.name}  (${t.file}:${t.line})`);
if (dead.length) {
  for (const d of dead) console.log(`  零引用：${d.name}  (${d.file}:${d.line})`);
  console.log(`死导出 ${dead.length} 个：删掉它，或者给它一个真实调用点（不能只有单测在用）`);
  process.exitCode = 1;
} else {
  console.log("死导出闸门通过：每个导出都有真实引用");
}
