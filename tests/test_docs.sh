#!/usr/bin/env bash
# Docs stay in step with the installer: every option install.sh accepts, and every setting it or the plugin reads, is in the README
# and in `install.sh --help`. Add an option without documenting it and this fails.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
README="$HERE/README.md"
fail=0; ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; fail=1; }

# options = the long flags in install.sh's argument loop (lines like:    --force) FORCE=1; ...)
flags="$(sed -n '/^while \[ \$# -gt 0 \]/,/^done/p' "$HERE/install.sh" | grep -oE '^[[:space:]]+(-[a-z-]+\|)?--[a-z-]+\)' | grep -oE -- '--[a-z-]+' | grep -v -- '--help' | sort -u)"
[ -n "$flags" ] || bad "could not read the options from install.sh"
help="$(bash "$HERE/install.sh" --help 2>&1)"
for f in $flags; do
  grep -q -E -- '`'"$f"'[` ]' "$README" && ok "README documents $f" || bad "README is missing $f"
  echo "$help" | grep -q -F -- "$f" && ok "--help documents $f" || bad "--help is missing $f"
done

# settings and environment variables the kit reads
for v in WV_APPROVALS WV_POLICY WV_WITH_HOME WV_AGENT_SHELL; do
  grep -q "$v" "$README" && ok "README documents $v" || bad "README is missing $v"
done
for w in "ask" "auto-safe" "policy-warn.jsonl" "settings.json" "check-syntax.sh" "stack.cjs" "run-all.sh" "shell-note.sh" "check-standalone.sh"; do
  grep -q -F -- "$w" "$README" && ok "README mentions $w" || bad "README is missing $w"
done
# the --base warning must stay
grep -q -F 'is run on your machine' "$README" && ok "README warns that --base runs the other repository's installer" || bad "README lost the --base warning"
echo "$help" | grep -q -i 'only use a base you trust' && ok "--help warns about --base" || bad "--help lost the --base warning"

[ "$fail" = 0 ] && echo "docs OK" || { echo "docs FAILED"; exit 1; }
