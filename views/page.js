'use strict';
/* Server-rendered Lite page. Works with JavaScript OFF: plain HTML + one small CSS file, refreshed by a
   <meta refresh>. Nothing secret is ever written into the page (no StarNet token, no file paths). */
const { themeCss } = require('../lib/themes');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ago(ms, now) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

// The short status word shown next to each crew member, e.g. "WORKING 2m" or "IDLE".
// member = { name, working, since (ms timestamp or null), queued (number of waiting tasks) }
// Return { text, tone } where tone is 'ok' (green), 'warn' (yellow) or 'dim' (grey).
function crewStatus(member, now) {
  if (member.working) return { text: 'WORKING' + (member.since ? ' ' + ago(member.since, now) : ''), tone: 'ok' };
  if (member.queued) return { text: member.queued + ' QUEUED', tone: 'warn' };
  return { text: 'IDLE', tone: 'dim' };
}

function renderCrew(crew, now) {
  if (!crew.length) return '<p class="dim">No crew found.</p>';
  return '<ul class="list">' + crew.map((m) => {
    const st = crewStatus(m, now);
    return `<li class="row"><span class="name">${esc(m.name)}</span><span class="tag ${esc(st.tone)}">${esc(st.text)}</span></li>`;
  }).join('') + '</ul>';
}

// Each approval is a plain HTML form: works with JavaScript off. Allow needs a second page (no pocket taps).
function renderPrompts(prompts, csrf) {
  if (!prompts.length) return '<p class="dim">Nothing waiting for you.</p>';
  return prompts.map((p) => {
    const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="runId" value="${esc(p.runId)}"><input type="hidden" name="promptId" value="${esc(p.promptId)}">`;
    return `<div class="ask"><p class="warn">${esc(p.agentName)} wants to use ${esc(p.tool || 'a tool')}</p>` +
      `<pre>${esc(p.argsSummary || '(no details were sent)')}</pre>` +
      `<form method="post" action="/lite/basic/consent" class="row">${hidden}` +
      `<button name="decision" value="deny" class="btn bad">DENY</button>` +
      `<a class="btn" href="/lite/basic?confirm=${encodeURIComponent(p.promptId)}">ALLOW…</a></form>` +
      (p.confirm ? `<form method="post" action="/lite/basic/consent" class="row">${hidden}<span>Really allow?</span><button name="decision" value="once" class="btn go">YES, ALLOW ONCE</button></form>` : '') +
      `</div>`;
  }).join('');
}

function renderRuns(runs, now) {
  if (!runs.length) return '<p class="dim">No runs yet.</p>';
  return '<ul class="list">' + runs.map((r) => {
    const tone = r.reason === 'done' ? 'ok' : (r.reason === 'error' || r.reason === 'failed') ? 'bad' : 'dim';
    return `<li class="run"><span class="title">${esc(r.title)}</span>` +
      `<span class="meta">${esc(r.agentName)} · <span class="${tone}">${esc(r.reason || '…')}</span> · ${esc(ago(r.endedAt, now))}</span></li>`;
  }).join('') + '</ul>';
}

function renderPage(state, { theme = 'amber', now = Date.now(), refresh = 10, csrf = '', host = null, confirm = null } = {}) {
  const online = state.online;
  const working = state.crew.filter((m) => m.working).length;
  const n = state.prompts.length;
  const body = online
    ? `<section id="approvals"><h2>APPROVALS${n ? ` <span class="badge">${n}</span>` : ''}</h2>${renderPrompts(state.prompts.map((p) => ({ ...p, confirm: p.promptId === confirm })), csrf)}</section>
<section id="crew"><h2>CREW <span class="dim">${working} working</span></h2>${renderCrew(state.crew, now)}</section>
<section id="runs"><h2>RECENT RUNS</h2>${renderRuns(state.runs, now)}</section>`
    : `<section><h2 class="bad">STARNET OFFLINE</h2><p>${esc(state.error || 'StarNet is not running.')}</p><p class="dim">This page retries every ${refresh}s.</p></section>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="refresh" content="${refresh}">
<meta name="theme-color" content="#000000">
<title>StarNet Lite</title>
<style>${themeCss(theme)}</style>
<link rel="stylesheet" href="/lite/basic.css">
</head><body>
<header class="top"><span class="logo">STARNET LITE</span><span class="dim">${host && host.connected ? 'computer: open' : 'computer: closed'}</span><span class="${online ? 'ok' : 'bad'}">● ${online ? 'ONLINE' : 'OFFLINE'}</span><a class="btn" href="/lite/basic">⟳</a></header>
<main>${body}</main>
<nav class="nav"><a href="#crew">CREW</a><a href="#approvals">APPROVALS${n ? ` (${n})` : ''}</a><a href="#runs">RUNS</a></nav>
</body></html>`;
}

module.exports = { renderPage, crewStatus, esc, ago };
