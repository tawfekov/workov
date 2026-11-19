// Workov: a planner that stops with a question (writer `needs you`) shows the question and takes your answer on the dashboard.
// A ticket whose planner ended `waiting-user` (it needs something only the owner has, e.g. a requirement text) sat in Plan with no
// sign on the card, no question and no way to answer: only the board's title said "needs your answer". Now it counts as "needs you",
// its drawer and answer window show the planner's open questions, and your answer (written to the ticket's user-decision.md like any
// answer) is picked up by wv-plan.py, which resumes the planner with it. Apply after question-visible. Idempotent.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 90)); };

let s = fs.readFileSync(S, 'utf8').replace(/\r\n/g, '\n');
if (!s.includes('wv-writer-question')) {
  const a = '            if r["awaiting"] or r["status"] == "blocked":';
  must(s, a);
  s = s.replace(a, () => '            if r["awaiting"] or r["status"] == "blocked" or r.get("writer") == "needs you":  # wv-writer-question');
  fs.writeFileSync(S, s);
}

const raw = fs.readFileSync(H, 'utf8');
const crlf = raw.includes('\r\n');
let h = raw.replace(/\r\n/g, '\n');
if (!h.includes('wv-writer-need')) {
  const sub = (a, b) => { must(h, a); h = h.replace(a, () => b); };
  sub("needsYou: !!ticket.needsYou || NEED_STATUS.indexOf(status) >= 0,", "needsYou: !!ticket.needsYou || NEED_STATUS.indexOf(status) >= 0 || ticket.writer === 'needs you', // wv-writer-need");
  sub("return st === 'blocked' || (!!pe && pe.phase === 'awaiting-user' && st !== 'done');", "return st === 'blocked' || (!!t && t.writer === 'needs you') || (!!pe && pe.phase === 'awaiting-user' && st !== 'done');");
  fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
}
console.log('writer-question: applied');
