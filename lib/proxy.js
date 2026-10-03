'use strict';
/* Pass-through to the full StarNet app for strong devices (was ~/apps/starnet-gateway).
   StarNet only answers loopback Host/Origin (anti DNS-rebinding), so Host / Origin / Referer are rewritten
   to the loopback values. Who may connect at all is decided OUTSIDE this program: the firewall and Tailscale.
   Responses (incl. SSE) are streamed; WebSocket upgrades are piped untouched. */
const http = require('http');
const net = require('net');

function createProxy({ host = '127.0.0.1', port = 8787 } = {}) {
  const loop = `http://${host}:${port}`;

  function rewrite(h) {
    const out = { ...h, host: `${host}:${port}` };
    if (out.origin) out.origin = loop;
    if (out.referer) {
      try { const u = new URL(out.referer); out.referer = loop + u.pathname + u.search; } catch (_) { delete out.referer; }
    }
    delete out['x-forwarded-host'];
    return out;
  }

  /* `inject(html) → html` (optional): applied to StarNet's main page only. The page is buffered (it is ~90 KB),
     changed, and sent with a corrected length; everything else streams straight through. Compression is
     switched off for that one request so the HTML can be edited. */
  function web(req, res, { inject = null } = {}) {
    const pathOnly = String(req.url || '/').split('?')[0];
    const isPage = !!inject && req.method === 'GET' && (pathOnly === '/' || pathOnly === '/index.html');
    const headersOut = rewrite(req.headers);
    // Never let a cached copy from before Lite (same address!) answer 304: it would load without the helper.
    if (isPage) { delete headersOut['accept-encoding']; delete headersOut['if-none-match']; delete headersOut['if-modified-since']; }
    const up = http.request({ host, port, method: req.method, path: req.url, headers: headersOut }, (r) => {
      const headers = { ...r.headers };
      if (headers.location && headers.location.startsWith(loop)) headers.location = headers.location.slice(loop.length) || '/';
      delete headers['access-control-allow-origin'];
      const html = isPage && /text\/html/i.test(String(headers['content-type'] || '')) && !headers['content-encoding'];
      if (!html) { res.writeHead(r.statusCode || 502, headers); return r.pipe(res); }
      const chunks = [];
      r.on('data', (d) => chunks.push(d));
      r.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        try { body = inject(body); } catch (_) {}
        const out = Buffer.from(body, 'utf8');
        headers['content-length'] = String(out.length);
        delete headers['transfer-encoding'];
        delete headers.etag;
        res.writeHead(r.statusCode || 200, headers);
        res.end(out);
      });
      r.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    });
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('StarNet is not reachable: ' + e.message);
    });
    req.pipe(up);
  }

  function upgrade(req, socket, head) {
    const upstream = net.connect(port, host, () => {
      let rawHead = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(rewrite(req.headers))) rawHead += `${k}: ${v}\r\n`;
      upstream.write(rawHead + '\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  }

  return { web, upgrade };
}

module.exports = { createProxy };
