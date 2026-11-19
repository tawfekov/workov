// Workov: the question a ticket asks is shown where you answer it.
// A ticket blocked by the fleet gate (or by a worker) showed "The worker did not leave a note" in the answer window and "The worker
// is waiting for your answer" in the drawer: the question itself sits in the ticket's rd.md (## Open questions), which the page never
// read for a ticket of another project. Now /api/wv/projects sends `question` (the last open-questions section that is not "None")
// for every ticket that waits for you, and the drawer and the answer window show it before any worker note.
// Apply after project-stage-actions and all-projects-views. Idempotent.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const rd = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 90)); };

let s = rd(S);
if (!s.includes('wv-question')) {
  const a = '            r["awaiting"] = r["status"] != "done" and r["id"] in pending';
  must(s, a);
  s = s.replace(a, () => a + '\n            if r["awaiting"] or r["status"] == "blocked":\n                r["question"] = wv_ticket_question(root, r["id"])  # wv-question');
  const b = 'def wv_projects():';
  must(s, b);
  s = s.replace(b, () => String.raw`def wv_ticket_question(root, num):
    """The question a ticket asks the owner: the last "## Open questions" section of its rd.md whose text is not "None". '' when there is none."""
    try:
        d = next(iter(sorted((Path(root) / "specs" / "tickets").glob(num + "-*"))), None)
        text = (d / "rd.md").read_text(encoding="utf-8", errors="replace") if d else ""
    except OSError:
        return ""
    best = ""
    for m in re.finditer(r"^##\s+Open questions[^\n]*\n(.*?)(?=^##\s|\Z)", text, re.M | re.S):
        body = m.group(1).strip()
        if body and not re.match(r"^(none|n/a|-)\b", body, re.I):
            best = body
    return best[:2500]


` + b);
  fs.writeFileSync(S, s);
}

const raw = fs.readFileSync(H, 'utf8');
const crlf = raw.includes('\r\n');
let h = raw.replace(/\r\n/g, '\n');
if (!h.includes('wvQuestionFor')) {
  const sub = (a, b) => { must(h, a); h = h.replace(a, () => b); };
  sub('running: !!t.running, port: t.port });', 'running: !!t.running, port: t.port, question: t.question || \'\' });');
  sub('      function workerNoteFor(num) {', "      function wvQuestionFor(id) {\n        const f = window.wvForeignById ? window.wvForeignById(id) : null;\n        return f && f.question ? String(f.question) : '';\n      }\n      function workerNoteFor(num) {");
  sub(": workerNoteFor(pipelineNum(currentTicket)) ||\n                  'The worker is waiting for your answer.',", ": wvQuestionFor(currentTicket) ||\n                  workerNoteFor(pipelineNum(currentTicket)) ||\n                  'The worker is waiting for your answer.',");
  sub("const wvNote = workerNoteFor(pipelineNum(ticketId)) || '';\n        setText(\n          $('#decision-question'),\n          wvNote ? 'Last note from the worker: ' + wvNote : 'The worker did not leave a note.',\n        );",
      "const wvQ = wvQuestionFor(ticketId);\n        const wvNote = workerNoteFor(pipelineNum(ticketId)) || '';\n        setText(\n          $('#decision-question'),\n          wvQ ? 'QUESTION: ' + wvQ : wvNote ? 'Last note from the worker: ' + wvNote : 'The worker did not leave a note.',\n        );");
  fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
}
console.log('question-visible: applied');
