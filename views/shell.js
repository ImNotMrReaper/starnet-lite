'use strict';
/* The Lite page every device loads. Static markup only — public/app.js fills it in live. Contains no StarNet
   token; the per-device CSRF secret rides in a <meta> so app.js can echo it on every change it asks for. */
const { themeCss } = require('../lib/themes');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Only CSS custom properties with plain colour-ish values may come from the StarNet window.
function varsCss(vars) {
  if (!vars || typeof vars !== 'object') return '';
  const out = [];
  for (const [k, v] of Object.entries(vars)) {
    if (/^--[a-z0-9-]{1,40}$/.test(k) && /^[#a-zA-Z0-9(),.%\s-]{1,80}$/.test(String(v))) out.push(k + ':' + v);
  }
  return out.length ? ':root{' + out.join(';') + '}' : '';
}

function renderShell({ csrf, theme, vars, version }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#000000">
<meta name="lite-csrf" content="${esc(csrf)}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<title>StarNet</title>
<link rel="manifest" href="/lite/manifest.json">
<link rel="icon" href="/lite/icon.svg">
<link rel="apple-touch-icon" href="/lite/icon.svg">
<style>${themeCss(theme)}${varsCss(vars)}</style>
<link rel="stylesheet" href="/lite/lite.css?v=${esc(version)}">
<noscript><meta http-equiv="refresh" content="0;url=/lite/basic"></noscript>
</head><body class="fx-full">
<div id="app">
  <header id="top">
    <span class="wordmark" role="img" aria-label="STARNET"></span><span class="lite-tag">LITE</span>
    <span class="top-fill"></span>
    <span id="chip-host" class="chip"><span class="dot"></span><span>CONNECTING</span></span>
  </header>
  <main id="views">
    <section id="v-map" class="view on" aria-label="Station">
      <div class="panel cam"><div class="ph"><span class="grow">CAM · STATION OVERVIEW</span><span class="live hidden" id="cam-live">LIVE</span></div>
        <div class="pb"><img id="map-img" alt="Live view of your station" hidden><p class="empty" id="map-empty">Waiting for the station view…</p></div></div>
      <div class="panel crewp"><div class="ph"><span class="grow">CREW</span><span class="dim" id="crew-sum2"></span></div><div class="pb"><ul class="crew" id="crew-mini"></ul></div></div>
    </section>
    <section id="v-comms" class="view" aria-label="Comms">
      <div class="panel comms">
        <div class="ph"><span class="grow">COMMS</span><span class="dim" id="comms-agent"></span></div>
        <div class="sessbar">
          <select id="sess-pick" aria-label="Session"></select>
          <button class="btn small" id="sess-new" title="New session">＋ NEW</button>
        </div>
        <div class="pb" id="log-wrap"><div class="log" id="log"></div></div>
        <div class="offline-note hidden" id="comms-off"></div>
        <form class="compose" id="compose" autocomplete="off">
          <textarea id="say" rows="1" placeholder="Message · / commands" aria-label="Message"></textarea>
          <button class="btn bad hidden" type="button" id="stop">■</button>
          <button class="btn" type="submit" id="send" aria-label="Send">➤</button>
        </form>
      </div>
    </section>
    <section id="v-crew" class="view" aria-label="Crew">
      <div class="panel" style="flex:1"><div class="ph"><span class="grow">CREW</span><span class="dim" id="crew-sum"></span></div>
        <div class="pb"><ul class="crew" id="crew"></ul>
          <div class="section-t">Sessions</div><ul class="rows" id="sessions"></ul></div></div>
    </section>
    <section id="v-work" class="view" aria-label="Work">
      <div class="panel" style="flex:1"><div class="ph"><span class="grow">WORK</span><button class="btn small" id="work-refresh">⟳</button></div>
        <div class="pb" id="work"></div></div>
    </section>
  </main>
  <div id="approvals" aria-live="assertive"></div>
  <nav id="nav" aria-label="Sections">
    <button data-v="v-map" class="on"><span class="g">⌂</span>STATION</button>
    <button data-v="v-comms"><span class="g">✉</span>COMMS</button>
    <button data-v="v-crew"><span class="g">☻</span>CREW<span class="badge hidden" id="nav-badge"></span></button>
    <button data-v="v-work"><span class="g">▤</span>WORK</button>
  </nav>
  <div id="toast" class="hidden" role="status"></div>
</div>
<div id="crt" aria-hidden="true"></div>
<script src="/lite/app.js?v=${esc(version)}" defer></script>
</body></html>`;
}

module.exports = { renderShell, varsCss, esc };
