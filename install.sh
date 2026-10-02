#!/usr/bin/env bash
# Installs MiniSync as a background service for your user (starts at login).
# Usage: ./install.sh [ROM folder ...] [--token SECRET] [--port N]
#   With no ROM folder, the folder that contains this project is used (e.g. "WEB POKEMINI").
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/minisync"
APP="$DATA/app"
ARGS=()
ROMS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --token|--port) ARGS+=("$1" "$2"); shift 2 ;;
    *) ROMS+=("$(cd "$1" && pwd)"); shift ;;
  esac
done
[ ${#ROMS[@]} -eq 0 ] && ROMS=("$(dirname "$HERE")")
command -v python3 >/dev/null || { echo "python3 is required (sudo apt install python3)"; exit 1; }
mkdir -p "$APP" "$DATA/roms"
rm -rf "$APP/web" "$APP/companion"
cp -r "$HERE/web" "$HERE/companion" "$APP/"
EXEC="/usr/bin/env python3 \"$APP/companion/minisync.py\" --web-dir \"$APP/web\""
for r in "${ROMS[@]}"; do EXEC="$EXEC --roms \"$r\""; done
for a in "${ARGS[@]+"${ARGS[@]}"}"; do EXEC="$EXEC \"$a\""; done
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/minisync.service" <<UNIT
[Unit]
Description=MiniSync - Web Pokémon mini for your phone
After=network-online.target

[Service]
ExecStart=$EXEC
Restart=on-failure

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable minisync.service
systemctl --user restart minisync.service
sleep 1.5
echo
echo "MiniSync is running. ROM folders: ${ROMS[*]} and $DATA/roms"
echo "Addresses for your phone:"
journalctl --user -u minisync.service -n 40 --no-pager -o cat | grep -E "http://" || true
echo
echo "If your phone can't connect and you use a firewall:  sudo ufw allow 8766/tcp"
echo "Logs: journalctl --user -u minisync -f     Stop: systemctl --user disable --now minisync"
