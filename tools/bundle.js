// 用 esbuild 打两个包：
//   dist/_worker.js  生产包（只导出 default + Meter）
//   dist/_test.js    测试包（额外导出内部符号，供 Node 单测直接调用）
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");
const { viewAssetsPlugin } = require("./view-assets.cjs");

const ROOT = path.resolve(__dirname, "..");
const common = {
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  external: ["cloudflare:sockets"],
  keepNames: true,
  legalComments: "none",
  charset: "utf8",
  loader: { ".html": "text" },
  plugins: [viewAssetsPlugin],
  absWorkingDir: ROOT,
  logLevel: "warning",
};

(async () => {
  const prod = await esbuild.build({
    ...common,
    entryPoints: ["src/index.ts"],
    outfile: "dist/_worker.js",
    metafile: true,
  });
  const test = await esbuild.build({
    ...common,
    entryPoints: ["src/test-entry.ts"],
    outfile: "dist/_test.js",
    metafile: true,
  });
  for (const name of ["_worker.js", "_test.js"]) {
    const st = fs.statSync(path.join(ROOT, "dist", name));
    console.log(`dist/${name}  ${(st.size / 1024).toFixed(1)} KB`);
  }
  const src = fs.readFileSync(path.join(ROOT, "dist/_worker.js"), "utf8");
  if (!/(class Meter\b|var Meter = class\b)/.test(src)) { console.error("!! 打包后找不到 Meter 类"); process.exit(1); }
  if (!/export\s*\{[^}]*\bMeter\b[^}]*\}/.test(src) && !/export class Meter/.test(src)) {
    console.error("!! 打包后 Meter 未被导出"); process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
