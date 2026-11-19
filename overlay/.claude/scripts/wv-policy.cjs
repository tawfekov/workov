'use strict';
// wv-policy.cjs: decide whether a shell command is allowed, denied or must be asked about.
//
// The old policy matched the START of the whole command text, so `git status; git push`, `git -C x push` and
// `curl http://localhost.evil.com` got through. This engine splits the command into its parts first:
//   1. a small tokenizer (POSIX or PowerShell quoting) turns the text into segments, joined by ; && || | & newline;
//   2. every segment is normalised (env assignments, env/command/nohup wrappers, git/npm global flags such as
//      `git -C x push` -> push, `bash -c "..."` is looked into) and checked against policy.json on its own;
//   3. $( ), backticks, heredocs, unbalanced quotes and redirects to a file are never allowed silently: they ask.
// Result: { verdict: 'allow' | 'deny' | 'ask', reasons: [...] }. The rules live in policy.json next to this file.
// Pure, no dependencies. `node wv-policy.cjs --check "git -C x push"` prints the decision.
// (This file avoids the backslash character on purpose: scripts written through a shell lose backslashes.)
const fs = require('node:fs');
const path = require('node:path');

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const BS = String.fromCharCode(92);
const BQ = String.fromCharCode(96);

// ---------- tokenizer ----------
function parse(command, shell) {
  const ps = shell === 'powershell';
  const text = String(command == null ? '' : command);
  const n = text.length;
  const res = { segments: [], ops: new Set(), subst: false, unterminated: false, heredoc: false };
  let argv = [];
  let redirects = [];
  let cur = '';
  let inTok = false;
  let pending = null;
  let depth = 0; // PowerShell: ( { [ nesting; a line break inside them, or after a trailing comma, continues the command

  const endTok = () => {
    if (!inTok) return;
    if (pending) { pending.target = cur; redirects.push(pending); pending = null; } else argv.push(cur);
    cur = '';
    inTok = false;
  };
  const endSeg = (op) => {
    endTok();
    if (pending) { pending.target = ''; redirects.push(pending); pending = null; }
    if (argv.length || redirects.length) res.segments.push({ argv, redirects });
    argv = [];
    redirects = [];
    if (op) res.ops.add(op);
  };

  for (let i = 0; i < n; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "'") {
      inTok = true;
      const j = text.indexOf("'", i + 1);
      if (j < 0) { res.unterminated = true; cur += text.slice(i + 1); break; }
      cur += text.slice(i + 1, j);
      i = j;
      continue;
    }
    if (ch === '"') {
      inTok = true;
      let j = i + 1;
      let closed = false;
      for (; j < n; j++) {
        const c = text[j];
        if (c === '"') { closed = true; break; }
        if (ps && c === BQ && j + 1 < n) { cur += text[j + 1]; j++; continue; }
        if (!ps && c === BS && j + 1 < n && (text[j + 1] === '"' || text[j + 1] === BS || text[j + 1] === '$' || text[j + 1] === BQ)) { cur += text[j + 1]; j++; continue; }
        if (c === '$' && text[j + 1] === '(') res.subst = true;
        if (!ps && c === BQ) res.subst = true;
        cur += c;
      }
      if (!closed) res.unterminated = true;
      i = j;
      continue;
    }
    if (ch === ' ' || ch === TAB || ch === CR) { endTok(); continue; }
    if (ch === NL) {
      const last = inTok ? cur : (argv.length ? argv[argv.length - 1] : '');
      if (ps && (depth > 0 || last.endsWith(','))) { endTok(); continue; }
      endSeg('newline');
      continue;
    }
    if (ch === BS) {
      if (ps) { inTok = true; cur += BS; continue; }
      if (next === undefined) { inTok = true; cur += BS; continue; }
      if (next !== NL) { inTok = true; cur += next; }
      i++;
      continue;
    }
    if (ch === BQ) {
      if (ps) { inTok = true; if (next !== undefined) { cur += next; i++; } continue; }
      res.subst = true; inTok = true; cur += ch; continue;
    }
    if (ch === '$' && next === '(') { res.subst = true; inTok = true; cur += ch; continue; }
    if (ch === ';') { endSeg(';'); continue; }
    if (ch === '|') {
      if (next === '|') { i++; endSeg('||'); } else { if (next === '&') i++; endSeg('|'); }
      continue;
    }
    if (ch === '&') {
      if (next === '&') { i++; endSeg('&&'); continue; }
      if (ps && !inTok && argv.length === 0) continue; // PowerShell call operator: & "path" args
      endSeg('&');
      continue;
    }
    if (ch === '>' || ch === '<') {
      if (inTok && /^[0-9]+$/.test(cur)) { cur = ''; inTok = false; } else endTok();
      let op = ch;
      if (ch === '>' && next === '>') { op = '>>'; i++; }
      else if (ch === '<' && next === '<') { op = '<<'; res.heredoc = true; i++; }
      if (ch === '>' && text[i + 1] === '&') { op += '&'; i++; }
      pending = { op, target: '' };
      continue;
    }
    if (ps) { if (ch === '(' || ch === '{' || ch === '[') depth++; else if (ch === ')' || ch === '}' || ch === ']') depth = Math.max(0, depth - 1); }
    inTok = true;
    cur += ch;
  }
  endSeg(null);
  return res;
}

// ---------- normalisation ----------
const GIT_GLOBAL_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);
const PKG_GLOBAL_VALUE = new Set(['--prefix', '-C', '--cwd', '--dir', '-w', '--workspace', '--filter', '-F', '--registry', '--userconfig', '--cache']);
const NESTED_POSIX = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const NESTED_PS = new Set(['powershell', 'pwsh']);

function progName(tok) {
  let p = String(tok);
  p = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf(BS)) + 1);
  return p.replace(/[.](exe|cmd|bat|ps1|com)$/i, '').toLowerCase();
}
function lc(s) { return String(s == null ? '' : s).toLowerCase(); }
function isFlag(a) { return a.length > 1 && a[0] === '-'; }
function normPath(a) {
  let s = String(a).split(BS).join('/').toLowerCase();
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}
function patternHit(arg, pat) {
  const a = lc(arg);
  const p = lc(pat);
  return p.endsWith('*') ? a.startsWith(p.slice(0, -1)) : a === p;
}

// the subcommand after the program's own global flags: `git -C x push` -> push, `pnpm --filter a add b` -> add
function subOf(prog, args) {
  const valueFlags = prog === 'git' ? GIT_GLOBAL_VALUE : PKG_GLOBAL_VALUE;
  let i = 0;
  while (i < args.length && isFlag(args[i])) i += valueFlags.has(args[i]) ? 2 : 1;
  return { sub: args[i], rest: args.slice(i + 1) };
}

// ---------- network ----------
const CURL_VALUE_FLAGS = new Set(['-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '-X', '--request', '-o', '--output', '-u', '--user',
  '-F', '--form', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-c', '--cookie-jar', '-T', '--upload-file', '-m', '--max-time', '--connect-timeout',
  '-x', '--proxy', '--retry', '--resolve', '--cacert', '--header-file']);
const WGET_VALUE_FLAGS = new Set(['-O', '-o', '-P', '-e', '-U', '-t', '-T', '--output-document', '--directory-prefix', '--user-agent', '--header', '--post-data', '--post-file', '--timeout', '--tries']);
const PS_SWITCHES = new Set(['-usebasicparsing', '-skipcertificatecheck', '-allowunencryptedauthentication', '-passthru', '-allowinsecureredirect', '-nobody']);

function urlCandidates(prog, args) {
  const out = [];
  if (prog === 'invoke-webrequest' || prog === 'iwr' || prog === 'invoke-restmethod' || prog === 'irm') {
    for (let i = 0; i < args.length; i++) {
      const a = lc(args[i]);
      if (a === '-uri' || a === '-url') { if (args[i + 1] !== undefined) out.push(args[i + 1]); i++; } else if (isFlag(args[i])) { if (!PS_SWITCHES.has(a)) i++; } else out.push(args[i]);
    }
    return out;
  }
  const valueFlags = prog === 'wget' ? WGET_VALUE_FLAGS : CURL_VALUE_FLAGS;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--url') { if (args[i + 1] !== undefined) out.push(args[i + 1]); i++; continue; }
    if (a.startsWith('--url=')) { out.push(a.slice(6)); continue; }
    if (isFlag(a)) { if (valueFlags.has(a)) i++; continue; }
    out.push(a);
  }
  return out;
}
function hostOf(token) {
  const t = String(token);
  try {
    return new URL(t.includes('://') ? t : 'http://' + t).hostname.toLowerCase();
  } catch {
    return null;
  }
}
function onlyLocalUrls(prog, args, rules) {
  const local = new Set(((rules.network || {}).localHosts || ['localhost', '127.0.0.1', '[::1]']).map(lc));
  const urls = urlCandidates(prog, args);
  if (!urls.length) return false;
  return urls.every((u) => { const h = hostOf(u); return h !== null && local.has(h); });
}

// ---------- rule matching ----------
function isRecursive(prog, args) {
  if (prog === 'rmdir' && args.some((a) => lc(a) === '/s')) return true;
  return args.some((a) => {
    const l = lc(a);
    if (l === '--recursive' || l.startsWith('-recurse')) return true;
    return /^-[a-zA-Z]{1,3}$/.test(a) && /[rR]/.test(a);
  });
}
function listOf(v) { return v === undefined ? null : Array.isArray(v) ? v : [v]; }

function matches(rule, ctx, rules) {
  const cmds = listOf(rule.cmd);
  if (cmds && !cmds.map(lc).includes(ctx.prog)) return false;
  const subs = listOf(rule.sub);
  if (subs && !(ctx.sub !== undefined && subs.map(lc).includes(lc(ctx.sub)))) return false;
  const subArgs = listOf(rule.subArg);
  if (subArgs && !(ctx.rest[0] !== undefined && subArgs.map(lc).includes(lc(ctx.rest[0])))) return false;
  if (rule.anyArg && !ctx.args.some((a) => rule.anyArg.some((p) => patternHit(a, p)))) return false;
  if (rule.unlessAnyArg && ctx.args.some((a) => rule.unlessAnyArg.some((p) => patternHit(a, p)))) return false;
  if (rule.firstArgStartsWith) {
    const f = ctx.args.length ? normPath(ctx.args[0]) : null;
    if (f === null || !rule.firstArgStartsWith.some((p) => f.startsWith(lc(p)))) return false;
  }
  if (rule.recursive && !isRecursive(ctx.prog, ctx.args)) return false;
  if (rule.targetRegex) {
    const re = new RegExp(rule.targetRegex, 'i');
    if (!ctx.args.filter((a) => !isFlag(a)).some((a) => re.test(a))) return false;
  }
  if (rule.needsArg && !ctx.rest.some((a) => !isFlag(a))) return false;
  if (rule.network === 'localhost-only' && onlyLocalUrls(ctx.prog, ctx.args, rules)) return false; // a local-only request is not a violation
  if (rule.localhostOnly && !onlyLocalUrls(ctx.prog, ctx.args, rules)) return false;
  return true;
}

// ---------- evaluation ----------
function evalSegment(seg, rules, shell, depth) {
  let argv = seg.argv.slice();
  while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv.shift();
  const wrappers = new Set(rules.wrappers || ['env', 'command', 'nohup', 'time', 'exec', 'builtin', 'timeout']);
  for (let k = 0; k < 6 && argv.length; k++) {
    const p = progName(argv[0]);
    if (p === 'command' && (argv[1] === '-v' || argv[1] === '-V')) break;
    if (!wrappers.has(p)) break;
    argv.shift();
    if (p === 'env') { while (argv.length && (isFlag(argv[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]))) argv.shift(); }
    if (p === 'timeout') { while (argv.length && isFlag(argv[0])) argv.shift(); if (argv.length) argv.shift(); }
  }
  if (!argv.length) return { verdict: 'ask', reasons: [{ kind: 'ask', rule: 'empty', why: 'nothing to run, or only a variable assignment' }] };

  const prog = progName(argv[0]);
  const args = argv.slice(1);
  const shown = argv.join(' ').slice(0, 120);

  // a shell inside a shell: look at what it runs
  let inner = null;
  if (NESTED_POSIX.has(prog)) {
    const ci = args.findIndex((a) => /^-[a-zA-Z]*c$/.test(a));
    if (ci >= 0 && args[ci + 1] !== undefined) inner = { text: args[ci + 1], shell: 'posix' };
  } else if (NESTED_PS.has(prog)) {
    const ci = args.findIndex((a) => ['-command', '-c', '-com'].includes(lc(a)));
    if (ci >= 0 && args[ci + 1] !== undefined) inner = { text: args.slice(ci + 1).join(' '), shell: 'powershell' };
    else if (args.some((a) => ['-encodedcommand', '-e', '-ec'].includes(lc(a)))) return { verdict: 'ask', reasons: [{ kind: 'ask', segment: shown, rule: 'opaque', why: 'an encoded command cannot be checked' }] };
  } else if (prog === 'cmd') {
    const ci = args.findIndex((a) => ['/c', '/k'].includes(lc(a)));
    if (ci >= 0) inner = { text: args.slice(ci + 1).join(' '), shell: 'posix' };
  }
  if (inner) {
    if (depth >= 3) return { verdict: 'ask', reasons: [{ kind: 'ask', segment: shown, rule: 'nested', why: 'shells nested too deeply' }] };
    return evaluate(inner.text, rules, { shell: inner.shell, depth: depth + 1 });
  }

  let sub;
  let rest = args;
  if (prog === 'git' || prog === 'npm' || prog === 'pnpm' || prog === 'yarn' || prog === 'npx') ({ sub, rest } = subOf(prog, args));
  const ctx = { prog, sub, rest, args };

  const reasons = [];
  for (const rule of rules.deny || []) {
    if (matches(rule, ctx, rules)) reasons.push({ kind: 'deny', segment: shown, rule: rule.id, why: rule.why });
  }
  // a denied program hiding behind another one (xargs git push, ForEach-Object { git push }, find -exec rm -rf /)
  const denyProgs = new Set();
  for (const rule of rules.deny || []) for (const c of listOf(rule.cmd) || []) denyProgs.add(lc(c));
  for (let i = 1; i < argv.length; i++) {
    const p2 = progName(argv[i]);
    if (!denyProgs.has(p2)) continue;
    const a2 = argv.slice(i + 1);
    let sub2;
    let rest2 = a2;
    if (p2 === 'git' || p2 === 'npm' || p2 === 'pnpm' || p2 === 'yarn' || p2 === 'npx') ({ sub: sub2, rest: rest2 } = subOf(p2, a2));
    const ctx2 = { prog: p2, sub: sub2, rest: rest2, args: a2 };
    for (const rule of rules.deny || []) {
      if (rule.cmd && matches(rule, ctx2, rules)) reasons.push({ kind: 'deny', segment: shown, rule: rule.id + ' (inside another command)', why: rule.why });
    }
  }
  if (reasons.length) return { verdict: 'deny', reasons };
  for (const rule of rules.allow || []) {
    if (matches(rule, ctx, rules)) return { verdict: 'allow', reasons: [{ kind: 'allow', segment: shown, rule: rule.id }] };
  }
  return { verdict: 'ask', reasons: [{ kind: 'ask', segment: shown, rule: 'unlisted', why: 'no rule allows this command' }] };
}

function evaluate(command, rules, opts) {
  const o = opts || {};
  const shell = o.shell || (process.platform === 'win32' ? 'powershell' : 'posix');
  const depth = o.depth || 0;
  const parsed = parse(command, shell);
  const reasons = [];
  let deny = false;
  let ask = false;
  for (const seg of parsed.segments) {
    const r = evalSegment(seg, rules, shell, depth);
    reasons.push(...r.reasons);
    if (r.verdict === 'deny') deny = true; else if (r.verdict === 'ask') ask = true;
  }
  const okOps = new Set(((rules.operators || {}).allow || []).map(lc));
  for (const op of parsed.ops) if (!okOps.has(lc(op))) { ask = true; reasons.push({ kind: 'ask', rule: 'operator', why: 'the operator ' + op + ' is not allowed by policy.json' }); }
  if (parsed.subst) { ask = true; reasons.push({ kind: 'ask', rule: 'substitution', why: 'a command substitution runs something that is not checked' }); }
  if (parsed.heredoc) { ask = true; reasons.push({ kind: 'ask', rule: 'heredoc', why: 'a heredoc is not checked' }); }
  if (parsed.unterminated) { ask = true; reasons.push({ kind: 'ask', rule: 'quote', why: 'unbalanced quote' }); }
  const safeTargets = new Set(((rules.redirects || {}).allowTargets || ['/dev/null', 'nul', '$null', '1', '2']).map(lc));
  for (const seg of parsed.segments) {
    for (const rd of seg.redirects) {
      if (rd.op === '<') continue; // reading a file
      if (!safeTargets.has(lc(rd.target))) { ask = true; reasons.push({ kind: 'ask', rule: 'redirect', why: 'writing to ' + rd.target.slice(0, 60) + ' is not allowed silently' }); }
    }
  }
  if (!parsed.segments.length) { ask = true; reasons.push({ kind: 'ask', rule: 'empty', why: 'empty command' }); }
  return { verdict: deny ? 'deny' : ask ? 'ask' : 'allow', reasons };
}

function loadRules(file) {
  return JSON.parse(fs.readFileSync(file || path.join(__dirname, 'policy.json'), 'utf8'));
}

module.exports = { evaluate, parse, loadRules };

if (require.main === module) {
  const i = process.argv.indexOf('--check');
  if (i < 0 || process.argv[i + 1] === undefined) { process.stderr.write('usage: node wv-policy.cjs --check "<command>" [--shell posix|powershell]' + NL); process.exit(2); }
  const si = process.argv.indexOf('--shell');
  const r = evaluate(process.argv[i + 1], loadRules(), { shell: si >= 0 ? process.argv[si + 1] : undefined });
  process.stdout.write(JSON.stringify(r, null, 2) + NL);
  process.exit(r.verdict === 'allow' ? 0 : r.verdict === 'deny' ? 3 : 1);
}
