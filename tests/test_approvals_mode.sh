#!/usr/bin/env bash
# Approvals mode as a setting, installer side (HOME is a temp folder; the real ~/.workov must stay untouched).
#   fresh install (no terminal) -> ask      --approvals sets it      a recorded choice is kept
#   an install that already existed, no choice yet -> auto-safe (a reinstall must not stall a running fleet)
#   other keys in settings.json survive      a bad value is refused
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
. "$HERE/tests/lib-realhome.sh"; realhome_snapshot
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
fail=0; ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; fail=1; }

WF="$T/wf"; mkdir -p "$WF/.claude/scripts"; printf '#!/usr/bin/env bash\nexit 0\n' > "$WF/.claude/scripts/install.sh"
R="$T/repo"; mkdir -p "$R"; git -C "$R" init -q -b main; echo x > "$R/a.txt"; git -C "$R" add -A; git -C "$R" commit -q -m init
inst() { bash "$HERE/install.sh" "$R" --in-place --base "$WF" --no-setup --no-command "$@" 2>&1 </dev/null; }
mode() { python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))['approvals']['mode'])" "$HOME/.workov/settings.json" 2>/dev/null | tr -d '\r'; }

# 1. fresh machine, no terminal: the default is ask
export HOME="$T/h1"; mkdir -p "$HOME"; inst >/dev/null
[ "$(mode)" = ask ] && ok "fresh install: ask" || bad "fresh install: ask (got '$(mode)')"
# 2. --approvals sets it, and a later run without the flag keeps it
inst --approvals auto-safe >/dev/null; [ "$(mode)" = auto-safe ] && ok "--approvals auto-safe is written" || bad "--approvals auto-safe is written"
inst >/dev/null; [ "$(mode)" = auto-safe ] && ok "a recorded choice is kept on the next install" || bad "a recorded choice is kept"
# 3. an install that already existed, no choice yet: keep today's behaviour
export HOME="$T/h2"; mkdir -p "$HOME/.workov"; echo '[{"name":"x","root":"/x"}]' > "$HOME/.workov/fleets.json"
out="$(inst)"; [ "$(mode)" = auto-safe ] && ok "existing install without a choice: auto-safe, so the fleet is not stalled" || bad "existing install: auto-safe (got '$(mode)')"
echo "$out" | grep -q "already ran the fleet that way" && ok "and it says why" || bad "and it says why"
# 4. ...unless you choose ask
inst --approvals ask >/dev/null; [ "$(mode)" = ask ] && ok "existing install, --approvals ask" || bad "existing install, --approvals ask"
# 5. other keys in settings.json survive
export HOME="$T/h3"; mkdir -p "$HOME/.workov"; echo '{"other": 1, "approvals": {"mode": "ask", "x": 2}}' > "$HOME/.workov/settings.json"
inst --approvals auto-safe >/dev/null
python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d['other']==1 and d['approvals']['x']==2 and d['approvals']['mode']=='auto-safe' else 1)" "$HOME/.workov/settings.json" && ok "other settings are preserved" || bad "other settings are preserved"
# 6. a bad value is refused
inst --approvals banana >/dev/null; [ "$?" = 2 ] && ok "a bad value is refused" || bad "a bad value is refused"

realhome_check || fail=1
[ "$fail" = 0 ] && echo "approvals mode (installer) OK" || { echo "approvals mode (installer) FAILED"; exit 1; }
