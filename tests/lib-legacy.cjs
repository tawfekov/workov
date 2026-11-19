'use strict';
// Loads the CURRENT policy() (prefix matching) straight from approvals.js, so tests compare the new engine with what runs today.
const fs = require('node:fs');
function loadLegacy(pluginPath) {
  const src = fs.readFileSync(pluginPath, 'utf8');
  const cut = (from, to) => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error('cannot find ' + from + ' in ' + pluginPath);
    return src.slice(a, b);
  };
  const code = cut('const ALLOW_ACTIONS', 'function mainRoot') + cut('function policy(', '// The command policy engine') + 'return policy;';
  const policy = new Function(code)();
  return (command) => policy('shell', [command]);
}
module.exports = { loadLegacy };
