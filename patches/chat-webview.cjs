// Workov: the desktop app's Chat tab is a <webview> inside the page (a real part of it), not a native view laid over it. A native
// view always draws above the page, so every popup had to fight it (it was frozen into a picture, then squeezed beside the popup).
// The webview is created by the page, but main.js decides what it loads (the app's own chat page, its own preload, sandboxed).
// This replaces the page's chatPlace() (native view bounds + snapshots) with "create the webview once and size it". Needs the app
// from version 0.6.1 (webviewTag). Idempotent; applied to .claude/dashboard/index.html.
const fs = require('fs');
const f = '.claude/dashboard/index.html';
if (!fs.existsSync(f)) process.exit(0);
let h = fs.readFileSync(f, 'utf8');
const crlf = h.includes('\r\n');
h = h.replace(/\r\n/g, '\n');
if (h.includes('wv-chat-webview')) process.exit(0);
const a = h.indexOf('  function chatPlace() {');
const b = a < 0 ? -1 : h.indexOf('  window.wvNavSync = function (tab) {', a);
if (a < 0 || b < 0) { console.log('chat-webview: anchors not found, skipped'); process.exit(0); }
const neu = `  var wvChat = null; // wv-chat-webview
  function chatPlace() {
    if (!shell || !onChat) return;
    var host = document.getElementById('chat-host'); if (!host) return;
    if (!wvChat) {
      wvChat = document.createElement('webview'); wvChat.id = 'chat-webview'; wvChat.setAttribute('src', 'about:blank'); // the app decides what it loads
      wvChat.style.cssText = 'display:flex;width:100%;border:0;background:var(--bg)';
      host.appendChild(wvChat);
    }
    var bar = getComputedStyle(nav).position === 'fixed' ? nav.offsetHeight : 0;
    wvChat.style.height = Math.max(300, window.innerHeight - host.getBoundingClientRect().top - bar) + 'px';
  }
`;
h = h.slice(0, a) + neu + h.slice(b);
// the overlay watcher that kept moving the native view is no longer needed: the webview is ordinary page content
h = h.replace(/  \/\/ a dashboard dialog, drawer or dropdown opening over the chat must never sit under it\n  if \(shell && window\.MutationObserver\) new MutationObserver\(function \(\) \{\n    if \(onChat\) \{ chatPlace\(\); \[120, 350, 700\]\.forEach\(function \(ms\) \{ setTimeout\(chatPlace, ms\); \}\); \}\n  \}\)\.observe\(document\.body, \{ subtree: true, attributes: true, attributeFilter: \['hidden', 'open', 'class'\] \}\);\n/, '');
fs.writeFileSync(f, crlf ? h.replace(/\n/g, '\r\n') : h);
console.log('Chat tab is a webview in the page');
