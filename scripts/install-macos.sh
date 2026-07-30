#!/bin/zsh
set -euo pipefail

APP_IDENTIFIER="io.github.baicie.codex-queue"
LABEL="io.github.baicie.codex-queue.scheduler"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DATA_DIRECTORY="$HOME/Library/Application Support/$APP_IDENTIFIER"
RUNTIME_DIRECTORY="$APP_DATA_DIRECTORY/bin"
LOG_DIRECTORY="$APP_DATA_DIRECTORY/logs"
PLIST_DIRECTORY="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIRECTORY/$LABEL.plist"
QUEUE="$APP_DATA_DIRECTORY/queue.json"
SOURCE_BINARY="$SCRIPT_DIR/codex-queue-demo"
CODEX_BINARY="${CODEX_BIN:-}"
OUTPUT_PLIST=""
DRY_RUN=false
QUEUE_WAS_SPECIFIED=false
TEMP_DIRECTORY=""
TEMP_PLIST=""

cleanup() {
  if [[ -n "$TEMP_PLIST" && -e "$TEMP_PLIST" ]]; then
    rm -f "$TEMP_PLIST"
  fi
  if [[ -n "$TEMP_DIRECTORY" && -d "$TEMP_DIRECTORY" ]]; then
    rm -rf "$TEMP_DIRECTORY"
  fi
}
trap cleanup EXIT

usage() {
  print "Usage: $0 [--cli-bin PATH] [--codex-bin PATH] [--queue PATH] [--dry-run] [--output-plist PATH]"
}

require_argument() {
  if [[ $# -lt 2 || -z "$2" ]]; then
    print -u2 "Missing value for $1"
    usage >&2
    exit 64
  fi
}

absolute_file_path() {
  local input_path="$1"
  local directory
  directory="$(cd "$(dirname "$input_path")" && pwd)"
  print -r -- "$directory/$(basename "$input_path")"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cli-bin)
      require_argument "$@"
      SOURCE_BINARY="$2"
      shift 2
      ;;
    --queue)
      require_argument "$@"
      QUEUE="$2"
      QUEUE_WAS_SPECIFIED=true
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --codex-bin)
      require_argument "$@"
      CODEX_BINARY="$2"
      shift 2
      ;;
    --output-plist)
      require_argument "$@"
      OUTPUT_PLIST="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      print -u2 "Unknown argument: $1"
      usage >&2
      exit 64
      ;;
  esac
done

if [[ ! -x "$SOURCE_BINARY" && "$SOURCE_BINARY" == "$SCRIPT_DIR/codex-queue-demo" ]]; then
  if [[ -x "$SCRIPT_DIR/../target/release/codex-queue-demo" ]]; then
    SOURCE_BINARY="$SCRIPT_DIR/../target/release/codex-queue-demo"
  fi
fi

[[ -x "$SOURCE_BINARY" ]] || {
  print -u2 "Scheduler CLI not found or not executable: $SOURCE_BINARY"
  print -u2 "Pass --cli-bin /absolute/path/to/codex-queue-demo"
  exit 1
}
if $QUEUE_WAS_SPECIFIED && [[ ! -f "$QUEUE" ]]; then
  print -u2 "Queue file not found: $QUEUE"
  exit 1
fi

if [[ -z "$CODEX_BINARY" ]]; then
  CODEX_BINARY="$(command -v codex || true)"
fi
[[ -n "$CODEX_BINARY" && -x "$CODEX_BINARY" ]] || {
  print -u2 "Codex CLI not found. Pass --codex-bin /absolute/path/to/codex"
  exit 1
}

SOURCE_BINARY="$(absolute_file_path "$SOURCE_BINARY")"
if [[ -f "$QUEUE" ]]; then
  QUEUE="$(absolute_file_path "$QUEUE")"
fi
CODEX_BINARY="$(absolute_file_path "$CODEX_BINARY")"
INSTALLED_BINARY="$RUNTIME_DIRECTORY/codex-queue-demo"

CODEX_DIRECTORY="$(dirname "$CODEX_BINARY")"
NODE_BINARY="$(command -v node || true)"
LAUNCH_PATH="$CODEX_DIRECTORY"
if [[ -n "$NODE_BINARY" ]]; then
  NODE_BINARY="$(absolute_file_path "$NODE_BINARY")"
  NODE_DIRECTORY="$(dirname "$NODE_BINARY")"
  if [[ "$NODE_DIRECTORY" != "$CODEX_DIRECTORY" ]]; then
    LAUNCH_PATH="$LAUNCH_PATH:$NODE_DIRECTORY"
  fi
fi
LAUNCH_PATH="$LAUNCH_PATH:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

if ! /usr/bin/env PATH="$LAUNCH_PATH" "$CODEX_BINARY" --version >/dev/null 2>&1; then
  print -u2 "Codex CLI could not run with the scheduler PATH: $CODEX_BINARY"
  print -u2 "Install a standalone Codex CLI or pass --codex-bin with its interpreter available."
  exit 1
fi

if $DRY_RUN; then
  if [[ -n "$OUTPUT_PLIST" ]]; then
    mkdir -p "$(dirname "$OUTPUT_PLIST")"
    PLIST="$OUTPUT_PLIST"
  else
    TEMP_DIRECTORY="$(mktemp -d)"
    PLIST="$TEMP_DIRECTORY/$LABEL.plist"
  fi
else
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || [[ -e "$PLIST" || -L "$PLIST" ]]; then
    print -u2 "Scheduler is already installed: $LABEL"
    print -u2 "Run uninstall-macos.sh first; queue and logs will be preserved."
    exit 1
  fi
  mkdir -p "$RUNTIME_DIRECTORY" "$LOG_DIRECTORY" "$PLIST_DIRECTORY"
  chmod 700 "$RUNTIME_DIRECTORY" "$LOG_DIRECTORY"
  if [[ ! -f "$QUEUE" ]]; then
    TEMP_QUEUE="$(mktemp "$APP_DATA_DIRECTORY/.queue.XXXXXX")"
    chmod 600 "$TEMP_QUEUE"
    print -r -- '{"version":1,"launchApp":true,"retryPolicy":{"maxAttempts":4,"initialDelaySeconds":30,"maxDelaySeconds":900},"tasks":[]}' > "$TEMP_QUEUE"
    if ln "$TEMP_QUEUE" "$QUEUE" 2>/dev/null; then
      :
    elif [[ ! -f "$QUEUE" || -L "$QUEUE" ]]; then
      print -u2 "Failed to initialize queue: $QUEUE"
      rm "$TEMP_QUEUE"
      exit 1
    fi
    rm "$TEMP_QUEUE"
  fi
  if [[ "$SOURCE_BINARY" != "$INSTALLED_BINARY" ]]; then
    install -m 755 "$SOURCE_BINARY" "$INSTALLED_BINARY"
  fi
  PLIST_TARGET="$PLIST"
  TEMP_PLIST="$(mktemp "$PLIST_DIRECTORY/.${LABEL}.plist.XXXXXX")"
  PLIST="$TEMP_PLIST"
fi

plutil -create xml1 "$PLIST"
plutil -insert Label -string "$LABEL" "$PLIST"
plutil -insert ProgramArguments -array "$PLIST"
plutil -insert ProgramArguments.0 -string "$INSTALLED_BINARY" "$PLIST"
plutil -insert ProgramArguments.1 -string "run" "$PLIST"
plutil -insert ProgramArguments.2 -string "--queue" "$PLIST"
plutil -insert ProgramArguments.3 -string "$QUEUE" "$PLIST"
plutil -insert ProgramArguments.4 -string "--codex-bin" "$PLIST"
plutil -insert ProgramArguments.5 -string "$CODEX_BINARY" "$PLIST"
plutil -insert WorkingDirectory -string "$APP_DATA_DIRECTORY" "$PLIST"
plutil -insert EnvironmentVariables -dictionary "$PLIST"
plutil -insert EnvironmentVariables.PATH -string "$LAUNCH_PATH" "$PLIST"
plutil -insert StartCalendarInterval -dictionary "$PLIST"
plutil -insert StartCalendarInterval.Hour -integer 1 "$PLIST"
plutil -insert StartCalendarInterval.Minute -integer 0 "$PLIST"
plutil -insert StandardOutPath -string "$LOG_DIRECTORY/queue.out.log" "$PLIST"
plutil -insert StandardErrorPath -string "$LOG_DIRECTORY/queue.err.log" "$PLIST"
plutil -insert ProcessType -string "Background" "$PLIST"
plutil -insert ThrottleInterval -integer 60 "$PLIST"
chmod 600 "$PLIST"
plutil -lint "$PLIST" >/dev/null

if $DRY_RUN; then
  if [[ -z "$OUTPUT_PLIST" ]]; then
    plutil -convert xml1 -o - "$PLIST"
  else
    print "Generated LaunchAgent plist: $PLIST"
  fi
  exit 0
fi

if ! /bin/ln "$TEMP_PLIST" "$PLIST_TARGET"; then
  print -u2 "Failed to install LaunchAgent plist: $PLIST_TARGET"
  exit 1
fi
rm "$TEMP_PLIST"
TEMP_PLIST=""
PLIST="$PLIST_TARGET"

if launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
  :
else
  BOOTSTRAP_STATUS=$?
  rm -f "$PLIST_TARGET"
  print -u2 "Failed to load LaunchAgent."
  exit "$BOOTSTRAP_STATUS"
fi

launchctl enable "gui/$(id -u)/$LABEL"

print "Installed daily 01:00 task: $LABEL"
print "Queue: $QUEUE"
print "Run now: launchctl kickstart -k gui/$(id -u)/$LABEL"
print "Inspect: launchctl print gui/$(id -u)/$LABEL"
