// 微型源码变异证明状态门禁会拒绝回潮；不修改工作区源码。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = fs.mkdtempSync(path.resolve('.tmp-sim/state-owner-'));
fs.cpSync('src', path.join(root, 'src'), { recursive: true });
let pass = 0, fail = 0;
const run = () => spawnSync(process.execPath, ['tools/check-state-owner.mjs', '--root', root], { encoding: 'utf8' });
function check(label, condition, output = '') {
  if (condition) pass++;
  else { fail++; console.log('FAIL ' + label + '\n' + output); }
}
const initial = run();
check('真实源码通过', initial.status === 0, initial.stdout + initial.stderr);
const state = path.join(root, 'src/core/state.ts');
const pristine = fs.readFileSync(state, 'utf8');
for (const [label, body] of [
  ['拒绝 AppState 回潮', pristine + '\nexport class AppState {}\n'],
  ['拒绝 S 兼容门面', pristine + '\nexport const S = {};\n'],
  ['拒绝入口元数据收容业务字段', pristine.replace('site = "";', 'site = "";\n  business = new Map();')],
  ['拒绝集中转发 getter', pristine.replace('site = "";', 'site = "";\n  get business() { return {}; }')],
]) {
  fs.writeFileSync(state, body);
  check(label, run().status === 1);
}
fs.writeFileSync(state, pristine);
const client = path.join(root, 'src/core/client-memory.ts');
const clientSource = fs.readFileSync(client, 'utf8');
fs.writeFileSync(client, clientSource.replace('rows = new Map<string, Record<string, RttEntry>>();', 'lostRows = new Map<string, Record<string, RttEntry>>();'));
check('另一个类同名 rows 不能掩盖 EntryMemory 成员丢失', run().status === 1);
fs.writeFileSync(client, clientSource);
fs.writeFileSync(state, pristine + '\n// export class AppState {}; const S = {};\n');
check('历史注释不误报', run().status === 0);
console.log(`状态归属反例：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
