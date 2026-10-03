'use strict';
/* The relay between ONE host (the StarNet window on the computer, via public/host.js) and any number of devices
   (phones, wall screens, Pis running the Lite app). Remote-Control model: the host is the only writer; devices
   see what the host reports and send requests that the host carries out. Nothing here edits StarNet's data. */
const crypto = require('crypto');

const MAX_BUFFERED = 1 << 20;          // a device that stops reading is dropped once 1 MB is queued for it
const KEEPALIVE_MS = 20000;

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
}

function frame(event, data) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data == null ? {} : data) + '\n\n';
}

function createHub({ commandTimeoutMs = 15000, now = () => Date.now() } = {}) {
  let host = null;                     // { id, res, since, version }
  let hostState = null;                // latest full snapshot from the host
  let stateSeq = 0;
  const activity = new Map();          // wsId → live activity (busy, status, acc, toolEvents, pending…)
  const pending = new Map();           // command id → { resolve, timer }
  const devices = new Set();           // { res, watchMap }
  let server = { starnet: 'unknown', prompts: [], updatedAt: 0 };
  let mapFrame = null;                 // { buf, type, seq, at }
  let mapSeq = 0;

  function send(res, event, data) {
    try {
      if (res.writableEnded || res.destroyed) return false;
      if (res.writableLength > MAX_BUFFERED) { res.destroy(); return false; }
      res.write(frame(event, data));
      return true;
    } catch (_) { return false; }
  }

  function toDevices(event, data) { for (const d of devices) if (!send(d.res, event, data)) devices.delete(d); }

  function watchingMap() { for (const d of devices) if (d.watchMap) return true; return false; }
  function tellHostWatch() { if (host) send(host.res, 'watch', { map: watchingMap(), devices: devices.size }); }

  function hostInfo() {
    return host ? { connected: true, since: host.since, starnetVersion: (hostState && hostState.starnetVersion) || null }
      : { connected: false, since: null, starnetVersion: null };
  }

  /* ---------- host side ---------- */
  function attachHost(res, meta = {}) {
    if (host) { send(host.res, 'bye', { reason: 'another StarNet window took over' }); try { host.res.end(); } catch (_) {} }
    sseHeaders(res);
    const me = { id: crypto.randomUUID(), res, since: now(), meta };
    host = me;
    send(res, 'hello', { id: me.id, watch: { map: watchingMap(), devices: devices.size } });
    const ka = setInterval(() => { if (!send(res, 'ping', { t: now() })) clearInterval(ka); }, KEEPALIVE_MS);
    if (ka.unref) ka.unref();
    const done = () => {
      clearInterval(ka);
      if (host === me) {
        host = null;
        for (const [id, p] of pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'StarNet was closed on the computer' }); pending.delete(id); }
        toDevices('host', hostInfo());
      }
    };
    res.on('close', done); res.on('error', done);
    toDevices('host', hostInfo());
    return me.id;
  }

  function isHost(id) { return !!host && host.id === id; }

  function hostState_(id, snap) {
    if (!isHost(id) || !snap || typeof snap !== 'object') return false;
    hostState = snap; stateSeq++;
    if (snap.activity && typeof snap.activity === 'object') {
      activity.clear();
      for (const [ws, a] of Object.entries(snap.activity)) activity.set(ws, a);
    }
    toDevices('state', publicState());
    return true;
  }

  // Frequent, small: one session's live activity (the reply as it is typed, tools, approval details).
  function hostActivity(id, a) {
    if (!isHost(id) || !a || !a.wsId) return false;
    const prev = activity.get(a.wsId) || {};
    const next = { ...prev, ...a };
    // `append` carries only the new text since the last update; `acc` replaces it.
    if (typeof a.append === 'string') next.acc = String(prev.acc || '') + a.append;
    delete next.append;
    activity.set(a.wsId, next);
    toDevices('activity', a);
    return true;
  }

  function hostResult(id, r) {
    if (!isHost(id) || !r || !r.id) return false;
    const p = pending.get(r.id);
    if (!p) return false;
    clearTimeout(p.timer); pending.delete(r.id);
    p.resolve(r.ok ? { ok: true, result: r.result } : { ok: false, error: String(r.error || 'failed') });
    return true;
  }

  function hostFrame(id, buf, type) {
    if (!isHost(id) || !buf || !buf.length) return false;
    mapFrame = { buf, type: type || 'image/jpeg', seq: ++mapSeq, at: now() };
    for (const d of devices) if (d.watchMap && !send(d.res, 'frame', { seq: mapSeq })) devices.delete(d);
    return true;
  }

  // Page events worth showing live (run started/ended, a delivery landed…) — passed through as-is.
  function hostEvent(id, ev) {
    if (!isHost(id) || !ev || !ev.name) return false;
    toDevices('event', { name: String(ev.name), payload: ev.payload || {} });
    return true;
  }

  /* ---------- device side ---------- */
  function command(cmd, args) {
    if (!host) return Promise.resolve({ ok: false, error: 'StarNet is not open on the computer', code: 'no-host' });
    const id = 'lite-' + crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'StarNet did not answer in time', code: 'timeout' }); }, commandTimeoutMs);
      pending.set(id, { resolve, timer });
      if (!send(host.res, 'cmd', { id, cmd: String(cmd), args: args || {} })) {
        clearTimeout(timer); pending.delete(id);
        resolve({ ok: false, error: 'StarNet is not reachable on the computer', code: 'no-host' });
      }
    });
  }

  function attachDevice(res, { watchMap = false } = {}) {
    sseHeaders(res);
    const d = { res, watchMap: !!watchMap };
    devices.add(d);
    send(res, 'hello', { host: hostInfo(), state: publicState(), server, mapSeq: mapFrame ? mapFrame.seq : 0 });
    const ka = setInterval(() => { if (!send(res, 'ping', { t: now() })) clearInterval(ka); }, KEEPALIVE_MS);
    if (ka.unref) ka.unref();
    const done = () => { clearInterval(ka); devices.delete(d); tellHostWatch(); };
    res.on('close', done); res.on('error', done);
    tellHostWatch();
    return d;
  }

  function setServer(patch) {
    server = { ...server, ...patch, updatedAt: now() };
    toDevices('server', server);
  }

  function publicState() {
    if (!hostState) return null;
    return { ...hostState, activity: Object.fromEntries(activity), seq: stateSeq };
  }

  return {
    attachHost, isHost, hostState: hostState_, hostActivity, hostResult, hostFrame, hostEvent,
    attachDevice, command, setServer, toDevices,
    snapshot: () => ({ host: hostInfo(), state: publicState(), server, mapSeq: mapFrame ? mapFrame.seq : 0 }),
    mapFrame: () => mapFrame,
    deviceCount: () => devices.size
  };
}

module.exports = { createHub, frame };
