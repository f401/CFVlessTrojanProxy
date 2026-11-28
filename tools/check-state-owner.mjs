// 状态归属门禁（棘轮）：已经迁出全局 `S`（src/core/state.ts）的字段不许回潮。
//
// 为什么需要：`S` 是「每个 isolate 独立持有的状态表」，但有些字段其实只有一个消费者 ——
// 放在 `S` 里只会让所有权不清（谁在写、谁能读、什么时候裁）。7.365 把判定层的软记忆
// （`bigByHost`/`bigChan`/`smCnt`）迁进了 `Judge.memory`。这个门禁用「迁移清单」记下
// 已经搬走的字段：一旦有人把它们写回 `S`，立刻报错，避免所有权悄悄倒退。
//
// 口径：清单里的字段在 `state.ts` 里出现（声明或赋值）即红；在别的文件里由各自的类持有，
// 不受限制。清单只增不减 —— 新迁一个字段就往 MIGRATED 里加一行，并在提交信息里说明。
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/** 已从 `S` 迁出的字段：{ 字段名: 现在归谁持有 } */
const MIGRATED = new Map([
  // 7.365 判定层软记忆
  ["bigByHost", "JudgeMemory（src/facts/judge.ts）"],
  ["bigChan", "JudgeMemory（src/facts/judge.ts）"],
  ["smCnt", "JudgeMemory（src/facts/judge.ts）"],
  // 7.369 AppState 上帝对象下放：以下字段全部从 S 迁进各自模块的实例持有者
  ["cntKeys", "Counter（src/core/counter.ts）"],
  ["cnt", "Counter（src/core/counter.ts）"],
  ["cntDay", "Counter（src/core/counter.ts）"],
  ["cntSent", "Counter（src/core/counter.ts）"],
  ["cronAt", "CronLock（src/core/lock.ts）"],
  ["gcnt", "SeedStore（src/px/seed.ts）"],
  ["seedAt", "SeedStore（src/px/seed.ts）"],
  ["seedReadFail", "SeedStore（src/px/seed.ts）"],
  ["pendAt", "PendingLedger（src/store/pend.ts）"],
  ["pendBusy", "PendingLedger（src/store/pend.ts）"],
  ["tflush", "PendingLedger（src/store/pend.ts）"],
  ["pendIdx", "PendingLedger（src/store/pend.ts）"],
  ["snapCache", "SnapshotState（src/store/snapshot.ts）"],
  ["snapWritten", "SnapshotState（src/store/snapshot.ts）"],
  ["snapBusy", "SnapshotState（src/store/snapshot.ts）"],
  ["snapChecked", "SnapshotState（src/store/snapshot.ts）"],
  ["lastManual", "ProxyipView（src/routes/proxyip.ts）"],
  ["bigTyp", "ShadowTable（src/facts/factshadow.ts）"],
  ["poolAt", "PoolReadyClock（src/px/pickpath.ts）"],
  ["aliveAt", "WarmPacer（src/px/warm.ts）"],
  ["vtPend", "VtSyncLedger（src/facts/verdict.ts）"],
  ["vtSent", "VtSyncLedger（src/facts/verdict.ts）"],
  ["vtCool", "VtSyncLedger（src/facts/verdict.ts）"],
  ["vtFlight", "VtSyncLedger（src/facts/verdict.ts）"],
  ["dnsCache", "DnsCache（src/proxy/dial.ts）"],
  ["v4AllCache", "DnsCache（src/proxy/dial.ts）"],
  ["aaaaCache", "DnsCache（src/proxy/dial.ts）"],
  ["cfHttpFlight", "CfHttpState（src/proxy/cfverdict.ts）"],
  ["nodeSnapCache", "NodeSnapCache（src/store/stats.ts）"],
  ["probeBad", "ProbeCooldown（src/px/alive.ts）"],
  ["reProbe", "RetestQueue（src/px/scan.ts）"],
  ["reProbeN", "RetestQueue（src/px/scan.ts）"],
  ["usersCache", "UserCache（src/proxy/protocol.ts）"],
  ["usersSig", "UserCache（src/proxy/protocol.ts）"],
  // 7.382 状态归属：cfHost 缓存全仓只有 Dialer 读写，从 S 收进 Dialer 实例
  ["cfHost", "Dialer（src/proxy/dialer.ts）"],
]);

const rootArg = process.argv.indexOf("--root");
const root = path.resolve(rootArg < 0 ? "." : process.argv[rootArg + 1]);
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const stateSrc = read("src/core/state.ts");
const owners = JSON.parse(fs.readFileSync(new URL("./state-owners.json", import.meta.url), "utf8"));
for (const row of owners) MIGRATED.set(row.legacyField, row.owner + (row.member ? "." + row.member : ""));
const violations = [];
for (const [field, owner] of MIGRATED) {
  // 按字段声明/赋值形态匹配，避免注释里提到名字就误报
  // 覆盖合法 TS 类字段的各种写法：private/public/protected + readonly + !/? 后缀
  const re = new RegExp(`^\\s*(?:(?:private|public|protected)\\s+)?(?:readonly\\s+)?${field}\\s*[!?]?\\s*[:=]`, "m");
  if (re.test(stateSrc)) violations.push(`${field} → 应由 ${owner} 持有，却又出现在 S 里`);
}

// 用语法树检查实际代码，注释和字符串提到历史名字不算回潮。
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(file) : file.endsWith(".ts") ? [file] : [];
});
const trees = new Map();
for (const file of walk(path.join(root, "src"))) {
  const tree = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  trees.set(path.relative(root, file).replaceAll("\\", "/"), tree);
  const visit = (node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === "AppState") violations.push(file + ": AppState 聚合根回潮");
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "S") violations.push(file + ": S 聚合状态回潮");
    if (ts.isImportSpecifier(node) && (node.propertyName || node.name).text === "S") violations.push(file + ": 禁止 S 兼容门面");
    ts.forEachChild(node, visit);
  };
  visit(tree);
}
for (const row of owners) {
  const tree = trees.get(row.module);
  if (!tree) { violations.push(row.module + ": 所有者文件缺失"); continue; }
  const binding = tree.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]).find((decl) => decl.name.getText(tree) === row.owner);
  const className = binding && ts.isNewExpression(binding.initializer) ? binding.initializer.expression.getText(tree) : "";
  const ownerClass = tree.statements.filter(ts.isClassDeclaration).find((decl) => decl.name?.text === className);
  if (!ownerClass) violations.push(row.owner + ": 必须直接构造登记的所有者类");
  if (row.member && !ownerClass?.members.some((member) => ts.isPropertyDeclaration(member) && member.name?.getText(tree) === row.member)) {
    violations.push(row.owner + "." + row.member + ": 状态成员缺失");
  }
}
if (/\b(?:get|set)\s+[A-Za-z_]\w*\s*\(/.test(stateSrc)) violations.push("state.ts 禁止集中转发业务状态");
const context = trees.get("src/core/state.ts")?.statements.find(ts.isClassDeclaration);
for (const member of context?.members || []) {
  if (ts.isPropertyDeclaration(member) && !["site", "colo"].includes(member.name.getText())) violations.push("IsolateContext 只能持有入口元数据");
}

if (violations.length) {
  console.log(`状态归属门禁：${violations.length} 个已迁出字段回潮到 S`);
  for (const v of violations) console.log(`  ${v}`);
  process.exit(1);
}
console.log(`状态归属门禁通过：${MIGRATED.size} 个已迁出字段都没有回潮到 S`);
