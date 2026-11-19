// Workov: the ticket's Timeline also shows the agents that run on Claude Code: the designer and the planner.
// The Timeline (Logs tab, "Timeline" view) was built from OpenCode sessions only, so a ticket whose designer runs on Claude showed
// nothing while it worked. The designer and planner write job/logs/<NNN>-designer.log and <NNN>-planner.log; this reads them
// (the ticket's own project folder for tickets of other projects) and turns every run into one agent with steps: the task, the
// text it writes, each tool call with its result, and the notes (limit reached, exit). Live while the log is still being written.
// Apply after steps-other-project. Idempotent.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8').replace(/\r\n/g, '\n');
if (s.includes('def wv_claude_log_agents')) { console.log('claude-steps: already applied'); process.exit(0); }
const a1 = 'def wv_opencode_steps(ticket, router, limit=300, base_root=None):';
if (!s.includes(a1)) throw new Error('anchor missing (apply steps-other-project first): ' + a1);
const a2 = '\nWV_PROVIDERS = {';
if (!s.includes(a2)) throw new Error('anchor missing: ' + a2);

s = s.replace(a1, () => 'def _wv_db_steps(ticket, router, limit=300, base_root=None):');

const FN = String.raw`

_WV_LOG_LINE = re.compile(r"^\[(\d\d):(\d\d):(\d\d)\] ?(.*)$")


def wv_claude_log_agents(ticket, base_root=None, limit=300):
    """The designer and planner runs of a ticket (Claude Code) as timeline agents, read from job/logs/<NNN>-<role>.log."""
    import datetime as _dt
    base = Path(base_root) if base_root else REPO_ROOT
    agents = []
    for role in ("planner", "designer"):
        f = base / "job" / "logs" / (str(ticket) + "-" + role + ".log")
        if not f.is_file():
            continue
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
            mt = f.stat().st_mtime
        except OSError:
            continue
        day = _dt.datetime.fromtimestamp(mt).replace(hour=0, minute=0, second=0, microsecond=0)

        def stamp(h, m, sec):
            t = (day + _dt.timedelta(hours=int(h), minutes=int(m), seconds=int(sec))).timestamp()
            return int((t - 86400 if t > mt + 120 else t) * 1000)

        runs, cur, last = [], None, None
        for raw in text.split("\n"):
            m = _WV_LOG_LINE.match(raw)
            if not m:
                if raw.strip() and last is not None:  # a continuation line of the previous step
                    key = "out" if last.get("k") == "tool" else "text"
                    last[key] = _wv_keep((last.get(key) or "") + "\n" + raw, 6000)
                continue
            t, body = stamp(m.group(1), m.group(2), m.group(3)), m.group(4)
            if body.startswith("▶"):  # a run starts: the task
                cur = {"id": role + "-" + m.group(1) + m.group(2) + m.group(3), "agent": role, "since": t, "steps": [], "done": False}
                runs.append(cur)
                last = {"t": t, "k": "user", "text": _wv_keep(body.lstrip("▶ ").strip(), 4000)}
                cur["steps"].append(last)
                continue
            if cur is None:
                cur = {"id": role + "-0", "agent": role, "since": t, "steps": [], "done": False}
                runs.append(cur)
            if body.startswith("session ") or body.startswith("claude-mem"):
                last = None
            elif body.startswith("→ "):  # a tool call: "→ Name {json}"
                name, _, rest = body[2:].partition(" ")
                try:
                    inp = json.loads(rest)
                    inp = inp if isinstance(inp, dict) else {"command": rest}
                except Exception:  # the log keeps only the first part of a long call: pick the value out of the cut JSON
                    bs = chr(92)
                    mm = re.match(r'^\{"(command|file_path|path|pattern)":"(.*)$', rest)
                    if mm:
                        val = mm.group(2).rstrip("…").replace(bs + '"', '"').replace(bs + "n", "\n").replace(bs + bs, bs)
                        inp = {mm.group(1): val}
                    else:
                        inp = {"command": rest} if name == "Bash" else {"file_path": rest}
                last = {"t": t, "k": "tool", "id": role + str(len(cur["steps"])), "name": name or "tool", "input": inp, "status": "completed", "out": ""}
                cur["steps"].append(last)
            elif body.lstrip().startswith("⎿"):  # the result of the last tool
                res = body.lstrip()[1:].strip()
                tool = next((x for x in reversed(cur["steps"]) if x.get("k") == "tool"), None)
                if tool is not None:
                    tool["out"] = _wv_keep((tool["out"] + "\n" + res).strip(), 6000)
                    if re.match(r"(?i)^(error|exit code [1-9])", res):
                        tool["status"] = "error"
                    last = tool
            elif body.startswith("■") or " exited " in body or "hit your" in body:
                last = {"t": t, "k": "note", "text": body}
                cur["steps"].append(last)
                if " exited " in body or body.startswith("■"):
                    cur["done"] = True
            else:
                last = {"t": t, "k": "text", "text": body}
                cur["steps"].append(last)
        live = time.time() - mt < 150
        for i, r in enumerate(runs):
            steps = r["steps"]
            if live and i == len(runs) - 1 and not r["done"]:
                tool = next((x for x in reversed(steps) if x.get("k") == "tool"), None)
                if tool is not None and steps[-1] is tool and not tool["out"]:
                    tool["status"] = "running"
            agents.append({"id": r["id"], "agent": r["agent"], "title": _wv_clip((r["agent"].capitalize() + " · " + (steps[0]["text"] if steps and steps[0].get("k") == "user" else "")), 90),
                           "since": r["since"], "total": len(steps), "steps": steps[-limit:]})
    return agents


def wv_opencode_steps(ticket, router, limit=300, base_root=None):
    """The OpenCode sessions of the ticket (or the router), plus its Claude Code designer and planner runs, as timeline agents."""
    d = _wv_db_steps(ticket, router, limit, base_root)
    if router or not ticket:
        return d
    try:
        extra = wv_claude_log_agents(ticket, base_root, limit)
    except Exception as e:
        print("[wv] claude steps failed: " + str(e), file=sys.stderr)
        extra = []
    if extra:
        d = {"agents": sorted(list(d.get("agents") or []) + extra, key=lambda x: x.get("since") or 0)}
    return d

`;
s = s.replace(a2, () => FN + a2);
fs.writeFileSync(S, s);
console.log('claude-steps: applied');
