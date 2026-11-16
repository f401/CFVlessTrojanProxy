/**
 * 功能：缩进门禁 —— 抓「语句被顶出所在块」的欠缩进行（7.168 同族：脚本按行替换时把缩进丢掉）。
 * 判据：某行的缩进 < 它所在块左花括号的缩进 + 2，且这一行是语句（不是续行、不是结构符号、不在模板字符串里）。
 * 为什么值得一条门禁：这类改动不会让 tsc / 单测 / 任何既有检查变红，只有人读代码时才会发现，
 * 而一旦真出问题（块边界读错），排查成本远高于把它挡住。
 * @returns 无（命中即以退出码 1 结束，并逐条打印 文件:行）
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 已知「整块少一级缩进」的文件：留待单独一轮整体重排，重排完必须从这张表里删掉。
 * 7.237 已把 `src/nodes/stat.ts`（130 行）与 `src/nodes/score.ts`（87 行）补齐 ⇒ 现在这张表是空的，
 * 门禁覆盖全仓；以后若再出现整块偏移，先登记、再排一轮补，补完删掉。
 */
const BLOCK_SHIFTED = [];

/** 上一行以这些字符结尾时，本行属于续行（多行表达式/参数表），不做缩进判断 */
const CONT_TAIL = /(?:[,=([]|[.?:+\-*/%<>&|^!~]|&&|\|\|)$/;

/** 以这些开头的行是结构符号行，不是语句 */
const SKIP_HEAD = /^\s*(?:[.)\]}?:+*/%|&<>=,!]|\?\.)/;

/** 递归收集 src 下所有 .ts 文件 */
function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name).replace(/\\/g, "/");
    if (ent.isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

/**
 * 检查单个文件的欠缩进行。
 * @param file 文件路径
 * @returns 命中的 [{ line, indent, need, text }]
 */
export function scanFile(file) {
  const s = fs.readFileSync(file, "utf8");
  const lines = s.split(/\r?\n/);
  const out = [];
  const open = []; // 每层左花括号所在行的缩进
  let inTpl = false;
  let prev = "";
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    // 反引号奇偶翻转：模板字符串内部的内容不参与缩进判断
    if ((raw.match(/`/g) || []).length % 2 === 1) inTpl = !inTpl;
    if (inTpl || !line) continue;
    const indent = raw.length - raw.trimStart().length;
    const isStmt =
      !SKIP_HEAD.test(line) && !/^\/[/*]/.test(line) && !CONT_TAIL.test(prev) && !/^[}\]);]/.test(line);
    if (isStmt && open.length >= 2) {
      const need = open[open.length - 1] + 2;
      if (indent < need) out.push({ line: i + 1, indent, need, text: line.slice(0, 64) });
    }
    for (const ch of raw) {
      if (ch === "{") open.push(indent);
      else if (ch === "}") open.pop();
    }
    prev = line;
  }
  return out;
}

let bad = 0;
const files = walk("src");
for (const file of files) {
  if (BLOCK_SHIFTED.includes(file)) continue;
  const hits = scanFile(file);
  for (const h of hits) {
    bad++;
    console.log(`${file}:${h.line} 缩进 ${h.indent}，所在块要求 ≥ ${h.need}  ${h.text}`);
  }
}
if (bad) {
  console.log(`\n缩进门禁：${bad} 行被顶出所在块（脚本按行替换时丢了缩进）`);
  process.exitCode = 1;
} else {
  // 白名单为空时不要打印「跳过 …」，否则看起来像还有文件没归位
  const skip = BLOCK_SHIFTED.length ? `（跳过整块偏移 ${BLOCK_SHIFTED.join(" / ")}）` : "";
  console.log(`缩进门禁通过：${files.length} 个文件${skip}`);
}
