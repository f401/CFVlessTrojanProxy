// 用独立微型项目验证门禁真的拒绝 core 反向依赖；不修改实际项目源码。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const index = process.argv.indexOf('--script');
const script = path.resolve(index < 0 ? 'tools/check-arch.js' : process.argv[index + 1]);
const fixture = fs.mkdtempSync(path.resolve('.tmp-sim/arch-gate-'));
for (const dir of ['tools', 'types', 'src/core', 'src/store']) fs.mkdirSync(path.join(fixture, dir), { recursive: true });
fs.copyFileSync(script, path.join(fixture, 'tools/check-arch.js'));
fs.writeFileSync(path.join(fixture, 'AGENTS.md'), 'Fixture only\n');
fs.writeFileSync(path.join(fixture, 'src/core/base.ts'), 'export const base = 1;\n');
fs.writeFileSync(path.join(fixture, 'src/store/port.ts'), 'export const port = 2;\n');
let passed = 0, failed = 0;
function run(label, source, expected, message) {
  fs.writeFileSync(path.join(fixture, 'src/core/fixture.ts'), source);
  const result = spawnSync(process.execPath, ['tools/check-arch.js'], { cwd: fixture, encoding: 'utf8' });
  const ok = result.status === expected && (!message || result.stdout.includes(message));
  ok ? passed++ : failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: exit=${result.status}\n${result.stdout}${result.stderr}`);
}
run('core can import its own layer', 'import { base } from "./base";\nexport const copy = base;\n', 0);
run('core cannot import store', 'import { port } from "../store/port";\nexport const copy = port;\n', 1, '反向依赖 core -> store');
fs.writeFileSync(path.join(fixture, 'src/index.ts'), 'import { port } from "./store/port";\nexport const entry = port;\n');
run('unknown entry layer remains allowed', 'export const copy = 1;\n', 0);
console.log(`Architecture gate: passed=${passed} failed=${failed}`);
process.exitCode = failed ? 1 : 0;
