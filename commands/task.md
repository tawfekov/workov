---
description: Prepare and run a task of any project on the Workov fleet, driven by a per-project profile file that is created on first use.
argument-hint: "[<profile name>] [task id or description] [headless | with <cli> | review | deliver | profile]"
---

# /task — one command for every project

The fleet (router, planner, worker, tester, reviewer) does not care which project a task belongs to. What changes per
project is only the **profile**: where tasks come from, how branches and commits are named, what "checked" means, and
how work is delivered. `/task` picks the profile, then runs the same flow.

## 1. Pick the profile

The first word of my input names the profile (`~/.claude/task-profiles/<name>.md`). When it does not, find the profile
whose `Repo:` line contains the current folder; when none does, ask me which profile to use (offer the existing ones plus
"new").

## 2. The profile

A profile is one Markdown file, `~/.claude/task-profiles/<name>.md`, with this shape:

```
# Profile: <name>
- Repo: <absolute path of the project>
- Task source: <local board `specs/tickets/BOARD.md` | GitHub issues | GitLab issues | another tracker: <where> | none: I describe it>
- Branch name: <e.g. feat/<slug>>
- Commit style: <e.g. conventional, single line>
- Checks: <the commands that prove a change is good: lint, test, build>
- Delivery: <push + PR on GitHub | MR on GitLab | leave in working tree | other>
- Rules: <anything specific: language, design system, never touch X>
```

Steps:
1. Read the profile. If the file does not exist, or a field is missing: **do not guess**. Inspect the repo first
   (git remote, package.json scripts, CLAUDE.md/AGENTS.md, branch history) to propose answers, then ask me only for what
   the repo could not tell you, with the proposed answers as the options. Then **write the profile file** and carry on.
   `/task <name> profile` re-opens it for changes.
2. Make sure the fleet is in the repo: it is when `specs/workov.config.json` exists. If not, offer to run
   `bash <workov>/install.sh <repo>` (it creates the project's fleet in its own managed folder and never touches the
   repository) and wait for my yes.
3. Get the task: from the profile's task source (an id), or from my words if the source is `none` or I typed a
   description. Create the ticket on the fleet's board: `rd.md` with the short plan (the Plan standard in
   `.claude/plan-standard.md`: tests first, small steps that copy existing files), `eval.md`, and the board row. Use the
   profile's branch name, commit style and checks wherever the standard names its own.
4. The worker builds, tester and reviewer gate it, as on any fleet ticket. I watch it on the dashboard.
5. `review` and `deliver` follow the profile's Delivery line. The global rules in `~/.claude/CLAUDE.md` still apply to
   every commit and PR description.

## Ticket flow (every profile)

The fleet asks me at three points:

1. **Before skipping anything.** A required screenshot or check that cannot run (no test account, credential or tool) is
   never skipped by the agent. The ticket blocks with the exact need and two options (skip it with a note, or I provide
   it and it retries); only my answer allows a skip.
2. **Draft PR / MR ready:** I choose the review: the fleet reviewer, Claude, both, or skip.
3. **After the review:** I choose whether to deliver. Yes: the PR / MR becomes ready and the optional tracker hook of
   `~/.claude/workov-profile.json` runs. No: the ticket ends as done and nothing else is touched.

## Rules

- A profile file never holds secrets. Tokens stay in environment variables.
- Never mix profiles in one run.
- If the provider is capped or a model fails, say so and point me at the dashboard's Providers panel (Switch, Connect,
  Test) rather than retrying in a loop.
