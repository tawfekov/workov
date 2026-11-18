// Workov: the ticket drawer's Logs / Timeline for a ticket of ANOTHER project (ADM-001, THE-004 ...). The one dashboard serves every
// project, but the OpenCode sessions of a worker are recorded under the hub's folder, so the steps lookup, which matched the session
// directory against the project folder, found nothing ("Nothing here yet"). For a project other than the hub the sessions are matched by
// the ticket's own words in the session title (its folder slug), and the "older than rd.md" filter, which a worker's own rd.md edits
// defeat, is skipped. Idempotent; run from the fleet folder.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
if (!fs.existsSync(S)) { console.log('steps-other-project: no server, skipped'); process.exit(0); }
let s = fs.readFileSync(S, 'utf8');
const crlf = s.includes('\r\n');
s = s.replace(/\r\n/g, '\n');
if (s.includes('slug_words')) { console.log('steps-other-project: already applied'); process.exit(0); }
const a = s.indexOf('def wv_opencode_steps(');
if (a < 0) { console.log('steps-other-project: anchors not found, skipped'); process.exit(0); }
const b = s.indexOf('\ndef ', a + 10);
let f = s.slice(a, b);
const BS = String.fromCharCode(92);
const steps = [
  ['    root = str(REPO_ROOT)', null], // placeholder to keep the list readable
];
function swap(old, neu) {
  if (!f.includes(old)) { f = null; return false; }
  f = f.replace(old, () => neu);
  return true;
}
const rootLine = '        root = str(REPO_ROOT).replace("' + BS + BS + '", "/").rstrip("/")';
const ok =
  swap(rootLine, rootLine + '\n        other = _wv_norm_root_safe(REPO_ROOT) != _wv_norm_root_safe(_WV_BASE_ROOT)  # another project: its sessions are recorded under the hub folder') &&
  swap('                if agent != "router" and title and pat.search(title) and (d == root or d.startswith(root) or wv_in_neutral(d) or "-" + str(ticket) + "-" in d):',
       '                if agent != "router" and title and pat.search(title) and (d == root or d.startswith(root) or wv_in_neutral(d) or "-" + str(ticket) + "-" in d or (slug_words and slug_words in title.lower())):') &&
  swap('            pat = re.compile(r"',
       '            slug_words = ""\n            if other:\n                sd = next(iter(sorted((REPO_ROOT / "specs" / "tickets").glob(f"{ticket}-*"))), None)\n                slug_words = sd.name[len(ticket) + 1:].replace("-", " ").lower() if sd else ""\n            pat = re.compile(r"') &&
  swap('            if ids and born:', '            if ids and born and not other:');
if (!ok || f === null) { console.log('steps-other-project: anchors not found, skipped'); process.exit(0); }
const helper = 'def _wv_norm_root_safe(p):\n    return str(p).replace("' + BS + BS + '", "/").rstrip("/").lower()\n\n\n';
s = s.slice(0, a) + helper + f + s.slice(b);
fs.writeFileSync(S, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('steps-other-project: patched');
