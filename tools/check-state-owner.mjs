// 状态归属门禁（棘轮）：已经迁出全局 `S`（src/core/state.ts）的字段不许回潮。
//
// 为什么需要：`S` 是「跨 isolate 共享的全局状态表」，但有些字段其实只有一个消费者 ——
// 放在 `S` 里只会让所有权不清（谁在写、谁能读、什么时候裁）。7.365 把判定层的软记忆
// （`bigByHost`/`bigChan`/`smCnt`）迁进了 `Judge.memory`。这个门禁用「迁移清单」记下
// 已经搬走的字段：一旦有人把它们写回 `S`，立刻报错，避免所有权悄悄倒退。
//
// 口径：清单里的字段在 `state.ts` 里出现（声明或赋值）即红；在别的文件里由各自的类持有，
// 不受限制。清单只增不减 —— 新迁一个字段就往 MIGRATED 里加一行，并在提交信息里说明。
import fs from "node:fs";

/** 已从 `S` 迁出的字段：{ 字段名: 现在归谁持有 } */
const MIGRATED = new Map([
  ["bigByHost", "JudgeMemory（src/route/judge.ts）"],
  ["bigChan", "JudgeMemory（src/route/judge.ts）"],
  ["smCnt", "JudgeMemory（src/route/judge.ts）"],
]);

const stateSrc = fs.readFileSync("src/core/state.ts", "utf8");
const violations = [];
for (const [field, owner] of MIGRATED) {
  // 按字段声明/赋值形态匹配，避免注释里提到名字就误报
  const re = new RegExp(`^\\s+(?:readonly\\s+)?${field}\\s*[:=]`, "m");
  if (re.test(stateSrc)) violations.push(`${field} → 应由 ${owner} 持有，却又出现在 S 里`);
}

if (violations.length) {
  console.log(`状态归属门禁：${violations.length} 个已迁出字段回潮到 S`);
  for (const v of violations) console.log(`  ${v}`);
  process.exit(1);
}
console.log(`状态归属门禁通过：${MIGRATED.size} 个已迁出字段都没有回潮到 S`);
