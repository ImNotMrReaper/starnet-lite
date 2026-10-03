// Dev rig: a throwaway StarNet station + a fake AI + Lite in front of it. Never touches a real station.
//   node dev/teststation.mjs            (STARNET_REPO=~/apps/starnet by default)
// Ports: fake AI 8941 · StarNet 8931 (scratch workspace) · Lite computer door 8932 · Lite device door 8933.
// The fake AI streams its reply slowly (so live typing can be watched) and, when the message contains WRITE,
// calls StarNet's file-write tool so StarNet raises a real approval request.
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.env.STARNET_REPO || join(homedir(), 'apps', 'starnet');
const seed = await import(pathToFileURL(join(REPO, 'scripts', 'lib', 'seed.mjs')).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fake = http.createServer((req, res) => {
  let raw = ''; req.on('data', (d) => { raw += d; });
  req.on('end', async () => {
    if (req.method !== 'POST') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, supported_parameters: ['tools'] }] })); }
    let body = {}; try { body = JSON.parse(raw); } catch {}
    const msgs = body.messages || [];
    const last = msgs[msgs.length - 1] || {};
    const userText = JSON.stringify(msgs.filter((m) => m.role === 'user').slice(-1));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    const tools = (body.tools || []).map((t) => t.function && t.function.name).filter(Boolean);
    const write = tools.find((n) => /fs[._]write/.test(n));
    if (/WRITE/.test(userText) && !msgs.some((m) => m.role === 'tool' || m.tool_calls) && write) {
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: write, arguments: JSON.stringify({ path: 'lite-approval-test.txt', content: 'written after approval from Lite' }) } }] } }] });
      chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
      res.end('data: [DONE]\n\n'); return;
    }
    const words = ('Hello from the fake model. I am typing this reply slowly so StarNet Lite can show it live, word by word, on your phone while the computer shows it too. ' +
      (last.role === 'tool' ? 'The tool finished: ' + String(last.content).slice(0, 80) : 'Done.')).split(' ');
    for (const w of words) { chunk({ choices: [{ delta: { content: w + ' ' } }] }); await sleep(180); }
    chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: words.length } });
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => fake.listen(8941, '127.0.0.1', r));

const scratch = mkdtempSync(join(tmpdir(), 'lite-station-'));
seed.materializeSeedWorkspace(scratch);
const base = 'http://127.0.0.1:8941';
const station = seed.bootSeededSidecar({ port: 8931, scratchDir: scratch, model: 'test/model', key: 'fixture', fullAccess: false,
  env: { SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base, SKYNET_CRON_ENABLED: '0', STARNET_CRON_ENABLED: '0' } });
if (!(await seed.waitUp('http://127.0.0.1:8931/'))) { console.error('test station did not start'); process.exit(1); }

process.env.STARNET = '127.0.0.1:8931';
const { createLite } = await import(pathToFileURL(join(process.cwd(), 'server.js')).href);
const lite = createLite({ log: (m) => console.log('[lite]', m) });
lite.local.listen(8932, '127.0.0.1');
lite.remote.listen(8933, '127.0.0.1');
console.log('ready: station 8931 · lite computer 8932 · lite device 8933 · scratch ' + scratch);
const bye = () => { try { station.kill('SIGTERM'); } catch {} lite.stop(); process.exit(0); };
process.on('SIGTERM', bye); process.on('SIGINT', bye);
