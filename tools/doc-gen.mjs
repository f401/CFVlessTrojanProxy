// 文档补齐器：只给「纯委托型薄包装」自动生成文档注释（功能 / 参数 / 返回值）。
// 其余需要人写的函数只列出，不改动。
// 用法：node tools/doc-gen.mjs [--write] [模块前缀]
import fs from "node:fs";
import path from "node:path";

const root = "src";
const write = process.argv.includes("--write");
const only = process.argv.slice(2).find((a) => !a.startsWith("--") && !/^\d+$/.test(a));

/** 递归收集 .ts（跳过 .d.ts 与 vendor） */
function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** 上方（跳过空行）是否有 /** 块 */
function hasDoc(lines, i) {
  let j = i - 1;
  while (j >= 0 && lines[j].trim() === "") j--;
  if (j < 0 || !lines[j].trim().endsWith("*/")) return false;
  let k = j;
  while (k >= 0 && !lines[k].trim().startsWith("/*")) k--;
  return k >= 0 && lines[k].trim().startsWith("/**");
}

/** 解析参数列表 "a: T, b = 1" → [{n,a},{n,b}]（忽略默认值） */
function params(txt) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of txt) {
    if ("({[<".includes(ch)) depth++;
    if (")}]>".includes(ch)) depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => {
    const t = x.split("=")[0].trim();
    const i = t.indexOf(":");
    return i < 0 ? { n: t, t: "" } : { n: t.slice(0, i).trim(), t: t.slice(i + 1).trim() };
  }).filter((p) => p.n);
}

const SIG = /^(\s*)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*(?::\s*([^{]+))?\{/;
// 类方法：两空格缩进、带返回类型、以 { 结尾（排除构造函数）
const METH = /^(\s{2})(?:(?:private|public|protected|static|async)\s+)*(?!constructor\b)([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*(?::\s*([^{]+))?\{\s*$/;

let made = 0;
const manual = [];

for (const file of walk(root)) {
  if (only && !file.includes(only)) continue;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(SIG) || line.match(METH);
    const KW = new Set(["if", "for", "while", "switch", "catch", "return", "do", "try", "else", "function"]);
    if (m && !KW.has(m[2]) && !hasDoc(lines, i)) {
      // 交给下面的委托判定
    } else { out.push(line); continue; }
    // 找函数体结束（花括号配平）
    let depth = 0, end = -1;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth === 0 && j > i) { end = j; break; }
      if (depth === 0 && j === i) { end = i; break; }
    }
    const body = lines.slice(i + 1, end).filter((x) => x.trim() && !x.trim().startsWith("//"));
    const one = body.length === 1 ? body[0].trim() : "";
    const call = one.match(/^(?:return\s+|await\s+)?([A-Za-z0-9_$.]+)\s*\(/);
    const isDelegate = !!call && (one.startsWith("return ") || one.endsWith(");"));
    if (!isDelegate) { manual.push(`${file}:${i + 1} ${m[2]}`); out.push(line); continue; }
    const target = call[1].replace(/^return /, "");
    const ps = params(m[3]);
    const rt = (m[4] || "").trim();
    const pTxt = ps.length ? ps.map((p) => `@param ${p.n}${p.t ? " " + p.t : ""}`).join("。") + "。" : "无参数。";
    const rTxt = rt && rt !== "void" ? `@returns 转发 ${target} 的返回值（${rt}）` : `@returns 无（${target} 无返回值）`;
    out.push(`${m[1]}/** 功能：${m[2]} 是薄包装，直接委托 ${target}。${pTxt}${rTxt} */`);
    out.push(line);
    made++;
    i = i; // 继续按行推进
  }
  if (write) {
    const next = out.join("\n") + (lines.length && lines[lines.length - 1] === "" ? "\n" : "");
    if (next !== fs.readFileSync(file, "utf8")) fs.writeFileSync(file, next);
  }
}

console.log(`自动补注释 ${made} 个${write ? "（已写入）" : "（演练，加 --write 才写）"}`);
console.log(`需人工写：${manual.length} 个`);
for (const x of manual.slice(0, 40)) console.log("  " + x);
