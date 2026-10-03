/* StarNet Lite — the app on phones, wall screens and Pis. It shows what the StarNet window on the computer
   shows, live, and sends requests that the window carries out (Remote-Control model). Plain ES2017, no
   frameworks, nothing heavy: it must run on an Echo Show and a Pi. Every agent/user text is inserted as TEXT
   (escaped), never as HTML. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var CSRF = (document.querySelector('meta[name="lite-csrf"]') || {}).content || '';
  var S = { host: { connected: false }, state: null, server: { prompts: [] }, mapSeq: 0, view: 'v-map', offline: null };
  var es = null, esMap = null, mapLoading = false, rendered = { wsId: null, count: 0, lastLen: 0 };
  var answered = {};   // promptId → true once this device answered (hides the card at once)

  /* ---------- effects tier: full look where the device can take it ---------- */
  (function fx() {
    var saved = null;
    try { saved = localStorage.getItem('lite.fx'); } catch (_) {}
    var mem = navigator.deviceMemory || 4, cores = navigator.hardwareConcurrency || 4, ua = navigator.userAgent || '';
    var tier = 'fx-full';
    if (mem <= 1 || cores <= 2 || /Silk|KFMUWI|AEO|Echo|armv6|armv7/i.test(ua)) tier = 'fx-lite';
    if (Math.min(screen.width, screen.height) <= 240) tier = 'fx-min';
    if (saved === 'fx-full' || saved === 'fx-lite' || saved === 'fx-min') tier = saved;
    document.body.className = tier;
  })();

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // Escape first, then a tiny safe subset of markdown: ``` blocks, `code`, **bold**.
  function fmt(text) {
    var parts = String(text || '').split('```'), out = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2) { out += '<pre>' + esc(parts[i].replace(/^[a-z0-9_-]*\n/i, '')) + '</pre>'; continue; }
      out += esc(parts[i]).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    }
    return out;
  }
  function ago(ts) {
    if (!ts) return '';
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd';
  }
  function clock(ts) { var d = new Date(ts); return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes(); }
  function toast(msg, bad) {
    var t = $('toast'); t.textContent = msg; t.className = bad ? 'bad' : ''; clearTimeout(toast.t);
    toast.t = setTimeout(function () { t.className = 'hidden'; }, 3200);
  }
  function api(cmd, args) {
    return fetch('/lite/api/cmd', { method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-lite-csrf': CSRF }, body: JSON.stringify({ cmd: cmd, args: args || {} }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Lite answered ' + r.status }; }); })
      .catch(function () { return { ok: false, error: 'Lite is not reachable' }; })
      .then(function (r) { if (!r.ok) toast(r.error || 'That did not work', true); return r; });
  }
  function read(what) { return fetch('/lite/api/read?what=' + what, { cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function () { return { ok: false }; }); }
  function crewName(id) { var c = (S.state && S.state.crew) || []; for (var i = 0; i < c.length; i++) if (c[i].id === id) return c[i].name; return id || 'agent'; }
  function isWide() { return window.matchMedia('(min-width: 1100px) and (min-height: 600px)').matches; }

  /* Hold-to-confirm (no accidental approvals from a pocket tap): the action fires only after holding `ms`. */
  function holdButton(btn, ms, fire) {
    var fill = document.createElement('span'); fill.className = 'fill'; btn.insertBefore(fill, btn.firstChild);
    btn.classList.add('hold');
    var t0 = 0, raf = 0, done = false;
    function tick() {
      var p = Math.min(1, (Date.now() - t0) / ms); fill.style.width = (p * 100) + '%';
      if (p >= 1) { done = true; stop(); if (navigator.vibrate) navigator.vibrate(30); fire(); return; }
      raf = requestAnimationFrame(tick);
    }
    function start(e) { if (e.cancelable) e.preventDefault(); done = false; t0 = Date.now(); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); }
    function stop() { cancelAnimationFrame(raf); if (!done) fill.style.width = '0'; }
    btn.addEventListener('pointerdown', start); btn.addEventListener('pointerup', stop); btn.addEventListener('pointerleave', stop); btn.addEventListener('pointercancel', stop);
    btn.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) start(e); });
    btn.addEventListener('keyup', function (e) { if (e.key === 'Enter' || e.key === ' ') stop(); });
    btn.addEventListener('click', function (e) { e.preventDefault(); });
  }

  /* ---------- live connection ---------- */
  function needMap() { return isWide() || S.view === 'v-map'; }
  function connect() {
    if (es && esMap === needMap()) return;
    if (es) es.close();
    esMap = needMap();
    es = new EventSource('/lite/api/stream' + (esMap ? '?map=1' : ''));
    es.addEventListener('hello', function (e) {
      var d = JSON.parse(e.data); S.host = d.host; S.state = d.state; S.server = d.server || S.server;
      if (d.mapSeq) loadMap(d.mapSeq);
      renderAll();
    });
    es.addEventListener('state', function (e) { S.state = JSON.parse(e.data); renderAll(); });
    es.addEventListener('host', function (e) { S.host = JSON.parse(e.data); if (!S.host.connected) loadOffline(); renderAll(); });
    es.addEventListener('server', function (e) { S.server = JSON.parse(e.data); renderApprovals(); renderTop(); });
    es.addEventListener('activity', function (e) { applyActivity(JSON.parse(e.data)); });
    es.addEventListener('frame', function (e) { loadMap(JSON.parse(e.data).seq); });
    es.addEventListener('event', function (e) { var d = JSON.parse(e.data); if (/^run\.|agent\.run\.end/.test(d.name) && S.view === 'v-work') renderWork(); });
    es.onerror = function () { S.host = { connected: false, lost: true }; renderTop(); };
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (es) { es.close(); es = null; } }   // phones suspend background streams anyway
    else connect();
  });

  function applyActivity(a) {
    if (!S.state) return;
    var act = S.state.activity || (S.state.activity = {});
    var prev = act[a.wsId] || {};
    var next = {}; for (var k in prev) next[k] = prev[k];
    for (var j in a) if (j !== 'append') next[j] = a[j];
    if (typeof a.append === 'string') next.acc = String(prev.acc || '') + a.append;
    act[a.wsId] = next;
    renderLive(); renderApprovals(); renderCrew();
  }

  /* ---------- station view ---------- */
  function loadMap(seq) {
    if (!seq || seq <= S.mapSeq && $('map-img').src) return;
    S.mapSeq = seq;
    if (mapLoading) return;
    mapLoading = true;
    var img = new Image();
    img.onload = function () { var m = $('map-img'); m.src = img.src; m.hidden = false; $('map-empty').className = 'hidden'; $('cam-live').className = 'live'; mapLoading = false; };
    img.onerror = function () { mapLoading = false; };
    img.src = '/lite/api/map?s=' + seq;
  }

  /* ---------- rendering ---------- */
  function renderAll() { applyTheme(); renderTop(); renderCrew(); renderSessions(); renderChat(); renderLive(); renderApprovals(); }

  function applyTheme() {
    var v = S.state && S.state.theme && S.state.theme.vars;
    if (!v) return;
    for (var k in v) if (/^--[a-z0-9-]+$/.test(k)) document.documentElement.style.setProperty(k, v[k]);
  }

  function renderTop() {
    var chip = $('chip-host'), on = S.host && S.host.connected;
    chip.className = 'chip ' + (on ? 'ok' : (S.server && S.server.starnet === 'online' ? 'warn' : 'bad'));
    chip.lastChild.textContent = on ? 'LIVE' : (S.host && S.host.lost ? 'RECONNECTING' : (S.server && S.server.starnet === 'online' ? 'STARNET CLOSED ON COMPUTER' : 'OFFLINE'));
    var n = approvals().length, b = $('nav-badge');
    b.textContent = n; b.className = n ? 'badge' : 'badge hidden';
  }

  function crewRow(m, full) {
    var li = document.createElement('li');
    li.className = 'mate' + (m.working ? ' working' : '') + (m.waiting ? ' waiting' : '');
    var st = m.waiting ? '<span class="warn">NEEDS YOU</span>' : m.working ? '<span class="ok">WORKING</span>' : '<span class="dim">IDLE</span>';
    li.innerHTML = '<span class="av">☻</span><span><span class="nm">' + esc(m.name) + '</span><br><span class="sub">' +
      esc((m.model || '') + (m.approval ? ' · ' + (m.approval === 'full' ? 'FULL POWER' : 'ASK') : '')) + '</span></span><span class="st">' + st + '</span>';
    if (full) {
      var ctl = document.createElement('div'); ctl.className = 'ctl';
      var talk = document.createElement('button'); talk.className = 'btn small'; talk.textContent = '✉ TALK';
      talk.onclick = function () { api('agent.select', { agentId: m.id }).then(function (r) { if (r.ok) show('v-comms'); }); };
      ctl.appendChild(talk);
      var mode = document.createElement('button'); mode.className = 'btn small' + (m.approval === 'full' ? ' bad' : '');
      if (m.approval === 'full') { mode.textContent = '✋ SET ASK'; mode.onclick = function () { api('agent.approval', { agentId: m.id, mode: 'ask' }); }; }
      else { mode.innerHTML = '<span class="lbl">⚡ HOLD: FULL POWER</span>'; holdButton(mode, 1500, function () { api('agent.approval', { agentId: m.id, mode: 'full' }); }); }
      ctl.appendChild(mode);
      var reach = document.createElement('select'); reach.className = 'btn small'; reach.setAttribute('aria-label', 'Reach');
      [['station-gear', 'STATION GEAR'], ['safe-cell', 'SAFE CELL'], ['remote-ssh', 'REMOTE SSH'], ['trusted-project', 'MY PROJECT FOLDERS'], ['this-computer', 'THIS COMPUTER']].forEach(function (o) {
        var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1]; if (m.profile === o[0]) opt.selected = true; reach.appendChild(opt);
      });
      reach.onchange = function () {
        if (reach.value === 'this-computer' && !confirm('THIS COMPUTER: ' + m.name + ' could read any file on the computer. Continue?')) { reach.value = m.profile; return; }
        api('agent.profile', { agentId: m.id, profile: reach.value });
      };
      ctl.appendChild(reach);
      li.appendChild(ctl);
    }
    return li;
  }
  function renderCrew() {
    var crew = (S.state && S.state.crew) || [];
    var working = crew.filter(function (m) { return m.working; }).length;
    [['crew', true], ['crew-mini', false]].forEach(function (x) {
      var ul = $(x[0]); ul.innerHTML = '';
      if (!crew.length) { ul.innerHTML = '<li class="empty">' + (S.host.connected ? 'No crew yet.' : 'Open StarNet on the computer to see your crew live.') + '</li>'; return; }
      crew.forEach(function (m) { ul.appendChild(crewRow(m, x[1])); });
    });
    $('crew-sum').textContent = $('crew-sum2').textContent = crew.length ? working + ' WORKING · ' + (crew.length - working) + ' IDLE' : '';
  }

  function sessionsList() { return (S.state && S.state.sessions) || (S.offline && S.offline.sessions) || []; }
  function activeId() { return (S.state && S.state.activeId) || (S.offline && S.offline.activeId) || null; }
  function renderSessions() {
    var list = sessionsList(), act = activeId(), pick = $('sess-pick'), ul = $('sessions');
    pick.innerHTML = ''; ul.innerHTML = '';
    list.forEach(function (s) {
      var o = document.createElement('option'); o.value = s.id;
      o.textContent = (s.busy ? '● ' : s.approval ? '⚠ ' : '') + s.title + ' · ' + crewName(s.agentId);
      if (s.id === act) o.selected = true; pick.appendChild(o);
      var li = document.createElement('li'); li.className = 'rowi' + (s.id === act ? ' active' : '');
      var b = document.createElement('button'); b.className = 'grow'; b.textContent = s.title + ' · ' + crewName(s.agentId);
      b.onclick = function () { openSession(s.id); };
      li.appendChild(b);
      var st = document.createElement('span'); st.className = s.approval ? 'warn' : s.busy ? 'ok' : 'dim';
      st.textContent = s.approval ? 'NEEDS YOU' : s.busy ? 'WORKING' : (s.kind === 'task' ? 'TASK' : '');
      li.appendChild(st); ul.appendChild(li);
    });
    if (!list.length) ul.innerHTML = '<li class="empty">No sessions.</li>';
  }

  function chatSource() {
    if (S.state && S.state.chat) return S.state.chat;
    if (S.offline && S.offline.messages) return { wsId: S.offline.wsId, agentId: null, messages: S.offline.messages, total: S.offline.messages.length };
    return null;
  }
  function msgEl(m, agentId) {
    var d = document.createElement('div'); d.className = 'msg ' + m.role;
    var who = m.role === 'user' ? 'YOU' : m.role === 'station' ? '' : crewName(m.agentId || agentId);
    d.innerHTML = (who ? '<span class="who">' + esc(who) + (m.ts ? ' · ' + clock(m.ts) : '') + '</span>' : '') + fmt(m.content);
    return d;
  }
  function renderChat() {
    var c = chatSource(), log = $('log'), wrap = $('log-wrap');
    var online = S.host && S.host.connected;
    $('comms-off').className = online ? 'offline-note hidden' : 'offline-note';
    $('comms-off').textContent = 'StarNet is closed on the computer — you can read, but messages wait until it is open.';
    $('say').disabled = $('send').disabled = !online;
    $('comms-agent').textContent = c && c.agentId ? crewName(c.agentId) : '';
    if (!c) { log.innerHTML = '<p class="empty">No conversation open.</p>'; rendered = { wsId: null, count: 0, lastLen: 0 }; return; }
    var msgs = c.messages || [], atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
    var last = msgs[msgs.length - 1], lastLen = last ? last.content.length : 0;
    if (rendered.wsId !== c.wsId || msgs.length < rendered.count || (msgs.length === rendered.count && lastLen !== rendered.lastLen)) {
      log.innerHTML = ''; rendered = { wsId: c.wsId, count: 0, lastLen: 0 }; atBottom = true;
    }
    var live = $('live-msg'); if (live) live.remove();
    if (rendered.count === 0) log.innerHTML = '';
    for (var i = rendered.count; i < msgs.length; i++) log.appendChild(msgEl(msgs[i], c.agentId));
    if (!msgs.length) log.innerHTML = '<p class="empty">Say something to start.</p>';
    rendered.count = msgs.length; rendered.lastLen = lastLen;
    renderLive(true);
    if (atBottom) wrap.scrollTop = wrap.scrollHeight;
  }
  // The reply as it is being typed on the computer, plus the tools the agent is using right now.
  function renderLive(noScroll) {
    var c = chatSource(), wrap = $('log-wrap');
    var a = c && S.state && S.state.activity && S.state.activity[c.wsId];
    var el = $('live-msg');
    var busy = !!(a && (a.busy || a.pending));
    $('stop').className = busy && S.host.connected ? 'btn bad' : 'btn bad hidden';
    if (!busy) { if (el) el.remove(); return; }
    var atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
    if (!el) { el = document.createElement('div'); el.id = 'live-msg'; el.className = 'msg assistant live'; $('log').appendChild(el); }
    var tools = (a.tools || []).filter(function (t) { return t.t === 'call' || t.t === 'result'; }).slice(-6).map(function (t) {
      return '<span class="tool ' + (t.t === 'call' ? 'call' : '') + (t.ok === false ? ' err' : '') + '">' + esc((t.t === 'call' ? '▸ ' : '✓ ') + (t.name || 'tool') + (t.args ? ' ' + t.args : '')) + '</span>';
    }).join('');
    el.innerHTML = '<span class="who">' + esc(crewName(c.agentId)) + ' · <span class="status-line">' + esc(a.status || 'working…') + '</span></span>' +
      fmt(a.acc || '') + (tools ? '<div class="tools">' + tools + '</div>' : '');
    if (!noScroll && atBottom) wrap.scrollTop = wrap.scrollHeight;
  }

  /* ---------- approvals ---------- */
  function approvals() {
    var byId = {}, out = [];
    var act = (S.state && S.state.activity) || {};
    Object.keys(act).forEach(function (ws) {
      var p = act[ws] && act[ws].pending;
      if (p && p.promptId && !answered[p.promptId]) { var s = sessionsList().filter(function (x) { return x.id === ws; })[0]; byId[p.promptId] = { runId: p.runId || act[ws].runId, promptId: p.promptId, tool: p.tool, argsSummary: p.argsSummary, scope: p.scope, question: p.question, kind: p.kind, agentId: s ? s.agentId : null, wsId: ws }; }
    });
    ((S.server && S.server.prompts) || []).forEach(function (p) {
      if (!p.promptId || answered[p.promptId]) return;
      var cur = byId[p.promptId] || {};
      byId[p.promptId] = { runId: cur.runId || p.runId, promptId: p.promptId, tool: cur.tool || p.tool, argsSummary: cur.argsSummary || p.argsSummary, scope: cur.scope || p.scope, question: cur.question, kind: cur.kind, agentId: cur.agentId || p.agentId, wsId: cur.wsId };
    });
    for (var k in byId) out.push(byId[k]);
    return out;
  }
  function decide(p, decision, card) {
    answered[p.promptId] = true; card.remove(); renderTop();
    api('consent', { runId: p.runId, promptId: p.promptId, decision: decision }).then(function (r) {
      if (!r.ok) { delete answered[p.promptId]; renderApprovals(); }
      else toast(decision === 'deny' ? 'Denied' : 'Approved');
    });
  }
  function renderApprovals() {
    var box = $('approvals'), list = approvals(), keep = {};
    list.forEach(function (p) { keep[p.promptId] = true; });
    Array.prototype.slice.call(box.children).forEach(function (el) { if (!keep[el.dataset.id]) el.remove(); });
    list.forEach(function (p) {
      if (box.querySelector('[data-id="' + p.promptId + '"]')) return;
      var card = document.createElement('div'); card.className = 'ask'; card.dataset.id = p.promptId;
      var isQ = p.kind === 'clarify' || p.tool === 'brief.ask' || (!!p.question && !p.argsSummary);
      card.innerHTML = '<div class="t">⚠ ' + esc(crewName(p.agentId)) + (isQ ? ' asks you' : ' wants to use ' + esc(p.tool || 'a tool')) + '</div>' +
        '<div class="cmd">' + esc(p.question || p.argsSummary || '(no details were sent)') + '</div>';
      if (isQ) {
        var ta = document.createElement('textarea'); ta.placeholder = 'Your answer'; card.appendChild(ta);
        var row0 = document.createElement('div'); row0.className = 'row';
        var send = document.createElement('button'); send.className = 'btn go'; send.textContent = 'ANSWER';
        send.onclick = function () { answered[p.promptId] = true; card.remove(); api('answer', { runId: p.runId, promptId: p.promptId, answer: ta.value }); };
        row0.appendChild(send); card.appendChild(row0); box.appendChild(card); return;
      }
      var row = document.createElement('div'); row.className = 'row';
      var deny = document.createElement('button'); deny.className = 'btn bad'; deny.textContent = '✕ DENY';
      deny.onclick = function () { decide(p, 'deny', card); };
      var allow = document.createElement('button'); allow.className = 'btn go'; allow.innerHTML = '<span class="lbl">HOLD ✓ ALLOW ONCE</span>';
      holdButton(allow, 1000, function () { decide(p, 'once', card); });
      var more = document.createElement('button'); more.className = 'btn small'; more.textContent = '⋯';
      row.appendChild(deny); row.appendChild(more); row.appendChild(allow);
      var extra = document.createElement('div'); extra.className = 'more hidden';
      var sess = document.createElement('button'); sess.className = 'btn go small'; sess.innerHTML = '<span class="lbl">HOLD: THIS SESSION</span>';
      holdButton(sess, 1200, function () { decide(p, 'session', card); });
      var always = document.createElement('button'); always.className = 'btn go small'; always.innerHTML = '<span class="lbl">HOLD: ALWAYS</span>';
      holdButton(always, 1600, function () { decide(p, 'always', card); });
      extra.appendChild(sess); extra.appendChild(always);
      more.onclick = function () { extra.classList.toggle('hidden'); };
      card.appendChild(row); card.appendChild(extra); box.appendChild(card);
    });
    renderTop();
  }

  /* ---------- work (tasks, routines, runs, quests) ---------- */
  function renderWork() {
    var w = $('work');
    w.innerHTML = '<p class="empty">Loading…</p>';
    var tasksP = S.host.connected ? api('verb', { verb: 'station.tasks' }) : Promise.resolve({ ok: false });
    Promise.all([tasksP, read('cron'), read('runs'), read('quests')]).then(function (r) {
      var html = '';
      html += '<div class="section-t">Tasks</div>';
      if (r[0].ok) {
        html += '<form id="task-new" class="compose" style="padding:0 0 6px;border:0"><textarea id="task-title" rows="1" placeholder="New task…"></textarea><button class="btn" type="submit">＋</button></form>';
        var tasks = r[0].result.tasks || [];
        html += tasks.length ? '<ul class="rows">' + tasks.map(function (t) {
          return '<li class="rowi"><span class="grow">' + esc(t.title) + ' · ' + esc(crewName(t.agentId)) + '</span>' +
            ['todo', 'active', 'shipped'].map(function (l) { return '<button class="btn small' + (t.lane === l ? ' on' : '') + '" data-task="' + esc(t.id) + '" data-lane="' + l + '">' + l.toUpperCase() + '</button>'; }).join('') + '</li>';
        }).join('') + '</ul>' : '<p class="empty">No tasks.</p>';
      } else html += '<p class="empty">Tasks need StarNet open on the computer.</p>';
      html += '<div class="section-t">Routines</div>';
      var jobs = (r[1].ok && r[1].data && r[1].data.jobs) || [];
      html += jobs.length ? '<ul class="rows">' + jobs.map(function (j) {
        return '<li class="rowi"><span class="grow">' + esc(j.name || j.id) + '</span><span class="' + (j.enabled ? 'ok' : 'dim') + '">' + (j.enabled ? 'ON' : 'OFF') + '</span></li>';
      }).join('') + '</ul>' : '<p class="empty">No routines.</p>';
      html += '<div class="section-t">Quests</div>';
      var q = r[3].ok && r[3].data, ql = (q && (q.quests || q.active || q.items)) || [];
      html += ql.length ? '<ul class="rows">' + ql.slice(0, 12).map(function (x) { return '<li class="rowi"><span class="grow">' + esc(x.title || x.name || x.id) + '</span><span class="dim">' + esc(x.status || '') + '</span></li>'; }).join('') + '</ul>' : '<p class="empty">No quests.</p>';
      html += '<div class="section-t">Recent runs</div>';
      var runs = (r[2].ok && r[2].data && r[2].data.runs) || [];
      html += runs.length ? '<ul class="rows">' + runs.slice(0, 25).map(function (x) {
        var tone = x.reason === 'done' ? 'ok' : /error|fail/.test(x.reason || '') ? 'bad' : 'dim';
        return '<li class="rowi"><span class="grow">' + esc(x.title || x.sessionTitle || '(untitled)') + '</span><span class="dim">' + esc(crewName(x.agentId)) + '</span><span class="' + tone + '">' + esc(x.reason || '') + ' ' + ago(x.endedAt) + '</span></li>';
      }).join('') + '</ul>' : '<p class="empty">No runs yet.</p>';
      w.innerHTML = html;
      Array.prototype.forEach.call(w.querySelectorAll('[data-task]'), function (b) {
        b.onclick = function () { api('verb', { verb: 'station.manage_task', args: { task: b.dataset.task, action: 'move', lane: b.dataset.lane } }).then(function (x) { if (x.ok) renderWork(); }); };
      });
      var f = $('task-new');
      if (f) f.onsubmit = function (e) {
        e.preventDefault(); var t = $('task-title').value.trim(); if (!t) return;
        api('verb', { verb: 'station.new_task', args: { title: t } }).then(function (x) { if (x.ok) renderWork(); });
      };
    });
  }

  /* ---------- closed StarNet window: read-only from the saved station ---------- */
  function loadOffline(wsId) {
    fetch('/lite/api/offline' + (wsId ? '?ws=' + encodeURIComponent(wsId) : ''), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) return;
      S.offline = d; if (!wsId && d.activeId) return loadOffline(d.activeId);
      if (wsId) S.offline.wsId = wsId;
      if (!S.host.connected) { renderSessions(); renderChat(); }
    }).catch(function () {});
  }

  /* ---------- actions ---------- */
  function openSession(id) {
    if (!S.host.connected) { loadOffline(id); show('v-comms'); return; }
    api('session.open', { wsId: id }).then(function (r) { if (r.ok) show('v-comms'); });
  }
  $('sess-pick').onchange = function () { openSession(this.value); };
  $('sess-new').onclick = function () { if (S.host.connected) api('session.new'); else toast('StarNet is closed on the computer', true); };
  $('stop').onclick = function () { var c = chatSource(); api('chat.stop', { wsId: c && c.wsId }); };
  $('compose').onsubmit = function (e) {
    e.preventDefault();
    var box = $('say'), text = box.value.trim(), c = chatSource();
    if (!text) return;
    $('send').disabled = true;
    api('chat.send', { text: text, wsId: c && c.wsId }).then(function (r) { $('send').disabled = false; if (r.ok) { box.value = ''; grow(); } });
  };
  function grow() { var t = $('say'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.3) + 'px'; }
  $('say').addEventListener('input', grow);
  $('say').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); $('compose').requestSubmit ? $('compose').requestSubmit() : $('compose').onsubmit(e); } });
  $('work-refresh').onclick = renderWork;

  function show(v) {
    S.view = v;
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (x) { x.classList.toggle('on', x.id === v); });
    Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (b) { b.classList.toggle('on', b.dataset.v === v); });
    if (v === 'v-work') renderWork();
    if (v === 'v-comms') { var w = $('log-wrap'); w.scrollTop = w.scrollHeight; }
    connect();
  }
  Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (b) { b.onclick = function () { show(b.dataset.v); }; });
  window.addEventListener('resize', function () { connect(); });

  connect();
  setInterval(function () { if (S.state) renderSessions(); }, 30000);
})();
