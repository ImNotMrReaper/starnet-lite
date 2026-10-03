'use strict';
/* One read of "what is the station doing right now", shaped for the Lite page.
   StarNet has no GET route for the crew roster (the browser pushes it), so names come from the roster file
   StarNet writes to its data folder (read-only here); if that file can't be read, agent ids are shown instead. */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_DATA = path.join(os.homedir(), '.local', 'share', 'StarNet', 'workspaces');

function readRoster(dataDir) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent.roster.json'), 'utf8'));
    return (r.agents || []).map((a) => ({ id: a.agentId, name: a.name || a.agentId, model: a.model || '', approval: a.approvalMode || '' }));
  } catch (_) { return []; }
}

async function readStation(client, { dataDir = DEFAULT_DATA, runLimit = 8 } = {}) {
  const [snap, runs] = await Promise.all([
    client.api('GET', '/api/state/snapshot'),
    client.api('GET', `/api/runs?agent=*&limit=${runLimit}`)
  ]);
  if (!snap.ok || snap.status !== 200 || !snap.json) {
    return { online: false, error: snap.error || `StarNet answered ${snap.status}`, crew: [], prompts: [], runs: [] };
  }
  const s = snap.json;
  const active = new Map((s.runs || []).map((r) => [r.agentId, r]));
  const queued = new Map((s.queues || []).map((q) => [q.agentId, q.depth || 0]));
  const roster = readRoster(dataDir);
  // Agents that are running but missing from the roster file still show up.
  for (const id of active.keys()) if (!roster.some((a) => a.id === id)) roster.push({ id, name: id, model: '', approval: '' });
  const nameOf = (id) => (roster.find((a) => a.id === id) || {}).name || id;

  const crew = roster.map((a) => {
    const run = active.get(a.id);
    return { ...a, working: !!run, since: run ? run.startedAt : null, queued: queued.get(a.id) || 0 };
  });
  const prompts = (s.prompts || []).map((p) => ({ ...p, agentName: nameOf(p.agentId) }));
  const recent = ((runs.json && runs.json.runs) || []).map((r) => ({
    runId: r.runId, agentId: r.agentId, agentName: nameOf(r.agentId), title: r.title || r.sessionTitle || '(untitled)',
    reason: r.reason || '', endedAt: r.endedAt || r.ts || null, streamId: r.streamId || ''
  }));
  return { online: true, ts: s.ts || Date.now(), crew, prompts, runs: recent };
}

module.exports = { readStation, DEFAULT_DATA };
