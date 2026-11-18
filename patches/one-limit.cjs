// Workov: ONE agent limit. Planning, designing, building and review all draw from the same pool (concurrency.maxParallelWorkers,
// default 4; wv-bin/wv-sessions.py pool_cap/slots_used). This removes what the old planner-limit patch added to a dashboard that
// already has it: the Planners selector next to Workers, the second (planner) ring in the Ring tab and its script. The selector that
// stays is renamed Agents. Idempotent; run from the fleet folder. The server's planner functions are left in place but unused.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
if (!fs.existsSync(H)) { console.log('one-limit: no dashboard, skipped'); process.exit(0); }
let h = fs.readFileSync(H, 'utf8');
const crlf = h.includes('\r\n');
h = h.replace(/\r\n/g, '\n');
const before = h;
// the Planners selector (its label, any leading space)
h = h.replace(/ ?<label class="note-s"[^>]*>Planners <select id="board-planners"[\s\S]*?<\/select><\/label>/, '');
// the second ring
h = h.replace(/[ \t]*<div id="planner-ring"[^>]*><\/div>\n/, '');
// its script
h = h.replace(/<script id="wv-planners-js">[\s\S]*?<\/script>\n?/, '');
// one limit: say so on the remaining selector
h = h.replace('>Workers <select id="board-workers" aria-label="Maximum parallel workers"', '>Agents <select id="board-workers" title="One limit for every agent: planning, designing, building and review" aria-label="Maximum parallel agents (planning, designing, building, review)"');
// an idle git worktree is not an agent: a worktree with no worker heartbeat is listed only while its ticket is being built or queued
const WT = "          const phase = (match && match.phase) || wt.displayPhase || 'building';";
if (h.includes(WT) && !h.includes('wv-idle-worktree')) {
  h = h.replace(WT, () => '          // wv-idle-worktree: a kept worktree of a ticket that is not being built is not a running agent' + '\n' +
    "          if (!match && ticketStatusById[wt.ticket || ''] && !['in-progress', 'ready'].includes(ticketStatusById[wt.ticket || ''])) return;" + '\n' + WT);
}
if (h === before) { console.log('one-limit: nothing to change'); process.exit(0); }
fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
console.log('one-limit: planner limit and second ring removed; the Workers selector is now Agents');
