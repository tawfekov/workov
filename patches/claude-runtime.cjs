// Workov: "Claude (your plan)" as a selectable PROVIDER for every agent role (Providers > Agents), with a manual model choice, and a
// master switch that runs the whole fleet on Claude and back. Server (dashboard-server.py):
//   - wv_set_claude / wv_claude_fleet / wv_role_runtime: a role set to Claude gets models.<role>.runtime = "claude" and
//     models.<role>.claude.model; the .claude/agents/<role>.md `model:` line follows (mirrored to every project like the other models)
//   - wv_set_model (any other provider) sets runtime = "opencode"
//   - /api/wv/providers returns each role's runtime, the Claude models, the sign-in hint and the master-switch state
//   - action wv_claude_fleet {on, model}: every role on Claude; off restores the saved previous setup (job/claude-fleet-backup.json,
//     separate from the free-preset backup)
// index.html (Agents table): provider `claude`, its models, Apply/Test for it, a hint on sub-agent rows, the master switch and a banner
// while the whole fleet is on Claude; the Review menu marks Claude as suggested when the reviewer role runs on Claude.
// Whitespace tolerant anchors; a missing anchor is reported and skipped. Idempotent. Run from the fleet folder, after models-list.
const fs = require('fs');
const path = require('path');
const S = '.claude/scripts/dashboard-server.py';
const I = '.claude/dashboard/index.html';
const MARK = 'wv-claude-runtime';
const frag = (n) => fs.readFileSync(path.join(__dirname, n), 'utf8').replace(/\r\n/g, '\n');

function load(file) {
  let s = fs.readFileSync(file, 'utf8');
  const crlf = s.includes('\r\n');
  return { s: s.replace(/\r\n/g, '\n'), crlf };
}
function save(file, o, s) {
  fs.writeFileSync(file, o.crlf ? s.replace(/\n/g, '\r\n') : s);
}
const lit = (t) => new RegExp(t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'));
function rep(s, re, to, what, miss) {
  if (!re.test(s)) { miss.push(what); return s; }
  return s.replace(re, () => to);
}

function patchServer() {
  if (!fs.existsSync(S)) { console.log('claude-runtime: no server, skipped'); return; }
  const o = load(S);
  let s = o.s;
  if (s.includes(MARK)) { console.log('claude-runtime: server already applied'); return; }
  const miss = [];
  // 1. the hub mirror also carries the .claude/agents model lines into every project
  s = rep(s, /rel\.startswith\("\.opencode\/agents\/"\) and rel\.endswith\("\.md"\)/, 'rel.startswith((".opencode/agents/", ".claude/agents/")) and rel.endswith(".md")', 'hub sync of .claude/agents', miss);
  // 2. any other provider means the OpenCode runtime
  s = rep(s, lit('entry.setdefault("opencode", {})["model"] = model\n        wv_atomic_write(path, json.dumps(cfg, indent=2, ensure_ascii=False) + "\\n")\n        changed.append("specs/worker-fleet.config.json")'),
    'entry.setdefault("opencode", {})["model"] = model\n        entry["runtime"] = "opencode"  # wv-claude-runtime\n        wv_atomic_write(path, json.dumps(cfg, indent=2, ensure_ascii=False) + "\\n")\n        changed.append("specs/worker-fleet.config.json")', 'wv_set_model runtime', miss);
  // 3. the new functions, before wv_set_model
  s = rep(s, /def wv_set_model\(role, model, reload=True\):/, frag('claude-runtime.server.py.txt') + 'def wv_set_model(role, model, reload=True):', 'def wv_set_model', miss);
  // 4. /api/wv/providers
  s = rep(s, lit('"backup": (_WV_BASE_ROOT / "job" / "models-backup.json").exists()}'), '"backup": (_WV_BASE_ROOT / "job" / "models-backup.json").exists(), **wv_claude_extra(cfg, roles)}', 'wv_providers return', miss);
  // 5. the actions
  s = rep(s, lit('if action == "wv_set_model":\n        return wv_set_model(req.get("role"), req.get("model"))'),
    'if action == "wv_set_model":\n        if str(req.get("runtime", "")) == "claude":\n            return wv_set_claude(req.get("role"), req.get("model"))\n        return wv_set_model(req.get("role"), req.get("model"))\n    if action == "wv_claude_fleet":\n        return wv_claude_fleet(bool(req.get("on")), str(req.get("model") or "sonnet"))', 'action routing', miss);
  s = rep(s, /"wv_set_model", "wv_set_implementer", "wv_pause_all"/, '"wv_set_model", "wv_claude_fleet", "wv_set_implementer", "wv_pause_all"', 'WV_ACTIONS', miss);
  s = rep(s, /WV_CLEARS_ISSUE = \("wv_router_restart", "wv_set_model",/, 'WV_CLEARS_ISSUE = ("wv_router_restart", "wv_set_model", "wv_claude_fleet",', 'WV_CLEARS_ISSUE', miss);
  // 6. the Claude test accepts the full model ids
  s = rep(s, lit('if model not in ("sonnet", "opus", "haiku"):\n        return 400, {"error": "Choose sonnet, opus or haiku."}'),
    'if not WV_CLAUDE_ID_RE.fullmatch(str(model)):\n        return 400, {"error": "Choose sonnet, opus, haiku or a Claude model id."}', 'wv_test_claude', miss);
  if (miss.length) { console.log('claude-runtime: anchors not found, skipped: ' + miss.join('; ')); return; }
  save(S, o, s);
  console.log('claude-runtime: server patched');
}

function patchUi() {
  if (!fs.existsSync(I)) { console.log('claude-runtime: no dashboard page, skipped'); return; }
  const o = load(I);
  let s = o.s;
  if (s.includes(MARK)) { console.log('claude-runtime: page already applied'); return; }
  const a = s.indexOf('Agents tab: pick the provider, then the model, of every agent');
  const b = s.indexOf('window.wvAgentsLoad = load;');
  if (a < 0 || b < a) { console.log('claude-runtime: anchors not found, skipped: Agents tab script'); return; }
  let seg = s.slice(a, b);
  const miss = [];
  // provider list: claude first, always available
  seg = rep(seg, lit('var usable = connected.filter(function (p) {\n return byProv[p];\n });'),
    "var usable = connected.filter(function (p) {\n            return byProv[p];\n          });\n          /* " + MARK + " */\n          var clList = d.claudeModels || ['sonnet', 'opus', 'haiku'],\n            clInfo = d.claudeInfo || {};\n          usable = ['claude'].concat(usable);", 'usable', miss);
  seg = rep(seg, lit("var p = provOf(r.model);\n cnt[p] = (cnt[p] || 0) + 1;"), "var p = r.runtime === 'claude' ? 'claude' : provOf(r.model);\n              cnt[p] = (cnt[p] || 0) + 1;", 'mix counts', miss);
  seg = rep(seg, lit('body.append(intro);'), 'body.append(intro);\n' + frag('claude-runtime.ui.js.txt'), 'intro', miss);
  seg = rep(seg, lit("if (ROLE[r.role]) nm.append(el('small', '', ROLE[r.role][1]));"),
    "if (ROLE[r.role]) nm.append(el('small', '', ROLE[r.role][1]));\n            if (['tester', 'merger', 'checker', 'watchdog', 'reproducer', 'teammate'].indexOf(r.role) >= 0)\n              nm.append(el('small', 'pvp-sub-hint', 'runs on Claude when its parent (worker/router) runs on Claude'));", 'role hint', miss);
  seg = rep(seg, lit('var cur = r.model,\n curProv = provOf(cur);'),
    "var isCl = r.runtime === 'claude';\n            var cur = isCl ? r.claude : r.model,\n              curProv = isCl ? 'claude' : provOf(cur);", 'current provider', miss);
  seg = rep(seg, lit("var o = el('option', '', p + (connected.indexOf(p) < 0 ? '  (not connected)' : ''));"),
    "var o = el(\n                'option',\n                '',\n                p === 'claude' ? 'claude (your plan)' : p + (connected.indexOf(p) < 0 ? '  (not connected)' : ''),\n              );", 'provider option', miss);
  seg = rep(seg, lit("ms.textContent = '';\n var list = (byProv[ps.value] || []).slice();"),
    "ms.textContent = '';\n              if (ps.value === 'claude') {\n                var cl = clList.slice();\n                if (curProv === 'claude' && cl.indexOf(cur) < 0) cl.unshift(cur);\n                cl.forEach(function (m) {\n                  var oc = el('option', '', m);\n                  oc.value = m;\n                  ms.append(oc);\n                });\n                ms.value = curProv === 'claude' && cl.indexOf(cur) >= 0 ? cur : cl[0];\n                return;\n              }\n              var list = (byProv[ps.value] || []).slice();", 'model list', miss);
  seg = rep(seg, lit("var x = await wvPost({ action: 'wv_set_model', role: r.role, model: ms.value });"),
    "var x = await wvPost(\n                ps.value === 'claude'\n                  ? { action: 'wv_set_model', role: r.role, model: ms.value, runtime: 'claude' }\n                  : { action: 'wv_set_model', role: r.role, model: ms.value },\n              );", 'apply', miss);
  seg = rep(seg, lit('cur = ms.value;\n curProv = ps.value;\n }'), 'cur = ms.value;\n                curProv = ps.value;\n                load();\n              }', 'reload after apply', miss);
  seg = rep(seg, lit("var x = await wvPost({ action: 'wv_test_model', model: ms.value });"),
    "var x = await wvPost(\n                ps.value === 'claude'\n                  ? { action: 'wv_test_claude', model: ms.value }\n                  : { action: 'wv_test_model', model: ms.value },\n              );", 'test', miss);
  let t = s.slice(0, a) + seg + s.slice(b);
  t = rep(t, lit("cl.enabled ? 'Review with Claude' :"), "cl.enabled ? 'Review with Claude' + (cl.suggested ? '  (suggested)' : '') :", 'review menu', miss);
  if (miss.length) { console.log('claude-runtime: anchors not found, skipped: ' + miss.join('; ')); return; }
  save(I, o, t);
  console.log('claude-runtime: page patched');
}

patchServer();
patchUi();
