// Workov: the Chat tab must never scroll the dashboard page. Locking the page's overflow was not enough (the page is still taller
// than the window on this tab, and focus or the webview can still move it). On the Chat tab the section is now a fixed layer: it fills
// exactly the window between the header and the bottom bar, is clipped, and holds the chat webview at 100% height. It is released
// when another tab opens. Idempotent; applied to .claude/dashboard/index.html (after chat-webview.cjs).
const fs = require('fs');
const f = '.claude/dashboard/index.html';
if (!fs.existsSync(f)) process.exit(0);
let h = fs.readFileSync(f, 'utf8');
const crlf = h.includes('\r\n');
h = h.replace(/\r\n/g, '\n');
if (h.includes('wv-chat-fixed')) process.exit(0);
const a = h.indexOf('  var wvChat = null; // wv-chat-webview');
const b = a < 0 ? -1 : h.indexOf('  window.wvNavSync = function (tab) {', a);
if (a < 0 || b < 0) { console.log('chat-fixed: anchors not found, skipped'); process.exit(0); }
const neu = `  var wvChat = null; // wv-chat-webview
  var wvFixedTop = null; // wv-chat-fixed
  function chatUnfix() {
    var sec = document.getElementById('tab-chat'), host = document.getElementById('chat-host');
    if (sec) { sec.style.position = sec.style.left = sec.style.right = sec.style.top = sec.style.bottom = sec.style.overflow = ''; }
    if (host) { host.style.height = host.style.minHeight = ''; }
    wvFixedTop = null;
  }
  function chatPlace() {
    if (!shell || !onChat) return;
    var sec = document.getElementById('tab-chat'), host = document.getElementById('chat-host'), main = document.querySelector('main');
    if (!sec || !host) return;
    if (!wvChat) {
      wvChat = document.createElement('webview'); wvChat.id = 'chat-webview'; wvChat.setAttribute('src', 'about:blank'); // the app decides what it loads
      wvChat.style.cssText = 'display:flex;width:100%;height:100%;border:0;background:var(--bg)';
      host.appendChild(wvChat);
    }
    window.scrollTo(0, 0);
    var top = main ? Math.round(main.getBoundingClientRect().top) : (wvFixedTop || 0);
    var bar = getComputedStyle(nav).position === 'fixed' ? nav.offsetHeight : 0;
    wvFixedTop = top;
    sec.style.position = 'fixed'; sec.style.left = '0'; sec.style.right = '0'; sec.style.top = top + 'px'; sec.style.bottom = bar + 'px'; sec.style.overflow = 'hidden';
    host.style.minHeight = '0'; host.style.height = '100%';
  }
`;
h = h.slice(0, a) + neu + h.slice(b);
// leaving the Chat tab releases the layer
const leave = "    else { snapOn = false; snapClear(); shell.chatHide(); }";
if (h.includes(leave)) h = h.replace(leave, () => "    else { snapOn = false; snapClear(); shell.chatHide(); chatUnfix(); }");
fs.writeFileSync(f, crlf ? h.replace(/\n/g, '\r\n') : h);
console.log('Chat tab is a fixed layer');
