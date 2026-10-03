'use strict';
/* Talks to the StarNet sidecar on loopback, the same way StarNet's own MCP bridge (sidecar/mcp/serve.js) does:
   the per-launch API token is scraped from the served page and kept HERE, on the StarNet machine.
   It is never sent to a device. StarNet mints a new token on every launch, so a 401/403 drops the cached
   token and the call is retried once with a freshly scraped one. */
const http = require('http');

function createClient({ host = '127.0.0.1', port = 8787, timeoutMs = 15000 } = {}) {
  const origin = `http://${host}:${port}`;
  let token = '';
  let pending = null;

  function raw(method, path, body, tok) {
    return new Promise((resolve) => {
      const headers = { Origin: origin, Accept: 'application/json' };
      if (tok) headers['x-starnet-token'] = tok;
      let payload = null;
      if (body != null) {
        payload = Buffer.from(JSON.stringify(body), 'utf8');
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }
      const req = http.request({ host, port, method, path, headers }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (_) {}
          resolve({ ok: true, status: res.statusCode, json, text });
        });
      });
      req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
      if (payload) req.write(payload);
      req.end();
    });
  }

  function discoverToken() {
    if (token) return Promise.resolve(token);
    if (pending) return pending;
    pending = raw('GET', '/', null, '').then((r) => {
      pending = null;
      const m = r.ok && r.status === 200 && /window\.__STARNET_API_TOKEN__=("(?:\\.|[^"])*")/.exec(r.text || '');
      if (m) { try { token = String(JSON.parse(m[1]) || ''); } catch (_) {} }
      return token;
    });
    return pending;
  }

  async function api(method, path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = await discoverToken();
      if (!tok) return { ok: false, status: 0, error: 'StarNet is not running (no access key found)' };
      const r = await raw(method, path, body, tok);
      if (r.ok && (r.status === 401 || r.status === 403) && attempt === 0) { token = ''; continue; }
      return r;
    }
  }

  /* StarNet's live feed (GET /api/channels/events). A Node client may send the token as a header, so no
     single-use ticket is needed. Frames are `data: {"name":…,"payload":…}`; `data: {}` is a keepalive.
     Reconnects forever with a short backoff and resumes from the last cursor so no event is skipped. */
  function subscribe(onEvent, { onState } = {}) {
    let stopped = false, req = null, cursor = '', backoff = 1000, timer = null;
    const state = (s) => { try { onState && onState(s); } catch (_) {} };
    async function connect() {
      if (stopped) return;
      const tok = await discoverToken();
      if (!tok) { state('offline'); return retry(); }
      const headers = { Origin: origin, Accept: 'text/event-stream', 'x-starnet-token': tok };
      if (cursor) headers['Last-Event-ID'] = cursor;
      req = http.request({ host, port, method: 'GET', path: '/api/channels/events', headers }, (res) => {
        if (res.statusCode === 401 || res.statusCode === 403) { token = ''; res.resume(); return retry(); }
        if (res.statusCode !== 200) { res.resume(); return retry(); }
        state('online'); backoff = 1000;
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            let data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('id: ')) cursor = line.slice(4).trim();
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (!data) continue;
            let msg = null;
            try { msg = JSON.parse(data); } catch (_) { continue; }
            if (msg && msg.name) { try { onEvent(msg.name, msg.payload || {}); } catch (_) {} }
          }
        });
        res.on('end', retry);
        res.on('error', retry);
      });
      req.on('error', retry);
      req.end();
    }
    function retry() {
      if (stopped || timer) return;
      state('offline');
      timer = setTimeout(() => { timer = null; connect(); }, backoff);
      if (timer.unref) timer.unref();
      backoff = Math.min(backoff * 2, 15000);
    }
    connect();
    return { stop() { stopped = true; if (timer) clearTimeout(timer); try { req && req.destroy(); } catch (_) {} } };
  }

  return { api, subscribe, origin, _forgetToken: () => { token = ''; } };
}

module.exports = { createClient };
