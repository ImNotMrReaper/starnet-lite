'use strict';
/* Keeps devices current with what StarNet's SERVER knows — open approval requests, running agents, run endings —
   independently of the StarNet window. This is what still works when the window on the computer is closed
   (approvals for scheduled/channel runs, the run list), and it fills in approval details (tool + command) that
   the server's snapshot alone does not carry. */

const FORWARD = /^(run\.|agent\.run\.|queue\.|permission\.|channel\.(inbound|delivery)|cron\.(fire|result)|quest\.(update|complete)|workitem\.)/;

function startWatch({ client, hub, pollMs = 15000, log = () => {} }) {
  const details = new Map();           // promptId → { tool, scope, argsSummary, agentId, at }
  let timer = null, refreshing = false, again = false;

  async function refresh() {
    if (refreshing) { again = true; return; }
    refreshing = true;
    try {
      const snap = await client.api('GET', '/api/state/snapshot');
      if (!snap.ok || snap.status !== 200 || !snap.json) { hub.setServer({ starnet: 'offline' }); return; }
      const s = snap.json;
      const prompts = (s.prompts || []).map((p) => ({ ...p, ...(details.get(p.promptId) || {}) }));
      // Forget details of prompts that are no longer open.
      const open = new Set(prompts.map((p) => p.promptId));
      for (const id of details.keys()) if (!open.has(id) && Date.now() - details.get(id).at > 60000) details.delete(id);
      hub.setServer({ starnet: 'online', prompts, runs: s.runs || [], queues: s.queues || [] });
    } catch (e) {
      hub.setServer({ starnet: 'offline' });
    } finally {
      refreshing = false;
      if (again) { again = false; setTimeout(refresh, 50); }
    }
  }

  function soon() { if (timer) return; timer = setTimeout(() => { timer = null; refresh(); }, 250); }

  const sub = client.subscribe((name, payload) => {
    if (name === 'permission.prompt' && payload && payload.promptId) {
      details.set(payload.promptId, {
        tool: payload.tool || 'tool', scope: payload.scope || '', argsSummary: String(payload.argsSummary || '').slice(0, 2000),
        agentId: payload.agentId || null, at: Date.now()
      });
    }
    if (FORWARD.test(name)) {
      hub.toDevices('event', { name, payload: slim(payload) });
      soon();
    }
  }, { onState: (st) => { log('starnet feed ' + st); if (st === 'online') soon(); else hub.setServer({ starnet: 'offline' }); } });

  refresh();
  const poll = setInterval(refresh, pollMs);
  if (poll.unref) poll.unref();
  return { refresh, stop() { clearInterval(poll); sub.stop(); } };
}

// Events can carry big tool outputs; devices only need the gist.
function slim(p) {
  if (!p || typeof p !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'string') out[k] = v.length > 500 ? v.slice(0, 500) + '…' : v;
    else if (typeof v === 'number' || typeof v === 'boolean' || v == null) out[k] = v;
  }
  return out;
}

module.exports = { startWatch, slim };
