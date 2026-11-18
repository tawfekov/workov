// Workov: "Open the mockup in a new tab" did nothing inside the desktop app: the app's window-open handler denies every new
// window that is not an https:// link (those go to the system browser), and the mockup link is the dashboard's own http://127.0.0.1
// address. The page now handles the click itself when it runs inside the app: the mockup opens in a full-window overlay with a Close
// button (same sandboxed frame as the drawer), so it works in the installed app without rebuilding it. In a normal browser the
// link still opens a real tab. Idempotent; applied to .claude/dashboard/index.html.
const fs = require('fs');
const f = '.claude/dashboard/index.html';
if (!fs.existsSync(f)) process.exit(0);
let h = fs.readFileSync(f, 'utf8');
const crlf = h.includes('\r\n');
h = h.replace(/\r\n/g, '\n');
if (h.includes('wv-mockup-open-js') || !h.includes('</body>')) process.exit(0);
const js = `<script id="wv-mockup-open-js">
(function () {
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('#d-mockup-open') : null;
    if (!a || !/Workov|Electron/.test(navigator.userAgent)) return;
    e.preventDefault();
    var ov = document.getElementById('wv-mockup-overlay');
    if (!ov) {
      ov = document.createElement('div'); ov.id = 'wv-mockup-overlay';
      ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.82);display:flex;flex-direction:column';
      var bar = document.createElement('div');
      bar.style.cssText = 'padding:8px 12px;display:flex;gap:8px;justify-content:flex-end;background:#111';
      var cb = document.createElement('button'); cb.type = 'button'; cb.className = 'btn'; cb.textContent = 'Close mockup';
      cb.onclick = function () { ov.remove(); };
      bar.appendChild(cb);
      var fr = document.createElement('iframe'); fr.title = 'Ticket mockup'; fr.setAttribute('sandbox', 'allow-scripts');
      fr.style.cssText = 'flex:1;border:0;background:#fff;width:100%';
      ov.appendChild(bar); ov.appendChild(fr); document.body.appendChild(ov);
      document.addEventListener('keydown', function (k) { if (k.key === 'Escape' && document.getElementById('wv-mockup-overlay')) ov.remove(); });
    }
    ov.querySelector('iframe').src = a.getAttribute('href') + '?t=' + Date.now();
  });
})();
</script>
`;
h = h.replace('</body>', () => js + '</body>');
fs.writeFileSync(f, crlf ? h.replace(/\n/g, '\r\n') : h);
console.log('mockup opens in an overlay inside the app');
