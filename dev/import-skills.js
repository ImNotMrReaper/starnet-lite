#!/usr/bin/env node
// Import SKILL.md folders (Claude Code / Codex / Hermes / shared) into StarNet as Open Agent Skill packages.
//   node dev/import-skills.js --dry <dir>...      inspect only (StarNet's guard scans each package)
//   node dev/import-skills.js --install <dir>...  inspect + install for agent "agent" when the guard allows it
// Each <dir> is a folder of skill folders (or a skill folder itself). Only SKILL.md and the four Open Agent Skills
// folders (references/ templates/ scripts/ assets/) are packaged; anything else is skipped and reported.
'use strict';
const fs = require('fs');
const path = require('path');
const { createClient } = require('../lib/starnet');

const ALLOWED = new Set(['references', 'templates', 'scripts', 'assets']);
const args = process.argv.slice(2);
const install = args.includes('--install');
const roots = args.filter((a) => !a.startsWith('--'));
const client = createClient({ host: '127.0.0.1', port: Number(process.env.STARNET_PORT || 8786) });
const agentId = process.env.AGENT || 'agent';

function skillDirs(root) {
  if (fs.existsSync(path.join(root, 'SKILL.md'))) return [root];
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'synced' || e.name.startsWith('.')) continue;
    out.push(...skillDirs(path.join(root, e.name)));
  }
  return out;
}

function packageOf(dir) {
  const files = [{ path: 'SKILL.md', encoding: 'base64', content: fs.readFileSync(path.join(dir, 'SKILL.md')).toString('base64') }];
  const skipped = [];
  (function walk(rel) {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (r === 'SKILL.md') continue;
      const top = r.split('/')[0];
      if (e.isDirectory()) { if (ALLOWED.has(top)) walk(r); else skipped.push(r + '/'); continue; }
      if (!ALLOWED.has(top) || !rel) { skipped.push(r); continue; }
      const buf = fs.readFileSync(path.join(dir, r));
      if (buf.length > 256000) { skipped.push(r + ' (too big)'); continue; }
      files.push({ path: r, encoding: 'base64', content: buf.toString('base64') });
    }
  })('');
  return { envelope: { format: 'open-agent-skill-package/v1', files: files.slice(0, 64), metadata: { category: path.basename(path.dirname(dir)) } }, skipped };
}

(async () => {
  const dirs = [...new Set(roots.flatMap(skillDirs))];
  const seen = new Set();
  const report = [];
  for (const dir of dirs) {
    const name = path.basename(dir);
    if (seen.has(name)) { report.push({ name, result: 'duplicate name, skipped', dir }); continue; }
    seen.add(name);
    const { envelope, skipped } = packageOf(dir);
    const r = await client.api('POST', '/api/skill-exchange/import', { envelope });
    if (!r.ok || r.status !== 200 || !r.json || r.json.ok === false) { report.push({ name, result: 'import refused: ' + ((r.json && r.json.error) || r.status), dir }); continue; }
    const p = r.json.preview || r.json;
    const row = { name, guard: p.guardAction, verdict: p.scan && p.scan.verdict, files: (p.files || []).length, skipped: skipped.length };
    if (install && p.guardAction !== 'block') {
      const i = await client.api('POST', '/api/skill-exchange/install', { agentId, inspectionId: p.inspectionId || p.id, sourceDigest: p.sourceDigest || p.digest });
      row.result = i.ok && i.status === 200 && i.json && i.json.ok !== false ? 'INSTALLED (' + i.json.action + ')' : 'install refused: ' + ((i.json && i.json.error) || i.status);
    } else row.result = install ? 'not installed (guard: ' + p.guardAction + ')' : 'inspected';
    report.push(row);
  }
  for (const r of report) console.log(JSON.stringify(r));
  const by = {}; for (const r of report) { const k = r.guard || r.result.split(':')[0]; by[k] = (by[k] || 0) + 1; }
  console.log('SUMMARY', JSON.stringify(by));
})();
