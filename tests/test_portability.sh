#!/usr/bin/env bash
# Portability: the router is told the shell its agents really use, and nothing is assumed about the project's stack.
#   1. the shell sentence per platform matches its snapshot (tests/snapshots/); the platform maps to the right shell
#   2. router-loop.sh builds its prompt from shell-note.sh and stack.cjs, with no hard-coded Windows shell left
#   3. the prompt itself, built per platform (and its Claude-runtime variant), carries the right sentence, keeps the stack note and prints
#      no "command not found" (the old line held a double-quoted $(...) that bash RAN every cycle)
#   4. the `stack` setting survives the base installer's apply-setup.py
# Update a snapshot on purpose with: bash overlay/.claude/scripts/shell-note.sh <powershell|posix> > tests/snapshots/shell-note.<kind>.txt
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
. "$HERE/tests/lib-realhome.sh"; realhome_snapshot
NOTE="$HERE/overlay/.claude/scripts/shell-note.sh"
LOOP="$HERE/overlay/.claude/scripts/router-loop.sh"
fail=0; ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; fail=1; }

# 1. snapshots and platform mapping
for kind in powershell posix; do
  [ "$(bash "$NOTE" "$kind")" = "$(cat "$HERE/tests/snapshots/shell-note.$kind.txt")" ] && ok "shell sentence for $kind matches its snapshot" || bad "shell sentence for $kind changed (see tests/snapshots)"
done
pick() { WV_UNAME="$1" WV_AGENT_SHELL="${2:-}" bash "$NOTE"; }
ps="$(cat "$HERE/tests/snapshots/shell-note.powershell.txt")"; px="$(cat "$HERE/tests/snapshots/shell-note.posix.txt")"
for u in Linux Darwin FreeBSD; do [ "$(pick $u)" = "$px" ] && ok "$u -> posix" || bad "$u -> posix"; done
for u in MINGW64_NT-10.0-26300 MSYS_NT-10.0 CYGWIN_NT-10.0; do [ "$(pick $u)" = "$ps" ] && ok "$u -> powershell" || bad "$u -> powershell"; done
[ "$(pick MINGW64_NT-10.0 posix)" = "$px" ] && ok "WV_AGENT_SHELL=posix overrides Windows (agents in Git Bash or WSL)" || bad "WV_AGENT_SHELL=posix overrides Windows"
[ "$(pick Linux powershell)" = "$ps" ] && ok "WV_AGENT_SHELL=powershell overrides Linux (pwsh)" || bad "WV_AGENT_SHELL=powershell overrides Linux"
bash "$NOTE" banana >/dev/null 2>&1; [ "$?" = 2 ] && ok "an unknown shell is refused" || bad "an unknown shell is refused"
echo "$ps" | grep -q -F '$(...)' && ok 'the PowerShell sentence keeps the literal $(...)' || bad 'the PowerShell sentence lost the literal $(...)'

# 2. the loop is wired to both helpers and no longer hard-codes a shell
grep -q -F 'shell-note.sh' "$LOOP" && grep -q -F 'stack.cjs' "$LOOP" && ok "router-loop.sh calls shell-note.sh and stack.cjs" || bad "router-loop.sh calls shell-note.sh and stack.cjs"
grep -q -F 'Windows PowerShell' "$LOOP" && bad "router-loop.sh still hard-codes Windows PowerShell" || ok "router-loop.sh hard-codes no shell"

# 3. the prompt, built per platform from the loop's own lines (CTX_HEAD / CTX_SHELL / CTX_TAIL / CTX, and the Claude variant CTXC)
ctxlines="$(grep -E '^  (CTX_HEAD|CTX_SHELL|CTX_TAIL|CTX)=' "$LOOP")"
claudeline="$(grep -E '^    CTXC=' "$LOOP" | sed 's/^ *//')"
[ -n "$ctxlines" ] && [ -n "$claudeline" ] || bad "could not find the prompt lines in router-loop.sh"
for kind in powershell posix; do
  err="$( { NAME=demo ROOT=/tmp/demo SHELL_NOTE="$(bash "$NOTE" $kind)" STACK_NOTE="This project's stack is node (npm)."; eval "$ctxlines"; eval "$claudeline"; printf '%s' "$CTX" > /tmp/wv-ctx.$$; printf '%s' "$CTXC" > /tmp/wv-ctxc.$$; } 2>&1 >/dev/null )"
  ctx="$(cat /tmp/wv-ctx.$$ 2>/dev/null)"; ctxc="$(cat /tmp/wv-ctxc.$$ 2>/dev/null)"; rm -f /tmp/wv-ctx.$$ /tmp/wv-ctxc.$$
  snap="$(cat "$HERE/tests/snapshots/shell-note.$kind.txt")"
  [ -z "$err" ] && ok "the $kind prompt prints no errors" || bad "the $kind prompt printed: $err"
  echo "$ctx" | grep -q -F "$snap" && echo "$ctx" | grep -q -F "This project's stack is node" && echo "$ctx" | grep -q -F "Do not touch any other project." && ok "the $kind prompt carries its shell sentence, the stack note and the project rule" || bad "the $kind prompt is incomplete"
  echo "$ctxc" | grep -q -F "$snap" && bad "the Claude-runtime prompt still carries the $kind shell sentence" || ok "the Claude-runtime prompt drops the $kind shell sentence"
  echo "$ctxc" | grep -q -F "instead of shell commands" && bad "the Claude-runtime prompt still tells the agent to avoid shell commands" || ok "and the file-work sentence"
  echo "$ctxc" | grep -q -F "This project's stack is node" && echo "$ctxc" | grep -q -F "Do not touch any other project." && ok "but keeps the stack note and the project rule" || bad "the Claude-runtime prompt lost the stack note or the project rule"
done

# 4. the stack setting survives apply-setup.py (the base installer step that rewrites specs/workov.config.json)
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
if git clone -q "$HERE" "$T/c" 2>/dev/null && [ -f "$T/c/.claude/scripts/apply-setup.py" ]; then
  mkdir -p "$T/h"
  ( cd "$T/c" && python3 -I -c "
import json
p='specs/workov.config.json'
c=json.load(open(p)); c['stack']={'commands':{'test':'make check'}}
json.dump(c,open(p,'w'),indent=2)" \
    && HOME="$T/h" USERPROFILE="$T/h" python3 .claude/scripts/apply-setup.py --preset custom --harness opencode --landing pr --max-workers 2 --main-port 4200 --dashboard on --tunnel local --budget-usd 3 >/dev/null 2>&1 \
    && python3 -I -c "
import json,sys
sys.exit(0 if json.load(open('specs/workov.config.json')).get('stack',{}).get('commands',{}).get('test')=='make check' else 1)" ) \
    && ok "the stack setting survives apply-setup.py" || bad "the stack setting survives apply-setup.py"
else
  echo "skip the apply-setup check (could not clone $HERE)"
fi

realhome_check || fail=1
[ "$fail" = 0 ] && echo "portability OK" || { echo "portability FAILED"; exit 1; }
