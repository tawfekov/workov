// Workov: the ticket stage pipeline. Draft - Plan - Design - Todo - Building - Review - Deliver - Done.
//   new real statuses: designing, todo, delivering (plus the existing draft, specifying, ready, in-progress, in-review, done);
//   blocked / failed / budget-exceeded stay as statuses but are a "Needs you" flag on the card, in the column the ticket was in.
// All transitions are decided in code, not by a model: ~/.wv-bin/wv-stage.py (engine), started by the dashboard server (one action,
// `wv_stage`), by wv-settle / wv-dispatch / wv-adopt (they all write status through the engine) and by the server's 30 s loop.
// Patches: dashboard-server.py (statuses, the stage block, the action, the state annotation), index.html (8 columns, card buttons,
// vocabulary), review.cjs (findings no longer flip the board: the owner chooses Fix or Skip), land.cjs (delivering counts),
// the router and planner agent rules. Idempotent: every part has a marker; a part whose anchors are not found is skipped.
const fs = require('fs');
const path = require('path');

const here = __dirname;
const note = [];
function edit(file, label, fn) {
  if (!fs.existsSync(file)) return;
  let s = fs.readFileSync(file, 'utf8');
  const crlf = s.includes('\r\n');
  s = s.replace(/\r\n/g, '\n');
  const out = fn(s);
  if (out === null) { note.push(label + ': anchors not found, skipped'); return; }
  if (out === s) return;
  fs.writeFileSync(file, crlf ? out.replace(/\n/g, '\r\n') : out);
  note.push(label + ': patched');
}
// replace exactly one anchor; a missing anchor aborts the whole file (null) so a file is never half patched
function swap(s, old, neu) {
  if (s === null) return null;
  let i = s.indexOf(old), len = old.length;
  if (i < 0) { // an older dashboard layout is indented by 4 and column padded: match with any run of whitespace
    const m = new RegExp(old.trim().replace(/\((\w+)\) =>/g, '$1 =>').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).exec(s);
    if (m) { i = m.index; len = m[0].length; neu = neu.replace(/^\s+/, ''); }
  }
  if (i < 0) { if (process.env.WV_DEBUG) console.log('stages-v2 anchor missing: ' + JSON.stringify(old.slice(0, 110))); return null; }
  return s.slice(0, i) + neu + s.slice(i + len);
}
const txt = (n) => fs.readFileSync(path.join(here, n), 'utf8').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------- the server
edit('.claude/scripts/dashboard-server.py', 'stages-v2 server', (s) => {
  if (s.includes('# ---- stages v2')) return s;
  let o = s;
  o = swap(o, '    "budget-exceeded",\n    "in-review",\n)', '    "budget-exceeded",\n    "in-review",\n    "designing",\n    "todo",\n    "delivering",\n)');
  o = swap(o, 'if w.get("role") != "writer"', 'if w.get("role") not in ("writer", "designer")');
  o = swap(o, 'if matching_workers and t["status"] != "done":', 'if matching_workers and t["status"] not in ("done", "draft", "specifying", "designing", "todo", "in-review", "delivering"):');
  o = swap(o, 'def wv_run_action(action, req, tid):', txt('stages-v2.server.py.txt') + 'def wv_run_action(action, req, tid):');
  o = swap(o, '    if action == "wv_review":\n        by = str(req.get("by", "claude"))', '    if action == "wv_stage":\n        return wv_stage_action(tid, req)\n    if action == "wv_review":\n        by = str(req.get("by", "claude"))');
  o = swap(o, '"wv_retry_ticket", "wv_project_action")', '"wv_retry_ticket", "wv_project_action", "wv_stage")');
  o = swap(o, '            if not WV_FLEET_OFF.exists():\n                _wp = Path.home()', '            if not WV_FLEET_OFF.exists():\n                wv_stage_tick_all()\n                _wp = Path.home()');
  o = swap(o, '                t["doneAt"] = read_done_at(t)\n', '                t["doneAt"] = read_done_at(t)\n            wv_stage_annotate(tickets)\n');
  o = swap(o, '        rows = wv_fleet_rows(root)\n        for r in rows:\n            r["running"]', '        rows = wv_fleet_rows(root)\n        if wv_norm_root(root) != wv_norm_root(_WV_BASE_ROOT):\n            wv_stage_annotate(rows, root)\n        for r in rows:\n            r["running"]');
  o = swap(o, '        if row["status"] != "draft":\n            return 409, {"error": f"Ticket {tid} is \'{row[\'status\']}\', not a draft."}\n        wv_project_set_status(root, tid, "ready")\n        return 200, {"ok": True, "note": f"Ticket {tid} of {name} is ready; its router picks it up on the next cycle."}',
    '        code, body = wv_stage_mod().act(root, tid, "dispatch", {}, WV_STAGE_HOOKS)\n        if code == 200:\n            body["note"] = f"Ticket {tid} of {name}: " + body.get("note", "dispatched.")\n        return code, body');
  o = swap(o, '    status = get_ticket_status_for_control(tid)\n    if status not in ("failed", "budget-exceeded", "blocked"):', '    _other = wv_stage_retry_other(tid)\n    if _other:\n        return _other\n    status = get_ticket_status_for_control(tid)\n    if status not in ("failed", "budget-exceeded", "blocked"):');
  o = swap(o, '                    self._audit_action(req, "ok")\n                    self._send_json(200, {"ok": True, "ticket": ticket_id, "newStatus": new_status, "updated": updated})',
    '                    try:\n                        wv_stage_mod().set_status(str(REPO_ROOT), ticket_id, new_status)\n                    except Exception:\n                        pass\n                    self._audit_action(req, "ok")\n                    self._send_json(200, {"ok": True, "ticket": ticket_id, "newStatus": new_status, "updated": updated})');
  return o;
});

// ---------------------------------------------------------------- the board
edit('.claude/dashboard/index.html', 'stages-v2 ui', (s) => {
  if (s.includes('/* stages v2:')) return s;
  let o = s;
  // vocabulary
  o = o === null ? null : o.replace(/const STATUS_ORDER = \[[\s\S]*?\];/, "const STATUS_ORDER = [\n        'draft',\n        'specifying',\n        'designing',\n        'todo',\n        'ready',\n        'in-progress',\n        'in-review',\n        'delivering',\n        'blocked',\n        'failed',\n        'budget-exceeded',\n        'done',\n      ];");
  if (o !== null && !o.includes("draft: { lamp: 'off', lit: false, label: 'DRAFT', name: 'Draft' },")) { // an older layout: quoted, column padded keys
    const m = /^( *)'draft':\s*\{ lamp: 'off',[^\n]*\n/m.exec(o);
    const add = (k, v) => m[1] + "'" + k + "': " + v + ',\n';
    o = m ? o.slice(0, m.index + m[0].length) + add('designing', "{ lamp: 'info', lit: true, label: 'DESIGN', name: 'Design' }") + add('todo', "{ lamp: 'ready', lit: false, label: 'TODO', name: 'Todo' }") + add('delivering', "{ lamp: 'info', lit: true, label: 'DELIVERING', name: 'Deliver' }") + o.slice(m.index + m[0].length) : null;
  } else
  o = swap(o, "draft: { lamp: 'off', lit: false, label: 'DRAFT', name: 'Draft' },", "draft: { lamp: 'off', lit: false, label: 'DRAFT', name: 'Draft' },\n        designing: { lamp: 'info', lit: true, label: 'DESIGN', name: 'Design' },\n        todo: { lamp: 'ready', lit: false, label: 'TODO', name: 'Todo' },\n        delivering: { lamp: 'info', lit: true, label: 'DELIVERING', name: 'Deliver' },");
  // constants
  if (o !== null) {
    const re = /const STAGES = \['plan', 'queue', 'building', 'done'\];[\s\S]*?const CARD_STATUS_WORD = \{[\s\S]*?\n\s*\};\n/;
    o = re.test(o) ? o.replace(re, () => txt('stages-v2.consts.js.txt')) : null;
  }
  // the lamp of a column
  if (o !== null) {
    const a = o.indexOf('function stageLamp(stage, infos) {');
    const b = o.indexOf('function loadStageChoices()');
    if (a < 0 || b < a) o = null;
    else o = o.slice(0, a) + `function stageLamp(stage, infos) {
        if (infos.some((d) => d.needsYou)) return ['attn', true];
        const has = (s) => infos.some((d) => d.status === s);
        if (stage === 'plan') return has('specifying') ? ['info', true] : ['off', false];
        if (stage === 'design') return has('designing') ? ['info', true] : ['off', false];
        if (stage === 'todo') return ['ready', false];
        if (stage === 'building') return has('in-progress') ? ['run', true] : ['off', false];
        if (stage === 'review' || stage === 'deliver') return infos.length ? ['info', true] : ['off', false];
        return ['off', false];
      }

      ` + o.slice(b);
  }
  o = swap(o, 'return stage === \'building\' && count > 0;', "return stage !== 'done' && stage !== 'draft' && count > 0;");
  o = swap(o, "['plan', 'queue', 'building'].forEach((stage) => {", "STAGES.filter((s) => s !== 'done').forEach((stage) => {");
  o = o !== null && o.includes('(stagePart(stage, a.status) - stagePart(stage, b.status))') ? o.replace('(stagePart(stage, a.status) - stagePart(stage, b.status))', 'stagePart2(stage, a) - stagePart2(stage, b)') : swap(o, 'stagePart(stage, a.status) - stagePart(stage, b.status) ||', 'stagePart2(stage, a) - stagePart2(stage, b) ||');
  o = swap(o, 'byStage[stageOfStatus(d.status)].push(d);', '(byStage[stageOfCard(d)] || byStage.draft).push(d);');
  o = swap(o, 'stageShown(stageOfStatus(d.status)) &&', 'stageShown(stageOfCard(d)) &&');
  o = swap(o, `          if (st === 'building') {
            const need = infos.filter((d) => NEED_STATUS.includes(d.status)).length;
            const el = document.getElementById('stage-building-need');
            setText(el, need === 1 ? '· 1 needs you' : '· ' + need + ' need you');
            if (el.hidden !== (need === 0)) el.hidden = need === 0;
          }`, `          {
            const need = infos.filter((d) => d.needsYou).length;
            const el = document.getElementById('stage-' + st + '-need');
            if (el) {
              setText(el, need === 1 ? '· 1 needs you' : '· ' + need + ' need you');
              if (el.hidden !== (need === 0)) el.hidden = need === 0;
            }
          }`);
  // card data and card
  o = swap(o, 'pr: findPrUrl(ticket.id),', `pr: findPrUrl(ticket.id) || ticket.prUrl || '',
          stage: ticket.stage || null,
          needsYou: !!ticket.needsYou || NEED_STATUS.indexOf(status) >= 0,
          ask: ticket.ask || null,
          waits: Array.isArray(ticket.waits) ? ticket.waits.slice() : [],
          actions: Array.isArray(ticket.actions) ? ticket.actions : [],
          stageState: ticket.stageState || null,`);
  o = swap(o, "if (d.status !== 'done') ids.push(buildCardStatus(d.status));", "if (d.status !== 'done') ids.push(buildCardStatus(d.status));\n        if (d.needsYou) ids.push(h('span', { class: 'plate attn need-chip', title: 'This ticket waits for you', text: 'Needs you' }));");
  o = swap(o, "if (d.deps.length)\n          meta.push(h('span', { class: 'dep', text: 'after ' + d.deps.join(' · ') }));", "if (d.deps.length)\n          meta.push(h('span', { class: 'dep', text: 'after ' + d.deps.join(' · ') }));\n        if (d.waits && d.waits.length)\n          meta.push(h('span', { class: 'plate quiet waits-chip', title: 'Dispatch is possible when these are done', text: 'waits for ' + d.waits.join(' · ') }));");
  o = swap(o, "          meta.length ? h('div', { class: 'meta' }, meta) : null,\n        );", "          meta.length ? h('div', { class: 'meta' }, meta) : null,\n          buildStageActions(d),\n        );") ?? swap(o, "meta.length ? h('div', { class: 'meta' }, meta) : null);", "meta.length ? h('div', { class: 'meta' }, meta) : null,\n        buildStageActions(d));");
  o = swap(o, 'return WIDE_MQ.matches && !COARSE_MQ.matches;', 'return false; /* stages v2: Dispatch is a button, not a drag */');
  o = swap(o, "onclick: () => setTicketStatus(ticketId, 'ready'),\n              },\n              'Approve & mark ready',", "onclick: () => wvStageAct(ticketId, 'dispatch'),\n              },\n              'Dispatch',") ?? swap(o, "onclick: () => setTicketStatus(ticketId, 'ready') }, 'Approve & mark ready'", "onclick: () => wvStageAct(ticketId, 'dispatch') }, 'Dispatch'");
  o = swap(o, '      async function setTicketStatus(ticketId, newStatus) {', '      ' + txt('stages-v2.actions.js.txt').trim() + '\n\n      async function setTicketStatus(ticketId, newStatus) {');
  o = o === null ? null : o.split("jumpToStage('plan')").join("jumpToStage('draft')");
  o = swap(o, 'renderStations(n);', 'renderStations(n + stageAskCount());');
  o = swap(o, "var ORDER = ['blocked', 'failed', 'in-review', 'in-progress', 'ready', 'specifying', 'draft', 'budget-exceeded', 'done'];", "var ORDER = ['blocked', 'failed', 'in-review', 'delivering', 'in-progress', 'ready', 'todo', 'designing', 'specifying', 'draft', 'budget-exceeded', 'done'];");
  o = swap(o, "'in-progress': 'Building', ready: 'Ready', specifying: 'Planning', draft: 'Draft',", "'in-progress': 'Building', ready: 'Queued', todo: 'Todo', designing: 'Design', delivering: 'Delivering', specifying: 'Planning', draft: 'Draft',");
  o = swap(o, "var op = t.status === 'draft' ?", "var op = (t.status === 'draft' || t.status === 'todo') ?");
  o = swap(o, '</style>', txt('stages-v2.css.txt') + '    </style>');
  // the eight columns
  if (o !== null) {
    const a = o.indexOf('<section id="stage-plan"');
    const c = o.indexOf('id="col-done"');
    const b = c < 0 ? -1 : o.indexOf('</section>', c);
    if (a < 0 || b < 0) o = null;
    else {
      const lamp = { todo: 'ready' };
      const sec = (st) => `<section id="stage-${st}" class="kanban-column" data-stage="${st}">
                <h2 class="column-title">
                  <button type="button" class="lane-toggle" aria-expanded="${st === 'done' ? 'false' : 'true'}" aria-controls="col-${st}">
                    <span class="lamp ${lamp[st] || 'off'}" aria-hidden="true"></span><span class="lane-name">${{ draft: 'Draft', plan: 'Plan', design: 'Design', todo: 'Todo', building: 'Building', review: 'Review', deliver: 'Deliver', done: 'Done' }[st]}</span><span id="count-${st}" class="c">–</span><span id="stage-${st}-need" class="stage-need" hidden></span><svg class="i chev" aria-hidden="true"><use href="#i-chev" /></svg>
                  </button>
                </h2>
                <div class="lane-note" hidden></div>
                <div id="col-${st}" class="ticket-list">
                  <div class="skeleton"></div>
                  <div class="skeleton"></div>
                </div>
              </section>`;
      o = o.slice(0, a) + ['draft', 'plan', 'design', 'todo', 'building', 'review', 'deliver', 'done'].map(sec).join('\n              ') + o.slice(b + '</section>'.length);
    }
  }
  return o;
});

// ---------------------------------------------------------------- review.cjs: the findings go to the owner, not back to the board
edit('.claude/scripts/review.cjs', 'stages-v2 review.cjs', (s) => {
  if (s.includes('/* wv-stages-v2 */')) return s;
  const a = s.indexOf("  if (state === 'findings') {\n    try {\n      const rd = ");
  const endMark = "catch (e) { line(`could not hand the findings back: ${clip(e.message, 200)}`); }\n  }\n";
  const b = s.indexOf(endMark);
  if (a < 0 || b < a) return null;
  let o = s.slice(0, a) + "  /* wv-stages-v2 */ if (state === 'findings') line(`${count} finding(s): the owner chooses Fix or Skip on the dashboard`);\n" + s.slice(b + endMark.length);
  const fm = "try { fm = JSON.parse(fs.readFileSync('specs/workov.config.json', 'utf8')).models.reviewer.opencode.model || fm; } catch {}";
  if (o.includes(fm)) o = o.replace(fm, () => fm + "\n    { const i = process.argv.indexOf('--fleet-model'); if (i > 0 && /^[\\w.-]+\\/[\\w.:/-]+$/.test(process.argv[i + 1] || '')) fm = process.argv[i + 1]; }");
  return o;
});
edit('.claude/scripts/land.cjs', 'stages-v2 land.cjs', (s) => {
  if (s.includes('in-progress|in-review|delivering|blocked|ready|draft')) return s;
  return swap(s, '(in-progress|in-review|blocked|ready|draft)', '(in-progress|in-review|delivering|blocked|ready|draft)');
});

// ---------------------------------------------------------------- agent rules
const ROUTER_MARK = '<!-- wv-stages-v2 -->';
const ROUTER = `## Ticket stages (Workov v2): the fleet code moves tickets, you do not

Board statuses and who moves them. \`draft\`: the owner's Dispatch sends it to the planner. \`specifying\`: the planner is writing.
\`designing\`: the owner chooses Design or Skip design. \`todo\`: planned, waits for the owner's Dispatch. \`ready\`: queued, dispatch it
(Step 2, dependencies done). \`in-progress\`: a worker builds it. \`in-review\`: the Review stage, decided by the owner and fleet code.
\`delivering\`: the pull request is being opened by fleet code. \`done\`. \`blocked\`, \`failed\`, \`budget-exceeded\` are a "Needs you" flag
on the card, in the column the ticket was in.

- You never set \`in-review\`, \`delivering\` or \`done\` yourself, never spawn the \`merger\` or a reviewer for a finished worker, and never
  run \`land.cjs\`: when a worker finishes (results.json written, no live worker) the fleet moves the ticket to \`in-review\`, and review,
  delivery and the pull request follow from the dashboard. Ignore the merger flow of Step 4 and the \`in-review\` polling of Step 5 in
  this file wherever they say otherwise; keep verification (wv-gate), reconcile, retries, blocked handling and dispatch.
- You never change \`draft\`, \`specifying\`, \`designing\` or \`todo\`. A ticket sent back with an Addendum section in rd.md (a review
  fix, a re-opened Done ticket) is dispatched like any \`ready\` ticket, on its existing branch and ledger entry.`;
const PLANNER_MARK = '<!-- wv-stages-v2-planner -->';
const PLANNER = `## Stage pipeline (Workov v2)

You are started only for a ticket the owner dispatched from Draft (board status \`specifying\`). In rd.md's header, next to
\`**Status:**\`, write \`**Mockup:** required\` when the ticket changes what a user sees (a new or changed screen, flow, layout, text in
the UI) and \`**Mockup:** none\` otherwise: the fleet then sends the ticket to Design or straight to Todo. When your spec is finished,
set the board row and \`**Status:**\` to \`draft\` exactly as before: the fleet notices it and moves the ticket on. Never write
\`designing\`, \`todo\`, \`ready\` or any later status yourself.`;
function addRule(files, mark, text, label) {
  let n = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    let s = fs.readFileSync(f, 'utf8');
    const crlf = s.includes('\r\n');
    s = s.replace(/\r\n/g, '\n');
    if (s.includes(mark)) continue;
    const block = `${mark}\n${text}\n${mark.replace('<!--', '<!--/')}\n\n`;
    const m = /^---\n[\s\S]*?\n---\n/.exec(s);
    s = m ? s.slice(0, m[0].length) + '\n' + block + s.slice(m[0].length).replace(/^\n+/, '') : block + s;
    fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
    n++;
  }
  if (n) note.push(label + ' added to ' + n + ' files');
}
addRule(['.claude/agents/router.md', '.opencode/agents/router.md'], ROUTER_MARK, ROUTER, 'stages-v2 router rule');
addRule(['.claude/agents/wv-planner.md', '.opencode/agents/wv-planner.md', '.opencode/agents/planner.md'], PLANNER_MARK, PLANNER, 'stages-v2 planner rule');

if (note.length) console.log(note.join('\n'));
