// Workov: the Agents section followed heartbeat files only. A worker the router has just started has no heartbeat yet (and the
// router writes the board and the ledger late), so it did not show; and finished writers stayed listed as "done" for ever, which made
// the list look stale. Now (1) every live worker session (wv-sessions.py live) without a heartbeat row is listed as a starting
// worker of its project, and (2) a finished (`done`) writer or worker is hidden half an hour after it finished.
// Idempotent; applied to .claude/scripts/dashboard-server.py after all-fleet-agents.cjs.
const fs = require('fs');
const f = '.claude/scripts/dashboard-server.py';
if (!fs.existsSync(f)) process.exit(0);
let s = fs.readFileSync(f, 'utf8');
const crlf = s.includes('\r\n');
s = s.replace(/\r\n/g, '\n');
if (s.includes('wv-agents-live')) process.exit(0);
const a = '            w["project"] = f["name"]\n            rows.append(w)\n    return rows\n';
if (!s.includes(a)) { console.log('agents-live: anchor missing, skipped'); process.exit(0); }
const add = [
  '            w["project"] = f["name"]',
  '            rows.append(w)',
  '    # wv-agents-live: live worker sessions that have no heartbeat row yet, and no stale finished rows',
  '    try:',
  '        import importlib.util as _iu',
  '        _spec = _iu.spec_from_file_location("wv_sessions", Path.home() / ".wv-bin" / "wv-sessions.py")',
  '        _m = _iu.module_from_spec(_spec)',
  '        _spec.loader.exec_module(_m)',
  '        hub_name = next((x["name"] for x in wv_fleets() if wv_norm_root(x["root"]) == wv_norm_root(_WV_BASE_ROOT)), "")',
  '        have = set()',
  '        for w in rows:',
  '            if w.get("role") != "writer":',
  '                mm = re.search(r"(\d{3})", str(w.get("ticket", "")))',
  '                have.add(((w.get("project") or hub_name), mm.group(1) if mm else ""))',
  '        nowms = time.time() * 1000',
  '        for sx in _m.live():',
  '            if (sx["fleet"], sx["ticket"]) in have:',
  '                continue',
  '            have.add((sx["fleet"], sx["ticket"]))',
  '            pre = prefixes.get(wv_norm_root(sx["root"]), "")',
  '            slug = next((d.name for d in sorted((Path(sx["root"]) / "specs" / "tickets").glob(sx["ticket"] + "-*"))), sx["ticket"])',
  '            own = wv_norm_root(sx["root"]) == wv_norm_root(_WV_BASE_ROOT)',
  '            rows.append({"ticket": slug if own else (pre + "-" + slug), "role": "worker", "phase": "building", "note": sx["title"], "isActive": True, "isStalled": False,',
  '                         "heartbeatAgeSec": int((nowms - sx["updated"]) / 1000), "project": None if own else sx["fleet"], "file": "OpenCode session", "superseded": False})',
  '    except Exception:',
  '        pass',
  '    rows = [w for w in rows if not (str(w.get("phase", "")).lower() == "done" and w.get("heartbeatAgeSec", 0) > 1800)]',
  '    return rows',
  '',
].join('\n');
s = s.replace(a, () => add);
fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('agents list shows live worker sessions and hides stale finished rows');
