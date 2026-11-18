// approvals.js — OpenCode plugin: decide each permission request by policy, and send the
// uncertain ones to the Fleet Control dashboard (Allow / Deny) and to the phone (notify.sh).
// Requests are files in <main checkout>/job/permissions/<id>.json; the dashboard writes the decision.
// Policy: read-only and in-worktree work is allowed, dangerous commands are denied, the rest asks.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

let define = (x) => x;
try {
  ({ Plugin: { define } } = await import('@opencode/plugin'));
} catch {
  /* older runtimes accept the plain object */
}

const WAIT_MS = 15 * 60 * 1000;
const ALLOW_ACTIONS = new Set(['read', 'glob', 'grep', 'list', 'edit', 'todowrite', 'todoread', 'subagent', 'skill']);
const DENY_SHELL = [
  /\bgit\s+push\b/i, // only the merger pushes, through land.cjs
  /--force\b|\s-f\s.*\bpush\b/i,
  /\bgit\s+reset\s+--hard\s+(origin|main)\b/i,
  /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\.\.|[A-Za-z]:\\)/i,
  // a worktree holds the ticket's uncommitted work: only the reap scripts (which salvage first) may remove one, never a raw command
  /\bgit\s+worktree\s+(remove|prune)\b/i,
  /\b(rm\s+-[a-z]*r[a-z]*|rmdir\s+\/s|Remove-Item\b.*-Recurse)\b.*-\d{3}-/i,
  /\b(curl|wget|Invoke-WebRequest)\b(?!.*\b(localhost|127\.0\.0\.1)\b)/i,
  /\b(npm|pnpm|yarn)\s+(add|install|i)\b\s+\S/i, // new dependencies need the owner
];
const ALLOW_SHELL = [
  /^\s*(git\s+(status|diff|log|show|add|commit|branch|switch|checkout|rev-parse|worktree\s+list|stash|restore|merge-base|ls-files|blame)\b)/i,
  /^\s*node\s+(node_modules\/|\.claude\/scripts\/|eslint\.|--check\b)/i,
  /^\s*(npx|pnpm|npm)\s+(run|test|exec|ng|prettier|eslint|playwright|vitest|tsc)\b/i,
  /^\s*(python3?|bash)\s+\.claude\/scripts\//i,
  /^\s*(ls|cat|head|tail|wc|grep|rg|find|pwd|echo|date|mkdir|cp|mv|touch|sed\s+-n|diff|sort|uniq|which|test)\b/i,
  /^\s*(Get-Command|Test-Path|Get-ChildItem|Get-Content|Get-Location|Select-String|where(\.exe)?|command\s+-v|type)\b/i, // read-only lookups
  /^\s*curl\s+-s\s+http:\/\/(localhost|127\.0\.0\.1)/i,
];

function mainRoot(cwd) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', windowsHide: true }).trim();
    return path.dirname(common);
  } catch {
    return cwd;
  }
}

function policy(action, resources) {
  if (ALLOW_ACTIONS.has(action)) return 'allow';
  if (action === 'shell' || action === 'bash') {
    const cmds = resources.length ? resources : [''];
    if (cmds.some((c) => DENY_SHELL.some((r) => r.test(c)))) return 'deny';
    if (cmds.every((c) => ALLOW_SHELL.some((r) => r.test(c)))) return 'allow';
  }
  return 'ask';
}

async function askOwner(root, event) {
  const dir = path.join(root, 'job', 'permissions');
  fs.mkdirSync(dir, { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const file = path.join(dir, `${id}.json`);
  const resources = (event.resources || []).map(String);
  fs.writeFileSync(file, JSON.stringify({ id, status: 'pending', agent: event.agent || null, action: event.action, resources, cwd: process.cwd(), createdAt: new Date().toISOString() }, null, 2));
  const summary = `${event.agent || 'agent'} wants ${event.action}: ${resources.join(' | ').slice(0, 160)}`.replace(/'/g, '');
  try {
    if (fs.existsSync(path.join(root, '.claude', 'scripts', 'notify.sh'))) {
      spawn('bash', ['.claude/scripts/notify.sh', 'needs_human', `Permission needed: ${summary}`], { cwd: root, stdio: 'ignore', windowsHide: true }).unref();
    }
  } catch {
    /* the dashboard is the fallback channel */
  }
  for (const end = Date.now() + WAIT_MS; Date.now() < end; ) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d.status === 'allow' || d.status === 'deny') return d.status;
    } catch {
      /* keep waiting */
    }
  }
  fs.writeFileSync(file, JSON.stringify({ id, status: 'expired', action: event.action, resources }, null, 2));
  return 'deny';
}

export default define({
  id: 'wv-approvals',
  async setup(ctx) {
    const root = mainRoot(process.cwd());
    // Active in a workov repo, or when a headless /task run starts the provider (WV_APPROVALS=1, or =auto to allow
    // everything that is not denied). The one router's neutral folder carries a .wv-router marker (router-loop.sh puts it there with
    // this plugin), so its workers are covered however the OpenCode service was started. Ordinary OpenCode sessions elsewhere are untouched.
    const mode = process.env.WV_APPROVALS || (fs.existsSync(path.join(root, '.wv-router')) ? 'auto' : '') || (fs.existsSync(path.join(root, 'specs', 'workov.config.json')) ? '1' : '');
    if (!mode) return;
    await ctx.permission.hook('evaluate', async (event) => {
      // One worker per ticket, one worker on the computer, enforced where the worker is spawned: a router that dispatches again
      // (it has no memory between cycles) is refused while a worker session is live (wv-sessions.py live exits 0).
      if (String(event.action || '') === 'subagent') {
        const what = (event.resources || []).map(String).join(' ');
        try { fs.appendFileSync(path.join(root, 'job', 'subagent-seen.log'), JSON.stringify({ at: new Date().toISOString(), agent: event.agent || null, resources: what.slice(0, 200) }) + '
'); } catch { /* best effort */ }
        if (/(worker|teammate|implementer)/i.test(what)) {
          try {
            const py = process.platform === 'win32' ? 'python3' : 'python3';
            const live = execFileSync(py, ['-I', path.join(os.homedir(), '.wv-bin', 'wv-sessions.py'), 'live'], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
            if (live) {
              event.effect = 'deny';
              event.message = 'A worker is already running (' + live.split('
')[0].replace(/	/g, ' ').slice(0, 120) + '). Do not dispatch another: adopt it, set the board row to in-progress, record it in the ledger, and wait.';
              return;
            }
          } catch { /* exit 1 = no live worker: dispatch allowed */ }
        }
      }
      const verdict = policy(String(event.action || ''), (event.resources || []).map(String));
      if (verdict === 'ask' && mode === 'auto') { event.effect = 'allow'; return; }
      if (verdict !== 'ask') {
        event.effect = verdict;
        if (verdict === 'deny') event.message = 'Denied by the Workov policy (push, force, deletes outside the worktree, outside network, new dependencies).';
        return;
      }
      const decision = await askOwner(root, event);
      event.effect = decision;
      if (decision === 'deny') event.message = 'The owner denied this, or did not answer within 15 minutes.';
    });
  },
});
