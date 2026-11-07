import fs from "fs";

// 路径必须相对本文件：早先写的是 "../dist/_worker.js"（相对 cwd），
// 在仓库根目录跑 npm test 时会读到上一级目录里的旧包 —— 测试全绿但测的是旧代码。
const srcUrl = new URL("../dist/_worker.js", import.meta.url);
const outUrl = new URL("./_bundle.mjs", import.meta.url);

let src = fs.readFileSync(srcUrl, "utf8");
src = src.replace(/import\s*\{\s*connect\s*\}\s*from\s*"cloudflare:sockets";/,
  "const connect = () => { throw new Error('connect() unavailable in test'); };");
fs.writeFileSync(outUrl, src);
console.log("wrote test/_bundle.mjs", src.length);
