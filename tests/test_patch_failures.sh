#!/usr/bin/env bash
# A patch that does not apply must be named and skipped, not abort the install (HOME is a temp folder).
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
. "$HERE/tests/lib-realhome.sh"; realhome_snapshot
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t HOME="$T/h"; mkdir -p "$HOME"
fail=0; ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; fail=1; }
# a copy of this repository with one patch that always fails
cp -r "$HERE" "$T/kit" 2>/dev/null; rm -rf "$T/kit/.git"
mkdir -p "$T/kit/patches"; echo "throw new Error('anchor missing: demo');" > "$T/kit/patches/agents.cjs"
R="$T/repo"; mkdir -p "$R"; git -C "$R" init -q -b main; echo x > "$R/a.txt"; git -C "$R" add -A; git -C "$R" commit -q -m init
out="$(bash "$T/kit/install.sh" "$R" --in-place --no-setup --no-command 2>&1 </dev/null)"; rc=$?
[ "$rc" = 0 ] && ok "a failing patch does not abort the install" || bad "install aborted (rc=$rc)"
echo "$out" | grep -q 'patch agents did not apply: .*anchor missing' && ok "the failing patch is named with its reason" || bad "failing patch not named"
echo "$out" | grep -q 'these patches did not apply: agents' && ok "the summary lists it" || bad "no summary"
realhome_check || fail=1
[ "$fail" = 0 ] && echo "patch failures OK" || { echo "patch failures FAILED"; exit 1; }
