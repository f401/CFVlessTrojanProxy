// 死导出闸门：`src` 里声明的每个「导出函数 / 导出常量」必须在全仓有真实引用；
// 另外检查 `SC`（`src/core/const.ts`）里的每个常量也必须有人读 —— 常量不是注释，没人读的值
// 只会误导后来者（`SEED_TTL`「seed 先验保质期」在 v7 已经不存在这个概念，`EXPLORE_MAX`
// 承诺的「探索上限」也没有任何代码在施加，两者的注释都在描述一个不存在的机制）。
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
//   - `SC` 常量额外允许被 `test/test_score.mjs` 读（测试有时直接断言阈值），但同样会列出来；
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
// 测试按领域拆分后仍检查所有手写套件；生成包不能冒充真实测试引用。
const testFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? testFiles(file) : entry.name.endsWith(".mjs") && entry.name !== "_bundle.mjs" ? [file] : [];
});
const testFile = testFiles("test").map((file) => fs.readFileSync(file, "utf8")).join("\n");

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

// 第二段：`SC` 常量零读。判据同上一段，但读取点写成 `SC.NAME`（含解构以外的所有引用）。
const constPath = path.join(root, "core", "const.ts");
const constSrc = fs.readFileSync(constPath, "utf8");
const body = constSrc.slice(constSrc.indexOf("export const SC"), constSrc.lastIndexOf("};"));
const keys = [...body.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
const deadKeys = [];
for (const k of keys) {
  const re = new RegExp(`\\bSC\\.${k}\\b`);
  let prod = 0;
  for (const [p, lines] of files) {
    if (p === constPath) continue;
    for (const l of lines) {
      if (!re.test(l)) continue;
      if (/^\s*(\*|\/\/)/.test(l)) continue;
      prod += 1;
    }
  }
  const inTest = re.test(testFile);
  if (prod === 0 && !inTest) deadKeys.push(k);
  else if (prod === 0) console.log(`  SC 常量仅测试引用：SC.${k}`);
}
console.log(`SC 常量扫描：${keys.length} 个，生产零读 ${deadKeys.length} 个`);
if (deadKeys.length) {
  for (const k of deadKeys) console.log(`  零读：SC.${k}`);
  console.log(`SC 常量 ${deadKeys.length} 个没人读：删掉它，或者给它一个真实读取点（注释描述的能力必须真的存在）`);
  process.exitCode = 1;
}

if (dead.length) {
  for (const d of dead) console.log(`  零引用：${d.name}  (${d.file}:${d.line})`);
  console.log(`死导出 ${dead.length} 个：删掉它，或者给它一个真实调用点（不能只有单测在用）`);
  process.exitCode = 1;
}
if (!dead.length && !deadKeys.length) {
  console.log("死导出闸门通过：每个导出与每个 SC 常量都有真实读取点");
}
