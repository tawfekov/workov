// Workov: the one router runs its subagents (workers, testers, reviewers) from a neutral folder that belongs to no project, so
// the dashboard's agent views (ticket Logs tab, Agents roster, steps) skipped them: they only accepted sessions whose folder was
// inside the project. Sessions in the neutral folder now count (the ticket number in the title and the ticket's birth time still
// pick the right ones). Idempotent; applied to .claude/scripts/dashboard-server.py.
const fs = require('fs');
const f = '.claude/scripts/dashboard-server.py';
if (!fs.existsSync(f)) process.exit(0);
let s = fs.readFileSync(f, 'utf8');
const crlf = s.includes('\r\n');
s = s.replace(/\r\n/g, '\n');
if (s.includes('def wv_in_neutral')) process.exit(0);
let n = 0;
const sub = (from, to) => { if (s.includes(from)) { s = s.split(from).join(to); n++; } };
if (!s.includes('def wv_opencode_db():')) { console.log('neutral-sessions: anchor missing, skipped'); process.exit(0); }
s = s.replace('def wv_opencode_db():', () => `def wv_in_neutral(d):
    """a session in the router's neutral folder (~/Workov/router): where the one router's subagents run"""
    neutral = str(Path.home() / "Workov" / "router").replace("\\\\", "/").rstrip("/").lower()
    return str(d or "").replace("\\\\", "/").lower().startswith(neutral)


def wv_opencode_db():`);
sub('and (d == root or d.startswith(root)):', 'and (d == root or d.startswith(root) or wv_in_neutral(d)):');
sub('(d == root or d.startswith(root) or "-" + str(ticket) + "-" in d):', '(d == root or d.startswith(root) or wv_in_neutral(d) or "-" + str(ticket) + "-" in d):');
sub('if (d or "").replace("\\\\", "/").startswith(root):', 'if (d or "").replace("\\\\", "/").startswith(root) or wv_in_neutral(d):');
sub('if not (r[6] or "").replace("\\\\", "/").lower().startswith(root):', 'if not ((r[6] or "").replace("\\\\", "/").lower().startswith(root) or wv_in_neutral(r[6])):');
fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('neutral-folder agent sessions shown (' + n + ' places)');
