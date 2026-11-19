#!/usr/bin/env bash
# check-standalone.sh <git-ref> [--repo <dir>] [--providers <ref pattern>]
# Does one pull request stand on its own? Takes the PR's branch (or any ref), exports it to a temp folder and checks:
#   1. references:  every file its scripts call is shipped by the PR or guarded by an existence test (scripts/standalone-refs.cjs);
#      with --providers the report says which other PR ships each missing file, which is the dependency order
#   2. syntax:      every script parses (scripts/check-syntax.sh)
#   3. install:     if the PR has an install.sh, it installs into a throwaway repository with a throwaway home folder and exits 0
# A PR that adds files to a kit another PR installs has no install.sh; step 3 then says so and is skipped.
# Example:  bash scripts/check-standalone.sh pr1/02-pipeline-scripts --providers 'refs/remotes/pr1/*'
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REF="${1:-}"; [ -n "$REF" ] || { sed -n 2,11p "$0" | sed 's/^# \{0,1\}//'; exit 2; }
shift
REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; PROV=""
while [ $# -gt 0 ]; do
  case "$1" in --repo) REPO="$2"; shift 2 ;; --providers) PROV="$2"; shift 2 ;; *) echo "unknown option $1" >&2; exit 2 ;; esac
done
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/pr"
git -C "$REPO" archive "$REF" 2>/dev/null | tar -x -C "$T/pr" || { echo "cannot export $REF from $REPO" >&2; exit 2; }
rc=0; ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; rc=1; }
echo "== $REF"

# 1. references
refargs=("$T/pr")
[ -n "$PROV" ] && refargs+=(--repo "$REPO" --providers "$PROV")
out="$(node "$HERE/standalone-refs.cjs" "${refargs[@]}" 2>&1)"; r=$?
echo "$out" | sed 's/^/     /'
[ "$r" = 0 ] && ok "references: nothing unguarded is missing" || bad "references: files this PR calls but does not ship"

# 2. syntax
if out="$(bash "$HERE/check-syntax.sh" "$T/pr" 2>&1)"; then ok "syntax: $(echo "$out" | tail -2 | head -1)"; else bad "syntax"; echo "$out" | tail -8 | sed 's/^/     /'; fi

# 3. install alone
if [ -f "$T/pr/install.sh" ]; then
  mkdir -p "$T/home" "$T/target"
  git -C "$T/target" init -q -b main
  echo x > "$T/target/a.txt"; git -C "$T/target" add -A
  git -C "$T/target" -c user.name=t -c user.email=t@t commit -q -m init
  flags="--in-place --no-setup"   # plus the consent and approvals flags, for an installer that knows them (an older one would take them for a path)
  grep -q -- "--with-home" "$T/pr/install.sh" && flags="$flags --with-home"
  grep -q -- "--approvals" "$T/pr/install.sh" && flags="$flags --approvals ask"
  out="$(HOME="$T/home" USERPROFILE="$T/home" bash "$T/pr/install.sh" "$T/target" $flags 2>&1 </dev/null)"; r=$?
  [ "$r" = 0 ] && ok "install: installs alone into a throwaway repository" || { bad "install: exit $r"; echo "$out" | tail -8 | sed 's/^/     /'; }
else
  echo "skip install: this PR has no install.sh (it adds files to a kit that another PR installs)"
fi
exit "$rc"
