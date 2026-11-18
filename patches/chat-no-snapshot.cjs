// Workov: in the desktop app the Chat tab is a native view that always draws above the page, so a popup (the navbar's three
// dots, the options panel, a drawer) could not cover it. The page worked around that by freezing the chat into a still picture
// while a popup was open, which looked wrong and could not be used. Now the chat keeps living: it is moved into the part of the
// page the popup does not cover (left of a popup that touches the right edge, else below it), and it is hidden only when no
// usable room is left (a full-window dialog). Idempotent; applied to .claude/dashboard/index.html.
const fs = require('fs');
const f = '.claude/dashboard/index.html';
if (!fs.existsSync(f)) process.exit(0);
let h = fs.readFileSync(f, 'utf8');
const crlf = h.includes('\r\n');
h = h.replace(/\r\n/g, '\n');
if (h.includes('wv-chat-room')) process.exit(0);
const a = h.indexOf("    if (covered) {\n      if (snapOn) return;");
const end = "    if (snapOn) { snapOn = false; snapClear(); }";
const b = a < 0 ? -1 : h.indexOf(end, a);
if (a < 0 || b < 0) { console.log('chat-no-snapshot: anchors not found, skipped'); process.exit(0); }
const neu = `    if (covered) {
      // wv-chat-room: keep the chat live in the part of the page the popup leaves free (no still picture)
      snapOn = false; snapClear();
      var rest = window.innerHeight - r.top, edge = over.right >= r.right - 24;
      var room = edge ? { x: r.left, y: r.top, w: over.left - r.left - 6, h: rest } : { x: r.left, y: over.bottom + 6, w: r.width, h: window.innerHeight - over.bottom - 6 };
      if (room.w < 320 || room.h < 220) { shell.chatHide(); return; }
      shell.chatShow({ x: room.x, y: room.y, width: room.w, height: room.h });
      return;
    }
`;
h = h.slice(0, a) + neu + h.slice(b);
fs.writeFileSync(f, crlf ? h.replace(/\n/g, '\r\n') : h);
console.log('chat stays live beside popups');
