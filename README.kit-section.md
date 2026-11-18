## The Workov kit

On top of this base, the kit (`app/`, `wv-bin/`, `patches/`, `overlay/`, `commands/`, `tests/`, `install.sh`) turns Workov
into a desktop app plus **one fleet for every project on the computer**:

- **One neutral hub, one dashboard, one router.** The dashboard (port 3080) shows every project's tickets on one board; the
  router serves the projects in fair turns. Tickets carry a per-project prefix (`ACM-001`).
- **One agent limit.** One worker at a time across all projects; heavy commands (install, test, lint, build) wait their turn
  machine-wide through the `wv-bin` shims.
- **Uniform projects.** Each project's fleet lives in its own managed clone (`~/Workov/fleets/<name>`), so your repository is
  never touched; work reaches it as a pushed branch and a draft PR / MR (`gh` or `glab`, or landing on an existing branch).
- **An 8-stage pipeline per ticket:** Draft, Plan, Design, Todo, Building, Review, Deliver, Done. The owner
  chooses at each gate (dispatch, design, review, deliver).

Install into a repository's fleet (idempotent; every patch reports `patched` or `already applied`):

```
bash install.sh <repository>          # clone mode: creates ~/Workov/fleets/<name>
bash install.sh <repository> --in-place --no-command   # straight into the given repo (for tests)
bash install.sh --hub                 # the neutral hub only
```

`install.sh` uses this repository as the base (`--base <path-or-git-url>` to use another checkout). Windows: Git Bash,
Python 3, Node.js, OpenCode. Tests: `python -m unittest tests.test_stages`, `python tests/e2e_stages.py`; the app:
`cd app && npx electron . --selftest`. Ported migration notes: `docs/MIGRATION-HUB.md`.
