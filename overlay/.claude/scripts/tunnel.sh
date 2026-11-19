#!/usr/bin/env bash
# tunnel.sh on|off|status: the one switch for remote access to this fleet's dashboard (Cloudflare tunnel).
#   off     provider = local and every connector for this dashboard's port is stopped: nothing is exposed.
#   on      provider = cloudflared (the named tunnel and hostname in the config are kept) and the tunnel is started.
#   status  shows the provider, the port and how many connectors are running.
# Run from anywhere inside the fleet folder:  bash .claude/scripts/tunnel.sh on
# Stopping connectors (off) is Windows only; elsewhere it sets the provider and tells you to stop cloudflared yourself.
# win_tunnels below is a copy of the one in patches/tunnel-windows.sh, so this script does not depend on that patch.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CFG="$ROOT/specs/workov.config.json"
PY="$(command -v python3 || command -v python)"
read_cfg() { "$PY" - "$CFG" "$1" <<'PYEOF'
import json, sys
c = json.load(open(sys.argv[1], encoding="utf-8")).get("dashboard", {})
print(c.get("port", 3080) if sys.argv[2] == "port" else c.get("tunnel", {}).get("provider", "cloudflared"))
PYEOF
}
set_provider() { "$PY" - "$CFG" "$1" <<'PYEOF'
import json, sys
p = sys.argv[1]
c = json.load(open(p, encoding="utf-8"))
c.setdefault("dashboard", {}).setdefault("tunnel", {})["provider"] = sys.argv[2]
with open(p, "w", encoding="utf-8") as f:
    json.dump(c, f, indent=2, ensure_ascii=False); f.write("\n")
PYEOF
}
win_tunnels() {
  local port="$1" mode="$2" out=""
  [[ "$port" =~ ^[0-9]+$ ]] || { echo 0; return 0; }
  command -v powershell.exe >/dev/null 2>&1 || { echo 0; return 0; }
  out="$(powershell.exe -NoProfile -NonInteractive -Command "\$p=@(Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | Where-Object { \$_.CommandLine -match 'tunnel (run )?--url http://127\.0\.0\.1:$port( |\$)' } | Sort-Object CreationDate); \$k=if ('$mode' -eq 'all') {0} else {1}; \$p | Select-Object -Skip \$k | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }; [Math]::Min(\$p.Count,\$k)" 2>/dev/null | tr -d '\r')"
  echo "${out:-0}"
}
count() { powershell.exe -NoProfile -NonInteractive -Command "@(Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | Where-Object { \$_.CommandLine -match 'tunnel (run )?--url http://127\.0\.0\.1:$(read_cfg port)( |\$)' }).Count" 2>/dev/null | tr -d '\r' || echo "?"; }
case "${1:-status}" in
  off)
    set_provider local
    if ! command -v powershell.exe >/dev/null 2>&1; then
      echo "Remote access OFF in the config (provider=local), but this script can only stop connectors on Windows." >&2
      echo "Stop any running cloudflared for port $(read_cfg port) yourself." >&2
      exit 1
    fi
    win_tunnels "$(read_cfg port)" all >/dev/null
    left="$(count)"
    echo "Remote access OFF: provider=local, connectors left: $left"
    [ "$left" = 0 ] || { echo "a connector is still running; stop it before relying on this" >&2; exit 1; } ;;
  on)
    set_provider cloudflared
    bash "$ROOT/.claude/scripts/start-dashboard.sh" --tunnel cloudflared | tail -4
    echo "Remote access ON: provider=cloudflared, connectors running: $(count)" ;;
  status)
    echo "provider=$(read_cfg provider) port=$(read_cfg port) connectors=$(count)" ;;
  *) echo "usage: bash .claude/scripts/tunnel.sh on|off|status" >&2; exit 2 ;;
esac
