// Workov: Telemetry counts the work of every project, not only the hub's own folder.
// telemetry.py scanned Claude Code, OpenCode and Codex logs for ONE folder (the dashboard's own). The hub holds no tickets of its own:
// the workers, planners and designers run in the project folders (fleets/<project>, their worktrees) and the one router in its
// neutral folder, so the page showed 0 tokens, $0 and 0 sessions. Now the totals, the roles, the models and the sessions add up every
// registered project (~/.workov/fleets.json) plus the neutral folder. A project's tickets in "Per ticket" carry its board prefix
// (EJA-009, ADM-001) so numbers of different projects never mix, and never touch the hub's own budget keys.
// A project folder is matched exactly (its Claude project folder, its OpenCode directory and worktrees), never by a name fragment.
// Apply after telemetry-v2. Idempotent.
const fs = require('fs');
const T = '.claude/scripts/telemetry.py';
let s = fs.readFileSync(T, 'utf8').replace(/\r\n/g, '\n');
if (s.includes('def _extra_roots')) { console.log('telemetry-all-projects: already applied'); process.exit(0); }
const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 80)); };
const sub = (a, b) => { must(a); s = s.replace(a, () => b); };

sub('def _claude_project_dirs(root: Path, home: Path):', 'def _claude_project_dirs(root: Path, home: Path, strict: bool = False):');
sub('    if not dirs:\n        dirs = [d for d in base.glob(f"*{root.name}*") if d.is_dir()]', '    if not dirs and not strict:\n        dirs = [d for d in base.glob(f"*{root.name}*") if d.is_dir()]');
sub('def _collect_claude(root: Path, home: Path):', 'def _collect_claude(root: Path, home: Path, strict: bool = False):');
sub('    for pdir in _claude_project_dirs(root, home):\n        for jf in pdir.rglob("*.jsonl"):', '    for pdir in _claude_project_dirs(root, home, strict):\n        for jf in pdir.rglob("*.jsonl"):');

const FN = String.raw`
def _extra_roots(root: Path, home: Path):
    """Every other registered project folder, with the prefix its tickets carry on the board, plus the one router's neutral folder."""
    out, used = [], set()
    try:
        fleets = json.loads((home / ".workov" / "fleets.json").read_text(encoding="utf-8"))
    except Exception:
        fleets = []
    here = str(root).replace("\\", "/").rstrip("/").lower()
    for f in fleets if isinstance(fleets, list) else []:
        name, fr = str(f.get("name", "")), str(f.get("root", ""))
        letters = re.sub(r"[^A-Za-z]", "", name).upper() + "XXX"  # the same rule the board uses for its ticket prefixes
        cands = [letters[:3]] + [letters[:2] + c for c in letters[2:]] + [letters[:2] + chr(c) for c in range(65, 91)]
        pick = next((c for c in cands if c not in used), letters[:3])
        used.add(pick)
        if fr and fr.replace("\\", "/").rstrip("/").lower() != here:
            out.append((pick, Path(fr)))
    neutral = home / "Workov" / "router"
    if neutral.is_dir() and str(neutral).replace("\\", "/").rstrip("/").lower() != here:
        out.append(("", neutral))
    return out


`;
const a = 'def get_telemetry(window="all", run_id=None, repo_root=None, *, home=None,';
sub(a, FN.replace(/^\n/, '') + a);

sub('    x_recs, x_trunc = _collect_codex(root, home_dir)\n',
  '    x_recs, x_trunc = _collect_codex(root, home_dir)\n' +
  '    for pre, r2 in _extra_roots(root, home_dir):  # the other projects and the router (see telemetry-all-projects)\n' +
  '        try:\n' +
  '            cc, ct = _collect_claude(r2, home_dir, strict=True)\n' +
  '            oo, _ = _collect_opencode(r2, home_dir)\n' +
  '            xx, xt = _collect_codex(r2, home_dir)\n' +
  '        except Exception:\n' +
  '            continue\n' +
  '        c_trunc, x_trunc = c_trunc + ct, x_trunc + xt\n' +
  '        for bucket, recs in ((c_recs, cc), (o_recs, oo), (x_recs, xx)):\n' +
  '            for rec in recs:\n' +
  '                rec = dict(rec)\n' +
  '                rec["ticket"] = (pre + "-" + rec["ticket"]) if (pre and rec.get("ticket")) else ""\n' +
  '                bucket.append(rec)\n');
fs.writeFileSync(T, s);
console.log('telemetry-all-projects: applied');
