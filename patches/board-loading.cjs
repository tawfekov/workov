// Workov: while the projects load, the board columns show "Loading tickets…" (with a spinner), not "No tickets".
// The tickets of every project arrive in a second request (/api/wv/projects) after the page's own state, so for a moment every
// column said "No tickets" as if the board were empty. Now an empty column says it is loading until that request has answered
// (also when it fails), and then shows the tickets or "No tickets". Apply after all-projects-views. Idempotent.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
const raw = fs.readFileSync(H, 'utf8');
const crlf = raw.includes('\r\n');
let h = raw.replace(/\r\n/g, '\n');
if (!h.includes('wvProjectsLoaded')) {
  const sub = (a, b) => { if (!h.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 80)); h = h.replace(a, () => b); };
  sub("const sig = JSON.stringify(st === 'done' ? [infos, dayKey] : infos);", "const sig = JSON.stringify(st === 'done' ? [infos, dayKey] : infos) + (window.wvProjectsLoaded ? '' : '|loading');");
  sub("              if (!infos.length) {\n                box.append(h('div', { class: 'lane-empty', text: 'No tickets' }));",
      "              if (!infos.length) {\n                box.append(window.wvProjectsLoaded ? h('div', { class: 'lane-empty', text: 'No tickets' }) : h('div', { class: 'lane-empty lane-loading', role: 'status', 'aria-live': 'polite', text: 'Loading tickets…' }));");
  sub("        foreign = next; fill();", "        foreign = next; window.wvProjectsLoaded = true; fill();");
  sub("}).catch(function () { /* the board still shows the local tickets */ });", "}).catch(function () { /* the board still shows the local tickets */ window.wvProjectsLoaded = true; redraw(); });");
  sub('  </head>', '    <style id="wv-loading-css">\n      .lane-loading { display: flex; align-items: center; justify-content: center; gap: 8px; }\n      .lane-loading::before { content: ""; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: wv-spin 0.8s linear infinite; }\n      @keyframes wv-spin { to { transform: rotate(360deg); } }\n      @media (prefers-reduced-motion: reduce) { .lane-loading::before { animation: none; } }\n    </style>\n  </head>');
  fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
}
console.log('board-loading: applied');
