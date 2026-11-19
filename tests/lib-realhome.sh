# Guard for installer tests: a test must never touch the real ~/.workov (fleets.json, settings.json, hub.json).
# Source this, call realhome_snapshot BEFORE changing HOME, and realhome_check at the end (it prints ok/FAIL and returns 1 on FAIL).
realhome_sum() { cat "$REAL_WV/fleets.json" "$REAL_WV/settings.json" "$REAL_WV/hub.json" 2>/dev/null | cksum; }
realhome_snapshot() { REAL_WV="$HOME/.workov"; REAL_SUM="$(realhome_sum)"; }
realhome_check() {
  if [ "$(realhome_sum)" = "$REAL_SUM" ]; then echo "ok   the real ~/.workov was not touched"; else echo "FAIL the real ~/.workov changed during the test"; return 1; fi
}
