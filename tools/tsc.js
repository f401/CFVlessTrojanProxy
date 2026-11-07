// 用本地安装的 typescript 跑类型检查 + 编译（沙箱没有 npx）
const path = require("path");
const ts = require(path.join(__dirname, "..", "node_modules", "typescript"));

const cfgPath = path.join(__dirname, "..", "tsconfig.json");
const cfg = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); },
});
if (!cfg) process.exit(2);

const program = ts.createProgram(cfg.fileNames, cfg.options);
const emit = program.emit();
const diags = ts.getPreEmitDiagnostics(program).concat(emit.diagnostics);

const errors = diags.filter((d) => d.category === ts.DiagnosticCategory.Error);
for (const d of diags) {
  const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (d.file) {
    const pos = d.file.getLineAndCharacterOfPosition(d.start || 0);
    console.log(`${path.relative(process.cwd(), d.file.fileName)}:${pos.line + 1}:${pos.character + 1}  ${msg}`);
  } else {
    console.log(msg);
  }
}
console.log(`--- ${errors.length} error(s), ${diags.length - errors.length} warning/other`);
process.exit(errors.length ? 1 : 0);
