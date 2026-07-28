#!/bin/zsh
set -euo pipefail

LABEL="com.openai.codex-queue-demo"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ -f "$PLIST" ]]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl disable "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm "$PLIST"
fi

print "Uninstalled $LABEL. Existing logs and queue results were preserved."
