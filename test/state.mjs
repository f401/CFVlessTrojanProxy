// 领域状态隔离与并发提交回归；--bundle 可在原版和修改版上运行同一输入。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const at = process.argv.indexOf('--bundle');
const W = await import(pathToFileURL(path.resolve(at < 0 ? 'test/_bundle.mjs' : process.argv[at + 1])).href);
let pass = 0, fail = 0;
function check(label, condition, observed = '') {
  if (condition) pass++;
  else { fail++; console.log('FAIL ' + label + ' ' + observed); }
}
check('生产测试窗口没有 S 聚合根', W.S === undefined);
const pending = new W.PEND.constructor(), pendingOther = new W.PEND.constructor();
const globalSize = (W.PEND.rows || W.S?.pend).size;
pending.add('independent', 5, 7, true);
check('新账本不写默认单例', (W.PEND.rows || W.S?.pend).size === globalSize);
check('两个账本独立拥有待发字节', pending.bytes === 12 && pendingOther.bytes === 0 && pending.rows?.get('independent')?.conns === 1);
const hostA = new W.HostProfile(), hostB = new W.HostProfile();
hostA.markDirect('independent.example', true);
check('站点画像实例不串写', hostA.direct?.size === 1 && hostB.direct?.size === 0);
if (W.NodeMemory) {
  const first = new W.NodeMemory(), second = new W.NodeMemory();
  first.acquire('node'); first.acquire('node'); first.release('node');
  check('节点引用计数独立', first.inflight.get('node') === 1 && second.inflight.size === 0);
  first.release('node'); first.release('node');
  check('引用归零后删除键', first.inflight.size === 0);
  first.invalidateRanks();
  check('排名代数独立', first.generation === 1 && second.generation === 0);
} else check('节点状态拥有可独立构造的所有者', false);
const seedA = new W.SeedStore(), seedB = new W.SeedStore();
if (seedA.document) seedA.document.byColo.X = { nodes: [], ts: 1 };
check('种子文档不跨实例共用', !!seedA.document?.byColo.X && !seedB.document?.byColo.X);
for (const [method, hit, capacity, value] of [
  ['v4Set', 'v4Hit', 500, '192.0.2.1'],
  ['aaaaSet', 'aaaaHit', 500, '2001:db8::1'],
  ['v4AllSet', 'v4AllHit', 300, ['192.0.2.1']],
]) {
  const cache = new W.DnsCache();
  for (let i = 0; i < capacity; i++) cache[method]('old-' + i, value, 1000 + i);
  cache[method]('recent', value, 10000);
  cache[method]('newest', value, 10001);
  check(method + ' 溢出保留近期热行', JSON.stringify(cache[hit]('recent', 10002)) === JSON.stringify(value));
  check(method + ' 溢出保留大部分有效行', (cache.aaaa.size + cache.v4All.size + cache.aRecord.size) > capacity / 2);
}
// 容量满时必须保留所有未完成任务的去重身份，桩不进行网络请求。
W.CF_HTTP.flight.clear();
for (let i = 0; i < 201; i++) W.CF_HTTP.flight.add('flight-' + i);
const jobs = [];
let requests = 0;
W.refreshCfHttp('new-flight.example', { waitUntil: task => jobs.push(task) }, {
  fetch: async () => { requests++; return new Response('', { status: 200 }); },
});
check('满载不清空在途守卫', W.CF_HTTP.flight.has('flight-0'));
check('满载跳过新探测', requests === 0);
await Promise.all(jobs);
W.CF_HTTP.flight.clear();

// 固定输入：KV 写在途中，新样本写入同一行、同一时间戳以及新用户。
const usage = W.USAGE_MEMORY?.rows || W.S.stats;
const rtt = W.ENTRY_MEMORY?.rows || W.S.rtt;
const errors = () => W.ERROR_MEMORY?.rows || W.S.errs;
const dirty = value => { if (W.USAGE_MEMORY) W.USAGE_MEMORY.dirtyBytes = value; else W.S.snapBytes = value; };
usage.clear(); rtt.clear(); errors().length = 0;
usage.set('same', { up: 10, down: 20, conns: 1, first: 1, last: 2 });
rtt.set('same', { tag: { rtt: 50, hits: 1, ok: 1, fail: 0, ts: 2 } });
errors().push({ t: 1, m: 'before', tag: '' });
dirty(30);
W.SNAP.busy = false; W.SNAP.checked = 0; W.SNAP.written = 0;
const store = new Map();
let signalStarted, release;
const started = new Promise(resolve => { signalStarted = resolve; });
const paused = new Promise(resolve => { release = resolve; });
const env = { STATS: {
  get: async key => store.get(key) || null,
  put: async (key, value) => { signalStarted(); await paused; store.set(key, value); },
} };
const writing = W.flushSnap(env, true);
await started;
usage.get('same').up += 5; usage.get('same').down += 7; usage.get('same').conns++;
usage.set('new', { up: 9, down: 0, conns: 1, first: 3, last: 3 });
rtt.get('same').tag.hits++; rtt.get('same').tag.ok++;
errors().push({ t: 2, m: 'during', tag: '' });
dirty(51);
release(); await writing;
const observed = {
  up: usage.get('same')?.up || 0, down: usage.get('same')?.down || 0,
  newUp: usage.get('new')?.up || 0, rttHits: rtt.get('same')?.tag.hits || 0,
  errors: errors().map(row => row.m), dirtyBytes: W.USAGE_MEMORY?.dirtyBytes ?? W.S.snapBytes,
};
check('同用户在途字节不丢', observed.up === 5 && observed.down === 7, JSON.stringify(observed));
check('新用户在途字节不丢', observed.newUp === 9);
check('同时间戳 RTT 新样本不丢', observed.rttHits === 1);
check('在途错误不丢', observed.errors.join(',') === 'during');
check('脏字节只确认本轮份额', observed.dirtyBytes === 21);
await W.flushSnap(env, true);
const persisted = await W.getSnap(env, true);
check('两轮持久化总量守恒', persisted.stats.same.up === 15 && persisted.stats.same.down === 27 && persisted.stats.new?.up === 9);
check('两轮持久化 RTT 计数守恒', persisted.rtt.same.tag.hits === 2);
check('两轮持久化错误守恒', persisted.errs.map(row => row.m).join(',') === 'before,during');
usage.set('failure', { up: 2, down: 3, conns: 1, first: 4, last: 4 });
await W.flushSnap({ STATS: { get: env.STATS.get, put: async () => { throw Error('fixture-write-failure'); } } }, true);
check('失败不确认本地增量', usage.get('failure')?.down === 3);
console.log('CONCURRENT_SNAPSHOT ' + JSON.stringify(observed));
console.log(`领域状态验收：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
