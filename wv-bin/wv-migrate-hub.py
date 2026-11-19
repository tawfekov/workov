#!/usr/bin/env python3
"""Workov: move the fleet from "one project is the hub" to "a neutral hub, every project equal".

Before: the dashboard, the router loop, the shared config/limits/models and the auth token live in ONE project's folder
(installed in place in the owner's repo). After: they live in a neutral folder (default ~/Workov/hub) that belongs to no
project and has no tickets; that project becomes a normal one (a clone under ~/Workov/fleets/<name>), like every other.

  python wv-migrate-hub.py                       # --dry (default): lists exactly what would be done, changes nothing
  python wv-migrate-hub.py --apply               # does it
  python wv-migrate-hub.py --rollback <backup>   # puts hub.json / fleets.json / the app config back from a backup folder

Options: --old-hub <dir> (default: root in ~/.workov/hub.json)   --new-hub <dir> (default ~/Workov/hub)
         --project-name <name> (default: its name in fleets.json)   --project-clone <dir> (default ~/Workov/fleets/<name>)
         --origin <url> (default: origin of the old hub)   --branch <name> (default: the branch checked out in the old hub)
         --app-config <file> (the Workeve app's config.json: its "fleet" is pointed at the new hub; default: untouched)
         --home <dir> (default: the user home; tests use a scratch one)   --no-fetch   --allow-running

Idempotent: every step checks what is already done, so a second --apply changes nothing. It NEVER stops or kills a process:
it refuses to --apply while the old hub's dashboard or router loop is alive (--allow-running overrides) and prints the exact
stop / start steps instead. The old hub folder is never modified (it is only read).
"""
import argparse, datetime, json, os, re, shutil, socket, subprocess, sys
from pathlib import Path

# what makes a folder a hub / a project's fleet tooling (copied, never tickets / history / ledger / worktrees)
TOOL_DIRS = [".claude/scripts", ".claude/dashboard", ".claude/agents", ".claude/skills", ".opencode", ".agents/skills"]
TOOL_FILES = [".claude/settings.json", ".claude/worker-fleet.version", "opencode.json", "specs/worker-fleet.config.json"]
# shared hub state the dashboard needs (token stays the same, provider catalog and its logos, failover choice)
HUB_JOB_FILES = ["dashboard-auth.json", "provider-catalog-v3.json", "provider-catalog.json", "failover-state.json", "models-backup.json",
                 "chat-bridge.json", "notify-secrets.json"]
HUB_JOB_DIRS = ["provider-logos"]
# one project's own state (carried to its clone with the old folder path rewritten)
PROJ_JOB_FILES = ["router-state.json", "paused.json", "fleet-off", "stages-v2.migrated", "timeline.jsonl"]
PROJ_JOB_DIRS = ["stage", "control", "briefs"]
PROJ_JOB_GLOBS = ["review-*.json", "status-writer-*.json"]
SKIP = shutil.ignore_patterns("__pycache__", "node_modules", "*.pyc", "*.db", "*.db-wal", "*.db-shm", "*.lock")
EXCLUDE = """# wv-fleet (worker-fleet + Workov layer; local only, never committed)
job/
__pycache__/
.worker-fleet-backup/
.claude/agents/
.claude/dashboard/
.claude/scripts/
.claude/skills/
.claude/settings.json
.claude/worker-fleet.version
.opencode/agents/checker.md
.opencode/agents/merger.md
.opencode/agents/reproducer.md
.opencode/agents/router.md
.opencode/agents/teammate.md
.opencode/agents/tester.md
.opencode/agents/watchdog.md
.opencode/agents/worker.md
.opencode/plugins/
.agents/skills
opencode.json
specs/worker-fleet.config.json
specs/tickets/*/delivery/
.delivery/
"""
BOARD_EMPTY = """# Ticket Board

The neutral Workov hub: no tickets live here. Every project keeps its own board in its own folder.

| #   | Title | Status | Mode | Prio | Runs |
| --- | --- | --- | --- | --- | --- |
"""


def slash(p):
    return str(p).replace("\\", "/").rstrip("/")


def norm(p):
    return slash(p).lower()


def jread(p, default=None):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return default


def git(cwd, *args, check=True, timeout=120):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0", GIT_SSH_COMMAND=os.environ.get("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=8"))
    r = subprocess.run(["git", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false"] + list(args), cwd=str(cwd), capture_output=True, text=True, timeout=timeout, env=env)
    if check and r.returncode != 0:
        raise RuntimeError("git " + " ".join(args) + " failed: " + (r.stderr or r.stdout).strip()[:300])
    return r


def alive(pid):
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        r = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/NH"], capture_output=True, text=True)
        return str(pid) in r.stdout
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def port_open(port):
    try:
        with socket.create_connection(("127.0.0.1", int(port)), 0.4):
            return True
    except (OSError, ValueError, TypeError):
        return False


def pidfile(p):
    try:
        return int(Path(p).read_text().split()[0])
    except Exception:
        return 0


class Plan:
    def __init__(self, apply):
        self.apply, self.items = apply, []

    def step(self, text, fn=None, needed=True):
        """record one step; run it when --apply. Steps that are already done are listed as 'ok'."""
        text = text.replace("\\", "/")
        if not needed:
            self.items.append(("ok  ", text))
            return
        self.items.append(("TODO" if not self.apply else "DONE", text))
        if self.apply and fn:
            fn()

    def show(self):
        for tag, text in self.items:
            print("  [%s] %s" % (tag, text))


def copy_tree(src, dst):
    shutil.copytree(src, dst, ignore=SKIP, dirs_exist_ok=True)


def tracked_set(repo):
    """every path git tracks in repo (so the team's own files are never overwritten by fleet tooling)"""
    if not repo or not (Path(repo) / ".git").exists():
        return set()
    return set(git(repo, "ls-files").stdout.splitlines())


def differs(a, b):
    try:
        return a.read_bytes() != b.read_bytes()
    except OSError:
        return True


def tool_files(src, rel, skip):
    """[(relative path)] of the files of one tooling path (a file or a folder) that are not tracked by the project"""
    base = src / rel
    if base.is_file():
        return [rel] if rel not in skip else []
    out = []
    if base.is_dir():
        for f in base.rglob("*"):
            if f.is_file() and not (set(f.parts) & {"__pycache__", "node_modules"}) and f.suffix not in (".pyc", ".db", ".lock"):
                r = f.relative_to(src).as_posix()
                if r not in skip:
                    out.append(r)
    return out


def tree_missing(src, dst):
    """True when something under src is absent or different in dst."""
    if src.is_file():
        return (not dst.exists()) or differs(src, dst)
    if not src.is_dir():
        return False
    for f in src.rglob("*"):
        if f.is_file() and (set(f.parts) & {"__pycache__", "node_modules"} or f.suffix in (".pyc", ".db")):
            continue
        if f.is_file() and ((not (dst / f.relative_to(src)).exists()) or differs(f, dst / f.relative_to(src))):
            return True
    return False


def ensure_exclude(repo, plan, label):
    ex = Path(git(repo, "rev-parse", "--git-common-dir").stdout.strip())
    ex = (ex if ex.is_absolute() else Path(repo) / ex) / "info" / "exclude"
    done = ex.exists() and "# wv-fleet" in ex.read_text(encoding="utf-8", errors="replace")

    def go():
        ex.parent.mkdir(parents=True, exist_ok=True)
        with open(ex, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(("\n" if ex.exists() and ex.stat().st_size else "") + EXCLUDE)
    plan.step("%s: keep the fleet files out of git (.git/info/exclude)" % label, go, needed=not done)

    def extra_needed():
        have = ex.read_text(encoding="utf-8", errors="replace") if ex.exists() else ""
        out = []
        for ln in git(repo, "ls-files", "--others", "--exclude-standard").stdout.splitlines():
            if ln.startswith((".opencode/", ".claude/", ".agents/")) and ("/" + ln) not in have and ln not in have.splitlines():
                out.append(ln)
        return out

    def go_extra():
        with open(ex, "a", encoding="utf-8", newline="\n") as fh:
            fh.write("# wv-fleet: more fleet files copied by wv-migrate-hub\n" + "\n".join(extra_needed()) + "\n")
    if (Path(repo) / ".git").exists():
        plan.step("%s: also exclude the other copied fleet files (.opencode agents ...)" % label, go_extra, needed=bool(extra_needed()))


def keep_patched(dst_file):
    """a copied file that carries the neutral-hub patch is never overwritten by the (unpatched) original again"""
    try:
        return dst_file.suffix in (".py", ".html") and "wv-neutral-hub" in dst_file.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False


def copy_tooling(old, dst, plan, label, skip_tracked_repo=None, rewrite=None):
    skip = tracked_set(skip_tracked_repo)
    for rel in TOOL_DIRS + TOOL_FILES:
        files = tool_files(old, rel, skip)
        if not files:
            continue
        todo = [r for r in files if differs(old / r, dst / r) and not keep_patched(dst / r)]

        def go(files=files):
            for r in files:
                if differs(old / r, dst / r) and not keep_patched(dst / r):
                    (dst / r).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(old / r, dst / r)
                    if rewrite and r.endswith(".md"):
                        rewrite_paths(dst / r, rewrite[0], rewrite[1])  # agent instructions name the project folder: it is the clone now
        plan.step("%s: copy %s (%d files%s)" % (label, rel, len(files), ", %d new or changed" % len(todo) if todo else ""), go, needed=bool(todo))


def rewrite_paths(path, old_root, new_root):
    """copy-time rewrite of the old folder path inside carried JSON/text state (both slash styles)"""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return
    o = slash(old_root)
    n = slash(new_root)
    new = text.replace(o, n).replace(o.replace("/", "\\\\"), n.replace("/", "\\\\")).replace(o.replace("/", "\\"), n.replace("/", "\\"))
    if new != text:
        path.write_text(new, encoding="utf-8", newline="")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--rollback", metavar="BACKUP_DIR")
    ap.add_argument("--remove-created", action="store_true", help="with --rollback: also delete the hub / clone folders this migration created")
    ap.add_argument("--old-hub")
    ap.add_argument("--new-hub")
    ap.add_argument("--project-name")
    ap.add_argument("--project-clone")
    ap.add_argument("--origin")
    ap.add_argument("--branch")
    ap.add_argument("--app-config")
    ap.add_argument("--home")
    ap.add_argument("--patch", help="patches/neutral-hub.cjs of the kit (default: found next to this script's kit folder)")
    ap.add_argument("--no-fetch", action="store_true")
    ap.add_argument("--allow-running", action="store_true")
    a = ap.parse_args()
    home = Path(a.home) if a.home else Path.home()
    wdir = home / ".workov"
    if a.rollback:
        return rollback(Path(a.rollback), wdir, a)

    hubjson = jread(wdir / "hub.json", {}) or {}
    if not a.old_hub and norm(hubjson.get("root", "")) == norm(a.new_hub or (home / "Workov" / "hub")):
        print("already migrated: hub.json points at the neutral hub %s. Nothing to do (pass --old-hub <folder> to repeat a step)." % slash(hubjson.get("root", "")))
        return 0
    old = Path(slash(a.old_hub or hubjson.get("root", "")))
    if not str(old) or not (old / "specs" / "worker-fleet.config.json").is_file():
        print("error: the current hub (%s) has no specs/worker-fleet.config.json; pass --old-hub" % old, file=sys.stderr)
        return 2
    new = Path(slash(a.new_hub or (home / "Workov" / "hub")))
    fleets = jread(wdir / "fleets.json", [])
    fleets = fleets if isinstance(fleets, list) else []
    entry = next((f for f in fleets if isinstance(f, dict) and norm(f.get("root", "")) == norm(old)), None)
    name = a.project_name or (entry or {}).get("name") or old.name
    clone = Path(slash(a.project_clone or (home / "Workov" / "fleets" / re.sub(r"[^A-Za-z0-9._-]+", "-", name))))  # no spaces in the folder name
    port = int(hubjson.get("port") or ((jread(old / "specs" / "worker-fleet.config.json", {}).get("dashboard") or {}).get("port")) or 3080)
    if norm(new) == norm(old):
        print("error: the new hub must be a different folder from the old one", file=sys.stderr)
        return 2
    if norm(clone) in (norm(old), norm(new)):
        print("error: the project clone must be a folder of its own", file=sys.stderr)
        return 2
    origin = a.origin or (git(old, "remote", "get-url", "origin", check=False).stdout.strip())
    cur_branch = a.branch or git(old, "symbolic-ref", "--quiet", "--short", "HEAD", check=False).stdout.strip() or "main"

    print("%s: %s" % ("APPLY" if a.apply else "DRY RUN (nothing is changed)", "move the hub out of the project"))
    print("  old hub (stays untouched) : %s" % slash(old))
    print("  new neutral hub           : %s   (port %s)" % (slash(new), port))
    print("  project                   : %s -> %s   origin %s   branch %s" % (name, slash(clone), origin or "(none)", cur_branch))

    # live processes of the old hub: never killed here
    dpid, rpid = pidfile(old / "job" / "dashboard-server.pid"), pidfile(old / "job" / "router-loop.pid")
    live = [(n, p) for n, p in (("dashboard server", dpid), ("router loop", rpid)) if alive(p)]
    if port_open(port) and not any(n == "dashboard server" for n, _ in live):
        live.append(("something listening on port %s" % port, 0))
    if live and a.apply and not a.allow_running:
        print("\nREFUSED: the old hub is running (%s). Stop it first (steps below) or pass --allow-running." % ", ".join("%s pid %s" % x if x[1] else x[0] for x in live), file=sys.stderr)
        print_runbook(old, new, clone, name, port, dpid, rpid, a)
        return 3

    plan = Plan(a.apply)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = wdir / "backups" / ("hub-migration-" + stamp)

    # ---- what is already done ----
    hub_done = norm(hubjson.get("root", "")) == norm(new) and int(hubjson.get("port") or 0) == port
    fleets_done = not any(norm(f.get("root", "")) == norm(old) for f in fleets if isinstance(f, dict)) and \
        any(norm(f.get("root", "")) == norm(clone) for f in fleets if isinstance(f, dict))
    app_cfg = Path(a.app_config) if a.app_config else None
    app_done = True
    if app_cfg:
        app_done = norm((jread(app_cfg, {}) or {}).get("fleet", "")) == norm(new)
    any_config_change = not (hub_done and fleets_done and app_done)

    created = {"hub": not (new / ".git").exists(), "clone": not (clone / ".git").exists()}
    manifest_path = backup / "manifest.json"

    def make_backup():
        backup.mkdir(parents=True, exist_ok=True)
        saved = {}
        for label, f in (("hub.json", wdir / "hub.json"), ("fleets.json", wdir / "fleets.json"), ("app-config.json", app_cfg)):
            if f and Path(f).exists():
                shutil.copy2(f, backup / label)
                saved[label] = str(f)
        manifest_path.write_text(json.dumps({"at": stamp, "saved": saved, "appConfig": str(app_cfg) if app_cfg else "", "newHub": slash(new),
                                             "clone": slash(clone), "oldHub": slash(old), "createdHub": created["hub"], "createdClone": created["clone"],
                                             "project": name}, indent=2), encoding="utf-8")
    plan.step("backup hub.json, fleets.json%s to %s" % (", the app config" if app_cfg else "", backup), make_backup, needed=any_config_change)

    # ---- 1. the neutral hub ----
    def mk_hub():
        new.mkdir(parents=True, exist_ok=True)
        git(new, "init", "-q")
    plan.step("hub: create %s and `git init` (a valid fleet root for dashboard-server.py)" % new, mk_hub, needed=not (new / ".git").exists())
    copy_tooling(old, new, plan, "hub")
    # the dashboard that runs from the hub must know there is no "own project" any more (ids prefixed for every project)
    srv = new / ".claude" / "scripts" / "dashboard-server.py"
    hp = Path(a.patch) if a.patch else next((c for c in (Path(__file__).resolve().parent.parent / "patches" / "neutral-hub.cjs", Path(__file__).resolve().parent / "neutral-hub.cjs") if c.is_file()), None)
    patched = srv.is_file() and "wv-neutral-hub" in srv.read_text(encoding="utf-8", errors="replace")

    def go_patch():
        r = subprocess.run(["node", str(hp)], cwd=str(new), capture_output=True, text=True)
        if r.returncode != 0 or "skipped" in r.stdout:
            raise RuntimeError("neutral-hub patch: " + (r.stdout + r.stderr).strip()[:300])
    if hp:
        plan.step("hub: apply the dashboard patch %s (no own-project special case, uniform board order)" % hp, go_patch, needed=not patched or not srv.is_file())
    else:
        plan.step("hub: WARNING patches/neutral-hub.cjs not found: pass --patch, or run `node patches/neutral-hub.cjs` inside the hub", None)
    for f in HUB_JOB_FILES:
        s = old / "job" / f
        if s.is_file():
            def go(s=s, f=f):
                (new / "job").mkdir(parents=True, exist_ok=True)
                shutil.copy2(s, new / "job" / f)
            plan.step("hub: copy job/%s%s" % (f, "  (same auth token)" if f == "dashboard-auth.json" else ""), go, needed=tree_missing(s, new / "job" / f))
    for d in HUB_JOB_DIRS:
        s = old / "job" / d
        if s.is_dir():
            plan.step("hub: copy job/%s/" % d, (lambda s=s, d=d: copy_tree(s, new / "job" / d)), needed=tree_missing(s, new / "job" / d))

    def mk_board():
        (new / "specs" / "tickets").mkdir(parents=True, exist_ok=True)
        (new / "job").mkdir(parents=True, exist_ok=True)
        (new / "specs" / "tickets" / "BOARD.md").write_text(BOARD_EMPTY, encoding="utf-8", newline="\n")
    plan.step("hub: empty specs/tickets/BOARD.md (the hub has no tickets) and job/", mk_board, needed=not (new / "specs" / "tickets" / "BOARD.md").exists())

    def commit_hub():
        git(new, "add", "specs/tickets/BOARD.md")
        git(new, "-c", "user.name=Workov", "-c", "user.email=workov@localhost", "commit", "-q", "-m", "chore: neutral hub")
    has_head = (new / ".git").exists() and git(new, "rev-parse", "--verify", "-q", "HEAD", check=False).returncode == 0
    plan.step("hub: first commit (BOARD.md only), so the folder is a normal git root", commit_hub, needed=not has_head)
    ensure_exclude_hub = (new / ".git").exists()
    if ensure_exclude_hub:
        ensure_exclude(new, plan, "hub")
    else:
        plan.step("hub: keep the fleet files out of git (.git/info/exclude)", lambda: ensure_exclude(new, Plan(True), "hub"))

    # ---- 2. the project clone ----
    def mk_clone():
        clone.parent.mkdir(parents=True, exist_ok=True)
        git(clone.parent, "clone", "-q", "--no-hardlinks", slash(old), slash(clone), timeout=900)
        if origin:
            git(clone, "remote", "set-url", "origin", origin)
    plan.step("project: clone %s -> %s and set origin to %s" % (old, clone, origin or "(none)"), mk_clone, needed=not (clone / ".git").exists())

    def clone_branches():
        # the old repo's local branches (feat/009-... and the others) become local branches of the clone
        git(clone, "fetch", "-q", slash(old), "+refs/heads/*:refs/wv-old/heads/*", "+refs/tags/*:refs/tags/*", timeout=600)
        for line in git(clone, "for-each-ref", "--format=%(refname) %(objectname)", "refs/wv-old/heads").stdout.splitlines():
            ref, sha = line.split()
            br = ref[len("refs/wv-old/heads/"):]
            if git(clone, "rev-parse", "--verify", "-q", "refs/heads/" + br, check=False).returncode != 0:
                git(clone, "branch", "-q", br, sha)
        for line in git(clone, "for-each-ref", "--format=%(refname)", "refs/wv-old").stdout.splitlines():
            git(clone, "update-ref", "-d", line)
        if cur_branch and git(clone, "symbolic-ref", "--short", "HEAD", check=False).stdout.strip() != cur_branch:
            git(clone, "checkout", "-q", cur_branch)
    src_branches = set(git(old, "for-each-ref", "--format=%(refname:short)", "refs/heads").stdout.split())
    have = set(git(clone, "for-each-ref", "--format=%(refname:short)", "refs/heads").stdout.split()) if (clone / ".git").exists() else set()
    cb = git(clone, "symbolic-ref", "--short", "HEAD", check=False).stdout.strip() if (clone / ".git").exists() else ""
    plan.step("project: every local branch of the old repo (%d) becomes a branch of the clone, checked out on %s" % (len(src_branches), cur_branch),
              clone_branches, needed=bool(src_branches - have) or cb != cur_branch)

    def fetch():
        r = git(clone, "fetch", "-q", "origin", check=False, timeout=60)
        if r.returncode != 0:
            print("  warning: could not fetch origin (%s); the clone keeps the commits it has" % (r.stderr.strip()[:120]), file=sys.stderr)
    if origin and not a.no_fetch:
        plan.step("project: fetch origin (a failure is only a warning)", fetch, needed=not (clone / ".git").exists() or True)

    copy_tooling(old, clone, plan, "project", skip_tracked_repo=clone if (clone / ".git").exists() else None, rewrite=(old, clone))
    if (clone / ".git").exists():
        ensure_exclude(clone, plan, "project")
    else:
        plan.step("project: keep the fleet files out of git (.git/info/exclude)", lambda: ensure_exclude(clone, Plan(True), "project"))

    # tickets: BOARD.md and every ticket folder as they are in the old working copy (tracked changes and untracked folders)
    def tickets_to_copy():
        out = []
        st = git(old, "status", "--porcelain=v1", "-uall", "--", "specs/tickets", check=False).stdout.splitlines()
        for ln in st:
            p = ln[3:].strip().strip('"')
            if " -> " in p:
                p = p.split(" -> ")[1]
            if "/delivery/" in p or ".bak" in Path(p).name:
                continue
            if (old / p).is_file():
                out.append(p)
        board = "specs/tickets/BOARD.md"
        if (old / board).is_file() and board not in out:
            out.append(board)
        return [p for p in out if differs(old / p, clone / p)]
    tix = tickets_to_copy() if (clone / ".git").exists() else ["specs/tickets/BOARD.md (and untracked ticket folders)"]

    def go_tix():
        for p in tickets_to_copy():
            (clone / p).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(old / p, clone / p)
    plan.step("project: carry the old working copy's ticket state (%s)" % (", ".join(tix[:6]) + (" ..." if len(tix) > 6 else "") if tix else "nothing new"), go_tix, needed=bool(tix))

    # per-project job state: router ledger, paused, stage engine state, control files (paths rewritten to the clone)
    def job_items():
        items = []
        for f in PROJ_JOB_FILES:
            if (old / "job" / f).is_file():
                items.append(f)
        import glob as _g
        for pat in PROJ_JOB_GLOBS:
            items += [Path(x).name for x in _g.glob(str(old / "job" / pat))]
        return items
    def job_dirs():
        return [d for d in PROJ_JOB_DIRS if (old / "job" / d).is_dir()]

    def carry_job():
        (clone / "job").mkdir(parents=True, exist_ok=True)
        for f in job_items():
            if not (clone / "job" / f).exists():
                shutil.copy2(old / "job" / f, clone / "job" / f)
                rewrite_paths(clone / "job" / f, old, clone)
        for d in job_dirs():
            for src in (old / "job" / d).rglob("*"):
                if src.is_file():
                    dst = clone / "job" / d / src.relative_to(old / "job" / d)
                    if not dst.exists():
                        dst.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(src, dst)
                        rewrite_paths(dst, old, clone)
    pend = [f for f in job_items() if not (clone / "job" / f).exists()] + [d for d in job_dirs() if tree_missing(old / "job" / d, clone / "job" / d)]
    plan.step("project: carry its own job state (%s) with the old folder path rewritten" % (", ".join(pend) or "nothing new"), carry_job, needed=bool(pend))

    # ---- 3. registry ----
    def write_hub_json():
        wdir.mkdir(parents=True, exist_ok=True)
        (wdir / "hub.json").write_text(json.dumps({"root": slash(new), "port": port}), encoding="utf-8")
    plan.step("hub.json -> {root: %s, port: %s}" % (slash(new), port), write_hub_json, needed=not hub_done)

    def write_fleets():
        items = [f for f in fleets if isinstance(f, dict) and norm(f.get("root", "")) not in (norm(old), norm(new))]
        if not any(norm(f.get("root", "")) == norm(clone) for f in items):
            pos = next((i for i, f in enumerate(fleets) if isinstance(f, dict) and norm(f.get("root", "")) == norm(old)), len(items))
            items.insert(min(pos, len(items)), {"name": name, "root": slash(clone)})
        (wdir / "fleets.json").write_text(json.dumps(items, indent=2), encoding="utf-8")
    plan.step("fleets.json: %s now points at the clone %s; the old folder and the hub are not listed" % (name, clone), write_fleets, needed=not fleets_done)

    if app_cfg:
        def write_app():
            c = jread(app_cfg, {}) or {}
            c["fleet"] = slash(new)
            app_cfg.write_text(json.dumps(c, indent=2), encoding="utf-8")
        plan.step("app config %s: fleet -> %s" % (app_cfg, slash(new)), write_app, needed=not app_done)
    else:
        print("  (the Workeve app config is not touched; set \"fleet\" to %s by hand or pass --app-config <file>)" % slash(new))

    print()
    try:
        plan.show()
    finally:
        pass
    print("\nnew cfg.fleet value for the Workeve app config (%%APPDATA%%\\Workeve\\config.json): %s" % slash(new))
    print_runbook(old, new, clone, name, port, dpid, rpid, a)
    if not a.apply:
        print("\nnothing was changed. Re-run with --apply to do it.")
    elif any_config_change and manifest_path.exists():
        print("\nbackup: %s   (rollback: python wv-migrate-hub.py --rollback \"%s\" [--remove-created])" % (backup, backup))
    return 0


def print_runbook(old, new, clone, name, port, dpid, rpid, a):
    print("\noperator steps (this tool never stops or starts anything):")
    print("  1. stop the old hub: dashboard server pid %s (%s) and router loop pid %s (%s)" % (dpid or "-", "alive" if alive(dpid) else "not running", rpid or "-", "alive" if alive(rpid) else "not running"))
    print("       bash \"%s/.claude/scripts/start-dashboard.sh\" --stop     (or: taskkill /PID <pid> /T /F for each pid above)" % slash(old))
    print("       the router loop ends by itself when stopped from the dashboard (Stop fleet), or: taskkill /PID %s /T /F" % (rpid or "<router-loop pid>"))
    print("       any worker already running keeps running in its worktree; wait for it or accept it finishing without the router")
    print("  2. python wv-migrate-hub.py --apply [--app-config <config.json>]")
    print("  3. quit and restart the Workeve app (its cfg.fleet is now %s), or start the hub by hand:" % slash(new))
    print("       cd \"%s\" && bash .claude/scripts/start-dashboard.sh" % slash(new))
    print("     the router loop starts by itself when a project has work (or press Start fleet in the dashboard)")
    print("  4. check: http://127.0.0.1:%s/ shows %s tickets as <PREFIX>-NNN; /api/wv/projects lists the projects" % (port, name))


def _force_rw(func, path, exc):
    import stat
    os.chmod(path, stat.S_IWRITE)
    func(path)


def rollback(backup, wdir, a):
    man = jread(backup / "manifest.json")
    if not man:
        print("error: %s has no manifest.json" % backup, file=sys.stderr)
        return 2
    print("ROLLBACK from %s" % backup)
    for label, dst in (("hub.json", wdir / "hub.json"), ("fleets.json", wdir / "fleets.json"), ("app-config.json", Path(man.get("appConfig") or "") if man.get("appConfig") else None)):
        src = backup / label
        if dst and src.exists():
            if not a.apply and not True:
                pass
            print("  restore %s <- %s" % (dst, src))
            if a.apply:
                shutil.copy2(src, dst)
    if a.remove_created:
        for key, p in (("createdHub", man.get("newHub")), ("createdClone", man.get("clone"))):
            if man.get(key) and p and Path(p).exists():
                print("  remove %s (created by the migration)" % p)
                if a.apply:
                    shutil.rmtree(p, onexc=_force_rw)
    if not a.apply:
        print("dry run: add --apply to restore. The hub/clone folders are kept unless --remove-created is given.")
    else:
        print("restored. Restart the dashboard from the old hub: bash \"%s/.claude/scripts/start-dashboard.sh\"" % man.get("oldHub"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
