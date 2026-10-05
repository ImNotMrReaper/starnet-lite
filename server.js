#!/usr/bin/env node
/* StarNet Lite — StarNet on phones, wall screens and Raspberry Pis, live with the StarNet window on your computer
   (the same way Claude Code Remote Control mirrors a terminal session). Zero dependencies, Node ≥ 18.
   StarNet's own files are never changed.

   Two doors:
     LOCAL  (default 127.0.0.1:8787) — the computer's own StarNet window. Full StarNet, plus a small helper
            (public/host.js) added to the page as it passes through. The helper is the live link.
     REMOTE (default 0.0.0.0:8788)   — every other device (home Wi-Fi, Tailscale). Always gets Lite.
   StarNet itself runs behind Lite (default 127.0.0.1:8786). Devices never receive StarNet's token.

   Env: STARNET (127.0.0.1:8786) · LITE_LOCAL (127.0.0.1:8787) · LITE_REMOTE (0.0.0.0:8788, "off" to disable)
        LITE_THEME (amber) · STARNET_DATA (StarNet's workspaces folder, for the read-only fallbacks) */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('./lib/starnet');
const { createProxy } = require('./lib/proxy');
const { createHub } = require('./lib/hub');
const { startWatch } = require('./lib/watch');
const { readStation, DEFAULT_DATA } = require('./lib/station');
const { THEMES } = require('./lib/themes');
const sec = require('./lib/security');
const { renderShell } = require('./views/shell');
const { renderPage } = require('./views/page');

const VERSION = require('./package.json').version;

// The only StarNet page commands a device may ask for (see StarNet frontend/app/stationcommands.js).
const VERBS = new Set(['station.status', 'station.sessions', 'station.crew', 'station.tasks', 'station.new_task',
  'station.manage_task', 'station.agent_config', 'station.update_agent', 'station.read_session', 'station.layout']);
const HOST_CMDS = new Set(['chat.send', 'chat.stop', 'session.open', 'session.new', 'session.read', 'agent.select',
  'agent.approval', 'agent.profile', 'autonomy.set', 'map.focus', 'verb', 'ping']);
const DECISIONS = new Set(['once', 'session', 'always', 'deny']);   // never 'full' (permanent full access) from a phone
// Read-only StarNet pages a device may view through Lite (Lite adds the token; the device never sees it).
const READS = {
  runs: '/api/runs?agent=*&limit=40', cron: '/api/cron', loops: '/api/loops', quests: '/api/quests',
  deliverables: '/api/deliverables', posture: '/api/autonomy/posture', channels: '/api/channels/status',
  version: '/api/version', budget: '/api/budget/status', nightshift: '/api/nightshift/status',
  permissions: '/api/permissions', toolsets: '/api/toolsets', skills: '/api/skills', projects: '/api/projects',
  connectors: '/api/connectors', agentskills: '/api/agent-skills', limits: '/api/limits'
};

function hostPort(s, defHost) {
  const v = String(s || '');
  const i = v.lastIndexOf(':');
  return i > 0 ? { host: v.slice(0, i), port: Number(v.slice(i + 1)) } : { host: defHost, port: Number(v) };
}

function createLite(opts = {}) {
  const upstream = hostPort(opts.starnet || process.env.STARNET || '127.0.0.1:8786', '127.0.0.1');
  const client = opts.client || createClient(upstream);
  const proxy = createProxy(upstream);
  const hub = opts.hub || createHub();
  const dataDir = opts.dataDir || process.env.STARNET_DATA || DEFAULT_DATA;
  const themeName = THEMES[opts.theme || process.env.LITE_THEME] ? (opts.theme || process.env.LITE_THEME) : 'amber';
  const hostKey = opts.hostKey || loadHostKey();
  const log = opts.log || ((m) => process.stdout.write(new Date().toISOString() + ' ' + m + '\n'));
  // Static files are re-read when they change on disk (tiny files; updates apply without a restart).
  const cache = {};
  const pub = (f) => {
    const full = path.join(__dirname, 'public', f);
    const m = fs.statSync(full).mtimeMs;
    if (!cache[f] || cache[f].m !== m) cache[f] = { m, body: fs.readFileSync(full) };
    return cache[f].body;
  };
  const types = { 'app.js': 'text/javascript; charset=utf-8', 'lite.css': 'text/css; charset=utf-8', 'basic.css': 'text/css; charset=utf-8',
    'manifest.json': 'application/manifest+json', 'icon.svg': 'image/svg+xml' };
  const files = {};
  for (const f of Object.keys(types)) Object.defineProperty(files, '/lite/' + f, { enumerable: true, get: () => ({ type: types[f], body: pub(f) }) });
  const watch = opts.noWatch ? null : startWatch({ client, hub, log });

  /* ---------- helpers ---------- */
  function json(res, status, obj, extra = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(JSON.stringify(obj));
  }
  function staticFile(res, f) {
    res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(f.body);
  }
  function themeVars() {
    const st = hub.snapshot().state;
    return (st && st.theme && st.theme.vars) || null;
  }

  /* ---------- the computer's own StarNet window ---------- */
  const inject = (html) => {
    const tag = `<script src="/lite/frame-governor.js?v=${VERSION}"></script>` +
      `<script src="/lite/host.js?k=${hostKey}&v=${VERSION}" defer></script>`;
    return html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag;
  };

  async function localHandler(req, res, url) {
    const p = url.pathname;
    if (p === '/lite/frame-governor.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(pub('frame-governor.js'));
    }
    if (p === '/lite/host.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(pub('host.js'));
    }
    if (p.startsWith('/lite/host/')) {
      if (url.searchParams.get('k') !== hostKey && req.headers['x-lite-key'] !== hostKey) { res.writeHead(403); return res.end('wrong key'); }
      if (p === '/lite/host/stream' && req.method === 'GET') { const id = hub.attachHost(res, { ua: String(req.headers['user-agent'] || '') }); log('host connected ' + id.slice(0, 8)); return; }
      const id = String(req.headers['x-lite-host'] || '');
      if (req.method !== 'POST' || !hub.isHost(id)) { res.writeHead(409); return res.end('not the current host'); }
      if (p === '/lite/host/frame') {
        const buf = await sec.readBody(req, 4 << 20);
        hub.hostFrame(id, buf, String(req.headers['content-type'] || 'image/jpeg'));
        res.writeHead(204); return res.end();
      }
      const body = await sec.readJson(req, 8 << 20);
      const ok = p === '/lite/host/state' ? hub.hostState(id, body)
        : p === '/lite/host/activity' ? hub.hostActivity(id, body)
        : p === '/lite/host/result' ? hub.hostResult(id, body)
        : p === '/lite/host/event' ? hub.hostEvent(id, body) : false;
      res.writeHead(ok ? 204 : 400); return res.end();
    }
    // Lite itself also works on the computer (handy for testing): /lite and its files.
    if (p === '/lite' || p === '/lite/' || p.startsWith('/lite/')) return deviceHandler(req, res, url);
    proxy.web(req, res, { inject });
  }

  /* ---------- every other device ---------- */
  async function deviceHandler(req, res, url) {
    const p = url.pathname;
    if (files[p] && req.method === 'GET') return staticFile(res, files[p]);
    // StarNet's own font and wordmark (no secrets in either) — the only StarNet files a device may load.
    if ((p === '/assets/fonts/vt323.woff2' || p === '/assets/brand/starnet-wordmark.svg') && req.method === 'GET') return proxy.web(req, res);

    if ((p === '/' || p === '/lite' || p === '/lite/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const csrf = sec.csrfFor(req);
      const headers = { ...sec.PAGE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' };
      if (csrf.setCookie) headers['Set-Cookie'] = csrf.setCookie;
      res.writeHead(200, headers);
      return res.end(req.method === 'HEAD' ? undefined : renderShell({ csrf: csrf.token, theme: themeName, vars: themeVars(), version: VERSION }));
    }

    // No-JavaScript version (Pi Zero, tiny screens, very old browsers): approvals still work as plain forms.
    if (p === '/lite/basic' && req.method === 'GET') {
      const csrf = sec.csrfFor(req);
      const headers = { ...sec.PAGE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' };
      if (csrf.setCookie) headers['Set-Cookie'] = csrf.setCookie;
      const state = await readStation(client, { dataDir });
      const server = hub.snapshot().server;
      state.prompts = (server.prompts || []).map((pr) => ({ ...pr, agentName: (state.crew.find((m) => m.id === pr.agentId) || {}).name || pr.agentId }));
      res.writeHead(200, headers);
      return res.end(renderPage(state, { theme: themeName, csrf: csrf.token, host: hub.snapshot().host, confirm: url.searchParams.get('confirm'), refresh: url.searchParams.get('confirm') ? 60 : 10 }));
    }
    if (p === '/lite/basic/consent' && req.method === 'POST') {
      const form = new URLSearchParams((await sec.readBody(req, 8192)).toString('utf8'));
      if (!sec.checkCsrf(req, form.get('csrf'))) { res.writeHead(403); return res.end('Refused: this form did not come from your Lite page.'); }
      const decision = form.get('decision');
      if (DECISIONS.has(decision)) {
        await client.api('POST', '/api/consent', { runId: form.get('runId'), promptId: form.get('promptId'), decision });
        if (watch) watch.refresh();
      }
      res.writeHead(303, { Location: '/lite/basic' }); return res.end();
    }

    if (p === '/lite/api/state' && req.method === 'GET') return json(res, 200, { ...hub.snapshot(), version: VERSION });
    if (p === '/lite/api/stream' && req.method === 'GET') { hub.attachDevice(res, { watchMap: url.searchParams.get('map') === '1' }); return; }
    if (p === '/lite/api/map' && req.method === 'GET') {
      const f = hub.mapFrame();
      if (!f) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(f.buf);
    }
    if (p === '/lite/api/read' && req.method === 'GET') {
      const what = url.searchParams.get('what');
      if (what === 'events') return json(res, 200, { ok: true, data: { events: hub.recentEvents() } });
      if (!Object.prototype.hasOwnProperty.call(READS, what)) return json(res, 400, { ok: false, error: 'unknown page' });
      const r = await client.api('GET', READS[what]);
      if (!(r.ok && r.status === 200)) return json(res, 200, { ok: false, error: 'StarNet answered ' + (r.status || 'nothing') });
      let data = r.json;
      // Devices only need the gist: skill bodies are long documents (74 of them) — never ship those to a phone.
      if (what === 'skills' && data && Array.isArray(data.skills)) data = { skills: data.skills.map(({ body, ...k }) => k) };
      return json(res, 200, { ok: true, data });
    }
    // Read-only view of sessions when the StarNet window is closed (from StarNet's saved station).
    if (p === '/lite/api/offline' && req.method === 'GET') return json(res, 200, await offlineView(url.searchParams.get('ws')));

    if (p === '/lite/api/cmd' && req.method === 'POST') {
      if (!sec.checkCsrf(req, req.headers['x-lite-csrf'])) return json(res, 403, { ok: false, error: 'This request did not come from your Lite page.' });
      const { cmd, args = {} } = await sec.readJson(req);
      if (cmd === 'consent') {
        if (!DECISIONS.has(args.decision)) return json(res, 400, { ok: false, error: 'unknown decision' });
        const r = await client.api('POST', '/api/consent', { runId: String(args.runId || ''), promptId: String(args.promptId || ''), decision: args.decision });
        if (watch) watch.refresh();
        return json(res, 200, r.ok && r.json ? { ok: !!r.json.ok, result: r.json, error: r.json.ok ? undefined : 'That request was already answered or has expired.' } : { ok: false, error: 'StarNet did not answer' });
      }
      if (cmd === 'answer') {
        const r = await client.api('POST', '/api/consent/answer', { runId: String(args.runId || ''), promptId: String(args.promptId || ''), answer: String(args.answer || '').slice(0, 4000) });
        if (watch) watch.refresh();
        return json(res, 200, r.ok && r.json ? { ok: !!r.json.ok, result: r.json } : { ok: false, error: 'StarNet did not answer' });
      }
      if (!HOST_CMDS.has(cmd)) return json(res, 400, { ok: false, error: 'unknown command' });
      if (cmd === 'verb' && !VERBS.has(args.verb)) return json(res, 400, { ok: false, error: 'that StarNet command is not available from Lite' });
      return json(res, 200, await hub.command(cmd, args));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not found');
  }

  async function offlineView(wsId) {
    const r = await client.api('GET', '/api/save?agent=agent');
    const doc = r.ok && r.json && (r.json.doc || (r.json.save && r.json.save.doc));
    if (!doc) return { ok: false, error: 'StarNet is not reachable' };
    const generalId = doc.generalId || null;
    const sessions = (doc.workstreams || []).filter((w) => w && !w.archived).map((w) => ({
      id: w.id, title: w.title != null ? w.title : (w.id === generalId ? 'General' : 'Untitled'),
      agentId: w.agentId || 'agent', kind: w.kind || 'chat', lane: w.lane || null
    }));
    const out = { ok: true, activeId: doc.activeId || null, sessions };
    if (wsId) {
      const w = (doc.workstreams || []).find((x) => x && x.id === wsId);
      if (w) out.messages = visible(w.history).slice(-80);
    }
    return out;
  }

  function wrap(handler) {
    return (req, res) => {
      let url;
      try { url = new URL(req.url, 'http://lite.local'); } catch (_) { res.writeHead(400); return res.end(); }
      Promise.resolve(handler(req, res, url)).catch((e) => {
        if (!res.headersSent) res.writeHead(e.status || 500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(e.status ? e.message : 'Lite error');
        if (!e.status) log('error ' + (e.stack || e.message));
      });
    };
  }

  const local = http.createServer(wrap(localHandler));
  local.on('upgrade', proxy.upgrade);
  const remote = http.createServer(wrap(deviceHandler));
  return { local, remote, hub, client, hostKey, stop() { if (watch) watch.stop(); } };
}

/* The helper's key survives Lite restarts (kept in ~/.local/state/starnet-lite/host.key, readable only by this
   account), so updating or restarting Lite never strands the StarNet window that is already open on the computer. */
function loadHostKey() {
  const dir = process.env.LITE_STATE || path.join(require('os').homedir(), '.local', 'state', 'starnet-lite');
  const file = path.join(dir, 'host.key');
  try { const k = fs.readFileSync(file, 'utf8').trim(); if (/^[a-f0-9]{36}$/.test(k)) return k; } catch (_) {}
  const k = crypto.randomBytes(18).toString('hex');
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(file, k + '\n', { mode: 0o600 }); } catch (_) {}
  return k;
}

// Visible chat lines only — never hidden/internal machine chatter (same filter StarNet's own session tools use).
function visible(history) {
  return (history || []).filter((m) => m && !m.hidden && !m.internal && typeof m.content === 'string'
    && (m.role === 'user' || m.role === 'assistant' || m.sys))
    .map((m) => ({ role: m.sys ? 'station' : m.role, agentId: m.agentId || null, content: m.content.slice(0, 20000), ts: m.ts || null }));
}

if (require.main === module) {
  const lite = createLite();
  const L = hostPort(process.env.LITE_LOCAL || '127.0.0.1:8787', '127.0.0.1');
  lite.local.listen(L.port, L.host, () => process.stdout.write(`StarNet Lite ${VERSION}: computer door ${L.host}:${L.port} → StarNet ${process.env.STARNET || '127.0.0.1:8786'}\n`));
  if (String(process.env.LITE_REMOTE || '').toLowerCase() !== 'off') {
    const R = hostPort(process.env.LITE_REMOTE || '0.0.0.0:8788', '0.0.0.0');
    lite.remote.listen(R.port, R.host, () => process.stdout.write(`StarNet Lite ${VERSION}: device door ${R.host}:${R.port}\n`));
  }
  const bye = () => { lite.stop(); process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}

module.exports = { createLite, visible, VERBS, HOST_CMDS, DECISIONS, READS };
