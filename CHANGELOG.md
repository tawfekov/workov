# Changelog

All notable changes to workov are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The version is the `version` field in `specs/workov.config.json`.

## [Unreleased]

App mode: run the router from the Claude desktop app.

- `/fleet` skill: runs the router in a Claude desktop app session. Workers start as app sessions when the app allows it and as subagents when it refuses; the ledger records `kind`, and for sessions `sessionId` and `link`.
- Merge gate: landing mode `approve`, board status `awaiting-merge`, dashboard action `approve_merge` and notify event `awaiting_merge`. The merger accepts a ticket in `awaiting-merge`.
- Hooks: `.claude/hooks/fleet-hook.py` writes `job/hook-status.json` for each worker (identified by its `job/ticket.json` marker). The dashboard shows last activity, tester and reviewer completion, a stall flag from the hook heartbeat (a running tool call gets four times the threshold), the worker kind and an `Open in Claude` link.
- Setup: `apply-setup.py --runtime app|terminal` merges the seven hook events into `.claude/settings.json` without replacing it, and records `runtime` in the config. Switching to `app` sets landing to `approve` only when it was `direct` or not set; `pr` is kept.
- Workers write the `job/ticket.json` marker as their first step when the router's brief gives them marker values. Terminal-mode workers skip it.
- `/api/state` worker entries carry `link` from the router ledger when it is an `https://` or `claude://` URL.
- Dashboard: a card shows `merge approved` and `merging` after **Approve merge**; a second approval during a merge is refused; `awaiting-merge` cannot be set by hand; Review opens the first draft; only fleet workers are listed under Agents.

## [0.1]

First release of workov.

- Ticket-driven workflow for Claude Code, OpenCode and the Codex CLI: `/write-tickets` turns feature requests into `rd.md` + `eval.md`, and the `router` dispatches ready tickets to workers in isolated git worktrees or to an agent team.
- Agents: `router`, `worker`, `teammate`, `tester`, `reviewer`, `merger`, `checker`, `reproducer` and `watchdog`.
- Fleet Control Dashboard with a board, live worker cards, dependency chains, approvals, telemetry and budgets, reachable locally or through a Cloudflare Tunnel or ngrok.
- Token-based dashboard auth, push notifications (ntfy, Telegram, Slack), a script-scheduled watchdog, and direct or PR landing.
- `install.sh` to install the workflow into an existing git repository, `/setup` (`apply-setup.py`) to configure it, and `selftest.py` to check it.
