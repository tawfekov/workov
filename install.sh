#!/usr/bin/env bash
# Workov kit installer: the Workov base (this repository's .claude/, .opencode/, specs/) + the kit layer (PR / MR
# landing, OpenCode Go models, permission approvals, mockup tab, one dashboard for every project, the stage pipeline,
# Copilot/Kilo/Antigravity implementers) + the /task command.
#
#   bash install.sh <target-repo> [options]
#   bash install.sh --hub [dir]      the neutral hub (default ~/Workov/hub): dashboard + router, no tickets, not a project
#
# Options:
#   --base <path-or-git-url>   the Workov base to install (default: this repository). A git URL is cloned and ITS
#                              .claude/scripts/install.sh is RUN on this machine: only use a base you trust.
#   --in-place                 install straight into <target-repo> (default: a fleet clone under ~/Workov/fleets/<name>)
#   --no-setup                 skip the models and landing setup
#   --no-command               skip every file in your home folder (the /task command, the plugin, ~/.wv-bin, the policy)
#   --with-home                write those home-folder files without asking (or set WV_WITH_HOME=1). Without a terminal and
#                              without this flag they are skipped. A file that would be replaced is saved to ~/.workov/backups/<time>/
#   --approvals ask|auto-safe  what an agent does when the command policy neither allows nor denies something:
#                              ask waits for you, auto-safe goes ahead (what is denied is refused in both). Kept in
#                              ~/.workov/settings.json. Default: ask; a machine that already ran the fleet stays on auto-safe
#   --force                    install into a target that has uncommitted changes (they are kept; a copy is saved first)
#
# Without --force the installer stops if the target has uncommitted changes to tracked files.
# Everything installed into the target repo stays out of git (written to .git/info/exclude); tracked files the
# base installer would replace are restored. Requires: git, bash, node, a real python 3; opencode for the fleet.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# The home folder as bash sees it ($HOME), in a form Python understands. On Windows Python ignores $HOME and reads USERPROFILE, so
# without this a run with HOME pointed elsewhere (a test, a sandbox) would still write into the real ~/.workov.
export WV_HOME_DIR="$(cygpath -m "$HOME" 2>/dev/null || printf %s "$HOME")"
TARGET=""; WF=""; DO_COMMAND=1; DO_SETUP=1; IN_PLACE=0; HUB_MODE=0; FORCE=0; WITH_HOME="${WV_WITH_HOME:-0}"; APPROVALS_FLAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --approvals) APPROVALS_FLAG="${2:-}"; shift 2 ;;
    --with-home) WITH_HOME=1; shift ;;
    --force) FORCE=1; shift ;;
    --base) WF="$2"; shift 2 ;;
    --no-command) DO_COMMAND=0; shift ;;
    --no-setup) DO_SETUP=0; shift ;;
    --in-place) IN_PLACE=1; shift ;;
    --hub) HUB_MODE=1; IN_PLACE=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
    *) TARGET="$1"; shift ;;
  esac
done
# --hub: the NEUTRAL hub (default ~/Workov/hub): the dashboard, the router loop, the shared config and the auth token live in a folder
# that belongs to no project and has no tickets. It is a git root (dashboard-server.py needs one) but is never listed in fleets.json.
if [ "$HUB_MODE" = 1 ]; then
  [ -n "$TARGET" ] || TARGET="${WV_HUB_DIR:-$HOME/Workov/hub}"
  mkdir -p "$TARGET"
  if [ ! -e "$TARGET/.git" ]; then
    git -C "$TARGET" init -q
    mkdir -p "$TARGET/specs/tickets"
    printf '# Ticket Board

The neutral Workov hub: no tickets live here. Every project keeps its own board in its own folder.

| #   | Title | Status | Mode | Prio | Runs |
| --- | --- | --- | --- | --- | --- |
' > "$TARGET/specs/tickets/BOARD.md"
    git -C "$TARGET" add specs/tickets/BOARD.md
    git -C "$TARGET" -c user.name=Workov -c user.email=workov@localhost commit -q -m "chore: neutral hub"
  fi
fi
case "$APPROVALS_FLAG" in ""|ask|auto-safe) ;; *) echo "--approvals takes ask or auto-safe, not '$APPROVALS_FLAG'" >&2; exit 2 ;; esac
# An install that already exists on this machine (checked before anything below writes to ~/.workov): its agents run unattended today.
EXISTING_INSTALL=0
[ -s "$HOME/.workov/fleets.json" ] && [ "$(cat "$HOME/.workov/fleets.json")" != "[]" ] && EXISTING_INSTALL=1
[ -f "$HOME/.workov/hub.json" ] && EXISTING_INSTALL=1
[ -n "$TARGET" ] && [ -d "$TARGET/.git" -o -f "$TARGET/.git" ] || { echo "usage: bash install.sh <target-repo> [--base <path-or-git-url>]" >&2; exit 2; }
if [ -z "$WF" ]; then
  [ -f "$HERE/.claude/scripts/install.sh" ] || { echo "missing --base <path-or-git-url>: $HERE is not a Workov checkout (no .claude/scripts/install.sh)" >&2; exit 2; }
  WF="$HERE"
fi
TARGET="$(cd "$TARGET" && pwd)"

# Tracked files with uncommitted changes (staged or not). The installer replaces some tracked files and restores them
# afterwards; a file you had already changed must never be one of them.
dirty_files() { git -C "$1" diff HEAD --name-only; }
require_clean() {
  local d; d="$(dirty_files "$1")"
  [ -n "$d" ] || return 0
  if [ "$FORCE" = 1 ]; then
    echo "warning: $1 has uncommitted changes; --force keeps them and only restores files this install changes:" >&2
    echo "$d" | sed 's/^/  /' >&2
    return 0
  fi
  echo "refusing to install: $1 has uncommitted changes to tracked files:" >&2
  echo "$d" | sed 's/^/  /' >&2
  echo "commit or stash them first, or run again with --force (they are kept, and a copy is saved to ~/.workov/backups/)." >&2
  exit 2
}
# Put back the tracked files an installer step replaced, except the ones that were already modified before the install.
restore_replaced() {
  local f n=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ -n "$PRE_DIRTY" ] && printf '%s\n' "$PRE_DIRTY" | grep -qxF -- "$f"; then continue; fi
    [ "$n" = 0 ] && echo "restoring tracked files the installer replaced:"
    echo "  $f"; n=$((n+1))
    git -C "$TARGET" checkout -- "$f"
  done < <(git -C "$TARGET" diff --name-only)
}

# One backup folder per run, created only when something needs saving.
bk_dir() { [ -n "${BK:-}" ] || { BK="$HOME/.workov/backups/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$BK"; }; }
# put_home <source> <dest>: copy into the home folder, saving what it replaces (when the content differs).
put_home() {
  local src="$1" dest="$2" rel
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ] && ! cmp -s "$src" "$dest"; then
    bk_dir; rel="${dest#"$HOME"/}"; mkdir -p "$BK/$(dirname "$rel")"; cp -p "$dest" "$BK/$rel"
    echo "  backed up $dest -> $BK/$rel"
  fi
  cp "$src" "$dest"
}

# A project's fleet lives in its own managed folder (a clone under ~/Workov/fleets/<name>), so your working copy never
# gets fleet files, an edited opencode.json or a job/ folder. Work still reaches your repo the normal way: the fleet pushes
# a branch and opens a draft MR. A folder that already holds a fleet (specs/workov.config.json) is upgraded in place,
# and --in-place keeps the old behaviour of installing straight into the given repo.
if [ "$IN_PLACE" = 0 ] && { [ ! -f "$TARGET/specs/workov.config.json" ] || [ "${WV_ALWAYS_CLONE:-0}" = 1 ]; }; then
  FLEETS_DIR="${WV_FLEETS_DIR:-$HOME/Workov/fleets}"
  NAME="${WV_PROJECT_NAME:-$(basename "$TARGET")}"
  FOLDER="$(printf %s "$NAME" | sed -e "s/[^A-Za-z0-9._-]\{1,\}/-/g")"  # no spaces in the folder name: agents quote such paths badly
  HOME_DIR="$FLEETS_DIR/$FOLDER"
  ORIGIN_URL="$(git -C "$TARGET" remote get-url origin 2>/dev/null || true)"
  mkdir -p "$FLEETS_DIR"
  FRESH=0
  if [ ! -d "$HOME_DIR/.git" ]; then
    echo "creating the fleet home for $NAME at $HOME_DIR (your repo is not touched)"
    git clone --quiet "$TARGET" "$HOME_DIR"
    [ -n "$ORIGIN_URL" ] && git -C "$HOME_DIR" remote set-url origin "$ORIGIN_URL"
    FRESH=1
  else
    require_clean "$HOME_DIR"
  fi
  if [ -n "$ORIGIN_URL" ]; then
    git -C "$HOME_DIR" fetch --quiet origin || echo "warning: could not fetch origin; the fleet home keeps the commits it has" >&2
    BR="$(git -C "$HOME_DIR" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
    [ -n "$BR" ] || BR="$(git -C "$TARGET" symbolic-ref --quiet --short HEAD 2>/dev/null || echo main)"
    if ! git -C "$HOME_DIR" rev-parse --verify --quiet "refs/remotes/origin/$BR" >/dev/null; then
      echo "warning: origin has no branch $BR; the fleet home stays where it is" >&2
    elif [ "$FRESH" = 1 ]; then
      # a clone made a moment ago holds nothing of the fleet's: start from origin's branch
      git -C "$HOME_DIR" checkout --quiet -B "$BR" "origin/$BR"
    elif ! git -C "$HOME_DIR" rev-parse --verify --quiet "refs/heads/$BR" >/dev/null; then
      git -C "$HOME_DIR" checkout --quiet -b "$BR" "origin/$BR"
    else
      # an existing fleet home keeps its commits: fast-forward only, never reset
      git -C "$HOME_DIR" checkout --quiet "$BR" || { echo "cannot switch the fleet home $HOME_DIR to $BR" >&2; exit 2; }
      if git -C "$HOME_DIR" merge-base --is-ancestor "origin/$BR" "$BR"; then
        :  # already up to date, or ahead of origin
      elif git -C "$HOME_DIR" merge-base --is-ancestor "$BR" "origin/$BR"; then
        git -C "$HOME_DIR" merge --ff-only --quiet "origin/$BR"
      else
        echo "the fleet home's $BR has diverged from origin/$BR, so nothing was changed." >&2
        echo "in $HOME_DIR, rebase it onto origin/$BR (or move its extra commits to another branch), then run the installer again." >&2
        exit 2
      fi
    fi
  fi
  TARGET="$(cd "$HOME_DIR" && pwd)"
fi
for bin in git node; do command -v "$bin" >/dev/null || { echo "missing $bin" >&2; exit 2; }; done
# Windows ships a python3.exe/python.exe "app execution alias" stub under WindowsApps that sits on PATH ahead of a
# real install and does nothing but redirect to the Store, so `command -v python3` alone proves nothing here; a real
# interpreter must actually run code. Prefer python3, fall back to python, and use this resolved name everywhere below.
PY3=""
for cand in python3 python; do
  if command -v "$cand" >/dev/null 2>&1 && [ "$("$cand" -c 'print(1)' 2>/dev/null)" = "1" ]; then PY3="$cand"; break; fi
done
[ -n "$PY3" ] || { echo "missing a working python 3 (python3/python on PATH resolve to Windows's App Store stub, not a real interpreter — install Python and make sure it comes first on PATH)" >&2; exit 2; }

# 1. the base (a local folder or a git URL)
if [ -d "$WF" ]; then
  WF_DIR="$(cd "$WF" && pwd)"
  [ -f "$WF_DIR/.claude/scripts/install.sh" ] || WF_DIR="$WF_DIR/workov"
else
  WF_DIR="$(mktemp -d)/workov"; git clone --depth 1 "$WF" "$WF_DIR"
fi
[ -f "$WF_DIR/.claude/scripts/install.sh" ] || { echo "not a Workov checkout: $WF_DIR" >&2; exit 2; }

# 2. install the base, then restore any tracked file it replaced (the team's files win)
require_clean "$TARGET"
PRE_DIRTY="$(dirty_files "$TARGET")"
if [ -n "$PRE_DIRTY" ]; then   # only reachable with --force: keep a copy of what was uncommitted
  bk_dir
  git -C "$TARGET" diff HEAD > "$BK/pre-install.patch"; echo "saved your uncommitted changes to $BK/pre-install.patch"
fi
bash "$WF_DIR/.claude/scripts/install.sh" "$TARGET"
restore_replaced

# 3. models and landing (OpenCode Go by default; edit specs/workov.config.json afterwards to change)
if [ "$DO_SETUP" = 1 ]; then
  ( cd "$TARGET" && node -e '
    const fs = require("fs"); const f = "specs/workov.config.json"; const c = JSON.parse(fs.readFileSync(f, "utf8"));
    const oc = { router: "opencode-go/glm-5.3", worker: "opencode-go/kimi-k2.7-code", teammate: "opencode-go/kimi-k2.7-code",
      reviewer: "opencode-go/deepseek-v4-pro", reproducer: "opencode-go/deepseek-v4-pro", tester: "opencode-go/glm-5.3-flash",
      merger: "opencode-go/glm-5.3-flash", checker: "opencode-go/glm-5.3-flash", watchdog: "opencode-go/glm-5.3-flash" };
    // the hub already knows which providers work on this machine: a new project inherits its models (the OpenCode Go names above are only a fallback)
    try {
      const hub = JSON.parse(fs.readFileSync(require("os").homedir() + "/.workov/hub.json", "utf8")).root;
      const hc = JSON.parse(fs.readFileSync(hub + "/specs/workov.config.json", "utf8"));
      for (const role of Object.keys(oc)) { const m = hc.models && hc.models[role] && hc.models[role].opencode && hc.models[role].opencode.model; if (m) oc[role] = m; }
    } catch (e) { /* no hub yet: the defaults stay */ }
    for (const [role, m] of Object.entries(oc)) c.models[role].opencode = { model: m };
    c.models.router.claude = { model: "sonnet", effort: "medium" };
    c.models.reviewer.delegateCli = "none"; c.models.worker.delegateCli = "none";
    fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");' \
    && "$PY3" .claude/scripts/apply-setup.py --preset custom --harness opencode --landing pr --max-workers 4 \
         --main-port 4200 --dashboard on --tunnel local --budget-usd 3 | tail -5 )
fi

# 4. the Workov layer: overlay files, then patches (after setup, which regenerates agent files)
cp -R "$HERE/overlay/." "$TARGET/"
FAILED_PATCHES=""
for p in agents worker dashboard agent-logs agent-roster decision-help dashboard-run dashboard-review dashboard-pause dashboard-overlay dashboard-fixes dashboard-insight dashboard-providers2 dashboard-connect dashboard-providers-page dashboard-providers-tab dashboard-providers-v2 dashboard-keystore dashboard-issue dashboard-answered dashboard-roster dashboard-readonly dashboard-router dashboard-mobile dashboard-theme dashboard-themes2 dashboard-polish named-tunnel tunnel-windows resource-rules ask-before-skip never-discard router-no-heavy delegate windows designer dashboard-claude dashboard-claude-account dashboard-cardfix telemetry-v2 dashboard-agentmodels dispatch-reliable failover dashboard-workers dashboard-workers2 worker-worktree land-branch dashboard-nav-chat dashboard-chat-theme chat-bridge dashboard-chat-web agent-steps dashboard-steps dashboard-processes retry-ticket projects-board project-context board-projects router-drafts-wait one-dashboard router-projects router-gate-skips fleet-stop-clean unique-prefix hub-guard neutral-sessions all-fleet-agents theme-andon-fix mockup-open-fix chat-no-snapshot chat-webview chat-noscroll chat-fixed writer-state autostart-writers timeline-all agents-live stages-v2 steps-other-project one-limit workers-count neutral-hub diff-lines models-list claude-runtime project-stage-actions stage-ui claude-steps telemetry-all-projects all-projects-views question-visible answer-visible plan-queue-label pre-plan-label board-loading timeline-loading writer-question stage-queue design-approval; do
  # a patch that is not shipped (yet) is skipped silently: later changes only ADD patch files
  [ -f "$HERE/patches/$p.cjs" ] || continue
  # one patch that does not apply (its anchor text is missing, usually because a patch of another PR has to land first) is named and
  # skipped; the install goes on and the summary below lists them
  if ! pout="$( cd "$TARGET" && node "$HERE/patches/$p.cjs" 2>&1 )"; then
    FAILED_PATCHES="$FAILED_PATCHES $p"; echo "patch $p did not apply: $(printf %s "$pout" | grep -m1 -E "Error|anchor|not found" | cut -c1-160)" >&2
  else [ -z "$pout" ] || printf "%s
" "$pout"; fi
done
[ -z "$FAILED_PATCHES" ] || echo "note: these patches did not apply:$FAILED_PATCHES (they depend on patches from another pull request; see the README, Landing order)" >&2

# Register this project in the machine-wide fleet list: the one dashboard shows every project's tickets, and only one
# worker runs at a time across them. WV_PROJECT_NAME overrides the display name (default: the folder name).
mkdir -p "$HOME/.workov"
if [ "$HUB_MODE" = 1 ]; then
  # the hub is recorded in hub.json only (never in fleets.json); a hub that is already recorded is left alone
  [ -f "$HOME/.workov/hub.json" ] || printf '{"root": "%s", "port": 3080}' "$(cygpath -m "$TARGET" 2>/dev/null || printf %s "$TARGET")" > "$HOME/.workov/hub.json"
else
"$PY3" - "$TARGET" "${WV_PROJECT_NAME:-}" <<'PYREG'
import json, os, sys
root = sys.argv[1].replace("\\", "/").rstrip("/")
name = sys.argv[2] or os.path.basename(root)
path = os.path.join(os.environ.get("WV_HOME_DIR") or os.path.expanduser("~"), ".workov", "fleets.json")
try:
    items = json.load(open(path, encoding="utf-8"))
except Exception:
    items = []
if not any(str(i.get("root", "")).replace("\\", "/").rstrip("/").lower() == root.lower() for i in items if isinstance(i, dict)):
    items.append({"name": name, "root": root})
    json.dump(items, open(path, "w", encoding="utf-8"), indent=2)
    print("registered " + name + " in ~/.workov/fleets.json")
PYREG
fi

# Approvals mode: ask | auto-safe, a machine-wide setting in ~/.workov/settings.json that the approvals plugin reads when an agent starts.
#   ask        what the policy allows runs, what it denies is refused, everything else waits for you (dashboard / phone)
#   auto-safe  what the policy denies is refused, everything else runs without asking (what an unattended fleet needs)
# Order: --approvals, else the choice already recorded (kept), else an install that already existed keeps running as it does today
# (auto-safe, so a reinstall never stalls a running fleet), else you are asked once (default ask), else ask.
approvals_now="$("$PY3" -I -c "import json,os; p=os.path.join(os.environ.get('WV_HOME_DIR') or os.path.expanduser('~'),'.workov','settings.json'); print((json.load(open(p)).get('approvals') or {}).get('mode',''))" 2>/dev/null | tr -d '\r' || true)"
approvals_set() {
  "$PY3" -I - "$1" <<'PYSET'
import json, os, sys
p = os.path.join(os.environ.get("WV_HOME_DIR") or os.path.expanduser("~"), ".workov", "settings.json")
try:
    d = json.load(open(p, encoding="utf-8"))
except Exception:
    d = {}
if not isinstance(d, dict):
    d = {}
a = d.get("approvals") if isinstance(d.get("approvals"), dict) else {}
a["mode"] = sys.argv[1]
d["approvals"] = a
os.makedirs(os.path.dirname(p), exist_ok=True)
json.dump(d, open(p, "w", encoding="utf-8"), indent=2)
PYSET
}
if [ -n "$APPROVALS_FLAG" ]; then
  approvals_set "$APPROVALS_FLAG"; echo "approvals mode: $APPROVALS_FLAG (set with --approvals)"
elif [ -n "$approvals_now" ]; then
  echo "approvals mode: $approvals_now (kept; change it with --approvals ask|auto-safe)"
elif [ "$EXISTING_INSTALL" = 1 ]; then
  approvals_set auto-safe; echo "approvals mode: auto-safe (this machine already ran the fleet that way; switch with --approvals ask)"
elif [ -t 0 ] && [ -t 1 ]; then
  echo
  echo "Approvals: when an agent wants to do something the policy neither allows nor denies, should it wait for you?"
  echo "  ask        yes, it waits for you in the dashboard (safest; the fleet pauses until you answer)"
  echo "  auto-safe  no, it goes ahead; only what the policy denies (push, force, deletes, outside network, new dependencies) is blocked"
  read -r -p "Approvals mode [ask/auto-safe] (ask): " ANSWER || ANSWER=""
  case "$ANSWER" in auto-safe|auto) approvals_set auto-safe ;; *) approvals_set ask ;; esac
  echo "approvals mode: $("$PY3" -I -c "import json,os; print(json.load(open(os.path.join(os.environ.get('WV_HOME_DIR') or os.path.expanduser('~'),'.workov','settings.json')))['approvals']['mode'])" | tr -d '\r')"
else
  approvals_set ask; echo "approvals mode: ask (the default; use --approvals auto-safe to let agents go ahead on their own)"
fi

# A running OpenCode background server keeps the agent list it loaded at start: without a reload, new agents such
# as `worker` fail with "Agent not found" when the router dispatches them.
if command -v opencode >/dev/null; then ( cd "$TARGET" && opencode reload >/dev/null 2>&1 ) || true; fi

# setup regenerates agent files: restore any tracked file again, so the team's files always win
restore_replaced

# 5. keep it all out of git
EXCLUDE="$(git -C "$TARGET" rev-parse --git-common-dir)/info/exclude"
case "$EXCLUDE" in /*|?:*) ;; *) EXCLUDE="$TARGET/$EXCLUDE" ;; esac
grep -q "# wv-fleet" "$EXCLUDE" 2>/dev/null || cat "$HERE/exclude.txt" >> "$EXCLUDE"

# 6. the /task command and the optional profile. These live OUTSIDE the project, in your home folder, so they need your
# consent: --with-home (or WV_WITH_HOME=1), or a yes at the prompt below. Without a terminal and without the flag they
# are skipped. Every file that would be overwritten with different content is copied to ~/.workov/backups/<time>/ first.
if [ "$DO_COMMAND" = 1 ] && [ "$WITH_HOME" != 1 ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    echo
    echo "The /task command and its helpers are installed in your home folder (outside this project):"
    echo "  ~/.claude/commands/task.md, ~/.claude/workov-profile.json (only if missing), ~/.claude/wv-fleet/land.cjs,"
    echo "  ~/.config/opencode/plugins/approvals.js, ~/.workov/policy/*, ~/.wv-bin/*   (anything replaced is backed up to ~/.workov/backups/)"
    read -r -p "Install them? [y/N] " ANSWER || ANSWER=""
    case "$ANSWER" in [yY]|[yY][eE][sS]) WITH_HOME=1 ;; esac
  fi
  [ "$WITH_HOME" = 1 ] || { echo "skipped the home folder files (run again with --with-home to install the /task command, the approvals plugin and ~/.wv-bin)"; DO_COMMAND=0; }
fi
if [ "$DO_COMMAND" = 1 ]; then
  mkdir -p "$HOME/.claude/task-profiles"
  put_home "$HERE/commands/task.md" "$HOME/.claude/commands/task.md"
  [ -f "$HOME/.claude/workov-profile.json" ] || put_home "$HERE/profile.example.json" "$HOME/.claude/workov-profile.json"
  # The approvals plugin, for /task headless runs in any repo. Inactive unless WV_APPROVALS is set (or the
  # repo has a Workov fleet), so ordinary OpenCode sessions are untouched.
  put_home "$HERE/overlay/.opencode/plugins/approvals.js" "$HOME/.config/opencode/plugins/approvals.js"
  # Headless runs in repos without a Workov fleet use land.cjs from here.
  put_home "$HERE/overlay/.claude/scripts/land.cjs" "$HOME/.claude/wv-fleet/land.cjs"
  # The command policy the global approvals plugin uses in repos without a fleet (a fleet folder has its own copy in .claude/scripts).
  for f in wv-policy.cjs policy.json; do put_home "$HERE/overlay/.claude/scripts/$f" "$HOME/.workov/policy/$f"; done
  # pnpm/npm wrappers: heavy commands (test, lint, build, install) wait their turn machine-wide. router-loop.sh puts this
  # folder first on PATH for the agents it starts.
  if [ -d "$HERE/wv-bin" ]; then
    for f in "$HERE"/wv-bin/*; do [ -f "$f" ] && put_home "$f" "$HOME/.wv-bin/$(basename "$f")"; done
    chmod +x "$HOME/.wv-bin/"* 2>/dev/null || true
  fi
  # stage pipeline: existing tickets go to Draft once (idempotent, backs up BOARD.md, deletes nothing); --dry shows it first
  [ "$HUB_MODE" = 1 ] || [ ! -f "$HOME/.wv-bin/wv-migrate-stages.py" ] || "$PY3" "$HOME/.wv-bin/wv-migrate-stages.py" "$TARGET" || echo "warning: stage migration did not run; run: python ~/.wv-bin/wv-migrate-stages.py <project> --dry" >&2
fi

echo
echo "Workov kit installed into $TARGET"
echo "  -> landing opens a PR (gh) or an MR (glab) for the origin host: log in with gh or glab once"
echo "  -> optional: ~/.claude/workov-profile.json (reviewers, a tracker hook); see profile.example.json"
[ -d "$HERE/wv-bin" ] || [ -f "$HOME/.wv-bin/wv-turn.py" ] || echo "  -> note: this checkout has no wv-bin/ (the pipeline scripts) and ~/.wv-bin has none, so the router loop will refuse to start until they are installed"
echo "  -> run: $PY3 .claude/scripts/selftest.py   (inside the target repo)"
echo "  -> read README.md for the daily workflow"
