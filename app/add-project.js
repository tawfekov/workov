'use strict';
// Adds a project from the app: asks for the repository, runs the bundled kit's install.sh (which ALWAYS clones it into a fleet
// home under ~/Workov/fleets and registers it in fleets.json) and reports the result. The repository itself is never modified.
// A project is never the hub: the dashboard and router live in the neutral hub (~/Workov/hub, install.sh --hub).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// where the kit (install.sh, patches, overlay, the Workov base) lives: inside the installed app, or the repo in development
function kitDir(app) { return app.isPackaged ? path.join(process.resourcesPath, 'kit') : path.resolve(__dirname, '..'); }

const slash = (p) => p.replace(/\\/g, '/');

function registered(name) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workov', 'fleets.json'), 'utf8'));
    return (Array.isArray(list) ? list : []).find((f) => f && f.name === name) || null;
  } catch { return null; }
}

// Runs the installer for one repository. Resolves { ok, root, log } where root is the new fleet home.
function install({ app, bash, repo, name, logFile }) {
  return new Promise((resolve) => {
    const kit = kitDir(app);
    const script = path.join(kit, 'install.sh');
    if (!fs.existsSync(script)) return resolve({ ok: false, error: 'The fleet kit is missing from this installation (' + script + ').', log: logFile });
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, 'w');
    const child = spawn(bash, [slash(script), slash(repo)], { env: { ...process.env, WV_PROJECT_NAME: name, WV_ALWAYS_CLONE: '1' }, stdio: ['ignore', out, out], windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 15 * 60 * 1000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e), log: logFile }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { fs.closeSync(out); } catch { /* closed */ }
      const f = registered(name);
      resolve(code === 0 && f ? { ok: true, root: f.root, log: logFile } : { ok: false, error: 'The installer stopped with code ' + code + '.', log: logFile });
    });
  });
}

// Creates the NEUTRAL hub (dashboard, router loop, shared config, auth token; no tickets, not a project) with `install.sh --hub <dir>`.
function installHub({ app, bash, dir, logFile }) {
  return new Promise((resolve) => {
    const script = path.join(kitDir(app), 'install.sh');
    if (!fs.existsSync(script)) return resolve({ ok: false, error: 'The fleet kit is missing from this installation (' + script + ').', log: logFile });
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, 'a');
    const child = spawn(bash, [slash(script), '--hub', slash(dir)], { env: { ...process.env }, stdio: ['ignore', out, out], windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 15 * 60 * 1000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e), log: logFile }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { fs.closeSync(out); } catch { /* closed */ }
      resolve(code === 0 && fs.existsSync(path.join(dir, 'specs', 'workov.config.json')) ? { ok: true, root: dir, log: logFile } : { ok: false, error: 'The hub installer stopped with code ' + code + '.', log: logFile });
    });
  });
}

function isGitRepo(dir) { return fs.existsSync(path.join(dir, '.git')); }

module.exports = { install, installHub, kitDir, isGitRepo, registered };
