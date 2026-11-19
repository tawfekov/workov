#!/usr/bin/env bash
# shell-note.sh [powershell|posix]: the sentence that tells the router which shell its commands run in, so it writes
# commands that work there. router-loop.sh puts it in the router's prompt every cycle.
#   shell:  the first argument, else WV_AGENT_SHELL (powershell | posix | bash | zsh | sh), else the platform:
#           Windows (Git Bash, MSYS, Cygwin) -> powershell, anything else -> posix.
#           Set WV_AGENT_SHELL=posix on Windows if your agents run in Git Bash or WSL.
#   WV_UNAME overrides `uname -s` (used by the tests to try other platforms).
# Single quotes below on purpose: a double-quoted $(...) here would be RUN by bash instead of printed.
set -u
kind="${1:-${WV_AGENT_SHELL:-}}"
if [ -z "$kind" ]; then
  case "${WV_UNAME:-$(uname -s 2>/dev/null)}" in
    MINGW*|MSYS*|CYGWIN*|Windows*) kind=powershell ;;
    *) kind=posix ;;
  esac
fi
case "$kind" in
  powershell|pwsh)
    echo 'Your shell is Windows PowerShell 5.1: NEVER chain commands with && or ||, never use bash-only syntax (export, heredocs, $(...), VAR=x cmd); run one simple command per call.' ;;
  posix|bash|zsh|sh)
    echo 'Your shell is a POSIX shell (bash or zsh): you may pipe and chain with && when every part is a simple command, but quote every path and keep each call to one small step.' ;;
  *)
    echo "usage: shell-note.sh [powershell|posix]   (got '$kind')" >&2; exit 2 ;;
esac
