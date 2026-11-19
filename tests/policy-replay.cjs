'use strict';
// Replay real agent commands through the current policy and the new engine, side by side.
//   node tests/policy-replay.cjs <commands.jsonl | audit file> [--shell powershell|posix] [--strict-ops] [--list]
// The input has one JSON object per line with a "command" field (job/permissions/*.json style "resources" arrays work too).
// Nothing is enforced: this answers "what would change if the new engine decided?" before anyone turns it on.
const fs = require('node:fs');
const path = require('node:path');
const { evaluate, loadRules } = require('../overlay/.claude/scripts/wv-policy.cjs');
const { loadLegacy } = require('./lib-legacy.cjs');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && a !== args[args.indexOf('--shell') + 1]);
if (!file) { console.error('usage: node tests/policy-replay.cjs <commands.jsonl> [--shell powershell|posix] [--strict-ops] [--list]'); process.exit(2); }
const si = args.indexOf('--shell');
const shell = si >= 0 ? args[si + 1] : (process.platform === 'win32' ? 'powershell' : 'posix');
const rules = loadRules(path.join(__dirname, '..', 'overlay', '.claude', 'scripts', 'policy.json'));
if (args.includes('--strict-ops')) rules.operators = { allow: [] };
const legacy = loadLegacy(path.join(__dirname, '..', 'overlay', '.opencode', 'plugins', 'approvals.js'));

const cmds = [];
for (const line of fs.readFileSync(file, 'utf8').split(String.fromCharCode(10))) {
  if (!line.trim()) continue;
  let j; try { j = JSON.parse(line); } catch { continue; }
  if (typeof j.command === 'string') cmds.push(j.command);
  else if (Array.isArray(j.resources) && (j.action === 'shell' || j.action === 'bash')) cmds.push(j.resources.map(String).join(' '));
}
const matrix = {};
const rows = [];
for (const c of cmds) {
  const o = legacy(c);
  const n = evaluate(c, rules, { shell });
  const key = o + ' -> ' + n.verdict;
  matrix[key] = (matrix[key] || 0) + 1;
  rows.push({ c, o, n });
}
console.log('commands: ' + cmds.length + '   shell: ' + shell + '   operators allowed: ' + JSON.stringify(rules.operators.allow));
console.log('current -> new      count');
for (const k of Object.keys(matrix).sort()) console.log('  ' + k.padEnd(16) + String(matrix[k]).padStart(5));

const show = (title, list, f) => {
  console.log(String.fromCharCode(10) + title + ': ' + list.length);
  for (const r of list.slice(0, args.includes('--list') ? 1000 : 12)) console.log('  ' + f(r));
};
const cut = (s) => s.replace(/[\r\n]+/g, ' ').slice(0, 150);
show('NEW DENIES where the current policy did not deny (these would stop real work)', rows.filter((r) => r.n.verdict === 'deny' && r.o !== 'deny'),
  (r) => '[was ' + r.o + '] ' + cut(r.c) + '   <- ' + r.n.reasons.filter((x) => x.kind === 'deny').map((x) => x.rule).join(','));
show('LOOSER: the current policy denied, the new engine does not', rows.filter((r) => r.o === 'deny' && r.n.verdict !== 'deny'),
  (r) => '[now ' + r.n.verdict + '] ' + cut(r.c));
const newAsks = rows.filter((r) => r.o === 'allow' && r.n.verdict === 'ask');
show('NEW ASKS where the current policy allowed', newAsks, (r) => cut(r.c) + '   <- ' + r.n.reasons.filter((x) => x.kind === 'ask').map((x) => x.rule).join(','));
const why = {};
for (const r of rows.filter((x) => x.n.verdict === 'ask')) for (const x of r.n.reasons) if (x.kind === 'ask') why[x.rule] = (why[x.rule] || 0) + 1;
console.log(String.fromCharCode(10) + 'why the new engine asks (count of reasons): ' + JSON.stringify(why));
