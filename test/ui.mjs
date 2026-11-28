// 无浏览器依赖的页面契约测试；--root 可对原版/修改版/回滚版使用同一组输入。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const rootIndex = process.argv.indexOf('--root');
const root = path.resolve(rootIndex < 0 ? '.' : process.argv[rootIndex + 1]);
const W = await import(pathToFileURL(path.join(root, 'test/_bundle.mjs')).href);
let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) passed++;
  else { failed++; console.log('FAIL ' + label); }
}
// 文档 IP 不触发外部国家码查询；45 个节点稳定覆盖两页和两种国家。
const userId = 'fixture-user';
const keys = Array.from({ length: 45 }, (_, i) => `203.0.113.${i + 1}:443`);
// 字典序分页中 .9 位于第二页，不能把 .45 误当作末页节点。
const offPageKey = keys[8];
W.NODE_MEMORY.alive.clear();
W.POOL_MEMORY.rows = keys.map(key => ({ h: key.split(':')[0], p: 443 }));
W.SEED_STORE.document = { v: 7, ts: 1, poolGen: 1, poolN: 45, builtAt: 1, byColo: {
  US: { nodes: keys.slice(0, 40).map(k => ({ k, h: k.split(':')[0], p: 443, cc: 'US' })) },
  JP: { nodes: keys.slice(40).map(k => ({ k, h: k.split(':')[0], p: 443, cc: 'JP' })) },
} };
W.REGION_CACHE.rows = null;
W.REGION_CACHE.json = null;
const me = { id: userId, pwd: 'fixture-only', enabled: true, managed: true,
  regions: ['US', 'JP', 'ZZ'], regionTopN: 3, targetHost: '', pinnedNodes: [keys[0], offPageKey] };
const auth = { ok: true, list: [me], uuids: new Set([userId]), pwds: new Set() };
function context(query = '') {
  const url = new URL(`https://edge.example.com/${userId}/regions${query}`);
  return { request: new Request(url), env: {}, id: userId, pageKey: 'MiXeD & key', url, auth };
}
const response = await W.regions(context('?page=1&k=MiXeD%20%26%20key'));
const html = await response.text();
check('HTML response 200', response.status === 200);
check('40 rows on first page', (html.match(/<tr data-node=/g) || []).length === 40);
check('page count unchanged', html.includes('第 1/2 页'));
check('cross-page pinned node preserved', html.includes(`type="hidden" name="pinnedNodes" value="${offPageKey}"`));
check('off-page country preserved', html.includes('type="hidden" name="regions" value="ZZ"'));
check('preserved values deduplicated', (html.match(new RegExp(`name="pinnedNodes" value="${keys[0].replaceAll('.', '\\.') }"`, 'g')) || []).length === 1);
const action = html.match(/<form method="post" action="([^"]+)" id="saveForm"/)[1].replaceAll('&amp;', '&');
check('POST retains case-sensitive pageKey', new URL(action, context().url).searchParams.get('k') === 'MiXeD & key');
const next = html.match(/<a href="([^"]+)" data-show="1"[^>]*>下一页/)[1].replaceAll('&amp;', '&');
check('pagination retains pageKey', new URL(next, context().url).searchParams.get('k') === 'MiXeD & key');
check('no unresolved include directives', !html.includes('<!-- @include'));
check('no unresolved template variables', !/\{\{\w+\}\}/.test(html));
check('search has accessible label', html.includes('for="q"'));
check('result announces status', html.includes('aria-live="polite"'));
check('shared visual tokens delivered', html.includes('--surface:'));
check('dirty state delivered', html.includes('id="saveState"'));
check('no sticky table header', !/th\s*\{[^}]*position\s*:\s*sticky/.test(html));
for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  try { new vm.Script(script[1]); check('browser script syntax', true); }
  catch { check('browser script syntax', false); }
}
const second = await (await W.regions(context('?page=2'))).text();
check('5 rows on second page', (second.match(/<tr data-node=/g) || []).length === 5);
check('first-page selection preserved on second page', second.includes(`type="hidden" name="pinnedNodes" value="${keys[0]}"`));
const json = await (await W.regions(context('?format=json'))).json();
check('JSON contract keys unchanged', Object.keys(json).sort().join(',') === 'coverage,nodes,s5,sample,target');
check('JSON includes all 45 fixture nodes', json.nodes.length === 45);
check('read-only GET did not change user selection', me.pinnedNodes.join(',') === [keys[0],offPageKey].join(','));
W.ISOLATE.colo = 'FIXTURE';
W.CONN_OBS.note('FIXTURE', keys[0], 'fixture.test', 200, 123, W.IpFamily.IPv4, Date.now());
const siteData = await (await W.regions(context('?format=json&site=fixture.test'))).json();
check('site projection includes measured RTT', siteData.nodes.find(row => row.key === keys[0]).rtt === 123);
check('site projection leaves shared base row unchanged', W.REGION_CACHE.rows.rows.find(row => row.key === keys[0]).rtt === null);
// 将第一页完整表单模拟提交；后端应保存两页的选择，而不只是当前页。
let stored;
const form = new FormData();
const saveFormHtml = html.match(/<form method="post"[^>]*id="saveForm">([\s\S]*?)<\/form>/)[1];
for (const match of saveFormHtml.matchAll(/<input\b([^>]+)>/g)) {
  const attrs = match[1], name = attrs.match(/name="([^"]+)"/), value = attrs.match(/value="([^"]*)"/);
  if (!name || !value) continue;
  if (/type="checkbox"/.test(attrs) && !/\bchecked\b/.test(attrs)) continue;
  form.append(name[1], value[1].replaceAll('&amp;', '&'));
}
const postCtx = context();
postCtx.env = { STATS: { put: async (_key, value) => { stored = JSON.parse(value); } } };
postCtx.request = new Request(postCtx.url, { method: 'POST', body: form });
const post = await W.regions(postCtx);
check('POST still redirects with 303', post.status === 303);
check('POST redirect retains pageKey', new URL(post.headers.get('location'), postCtx.url).searchParams.get('k') === 'MiXeD & key');
const saved = Array.isArray(stored) ? stored.find(user => user.id === userId) : stored?.users?.find(user => user.id === userId);
check('POST retains both pinned nodes', saved?.pinnedNodes?.length === 2);
check('POST retains off-page country', saved?.regions?.includes('ZZ'));
// 静态展开器拒绝穿越与未知资源，不依赖某一个模板路径布局。
const helper = path.join(root, 'tools/view-assets.cjs');
if (fs.existsSync(helper)) {
  const { expandHtml } = require(helper);
  check('expanded source equals built template contract', expandHtml(path.join(root, 'src/views/html/regions.html')).includes('id="saveState"'));
} else check('build-time asset expansion available', false);
const client = path.join(root, 'src/views/client/regions.js');
const js = fs.existsSync(client) ? fs.readFileSync(client, 'utf8') : html;
check('probe does not reenable after arbitrary 8s', !js.includes('setTimeout(done,8000)'));
check('single row visibility writer', (js.match(/tr\.style\.display\s*=/g) || []).length === 1 && !js.includes("row.style.display='';"));
check('draft expiration bounded', js.includes('1800000'));
console.log(`UI contracts: passed=${passed} failed=${failed}`);
process.exitCode = failed ? 1 : 0;
