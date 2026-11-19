'use strict';
// stack.cjs: how THIS project is built, linted and tested, so the agents run its real commands and nothing assumes one stack.
//   node stack.cjs [--root <dir>] [--json | --note]
// Detected from the files in the project (package.json and its lockfile, pyproject.toml, go.mod, Cargo.toml, Makefile, pom.xml,
// gradle, dotnet), then overridden by the `stack` setting in specs/workov.config.json, which only has to list what differs:
//   "stack": { "profile": "angular", "packageManager": "pnpm", "srcDir": "src/app",
//              "commands": { "test": "pnpm run test -- --watch=false", "lint": null } }
// A command set to null means "this project has none" (the check is recorded as SKIP). Angular is one profile among the others.
// Pure Node, no dependencies. Exit code 0 always: an unknown stack is a valid answer ("unknown", every command null).
const fs = require('node:fs');
const path = require('node:path');

const CHECKS = ['install', 'build', 'lint', 'test', 'typecheck'];

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
function has(root, rel) { return fs.existsSync(path.join(root, rel)); }
function emptyCommands() { return { install: null, build: null, lint: null, test: null, typecheck: null }; }

function nodePackageManager(root, pkg) {
  const field = String((pkg && pkg.packageManager) || '').split('@')[0];
  if (['pnpm', 'yarn', 'npm', 'bun'].includes(field)) return field;
  if (has(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (has(root, 'yarn.lock')) return 'yarn';
  if (has(root, 'bun.lockb') || has(root, 'bun.lock')) return 'bun';
  return 'npm';
}
function runScript(pm, name) { return pm === 'yarn' ? 'yarn run ' + name : pm + ' run ' + name; }

function detectNode(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg) return null;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const pm = nodePackageManager(root, pkg);
  const scripts = pkg.scripts || {};
  let profile = 'node';
  if (deps['@angular/core'] || has(root, 'angular.json')) profile = 'angular';
  else if (deps.next) profile = 'next';
  else if (deps.nuxt) profile = 'nuxt';
  else if (deps.vue) profile = 'vue';
  else if (deps.svelte || deps['@sveltejs/kit']) profile = 'svelte';
  else if (deps.react) profile = 'react';
  const c = emptyCommands();
  c.install = pm + ' install';
  for (const name of ['build', 'lint', 'test']) if (scripts[name]) c[name] = runScript(pm, name);
  const tc = ['typecheck', 'type-check', 'tsc'].find((n) => scripts[n]);
  if (tc) c.typecheck = runScript(pm, tc);
  else if (has(root, 'tsconfig.json') && (deps.typescript || profile === 'angular')) c.typecheck = (pm === 'npm' ? 'npx' : pm === 'yarn' ? 'yarn' : pm + ' exec') + ' tsc --noEmit';
  if (profile === 'angular') { // an Angular project without those scripts still builds and tests through its CLI
    const ng = pm === 'npm' ? 'npx ng' : pm === 'yarn' ? 'yarn ng' : pm + ' exec ng';
    if (!c.build) c.build = ng + ' build';
    if (!c.test) c.test = ng + ' test --watch=false';
    if (!c.lint && (deps['@angular-eslint/builder'] || scripts.lint)) c.lint = ng + ' lint';
  }
  let srcDir = 'src';
  if (profile === 'angular') srcDir = 'src/app';
  else if (profile === 'next') srcDir = has(root, 'src/app') ? 'src/app' : has(root, 'app') ? 'app' : has(root, 'src/pages') ? 'src/pages' : 'pages';
  else if (!has(root, 'src')) srcDir = '.';
  return { profile, packageManager: pm, srcDir, commands: c, from: ['package.json'] };
}

function detectPython(root) {
  const markers = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'].filter((f) => has(root, f));
  if (!markers.length) return null;
  const text = ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.cfg'].map((f) => readText(path.join(root, f))).join(String.fromCharCode(10)).toLowerCase();
  const c = emptyCommands();
  const poetry = text.includes('[tool.poetry]');
  const uv = has(root, 'uv.lock');
  const pm = uv ? 'uv' : poetry ? 'poetry' : 'pip';
  c.install = uv ? 'uv sync' : poetry ? 'poetry install' : has(root, 'requirements.txt') ? 'python -m pip install -r requirements.txt' : 'python -m pip install -e .';
  const run = uv ? 'uv run ' : poetry ? 'poetry run ' : 'python -m ';
  if (text.includes('pytest') || has(root, 'tests') || has(root, 'test')) c.test = run + 'pytest';
  if (text.includes('ruff')) c.lint = (uv ? 'uv run ' : poetry ? 'poetry run ' : '') + 'ruff check .';
  else if (text.includes('flake8')) c.lint = run + 'flake8';
  if (text.includes('mypy')) c.typecheck = run + 'mypy .';
  return { profile: 'python', packageManager: pm, srcDir: has(root, 'src') ? 'src' : '.', commands: c, from: markers };
}

function detectSimple(root) {
  if (has(root, 'go.mod')) return { profile: 'go', packageManager: 'go', srcDir: '.', commands: { install: 'go mod download', build: 'go build ./...', lint: 'go vet ./...', test: 'go test ./...', typecheck: null }, from: ['go.mod'] };
  if (has(root, 'Cargo.toml')) return { profile: 'rust', packageManager: 'cargo', srcDir: 'src', commands: { install: 'cargo fetch', build: 'cargo build', lint: 'cargo clippy', test: 'cargo test', typecheck: 'cargo check' }, from: ['Cargo.toml'] };
  if (has(root, 'pom.xml')) return { profile: 'java', packageManager: 'maven', srcDir: 'src/main', commands: { install: null, build: 'mvn -q package -DskipTests', lint: null, test: 'mvn -q test', typecheck: null }, from: ['pom.xml'] };
  if (has(root, 'build.gradle') || has(root, 'build.gradle.kts')) return { profile: 'java', packageManager: 'gradle', srcDir: 'src/main', commands: { install: null, build: './gradlew build -x test', lint: null, test: './gradlew test', typecheck: null }, from: ['build.gradle'] };
  const dn = fs.readdirSync(root).find((f) => /[.](sln|csproj)$/.test(f));
  if (dn) return { profile: 'dotnet', packageManager: 'dotnet', srcDir: '.', commands: { install: 'dotnet restore', build: 'dotnet build', lint: null, test: 'dotnet test', typecheck: null }, from: [dn] };
  if (has(root, 'Makefile')) {
    const mk = readText(path.join(root, 'Makefile'));
    const c = emptyCommands();
    for (const t of ['build', 'lint', 'test']) if (new RegExp('^' + t + '[ ]*:', 'm').test(mk)) c[t] = 'make ' + t;
    if (new RegExp('^check[ ]*:', 'm').test(mk) && !c.test) c.test = 'make check';
    return { profile: 'make', packageManager: 'make', srcDir: '.', commands: c, from: ['Makefile'] };
  }
  return null;
}

function detect(root) {
  const found = [detectNode(root), detectPython(root), detectSimple(root)].filter(Boolean);
  if (!found.length) return { profile: 'unknown', packageManager: null, srcDir: '.', commands: emptyCommands(), detectedFrom: [], also: [] };
  const [main, ...rest] = found;
  return { ...main, detectedFrom: main.from, also: rest.map((r) => r.profile) };
}

// the setting in specs/workov.config.json: only the keys it lists replace the detected ones
function resolve(root) {
  const detected = detect(root);
  const cfg = readJson(path.join(root, 'specs', 'workov.config.json'));
  const set = cfg && cfg.stack && typeof cfg.stack === 'object' ? cfg.stack : null;
  const out = { ...detected, commands: { ...detected.commands }, source: 'detected' };
  if (set) {
    for (const k of ['profile', 'packageManager', 'srcDir']) if (typeof set[k] === 'string' && set[k]) { out[k] = set[k]; out.source = 'configured'; }
    if (set.commands && typeof set.commands === 'object') {
      for (const k of CHECKS) if (k in set.commands && (set.commands[k] === null || typeof set.commands[k] === 'string')) { out.commands[k] = set.commands[k]; out.source = 'configured'; }
    }
  }
  out.designerStack = out.profile === 'angular' ? 'angular' : 'html-tailwind';
  delete out.from;
  return out;
}

function note(s) {
  const cmd = (k) => k + ': ' + (s.commands[k] || 'none (record SKIP)');
  return 'This project\'s stack is ' + s.profile + (s.packageManager ? ' (' + s.packageManager + ')' : '') + '; its commands are ' + ['build', 'lint', 'test', 'typecheck'].map(cmd).join('; ') +
    '; source folder ' + s.srcDir + '. Run these, do not guess others, and do not assume another stack.';
}

module.exports = { resolve, detect, note };

if (require.main === module) {
  const a = process.argv.slice(2);
  const ri = a.indexOf('--root');
  const root = path.resolve(ri >= 0 && a[ri + 1] ? a[ri + 1] : process.cwd());
  const s = resolve(root);
  process.stdout.write((a.includes('--note') ? note(s) : JSON.stringify(s, null, 2)) + String.fromCharCode(10));
}
