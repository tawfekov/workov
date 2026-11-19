// Workov: stage UI polish.
//  - the stage buttons (Design, Skip design, Review, Dispatch, Retry...) are also in the ticket drawer footer, for the tickets of
//    every project (the cards already have them; see project-stage-actions)
//  - the buttons are smaller, and the board columns a little wider
//  - a ticket that is in the Design stage but whose designer has not been started shows PRE-DESIGN instead of DESIGN
// Apply after project-stage-actions. Idempotent.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
const raw = fs.readFileSync(H, 'utf8');
const crlf = raw.includes('\r\n');
let h = raw.replace(/\r\n/g, '\n');
const must = (a) => { if (!h.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 90)); };
const once = (a, b) => { must(a); h = h.replace(a, () => b); };

if (!h.includes('id="wv-stage-ui-css"')) {
  // 1. CSS: smaller buttons, wider columns, the drawer row
  once('</head>', [
    '<style id="wv-stage-ui-css">',
    '      .kanban-grid { grid-auto-columns: minmax(272px, 1fr); }',
    '      .stage-acts .btn, .stage-acts .btn.btn-sm, #drawer-stage-container .btn { padding: 2px 9px; min-height: 0; font-size: 11px; line-height: 1.5; border-radius: 6px; }',
    '      .stage-acts { gap: 4px; }',
    '      #drawer-stage-container { margin-bottom: 8px; }',
    '      #drawer-stage-container:empty { display: none; }',
    '    </style>',
    '  </head>',
  ].join('\n'));

  // 2. PRE-DESIGN on the card and in the drawer when the designer has not been started
  once('function buildCardStatus(status) {', 'function buildCardStatus(status, d) {');
  once("const word = known ? CARD_STATUS_WORD[key] : status;",
    "const word = known ? (key === 'designing' && d && !(d.stageState && d.stageState.design) ? 'PRE-DESIGN' : CARD_STATUS_WORD[key]) : status;");
  once('if (d.status !== \'done\') ids.push(buildCardStatus(d.status));', 'if (d.status !== \'done\') ids.push(buildCardStatus(d.status, d));');
  once("setText($('#drawer-status'), sl.label);",
    "setText($('#drawer-status'), st === 'designing' && !(t.stageState && t.stageState.design) ? 'PRE-DESIGN' : sl.label);");

  // 3. the drawer footer gets the stage buttons
  once('<div id="drawer-action-container"></div>', '<div id="drawer-stage-container"></div>\n          <div id="drawer-action-container"></div>');
  once('      function syncDrawerFromState() {',
    [
      '      // The stage buttons of the open ticket (any project) in the drawer footer; rebuilt only when they change.',
      '      function renderDrawerStageActions(id) {',
      "        const box = document.getElementById('drawer-stage-container');",
      '        if (!box) return;',
      '        const t = ticketById(id);',
      "        const sig = t ? JSON.stringify([t.id, t.status, t.actions, t.stageState, t.ask && t.ask.text, t.waits]) : '';",
      '        if (box.dataset.sig === sig) return;',
      '        box.dataset.sig = sig;',
      "        box.textContent = '';",
      '        const row = t ? buildStageActions(t) : null;',
      '        if (row) box.append(row);',
      '      }',
      '',
      '      function syncDrawerFromState() {',
    ].join('\n'));
  once("setText($('#drawer-decision-send'), ans ? 'Send a new answer' : 'Send decision');\n        renderActionRow(currentTicket);",
    "setText($('#drawer-decision-send'), ans ? 'Send a new answer' : 'Send decision');\n        renderActionRow(currentTicket);\n        renderDrawerStageActions(currentTicket);");
  fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
}
console.log('stage-ui: applied');
