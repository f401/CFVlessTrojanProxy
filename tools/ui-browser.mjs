// 使用本机 Edge 的 CDP 验证真实 DOM；无需引入前端运行时或浏览器测试依赖。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
const W = await import('../test/_bundle.mjs');
const outIndex = process.argv.indexOf('--out');
const output = path.resolve(outIndex < 0 ? '.tmp-sim/ui-browser' : process.argv[outIndex + 1]);
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'edge-profile-'));
const keys = Array.from({ length: 45 }, (_, i) => `203.0.113.${i + 1}:443`);
const me = { id: 'fixture-user', pwd: 'fixture-password', enabled: true, managed: true,
  regions: ['US', 'JP'], regionTopN: 3, targetHost: '', pinnedNodes: [keys[0], keys[8]] };
W.NODE_MEMORY.alive.clear(); W.POOL_MEMORY.rows = keys.map(key => ({ h: key.split(':')[0], p: 443 }));
W.SEED_STORE.document = { v: 7, ts: 1, poolGen: 1, poolN: 45, builtAt: 1, byColo: {
  US: { nodes: keys.map(k => ({ k, h: k.split(':')[0], p: 443, cc: 'US' })) },
} };
W.REGION_CACHE.rows = null; W.REGION_CACHE.json = null;
const auth = { ok: true, list: [me], uuids: new Set([me.id]), pwds: new Set() };
const env = { STATS: { put: async (_key, value) => Object.assign(me, JSON.parse(value)[0]) } };
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${server.address().port}`);
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    if (url.pathname === '/panel') {
      response.setHeader('content-type', 'text/html;charset=utf-8');
      response.end(W.renderHtml({ uuid: me.id, pwd: me.pwd }, url, me.id, 'ProxyX 控制台', '', { regions: ['US','JP'], used: '2.4 GB', today: '180 MB', aliveCount: 45 })); return;
    }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (request.method === 'POST') {
      const form = await new Request(url, { method: 'POST', headers: request.headers, body: bytes }).formData();
      if (form.get('op') === 'requality') {
        await new Promise(resolve => setTimeout(resolve, 300));
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: true, key: form.get('key'), cc: 'US', org: 'Fixture network', reachable: true, label: '良好', badge: '<span class="b g">良好</span>', kindHtml: '住宅' })); return;
      }
    }
    const req = new Request(url, { method: request.method, headers: request.headers, ...(request.method === 'POST' ? { body: bytes } : {}) });
    const result = await W.regions({ request: req, url, env, auth, id: me.id, pageKey: 'FixtureKey' });
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) { response.writeHead(500).end(error.stack); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const edge = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket, passed = 0, failed = 0;
const errors = [], checks = [];
function check(label, condition) { checks.push({ label, passed: !!condition }); condition ? passed++ : failed++; console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`); }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await pause(100);
  if (!fs.existsSync(portFile)) throw new Error('Edge did not expose DevToolsActivePort');
  const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const pending = new Map();
  socket.onmessage = event => {
    const value = JSON.parse(event.data);
    if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails.text + ': ' + (value.params.exceptionDetails.exception?.description || ''));
    if (value.id && pending.has(value.id)) {
      const item = pending.get(value.id); pending.delete(value.id); clearTimeout(item.timer);
      value.error ? item.reject(new Error(JSON.stringify(value.error))) : item.resolve(value.result);
    }
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(next, { resolve, reject, timer }); socket.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(100); } throw new Error('DOM wait timeout: ' + expression); };
  const navigate = async suffix => { await cdp('Page.navigate', { url: base + suffix }); await waitFor(`document.readyState==='complete'&&!!document.getElementById('cntAll')`); };
  const screenshot = async name => { const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const file = path.join(output, name + '.png'); fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); console.log('SCREENSHOT ' + file); };
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await navigate('/fixture-user/regions?page=1&k=FixtureKey');
  check('initial page count', await evaluate(`document.getElementById('cntAll').textContent==='40'`));
  check('initial unprobed fold', await evaluate(`document.getElementById('cntShown').textContent==='0'`));
  await evaluate(`document.querySelector('[data-act="toggle-unprobed"]').click()`);
  check('unprobed toggle renders 40 rows', await evaluate(`document.getElementById('cntShown').textContent==='40'`));
  await evaluate(`document.getElementById('q').value='203.0.113.1:443';document.getElementById('q').dispatchEvent(new Event('input',{bubbles:true}))`);
  check('search and visible count agree', await evaluate(`document.getElementById('cntShown').textContent==='1'`));
  await evaluate(`document.querySelector('[data-act="collapse"]').click()`);
  check('collapse respects filter', await evaluate(`document.getElementById('cntShown').textContent==='0'`));
  await evaluate(`document.querySelector('[data-act="expand"]').click()`);
  check('expand respects filter', await evaluate(`document.getElementById('cntShown').textContent==='1'`));
  await evaluate(`document.getElementById('q').value='';document.getElementById('q').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.group-toggle').click()`);
  check('accessible group toggle updates aria', await evaluate(`document.querySelector('.group-toggle').getAttribute('aria-expanded')==='false'`));
  await evaluate(`document.querySelector('.group-toggle').click();var checkbox=Array.from(document.querySelectorAll('input[name="pinnedNodes"]')).find(x=>x.type==='checkbox'&&!x.checked);window.fixtureSelected=checkbox.value;checkbox.click()`);
  const selected = await evaluate('window.fixtureSelected');
  check('selection marks unsaved state', await evaluate(`document.getElementById('saveState').textContent==='有未保存的更改'`));
  await screenshot('regions-desktop');
  await evaluate(`document.querySelector('#pager a[data-show="1"]').click()`);
  await waitFor(`document.getElementById('cntAll')&&document.getElementById('cntAll').textContent==='5'`);
  check('draft survives pagination', await evaluate(`Array.from(document.querySelectorAll('#saveForm input[name="pinnedNodes"]')).some(x=>x.value===${JSON.stringify(selected)}&&x.type==='hidden')`));
  check('pagination keeps pageKey', await evaluate(`new URL(location.href).searchParams.get('k')==='FixtureKey'`));
  await evaluate(`document.querySelector('button[form="saveForm"]').click()`);
  await waitFor(`new URL(location.href).searchParams.get('page')===null&&document.getElementById('saveState')?.textContent==='选择已保存'`);
  check('POST persists all pages', me.pinnedNodes.includes(selected) && me.pinnedNodes.includes(keys[8]));
  check('saved state clears draft', await evaluate(`sessionStorage.getItem('regions-draft:'+location.pathname)===null`));
  await evaluate(`document.querySelector('[data-act="toggle-unprobed"]').click();document.querySelector('button[value="requality"]').click()`);
  check('probe stays disabled while pending', await evaluate(`document.querySelector('button[value="requality"]').disabled`));
  await waitFor(`document.querySelector('button[value="requality"]').textContent.includes('s）')`);
  check('probe cooldown and row update', await evaluate(`document.querySelector('tr[data-node]').dataset.probed==='1'&&document.querySelector('button[value="requality"]').disabled`));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot('regions-mobile');
  check('mobile page stays within viewport', await evaluate(`document.documentElement.scrollWidth<=window.innerWidth+1`));
  check('mobile table scrolls without fragmenting node addresses', await evaluate(`document.querySelector('.tw').scrollWidth>document.querySelector('.tw').clientWidth&&getComputedStyle(document.querySelector('td.u')).whiteSpace==='nowrap'`));
  const blockedStorage = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(window,'sessionStorage',{get(){throw new DOMException('Storage blocked','SecurityError')}})` });
  await navigate('/fixture-user/regions?k=FixtureKey');
  await evaluate(`document.querySelector('[data-act="toggle-unprobed"]').click()`);
  check('blocked storage does not break filtering', await evaluate(`document.getElementById('cntShown').textContent==='40'`));
  await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: blockedStorage.identifier });
  await cdp('Page.navigate', { url: base + '/panel' });
  await waitFor(`document.readyState==='complete'&&!!document.querySelector('.section-nav')`);
  check('credentials initially collapsed', await evaluate(`document.querySelector('.credential')&&!document.querySelector('.credential').open`));
  check('mobile overview stays within viewport', await evaluate(`document.documentElement.scrollWidth<=window.innerWidth+1`));
  await screenshot('overview-mobile');
  check('no browser exceptions', errors.length === 0);
} catch (error) { failed++; errors.push(error.stack); console.error(error.stack); }
finally {
  socket?.close(); child.kill(); server.close();
  fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify({ passed, failed, checks, errors }, null, 2));
}
console.log(`Browser: passed=${passed} failed=${failed}`);
process.exitCode = failed ? 1 : 0;
