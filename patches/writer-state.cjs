// Workov: a `specifying` ticket looked the same whether its writer was running, finished and waiting for the owner, or had
// never started (a stub). The one board now says which: "writing" (a fresh writer heartbeat), "needs you" (the writer finished and
// left open questions) or "waiting for a writer" (nothing is writing it; wv-plan.py starts it when a slot is free).
// The state is added to the ticket's title on the board, for every project. Idempotent; .claude/scripts/dashboard-server.py.
const fs = require('fs');
const f = '.claude/scripts/dashboard-server.py';
if (!fs.existsSync(f)) process.exit(0);
let s = fs.readFileSync(f, 'utf8');
const crlf = s.includes('\r\n');
s = s.replace(/\r\n/g, '\n');
if (s.includes('def wv_writer_state')) process.exit(0);
const a = '        rows = wv_fleet_rows(root)\n        for r in rows:\n            r["running"] = r["id"] in live\n';
if (!s.includes(a)) { console.log('writer-state: anchor missing, skipped'); process.exit(0); }
s = s.replace('def wv_projects():', () => `def wv_writer_state(root, tid):
    """For a specifying ticket: writing | needs you | waiting for a writer."""
    base = Path(root)
    hb = base / "job" / ("status-writer-" + tid + ".json")
    try:
        data = json.loads(hb.read_text(encoding="utf-8")) if hb.is_file() else {}
        age = time.time() - hb.stat().st_mtime if hb.is_file() else 1e9
    except Exception:
        data, age = {}, 1e9
    phase = str(data.get("phase", "")).lower()
    if phase not in ("", "done", "waiting-user") and age < 300:
        return "writing"
    rd = next(iter((base / "specs" / "tickets").glob(tid + "-*/rd.md")), None)
    big = bool(rd and rd.stat().st_size > 1500)
    if data and phase in ("done", "waiting-user") and big:
        return "needs you"
    return "waiting for a writer"


def wv_projects():`);
s = s.replace(a, () => a + '            if r["status"] == "specifying":\n                r["writer"] = wv_writer_state(root, r["id"])\n                r["title"] = r["title"] + "  ·  " + {"writing": "✍ writing now", "needs you": "❓ needs your answer", "waiting for a writer": "⏳ not being written yet"}[r["writer"]]\n');
fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('writer state shown on the board');
