#!/usr/bin/env bash
# Installer safety checks on throwaway repos (HOME is a temp folder, nothing real is touched):
#   1. a dirty target is refused, and --force keeps the edit and saves a backup
#   2. a file the base installer replaces is restored, but one you had already edited is not
#   3. clone mode fast-forwards the fleet branch, and stops (changing nothing) when it diverged
# The kit patches are not run: the stub base installer is enough to reach the part under test, and the
# installer is expected to stop after the first restore (the stub repo has nothing to patch).
set -u
. "$(dirname "$0")/lib-realhome.sh"; realhome_snapshot
HERE="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
fail=0; ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; fail=1; }

# stub base installer: replaces a tracked file, the way worker-fleet's installer does
WF="$T/wf"; mkdir -p "$WF/.claude/scripts"
cat > "$WF/.claude/scripts/install.sh" <<'EOF'
#!/usr/bin/env bash
echo "replaced by the base installer" > "$1/base.txt"
echo "appended by the base installer" >> "$1/mine.txt"
EOF

mkrepo() { rm -rf "$1"; mkdir -p "$1"; git -C "$1" init -q -b main; echo base > "$1/base.txt"; echo mine > "$1/mine.txt"
  git -C "$1" add -A; git -C "$1" commit -q -m init; }
run() { bash "$HERE/install.sh" "$@" --base "$WF" --no-setup --no-command 2>&1; }

# 1. dirty repo refused
R="$T/r1"; mkrepo "$R"; echo "my edit" > "$R/mine.txt"
out="$(run "$R" --in-place)"; rc=$?
[ "$rc" = 2 ] && echo "$out" | grep -q "uncommitted changes" && ok "dirty target is refused" || bad "dirty target is refused (rc=$rc)"
[ "$(cat "$R/mine.txt")" = "my edit" ] && ok "the edit is untouched after a refusal" || bad "the edit is untouched after a refusal"

# 2. --force: the pre-edited file is kept, the other replaced file is restored, a backup exists
out="$(run "$R" --in-place --force)"
grep -q "my edit" "$R/mine.txt" && ok "--force keeps your edit (not reverted)" || bad "--force keeps your edit (not reverted)"
[ "$(cat "$R/base.txt")" = base ] && ok "a file you had not edited is restored" || bad "a file you had not edited is restored"
ls "$HOME"/.workov/backups/*/pre-install.patch >/dev/null 2>&1 && grep -q "my edit" "$HOME"/.workov/backups/*/pre-install.patch && ok "--force saved a backup of your edit" || bad "--force saved a backup of your edit"

# clean repo: restored without --force
R="$T/r2"; mkrepo "$R"; out="$(run "$R" --in-place)"
[ "$(cat "$R/base.txt")" = base ] && [ "$(cat "$R/mine.txt")" = mine ] && ok "clean repo: replaced files restored" || bad "clean repo: replaced files restored"

# 3. clone mode
ORIGIN="$T/origin.git"; git init -q --bare -b main "$ORIGIN"
SRC="$T/src"; mkrepo "$SRC"; git -C "$SRC" remote add origin "$ORIGIN"; git -C "$SRC" push -q origin main
export WV_FLEETS_DIR="$T/fleets" WV_PROJECT_NAME=proj
run "$SRC" >/dev/null
FH="$T/fleets/proj"; [ -d "$FH/.git" ] && ok "clone mode creates the fleet home" || bad "clone mode creates the fleet home"
# origin moves ahead: fast-forward
git -C "$SRC" commit -q --allow-empty -m next; git -C "$SRC" push -q origin main
run "$SRC" >/dev/null
[ "$(git -C "$FH" rev-parse HEAD)" = "$(git -C "$SRC" rev-parse HEAD)" ] && ok "fleet home fast-forwarded" || bad "fleet home fast-forwarded"
# the fleet home has a commit of its own, origin has another: diverged, nothing changes
git -C "$FH" commit -q --allow-empty -m fleet-own; before="$(git -C "$FH" rev-parse HEAD)"
git -C "$SRC" commit -q --allow-empty -m other; git -C "$SRC" push -q origin main
out="$(run "$SRC")"; rc=$?
[ "$rc" = 2 ] && echo "$out" | grep -q "diverged" && [ "$(git -C "$FH" rev-parse HEAD)" = "$before" ] && ok "diverged fleet home: stops, keeps its commit" || bad "diverged fleet home: stops, keeps its commit (rc=$rc)"
# fleet home ahead of origin only: left alone
git -C "$FH" reset -q --hard "$(git -C "$SRC" rev-parse HEAD)"; git -C "$FH" commit -q --allow-empty -m ahead; before="$(git -C "$FH" rev-parse HEAD)"
run "$SRC" >/dev/null
[ "$(git -C "$FH" rev-parse HEAD)" = "$before" ] && ok "fleet home ahead of origin: not reset" || bad "fleet home ahead of origin: not reset"

realhome_check || fail=1
[ "$fail" = 0 ] && echo "installer safety OK" || { echo "installer safety FAILED"; exit 1; }
