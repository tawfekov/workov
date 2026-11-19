// Workov: a finished mockup waits for your approval, with "Approve mockup" and "Request changes" (a dialog for your note).
// The designer's end used to move the ticket straight to Todo, so the mockup was never approved or questioned on the board. Now the ticket
// stays in Design with the state "review"; Approve moves it to Todo and records the approval in the ticket; Request changes opens a dialog,
// sends your note to the designer (job/briefs/NNN-design-changes.md) which revises the mockup (the previous one stays as mockup.prev.html),
// and asks you again. The dialog is a generic "changes" action, ready for other stages. Apply after stage-ui and stage-queue. Idempotent.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
const H = '.claude/dashboard/index.html';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 90)); };

// server: the designer reads the changes brief when there is one
let s = fs.readFileSync(S, 'utf8').replace(/\r\n/g, '\n');
if (!s.includes('wv-design-changes')) {
  const a = '        _wv_stage_run(root, ["node", ".claude/scripts/mockup.cjs", d.name], tid + "-designer-run.log", done)';
  must(s, a);
  s = s.replace(a, () => '        cmd = ["node", ".claude/scripts/mockup.cjs", d.name]\n        if Path(root, "job", "briefs", tid + "-design-changes.md").is_file():  # wv-design-changes\n            cmd.append("job/briefs/" + tid + "-design-changes.md")\n        _wv_stage_run(root, cmd, tid + "-designer-run.log", done)');
  fs.writeFileSync(S, s);
}

// client
const raw = fs.readFileSync(H, 'utf8');
const crlf = raw.includes('\r\n');
let h = raw.replace(/\r\n/g, '\n');
if (!h.includes('wvChangesDialog')) {
  const sub = (a, b) => { must(h, a); h = h.replace(a, () => b); };
  sub('      function buildStageActions(d) {', [
    '      // A dialog for a note that sends a ticket back (Request changes): the note goes with the action to the stage engine.',
    '      function wvChangesDialog(d, a) {',
    "        const dlg = document.createElement('dialog');",
    "        dlg.style.cssText = 'max-width:34rem;width:92vw;padding:1rem 1.25rem;border-radius:12px;border:1px solid var(--border,#888);background:var(--surface,#fff);color:inherit';",
    "        const ta = h('textarea', { rows: '6', 'aria-label': a.title || 'Request changes', placeholder: a.hint || 'What should change?' });",
    "        ta.style.cssText = 'width:100%;margin:.5rem 0';",
    "        const close = () => { dlg.close(); dlg.remove(); };",
    "        const send = h('button', { type: 'button', class: 'btn btn-sm primary', text: 'Send back', onclick: async () => { if (!ta.value.trim()) { ta.focus(); return; } send.disabled = true; await wvStageAct(d.id, a.op, { note: ta.value.trim() }); close(); } });",
    "        const cancel = h('button', { type: 'button', class: 'btn btn-sm', text: 'Cancel', onclick: close });",
    "        const row = h('div', { style: 'display:flex;gap:.5rem;justify-content:flex-end' });",
    '        row.append(cancel, send);',
    "        dlg.append(h('h3', { text: (a.title || 'Request changes') + ' · ' + d.id }), h('p', { class: 'note-s', text: a.hint || '' }), ta, row);",
    "        dlg.addEventListener('cancel', () => dlg.remove());",
    '        document.body.append(dlg);',
    '        dlg.showModal();',
    '        ta.focus();',
    '      }',
    '      function buildStageActions(d) {'
  ].join('\n'));
  sub("          if (a.type === 'note') {", "          if (a.type === 'changes') return row.append(h('button', { type: 'button', class: 'btn btn-sm', text: a.label, onclick: (ev) => { ev.stopPropagation(); wvChangesDialog(d, a); } }));\n          if (a.type === 'note') {");
  sub("        if (st.design === 'running') info.push(h('span', { class: 'note-s', text: 'The designer is working…' }));", "        if (st.design === 'running') info.push(h('span', { class: 'note-s', text: 'The designer is working…' }));\n        if (st.design === 'review') info.push(h('span', { class: 'note-s', text: 'The mockup is ready: open its tab, then approve it or request changes.' }));");
  fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
}
console.log('design-approval: applied');
