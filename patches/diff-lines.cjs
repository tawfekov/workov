// Workov: edit diffs in the ticket logs and the router steps showed always "-1 +1" and a one-line code view. Cause: wv_step_list ran every
// tool input string through _wv_clip, which joins all whitespace (newlines included) into single spaces, so an Edit's old and new text
// became one line each. Tool inputs and outputs, reasoning and text now keep their newlines (truncated, not flattened). The step
// carries the true line counts too (old_lines / new_lines), because long text is cut. In the page an empty side counts 0 lines (a new
// file is "+N", never "-1") and draws no blank row. Idempotent; run from the fleet folder.
const fs = require('fs');
let n = 0;
const S = '.claude/scripts/dashboard-server.py';
if (fs.existsSync(S)) {
  let s = fs.readFileSync(S, 'utf8');
  const crlf = s.includes('\r\n');
  s = s.replace(/\r\n/g, '\n');
  if (!s.includes('def _wv_keep')) {
    const a = s.indexOf('def wv_step_list(m, typ):');
    if (a < 0) { console.log('diff-lines: server anchors not found, skipped'); }
    else {
      const b = s.indexOf('\n\n\n', a) > 0 ? s.indexOf('\n\n\n', a) : s.length;
      let f = s.slice(a, b);
      const keep = [
        'def _wv_keep(text, n):',
        '    """truncate to n characters but keep the line breaks (a diff and a command are read line by line)"""',
        '    text = str(text).replace("\\r\\n", "\\n")',
        '    return text if len(text) <= n else text[: n - 1] + "…"',
        '',
        '',
        '',
      ].join('\n');
      const rep = (o, nw) => { if (f !== null && f.includes(o)) f = f.replace(o, () => nw); else f = null; };
      rep('"text": _wv_clip(m.get("text", ""), 4000)', '"text": _wv_keep(m.get("text", ""), 4000)');
      rep('"text": _wv_clip(m.get("text", ""), 1500)', '"text": _wv_keep(m.get("text", ""), 1500)');
      rep('"text": _wv_clip(it["text"], 3000)', '"text": _wv_keep(it["text"], 3000)');
      rep('"text": _wv_clip(it["text"], 6000)', '"text": _wv_keep(it["text"], 6000)');
      rep('(_wv_clip(v, 6000) if isinstance(v, str) else v)', '(_wv_keep(v, 20000) if isinstance(v, str) else v)');
      rep('"out": _wv_clip(txt, 3000)', '"out": _wv_keep(txt, 6000)');
      // the true line counts of an edit, before any truncation
      rep('                res = st.get("content") or []\n                txt =',
        '                if name == "Edit" and isinstance(raw, dict):\n                    inp["old_lines"] = len(str(raw.get("oldString", raw.get("old_string", ""))).splitlines())\n                    inp["new_lines"] = len(str(raw.get("newString", raw.get("new_string", ""))).splitlines())\n                res = st.get("content") or []\n                txt =');
      if (f === null) { console.log('diff-lines: server anchors not found, skipped'); }
      else { s = s.slice(0, a) + keep + f + s.slice(b); fs.writeFileSync(S, crlf ? s.replace(/\n/g, '\r\n') : s); n++; console.log('diff-lines: server patched'); }
    }
  }
}
const H = '.claude/dashboard/index.html';
if (fs.existsSync(H)) {
  let h = fs.readFileSync(H, 'utf8');
  const crlf = h.includes('\r\n');
  h = h.replace(/\r\n/g, '\n');
  if (!h.includes('wv-difflines')) {
    const oldCount = "sx.append(mk('span', 'plus', '+' + String(i.new_string || '').split('\\n').length), mk('span', 'minus', '−' + String(i.old_string || '').split('\\n').length));";
    const newCount = "sx.append(mk('span', 'plus', '+' + (i.new_lines != null ? i.new_lines : nlines(i.new_string))), mk('span', 'minus', '−' + (i.old_lines != null ? i.old_lines : nlines(i.old_string))));";
    const oldDiff = "    String(from || '').split('\\n').forEach(function (x) { add('d', '−', x); });\n    String(to || '').split('\\n').forEach(function (x) { add('a', '+', x); });";
    const newDiff = "    if (from) String(from).split('\\n').forEach(function (x) { add('d', '−', x); });\n    if (to) String(to).split('\\n').forEach(function (x) { add('a', '+', x); });";
    const oldFn = '  function diff(from, to, host) {';
    if (h.includes(oldCount) && h.includes(oldDiff) && h.includes(oldFn)) {
      h = h.replace(oldCount, () => newCount).replace(oldDiff, () => newDiff).replace(oldFn, () => "  function nlines(s) { s = String(s == null ? '' : s); return s ? s.split('\\n').length : 0; } // wv-difflines: an empty side is 0 lines, not 1\n" + oldFn);
      fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h); n++; console.log('diff-lines: page patched');
    } else console.log('diff-lines: page anchors not found, skipped');
  }
}
if (!n) console.log('diff-lines: nothing to change');
