// Workov: a ticket you answered shows your answer, and you can change it.
// The drawer and the answer window said "You answered at 13:23: ..." only for the hub's own tickets (answers were keyed by number
// from the hub's own folder). For a ticket of another project nothing showed that an answer was sent, or what it said. Now
// /api/wv/projects sends `answer` ({text, at, state: delivered|saved}) from the ticket's user-decision.md, and answerFor() reads it,
// so the drawer shows "You answered at HH:MM: “text”" and both places offer "Send a new answer" to change it. It does not expire.
// Apply after question-visible. Idempotent.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const rd = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing (apply question-visible first): ' + a.slice(0, 90)); };

let s = rd(S);
if (!s.includes('wv-answer')) {
  const a = '            if r["awaiting"] or r["status"] == "blocked":';
  must(s, a);
  s = s.replace(a, () => '            if r["status"] != "done":\n                r["answer"] = wv_ticket_answer(root, r["id"])  # wv-answer\n' + a);
  const b = 'def wv_ticket_question(root, num):';
  must(s, b);
  s = s.replace(b, () => String.raw`def wv_ticket_answer(root, num):
    """The owner's latest answer to a ticket (its user-decision.md): {"text","at","state","answered"} or None. delivered once the router passed it on."""
    try:
        d = next(iter(sorted((Path(root) / "specs" / "tickets").glob(num + "-*"))), None)
        txt = (d / "user-decision.md").read_text(encoding="utf-8", errors="replace") if d else ""
    except OSError:
        return None
    if not txt.strip():
        return None
    m = re.search(r"\*\*Submitted:\*\*\s*(\S+)", txt)
    at = m.group(1) if m else ""
    sent = False
    for f in wv_fleet_json(root, "job/router-state.json").get("forwardedDecisions") or []:
        if isinstance(f, dict) and ("/" + d.name + "/") in (str(f.get("path", "")).replace(chr(92), "/") + "/") and str(f.get("submitted", "")) >= at:
            sent = True
    return {"text": txt.split("## Instructions", 1)[-1].strip()[:1500], "at": at, "state": "delivered" if sent else "saved", "answered": True}


` + b);
  fs.writeFileSync(S, s);
}

const raw = fs.readFileSync(H, 'utf8');
const crlf = raw.includes('\r\n');
let h = raw.replace(/\r\n/g, '\n');
if (!h.includes('wv-answer-foreign')) {
  const sub = (a, b) => { must(h, a); h = h.replace(a, () => b); };
  sub("question: t.question || '' });", "question: t.question || '', answer: t.answer || null });");
  sub('const a = stateData && stateData.answers && stateData.answers[pipelineNum(id)];',
      "const f = window.wvForeignById ? window.wvForeignById(id) : null; // wv-answer-foreign\n        const a = f ? f.answer : stateData && stateData.answers && stateData.answers[pipelineNum(id)];");
  fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
}
console.log('answer-visible: applied');
