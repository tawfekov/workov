'use strict';
// Approvals mode, plugin side: node tests/test_approvals_plugin.cjs
// Order is WV_APPROVALS (ask | auto-safe | auto) > ~/.workov/settings.json > ask. "ng build" is something the policy neither allows nor
// denies, so it shows the mode: ask waits for the owner (reported as "waiting"), auto-safe lets it through. "git push" is always denied.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-approvals-'));
process.on('exit', () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ } });
let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail = 1; };

const pluginMjs = path.join(T, 'approvals.mjs');
fs.copyFileSync(path.join(ROOT, 'overlay', '.opencode', 'plugins', 'approvals.js'), pluginMjs);
let n = 0;
function scenario({ env, setting, marker = true }) {
  const repo = path.join(T, 'repo' + (++n));
  const home = path.join(T, 'home' + n);
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, '.workov'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  if (marker) fs.writeFileSync(path.join(repo, '.wv-router'), '');
  if (setting) fs.writeFileSync(path.join(home, '.workov', 'settings.json'), JSON.stringify({ approvals: { mode: setting } }));
  const e = { ...process.env, HOME: home, USERPROFILE: home, PEEK: '1', WV_POLICY: 'off' };
  delete e.WV_APPROVALS;
  if (env !== undefined) e.WV_APPROVALS = env;
  const r = spawnSync(process.execPath, [path.join(__dirname, 'policy-plugin-runner.mjs'), pluginMjs, JSON.stringify(['ng build', 'git push'])], { cwd: repo, env: e, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('runner failed: ' + r.stderr);
  const out = JSON.parse(r.stdout.trim().split(String.fromCharCode(10)).pop());
  if (out.inactive) return { inactive: true };
  return { build: out[0].state === 'waiting' ? 'waiting' : out[0].effect, push: out[1].effect };
}
const is = (got, build, push, msg) => ok(got.build === build && got.push === push, msg + '  (ng build: ' + got.build + ', git push: ' + got.push + ')');

is(scenario({}), 'waiting', 'deny', 'no setting, nothing set: the default is ask');
is(scenario({ setting: 'ask' }), 'waiting', 'deny', 'setting ask');
is(scenario({ setting: 'auto-safe' }), 'allow', 'deny', 'setting auto-safe: goes ahead, push is still denied');
is(scenario({ env: 'ask', setting: 'auto-safe' }), 'waiting', 'deny', 'WV_APPROVALS=ask beats the setting');
is(scenario({ env: 'auto-safe', setting: 'ask' }), 'allow', 'deny', 'WV_APPROVALS=auto-safe beats the setting');
is(scenario({ env: 'auto', setting: 'ask' }), 'allow', 'deny', 'the old WV_APPROVALS=auto still means auto-safe (nothing running changes)');
is(scenario({ env: '1', setting: 'auto-safe' }), 'allow', 'deny', 'WV_APPROVALS=1 only switches the plugin on: the setting decides');
is(scenario({ env: 'banana' }), 'waiting', 'deny', 'an unknown value falls back to ask, never to auto');
is(scenario({ setting: 'banana' }), 'waiting', 'deny', 'an unknown setting falls back to ask');
ok(scenario({ marker: false }).inactive === true, 'outside a fleet and without WV_APPROVALS the plugin stays off');

if (fail) { console.log('approvals plugin tests FAILED'); process.exit(1); }
console.log('approvals plugin tests OK');
