// Workov: switching from Cyberpunk or Tmzm back to Andon did nothing. The themes2 wrapper around applyTheme treats any
// Auto/Dark/Light call made while a styled theme is active as a MODE change (so the mode buttons keep the style). But
// chooseThemeStyle('andon') leaves the styled theme by calling applyTheme('auto'|'dark'|'light', true), which the wrapper
// swallowed as a mode change: the style never changed. The style switch now passes persist = 'style' and the wrapper only
// intercepts persist === true (the mode buttons). Idempotent; applied to .claude/dashboard/index.html.
const fs = require('fs');
const f = '.claude/dashboard/index.html';
if (!fs.existsSync(f)) process.exit(0);
let h = fs.readFileSync(f, 'utf8');
const crlf = h.includes('\r\n');
h = h.replace(/\r\n/g, '\n');
let n = 0;
const a = "applyTheme(prev === 'dark' || prev === 'light' ? prev : 'auto', true);";
const b = "if (persist && (m === 'auto' || m === 'dark' || m === 'light') && styled())";
if (h.includes(a)) { h = h.replace(a, "applyTheme(prev === 'dark' || prev === 'light' ? prev : 'auto', 'style');"); n++; }
if (h.includes(b)) { h = h.replace(b, "if (persist === true && (m === 'auto' || m === 'dark' || m === 'light') && styled())"); n++; }
if (n) { fs.writeFileSync(f, crlf ? h.replace(/\n/g, '\r\n') : h); console.log('Andon theme switch fixed (' + n + ' edits)'); }
