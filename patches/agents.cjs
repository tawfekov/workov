const fs=require('fs');
const MERGER_BLOCK=`
## Workov landing (overrides the gh steps below)

In PR mode, skip the \`gh\` precondition (step 1's first bullet) and steps 3 and 4: landing goes through \`land.cjs\`, which uses \`gh\` (GitHub) or the GitLab API for the origin host. After step 2 (build verified on the ticket branch), run exactly:

\`node .claude/scripts/land.cjs land NNN <branch>\`

It pushes the branch (never force) and opens or updates the PR / MR as a **draft** from the ticket's delivery pack (screenshots, \`delivery/mr-title.txt\`, \`delivery/mr.md\`). No tracker is touched: the owner's final review marks it ready and runs the optional tracker hook (\`land.cjs deliver\`). The \`prUrl\` is the URL on its \`MR_URL\` line.
`;
const WORKER_BLOCK=`
# Workov rules (override anything below that disagrees)
- Read the repository's \`CLAUDE.md\` (the constitution) before coding; it wins over this file.
- Commits: one per feature or fix, one-line conventional subject in the repo's style (\`feat(<scope>): …\`, \`fix(<scope>): …\`), no body, no \`Co-Authored-By\`, no AI attribution. Stage files by explicit path. Never push.
- Before the tester's final run, apply the ticket's \`## Final review\` (code review, security review, simplify — procedures in \`rd.md\`), fix what they find and re-run the checks.
- Delivery pack, last, in \`specs/tickets/NNN-slug/delivery/\` (never committed: it is in \`.git/info/exclude\`): \`screens/NN-<name>.png\` (the screenshots listed in \`rd.md\` \`## Screenshots\`, copied or taken against your dev server, checked by eye; every change a user can see has screenshots, even a single button), \`mr.md\` (exactly these sections in this order: \`## Summary\` (one bullet per feature or fix) / \`## Implementation\` (how it was built, short, no file list) / \`## Screenshots\` (only when there are any; bold caption, then \`![caption](screens/NN-<name>.png)\`) / \`## Notes\` (deviations, backend gaps, follow-ups, checks run with results); short, no AI attribution), \`mr-title.txt\` (one line, matching the main commit), \`tracker.md\` (3–6 lines for the optional tracker hook, no link).
- Browser checks that need a sign-in use the test account from the environment variables \`E2E_EMAIL\` / \`E2E_PASSWORD\` when the project defines them (never print them, never write them to a file; pass this rule to the tester in its prompt). Never write real users' records in a check: read what you need and hold or abort the writes. A check that cannot run is never skipped silently: ask.
`;
const LF = (s) => s.split('\r\n').join('\n');
for (const dir of ['.claude', '.opencode']) {
  const r = `${dir}/agents/router.md`;
  let t = LF(fs.readFileSync(r, 'utf8'));
  t = t.split('`gh pr view <number-or-branch> --json state`').join('`node .claude/scripts/land.cjs status <branch>` (prints `opened`, `merged`, `closed` or `none`)');
  fs.writeFileSync(r, t);
  const m = `${dir}/agents/merger.md`;
  t = LF(fs.readFileSync(m, 'utf8'));
  if (!t.includes('## Workov landing')) {
    if (!t.includes('# PR Landing Mode (ticket 022)\n')) throw new Error(`${m}: PR Landing Mode heading not found`);
    t = t.replace('# PR Landing Mode (ticket 022)\n', '# PR Landing Mode (ticket 022)\n' + MERGER_BLOCK);
  }
  fs.writeFileSync(m, t);
  const w = `${dir}/agents/worker.md`;
  t = LF(fs.readFileSync(w, 'utf8'));
  if (!t.includes('# Workov rules')) t = t.replace('# Inputs Provided by Router', WORKER_BLOCK.trim() + '\n\n# Inputs Provided by Router');
  t = t.split('(`feat(NNN): <title>`)').join('(one-line conventional subject per the Workov rules above)');
  fs.writeFileSync(w, t);
}
console.log('agents patched');
