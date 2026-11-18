// Workov: nothing lands with an unanswered skip, and a failed ticket has no live worker. Idempotent; applied to the router's agent files.
const fs = require('fs');
const path = require('path');
const MARK = '<!-- wv-gate-skips -->';
const END = '<!--/ wv-gate-skips -->';
const TEXT = `## Never land a skip; never leave a worker running on a closed ticket

Before you spawn the merger for a ticket, or write \`in-review\` or \`done\` for it, run \`python3 -I "$HOME/.wv-bin/wv-gate.py" <NNN>\` from the project folder. Exit 1 means a check was marked SKIP without the owner's
answer: the gate has already made the ticket \`blocked\` with a question, so do not land it, say so in your summary line and stop for that ticket.
When you mark a ticket \`failed\`, \`blocked\` or \`done\`, its worker session must stop too: the loop's \`wv-sessions.py reap\` does it, so never re-dispatch a ticket while
\`python3 -I "$HOME/.wv-bin/wv-sessions.py" live\` lists a worker for it. An answer in \`user-decision.md\` for a ticket with no live worker is handled by \`wv-settle.py\` before your turn.`;
let n = 0;
for (const dir of ['.claude/agents', '.opencode/agents']) {
  const f = path.join(dir, 'router.md');
  if (!fs.existsSync(f)) continue;
  let s = fs.readFileSync(f, 'utf8');
  const crlf = s.includes('\r\n');
  s = s.replace(/\r\n/g, '\n');
  if (s.includes(MARK)) continue;
  const block = `${MARK}\n${TEXT}\n${END}\n\n`;
  const m = /^---\n[\s\S]*?\n---\n/.exec(s);
  s = m ? s.slice(0, m[0].length) + '\n' + block + s.slice(m[0].length).replace(/^\n+/, '') : block + s;
  fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
  n++;
}
if (n) console.log('gate-skips rule added to ' + n + ' router files');
