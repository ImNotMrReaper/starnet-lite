'use strict';
// node --test test/  — runs against a tiny fake StarNet (no real station needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLite } = require('../server');
const { createHub } = require('../lib/hub');

const TOKEN = 'secret-token-abc';
function fakeStarnet() {
  const consents = [];
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<html><head><script>window.__STARNET_API_TOKEN__=${JSON.stringify(TOKEN)};</script></head><body>app</body></html>`);
    }
    if (url.startsWith('/api/') && req.headers['x-starnet-token'] !== TOKEN) { res.writeHead(401); return res.end(); }
    if (url === '/api/state/snapshot') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ runs: [], prompts: [{ runId: 'r1', promptId: 'p1', agentId: 'agent' }], queues: [] })); }
    if (url === '/api/consent') {
      let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { consents.push(JSON.parse(b)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
      return;
    }
    if (url === '/api/runs') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"runs":[]}'); }
    if (url === '/api/channels/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.write('data: {}\n\n'); }
    res.writeHead(404); res.end();
  });
  return { srv, consents };
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
function req(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}

let up, upPort, lite, localPort, remotePort;
test.before(async () => {
  up = fakeStarnet(); upPort = await listen(up.srv);
  lite = createLite({ starnet: '127.0.0.1:' + upPort, dataDir: '/nonexistent', log: () => {} });
  localPort = await listen(lite.local); remotePort = await listen(lite.remote);
  await new Promise((r) => setTimeout(r, 300));
});
test.after(() => { lite.stop(); lite.local.closeAllConnections && lite.local.closeAllConnections(); lite.remote.closeAllConnections && lite.remote.closeAllConnections(); lite.local.close(); lite.remote.close(); up.srv.closeAllConnections && up.srv.closeAllConnections(); up.srv.close(); });

async function pageAndCookie() {
  const r = await req(remotePort, 'GET', '/');
  const cookie = String(r.headers['set-cookie'] || '').split(';')[0];
  const csrf = /name="lite-csrf" content="([a-f0-9]+)"/.exec(r.body)[1];
  return { r, cookie, csrf };
}

test('computer door: StarNet page passes through with the helper added', async () => {
  const r = await req(localPort, 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.body, /__STARNET_API_TOKEN__/);                 // the computer's own window keeps working as before
  assert.match(r.body, /<script src="\/lite\/host\.js\?k=[a-f0-9]+/);
  assert.equal(Number(r.headers['content-length']), Buffer.byteLength(r.body));
});

test('device door: Lite page, never the token, never StarNet API', async () => {
  const { r } = await pageAndCookie();
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.body, /secret-token-abc|__STARNET_API_TOKEN__/);
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal((await req(remotePort, 'GET', '/api/runs')).status, 404);
  assert.equal((await req(remotePort, 'GET', '/index.html')).status, 404);
  assert.equal((await req(remotePort, 'GET', '/lite/host/stream')).status, 404);
});

test('host channel refuses a wrong key', async () => {
  assert.equal((await req(localPort, 'GET', '/lite/host/stream?k=nope')).status, 403);
});

test('commands need the page secret and a same-site origin', async () => {
  const { cookie, csrf } = await pageAndCookie();
  const body = JSON.stringify({ cmd: 'consent', args: { runId: 'r1', promptId: 'p1', decision: 'once' } });
  const base = { 'Content-Type': 'application/json', Cookie: cookie, Host: '127.0.0.1:' + remotePort };
  assert.equal((await req(remotePort, 'POST', '/lite/api/cmd', { headers: base, body })).status, 403);                                   // no secret
  assert.equal((await req(remotePort, 'POST', '/lite/api/cmd', { headers: { ...base, 'x-lite-csrf': 'f'.repeat(48) }, body })).status, 403);  // wrong secret
  assert.equal((await req(remotePort, 'POST', '/lite/api/cmd', { headers: { ...base, 'x-lite-csrf': csrf, Origin: 'http://evil.example' }, body })).status, 403);
  const ok = await req(remotePort, 'POST', '/lite/api/cmd', { headers: { ...base, 'x-lite-csrf': csrf }, body });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).ok, true);
  assert.deepEqual(up.consents.at(-1), { runId: 'r1', promptId: 'p1', decision: 'once' });
});

test('a phone can never grant permanent full access', async () => {
  const { cookie, csrf } = await pageAndCookie();
  const r = await req(remotePort, 'POST', '/lite/api/cmd', { headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-lite-csrf': csrf },
    body: JSON.stringify({ cmd: 'consent', args: { runId: 'r1', promptId: 'p1', decision: 'full' } }) });
  assert.equal(r.status, 400);
});

test('only listed StarNet commands are allowed; no host → clear answer', async () => {
  const { cookie, csrf } = await pageAndCookie();
  const h = { 'Content-Type': 'application/json', Cookie: cookie, 'x-lite-csrf': csrf };
  assert.equal((await req(remotePort, 'POST', '/lite/api/cmd', { headers: h, body: JSON.stringify({ cmd: 'verb', args: { verb: 'station.deliver' } }) })).status, 400);
  assert.equal((await req(remotePort, 'POST', '/lite/api/cmd', { headers: h, body: JSON.stringify({ cmd: 'eval', args: {} }) })).status, 400);
  const r = await req(remotePort, 'POST', '/lite/api/cmd', { headers: h, body: JSON.stringify({ cmd: 'chat.send', args: { text: 'hi' } }) });
  assert.match(JSON.parse(r.body).error, /not open on the computer/);
});

test('no-JavaScript page shows the approval as a form and posts it', async () => {
  await new Promise((r) => setTimeout(r, 400));
  const page = await req(remotePort, 'GET', '/lite/basic');
  assert.equal(page.status, 200);
  assert.match(page.body, /action="\/lite\/basic\/consent"/);
  const cookie = String(page.headers['set-cookie'] || '').split(';')[0];
  const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(page.body)[1];
  const r = await req(remotePort, 'POST', '/lite/basic/consent', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: `csrf=${csrf}&runId=r1&promptId=p1&decision=deny` });
  assert.equal(r.status, 303);
  assert.equal(up.consents.at(-1).decision, 'deny');
});

test('hub: a command reaches the host and its answer comes back', async () => {
  const hub = createHub({ commandTimeoutMs: 500 });
  const writes = [];
  const fakeRes = { writableLength: 0, write: (s) => { writes.push(s); return true; }, writeHead() {}, on() {} };
  const id = hub.attachHost(fakeRes);
  const p = hub.command('ping', {});
  const sent = writes.find((w) => w.startsWith('event: cmd'));
  const cmdId = JSON.parse(sent.split('data: ')[1]).id;
  hub.hostResult(id, { id: cmdId, ok: true, result: { pong: true } });
  assert.deepEqual(await p, { ok: true, result: { pong: true } });
  const late = await hub.command('ping', {});        // never answered → times out with a reason
  assert.equal(late.code, 'timeout');
});

test('hub: live text arrives as small appends', () => {
  const hub = createHub();
  const fakeRes = { writableLength: 0, write: () => true, writeHead() {}, on() {} };
  const id = hub.attachHost(fakeRes);
  hub.hostState(id, { sessions: [], activity: {} });
  hub.hostActivity(id, { wsId: 'w', acc: 'Hel', busy: true });
  hub.hostActivity(id, { wsId: 'w', append: 'lo' });
  assert.equal(hub.snapshot().state.activity.w.acc, 'Hello');
});
