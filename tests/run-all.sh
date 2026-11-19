#!/usr/bin/env bash
# Run the syntax check and every test: bash tests/run-all.sh
# Works on Linux, macOS and Windows (Git Bash). Needs bash, git, node and python3. Prints a one-line summary per step and a final verdict.
cd "$(dirname "$0")/.." || exit 2
fail=0; passed=0; failed=""
run() {
  local label="$1"; shift
  local out; out="$("$@" 2>&1)"; local rc=$?
  if [ "$rc" = 0 ]; then passed=$((passed + 1)); printf 'ok     %s\n' "$label"
  else fail=1; failed="$failed $label"; printf 'FAILED %s\n' "$label"; printf '%s\n' "$out" | grep -v 'warning: in the working copy' | tail -25 | sed 's/^/       /'; fi
}
run "syntax check (scripts/check-syntax.sh)" bash scripts/check-syntax.sh
for t in tests/test_*.sh; do [ -f "$t" ] && run "$t" bash "$t"; done
for t in tests/test_*.cjs; do [ -f "$t" ] && run "$t" node "$t"; done
echo
if [ "$fail" = 0 ]; then echo "ALL OK ($passed steps)"; else echo "FAILED:$failed"; exit 1; fi
