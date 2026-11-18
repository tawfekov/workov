// Workov: scrolling in the Chat tab moved the whole dashboard page. The chat is a <webview>; when its own content hits the end of
// the scroll, the wheel event passes on to the page, which scrolled up and left only the bottom strip of the chat in view.
// On the Chat tab the page itself must not scroll: the chat fills the window below the header and scrolls on its own.
// Idempotent; applied to .claude/dashboard/index.html.
const fs = require('fs');
const f = '.claude/dashboard/index.html';
if (!fs.existsSync(f)) process.exit(0);
let h = fs.readFileSync(f, 'utf8');
const crlf = h.includes('\r\n');
h = h.replace(/\r\n/g, '\n');
if (h.includes('wv-chat-tab')) process.exit(0);
const a = "    onChat = tab === 'chat';\n";
if (!h.includes(a) || !h.includes('</head>')) { console.log('chat-noscroll: anchors not found, skipped'); process.exit(0); }
h = h.replace(a, () => a + "    document.documentElement.classList.toggle('wv-chat-tab', onChat); if (onChat) window.scrollTo(0, 0);\n");
h = h.replace('</head>', () => '<style id="wv-chat-noscroll">html.wv-chat-tab, html.wv-chat-tab body { overflow: hidden !important; height: 100%; }</style>\n</head>');
fs.writeFileSync(f, crlf ? h.replace(/\n/g, '\r\n') : h);
console.log('Chat tab no longer scrolls the page');
