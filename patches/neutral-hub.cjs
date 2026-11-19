// Workov: a NEUTRAL hub. The folder that runs the dashboard / router loop / shared config belongs to no project, and every
// project (including the one that used to be the hub) is a normal project: its tickets are PREFIX-NNN on the board and in every
// API, the board is ordered the same for all of them (stage, then priority P0<P1<P2, then newest first), never by project.
//   dashboard-server.py
//     - wv_fleets(): the hub folder is listed as a project only when it is registered in fleets.json or still has tickets (an old
//       install); a ticket-less hub is never a project
//     - wv_project_by_prefix(): the hub folder is a valid target of a prefixed id too (no "own project" skip)
//     - wv_projects(): every project is annotated and "self" is always false; rows carry prio / deps / doneAt
//     - get_worker_statuses(), wv_timeline(), live sessions: no unprefixed own-project rows
//     - hub-level files (router loop log/pid, provider catalog, failover, chat bridge, notify secrets) are read from the hub
//       folder even while a request runs in a project's context; the router loop is started from the hub folder
//     - /api/permissions lists the requests of every project (they are written under the project's main checkout)
//     - a change of models in the hub (config, opencode.json, agent files) is mirrored into every project, whose workers read
//       their own copy
//   index.html (board script): local tickets are not shown (they are project tickets like all others), priority and
//   dependencies of every ticket are read, ordering is stage -> priority -> newest first.
// Anchors are whitespace tolerant; a missing anchor is reported and skipped. Idempotent.
const fs = require('fs');

function edit(file, fn) {
  if (!fs.existsSync(file)) return;
  let s = fs.readFileSync(file, 'utf8');
  const crlf = s.includes('\r\n');
  s = s.replace(/\r\n/g, '\n');
  if (s.includes('wv-neutral-hub')) return;
  const out = fn(s);
  if (out !== s) fs.writeFileSync(file, crlf ? out.replace(/\n/g, '\r\n') : out);
}
const miss = [];
function rep(s, re, to, what, all) {
  const r = all ? new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g') : re;
  if (!r.test(s)) { miss.push(what); return s; }
  r.lastIndex = 0;
  return s.replace(r, typeof to === 'function' ? to : (...g) => to.replace(/\$(\d)/g, (x, i) => (g[i] === undefined || typeof g[i] === 'number' ? x : g[i])));
}
const lit = (t) => new RegExp(t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'));

edit('.claude/scripts/dashboard-server.py', (s) => {
  // 1. the hub is a project only when registered or still holding tickets
  s = rep(s, /    for it in \(items if isinstance\(items, list\) else \[\]\) \+ \[\{"name": REPO_ROOT\.name, "root": str\(REPO_ROOT\)\}\]:\n/,
`    items = items if isinstance(items, list) else []
    # wv-neutral-hub: the hub folder is a project only when it is registered in fleets.json or still holds tickets (an old install)
    hub_is_project = any(isinstance(i, dict) and wv_norm_root(i.get("root", "")) == wv_norm_root(_WV_BASE_ROOT) for i in items) or bool(wv_fleet_rows(str(_WV_BASE_ROOT)))
    for it in items + ([{"name": Path(str(_WV_BASE_ROOT)).name, "root": str(_WV_BASE_ROOT)}] if hub_is_project else []):
`, 'wv_fleets');
  // 2. prefixed ids resolve to the hub folder too
  s = rep(s, /(def wv_project_by_prefix\(prefix\):\n    for f in wv_fleets\(\):\n)        if wv_norm_root\(f\["root"\]\) == wv_norm_root\(_WV_BASE_ROOT\):\n            continue\n/, '$1', 'wv_project_by_prefix');
  // 3. board rows carry prio / deps / doneAt
  s = rep(s, /    for m in re\.finditer\(r"\^\\\|\\s\*\(\\d\{3\}\)\\s\*\\\|\\s\*\(\[\^\|\]\*\?\)\\s\*\\\|\\s\*\(\[a-z-\]\+\)\\s\*\\\|\\s\*\(\[a-z\]\+\)\?", text, re\.M\):\n        rows\.append\(\{"id": m\.group\(1\), "title": m\.group\(2\), "status": m\.group\(3\), "mode": m\.group\(4\) or ""\}\)\n/,
`    for m in re.finditer(r"^\\|(.*)\\|[ \\t]*$", text, re.M):  # wv-neutral-hub: also the priority, the dependencies and the done time
        cells = [c.strip() for c in m.group(1).split("|")]
        if len(cells) < 4 or not re.fullmatch(r"\\d{3}", cells[0]) or not re.fullmatch(r"[a-z-]+", cells[2]):
            continue
        prio = cells[4].upper() if len(cells) >= 6 and re.fullmatch(r"[Pp][012]", cells[4]) else "P1"
        deps = re.findall(r"\\b(\\d{3})\\b", cells[-1]) if len(cells) >= 5 and cells[-1].lower().startswith("waits") else []
        row = {"id": cells[0], "title": cells[1], "status": cells[2], "mode": cells[3] if re.fullmatch(r"[a-z]+", cells[3]) else "", "prio": prio, "deps": deps}
        if cells[2] == "done":
            try:
                d = next(iter((Path(root) / "specs" / "tickets").glob(cells[0] + "-*")), None)
                fin = json.loads((d / "results.json").read_text(encoding="utf-8")).get("finishedAt") if d else None
                row["doneAt"] = fin if isinstance(fin, str) and re.fullmatch(r"\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ", fin) else None
            except Exception:
                pass
        rows.append(row)
`, 'wv_fleet_rows');
  s = rep(s, /        if wv_norm_root\(root\) != wv_norm_root\(_WV_BASE_ROOT\):\n            wv_stage_annotate\(rows, root\)\n/, '        wv_stage_annotate(rows, root)\n', 'wv_projects annotate');
  s = rep(s, /"self": wv_norm_root\(root\) == wv_norm_root\(REPO_ROOT\),/, '"self": False,', 'wv_projects self');
  // 4. worker rows, live sessions, timeline: every project is prefixed, none is "own"
  s = rep(s, /    rows = _wv_worker_statuses_one\(\)\n    if getattr\(_WV_CTX, "root", None\):\n        return rows\n    prefixes = wv_prefixes\(\)\n    for f in wv_fleets\(\):\n        if wv_norm_root\(f\["root"\]\) == wv_norm_root\(_WV_BASE_ROOT\):\n            continue\n/,
`    if getattr(_WV_CTX, "root", None):
        return _wv_worker_statuses_one()
    rows = []  # wv-neutral-hub: the hub folder has no workers of its own; every project is read the same way
    prefixes = wv_prefixes()
    for f in wv_fleets():
`, 'get_worker_statuses');
  s = rep(s, /            own = wv_norm_root\(sx\["root"\]\) == wv_norm_root\(_WV_BASE_ROOT\)\n/, '            own = False\n', 'sessions own');
  s = rep(s, /        own = wv_norm_root\(root\) == wv_norm_root\(_WV_BASE_ROOT\)\n        _WV_CTX\.root = None if own else root\n/, '        own = False\n        _WV_CTX.root = root\n', 'timeline own');
  s = rep(s, /other = bool\(base_root\) or wv_norm_root\(str\(BASE\)\) != wv_norm_root\(str\(_WV_BASE_ROOT\)\)/, 'other = True', 'steps other');
  // 5. hub-level files and the router loop come from the hub folder, also inside a project's request context
  s = rep(s, /REPO_ROOT \/ "job" \/ "(router-loop\.log|router-loop\.pid|provider-catalog-v3\.json|provider-logos|chat-bridge\.json|models-backup\.json|notify-secrets\.json|dashboard-url\.txt|failover-cwd)"/g, (m, f) => '_WV_BASE_ROOT / "job" / "' + f + '"', 'hub-level files');
  s = rep(s, /(router-loop\.sh"\], cwd=str\()REPO_ROOT(\))/g, (m, a, b) => a + '_WV_BASE_ROOT' + b, 'router cwd');
  // 6. permission requests of every project
  s = rep(s, /def wv_permissions\(\):\n    pdir = REPO_ROOT \/ "job" \/ "permissions"\n    rows = \[\]\n    for f in \(sorted\(pdir\.glob\("\*\.json"\)\) if pdir\.is_dir\(\) else \[\]\):\n/,
`def wv_permission_roots():
    return [Path(str(_WV_BASE_ROOT))] + [Path(f["root"]) for f in wv_fleets() if wv_norm_root(f["root"]) != wv_norm_root(_WV_BASE_ROOT)]


def wv_permission_file(pid):
    """wv-neutral-hub: a request is written under the main checkout of the project its worker runs in, not under the hub"""
    for base in wv_permission_roots():
        p = base / "job" / "permissions" / f"{pid}.json"
        if PERMISSION_ID_RE.match(str(pid)) and p.is_file():
            return p
    return Path(str(REPO_ROOT)) / "job" / "permissions" / f"{pid}.json"


def wv_permissions():
    rows = []
    files = []
    for base in wv_permission_roots():
        pdir = base / "job" / "permissions"
        files += sorted(pdir.glob("*.json")) if pdir.is_dir() else []
    for f in files:
`, 'wv_permissions');
  s = rep(s, /pfile = REPO_ROOT \/ "job" \/ "permissions" \/ f"\{pid\}\.json"/, 'pfile = wv_permission_file(pid)', 'decide_permission');
  // 7. a model change in the hub reaches every project
  s = rep(s, /(def wv_atomic_write\(path, text\):\n    fd, tmp = tempfile\.mkstemp\(dir=str\(Path\(path\)\.parent\)\)\n    with os\.fdopen\(fd, "w", encoding="utf-8"\) as fh:\n        fh\.write\(text\)\n    os\.replace\(tmp, path\)\n)/,
`$1    try:
        wv_hub_sync(path)
    except Exception as e:
        print(f"[wv] hub sync failed: {e}", file=sys.stderr)


def wv_hub_sync(path):
    """wv-neutral-hub: the hub holds the shared models; a project's workers read the project's OWN copy of the config, opencode.json
    and agent files, so a change of models made on the dashboard is mirrored there (models only, nothing else of the project)."""
    if getattr(_WV_CTX, "root", None):
        return
    base = Path(str(_WV_BASE_ROOT)).resolve()
    try:
        rel = Path(path).resolve().relative_to(base).as_posix()
    except ValueError:
        return
    kind = "cfg" if rel == "specs/worker-fleet.config.json" else "oc" if rel == "opencode.json" else "md" if rel.startswith(".opencode/agents/") and rel.endswith(".md") else ""
    if not kind:
        return
    src = base / rel
    for f in wv_fleets():
        root = Path(f["root"])
        dst = root / rel
        if wv_norm_root(root) == wv_norm_root(base) or not dst.is_file():
            continue
        try:
            if kind == "cfg":
                hub, pc = json.loads(src.read_text(encoding="utf-8")), json.loads(dst.read_text(encoding="utf-8"))
                if hub.get("models") and pc.get("models") != hub["models"]:
                    pc["models"] = hub["models"]
                    dst.write_text(json.dumps(pc, indent=2, ensure_ascii=False) + "\\n", encoding="utf-8")
            elif kind == "oc":
                hub, pc, ch = json.loads(src.read_text(encoding="utf-8")), json.loads(dst.read_text(encoding="utf-8")), False
                for role, v in (hub.get("agent") or {}).items():
                    if isinstance(v, dict) and v.get("model") and isinstance((pc.get("agent") or {}).get(role), dict) and pc["agent"][role].get("model") != v["model"]:
                        pc["agent"][role]["model"], ch = v["model"], True
                if ch:
                    dst.write_text(json.dumps(pc, indent=2, ensure_ascii=False) + "\\n", encoding="utf-8")
            else:
                m = re.search(r"^model:.*$", src.read_text(encoding="utf-8"), re.M)
                text = dst.read_text(encoding="utf-8")
                if m and re.search(r"^model:.*$", text, re.M) and m.group(0) not in text:
                    dst.write_text(re.sub(r"^model:.*$", lambda _m: m.group(0), text, count=1, flags=re.M), encoding="utf-8")
        except Exception as e:
            print(f"[wv] hub sync to {f.get('name')} skipped: {e}", file=sys.stderr)
`, 'wv_atomic_write');
  return s.replace(/^(#![^\n]*\n)?/, (m) => (m || '') + '# wv-neutral-hub\n');
});

edit('.claude/dashboard/index.html', (h) => {
  h = rep(h, /if \(selected === 'all' \|\| selected === window\.__wvSelf\) out = out\.concat\(local\);/, '/* wv-neutral-hub: every ticket is a project ticket; none is shown as local */', 'board local');
  h = rep(h, /if \(p\.self\) \{ window\.__wvSelf = p\.name; return; \}\s*/, '', 'board self');
  h = rep(h, /var out = local\.filter\(function \(t\) \{ return String\(t\.status \|\| ''\)\.toLowerCase\(\) === 'draft'; \}\)\.map\(function \(t\) \{ return \{ id: t\.id, local: true \}; \}\);/, 'var out = [];', 'drafts');
  h = rep(h, /prio: 'P1', runs: 'alongside', deps: \[\], dependents: \[\], wvProject: p\.name/,
    "prio: t.prio || 'P1', runs: 'alongside', deps: (t.deps || []).map(function (d) { return pre(p.name) + '-' + d; }), dependents: [], doneAt: t.doneAt || null, wvProject: p.name", 'board foreign row');
  h = rep(h, /(\s*)var sig = JSON\.stringify\(\[names, next\.map\(/, (m, ws) => ws + 'var byId = {}; next.forEach(function (t) { byId[t.id] = t; }); next.forEach(function (t) { t.deps.forEach(function (d) { if (byId[d]) byId[d].dependents.push(t.id); }); });' + ws + 'var sig = JSON.stringify([names, next.map(', 'board dependents');
  h = rep(h, /const prioRank = /, 'const wvNum = (d) => parseInt(String(d.projectRaw || d.id).replace(/\\D/g, \'\'), 10) || 0; // wv-neutral-hub: newest (highest number) first\n        const prioRank = ', 'wvNum');
  h = rep(h, /prioRank\(a\.prio\)\s*-\s*prioRank\(b\.prio\)(\)?)\s*\|\|\s*(\(?)a\.idx\s*-\s*b\.idx/, (m, p1, p2) => 'prioRank(a.prio) - prioRank(b.prio)' + p1 + ' || (wvNum(b) - wvNum(a)) || ' + p2 + 'a.idx - b.idx', 'board order');
  h = rep(h, /if \(x === null && y === null\) return b\.idx - a\.idx;/, 'if (x === null && y === null) return wvNum(b) - wvNum(a) || b.idx - a.idx;', 'done order');
  return h.replace('</body>', '<!-- wv-neutral-hub -->\n</body>');
});

if (miss.length) console.log('neutral-hub: anchors not found, skipped: ' + [...new Set(miss)].join(', '));
else console.log('neutral hub installed');
