// Workov: the stage buttons (Design, Skip design, Review, Dispatch, Retry...) work on the tickets of OTHER projects too.
// Before: a ticket of another project reached the board as { id, title, status, ... } without its stage, buttons and ask
// (the server already sends them in /api/wv/projects), and the one wv_stage action always ran on the hub's own folder, so a
// ticket of another project waiting in Design had no button and no way to move.
//  - the board keeps stage, actions, stageState, ask, needsYou, paused, prUrl and waits of every project ticket
//  - wvStageAct posts the ticket's own project and number when the card belongs to another project
//  - the wv_stage action runs the stage engine on that project's folder (hooks start the designer, reviewer, PR there)
// Apply after stages-v2 and board-projects. Idempotent.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const rd = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing (apply stages-v2 and board-projects first): ' + a.slice(0, 80)); };

// ---------- server: the wv_stage action takes an optional project
let s = rd(S);
if (!s.includes('wv-project-stage')) {
  const a = '    op = str(req.get("op") or "")\n    root = str(REPO_ROOT)\n    args = {k: req.get(k) for k in ("choice", "note", "by", "model") if req.get(k) is not None}';
  must(s, a);
  s = s.replace(a, () => '    op = str(req.get("op") or "")\n    root = str(REPO_ROOT)\n' +
    '    project = str(req.get("project") or "")  # wv-project-stage: a ticket of another project is acted on in that project\'s folder\n' +
    '    if project:\n' +
    '        fleet = next((f for f in wv_fleets() if f["name"] == project), None)\n' +
    '        if not fleet:\n' +
    '            return 404, {"error": "Unknown project: " + project}\n' +
    '        root = str(fleet["root"])\n' +
    '    args = {k: req.get(k) for k in ("choice", "note", "by", "model") if req.get(k) is not None}');
  fs.writeFileSync(S, s);
}

// ---------- page: keep the stage fields of other projects' tickets, and post the project with the action
let h = rd(H);
const crlf = fs.readFileSync(H, 'utf8').includes('\r\n');
if (!h.includes('function wvStageTarget(')) {
  const a1 = "wvProject: p.name, awaiting: !!t.awaiting, wvRaw: t.id });";
  must(h, a1);
  h = h.replace(a1, () => "wvProject: p.name, awaiting: !!t.awaiting, wvRaw: t.id, stage: t.stage, actions: t.actions, stageState: t.stageState, ask: t.ask, needsYou: t.needsYou, paused: t.paused, prUrl: t.prUrl, waits: t.waits });");

  const a2 = "async function wvStageAct(id, op, extra) {";
  must(h, a2);
  h = h.replace(a2, () =>
    "// A card of another project posts that project's name and the ticket's own number; the hub acts on that project's folder.\n" +
    "      function wvStageTarget(id, op) {\n" +
    "        const f = window.wvForeignById ? window.wvForeignById(id) : null;\n" +
    "        return f ? { action: 'wv_stage', ticket: f.wvRaw, project: f.wvProject, op: op } : { action: 'wv_stage', ticket: id, op: op };\n" +
    "      }\n" +
    "      " + a2);

  const a3 = "body: JSON.stringify(Object.assign({ action: 'wv_stage', ticket: id, op: op }, extra || {})),";
  must(h, a3);
  h = h.replace(a3, () => "body: JSON.stringify(Object.assign(wvStageTarget(id, op), extra || {})),");
  fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
}
console.log('project-stage-actions: applied');
