# Migration: from "a project is the hub" to a neutral hub

## What changes
- **Hub** (dashboard server + UI, router loop, shared config/limits/models, `job/dashboard-auth.json`, port) moves from a project
  folder to a neutral folder, default `~/Workov/hub`. It has an empty board, belongs to no project, is recorded only in
  `~/.workov/hub.json` and never in `fleets.json`.
- The old hub project (say `acme-web`) becomes a normal project: a clone in `~/Workov/fleets/<name>` (origin = the old origin, every local
  branch, the old working copy's ticket files, its ledger/paused/stage state with paths rewritten), registered in `fleets.json`.
  The original folder is only read, never changed; it just stops being the hub.
- Every project has a prefix (`acme-web` = `ACM`, `ACM-009`). The dashboard has no "own project" case any more (`patches/neutral-hub.cjs`):
  ids are prefixed everywhere, the board is ordered stage -> priority (P0<P1<P2) -> newest (highest number) first, never by project.
- Models changed on the dashboard are mirrored into each project's config / `opencode.json` / agent files; permission requests of
  every project are listed; the router loop is always started from the hub folder.
- The Workov app: first run creates the hub (`install.sh --hub`) and sets `fleet` to it; Add project always clones.

## Run (nothing is stopped or started by the tool)
1. `python wv-bin/wv-migrate-hub.py` (dry run: lists every step). Add `--app-config "%APPDATA%\Workov\config.json"` to include the app config.
2. Stop the old hub: the dashboard server and the router loop (the tool prints the pids and commands). Quit the Workov app.
   Running workers keep running in their worktrees.
3. `python wv-bin/wv-migrate-hub.py --apply --app-config "%APPDATA%\Workov\config.json"` (refuses while the old hub runs; `--allow-running` overrides).
   Backup of hub.json, fleets.json and the app config: `~/.workov/backups/hub-migration-<time>/`. Running it again changes nothing.
4. Start the Workov app (or `cd ~/Workov/hub && bash .claude/scripts/start-dashboard.sh`). Same port and token. Expect about 1-2 minutes down.
5. Check `/api/wv/projects` (`acme-web` listed, hub not) and the board (`ACM-xxx`).
   Branch worktrees made beside the old folder (`acme-web-009-...`) stay where they are; the owner's repo is unchanged.

## Rollback
`python wv-bin/wv-migrate-hub.py --rollback <backup-folder> --apply` restores hub.json, fleets.json and the app config. Then stop the
new hub and start the old one with its `start-dashboard.sh`. Add `--remove-created` to also delete the new hub and the clone (it
loses any ticket work done in the clone since the migration).

## Known limits
- Ticket priority/dependencies are read from BOARD.md; "newest first" means highest ticket number, mixed across projects.
- "Pause all" pauses through the hub's switch and kills workers, but the per-ticket paused ledger of a project is set only by
  per-ticket pause. Models written in the hub overwrite only `models` of a project config.
