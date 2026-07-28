#!/bin/zsh
set -euo pipefail

LABEL="com.openai.codex-queue-demo"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BINARY="$PROJECT_ROOT/target/release/codex-queue-demo"
QUEUE="$PROJECT_ROOT/demo/queue.json"
CODEX_BINARY="${CODEX_BIN:-$(command -v codex || true)}"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --queue)
      QUEUE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --codex-bin)
      CODEX_BINARY="$2"
      shift 2
      ;;
    *)
      print -u2 "Unknown argument: $1"
      exit 64
      ;;
  esac
done

[[ -x "$BINARY" ]] || {
  print -u2 "Release binary not found. Run: cargo build --release"
  exit 1
}
[[ -f "$QUEUE" ]] || {
  print -u2 "Queue file not found: $QUEUE"
  exit 1
}
[[ -x "$CODEX_BINARY" ]] || {
  print -u2 "Codex CLI not found. Pass --codex-bin /absolute/path/to/codex"
  exit 1
}

QUEUE="$(cd "$(dirname "$QUEUE")" && pwd)/$(basename "$QUEUE")"
CODEX_BINARY="$(cd "$(dirname "$CODEX_BINARY")" && pwd)/$(basename "$CODEX_BINARY")"
LOG_DIRECTORY="$PROJECT_ROOT/logs"
PLIST_DIRECTORY="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIRECTORY/$LABEL.plist"

if $DRY_RUN; then
  TEMP_DIRECTORY="$(mktemp -d)"
  trap 'rm -r "$TEMP_DIRECTORY"' EXIT
  PLIST="$TEMP_DIRECTORY/$LABEL.plist"
else
  mkdir -p "$LOG_DIRECTORY" "$PLIST_DIRECTORY"
  chmod 700 "$LOG_DIRECTORY"
fi

plutil -create xml1 "$PLIST"
plutil -insert Label -string "$LABEL" "$PLIST"
plutil -insert ProgramArguments -array "$PLIST"
plutil -insert ProgramArguments.0 -string "$BINARY" "$PLIST"
plutil -insert ProgramArguments.1 -string "run" "$PLIST"
plutil -insert ProgramArguments.2 -string "--queue" "$PLIST"
plutil -insert ProgramArguments.3 -string "$QUEUE" "$PLIST"
plutil -insert ProgramArguments.4 -string "--codex-bin" "$PLIST"
plutil -insert ProgramArguments.5 -string "$CODEX_BINARY" "$PLIST"
plutil -insert WorkingDirectory -string "$PROJECT_ROOT" "$PLIST"
plutil -insert StartCalendarInterval -dictionary "$PLIST"
plutil -insert StartCalendarInterval.Hour -integer 1 "$PLIST"
plutil -insert StartCalendarInterval.Minute -integer 0 "$PLIST"
plutil -insert StandardOutPath -string "$LOG_DIRECTORY/queue.out.log" "$PLIST"
plutil -insert StandardErrorPath -string "$LOG_DIRECTORY/queue.err.log" "$PLIST"
plutil -insert ProcessType -string "Background" "$PLIST"
plutil -insert ThrottleInterval -integer 60 "$PLIST"
chmod 600 "$PLIST"
plutil -lint "$PLIST"

if $DRY_RUN; then
  plutil -convert xml1 -o - "$PLIST"
  exit 0
fi

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

print "Installed daily 01:00 task: $LABEL"
print "Run now: launchctl kickstart -k gui/$(id -u)/$LABEL"
print "Inspect: launchctl print gui/$(id -u)/$LABEL"
