// Workov: a designer or a review started by a button waits for a free agent slot instead of exceeding the limit.
// Pressing Design (or Review) started the process at once, even when every agent slot was taken, so more agents ran than
// concurrency.maxParallelWorkers allows. The stage engine (wv-stage.py) now queues it ("queued") when no slot is free and its tick starts
// it as soon as one is. This shows the state: "Waiting for a free agent slot…" on the card and drawer. Apply after stage-ui. Idempotent.
const fs = require('fs');
const H = '.claude/dashboard/index.html';
const raw = fs.readFileSync(H, 'utf8');
const crlf = raw.includes('\r\n');
let h = raw.replace(/\r\n/g, '\n');
if (!h.includes('Waiting for a free agent slot')) {
  const a = "        if (st.design === 'running') info.push(h('span', { class: 'note-s', text: 'The designer is working…' }));";
  if (!h.includes(a)) throw new Error('anchor missing');
  h = h.replace(a, () => a + "\n        if (st.design === 'queued' || st.review === 'queued') info.push(h('span', { class: 'note-s', text: 'Waiting for a free agent slot…' }));");
  fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
}
console.log('stage-queue: applied');
