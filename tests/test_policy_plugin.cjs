'use strict';
// The approvals plugin with the command policy engine wired in: node tests/test_policy_plugin.cjs
//   off / warn : the decisions are exactly the current ones; warn also writes job/policy-warn.jsonl where the engine differs
//   enforce    : the engine decides (and nothing the old rules denied is let through)
//   no engine  : files missing -> the old rules decide alone, nothing breaks
// Runs in a temp git repo with HOME pointed at a temp folder. WV_APPROVALS=auto means "ask" becomes "allow" (no waiting on an owner).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-policy-plugin-'));
process.on('exit', () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ } });
let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail = 1; };

function makeRepo(name, withEngine) {
  const dir = path.join(T, name);
  fs.mkdirSync(path.join(dir, '.claude', 'scripts'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  if (withEngine) for (const f of ['wv-policy.cjs', 'policy.json']) fs.copyFileSync(path.join(ROOT, 'overlay', '.claude', 'scripts', f), path.join(dir, '.claude', 'scripts', f));
  return dir;
}
const pluginMjs = path.join(T, 'approvals.mjs');
fs.copyFileSync(path.join(ROOT, 'overlay', '.opencode', 'plugins', 'approvals.js'), pluginMjs);
const home = path.join(T, 'home'); fs.mkdirSync(home);

function run(repo, mode, commands) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, WV_APPROVALS: 'auto' };
  delete env.WV_POLICY;
  if (mode) env.WV_POLICY = mode;
  const r = spawnSync(process.execPath, [path.join(__dirname, 'policy-plugin-runner.mjs'), pluginMjs, JSON.stringify(commands)], { cwd: repo, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('runner failed: ' + r.stderr);
  return JSON.parse(r.stdout.trim().split(String.fromCharCode(10)).pop());
}
const CMDS = ['git status', 'git -C x push', 'curl http://localhost.evil.com', 'git status; git push', 'ls'];
const effects = (rows) => rows.map((r) => r.effect).join(',');
const warnLog = (repo) => { try { return fs.readFileSync(path.join(repo, 'job', 'policy-warn.jsonl'), 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// no engine files: the old rules decide ("ask" -> allow in auto mode, push -> deny)
const bare = makeRepo('bare', false);
const old = effects(run(bare, 'enforce', CMDS));
ok(old === 'allow,allow,allow,deny,allow', 'no engine files: the old rules decide alone (' + old + ')');

// off: same as the old rules, no log
const off = makeRepo('off', true);
ok(effects(run(off, 'off', CMDS)) === old && warnLog(off).length === 0, 'off: old decisions, nothing logged');

// warn (the default, no WV_POLICY set): old decisions, differences logged
const warn = makeRepo('warn', true);
const w = effects(run(warn, undefined, CMDS));
ok(w === old, 'warn (default): decisions unchanged, nothing is enforced (' + w + ')');
const log = warnLog(warn);
const pushLine = log.find((l) => l.command.includes('-C x push'));
ok(pushLine && pushLine.current === 'ask' && pushLine.engine === 'deny', 'warn: logs that the engine would deny "git -C x push" (current policy: ask)');
ok(log.some((l) => l.command.includes('localhost.evil.com') && l.engine === 'deny'), 'warn: logs the look-alike host as a would-deny');
ok(!log.some((l) => l.command === 'git status'), 'warn: no line when both agree');

// enforce: the engine decides
const enf = makeRepo('enforce', true);
const e = effects(run(enf, 'enforce', CMDS));
ok(e === 'allow,deny,deny,deny,allow', 'enforce: "git -C x push" and the look-alike host are denied (' + e + ')');

if (fail) { console.log('policy plugin tests FAILED'); process.exit(1); }
console.log('policy plugin tests OK');
