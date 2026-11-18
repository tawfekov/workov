// Workov: a ticket of another project is addressed as "<PREFIX>-NNN" on the one dashboard. The prefix was the first three
// characters of the project's name, so two projects named alike ("Acme Web", "Acme API") shared one and an answer or a
// Dispatch could reach the wrong project; digits in a name also broke the id pattern (letters only). Now every registered
// project gets its own letters-only prefix (the server decides, the board reads it from /api/wv/projects). Idempotent.
const fs = require('fs');
let n = 0;
const S = '.claude/scripts/dashboard-server.py';
if (fs.existsSync(S)) {
  let s = fs.readFileSync(S, 'utf8');
  const crlf = s.includes('\r\n');
  s = s.replace(/\r\n/g, '\n');
  if (!s.includes('def wv_prefixes') && s.includes('def wv_project_by_prefix(prefix):')) {
    const fn = `def wv_prefixes():
    """One unique letters-only prefix (2-3 capitals) per registered project: the first three letters of its name, and on a
    clash the first two plus the next free letter of the name, then any letter. {normalised root: prefix}"""
    out, used = {}, set()
    for f in wv_fleets():
        letters = (re.sub(r"[^A-Za-z]", "", f["name"]).upper() + "XXX")
        cands = [letters[:3]] + [letters[:2] + c for c in letters[2:]] + [letters[:2] + chr(c) for c in range(65, 91)]
        pick = next((c for c in cands if c not in used), letters[:3])
        used.add(pick)
        out[wv_norm_root(f["root"])] = pick
    return out


`;
    s = s.replace('def wv_project_by_prefix(prefix):', () => fn + 'def wv_project_by_prefix(prefix):');
    const old = '        if re.sub(r"[^A-Za-z0-9]", "", f["name"])[:3].upper() == prefix:\n            return f\n';
    if (!s.includes(old)) throw new Error('anchor missing: prefix match');
    s = s.replace(old, () => '        if wv_prefixes().get(wv_norm_root(f["root"])) == prefix:\n            return f\n');
    const a = '            "self": wv_norm_root(root) == wv_norm_root(REPO_ROOT),\n';
    if (!s.includes(a)) throw new Error('anchor missing: projects self');
    s = s.replace(a, () => a + '            "prefix": wv_prefixes().get(wv_norm_root(root), "PRJ"),\n');
    fs.writeFileSync(S, crlf ? s.replace(/\n/g, '\r\n') : s);
    n++;
  }
}
const H = '.claude/dashboard/index.html';
if (fs.existsSync(H)) {
  let h = fs.readFileSync(H, 'utf8');
  const crlf = h.includes('\r\n');
  h = h.replace(/\r\n/g, '\n');
  if (!h.includes('wvPrefix')) {
    const oldPre = "function pre(name) { return String(name).replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'PRJ'; }";
    const oldNames = "names = (d.projects || []).map(function (p) { return p.name; });";
    if (h.includes(oldPre) && h.includes(oldNames)) {
      h = h.replace(oldPre, () => "var wvPrefix = {};\n    function pre(name) { return wvPrefix[name] || String(name).replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'PRJ'; }");
      h = h.replace(oldNames, () => "(d.projects || []).forEach(function (p) { if (p.prefix) wvPrefix[p.name] = p.prefix; });\n        " + oldNames);
      fs.writeFileSync(H, crlf ? h.replace(/\n/g, '\r\n') : h);
      n++;
    } else console.log('unique-prefix: board anchors not found, page skipped');
  }
}
if (n) console.log('unique project prefixes: ' + n + ' file(s) patched');
