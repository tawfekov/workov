#!/usr/bin/env bash
# Home folder consent: the installer writes outside the project only with --with-home (or WV_WITH_HOME=1) or a yes at
# the prompt, and saves every file it overwrites to ~/.workov/backups/<time>/. HOME is a temp folder here.
# (The interactive prompt needs a terminal, so only its non-interactive side is covered: no flag and no terminal = skip.)
set -u
. "$(dirname "$0")/lib-realhome.sh"; realhome_snapshot
HERE="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
fail=0; ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; fail=1; }

WF="$T/wf"; mkdir -p "$WF/.claude/scripts"
printf '#!/usr/bin/env bash\nexit 0\n' > "$WF/.claude/scripts/install.sh"
R="$T/repo"; mkdir -p "$R"; git -C "$R" init -q -b main; echo x > "$R/a.txt"; git -C "$R" add -A; git -C "$R" commit -q -m init
run() { bash "$HERE/install.sh" "$R" --in-place --base "$WF" --no-setup 2>&1 </dev/null; }
home_files() { find "$HOME" -type f -not -path "$HOME/.workov/*" 2>/dev/null | sort; }

# 1. no flag, no terminal: nothing is written outside the project
export HOME="$T/h1"; mkdir -p "$HOME"
out="$(run)"
[ -z "$(home_files)" ] && ok "no flag: no file written in the home folder" || bad "no flag: no file written in the home folder: $(home_files)"
echo "$out" | grep -q "skipped the home folder files" && ok "no flag: says what was skipped" || bad "no flag: says what was skipped"
[ -d "$R/.claude" ] && ok "no flag: the project part still installs" || bad "no flag: the project part still installs"

# 2. --with-home installs them
out="$(bash "$HERE/install.sh" "$R" --in-place --base "$WF" --no-setup --with-home 2>&1 </dev/null)"
for f in .claude/commands/task.md .claude/wv-fleet/land.cjs .config/opencode/plugins/approvals.js; do
  [ -f "$HOME/$f" ] && ok "--with-home wrote ~/$f" || bad "--with-home wrote ~/$f"
done
[ ! -d "$HOME/.workov/backups" ] && ok "identical files: no backup made" || bad "identical files: no backup made"

# 3. a different file is backed up before it is replaced
echo "my own task command" > "$HOME/.claude/commands/task.md"
out="$(bash "$HERE/install.sh" "$R" --in-place --base "$WF" --no-setup --with-home 2>&1 </dev/null)"
b="$(ls "$HOME"/.workov/backups/*/.claude/commands/task.md 2>/dev/null | head -1)"
[ -n "$b" ] && grep -q "my own task command" "$b" && ok "a replaced file is backed up first" || bad "a replaced file is backed up first"
cmp -s "$HERE/commands/task.md" "$HOME/.claude/commands/task.md" && ok "and the new one is installed" || bad "and the new one is installed"

# 4. WV_WITH_HOME=1 (what a desktop app passes) works like the flag
export HOME="$T/h2"; mkdir -p "$HOME"
WV_WITH_HOME=1 bash "$HERE/install.sh" "$R" --in-place --base "$WF" --no-setup >/dev/null 2>&1 </dev/null
[ -f "$HOME/.claude/commands/task.md" ] && ok "WV_WITH_HOME=1 gives consent" || bad "WV_WITH_HOME=1 gives consent"

# 5. --no-command still skips everything, even with --with-home
export HOME="$T/h3"; mkdir -p "$HOME"
bash "$HERE/install.sh" "$R" --in-place --base "$WF" --no-setup --no-command --with-home >/dev/null 2>&1 </dev/null
[ -z "$(home_files)" ] && ok "--no-command writes nothing in the home folder" || bad "--no-command writes nothing in the home folder"

realhome_check || fail=1
[ "$fail" = 0 ] && echo "home consent OK" || { echo "home consent FAILED"; exit 1; }
