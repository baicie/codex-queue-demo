#!/bin/zsh
set -euo pipefail

APP_IDENTIFIER="io.github.baicie.codex-queue"
LABEL="io.github.baicie.codex-queue.scheduler"
APP_DATA_DIRECTORY="$HOME/Library/Application Support/$APP_IDENTIFIER"
RUNTIME_DIRECTORY="$APP_DATA_DIRECTORY/bin"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ $# -gt 0 ]]; then
  case "$1" in
    --help|-h)
      print "Usage: $0"
      exit 0
      ;;
    *)
      print -u2 "Unknown argument: $1"
      exit 64
      ;;
  esac
fi

if [[ -f "$PLIST" ]]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl disable "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm "$PLIST"
fi

rm -f "$RUNTIME_DIRECTORY/codex-queue-demo"
rmdir "$RUNTIME_DIRECTORY" 2>/dev/null || true

print "Uninstalled $LABEL and its scheduler CLI."
print "Preserved queue and logs in: $APP_DATA_DIRECTORY"
