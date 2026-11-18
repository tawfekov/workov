#!/usr/bin/env bash
# Workov: THE router. One loop and one OpenCode router session serve every project registered in ~/.workov/fleets.json,
# one project per cycle. `opencode run --agent router` ends when the router finishes one cycle and cannot be woken on Windows,
# so this loop starts the next cycle every WV_ROUTER_INTERVAL seconds (default 90) for as long as any project needs the
# router, then exits. wv-turn.py --pick chooses the project (fair turns, one worker at a time on the computer) and the cycle
# message names it. The permission plugin (.opencode/wv/router-scope.mjs) keeps the router inside that project's folder.
# It runs from the hub only (the folder whose dashboard serves the board); another project's folder does nothing.
# Usage: bash .claude/scripts/router-loop.sh
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
HOME_DIR="$HOME/.workov"
HERE="$(cygpath -m "$(pwd)" 2>/dev/null || pwd)"
HUB="$(python3 -I - "$HOME_DIR/hub.json" <<'PYHUB'
import json, sys
try:
    print(str(json.load(open(sys.argv[1], encoding="utf-8")).get("root", "")).replace(chr(92), "/").rstrip("/"))
except Exception:
    pass
PYHUB
)"
HUB="$(printf '%s' "$HUB" | tr -d '\r')"
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
SAME="$(python3 -I -c "import os,sys;print(int(os.path.exists(sys.argv[1]) and os.path.samefile(sys.argv[1], sys.argv[2])))" "$HUB" "$HERE" 2>/dev/null | tr -d '\r\n')"
if [ -n "$HUB" ] && [ "$SAME" = "0" ] && [ -d "$HUB/job" ]; then
  echo "the one router runs from $HUB; nothing to do here"
  exit 0
fi
mkdir -p job
PIDFILE=job/router-loop.pid
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "router loop already running (pid $(cat "$PIDFILE"))"; exit 0; fi
echo $$ > "$PIDFILE"
# when the loop ends (nothing left to do, or the fleet was stopped) nothing it started may keep running
# zero-token guard while the loop runs: one worker per ticket and one worker on the computer, enforced every 20 s, not once per
# (slow) router cycle, so a duplicate dispatch lives seconds, never minutes
( while sleep 20; do python3 -I "$HOME/.wv-bin/wv-sessions.py" reap >/dev/null 2>&1; python3 -I "$HOME/.wv-bin/wv-gate.py" >/dev/null 2>&1; python3 -I "$HOME/.wv-bin/wv-dispatch.py" >/dev/null 2>&1; python3 -I "$HOME/.wv-bin/wv-adopt.py" >/dev/null 2>&1; python3 -I "$HOME/.wv-bin/wv-plan.py" >/dev/null 2>&1; done ) &
GUARD_PID=$!
trap 'kill "$GUARD_PID" 2>/dev/null; rm -f "$PIDFILE" "$HOME_DIR/router-project.json"; python3 -I "$HOME/.wv-bin/wv-stop.py" >/dev/null 2>&1' EXIT
INTERVAL="${WV_ROUTER_INTERVAL:-90}"
export WV_APPROVALS="${WV_APPROVALS:-auto}"
# heavy pnpm/npm commands (test, lint, build, install) wait their turn machine-wide
export PATH="$HOME/.wv-bin:$PATH"
# bash agents call the real pnpm/ng directly; this makes them go through the same lock
export BASH_ENV="$HOME/.wv-bin/wv-bashenv.sh"

# one worker at a time across every project: tell the router when another project's worker is running
busy_note() {
  local b
  b="$(python3 -I "$HOME/.wv-bin/wv-busy.py" "$1" 2>/dev/null | tr -d '\r')"
  [ -n "$b" ] && printf ' DISPATCH PAUSED: this computer runs one worker at a time and %s has a worker running. Do not start any worker this cycle (no new dispatch, no new worktree); keep reconciling and answering decisions, and say in your one summary line that dispatch is waiting for %s.' "$b" "$b"
  return 0
}
# a worker session that is already running for a ticket of this project must be adopted, never dispatched a second time
live_note() {
  local t
  t="$(python3 -I "$HOME/.wv-bin/wv-sessions.py" live "$1" 2>/dev/null | cut -f2 | sort -u | tr -s '[:space:]' ' ')"
  [ -n "$t" ] && printf ' A WORKER IS ALREADY RUNNING for ticket(s) %s of this project. Do NOT dispatch or spawn another worker for them and do NOT mark them failed: set the board row to in-progress if it is still ready, record it in the ledger (dispatched, attempt 1 unless it is a retry you started), and only watch it.' "$t"
  return 0
}
# workers are sessions of their own, started by the fleet (wv-dispatch.py), not subagents of the router: the router must never spawn one
workers_note() {
  printf ' WORKERS ARE NOT YOURS: the fleet starts every worker itself (a separate session per ticket) and records it in the ledger and on the board. NEVER spawn a worker, teammate or any long-running subagent and never wait for a worker to finish: your cycle is short. Do only the reconcile, verify, land, decision and intent work, then end your turn.'
  return 0
}
latest_router_session() {
  python3 -I - "$(cygpath -m "$NEUTRAL" 2>/dev/null || echo "$NEUTRAL")" <<'PY'
import os, sqlite3, sys
db = os.environ.get("OPENCODE_DB") or os.path.join(os.path.expanduser("~"), ".local", "share", "opencode", "opencode.db")
root = sys.argv[1].replace("\\", "/").rstrip("/").lower()
try:
    con = sqlite3.connect("file:" + db.replace("\\", "/") + "?mode=ro", uri=True, timeout=5)
    for sid, d in con.execute("SELECT id, directory FROM session_v2 WHERE agent = 'router' AND parent_id IS NULL ORDER BY time_created DESC LIMIT 20"):
        if (d or "").replace("\\", "/").rstrip("/").lower().endswith(root.split(":", 1)[-1]):
            print(sid); break
except Exception:
    pass
PY
}
# The router runs from a neutral folder that belongs to no project, so a relative path it writes by mistake can never touch a
# project's files (it lands here, harmlessly). Its agent files and model settings are copied from this hub every cycle.
NEUTRAL="${WV_ROUTER_HOME:-$HOME/Workov/router}"
mkdir -p "$NEUTRAL/.opencode" "$NEUTRAL/job"
[ -d "$NEUTRAL/.git" ] || git -C "$NEUTRAL" init -q 2>/dev/null
sync_router() {
  rm -rf "$NEUTRAL/.opencode/agents" && cp -r "$HERE/.opencode/agents" "$NEUTRAL/.opencode/agents" 2>/dev/null
  cp "$HERE/opencode.json" "$NEUTRAL/opencode.json" 2>/dev/null
  # the permission policy for the router and every worker it runs from here (denies, one worker at a time), whatever env the OpenCode service has
  mkdir -p "$NEUTRAL/.opencode/plugins" && cp "$HERE/.opencode/plugins/approvals.js" "$NEUTRAL/.opencode/plugins/approvals.js" 2>/dev/null
  : > "$NEUTRAL/.wv-router"
  return 0
}
oc() { ( cd "$NEUTRAL" && opencode "$@" ); }
SID="${WV_ROUTER_SESSION:-}"
FIRST="Run the fleet for this project. Reconcile job/router-state.json first: a worker listed there may still be alive inside OpenCode (check its job/status.json heartbeat and its session) before you re-dispatch it. Dispatch every ready ticket, verify finished ones against eval.md, and land them per their Landing mode. Do one full cycle, then end your turn; you will be called again."
NEXT="Next router cycle for this project: reconcile, read worker heartbeats and results, dispatch ready tickets, verify and land finished ones, answer or record pending decisions. Then end your turn."
while true; do
  # one fleet, one worker: stop worker sessions that must not run (failed/done tickets, duplicates, a second worker), then
  # hand answers nobody is waiting for back to the pipeline, before the router looks at anything
  python3 -I "$HOME/.wv-bin/wv-sessions.py" reap 2>&1 | tr -d '\r' | sed 's/^/[router-loop] /'
  python3 -I "$HOME/.wv-bin/wv-gate.py" 2>&1 | sed 's/^/[router-loop] /'
  python3 -I "$HOME/.wv-bin/wv-plan.py" 2>&1 | sed 's/^/[router-loop] /'
  python3 -I "$HOME/.wv-bin/wv-settle.py" 2>&1 | tr -d '\r' | sed 's/^/[router-loop] /'
  PICK="$(python3 -I "$HOME/.wv-bin/wv-turn.py" --pick | tr -d '\r')"
  case "$PICK" in
    run*) ;;
    *) echo "[router-loop] ${PICK:-no project needs the router}: stopping"; break ;;
  esac
  NAME="$(printf '%s' "$PICK" | cut -f2)"
  ROOT="$(printf '%s' "$PICK" | cut -f3)"
  printf '{"name": "%s", "root": "%s", "at": "%s"}\n' "$NAME" "$ROOT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HOME_DIR/router-project.json"
  CTX="PROJECT $NAME, HOME $ROOT. This cycle is only about this project. Every path in your instructions that starts with job/, specs/, .claude/ or .opencode/ means that path under HOME (use the absolute path), and every git or script command must name the project explicitly: git -C \"$ROOT\" ..., or a script by its absolute path with the project as an argument. Your shell is Windows PowerShell 5.1: NEVER chain commands with && or ||, never use bash-only syntax (export, heredocs, $(...), VAR=x cmd); run one simple command per call. For file work use your Read, Glob, Grep, Write and Edit tools instead of shell commands. Do not touch any other project."
  echo "[router-loop] cycle for $NAME"
  if [ -z "$SID" ]; then
    sync_router
    oc run --auto --agent router "$CTX $FIRST$(busy_note "$ROOT")$(live_note "$ROOT")$(workers_note)"
    SID="$(latest_router_session | tr -d '\r')"
    echo "[router-loop] router session: ${SID:-unknown}"
  else
    sync_router
    oc run --auto --agent router --session "$SID" "$CTX $NEXT$(busy_note "$ROOT")$(live_note "$ROOT")$(workers_note)"
  fi
  sleep "$INTERVAL"
done
echo "[router-loop] no project is specifying, ready, in progress or waiting for its answer to be forwarded: stopping"
