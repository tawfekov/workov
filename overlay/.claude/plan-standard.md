# Plan standard

The plan holds the **decisions** a weaker model can't make well, plus pointers. Anything mechanical that the repo's
lint, tests, build or existing patterns already settle is left to the implementer. **Length: about 300 lines**
(excluding the appendix); if a task needs more, split it into phases or into separate tasks.

**In the plan:**
- decisions with one line of reason; rejected options only in Decisions;
- the API contract, checked against the backend source or Swagger: method, path, the request and response fields
  used, the error statuses and what the user sees for each;
- backend gaps, each with its impact, the workaround and a backend task id;
- every state of each screen (loading, empty, error, permission, success, read-only…) and what's shown;
- every user-facing text in every language the app supports, with its key;
- the Files table: path, new/changed/moved, one-line purpose;
- the tests by name ("it …") with the setup and assertion in one line each;
- for each step, an existing file whose shape to copy.

**Not in the plan:** markup, CSS classes, test data values, private signatures, line estimates, restating repo rules
the lint already enforces. Quote a repo rule only when lint can't catch it.

**Sections:**
1. Header: ticket id and title, branch, date, mockup approval line.
2. Goal and the acceptance criteria verbatim, numbered.
3. What exists: paths to reuse, dependencies and their state, overlapping open MRs.
4. Before you start: setup, the exact lint/test/format/build/e2e commands, tool quirks, env var names (never values).
5. API contract, then Backend gaps.
6. Decisions.
7. Design: states table, texts table, interactions and accessibility notes the mockup doesn't make obvious.
8. Files table.
9. Phases and steps. Each step: the files; the model file to copy; the tests to write first (names); the check
   command and its expected result. A step depends only on earlier steps. A task with more than about 12 files or more
   than one screen gets phases (e.g. data and service → screens → e2e), each ending with all checks green.
10. Verify: the commands in order and a short manual walk-through (languages, themes, phone width).
11. Final review: run `/code-review`, `/security-review`, `/simplify` on `git diff origin/<default>...HEAD`, or the
    appendix procedures when the agent has no such commands; fix and re-run Verify; log findings in Deviations.
12. Delivery pack: commit style, what the implementer must NOT do (push, issue trackers, the remote: those are the owner's unless said otherwise), and the **delivery pack** it must leave ready (see "Delivery pack" below), with the named list of screenshots
    to take (screen, state, language, theme, desktop or 390 px phone) and how to reach each state on the real app.
    **Any change a user can see gets screenshots, however small** (one button, a colour, a text): at least the
    changed element in each state it has (e.g. normal and busy), in the context of its screen.
13. Definition of done: one checkbox per acceptance criterion, plus all checks green and the reviews run.
14. Out of scope, then Deviations (empty; the implementer appends).
15. Appendix: the **Review procedures** block below, verbatim.

**Review procedures** (copy verbatim into every plan's appendix)

> ### A. Code review: correctness bugs
> Scope: `git diff origin/<default>...HEAD` plus uncommitted changes. Read each changed file in full and the callers
> of changed functions. Look for real defects only: wrong logic, null/undefined paths, unhandled errors, race
> conditions and stale state, missing loading/empty/error states, wrong API usage against the plan's contract, broken
> or missing translations, accessibility breaks, repo-rule violations, missing tests, behaviour that contradicts the
> plan or the mockup. Prove each one with the inputs that trigger it; drop what you can't make concrete. Fix each
> confirmed finding with a test that would have caught it.
>
> ### B. Security review
> Same scope. Unsafe HTML or sanitizer bypass; tokens sent only to the configured API host; nothing sensitive left in
> storage or memory after sign-out; no auth weakened outside development; UI never relies on hiding alone; ids from
> URLs or storage not trusted; no tokens or personal data in logs, URLs or errors; storage values validated before
> use; no secrets committed; no new package without approval; no open redirects. Report only exploitable or clearly
> exposed issues, and fix them.
>
> ### C. Simplify
> Same scope. Reuse existing helpers instead of re-implementing; remove redundant state, copy-paste, dead code; avoid
> repeated work and sequential independent calls; fix root causes rather than adding special cases. Skip a change that
> would alter behaviour or reach far outside the diff, and note the skip.
>
> After A, B and C: re-run format, lint, all tests and the build; all must pass.

**Delivery pack** (the implementer prepares it so delivery takes seconds). Folder `.delivery/<task id>/` at the repo
root, kept out of git by adding `.delivery/` to `.git/info/exclude` (local only, never committed):
- `screens/NN-<name>.png`: every screenshot in the plan's list, taken against the real running app (the repo's dev
  server and environment), checked by eye: no errors, no sideways scroll at 390 px, texts in the right language.
  Required for **every** change a user can see, even a single button; only a change with nothing visible (API,
  tests, tooling) has none.
- `mr.md`: the PR / MR description, in the format below.
- **PR / MR description** (every PR / MR the fleet opens or updates overrides any repo template):
  exactly these sections, in this order, nothing before or after them:
  - `## Summary`: what changed for the user, one bullet per feature or fix.
  - `## Implementation`: how it was built, short: the main pieces (services, components, routes, API calls) and the
    decisions; no file-by-file list.
  - `## Screenshots`: only when there are screenshots; each as a bold caption line, then
    `![<caption>](screens/NN-<name>.png)`. Every screenshot taken is in it, uploaded to the host at delivery.
  - `## Notes`: deviations, backend gaps, overlaps with other MRs, follow-ups, and the checks run with their results.
  Size caps (the description is for the reviewer: only what they need to know, easy and clear): `## Summary` at most 3
  one-line bullets; `## Implementation` at most 5 one-line bullets (main pieces and non-obvious decisions, no file
  lists, no re-listing of tests); `## Notes` at most 4 bullets and only what matters (deviations, backend gaps, overlaps,
  follow-ups, anything the reviewer must check; the checks run only if one failed or was skipped); each line at most 160
  characters; at most 30 lines in total without screenshots. `land.cjs` refuses to deliver a description that breaks
  these caps.
  Short, no AI attribution.
- `mr-title.txt`: one line, conventional style, matching the main commit.
- `tracker.md`: the comment for the optional tracker hook (3–6 lines: what was done, checks, follow-ups), without the PR / MR
  link (added at delivery).

**Plan check (one pass):** a fresh Sonnet agent gets only the plan, the mockup and the repo path and reports, in 20
lines or fewer, the blockers: questions an implementer would have to ask about a **decision**, wrong API or code
claims, missing states or texts, contradictions. Not lint-level details. You fix the blockers yourself in the main
session, or with a fresh Planner given a short list. No second round unless a fix changed a decision.

## Extra lines of a fleet ticket

`rd.md` holds the Plan standard's content plus `**Status:** draft`, `**Tracker:** <id>` (or `none`), `## Screenshots` (the
named list), `## Final review` (the Review procedures block, verbatim) and `## Landing` with `- Mode: pr`. `eval.md` turns
the acceptance criteria and the Verify section into numbered pass/fail checks `E-1...`. The board row ends `draft`, with
its `Runs` dependencies.
