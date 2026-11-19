// Workov: a ticket that waits for its planner shows PRE-PLAN (like PRE-DESIGN), whatever it depends on.
// A ticket in Plan whose writer has not started (it is queued for a free agent slot) said "PLAN" like one being written, and the
// "waits for 009" of its Runs column made it look blocked by that ticket. Planning never waits for a dependency (only building does),
// so the card and the drawer say PRE-PLAN until the planner runs. Apply after stage-ui and all-projects-views. Idempotent.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
const raw = fs.readFileSync(H, 'utf8');
const crlf = raw.includes('\r\n');
let h = raw.replace(/\r\n/g, '\n');
if (!h.includes('PRE-PLAN')) {
  const sub = (a, b) => { if (!h.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 80)); h = h.replace(a, () => b); };
  sub("running: !!t.running, port: t.port,", "running: !!t.running, writer: t.writer || '', port: t.port,");
  sub("          needsYou: !!ticket.needsYou || NEED_STATUS.indexOf(status) >= 0,", "          writer: ticket.writer || '',\n          needsYou: !!ticket.needsYou || NEED_STATUS.indexOf(status) >= 0,");
  sub("const word = known ? (key === 'designing' &&", "const word = known ? (key === 'specifying' && d && d.writer === 'waiting for a writer' ? 'PRE-PLAN' : key === 'designing' &&");
  sub("setText($('#drawer-status'), st === 'designing' &&", "setText($('#drawer-status'), st === 'specifying' && t.writer === 'waiting for a writer' ? 'PRE-PLAN' : st === 'designing' &&");
  fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
}
console.log('pre-plan-label: applied');
