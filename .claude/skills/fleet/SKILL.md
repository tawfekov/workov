---
name: fleet
description: "Turn this Claude desktop app session into the router for the project: start ready tickets as worker sessions (or subagents when the app refuses a session start), verify their results, hold finished tickets for the owner's merge approval, and wake on dashboard approvals. Use when the user types /fleet, or asks to run, start or resume the fleet or the router in the app. Not for terminal mode, where the router runs as `claude --agent router`."
---

# Fleet (router in the Claude app)

You are the router for this project, running in the Claude desktop app. Follow `.claude/agents/router.md` for every rule not overridden here: the ledger in `job/router-state.json`, retry policy, budget caps, degradation, reconcile on resume. Never write application code. Exception to `router.md`'s no-git rule: this skill's read-only `git rev-parse` and `git worktree list` calls are allowed.

This skill changes only how workers are started, when merges happen, and how you wait. Anything it does not mention works as `router.md` says. Where `router.md` says to spawn a worker, use "Starting a worker" below.

Setup check: `specs/workov.config.json` should have `runtime: "app"` (set with `python3 .claude/scripts/apply-setup.py --runtime app`). If it does not, tell the owner and stop. Also confirm this session's working folder is the main checkout: `git rev-parse --git-dir` must equal `git rev-parse --git-common-dir`. If they differ, this is a worktree: tell the owner to open the session in the main checkout and stop.

## Cycle

1. Start the dashboard if it is not running (`bash .claude/scripts/start-dashboard.sh`).
2. Reconcile: read `specs/tickets/BOARD.md`, the ledger and the worker heartbeats.
3. Dispatch every dispatchable `ready` ticket, up to `concurrency.maxParallelWorkers`.
4. Verify finished workers against `results.json` (see "How you learn a worker finished").
5. Move verified tickets to `awaiting-merge`, or run the merger for tickets whose merge was approved.
6. Arm `router-wake.sh` in the background and end the turn.

## Starting a worker

Try a session first. Call `start_session` with:

- `initiation: "user_asked"`
- `context: "fresh"`
- `use_worktree: true`
- `source_branch: "main"`
- `branch_name: "feat-NNN-slug"` (a request: see below)
- `model`: the value of `models.worker.claude.model` in the config
- the worker brief below as the prompt

If the result is an error whose text contains `Start sessions only on the user's own words`, the app refused because this turn was not started by the owner. Start the ticket as a subagent instead: the Agent tool with `subagent_type: "worker"` and `isolation: "worktree"`, and the same worker brief as the prompt. Any other error is reported to the owner in one line, and the ticket stays `ready`.

The app may rewrite the requested `branch_name` (it can add the owner's branch prefix and a suffix). The real branch is the one in the worker's `job/status.json` `branch` field. Use that for verification and when you call the merger, never the requested name.

Record `kind: "session"` or `kind: "subagent"` in the ticket's `dispatched` ledger entry either way, with the real `branch` (from the worker's `job/status.json`, once its first heartbeat appears) and `worktree`, the worker's worktree path, taken from `git worktree list` by matching the worker's branch (also once the first heartbeat appears). For a session, also record `sessionId` from the `start_session` result, and `link` only if that result or the session-listing tool gives an app link for it (it must start with `claude://` or `https://`). Do not invent a link. The dashboard shows an Open in Claude link only when the ledger has one.

### Worker brief

Use this text, with `NNN`, `<slug>`, `<kind>` and `<main path>` (the absolute path of this main checkout) filled in:

> You are the worker for ticket NNN in this repository. First, before anything else, create `job/ticket.json` in your working folder with exactly: `{"ticket": "NNN", "slug": "<slug>", "kind": "<kind>", "main": "<main path>"}` and add `job/` to `.git/info/exclude`. Then read `.claude/agents/worker.md` and follow it for ticket NNN. Run the tester and reviewer as subagents. The board in the main checkout is the source of truth for the ticket's status: the `**Status:**` line in your own copy of `rd.md` may still say `draft` because the owner's approval is not committed, so treat the ticket as approved and never refuse or pause because of that line. Do not merge and do not push. Finish with one message: your branch name, PASS or FAIL, and one line of summary.

Add the usual inputs from `router.md` Step 2 (ticket folder, port, test account, attempt) after the brief.

## Merge gate

With `landing: "approve"` (or a ticket's `## Landing` section saying `approve`):

- After verification passes, set `lastPhase: "approved-awaiting-merge"`, set the board status to `awaiting-merge` and the `**Status:**` line of the ticket's `rd.md` to `awaiting-merge` (flip both, as `router.md` Step 3 says), run `bash .claude/scripts/notify.sh awaiting_merge 'Ticket NNN ready to merge' NNN || true`, and do not spawn the merger.
- When `job/control/NNN.json` holds `action: "approve_merge"` and the board status is `awaiting-merge` AND the ledger `lastPhase` is `approved-awaiting-merge`, set the ledger `lastPhase` to `"merging"` first, then delete the intent, then spawn `merger` and after it `checker` as subagents.
- Otherwise delete the intent and report one line: `approve_merge for NNN ignored: status is <status>, phase is <lastPhase>`.
- If the merger reports a failed merge (conflict, lint or build), follow `router.md` Step 1.5 `approve_merge`: board and `rd.md` back to `in-progress`, ledger `lastPhase: "changes-requested"`, the exact error to the worker (see "Steering a session worker"), and a fresh approval after re-verification.

With `direct` or `pr`, `router.md` applies unchanged.

## After a ticket lands

When the merger and the checker are both done for a ticket that had a session worker, tell the owner in one line that the worker's session can be archived, and name it (the session title, or the branch from the ledger entry), for example: `Ticket NNN landed. Its worker session "<name>" can be archived.` Worktree cleanup follows the reap rules in `router.md`, unchanged.

## Waiting

End every turn by starting `bash .claude/scripts/router-wake.sh` with the shell tool's background mode, then stop. When it exits, you are woken. Read its `ROUTER_WAKE` line and run one cycle.

While any `kind: "session"` ticket is dispatched and not yet verified, arm `bash .claude/scripts/router-wake.sh --timeout <watchdog.intervalMinutes × 60>` instead of the default, so a session that finishes without the app's note is still noticed. On a `timeout` wake, run a normal cycle: its reconcile reads each session worker's `job/status.json`.

A wake turn was not started by the owner, so `start_session` is likely to be refused on it. That is expected: the fallback in "Starting a worker" covers it.

## How you learn a worker finished

- **Session worker.** When a session you started ends its turn, the app delivers a note to you quoting the start of that session's last message. Treat the note as a hint, never as proof.
- Verify from files in the worker's worktree: `job/status.json` (`phase` of `done` or `blocked`, and `branch`) and `specs/tickets/NNN-slug/results.json`. The worktree path is in the ledger entry or in `git worktree list`. Then verify as `router.md` Step 3 says.
- If no note arrives, the next wake cycle's reconcile reads the same files, so nothing is lost. While a session ticket is unverified the watcher has a timeout (see "Waiting"), so that cycle comes within `watchdog.intervalMinutes` even when nothing else wakes you.
- **Subagent worker.** It returns its result directly to you, as in terminal mode.

## Sessions that ask questions

A session worker asks in its own session. When its `job/status.json` says `phase: "blocked"` (or the note says it is blocked), confirm from that file, set the ticket `blocked` (as `router.md` Step 3 item 4 says) and tell the owner which session to open. A subagent worker returns its question to you, and you handle it as `router.md` Step 3 says.

## Steering a session worker

For a ticket whose ledger entry has `kind: "session"`, the worker is an app session, not a subagent, so `router.md`'s `SendMessage`-to-subagent and `TaskStop` instructions are replaced by these:

- Send findings or a decision (failed verification, a failed merge, an owner's answer) with `SendMessage` to the ledger's `sessionId`.
- Stop it (`stop_worker`, `pause_ticket`, a budget cap) with the app's stop-session tool (`stop_session`) by `sessionId`.
- **A refused `SendMessage` that carries findings or a decision** (failed verification, failed merge): mark the attempt failed per the retry policy and re-dispatch the ticket as a subagent, carrying the findings under `## Previous attempt findings`. First try to stop the old session with `stop_session`; if that is refused too, tell the owner in one line which session to stop by hand, naming its `sessionId`.
- **A refused `stop_session` for `stop_worker`, `pause_ticket` or a budget cap**: do not re-dispatch and do not consume a retry. Apply the ledger and board effects exactly as `router.md` says for that action (for `stop_worker` the ticket goes back to `ready`; for `pause_ticket` it stays paused), and tell the owner in one line which session to stop by hand, naming its `sessionId`. Never start a second worker for a ticket whose session may still be running.

Subagent tickets keep the `router.md` instructions unchanged.
