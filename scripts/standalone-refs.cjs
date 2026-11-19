'use strict';
// standalone-refs.cjs <dir> [--repo <git dir> --providers <ref pattern>] [--json]
// Static half of the "does this PR stand alone" check. Walks the scripts in <dir> (a checkout of one PR) and lists every file they call
// that the PR does not ship:
//   ~/.wv-bin/<name>          must exist as wv-bin/<name>
//   .claude/scripts/<name>    must exist as .claude/scripts/<name> or overlay/.claude/scripts/<name>
//   "$HERE/<path>" in install.sh must exist
// A missing file is GUARDED when its file has a line that tests the file exists and names it ([ -f ... ], existsSync, os.path.exists;
// a preflight loop over the names counts); a call with no such test fails silently or breaks. With --repo and --providers, each missing file is matched to the other PR branches that ship it.
// Exit code 1 when anything unguarded is missing. Lines that are comments are ignored.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2);
const dir = path.resolve(args[0] || '.');
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const repo = opt('--repo');
const providersPattern = opt('--providers');
const asJson = args.includes('--json');

const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', 'docs', 'tests', 'dist', 'dist-installer', 'images']);
function walk(d, out) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), out); } else if (/[.](sh|py|cjs|js|mjs)$/.test(e.name)) out.push(path.join(d, e.name));
  }
  return out;
}
const exists = (rel) => fs.existsSync(path.join(dir, rel));
const GUARD = /(\[\[? (! )?-[fde] |existsSync|is_file()|os[.]path[.]exists|[.]exists\(\))/;
const isComment = (l) => /^\s*(#|\/\/|\*|<!--)/.test(l);

// guarded = somewhere in the same file, a line tests that the file exists and names it (a preflight loop counts)
const guardCache = new Map();
function fileGuards(lines, name) {
  const key = lines.length + '|' + name + '|' + lines[0];
  if (!guardCache.has(key)) guardCache.set(key, lines.some((l) => !isComment(l) && GUARD.test(l) && l.includes(name.split('/').pop())));
  return guardCache.get(key);
}
const found = [];
for (const file of walk(dir, [])) {
  const rel = path.relative(dir, file).split(path.sep).join('/');
  if (fs.statSync(file).size > 1500000) continue;
  const lines = fs.readFileSync(file, 'utf8').split(String.fromCharCode(10));
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    const add = (kind, name, want) => found.push({ file: rel, line: i + 1, kind, ref: name, want, guarded: fileGuards(lines, name) });
    let m;
    const a = /[.]wv-bin\/([A-Za-z0-9_.-]+[.](?:py|sh|cmd|cjs|js))/g;
    while ((m = a.exec(line))) add('wv-bin', m[1], ['wv-bin/' + m[1]]);
    const b = /[.]wv-bin['"],\s*['"]([A-Za-z0-9_.-]+[.](?:py|sh|cmd|cjs|js))['"]/g;
    while ((m = b.exec(line))) add('wv-bin', m[1], ['wv-bin/' + m[1]]);
    const c = /[.]claude\/scripts\/([A-Za-z0-9_.-]+[.](?:py|sh|cjs|json|js))/g;
    while ((m = c.exec(line))) add('claude-scripts', m[1], ['.claude/scripts/' + m[1], 'overlay/.claude/scripts/' + m[1]]);
    if (rel === 'install.sh') {
      const d2 = /"[$]HERE\/([A-Za-z0-9_./-]+)"/g;
      while ((m = d2.exec(line))) if (!m[1].endsWith('/')) add('installer', m[1], [m[1]]);
    }
  });
}
// the same call on many lines is one finding per (file, ref)
const seen = new Map();
for (const f of found) {
  if (f.want.some(exists)) continue;
  const key = f.file + '|' + f.ref;
  const prev = seen.get(key);
  if (!prev) seen.set(key, { ...f, lines: [f.line], allGuarded: f.guarded });
  else { prev.lines.push(f.line); prev.allGuarded = prev.allGuarded && f.guarded; }
}
const missing = [...seen.values()].map((f) => ({ file: f.file, lines: f.lines.slice(0, 4), ref: f.ref, expected: f.want[0], guarded: f.allGuarded }));

// the patches install.sh lists but this PR does not ship are skipped on purpose; count them for information
let patchesAbsent = 0;
if (exists('install.sh')) {
  const m = /for p in ([^;]+); do/.exec(fs.readFileSync(path.join(dir, 'install.sh'), 'utf8'));
  if (m) patchesAbsent = m[1].trim().split(/\s+/).filter((n) => !exists('patches/' + n + '.cjs')).length;
}

// who ships each missing file?
const providers = {};
if (repo && providersPattern && missing.length) {
  let refs = [];
  try { refs = execFileSync('git', ['-C', repo, 'for-each-ref', '--format=%(refname:short)', providersPattern], { encoding: 'utf8' }).split(String.fromCharCode(10)).filter(Boolean); } catch { /* no providers */ }
  for (const r of refs) {
    let tree = [];
    try { tree = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', r], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split(String.fromCharCode(10)); } catch { continue; }
    const set = new Set(tree);
    for (const m of missing) if (set.has(m.expected) || set.has('overlay/' + m.expected)) (providers[m.expected] = providers[m.expected] || []).push(r.replace(/^.*[/]/, ''));
  }
}

const unguarded = missing.filter((m) => !m.guarded);
if (asJson) {
  process.stdout.write(JSON.stringify({ missing, unguarded: unguarded.length, patchesListedButAbsent: patchesAbsent, providers }, null, 2) + String.fromCharCode(10));
} else {
  const show = (title, list) => {
    if (!list.length) return;
    console.log(title + ' (' + list.length + '):');
    for (const m of list) {
      const who = providers[m.expected] ? '   <- shipped by ' + providers[m.expected].join(', ') : '';
      console.log('  ' + m.expected.padEnd(34) + ' called from ' + m.file + ':' + m.lines.join(',') + who);
    }
  };
  show('missing and NOT guarded: the call fails or does nothing silently', unguarded);
  show('missing but guarded: an existence test explains it', missing.filter((m) => m.guarded));
  if (patchesAbsent) console.log('install.sh lists ' + patchesAbsent + ' patches this PR does not ship; they are skipped on purpose, later PRs add them');
  if (!missing.length) console.log('every file the scripts call ships in this PR');
}
process.exit(unguarded.length ? 1 : 0);
