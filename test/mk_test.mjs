import fs from "fs";
let src = fs.readFileSync("../dist/_worker.js", "utf8");
src = src.replace(/import\s*\{\s*connect\s*\}\s*from\s*"cloudflare:sockets";/,
  "const connect = () => { throw new Error('connect() unavailable in test'); };");
fs.writeFileSync(new URL("./_bundle.mjs", import.meta.url), src);
console.log("wrote test/_bundle.mjs", src.length);
