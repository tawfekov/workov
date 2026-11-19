#!/usr/bin/env bash
# wv-fleet installer: worker-fleet + the Workov layer (GitLab MR / Plane / Workov HR landing, OpenCode Go models,
# permission approvals, mockup tab, Copilot/Kilo/Antigravity implementers) + the /task command.
#
#   bash install.sh <target-repo> [--worker-fleet <path-or-git-url>] [--no-command] [--no-setup]
#   bash install.sh --hub [dir]      the neutral hub (default ~/Workov/hub): dashboard + router, no tickets, not a project
#
# --worker-fleet defaults to vendor/worker-fleet next to this script (a local checkout kept for exactly this,
# since worker-fleet has no package registry or public git URL of its own); pass a path or git URL to use another.
#
# Everything installed into the target repo stays out of git (written to .git/info/exclude); tracked files the
# worker-fleet installer would replace are restored. Requires: git, bash, node, a real python 3; opencode for the fleet.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET=""; WF=""; DO_COMMAND=1; DO_SETUP=1; IN_PLACE=0; HUB_MODE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --worker-fleet) WF="$2"; shift 2 ;;
    --no-command) DO_COMMAND=0; shift ;;
    --no-setup) DO_SETUP=0; shift ;;
    --in-place) IN_PLACE=1; shift ;;
    --hub) HUB_MODE=1; IN_PLACE=1; shift ;;
    -h|--help) sed -n 2,10p "$0"; exit 0 ;;
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
[ -n "$TARGET" ] && [ -d "$TARGET/.git" -o -f "$TARGET/.git" ] || { echo "usage: bash install.sh <target-repo> [--worker-fleet <path-or-git-url>]" >&2; exit 2; }
if [ -z "$WF" ]; then
  [ -f "$HERE/vendor/worker-fleet/.claude/scripts/install.sh" ] || { echo "missing --worker-fleet <path-or-git-url>, and no vendored copy at $HERE/vendor/worker-fleet" >&2; exit 2; }
  WF="$HERE/vendor/worker-fleet"
fi
TARGET="$(cd "$TARGET" && pwd)"
# A project's fleet lives in its own managed folder (a clone under ~/Workov/fleets/<name>), so your working copy never
# gets fleet files, an edited opencode.json or a job/ folder. Work still reaches your repo the normal way: the fleet pushes
# a branch and opens a draft MR. A folder that already holds a fleet (specs/worker-fleet.config.json) is upgraded in place,
# and --in-place keeps the old behaviour of installing straight into the given repo.
if [ "$IN_PLACE" = 0 ] && { [ ! -f "$TARGET/specs/worker-fleet.config.json" ] || [ "${WV_ALWAYS_CLONE:-0}" = 1 ]; }; then
  FLEETS_DIR="${WV_FLEETS_DIR:-$HOME/Workov/fleets}"
  NAME="${WV_PROJECT_NAME:-$(basename "$TARGET")}"
  FOLDER="$(printf %s "$NAME" | sed -e "s/[^A-Za-z0-9._-]\{1,\}/-/g")"  # no spaces in the folder name: agents quote such paths badly
  HOME_DIR="$FLEETS_DIR/$FOLDER"
  ORIGIN_URL="$(git -C "$TARGET" remote get-url origin 2>/dev/null || true)"
  mkdir -p "$FLEETS_DIR"
  if [ ! -d "$HOME_DIR/.git" ]; then
    echo "creating the fleet home for $NAME at $HOME_DIR (your repo is not touched)"
    git clone --quiet "$TARGET" "$HOME_DIR"
    [ -n "$ORIGIN_URL" ] && git -C "$HOME_DIR" remote set-url origin "$ORIGIN_URL"
  fi
  if [ -n "$ORIGIN_URL" ]; then
    git -C "$HOME_DIR" fetch --quiet origin || echo "warning: could not fetch origin; the fleet home keeps the commits it has" >&2
    BR="$(git -C "$HOME_DIR" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
    [ -n "$BR" ] || BR="$(git -C "$TARGET" symbolic-ref --quiet --short HEAD 2>/dev/null || echo main)"
    git -C "$HOME_DIR" checkout --quiet -B "$BR" "origin/$BR" 2>/dev/null || true
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

# 1. worker-fleet source (a local folder or a git URL)
if [ -d "$WF" ]; then
  WF_DIR="$(cd "$WF" && pwd)"
  [ -f "$WF_DIR/.claude/scripts/install.sh" ] || WF_DIR="$WF_DIR/worker-fleet"
else
  WF_DIR="$(mktemp -d)/worker-fleet"; git clone --depth 1 "$WF" "$WF_DIR"
fi
[ -f "$WF_DIR/.claude/scripts/install.sh" ] || { echo "not a worker-fleet checkout: $WF_DIR" >&2; exit 2; }

# 2. install worker-fleet, then restore any tracked file it replaced (the team's files win)
bash "$WF_DIR/.claude/scripts/install.sh" "$TARGET"
CHANGED="$(git -C "$TARGET" diff --name-only)"
if [ -n "$CHANGED" ]; then
  echo "restoring tracked files the installer replaced:"; echo "$CHANGED" | sed 's/^/  /'
  echo "$CHANGED" | while read -r f; do git -C "$TARGET" checkout -- "$f"; done
fi

# 3. models and landing (OpenCode Go by default; edit specs/worker-fleet.config.json afterwards to change)
if [ "$DO_SETUP" = 1 ]; then
  ( cd "$TARGET" && node -e '
    const fs = require("fs"); const f = "specs/worker-fleet.config.json"; const c = JSON.parse(fs.readFileSync(f, "utf8"));
    const oc = { router: "opencode-go/glm-5.3", worker: "opencode-go/kimi-k2.7-code", teammate: "opencode-go/kimi-k2.7-code",
      reviewer: "opencode-go/deepseek-v4-pro", reproducer: "opencode-go/deepseek-v4-pro", tester: "opencode-go/glm-5.3-flash",
      merger: "opencode-go/glm-5.3-flash", checker: "opencode-go/glm-5.3-flash", watchdog: "opencode-go/glm-5.3-flash" };
    // the hub already knows which providers work on this machine: a new project inherits its models (the OpenCode Go names above are only a fallback)
    try {
      const hub = JSON.parse(fs.readFileSync(require("os").homedir() + "/.workov/hub.json", "utf8")).root;
      const hc = JSON.parse(fs.readFileSync(hub + "/specs/worker-fleet.config.json", "utf8"));
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
for p in agents worker dashboard agent-logs agent-roster decision-help dashboard-run dashboard-review dashboard-pause dashboard-overlay dashboard-fixes dashboard-insight dashboard-providers2 dashboard-connect dashboard-providers-page dashboard-providers-tab dashboard-providers-v2 dashboard-keystore dashboard-issue dashboard-answered dashboard-roster dashboard-readonly dashboard-router dashboard-mobile dashboard-theme dashboard-themes2 dashboard-polish named-tunnel tunnel-windows resource-rules ask-before-skip never-discard router-no-heavy delegate windows designer dashboard-claude dashboard-claude-account dashboard-cardfix telemetry-v2 dashboard-agentmodels dispatch-reliable failover dashboard-workers dashboard-workers2 worker-worktree land-branch dashboard-nav-chat dashboard-chat-theme chat-bridge dashboard-chat-web agent-steps dashboard-steps dashboard-processes retry-ticket projects-board project-context board-projects router-drafts-wait one-dashboard router-projects router-gate-skips fleet-stop-clean unique-prefix hub-guard neutral-sessions all-fleet-agents theme-andon-fix mockup-open-fix chat-no-snapshot chat-webview chat-noscroll chat-fixed writer-state autostart-writers timeline-all agents-live stages-v2 steps-other-project one-limit workers-count neutral-hub diff-lines models-list claude-runtime project-stage-actions stage-ui claude-steps telemetry-all-projects all-projects-views question-visible answer-visible plan-queue-label pre-plan-label board-loading timeline-loading writer-question stage-queue design-approval; do ( cd "$TARGET" && node "$HERE/patches/$p.cjs" ); done

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
path = os.path.join(os.path.expanduser("~"), ".workov", "fleets.json")
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

# A running OpenCode background server keeps the agent list it loaded at start: without a reload, new agents such
# as `worker` fail with "Agent not found" when the router dispatches them.
if command -v opencode >/dev/null; then ( cd "$TARGET" && opencode reload >/dev/null 2>&1 ) || true; fi

# setup regenerates agent files: restore any tracked file again, so the team's files always win
CHANGED="$(git -C "$TARGET" diff --name-only)"
[ -z "$CHANGED" ] || echo "$CHANGED" | while read -r f; do git -C "$TARGET" checkout -- "$f"; done

# 5. keep it all out of git
EXCLUDE="$(git -C "$TARGET" rev-parse --git-common-dir)/info/exclude"
case "$EXCLUDE" in /*|?:*) ;; *) EXCLUDE="$TARGET/$EXCLUDE" ;; esac
grep -q "# wv-fleet" "$EXCLUDE" 2>/dev/null || cat "$HERE/exclude.txt" >> "$EXCLUDE"

# 6. the /task command and the optional profile
if [ "$DO_COMMAND" = 1 ]; then
  mkdir -p "$HOME/.claude/commands" "$HOME/.claude/task-profiles"
  cp "$HERE/commands/task.md" "$HOME/.claude/commands/task.md"
  [ -f "$HOME/.claude/workov-profile.json" ] || cp "$HERE/profile.example.json" "$HOME/.claude/workov-profile.json"
  # The approvals plugin, for /task headless runs in any repo. Inactive unless WV_APPROVALS is set (or the
  # repo has a Workov fleet), so ordinary OpenCode sessions are untouched.
  mkdir -p "$HOME/.config/opencode/plugins"
  cp "$HERE/overlay/.opencode/plugins/approvals.js" "$HOME/.config/opencode/plugins/approvals.js"
  # Headless runs in repos without worker-fleet use land.cjs from here.
  mkdir -p "$HOME/.claude/wv-fleet"
  cp "$HERE/overlay/.claude/scripts/land.cjs" "$HOME/.claude/wv-fleet/land.cjs"
  # pnpm/npm wrappers: heavy commands (test, lint, build, install) wait their turn machine-wide. router-loop.sh puts this
  # folder first on PATH for the agents it starts.
  mkdir -p "$HOME/.wv-bin" && cp "$HERE"/wv-bin/* "$HOME/.wv-bin/" && chmod +x "$HOME/.wv-bin/"*
  # stage pipeline: existing tickets go to Draft once (idempotent, backs up BOARD.md, deletes nothing); --dry shows it first
  [ "$HUB_MODE" = 1 ] || "$PY3" "$HOME/.wv-bin/wv-migrate-stages.py" "$TARGET" || echo "warning: stage migration did not run; run: python ~/.wv-bin/wv-migrate-stages.py <project> --dry" >&2
fi

echo
echo "wv-fleet installed into $TARGET"
echo "  -> run: $PY3 .claude/scripts/selftest.py   (inside the target repo)"
echo "  -> read README.md in wv-fleet for the daily workflow"
