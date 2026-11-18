// Workov: the dashboard's Timeline recorded and showed only the hub's own project, so the tickets of every other project (their
// writing, approval, build...) never appeared. The sampler now records each registered project into that project's own
// job/timeline.jsonl, and the Timeline lists all of them with ids shown as PREFIX-NNN. A `specifying` ticket's stage says what is
// really happening: writing | needs your answer | waiting for a writer. Idempotent; .claude/scripts/dashboard-server.py.
const fs = require('fs');
const f = '.claude/scripts/dashboard-server.py';
if (!fs.existsSync(f)) process.exit(0);
let s = fs.readFileSync(f, 'utf8');
const crlf = s.includes('\r\n');
s = s.replace(/\r\n/g, '\n');
if (s.includes('_wv_timeline_sample_one')) process.exit(0);
const need = ['def wv_timeline_sample(last):', 'def wv_timeline_loop():', 'def wv_timeline():', '    if st == "specifying":\n        return "plan"\n', 'def wv_writer_state(', 'def wv_prefixes():'];
for (const n of need) if (!s.includes(n)) { console.log('timeline-all: anchor missing (' + n.slice(0, 30) + '), skipped'); process.exit(0); }
s = s.replace('    if st == "specifying":\n        return "plan"\n', () => '    if st == "specifying":\n        return {"writing": "plan (writing)", "needs you": "waiting: your answer", "waiting for a writer": "plan (no writer yet)"}.get(wv_writer_state(str(REPO_ROOT), row["id"]), "plan")\n');
s = s.replace('def wv_timeline_sample(last):', 'def _wv_timeline_sample_one(last):');
s = s.replace('def wv_timeline_loop():\n    last = {}\n', () => `def wv_timeline_sample(lasts):
    """Record every registered project into its own job/timeline.jsonl (the sample code runs under that project's context)."""
    for f in wv_fleets():
        root = f["root"]
        _WV_CTX.root = None if wv_norm_root(root) == wv_norm_root(_WV_BASE_ROOT) else root
        try:
            last = lasts.setdefault(wv_norm_root(root), {})
            if not last:
                try:
                    for ln in WV_TL_FILE.read_text(encoding="utf-8").splitlines():
                        d = json.loads(ln)
                        last[d["ticket"]] = d["stage"]
                except Exception:
                    pass
            _wv_timeline_sample_one(last)
        except Exception as e:
            print(f"[wv] timeline sample failed for {f['name']}: {e}", file=sys.stderr)
        finally:
            _WV_CTX.root = None


def wv_timeline_loop():
    last = {}
`);
s = s.replace('            wv_timeline_sample(last)\n', '            wv_timeline_sample(last)\n'.replace('last', 'lasts_all'));
s = s.replace('def wv_timeline_loop():\n    last = {}\n', 'def wv_timeline_loop():\n    lasts_all = {}\n    last = {}\n');
s = s.replace('def wv_timeline():\n', 'def _wv_timeline_one():\n');
const TL = `
_wv_timeline_one_fn = _wv_timeline_one


def wv_timeline():
    """Every project's timeline, one list; other projects' ids as PREFIX-NNN."""
    tickets = []
    note = ""
    prefixes = wv_prefixes()
    for f in wv_fleets():
        root = f["root"]
        own = wv_norm_root(root) == wv_norm_root(_WV_BASE_ROOT)
        _WV_CTX.root = None if own else root
        try:
            part = _wv_timeline_one_fn()
        except Exception:
            part = {"tickets": []}
        finally:
            _WV_CTX.root = None
        note = note or part.get("note", "")
        pre = prefixes.get(wv_norm_root(root), "")
        for t in part.get("tickets", []):
            if not own and pre:
                t["id"] = pre + "-" + t["id"]
            t["project"] = f["name"]
            tickets.append(t)
    return {"tickets": sorted(tickets, key=lambda t: t["since"], reverse=True), "note": note}
`;
const mainAt = s.indexOf('\nif __name__ == "__main__":');
if (mainAt < 0) { console.log('timeline-all: main block not found, skipped'); process.exit(0); }
s = s.slice(0, mainAt) + '\n' + TL + s.slice(mainAt);
fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('timeline covers every project');
