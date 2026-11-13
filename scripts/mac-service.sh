#!/bin/bash
# Run the bot as a macOS background service (launchd) instead of `npm run forever`.
# launchd starts it at login, restarts it within ~5s whenever it exits (crash or the
# dashboard Restart button), and wraps it in caffeinate so the Mac doesn't idle-sleep.
# Closing the lid still sleeps the Mac.
#
#   bash scripts/mac-service.sh install     # stop any `npm run forever` first!
#   bash scripts/mac-service.sh status
#   bash scripts/mac-service.sh logs        # live log (Ctrl-C stops viewing, not the bot)
#   bash scripts/mac-service.sh restart
#   bash scripts/mac-service.sh uninstall
set -euo pipefail
LABEL="com.kalshibot.server"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$REPO/logs/bot.log"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    NODE="$(command -v node || true)"
    [ -n "$NODE" ] || { echo "node not found on PATH"; exit 1; }
    if lsof -nP -iTCP:3333 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "Something is already listening on port 3333 (probably 'npm run forever')."
      echo "Stop it with Ctrl-C in its Terminal tab first, then re-run install."
      exit 1
    fi
    mkdir -p "$HOME/Library/LaunchAgents" "$REPO/logs"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-dis</string>
    <string>$NODE</string><string>-r</string><string>dotenv/config</string><string>server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
    plutil -lint "$PLIST" >/dev/null
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Installed. Dashboard: http://localhost:3333  |  Log: bash scripts/mac-service.sh logs"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed. Start manually again with: caffeinate -dis npm run forever"
    ;;
  restart) launchctl kickstart -k "$DOMAIN/$LABEL" && echo "Restarted." ;;
  status)  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s*(state|pid|last exit code) =' || echo "Not installed." ;;
  logs)    tail -n 50 -f "$LOG" ;;
  *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
