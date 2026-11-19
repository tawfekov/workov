'use strict';
// Stack detection: node tests/test_stack.cjs
// Builds small throwaway projects of different kinds and checks what stack.cjs reports: the profile, the package manager, the commands the agents
// should run (null = none, recorded as SKIP) and that the `stack` setting in specs/workov.config.json overrides only what it lists.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolve, note } = require('../overlay/.claude/scripts/stack.cjs');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-stack-'));
process.on('exit', () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ } });
let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail = 1; };
let n = 0;
function project(files) {
  const dir = path.join(T, 'p' + (++n));
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}
const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
const same = (a, b) => canon(a) === canon(b);
function check(name, files, want) {
  const s = resolve(project(files));
  const got = { profile: s.profile, pm: s.packageManager, src: s.srcDir, ...Object.fromEntries(Object.entries(s.commands).filter(([k]) => k in (want.commands || {})).map(([k, v]) => ['c.' + k, v])) };
  const exp = { profile: want.profile, pm: want.pm, src: want.src, ...Object.fromEntries(Object.entries(want.commands || {}).map(([k, v]) => ['c.' + k, v])) };
  ok(same(got, exp), name + (same(got, exp) ? '' : '  got ' + JSON.stringify(got) + ' wanted ' + JSON.stringify(exp)));
  return s;
}

// ---- JavaScript ----
const ng = check('angular with pnpm and scripts', { 'package.json': { dependencies: { '@angular/core': '19.0.0' }, scripts: { build: 'ng build', lint: 'ng lint', test: 'ng test' } }, 'pnpm-lock.yaml': '', 'angular.json': '{}' },
  { profile: 'angular', pm: 'pnpm', src: 'src/app', commands: { build: 'pnpm run build', lint: 'pnpm run lint', test: 'pnpm run test', install: 'pnpm install' } });
ok(ng.designerStack === 'angular', 'angular uses the angular designer stack');
check('angular without scripts falls back to the ng cli', { 'package.json': { dependencies: { '@angular/core': '19.0.0' } }, 'angular.json': '{}' },
  { profile: 'angular', pm: 'npm', src: 'src/app', commands: { build: 'npx ng build', test: 'npx ng test --watch=false' } });
const nx = check('next with yarn', { 'package.json': { dependencies: { next: '15.0.0', react: '19.0.0' }, scripts: { build: 'next build', lint: 'next lint' } }, 'yarn.lock': '', 'app/page.tsx': '' },
  { profile: 'next', pm: 'yarn', src: 'app', commands: { build: 'yarn run build', lint: 'yarn run lint', test: null } });
ok(nx.designerStack === 'html-tailwind', 'a non-angular project uses the html-tailwind designer stack');
check('react (vite) with the packageManager field', { 'package.json': { packageManager: 'pnpm@9.1.0', dependencies: { react: '19.0.0' }, devDependencies: { typescript: '5.0.0' }, scripts: { test: 'vitest run', typecheck: 'tsc -b' } }, 'src/main.tsx': '' },
  { profile: 'react', pm: 'pnpm', src: 'src', commands: { test: 'pnpm run test', typecheck: 'pnpm run typecheck', build: null, lint: null } });
check('plain node with npm and no scripts', { 'package.json': { name: 'x' } },
  { profile: 'node', pm: 'npm', src: '.', commands: { build: null, lint: null, test: null, typecheck: null, install: 'npm install' } });
check('vue with bun', { 'package.json': { dependencies: { vue: '3.0.0' }, scripts: { build: 'vite build' } }, 'bun.lockb': '', 'src/App.vue': '' },
  { profile: 'vue', pm: 'bun', src: 'src', commands: { build: 'bun run build' } });

// ---- other stacks ----
check('python with pytest, ruff and mypy (uv)', { 'pyproject.toml': '[project]' + String.fromCharCode(10) + 'dev = ["pytest", "ruff", "mypy"]', 'uv.lock': '', 'src/a.py': '' },
  { profile: 'python', pm: 'uv', src: 'src', commands: { install: 'uv sync', test: 'uv run pytest', lint: 'uv run ruff check .', typecheck: 'uv run mypy .', build: null } });
check('python with requirements.txt only', { 'requirements.txt': 'flask' },
  { profile: 'python', pm: 'pip', src: '.', commands: { install: 'python -m pip install -r requirements.txt', test: null, lint: null } });
check('go', { 'go.mod': 'module x' }, { profile: 'go', pm: 'go', src: '.', commands: { test: 'go test ./...', build: 'go build ./...', lint: 'go vet ./...' } });
check('rust', { 'Cargo.toml': '[package]' }, { profile: 'rust', pm: 'cargo', src: 'src', commands: { test: 'cargo test', lint: 'cargo clippy', typecheck: 'cargo check' } });
check('maven', { 'pom.xml': '<project/>' }, { profile: 'java', pm: 'maven', src: 'src/main', commands: { test: 'mvn -q test', lint: null } });
check('dotnet', { 'App.sln': '' }, { profile: 'dotnet', pm: 'dotnet', src: '.', commands: { test: 'dotnet test', build: 'dotnet build' } });
check('a Makefile with test and build targets', { Makefile: 'build:' + String.fromCharCode(10) + String.fromCharCode(9) + 'cc x.c' + String.fromCharCode(10) + 'test:' + String.fromCharCode(10) + String.fromCharCode(9) + './run' },
  { profile: 'make', pm: 'make', src: '.', commands: { build: 'make build', test: 'make test', lint: null } });
const unk = check('an empty project is "unknown", not an error', {}, { profile: 'unknown', pm: null, src: '.', commands: { build: null, test: null } });
ok(unk.detectedFrom.length === 0, 'unknown: nothing detected');
const mixed = resolve(project({ 'package.json': { scripts: { test: 'jest' } }, 'pyproject.toml': '[project]' }));
ok(mixed.profile === 'node' && mixed.also.includes('python'), 'a node + python repo reports node first and lists python as also');

// ---- the setting overrides only what it lists ----
const cfgDir = project({ 'package.json': { dependencies: { '@angular/core': '19.0.0' }, scripts: { build: 'ng build', lint: 'ng lint', test: 'ng test' } }, 'pnpm-lock.yaml': '', 'angular.json': '{}',
  'specs/workov.config.json': { stack: { commands: { test: 'pnpm run test -- --watch=false', lint: null } } } });
const o = resolve(cfgDir);
ok(o.commands.test === 'pnpm run test -- --watch=false' && o.commands.lint === null && o.commands.build === 'pnpm run build' && o.profile === 'angular' && o.source === 'configured',
  'the stack setting replaces test and lint only; build and the profile stay detected');
const p2 = resolve(project({ 'package.json': { scripts: { test: 'x' } }, 'specs/workov.config.json': { stack: { profile: 'react', srcDir: 'web' } } }));
ok(p2.profile === 'react' && p2.srcDir === 'web' && p2.designerStack === 'html-tailwind', 'the setting can name the profile and the source folder');
const bad = resolve(project({ 'package.json': { scripts: { test: 'x' } }, 'specs/workov.config.json': { stack: { commands: { test: 5 }, profile: 7 } } }));
ok(bad.commands.test === 'npm run test' && bad.profile === 'node', 'a malformed setting is ignored');
const none = resolve(project({ 'package.json': { scripts: { test: 'x' } }, 'specs/workov.config.json': '{ not json' }));
ok(none.commands.test === 'npm run test', 'an unreadable config file is ignored');

// ---- the sentence handed to the router ----
const sentence = note(ng);
ok(sentence.includes('angular') && sentence.includes('pnpm run test') && sentence.includes('do not assume another stack') && !sentence.includes('undefined'), 'the router note names the stack and its commands');
ok(note(unk).includes('none (record SKIP)'), 'the router note says SKIP for a missing command');

if (fail) { console.log('stack tests FAILED'); process.exit(1); }
console.log('stack tests OK');
