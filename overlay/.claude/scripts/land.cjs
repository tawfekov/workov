#!/usr/bin/env node
// land.cjs — token-free delivery for Workov tickets: a pull request (GitHub, through `gh`) or a merge request (GitLab,
// through the REST API with the token from `glab`), chosen from the origin remote (override: profile "provider").
//   node .claude/scripts/land.cjs land <NNN> <branch> [--dry-run]
//   node .claude/scripts/land.cjs deliver <NNN> <branch> [--dry-run]
//   node .claude/scripts/land.cjs status <branch>          -> prints opened | merged | closed | none
// Optional delivery pack in specs/tickets/NNN-*/delivery/: mr-title.txt, mr.md (screenshots as
// ![caption](screens/NN-name.png)), tracker.md, screens/*.png. Without it, the title comes from rd.md's first
// heading and the body from results.md. rd.md may carry "**Tracker:** <id>": handed to the optional tracker hook.
// Settings (all optional) come from ~/.claude/workov-profile.json (see profile.example.json): reviewers, provider and
// "trackerHook": a command run after a delivery with WV_TICKET, WV_TRACKER, WV_PR_URL, WV_TITLE and WV_NOTE in its
// environment. Empty by default: nothing outside the PR / MR is ever touched.
// The GitLab token comes from `glab config get token --host <host>`; GitHub auth is gh's own. Nothing secret is printed.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Per-person settings: ~/.claude/workov-profile.json (see profile.example.json); every field is optional.
const PROFILE = (() => {
  const file = process.env.WORKOV_PROFILE || path.join(require('node:os').homedir(), '.claude', 'workov-profile.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
})();
const ME = { gitlab: PROFILE.gitlabUserId || null, github: PROFILE.githubLogin || null };
const REVIEWER = (kind) => {
  const today = new Date().toISOString().slice(0, 10);
  const r = (PROFILE.reviewers || []).find((x) => !x.until || today <= x.until);
  return r ? (kind === 'github' ? r.githubLogin || null : r.gitlabUserId || null) : null;
};
const [mode, a1, a2] = process.argv.slice(2);
const DRY = process.argv.includes('--dry-run');

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
function env(name) {
  if (process.env[name]) return process.env[name];
  if (process.platform !== 'win32') return '';
  try {
    return sh('powershell', ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('${name}','User')`]);
  } catch {
    return '';
  }
}
function provider() {
  if (PROFILE.provider === 'github' || PROFILE.provider === 'gitlab') return PROFILE.provider;
  const m = /^(?:git@([^:]+):|https?:\/\/(?:[^@/]+@)?([^/]+)\/)/.exec(sh('git', ['remote', 'get-url', 'origin']));
  return (m && (m[1] || m[2]) || '').toLowerCase() === 'github.com' ? 'github' : 'gitlab';
}
// GitHub: the pull request of a branch through gh. Returns { state: opened|merged|closed, number, url } or null.
function ghPr(branch) {
  let list;
  try { list = JSON.parse(sh('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,url', '--limit', '5'])); } catch { return null; }
  const pr = list.find((p) => p.state === 'OPEN') || list[0];
  return pr ? { state: ({ OPEN: 'opened', MERGED: 'merged', CLOSED: 'closed' })[pr.state] || 'closed', number: pr.number, url: pr.url } : null;
}
function gitlab() {
  const url = sh('git', ['remote', 'get-url', 'origin']);
  const m = /^(?:git@([^:]+):|https?:\/\/(?:[^@/]+@)?([^/]+)\/)(.+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error('cannot parse origin remote');
  const host = m[1] || m[2];
  const token = sh('glab', ['config', 'get', 'token', '--host', host]);
  if (!token) throw new Error(`no glab token for ${host}`);
  return { api: `https://${host}/api/v4/projects/${encodeURIComponent(m[3])}`, token };
}
async function req(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${url.replace(/\?.*/, '')} -> ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}
const json = (method, headers, body) => ({ method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const log = (...a) => console.log(...a);
const write = async (label, fn) => (DRY ? log('[dry-run]', label) : (await fn(), log('ok', label)));

async function mrFor(gl, branch) {
  const list = await req(`${gl.api}/merge_requests?source_branch=${encodeURIComponent(branch)}&order_by=updated_at`, { headers: { 'PRIVATE-TOKEN': gl.token } });
  return list.find((m) => m.state === 'opened') || list[0] || null;
}

function ticket(nnn) {
  const dir = fs.readdirSync('specs/tickets').find((d) => d.startsWith(`${nnn}-`));
  if (!dir) throw new Error(`ticket ${nnn} not found in specs/tickets`);
  const root = path.join('specs/tickets', dir);
  // The delivery pack is not committed: look in the main checkout, then in the worker worktrees.
  const packs = [root, ...(fs.existsSync('.claude/worktrees') ? fs.readdirSync('.claude/worktrees').map((w) => path.join('.claude/worktrees', w, root)) : [])];
  const packRoot = packs.find((r) => fs.existsSync(path.join(r, 'delivery'))) || root;
  const read = (f) => {
    const base = f.startsWith('delivery/') ? packRoot : root;
    return fs.existsSync(path.join(base, f)) ? fs.readFileSync(path.join(base, f), 'utf8') : '';
  };
  const rd = read('rd.md');
  const trackerId = ((/\*\*Tracker:\*\*\s*(\S+)/.exec(rd) || [])[1] || '').replace(/^none$/i, '');
  return {
    root, packRoot, screenDir: path.join(packRoot, 'delivery'), tracker_id: trackerId, ticketDir: `${TICKETS}/${dir}`,
    title: read('delivery/mr-title.txt').trim() || `feat: ${((/^#\s+(.+)$/m.exec(rd) || [])[1] || dir).trim()}`,
    body: read('delivery/mr.md') || read('results.md') || `Ticket ${dir}.`,
    tracker: read('delivery/tracker.md').trim() || `Delivered ticket ${dir}.`,
    screens: fs.existsSync(path.join(packRoot, 'delivery/screens')) ? fs.readdirSync(path.join(packRoot, 'delivery/screens')).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort() : [],
  };
}

async function uploadScreens(gl, t, body) {
  for (const f of t.screens) {
    const ref = `screens/${f}`;
    if (!body.includes(ref)) continue;
    if (DRY) { log('[dry-run] upload', ref); continue; }
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(path.join(t.screenDir, ref))]), f);
    const up = await req(`${gl.api}/uploads`, { method: 'POST', headers: { 'PRIVATE-TOKEN': gl.token }, body: form });
    body = body.split(ref).join(up.url);
    log('ok upload', f);
  }
  return body;
}

// Optional, empty by default: a command from the profile ("trackerHook") that mirrors a delivery into an external task
// tracker. It gets the ticket, the tracker id from rd.md ("**Tracker:** <id>"), the PR / MR url, the title and the
// tracker.md note in its environment, and runs once after the PR / MR is ready. Nothing is called when it is not set.
async function trackerHook(t, url, title) {
  const cmd = String(PROFILE.trackerHook || '').trim();
  if (!cmd) return;
  await write(`tracker hook: ${cmd.split(/\s+/)[0]}`, async () => {
    execFileSync(process.platform === 'win32' ? 'bash' : 'sh', ['-c', cmd], { stdio: 'inherit', windowsHide: true, env: { ...process.env,
      WV_TICKET: t.ticketDir ? path.basename(t.ticketDir) : '', WV_TRACKER: t.tracker_id || '', WV_PR_URL: url, WV_TITLE: title, WV_NOTE: t.tracker || '' } });
  });
}

// A headless delivery pack (.delivery/<task>/, from a headless /task run): same shape as a ticket's delivery folder.
function pack(dir, trackerId) {
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  const sdir = path.join(dir, 'screens');
  return {
    root: dir, screenDir: dir, tracker_id: trackerId || '',
    title: read('mr-title.txt').trim(), body: read('mr.md'), tracker: read('tracker.md').trim(),
    screens: fs.existsSync(sdir) ? fs.readdirSync(sdir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort() : [],
  };
}

// Fleet tickets (specs/tickets/) stay local, except each ticket's evidence/ folder, which the MR carries as proof of
// the checks: the branch that reaches the remote is the local branch replayed with every other specs/tickets change
// undone (rd.md, eval.md, results, delivery packs). Commits left empty are dropped; every other commit keeps its
// message, author and dates, so the replay is deterministic and a re-land after rework is a fast-forward.
const TICKETS = 'specs/tickets';
function shEnv(env, cmd, args, input) {
  return execFileSync(cmd, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } }).trim();
}
function withoutTickets(branch, ticketDir) {
  // Only this ticket's evidence/ folder is kept; another ticket's evidence that a branch carries along is undone too.
  const isEvidence = (p) => Boolean(ticketDir) && p.startsWith(`${ticketDir}/evidence/`);
  sh('git', ['fetch', '-q', 'origin', 'main']);
  const base = sh('git', ['merge-base', branch, 'origin/main']);
  let baseTickets = true;
  try { sh('git', ['cat-file', '-e', `${base}:${TICKETS}`]); } catch { baseTickets = false; }
  const commits = sh('git', ['rev-list', '--reverse', '--parents', `${base}..${branch}`]).split(String.fromCharCode(10)).filter(Boolean);
  const idx = path.join(require('node:os').tmpdir(), `wv-land-${process.pid}.idx`);
  const I = { GIT_INDEX_FILE: idx };
  let parent = base;
  let parentTree = sh('git', ['rev-parse', `${base}^{tree}`]);
  let changed = false; // a branch with nothing to strip is pushed as it is: replayed commits would get new hashes
  try {
    for (const line of commits) {
      const [c, ...ps] = line.split(' ');
      if (ps.length > 1) throw new Error(`merge commit ${c} on ${branch}: rebase the branch first`);
      shEnv(I, 'git', ['read-tree', c]);
      // Undo every non-evidence ticket path: drop it, then put back the base's version where the base has one.
      const NL = String.fromCharCode(10), TAB = String.fromCharCode(9);
      const own = shEnv(I, 'git', ['ls-files', '--', TICKETS]).split(NL).filter((p) => p && !isEvidence(p));
      const kept = baseTickets
        ? sh('git', ['ls-tree', '-r', base, '--', TICKETS]).split(NL).filter(Boolean)
            .map((l) => l.split(TAB)).filter(([, p]) => !isEvidence(p)).map(([m, p]) => { const [mode, , sha] = m.split(' '); return `${mode} ${sha}${TAB}${p}`; })
        : [];
      const info = own.map((p) => `0 ${'0'.repeat(40)}${TAB}${p}`).concat(kept);
      if (info.length) shEnv(I, 'git', ['update-index', '--index-info'], info.join(NL) + NL);
      const tree = shEnv(I, 'git', ['write-tree']);
      if (tree !== sh('git', ['rev-parse', `${c}^{tree}`])) changed = true;
      if (tree === parentTree) { changed = true; continue; }
      const [an, ae, ad, cn, ce, cd] = sh('git', ['log', '-1', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', c]).split(String.fromCharCode(0));
      const id = { GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad, GIT_COMMITTER_NAME: cn, GIT_COMMITTER_EMAIL: ce, GIT_COMMITTER_DATE: cd };
      parent = shEnv(id, 'git', ['commit-tree', tree, '-p', parent, '-F', '-'], sh('git', ['log', '-1', '--format=%B', c]) + String.fromCharCode(10));
      parentTree = tree;
    }
  } finally {
    try { fs.unlinkSync(idx); } catch {}
  }
  if (!changed) return sh('git', ['rev-parse', branch]);
  if (parent === base) throw new Error(`${branch} has no changes besides local ticket files`);
  return parent;
}

// The MR description is for the reviewer: only what they need, short and clear. Caps: Summary 3 bullets, Implementation 5,
// Notes 4 (only important notes), each bullet one line (160 characters), the whole text 30 lines without Screenshots, and
// no sections other than Summary / Implementation / Screenshots / Notes.
function mrBodyProblems(body) {
  const problems = [];
  const caps = { Summary: 3, Implementation: 5, Notes: 4 };
  const parts = String(body || '').replace(/\r\n/g, '\n').split(/^## /m).slice(1);
  let lines = 0;
  for (const part of parts) {
    const name = part.split('\n')[0].trim();
    const rest = part.split('\n').slice(1).filter((l) => l.trim());
    if (!['Summary', 'Implementation', 'Screenshots', 'Notes'].includes(name)) problems.push(`section "${name}" is not allowed`);
    if (name === 'Screenshots') continue;
    lines += rest.length + 1;
    const bullets = rest.filter((l) => /^\s*[-*] /.test(l));
    if (caps[name] && bullets.length > caps[name]) problems.push(`${name} has ${bullets.length} bullets (max ${caps[name]})`);
    for (const l of rest) if (l.length > 160) { problems.push(`a line in ${name} is ${l.length} characters (max 160)`); break; }
  }
  if (lines > 30) problems.push(`the description is ${lines} lines without screenshots (max 30)`);
  for (const need of ['Summary', 'Implementation']) if (!parts.some((x) => x.startsWith(need))) problems.push(`the ${need} section is missing`);
  return problems;
}

// GitHub: open or update the pull request of the branch with gh (draft until the owner delivers). Screenshots are not
// uploaded (gh has no upload): the evidence/ folder the branch carries is the proof; relative screens/ links are removed.
async function openPr(t, branch, draft) {
  const body = t.screens.reduce((b, f) => b.split(`screens/${f}`).join(`${PROFILE.screenshotBase || 'evidence'}/${f}`), t.body);
  const title = t.title.replace(/^(draft:\s*)+/i, '');
  const reviewer = REVIEWER('github');
  const pr = ghPr(branch);
  if (pr && pr.state === 'opened') {
    await write(`update PR #${pr.number}${draft ? ' (draft)' : ' (ready)'}`, () => {
      sh('gh', ['pr', 'edit', String(pr.number), '--title', title, '--body', body]);
      if (!draft) sh('gh', ['pr', 'ready', String(pr.number)]);
    });
    return pr.url;
  }
  let url = '(dry-run PR url)';
  await write(`create PR${draft ? ' (draft)' : ''}`, async () => {
    const args = ['pr', 'create', '--head', branch, '--title', title, '--body', body];
    if (draft) args.push('--draft');
    if (reviewer) args.push('--reviewer', reviewer);
    url = sh('gh', args).split(/\s+/).filter((x) => /^https?:/.test(x)).pop() || url;
  });
  return url;
}

// Push and open or update the MR. draft=true (the fleet's merger): nothing is marked delivered yet;
// Claude's review then runs `deliver`, which marks it ready and runs the optional tracker hook.
async function openMr(t, branch, draft) {
  if (!t.title || !t.body) throw new Error('the delivery pack has no mr-title.txt or mr.md');
  const mrProblems = mrBodyProblems(t.body);
    if (mrProblems.length) {
      const msg = 'the MR description is too long or off-format: ' + mrProblems.join('; ');
      if (!draft) throw new Error(msg + '. Shorten delivery/mr.md and deliver again.');
      log('WARN ' + msg);
    }
  const github = provider() === 'github';
  const gl = github ? null : gitlab();
  const sha = withoutTickets(branch, t.ticketDir);
  await write(`git push origin ${branch} (${sha.slice(0, 8)}, local ticket files removed, evidence kept)`, () => sh('git', ['push', 'origin', `${sha}:refs/heads/${branch}`]));
  if (github) return openPr(t, branch, draft);
  const body = await uploadScreens(gl, t, t.body);
  const reviewer = REVIEWER('gitlab');
  // Some GitLab servers ignore the API's `draft` field: the "Draft: " title prefix is what makes an MR a draft.
  const title = `${draft ? 'Draft: ' : ''}${t.title.replace(/^(draft:s*)+/i, '')}`;
  const fields = { title, description: body, reviewer_ids: reviewer ? [reviewer] : [], remove_source_branch: false };
  if (ME.gitlab) fields.assignee_ids = [ME.gitlab];
  let mr = await mrFor(gl, branch);
  if (mr && mr.state === 'opened') {
    await write(`update MR !${mr.iid}${draft ? ' (draft)' : ' (ready)'}`, async () => (mr = await req(`${gl.api}/merge_requests/${mr.iid}`, json('PUT', { 'PRIVATE-TOKEN': gl.token }, { ...fields, draft }))));
  } else {
    await write(`create MR${draft ? ' (draft)' : ''}`, async () => (mr = await req(`${gl.api}/merge_requests`, json('POST', { 'PRIVATE-TOKEN': gl.token }, { ...fields, draft, source_branch: branch, target_branch: 'main' }))));
  }
  return mr?.web_url || '(dry-run MR url)';
}

async function land(nnn, branch) {
  const url = await openMr(ticket(nnn), branch, true);
  log(`MR_URL ${url}`);
}

// A delivered ticket is handed over (PR / MR ready, tracker hook run): the fleet has nothing left to track, so
// its board row becomes done instead of staying in-progress or in-review until someone merges.
function markDone(nnn) {
  const file = 'specs/tickets/BOARD.md';
  if (!nnn || !fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  const row = /^(\|\s*)(\d{3})(\s*\|[^|]*\|\s*)(in-progress|in-review|blocked|ready|draft)(\s*\|)/gm;
  const next = text.replace(row, (m, a, n, b, status, c) => (n === nnn ? `${a}${n}${b}done${' '.repeat(Math.max(0, status.length - 4))}${c}` : m));
  if (next !== text) write(`board ${nnn} -> done`, async () => fs.writeFileSync(file, next));
}

async function deliver(t, branch) {
  const url = await openMr(t, branch, false);
  await trackerHook(t, url, t.title);
  if (t.ticketDir) markDone(path.basename(t.ticketDir).slice(0, 3));
  log(`MR_URL ${url}`);
}

(async () => {
  const opt = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  if (mode === 'land' && a1 && a2) return land(a1, a2);
  if (mode === 'deliver' && a1 && /^\d+$/.test(a1) && a2) return deliver(ticket(a1), a2);
  if (mode === 'deliver' && a1 && opt('--pack')) return deliver(pack(opt('--pack'), opt('--tracker')), a1);
  if (mode === 'status' && a1) {
    if (provider() === 'github') { const pr = ghPr(a1); return log(pr ? pr.state : 'none'); }
    const mr = await mrFor(gitlab(), a1);
    return log(mr ? mr.state : 'none');
  }
  console.error([
    'usage: land.cjs land <NNN> <branch>                         (fleet merger: push + draft PR / MR)',
    '       land.cjs deliver <NNN> <branch>                      (after review: PR / MR ready, tracker hook)',
    '       land.cjs deliver <branch> --pack <dir> [--tracker <id>]  (headless delivery pack)',
    '       land.cjs status <branch>',
    '       add --dry-run to print the writes without doing them',
  ].join('\n'));
  process.exit(2);
})().catch((e) => {
  console.error(`wv-land: ${e.message}`);
  process.exit(1);
});
