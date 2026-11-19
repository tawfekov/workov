// Workov: a ticket that waits for a free agent slot to be planned says so ("waiting for planning"), not "not being written yet".
// Planning takes an agent slot like a worker; the plan queue (wv-plan-queue.py) starts the next writer when a slot is free.
// Apply after writer-state. Idempotent.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8');
const a = '⏳ not being written yet';
if (s.includes(a)) {
  s = s.split(a).join('⏳ waiting for planning (queued for a free agent slot)');
  fs.writeFileSync(S, s);
}
console.log('plan-queue-label: applied');
