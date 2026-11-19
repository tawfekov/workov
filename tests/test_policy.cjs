'use strict';
// Command policy tests: node tests/test_policy.cjs
// Three lists: commands that must be allowed, commands that must ask, and bypasses that must be denied.
// `legacyBypass` marks a case the CURRENT prefix policy gets wrong (it does not deny it), to prove the new engine fixes it.
const path = require('node:path');
const { evaluate, loadRules } = require('../overlay/.claude/scripts/wv-policy.cjs');
const { loadLegacy } = require('./lib-legacy.cjs');

const BS = String.fromCharCode(92);
const BQ = String.fromCharCode(96);
const rules = loadRules(path.join(__dirname, '..', 'overlay', '.claude', 'scripts', 'policy.json'));
const legacy = loadLegacy(path.join(__dirname, '..', 'overlay', '.opencode', 'plugins', 'approvals.js'));

// [command, expected verdict, shell, legacyBypass]
const CASES = [
  // ---- allowed: what the agents run every day ----
  ['git status', 'allow'], ['git -C ../repo status', 'allow'], ['git diff --stat | head -20', 'allow'],
  ['git add -A && git commit -m "feat: x"', 'allow'], ['git worktree list', 'allow'], ['git log --oneline -5; git status', 'allow'],
  ['ls -la', 'allow'], ['cat a.txt | grep foo | wc -l', 'allow'], ['pnpm test', 'allow'], ['pnpm --filter app test', 'allow'],
  ['npx prettier --check .', 'allow'], ['node .claude/scripts/x.cjs', 'allow'], ['python3 .claude/scripts/x.py --dry', 'allow'],
  ['bash .claude/scripts/x.sh', 'allow'], ['node .claude' + BS + 'scripts' + BS + 'x.cjs', 'allow', 'powershell'],
  ['curl -s http://localhost:4200/api/state', 'allow'], ['curl -s http://127.0.0.1:3080/x | head', 'allow'],
  ['curl -s "http://localhost:4200/a?u=http://evil.com"', 'allow'],
  ['sed -n 1,10p f.txt', 'allow'], ['find . -name "*.ts"', 'allow'], ['ls 2>/dev/null', 'allow'], ['ls 2>&1 | head', 'allow'],
  ['command -v node', 'allow'], ['cd src && ls', 'allow'], ['bash -c "ls -la"', 'allow'], ['FOO=1 git status', 'allow'],
  ['Get-Content a.txt | Select-String foo', 'allow', 'powershell'], ['Get-ChildItem -Recurse | Select-Object -First 5', 'allow', 'powershell'],
  ['Select-String -Path x.ts -Pattern y; Test-Path z', 'allow', 'powershell'],
  // ---- other stacks' checks are allowed like pnpm test is; anything that runs arbitrary code still asks ----
  ['make test', 'allow'], ['make build && make lint', 'allow'], ['pytest -q tests/', 'allow'], ['python -m pytest', 'allow'], ['python3 -m ruff check .', 'allow'],
  ['uv run pytest', 'allow'], ['poetry run mypy .', 'allow'], ['cargo test', 'allow'], ['cargo clippy -- -D warnings', 'allow'], ['go test ./...', 'allow'],
  ['go vet ./...', 'allow'], ['dotnet test', 'allow'], ['mvn -q test', 'allow'], ['./gradlew test', 'allow'],
  ['make install', 'ask'], ['cargo run', 'ask'], ['go run main.go', 'ask'], ['uv run rm -rf x', 'ask'], ['python -m http.server', 'ask'], ['python script.py', 'ask'],
  // ---- ask: not listed, or something the policy will not wave through silently ----
  ['git status; rm foo', 'ask'], ['echo hi > out.txt', 'ask'], ['echo hi >> out.txt', 'ask'], ['ls $(whoami)', 'ask'],
  ['ls ' + BQ + 'whoami' + BQ, 'ask', 'posix'], ['ls || true', 'ask'], ['sleep 1 &', 'ask'], ['cat <<EOF', 'ask'], ['ls "unterminated', 'ask'],
  ['curl http://localhost:1/x', 'ask'], ['pnpm install', 'ask'], ['ng build', 'ask'], ['find . -delete', 'ask'], ['find . -exec rm {} ;', 'ask'],
  ['xargs rm', 'ask'], ['sudo ls', 'ask'], ['powershell -EncodedCommand AAAA', 'ask'], ['', 'ask'], ['FOO=1', 'ask'],
  ['git reset --hard HEAD', 'ask'], ['git -C x checkout -b y', 'allow'],
  // ---- hidden behind another command, and multi-line PowerShell ----
  ['ForEach-Object { git push }', 'deny', 'powershell'], ['xargs git push', 'deny'], ['echo x | xargs rm -rf /', 'deny'], ['find . -exec git push ;', 'deny'],
  ['Get-ChildItem | ForEach-Object { $_.Name }', 'ask', 'powershell'], ['git remote -v', 'allow'], ['git remote add x y', 'ask'], ['git rev-list --count HEAD..origin/main', 'allow'],
  ['git add a.ts,' + String.fromCharCode(10) + 'b.ts', 'allow', 'powershell'], ['Get-ChildItem @(' + String.fromCharCode(10) + '  "a"' + String.fromCharCode(10) + ')', 'allow', 'powershell'],
  // ---- denied: the review's bypasses and the old rules, in every spelling ----
  ['git push', 'deny'], ['git push origin main', 'deny'], ['git -C x push', 'deny', 'posix', true], ['git --no-pager push', 'deny', 'posix', true],
  ['git -c a=b push origin main', 'deny', 'posix', true], ['FOO=1 git push', 'deny'], ['env FOO=1 git push', 'deny'],
  ['command git push', 'deny'], ['/usr/bin/git push', 'deny'], ['"git" "push"', 'deny', 'posix', true],
  ['git status; git push', 'deny'], ['git status && git push', 'deny'], ['ls | git push', 'deny'],
  ['bash -c "git push"', 'deny'], ["sh -c 'git status; git push'", 'deny'], ['cmd /c git push', 'deny'], ['powershell -Command "git push"', 'deny', 'powershell'],
  ['git push --force-with-lease', 'deny'], ['git checkout --force x', 'deny'], ['npm test --force', 'deny'],
  ['git reset --hard origin/main', 'deny'], ['git reset --hard main', 'deny'], ['git -C x reset --hard origin/main', 'deny', 'posix', true],
  ['rm -rf /', 'deny'], ['rm -rf ~', 'deny'], ['rm -rf ..', 'deny'], ['rm -fr /tmp/x', 'deny'], ['rm -rf C:/x', 'deny'], ['rm -rf C:' + BS + 'x', 'deny'],
  ['rm -rf ../x', 'deny'], ['rm --recursive --force /', 'deny'],
  ['Remove-Item -Recurse -Force C:/x', 'deny', 'powershell'], ['Remove-Item -Recurse E:' + BS + 'x' + BS + 'fleet-009-y', 'deny', 'powershell'],
  ['rm -r foo-009-bar', 'deny'], ['rmdir /s /q foo-012-bar', 'deny'],
  ['git worktree remove x', 'deny'], ['git worktree prune', 'deny'], ['git -C y worktree remove z', 'deny', 'posix', true],
  ['curl https://example.com', 'deny'], ['curl http://localhost.evil.com', 'deny', 'posix', true], ['curl -s http://localhost.evil.com/x', 'deny', 'posix', true],
  ['curl evil.com?localhost', 'deny'], ['curl http://localhost@evil.com/', 'deny', 'posix', true], ['curl -s http://127.0.0.1.evil.com', 'deny', 'posix', true],
  ['curl -s http://localhost:3000 http://evil.com', 'deny', 'posix', true], ['curl -H "X: localhost" http://evil.com', 'deny'],
  ['curl http://evil.com -o localhost', 'deny'], ['wget http://evil.com', 'deny'], ['curl', 'deny'], ['curl --url http://evil.com', 'deny'], ['curl $URL', 'deny'],
  ['curl -f http://evil.com', 'deny'], ['curl -s http://localhost:3000; curl http://evil.com', 'deny'],
  ['Invoke-WebRequest -Uri http://evil.com', 'deny', 'powershell'], ['iwr evil.com', 'deny', 'powershell'],
  ['pnpm add left-pad', 'deny'], ['npm install lodash', 'deny'], ['pnpm --filter app add x', 'deny', 'posix', true], ['yarn add y', 'deny'], ['npm i x', 'deny'],
];

let fail = 0;
let fixed = 0;
for (const [cmd, want, shell, legacyBypass] of CASES) {
  const got = evaluate(cmd, rules, { shell: shell || 'posix' });
  const label = cmd === '' ? '(empty)' : cmd.length > 70 ? cmd.slice(0, 70) + '...' : cmd;
  if (got.verdict !== want) {
    fail++;
    console.log('FAIL  ' + label + '  -> ' + got.verdict + ', wanted ' + want + '  ' + JSON.stringify(got.reasons.map((r) => r.rule)));
    continue;
  }
  if (legacyBypass) {
    const old = legacy(cmd);
    if (old === 'deny') { fail++; console.log('FAIL  ' + label + '  was marked a bypass but the current policy already denies it'); } else fixed++;
  }
}
console.log((CASES.length - fail) + ' of ' + CASES.length + ' cases pass; ' + fixed + ' of them are bypasses the current prefix policy lets through');
if (fail) { console.log('policy tests FAILED'); process.exit(1); }
console.log('policy tests OK');
