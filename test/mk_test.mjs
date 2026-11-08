import fs from "fs";

// 路径必须相对本文件：早先写的是 "../dist/_worker.js"（相对 cwd），
// 在仓库根目录跑 npm test 时会读到上一级目录里的旧包 —— 测试全绿但测的是旧代码。
const srcUrl = new URL("../dist/_test.js", import.meta.url);
const outUrl = new URL("./_bundle.mjs", import.meta.url);

let src = fs.readFileSync(srcUrl, "utf8");
// esbuild 会把 external 的 connect 按模块各留一条 import；Node 里换成抛错的桩
src = src.replace(/^import \{ connect(?: as (\w+))? \} from "cloudflare:sockets";$/gm,
  (_, alias) => `const ${alias || "connect"} = () => { throw new Error("connect() unavailable in test"); };`);
if (src.includes("cloudflare:sockets")) throw new Error("还有未替换的 cloudflare:sockets 引用");
fs.writeFileSync(outUrl, src);
console.log("wrote test/_bundle.mjs", src.length);
