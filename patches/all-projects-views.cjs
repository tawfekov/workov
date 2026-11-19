// Workov: the Ring and the Graph show the tickets of every project, not only the hub's own.
// The Ring counted running workers from the hub's own tickets and ports ("0 of 3 idle" while three workers ran), and the Graph drew
// only the hub's tickets ("No tickets on the board yet"). The hub holds no tickets of its own: they live in the registered projects
// (the board already merges them as "<PRE>-001" cards). Now:
//  - /api/wv/projects also says on which worker port a ticket runs
//  - the board's merged list (window.wvAllTickets) feeds the Ring and the Graph
//  - a project ticket that runs takes the slot of its worker port in the Ring
// Apply after project-stage-actions. Idempotent.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const rd = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 90)); };

let s = rd(S);
if (!s.includes('wv-ring-port')) {
  const a = '            r["running"] = r["id"] in live';
  must(s, a);
  s = s.replace(a, () => '            for tk in wv_live_tickets().get(f["name"], ()):  # a worker process that lives counts as running even without a dev server\n                live.setdefault(tk, None)\n' + a + '\n            r["port"] = live.get(r["id"])  # wv-ring-port');
  const b = 'def wv_projects():';
  must(s, b);
  s = s.replace(b, () => String.raw`_wv_live_cache = [0.0, {}]


def wv_live_tickets():
    """{project name: {ticket numbers with a live worker}}, from the list that enforces the worker cap (wv-sessions.py live). Cached 5 s."""
    if time.time() - _wv_live_cache[0] < 5:
        return _wv_live_cache[1]
    out = {}
    try:
        sp = Path.home() / ".wv-bin" / "wv-sessions.py"
        r = subprocess.run([sys.executable, "-I", str(sp), "live"], capture_output=True, text=True, timeout=15, creationflags=WV_NOWIN)
        for ln in (r.stdout or "").splitlines():
            parts = ln.split("\t")
            if len(parts) >= 2 and re.fullmatch(r"\d{3}", parts[1].strip()):
                out.setdefault(parts[0].strip(), set()).add(parts[1].strip())
    except Exception:
        pass
    _wv_live_cache[0], _wv_live_cache[1] = time.time(), out
    return out


` + b);
  fs.writeFileSync(S, s);
}

const raw = fs.readFileSync(H, 'utf8');
const crlf = raw.includes('\r\n');
let h = raw.replace(/\r\n/g, '\n');
if (!h.includes('function allTickets()')) {
  const sub = (a, b) => { must(h, a); h = h.replace(a, () => b); };
  // 1. the merged list, and the port and running state of a project ticket
  sub('prUrl: t.prUrl, waits: t.waits });', 'prUrl: t.prUrl, waits: t.waits, running: !!t.running, port: t.port });');
  sub('window.wvForeignById = foreignById;', 'window.wvForeignById = foreignById;\n    window.wvAllTickets = function (own) { var seen = {}; (own || []).forEach(function (t) { seen[t.id] = 1; }); return (own || []).concat(foreign.filter(function (f) { return !seen[f.id]; })); };');
  // 2. one helper next to the Ring
  sub('      function ringModel(attRows) {', '      // the hub\'s own tickets plus every project\'s (the board merges them; see board-projects)\n      function allTickets() {\n        const own = (stateData && stateData.tickets) || [];\n        return window.wvAllTickets ? window.wvAllTickets(own) : own;\n      }\n\n      function ringModel(attRows) {');
  // 3. the Ring
  sub('const tickets = (stateData.tickets || []).map((t, i) => {\n          let st = String(t.status || \'\').toLowerCase();',
      'const tickets = allTickets().map((t, i) => {\n          let st = String(t.status || \'\').toLowerCase();');
  sub('            idx: i,\n          };', '            idx: i,\n            foreign: !!t.wvProject,\n            fport: Number(t.port) || 0,\n            frun: !!t.running,\n          };');
  sub(".filter((t) => t.status !== 'done' && t.num && ports.has(t.num))", ".filter((t) => t.status !== 'done' && ((t.num && ports.has(t.num)) || (t.foreign && t.frun)))");
  sub('          const free = ports\n            .get(t.num)\n            .map((p) => p - base + 1)',
      '          const free = (t.foreign ? (t.fport ? [t.fport] : []) : ports.get(t.num))\n            .map((p) => p - base + 1)');
  // 4. the Graph: the picture, its filter (Find, Show done) and its keyboard moves
  sub('const tickets = stateData.tickets;\n        if (\n          !changed(\n            \'graph\',', 'const tickets = allTickets();\n        if (\n          !changed(\n            \'graph\',');
  sub("const tickets = (stateData && stateData.tickets) || [];\n        const matches = new Set();", "const tickets = allTickets();\n        const matches = new Set();");
  sub("const i = nodes.indexOf(n);\n        const tickets = (stateData && stateData.tickets) || [];", "const i = nodes.indexOf(n);\n        const tickets = allTickets();");
  fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
}
console.log('all-projects-views: applied');
