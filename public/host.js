/* StarNet Lite — host helper. Added by the Lite add-on to the StarNet page on the COMPUTER only.
   It is the live link (Remote-Control model): it reports what this StarNet window shows (sessions, chat, the reply
   while it is typed, crew, approvals, theme, the station view) and carries out requests from Lite devices with
   StarNet's OWN building blocks (Chat.sendOrQueue, App.openWorkstream, StationCommands verbs …). It never edits
   StarNet's data directly, so this window stays the only writer and saves cannot conflict.
   Golden rule: nothing here may ever break StarNet — every call is guarded; a missing piece is reported, not guessed. */
(function () {
  'use strict';
  if (window.__STARNET_LITE_HOST__) return;
  window.__STARNET_LITE_HOST__ = true;

  var me = document.currentScript;
  var KEY = '';
  try { KEY = new URL(me.src).searchParams.get('k') || ''; } catch (_) {}
  var BASE = '/lite/host/';
  var hostId = null, es = null, devices = 0, watchMap = false, stopped = false;
  var lastSig = '', lastAct = {}, frameBusy = false;
  var acks = {};

  /* StarNet's modules are script-scope `const`s (not window properties), so they are reached by name directly —
     no eval, which a strict page policy would block. */
  function mod(name) {
    try {
      switch (name) {
        case 'Workstreams': return typeof Workstreams !== 'undefined' ? Workstreams : null;
        case 'App': return typeof App !== 'undefined' ? App : null;
        case 'Chat': return typeof Chat !== 'undefined' ? Chat : null;
        case 'Channels': return typeof Channels !== 'undefined' ? Channels : null;
        case 'StationCommands': return typeof StationCommands !== 'undefined' ? StationCommands : null;
        case 'StationUI': return typeof StationUI !== 'undefined' ? StationUI : null;
        case 'World': return typeof World !== 'undefined' ? World : null;
        case 'U': return typeof U !== 'undefined' ? U : null;
        case 'AutonomyStore': return typeof AutonomyStore !== 'undefined' ? AutonomyStore : null;
      }
    } catch (_) {}
    return null;
  }
  function safe(fn, dflt) { try { return fn(); } catch (_) { return dflt; } }

  /* ---------- talking to the Lite add-on ---------- */
  var rawFetch = window.fetch.bind(window);
  function post(kind, body, type) {
    if (!hostId) return Promise.resolve(false);
    return rawFetch(BASE + kind + '?k=' + encodeURIComponent(KEY), {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': type || 'application/json', 'x-lite-host': hostId },
      body: type ? body : JSON.stringify(body)
    }).then(function (r) { return r.ok; }, function () { return false; });
  }

  /* StationCommands.run() answers the StarNet server (POST /api/station/ack) instead of returning. For Lite's own
     requests (ids starting "lite-") that answer is caught here and handed back; everything else passes untouched. */
  window.fetch = function (u, init) {
    try {
      if (u === '/api/station/ack' && init && typeof init.body === 'string') {
        var b = JSON.parse(init.body);
        if (b && typeof b.id === 'string' && acks[b.id]) {
          var done = acks[b.id]; delete acks[b.id]; done(b);
          return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
      }
    } catch (_) {}
    return rawFetch.apply(window, arguments);
  };
  function runVerb(verb, args) {
    var SC = mod('StationCommands');
    if (!SC || !SC.run) return Promise.reject(new Error('this StarNet version has no station commands'));
    return new Promise(function (resolve, reject) {
      var id = 'lite-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      var t = setTimeout(function () { delete acks[id]; reject(new Error('StarNet did not finish in time')); }, 12000);
      acks[id] = function (b) { clearTimeout(t); b.ok ? resolve(b.result) : reject(new Error(b.error || 'refused')); };
      SC.run(id, verb, args || {});
    });
  }

  /* ---------- reading this window ---------- */
  function ready() {
    var W = mod('Workstreams'), A = mod('App'), C = mod('Chat'), Ch = mod('Channels');
    var game = document.getElementById('screen-game');
    return !!(W && W.list && A && A.agents && C && C.sendOrQueue && Ch && Ch.snapshot && game && game.classList.contains('active'));
  }

  function visible(history, limit) {
    var out = [];
    (history || []).forEach(function (m) {
      if (!m || m.hidden || m.internal || typeof m.content !== 'string') return;
      if (m.role !== 'user' && m.role !== 'assistant' && !m.sys) return;
      out.push({ role: m.sys ? 'station' : m.role, agentId: m.agentId || null, content: m.content.slice(0, 20000), ts: m.ts || null });
    });
    return limit ? out.slice(-limit) : out;
  }

  var VARS = ['--ph', '--ph-bright', '--ph-dim', '--ph-faint', '--ink', '--bg', '--panel', '--panel2', '--warn', '--bad', '--gold',
    '--text', '--ok', '--ph-glow', '--ph-glow2', '--ph-rgb', '--ph-bright-rgb', '--gold-rgb', '--ok-rgb', '--bad-rgb', '--link-down'];
  function theme() {
    var cs = safe(function () { return getComputedStyle(document.body); }, null), vars = {};
    if (cs) VARS.forEach(function (v) { var x = (cs.getPropertyValue(v) || '').trim(); if (x) vars[v] = x; });
    var SU = mod('StationUI');
    return { name: safe(function () { return SU && SU.getTheme ? SU.getTheme() : null; }, null), vars: vars };
  }

  function activityOf(wsId) {
    var Ch = mod('Channels');
    var s = safe(function () { return Ch.snapshot(wsId); }, null);
    if (!s) return null;
    var acc = String(s.acc || '');
    return {
      wsId: wsId, busy: !!s.busy, runId: s.runId || null, status: safe(function () { return Ch.statusOf(wsId); }, null) || s.status || null,
      startedAt: safe(function () { return Ch.startedAtOf(wsId); }, 0) || 0,
      acc: acc.length > 30000 ? acc.slice(-30000) : acc,
      tools: (s.toolEvents || []).slice(-25).map(function (e) {
        return { t: e.t, name: e.name || null, args: String(e.argsSummary || '').slice(0, 300), ok: e.ok !== false && !e.isErr, callId: e.callId || null };
      }),
      pending: s.pending ? {
        runId: s.pending.runId || s.runId || null, promptId: s.pending.promptId || null, tool: s.pending.tool || null,
        scope: s.pending.scope || null, argsSummary: String(s.pending.argsSummary || '').slice(0, 2000),
        question: s.pending.question || s.pending.text || null, kind: s.pending.kind || null
      } : null
    };
  }

  function snapshot() {
    var W = mod('Workstreams'), A = mod('App'), Ch = mod('Channels');
    var activeId = safe(function () { return W.activeId(); }, null);
    var generalId = safe(function () { return W.generalId(); }, null);
    var rows = safe(function () { return W.list() || []; }, []);
    var sessions = rows.map(function (w) {
      return {
        id: w.id, title: w.title != null ? w.title : (w.id === generalId ? 'General' : 'Untitled'),
        agentId: w.agentId || 'agent', kind: w.kind || 'chat', lane: w.lane || null, pinned: !!w.pinned,
        unread: safe(function () { return !!W.unread(w.id); }, false),
        busy: safe(function () { return Ch.isBusy(w.id); }, false),
        status: safe(function () { return Ch.statusOf(w.id); }, null),
        approval: safe(function () { return !!Ch.pendingOf(w.id); }, false),
        automated: safe(function () { return !!(W.automationOf && W.automationOf(w.id)); }, false),
        projectRoot: w.projectRoot || null
      };
    });
    var crew = safe(function () { return A.agents() || []; }, []).map(function (a) {
      return {
        id: a.id, name: a.name || a.id, role: a.role || null, color: a.color || null, skin: a.skin || null,
        model: a.model || null, provider: a.provider || null, approval: a.approvalMode || null, profile: a.executionProfile || null,
        purpose: a.purpose || null,
        working: sessions.some(function (s) { return s.busy && s.agentId === a.id; }),
        waiting: sessions.some(function (s) { return s.approval && s.agentId === a.id; })
      };
    });
    var active = activeId ? safe(function () { return W.get(activeId); }, null) : null;
    var activity = {};
    sessions.forEach(function (s) { if (s.busy || s.approval) { var a = activityOf(s.id); if (a) activity[s.id] = a; } });
    return {
      v: 1, ts: Date.now(),
      starnetVersion: safe(function () { return document.querySelector('meta[name="starnet-version"]').content; }, null),
      theme: theme(), activeId: activeId, focusAgentId: safe(function () { return A.heroId(); }, null),
      sessions: sessions, crew: crew,
      chat: active ? { wsId: active.id, title: active.title != null ? active.title : (active.id === generalId ? 'General' : 'Untitled'),
        agentId: active.agentId || 'agent', messages: visible(active.history, 80), total: (active.history || []).length } : null,
      activity: activity,
      caps: { verbs: safe(function () { return mod('StationCommands').verbs(); }, []), map: !!document.getElementById('stage') }
    };
  }

  // A cheap fingerprint so the full state is only sent when something visible changed.
  function signature(s) {
    var c = s.chat, last = c && c.messages.length ? c.messages[c.messages.length - 1] : null;
    return JSON.stringify([s.activeId, s.focusAgentId, s.sessions, s.crew, s.theme,
      c && c.wsId, c && c.total, last && last.content.length, last && last.ts]);
  }

  function pushState(force) {
    if (!hostId || !ready()) return;
    var s = safe(snapshot, null);
    if (!s) return;
    var sig = signature(s);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    lastAct = {};
    Object.keys(s.activity).forEach(function (k) { lastAct[k] = s.activity[k]; });
    post('state', s);
  }

  // While an agent works: send only what changed — the new text since last time, tool steps, approval details.
  function pushActivity() {
    if (!hostId || !devices || !ready()) return;
    var Ch = mod('Channels');
    var ids = safe(function () { return (Ch.busyIds() || []).concat(Ch.pendingIds() || []); }, []);
    Object.keys(lastAct).forEach(function (k) { if (ids.indexOf(k) < 0) ids.push(k); });
    ids.forEach(function (id) {
      var a = activityOf(id), prev = lastAct[id];
      if (!a) return;
      var msg = { wsId: id }, changed = false;
      if (!prev || a.acc.indexOf(prev.acc) !== 0) { msg.acc = a.acc; changed = changed || !!a.acc || !!prev; }
      else if (a.acc.length > prev.acc.length) { msg.append = a.acc.slice(prev.acc.length); changed = true; }
      ['busy', 'status', 'runId', 'startedAt'].forEach(function (k) { if (!prev || prev[k] !== a[k]) { msg[k] = a[k]; changed = true; } });
      if (!prev || JSON.stringify(prev.tools) !== JSON.stringify(a.tools)) { msg.tools = a.tools; changed = true; }
      if (!prev || JSON.stringify(prev.pending) !== JSON.stringify(a.pending)) { msg.pending = a.pending; changed = true; }
      lastAct[id] = a;
      if (changed) post('activity', msg);
      if (!a.busy && !a.pending) delete lastAct[id];
    });
  }

  /* ---------- the station view (map) ---------- */
  var shot = null;
  function pushFrame() {
    if (!hostId || !watchMap || frameBusy || document.hidden) return;
    var cv = document.getElementById('stage');
    if (!cv || !cv.width || !cv.height) return;
    frameBusy = true;
    try {
      var w = Math.min(960, cv.width), h = Math.round(cv.height * (w / cv.width));
      if (!shot) shot = document.createElement('canvas');
      if (shot.width !== w || shot.height !== h) { shot.width = w; shot.height = h; }
      shot.getContext('2d').drawImage(cv, 0, 0, w, h);
      shot.toBlob(function (blob) {
        if (!blob) { frameBusy = false; return; }
        post('frame', blob, 'image/jpeg').then(function () { frameBusy = false; });
      }, 'image/jpeg', 0.72);
    } catch (_) { frameBusy = false; }
  }

  /* ---------- requests from Lite devices ---------- */
  function need(name, fn) { var m = mod(name); if (!m || (fn && typeof m[fn] !== 'function')) throw new Error('this StarNet version does not support that (' + name + (fn ? '.' + fn : '') + ')'); return m; }
  function openSession(wsId) {
    var W = need('Workstreams', 'get'), A = need('App', 'openWorkstream');
    if (!W.get(wsId)) throw new Error('that session no longer exists');
    if (W.activeId() !== wsId) A.openWorkstream(wsId);
  }
  var CMDS = {
    ping: function () { return { pong: true }; },
    'chat.send': function (a) {
      var text = String(a.text || '').trim();
      if (!text) throw new Error('nothing to send');
      if (a.wsId) openSession(a.wsId);
      var r = need('Chat', 'sendOrQueue').sendOrQueue(text);
      if (!r || !r.ok) throw new Error('StarNet could not send that message');
      setTimeout(function () { pushState(true); }, 120);
      return r;
    },
    'chat.stop': function (a) {
      if (a.wsId) openSession(a.wsId);
      need('Chat', 'stopActive').stopActive();
      return { stopped: true };
    },
    'session.open': function (a) { openSession(String(a.wsId || '')); setTimeout(function () { pushState(true); }, 60); return { activeId: a.wsId }; },
    'session.new': function () {
      var W = need('Workstreams', 'startSession'), C = need('Chat', 'load'), A = mod('App');
      var ws = W.startSession();
      if (!ws) throw new Error('StarNet could not start a session');
      C.load(ws);
      safe(function () { A.refreshRail(); }); safe(function () { A.persist(); });
      setTimeout(function () { pushState(true); }, 60);
      return { id: ws.id };
    },
    'session.read': function (a) {
      var w = need('Workstreams', 'get').get(String(a.wsId || ''));
      if (!w) throw new Error('that session no longer exists');
      return { wsId: w.id, messages: visible(w.history, Math.min(500, Number(a.limit) || 200)) };
    },
    'agent.select': function (a) {
      var A = need('App', 'selectAgent');
      if (!(A.agents() || []).some(function (x) { return x.id === a.agentId; })) throw new Error('no crew member with that id');
      A.selectAgent(a.agentId);
      setTimeout(function () { pushState(true); }, 60);
      return { agentId: a.agentId };
    },
    'agent.approval': function (a) {
      if (a.mode !== 'ask' && a.mode !== 'full') throw new Error('approval must be ask or full');
      var r = need('App', 'setApproval').setApproval(a.agentId, a.mode);
      setTimeout(function () { pushState(true); }, 60);
      return { agentId: a.agentId, mode: a.mode, result: r === undefined ? null : r };
    },
    'agent.profile': function (a) {
      var ok = ['station-gear', 'safe-cell', 'remote-ssh', 'trusted-project', 'this-computer'];
      if (ok.indexOf(a.profile) < 0) throw new Error('unknown reach profile');
      return Promise.resolve(need('App', 'setExecutionProfile').setExecutionProfile(a.agentId, a.profile)).then(function (r) {
        if (r === false) throw new Error('StarNet kept the previous reach');
        setTimeout(function () { pushState(true); }, 60);
        return { agentId: a.agentId, profile: a.profile };
      });
    },
    // The Commander's INITIATIVE dial (WAIT · SUGGEST · BUILD · FREE), changed by this window so its save stays the only one.
    'autonomy.set': function (a) {
      var ok = ['wait', 'propose', 'leash', 'free'];
      if (ok.indexOf(a.initiative) < 0) throw new Error('unknown initiative');
      return Promise.resolve(need('AutonomyStore', 'setInitiative').setInitiative(a.initiative)).then(function (r) {
        if (r && r.ok === false) throw new Error(r.error || 'StarNet kept the previous setting');
        return { initiative: a.initiative };
      });
    },
    'map.focus': function (a) { var Wd = need('World', 'focusAgent'); Wd.focusAgent(a.agentId); return { focused: a.agentId }; },
    verb: function (a) { return runVerb(String(a.verb || ''), a.args || {}); }
  };

  function handle(msg) {
    var fn = CMDS[msg.cmd];
    Promise.resolve().then(function () {
      if (!fn) throw new Error('this Lite command is not known to the helper');
      if (!ready()) throw new Error('StarNet is still starting on the computer');
      return fn(msg.args || {});
    }).then(function (result) { post('result', { id: msg.id, ok: true, result: result == null ? null : result }); },
      function (e) { post('result', { id: msg.id, ok: false, error: String((e && e.message) || e) }); });
  }

  /* ---------- live events from this page (run start/end …) ---------- */
  function tapBus() {
    var U_ = mod('U');
    if (!U_ || !U_.bus || !U_.bus.emit || U_.bus.__liteTap) return;
    var orig = U_.bus.emit;
    var WANT = /^(agent\.run\.(start|end|error)|run\.|permission\.|station\.(deliver|new_session|sessions)|workitem\.)/;
    U_.bus.emit = function (ev, data) {
      try {
        if (hostId && devices && WANT.test(String(ev))) {
          var p = {};
          if (data && typeof data === 'object') Object.keys(data).forEach(function (k) { var v = data[k]; if (v == null || typeof v !== 'object') p[k] = typeof v === 'string' ? v.slice(0, 300) : v; });
          post('event', { name: String(ev), payload: p });
          setTimeout(function () { pushState(); }, 80);
        }
      } catch (_) {}
      return orig.apply(this, arguments);
    };
    U_.bus.__liteTap = true;
  }

  /* ---------- connection ---------- */
  function connect() {
    if (stopped || es) return;
    es = new EventSource(BASE + 'stream?k=' + encodeURIComponent(KEY));
    es.addEventListener('hello', function (e) {
      var d = JSON.parse(e.data || '{}');
      hostId = d.id; devices = (d.watch && d.watch.devices) || 0; watchMap = !!(d.watch && d.watch.map);
      lastSig = ''; pushState(true);
    });
    es.addEventListener('watch', function (e) { var d = JSON.parse(e.data || '{}'); devices = d.devices || 0; watchMap = !!d.map; if (devices) pushState(true); });
    es.addEventListener('cmd', function (e) { handle(JSON.parse(e.data || '{}')); });
    es.addEventListener('bye', function () { stopped = true; hostId = null; try { es.close(); } catch (_) {} });
    es.onerror = function () { hostId = null; /* EventSource reconnects by itself; a new hello gives a new id */ };
  }
  // A refused or dropped stream closes for good in some browsers — reopen it so the link heals on its own.
  setInterval(function () { if (!stopped && es && es.readyState === 2) { es = null; connect(); } }, 5000);

  function boot() {
    if (!ready()) return setTimeout(boot, 700);
    tapBus();
    connect();
    setInterval(function () { if (devices) pushActivity(); }, 150);
    setInterval(function () { pushState(); }, devices ? 600 : 600);
    setInterval(function () { pushState(true); }, 15000);
    setInterval(pushFrame, 900);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) pushState(true); });
  }
  boot();
})();
