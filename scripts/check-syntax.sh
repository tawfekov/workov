#!/usr/bin/env bash
# Syntax check for every script this kit ships. Run it before a commit and in CI: bash scripts/check-syntax.sh
#   .cjs  -> node --check
#   .js   -> node --check as an ES module (a plugin file is loaded as one, and `node --check` on the .js alone can pass wrongly)
#   .sh   -> bash -n
#   .py   -> python compile
# Why: a script written through a shell heredoc or a JSON string can lose its backslashes ('\n' becomes a line break,
# '\b' a backspace character). The file still looks fine and breaks only where it is loaded.
set -u
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0; n=0
files="$( (git ls-files; git ls-files --others --exclude-standard) 2>/dev/null | sort -u )"
[ -n "$files" ] || files="$(find . -type f \( -name '*.js' -o -name '*.cjs' -o -name '*.sh' -o -name '*.py' \) -not -path './node_modules/*' -not -path './vendor/*' -not -path './.git/*')"
while IFS= read -r f; do
  case "$f" in vendor/*|node_modules/*|*/node_modules/*|app/dist-installer/*|app/dist/*|*.min.js) continue ;; esac
  [ -f "$f" ] || continue
  case "$f" in
    *.cjs) n=$((n+1)); node --check "$f" >/dev/null 2>"$TMP/err" || { echo "FAIL $f"; head -3 "$TMP/err"; fail=1; } ;;
    *.js)  n=$((n+1)); cp "$f" "$TMP/m.mjs"; node --check "$TMP/m.mjs" >/dev/null 2>"$TMP/err" || { echo "FAIL $f (as an ES module)"; head -3 "$TMP/err"; fail=1; } ;;
    *.sh)  n=$((n+1)); bash -n "$f" 2>"$TMP/err" || { echo "FAIL $f"; head -3 "$TMP/err"; fail=1; } ;;
    *.py)  n=$((n+1)); python3 -I -c "import sys; compile(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1], 'exec')" "$f" 2>"$TMP/err" || { echo "FAIL $f"; head -3 "$TMP/err"; fail=1; } ;;
  esac
  # a backspace character in a source file is the other sign of a lost backslash (\b)
  case "$f" in *.js|*.cjs|*.sh|*.py) if LC_ALL=C grep -q "$(printf '\010')" "$f" 2>/dev/null; then echo "FAIL $f: contains a backspace character (a lost \\b)"; fail=1; fi ;; esac
done <<< "$files"
echo "checked $n files"
[ "$fail" = 0 ] && echo "syntax OK" || { echo "syntax errors found"; exit 1; }
