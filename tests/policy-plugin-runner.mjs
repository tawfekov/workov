// Used by the plugin tests: loads the approvals plugin with a fake OpenCode context, feeds it shell
// permission events and prints the outcome for each one as JSON.
//   node policy-plugin-runner.mjs <plugin.mjs> <commands-json>
// With PEEK=1 a request that is waiting for the owner is reported as state "waiting" after 2.5 s instead of blocking for 15 minutes.
import { pathToFileURL } from 'node:url';
const [, , pluginFile, commandsJson] = process.argv;
const peek = process.env.PEEK === '1';
const mod = await import(pathToFileURL(pluginFile).href);
let handler = null;
await mod.default.setup({ permission: { hook: async (_name, fn) => { handler = fn; } } });
if (!handler) { console.log(JSON.stringify({ inactive: true })); process.exit(0); }
const out = [];
for (const command of JSON.parse(commandsJson)) {
  const event = { action: process.env.EVENT_ACTION || 'shell', agent: 'worker', resources: [command] };
  const p = handler(event);
  if (peek) {
    const state = await Promise.race([p.then(() => 'done'), new Promise((r) => setTimeout(() => r('waiting'), 2500))]);
    out.push({ command, effect: event.effect || null, state });
  } else {
    await p;
    out.push({ command, effect: event.effect });
  }
}
console.log(JSON.stringify(out));
if (peek) process.exit(0);
