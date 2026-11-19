// Workov: the ticket drawer's Timeline shows "Loading timeline…" when you switch to another ticket.
// Opening another ticket kept the previous ticket's steps (or an empty pane) on screen until the new request answered, with no sign
// that anything was loading, and a slow answer of the old ticket could even be drawn into the new one. Now the pane is cleared and
// shows a loader the moment the ticket changes, a stale answer is ignored, and a failed request says so.
// Apply after agent-steps / claude-steps and board-loading. Idempotent.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
const raw = fs.readFileSync(H, 'utf8');
const crlf = raw.includes('\r\n');
let h = raw.replace(/\r\n/g, '\n');
if (!h.includes('lastU')) {
  const sub = (a, b) => { if (!h.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 80)); h = h.replace(a, () => b); };
  sub("keep = new Set(), sig = '', pref = 'steps', busy = false;", "keep = new Set(), sig = '', pref = 'steps', busy = false, lastU = null;");
  sub("      var u = o.url(); if (pref !== 'steps' || !u || busy || document.hidden || !host.offsetParent) return; busy = true;\n      try {\n        var r = await fetch(u, { headers: getAuthHeaders() }); if (!r.ok) return; var d = await r.json();",
      "      var u = o.url();\n      if (u !== lastU) { // another ticket: clear the old steps and say it is loading\n        lastU = u; sig = ''; keep.clear(); host.replaceChildren();\n        if (u) { var ld = document.createElement('div'); ld.className = 'st-empty st-loading'; ld.setAttribute('role', 'status'); ld.textContent = 'Loading timeline…'; host.append(ld); }\n      }\n      if (pref !== 'steps' || !u || busy || document.hidden || !host.offsetParent) return; busy = true;\n      try {\n        var r = await fetch(u, { headers: getAuthHeaders() });\n        if (o.url() !== u) return; // the drawer moved on to another ticket: ignore this answer\n        if (!r.ok) { if (host.querySelector('.st-loading')) host.firstChild.textContent = 'Could not load the timeline.'; return; }\n        var d = await r.json(); if (o.url() !== u) return;");
  sub("} catch (e) { /* keeps the last view */ } finally { busy = false; }", "} catch (e) { /* keeps the last view */ if (host.querySelector('.st-loading')) host.firstChild.textContent = 'Could not load the timeline.'; } finally { busy = false; if (o.url() !== u) setTimeout(function () { load(false); }, 0); }");
  sub('  </head>', '    <style id="wv-timeline-loading-css">\n      .st-loading { display: flex; align-items: center; gap: 8px; }\n      .st-loading::before { content: ""; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: wv-spin 0.8s linear infinite; flex: none; }\n      @media (prefers-reduced-motion: reduce) { .st-loading::before { animation: none; } }\n    </style>\n  </head>');
  fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
}
console.log('timeline-loading: applied');
