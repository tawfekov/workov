'use strict';
// The approvals plugin's one-worker check uses ~/.wv-bin/wv-sessions.py (from the pipeline scripts). node tests/test_plugin_helpers.cjs
//   helper missing -> the check is skipped on purpose (nothing to enforce), the worker dispatch is allowed as before
//   helper reports a live worker -> a second worker is refused
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-helpers-'));
process.on('exit', () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ } });
let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail = 1; };

const pluginMjs = path.join(T, 'approvals.mjs');
fs.copyFileSync(path.join(ROOT, 'overlay', '.opencode', 'plugins', 'approvals.js'), pluginMjs);
function dispatch(helperBody) {
  const repo = path.join(T, 'repo' + Math.random().toString(36).slice(2, 7));
  const home = path.join(T, 'home' + Math.random().toString(36).slice(2, 7));
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, '.wv-bin'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.writeFileSync(path.join(repo, '.wv-router'), '');
  if (helperBody !== null) fs.writeFileSync(path.join(home, '.wv-bin', 'wv-sessions.py'), helperBody);
  const env = { ...process.env, HOME: home, USERPROFILE: home, WV_APPROVALS: 'auto-safe', WV_POLICY: 'off', EVENT_ACTION: 'subagent' };
  const r = spawnSync(process.execPath, [path.join(__dirname, 'policy-plugin-runner.mjs'), pluginMjs, JSON.stringify(['worker'])], { cwd: repo, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('runner failed: ' + r.stderr);
  return JSON.parse(r.stdout.trim().split(String.fromCharCode(10)).pop())[0].effect;
}
ok(dispatch(null) === 'allow', 'no wv-sessions.py installed: the worker dispatch is allowed (the check is skipped, nothing breaks)');
ok(dispatch('import sys' + String.fromCharCode(10) + 'sys.exit(1)') === 'allow', 'the helper exits 1 (no live worker): dispatch allowed');
ok(dispatch('print("1" + chr(9) + "009")') === 'deny', 'the helper reports a live worker: a second worker is refused');

if (fail) { console.log('plugin helper tests FAILED'); process.exit(1); }
console.log('plugin helper tests OK');
