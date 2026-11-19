#!/usr/bin/env bash
# "Does a PR stand on its own?" tools and what PR #1 does when the pipeline scripts it calls are not installed.
#   1. check-standalone.sh on fixtures: unguarded / guarded / shipped / commented calls, provider hints, install alone
#   2. router-loop.sh refuses to start, naming the missing helpers, instead of stopping at once with no explanation
#   3. this repository passes its own check (the committed HEAD)
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
. "$HERE/tests/lib-realhome.sh"; realhome_snapshot
CHK="$HERE/scripts/check-standalone.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
fail=0; ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; fail=1; }

# a fixture repository with one branch per case
F="$T/fx"; mkdir -p "$F"; git -C "$F" init -q -b main; echo base > "$F/README.md"; git -C "$F" add -A; git -C "$F" commit -q -m base
mkbranch() { # name, then "path=content" pairs written verbatim
  local b="$1"; shift; git -C "$F" checkout -q -b "$b" main
  for kv in "$@"; do mkdir -p "$F/$(dirname "${kv%%=*}")"; printf '%s\n' "${kv#*=}" > "$F/${kv%%=*}"; done
  git -C "$F" add -A; git -C "$F" commit -q -m "$b"; git -C "$F" checkout -q main
}
CALL='python3 "$HOME/.wv-bin/wv-missing.py" run'
mkbranch unguarded "overlay/.claude/scripts/x.sh=$CALL"
mkbranch guarded   "overlay/.claude/scripts/x.sh=[ -f \"\$HOME/.wv-bin/wv-missing.py\" ] && $CALL"
mkbranch shipped   "overlay/.claude/scripts/x.sh=$CALL" "wv-bin/wv-missing.py=print(1)"
mkbranch commented "overlay/.claude/scripts/x.sh=# $CALL"
mkbranch scripts   "overlay/.claude/scripts/y.sh=bash .claude/scripts/not-here.sh"
mkbranch installok  "install.sh=exit 0"
mkbranch installbad "install.sh=exit 5"

run() { bash "$CHK" "$1" --repo "$F" "${@:2}" 2>&1; }
out="$(run unguarded)"; rc=$?
[ "$rc" != 0 ] && echo "$out" | grep -q 'wv-bin/wv-missing.py' && ok "an unguarded call to a file the PR does not ship fails and names the file" || bad "unguarded call (rc=$rc)"
out="$(run guarded)"; rc=$?; [ "$rc" = 0 ] && echo "$out" | grep -q 'guarded' && ok "a call behind an existence test passes (and is reported as guarded)" || bad "guarded call (rc=$rc)"
out="$(run shipped)"; rc=$?; [ "$rc" = 0 ] && ok "a call to a file the PR ships passes" || bad "shipped call (rc=$rc)"
out="$(run commented)"; rc=$?; [ "$rc" = 0 ] && ok "a commented-out call is ignored" || bad "commented call (rc=$rc)"
out="$(run scripts)"; rc=$?; [ "$rc" != 0 ] && echo "$out" | grep -q 'not-here.sh' && ok "a call to a missing .claude/scripts file fails" || bad "missing .claude/scripts file (rc=$rc)"
out="$(run unguarded --providers 'refs/heads/*')"; echo "$out" | grep -q 'shipped by .*shipped' && ok "the report says which other PR ships the missing file" || bad "provider hint missing: $out"
out="$(run installok)"; rc=$?; [ "$rc" = 0 ] && echo "$out" | grep -q 'installs alone' && ok "a PR whose installer succeeds passes the install-alone check" || bad "install ok (rc=$rc)"
out="$(run installbad)"; rc=$?; [ "$rc" != 0 ] && echo "$out" | grep -q 'FAIL install' && ok "a PR whose installer fails is caught" || bad "install bad (rc=$rc)"
out="$(run unguarded)"; echo "$out" | grep -q 'skip install: this PR has no install.sh' && ok "a PR without an installer says so instead of failing" || bad "no-installer message"

# 2. the router loop names what is missing
R="$T/r"; mkdir -p "$R/.claude/scripts" "$T/h1" "$T/h2/.wv-bin"; git -C "$R" init -q -b main
cp "$HERE/overlay/.claude/scripts/router-loop.sh" "$HERE/overlay/.claude/scripts/shell-note.sh" "$HERE/overlay/.claude/scripts/stack.cjs" "$R/.claude/scripts/"
out="$(cd "$R" && HOME="$T/h1" USERPROFILE="$T/h1" WV_HOME_DIR="$T/h1" bash .claude/scripts/router-loop.sh 2>&1)"; rc=$?
[ "$rc" = 3 ] && echo "$out" | grep -q 'not started' && echo "$out" | grep -q 'wv-turn.py' && echo "$out" | grep -q -- '--with-home' && ok "router-loop.sh refuses to start, naming the missing helpers and how to install them" || bad "router-loop preflight (rc=$rc): $out"
[ ! -e "$R/job/router-loop.pid" ] && ok "and it leaves no pid file or guard process behind" || bad "a pid file was left behind"
for h in wv-turn.py wv-sessions.py wv-gate.py wv-plan.py wv-settle.py wv-dispatch.py wv-adopt.py wv-busy.py wv-stop.py wv-bashenv.sh; do : > "$T/h2/.wv-bin/$h"; done
out="$(cd "$R" && HOME="$T/h2" USERPROFILE="$T/h2" WV_HOME_DIR="$T/h2" timeout 60 bash .claude/scripts/router-loop.sh 2>&1)"; rc=$?
echo "$out" | grep -q 'not started' && bad "router-loop refused although every helper exists" || ok "with every helper present the preflight lets the loop run"

# 3. this repository passes its own check
out="$(bash "$CHK" HEAD --repo "$HERE" 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "this repository (HEAD) stands alone: nothing unguarded is missing" || { bad "this repository does not pass its own check"; echo "$out" | sed 's/^/     /' | tail -15; }

realhome_check || fail=1
[ "$fail" = 0 ] && echo "standalone OK" || { echo "standalone FAILED"; exit 1; }
