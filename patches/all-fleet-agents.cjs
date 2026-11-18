// Workov: the dashboard's Agents section listed only the heartbeats of the hub's own project (and the router's neutral-folder
// sessions), so the ticket writer of another project (job/status-writer-NNN.json, written by plan.cjs inside that project's
// fleet home) never showed. The hub now also collects the heartbeats of every other registered project, runs by the same
// code under that project's context, with ticket ids shown as PREFIX-NNN-slug and a `project` field. Idempotent.
const fs = require('fs');
const f = '.claude/scripts/dashboard-server.py';
if (!fs.existsSync(f)) process.exit(0);
let s = fs.readFileSync(f, 'utf8');
const crlf = s.includes('\r\n');
s = s.replace(/\r\n/g, '\n');
if (s.includes('_wv_worker_statuses_one')) process.exit(0);
const anchor = '\n\n# --- Telemetry (ticket 014) ---';
if (!s.includes('def get_worker_statuses():') || !s.includes(anchor) || !s.includes('_WV_CTX')) { console.log('all-fleet-agents: anchors missing, skipped'); process.exit(0); }
const add = `

_wv_worker_statuses_one = get_worker_statuses


def get_worker_statuses():
    """The hub's own heartbeats plus those of every other registered project (ticket ids as PREFIX-NNN-slug)."""
    rows = _wv_worker_statuses_one()
    if getattr(_WV_CTX, "root", None):
        return rows
    prefixes = wv_prefixes()
    for f in wv_fleets():
        if wv_norm_root(f["root"]) == wv_norm_root(_WV_BASE_ROOT):
            continue
        pre = prefixes.get(wv_norm_root(f["root"]), "")
        _WV_CTX.root = f["root"]
        try:
            extra = _wv_worker_statuses_one()
        except Exception:
            extra = []
        finally:
            _WV_CTX.root = None
        for w in extra:
            t = str(w.get("ticket", "")).strip()
            if not t and not w.get("phase"):
                continue  # a file that is not a worker heartbeat (the router once wrote its notes to job/status.json)
            if t and pre and not t.startswith(pre + "-"):
                w["ticket"] = pre + "-" + t
            w["project"] = f["name"]
            rows.append(w)
    return rows
`;
s = s.replace(anchor, () => add + anchor);
fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('agents of every project listed');
