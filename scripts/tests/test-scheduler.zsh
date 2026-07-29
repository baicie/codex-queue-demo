#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMP_DIRECTORY="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIRECTORY"' EXIT

fail() {
  print -u2 "FAIL: $1"
  exit 1
}

assert_equal() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  [[ "$actual" == "$expected" ]] || fail "$message (expected '$expected', got '$actual')"
}

assert_path_contains() {
  local path_value="$1"
  local expected_entry="$2"
  local message="$3"
  [[ ":$path_value:" == *":$expected_entry:"* ]] || fail "$message ('$expected_entry' missing from '$path_value')"
}

assert_file_contains() {
  local expected_text="$1"
  local file_path="$2"
  local message="$3"
  /usr/bin/grep -Fq -- "$expected_text" "$file_path" || fail "$message"
}

PACKAGE_DIRECTORY="$TEMP_DIRECTORY/release-package"
FAKE_BIN_DIRECTORY="$TEMP_DIRECTORY/npm-bin"
FAKE_NODE_DIRECTORY="$TEMP_DIRECTORY/node-bin"
FAKE_FAILURE_DIRECTORY="$TEMP_DIRECTORY/failure-bin"
FAKE_CONCURRENT_DIRECTORY="$TEMP_DIRECTORY/concurrent-bin"
FAKE_SYMLINK_DIRECTORY="$TEMP_DIRECTORY/symlink-bin"
TEST_HOME="$TEMP_DIRECTORY/home"
APP_DATA_DIRECTORY="$TEST_HOME/Library/Application Support/io.github.baicie.codex-queue"
DEFAULT_QUEUE="$APP_DATA_DIRECTORY/queue.json"
EXPLICIT_QUEUE="$TEMP_DIRECTORY/explicit queue.json"
EXPLICIT_CLI="$TEMP_DIRECTORY/custom cli"

mkdir -p \
  "$PACKAGE_DIRECTORY" \
  "$FAKE_BIN_DIRECTORY" \
  "$FAKE_NODE_DIRECTORY" \
  "$FAKE_FAILURE_DIRECTORY" \
  "$FAKE_CONCURRENT_DIRECTORY" \
  "$FAKE_SYMLINK_DIRECTORY" \
  "$APP_DATA_DIRECTORY"
cp "$REPOSITORY_ROOT/scripts/install-macos.sh" "$PACKAGE_DIRECTORY/install-macos.sh"
cp "$REPOSITORY_ROOT/scripts/uninstall-macos.sh" "$PACKAGE_DIRECTORY/uninstall-macos.sh"

print '#!/bin/zsh\nexit 0' > "$PACKAGE_DIRECTORY/codex-queue-demo"
print '#!/usr/bin/env node\nprocess.exit(0)' > "$FAKE_BIN_DIRECTORY/codex"
print '#!/bin/zsh\nexit 0' > "$FAKE_NODE_DIRECTORY/node"
print '#!/bin/zsh
if [[ -n "${FAKE_LAUNCHCTL_LOG:-}" ]]; then
  print -r -- "$*" >> "$FAKE_LAUNCHCTL_LOG"
fi
case "${1:-}" in
  print)
    [[ -n "${FAKE_LAUNCHCTL_STATE:-}" && -f "$FAKE_LAUNCHCTL_STATE" ]]
    ;;
  bootstrap)
    if [[ -n "${FAKE_LAUNCHCTL_STATE:-}" ]]; then
      print -r -- "${2:-}" > "$FAKE_LAUNCHCTL_STATE"
    fi
    ;;
  bootout)
    if [[ -n "${FAKE_LAUNCHCTL_STATE:-}" ]]; then
      rm -f "$FAKE_LAUNCHCTL_STATE"
    fi
    ;;
esac' > "$FAKE_BIN_DIRECTORY/launchctl"
print '#!/bin/zsh\nexit 1' > "$FAKE_FAILURE_DIRECTORY/ln"
print '#!/bin/zsh
print -r -- '\''{"version":1,"launchApp":false,"retryPolicy":{"maxAttempts":2,"initialDelaySeconds":5,"maxDelaySeconds":20},"tasks":[]}'\'' > "$2"
exit 1' > "$FAKE_CONCURRENT_DIRECTORY/ln"
print '#!/bin/zsh
/bin/ln -s "$1" "$2"
exit 1' > "$FAKE_SYMLINK_DIRECTORY/ln"
print '#!/bin/zsh\nexit 0' > "$EXPLICIT_CLI"
chmod +x \
  "$PACKAGE_DIRECTORY/codex-queue-demo" \
  "$PACKAGE_DIRECTORY/install-macos.sh" \
  "$PACKAGE_DIRECTORY/uninstall-macos.sh" \
  "$FAKE_BIN_DIRECTORY/codex" \
  "$FAKE_NODE_DIRECTORY/node" \
  "$FAKE_BIN_DIRECTORY/launchctl" \
  "$FAKE_FAILURE_DIRECTORY/ln" \
  "$FAKE_CONCURRENT_DIRECTORY/ln" \
  "$FAKE_SYMLINK_DIRECTORY/ln" \
  "$EXPLICIT_CLI"

print '{"version":1,"launchApp":true,"retryPolicy":{"maxAttempts":4,"initialDelaySeconds":30,"maxDelaySeconds":900},"tasks":[]}' > "$DEFAULT_QUEUE"
cp "$DEFAULT_QUEUE" "$EXPLICIT_QUEUE"

DEFAULT_PLIST="$TEMP_DIRECTORY/default.plist"
HOME="$TEST_HOME" PATH="$FAKE_NODE_DIRECTORY:$FAKE_BIN_DIRECTORY:/usr/bin:/bin:/usr/sbin:/sbin" \
  "$PACKAGE_DIRECTORY/install-macos.sh" \
  --dry-run \
  --output-plist "$DEFAULT_PLIST" \
  --codex-bin "$FAKE_BIN_DIRECTORY/codex" >/dev/null

plutil -lint "$DEFAULT_PLIST" >/dev/null
assert_equal \
  "io.github.baicie.codex-queue.scheduler" \
  "$(plutil -extract Label raw -o - "$DEFAULT_PLIST")" \
  "LaunchAgent label should use the project-owned reverse domain"
assert_equal \
  "$APP_DATA_DIRECTORY/bin/codex-queue-demo" \
  "$(plutil -extract ProgramArguments.0 raw -o - "$DEFAULT_PLIST")" \
  "LaunchAgent should run the installed scheduler CLI"
assert_equal \
  "$DEFAULT_QUEUE" \
  "$(plutil -extract ProgramArguments.3 raw -o - "$DEFAULT_PLIST")" \
  "default queue should match Tauri app_data_dir/queue.json"
assert_equal \
  "1" \
  "$(plutil -extract StartCalendarInterval.Hour raw -o - "$DEFAULT_PLIST")" \
  "LaunchAgent should run at 01:00"
assert_equal \
  "0" \
  "$(plutil -extract StartCalendarInterval.Minute raw -o - "$DEFAULT_PLIST")" \
  "LaunchAgent should run at 01:00"

LAUNCH_PATH="$(plutil -extract EnvironmentVariables.PATH raw -o - "$DEFAULT_PLIST")"
assert_path_contains "$LAUNCH_PATH" "$FAKE_BIN_DIRECTORY" "LaunchAgent PATH should resolve npm Codex and its node interpreter"
assert_path_contains "$LAUNCH_PATH" "$FAKE_NODE_DIRECTORY" "LaunchAgent PATH should include the resolved node interpreter directory"

EXPLICIT_PLIST="$TEMP_DIRECTORY/explicit.plist"
HOME="$TEST_HOME" PATH="$FAKE_NODE_DIRECTORY:$FAKE_BIN_DIRECTORY:/usr/bin:/bin:/usr/sbin:/sbin" \
  "$PACKAGE_DIRECTORY/install-macos.sh" \
  --dry-run \
  --output-plist "$EXPLICIT_PLIST" \
  --cli-bin "$EXPLICIT_CLI" \
  --codex-bin "$FAKE_BIN_DIRECTORY/codex" \
  --queue "$EXPLICIT_QUEUE" >/dev/null

assert_equal \
  "$EXPLICIT_QUEUE" \
  "$(plutil -extract ProgramArguments.3 raw -o - "$EXPLICIT_PLIST")" \
  "explicit queue path should be preserved"

rm "$DEFAULT_QUEUE"
MISSING_QUEUE_STDERR="$TEMP_DIRECTORY/missing-queue.stderr"
if HOME="$TEST_HOME" PATH="$FAKE_FAILURE_DIRECTORY:$FAKE_NODE_DIRECTORY:$FAKE_BIN_DIRECTORY:/usr/bin:/bin:/usr/sbin:/sbin" \
  "$PACKAGE_DIRECTORY/install-macos.sh" \
  --codex-bin "$FAKE_BIN_DIRECTORY/codex" >/dev/null 2>"$MISSING_QUEUE_STDERR"; then
  fail "macOS installer should report a queue initialization failure"
fi
[[ ! -e "$DEFAULT_QUEUE" && ! -L "$DEFAULT_QUEUE" ]] || fail "failed initialization should not create the default queue"
assert_file_contains "Failed to initialize queue: $DEFAULT_QUEUE" "$MISSING_QUEUE_STDERR" "queue initialization failure should identify the missing target"

SYMLINK_QUEUE_STDERR="$TEMP_DIRECTORY/symlink-queue.stderr"
if HOME="$TEST_HOME" PATH="$FAKE_SYMLINK_DIRECTORY:$FAKE_NODE_DIRECTORY:$FAKE_BIN_DIRECTORY:/usr/bin:/bin:/usr/sbin:/sbin" \
  "$PACKAGE_DIRECTORY/install-macos.sh" \
  --codex-bin "$FAKE_BIN_DIRECTORY/codex" >/dev/null 2>"$SYMLINK_QUEUE_STDERR"; then
  fail "macOS installer should reject a symlink created while initializing the queue"
fi
[[ ! -f "$DEFAULT_QUEUE" ]] || fail "failed symlink initialization should not leave a usable default queue"
assert_file_contains "Failed to initialize queue: $DEFAULT_QUEUE" "$SYMLINK_QUEUE_STDERR" "symlink initialization failure should identify the queue target"
rm -f "$DEFAULT_QUEUE"

HOME="$TEST_HOME" PATH="$FAKE_CONCURRENT_DIRECTORY:$FAKE_NODE_DIRECTORY:$FAKE_BIN_DIRECTORY:/usr/bin:/bin:/usr/sbin:/sbin" \
  "$PACKAGE_DIRECTORY/install-macos.sh" \
  --codex-bin "$FAKE_BIN_DIRECTORY/codex" >/dev/null
[[ -f "$DEFAULT_QUEUE" && ! -L "$DEFAULT_QUEUE" ]] || fail "installer should tolerate a concurrently created regular queue file"
assert_equal "false" "$(plutil -extract launchApp raw -o - "$DEFAULT_QUEUE")" "installer should preserve a concurrently created queue"
HOME="$TEST_HOME" PATH="$FAKE_NODE_DIRECTORY:$FAKE_BIN_DIRECTORY:/usr/bin:/bin:/usr/sbin:/sbin" \
  "$PACKAGE_DIRECTORY/uninstall-macos.sh" >/dev/null
rm "$DEFAULT_QUEUE"

LAUNCHCTL_STATE="$TEMP_DIRECTORY/launchctl.state"
HOME="$TEST_HOME" PATH="$FAKE_NODE_DIRECTORY:$FAKE_BIN_DIRECTORY:/usr/bin:/bin:/usr/sbin:/sbin" \
  FAKE_LAUNCHCTL_STATE="$LAUNCHCTL_STATE" \
  "$PACKAGE_DIRECTORY/install-macos.sh" \
  --codex-bin "$FAKE_BIN_DIRECTORY/codex" >/dev/null
[[ -f "$DEFAULT_QUEUE" ]] || fail "macOS installer should initialize a missing default queue"
assert_equal "1" "$(plutil -extract version raw -o - "$DEFAULT_QUEUE")" "initialized queue should use version 1"
assert_equal "true" "$(plutil -extract launchApp raw -o - "$DEFAULT_QUEUE")" "initialized queue should launch Codex"

print '{"version":1,"launchApp":false,"retryPolicy":{"maxAttempts":2,"initialDelaySeconds":5,"maxDelaySeconds":20},"tasks":[]}' > "$DEFAULT_QUEUE"
PRESERVED_QUEUE="$(/bin/cat "$DEFAULT_QUEUE")"
INSTALLED_PLIST="$TEST_HOME/Library/LaunchAgents/io.github.baicie.codex-queue.scheduler.plist"
INSTALLED_BINARY="$APP_DATA_DIRECTORY/bin/codex-queue-demo"
PRESERVED_PLIST="$(/bin/cat "$INSTALLED_PLIST")"
PRESERVED_BINARY="$(/bin/cat "$INSTALLED_BINARY")"
PRESERVED_TASK="$(/bin/cat "$LAUNCHCTL_STATE")"
REGISTERED_DRY_RUN_PLIST="$TEMP_DIRECTORY/registered-dry-run.plist"
HOME="$TEST_HOME" PATH="$FAKE_NODE_DIRECTORY:$FAKE_BIN_DIRECTORY:/usr/bin:/bin:/usr/sbin:/sbin" \
  FAKE_LAUNCHCTL_STATE="$LAUNCHCTL_STATE" \
  "$PACKAGE_DIRECTORY/install-macos.sh" \
  --dry-run \
  --output-plist "$REGISTERED_DRY_RUN_PLIST" \
  --codex-bin "$FAKE_BIN_DIRECTORY/codex" >/dev/null
plutil -lint "$REGISTERED_DRY_RUN_PLIST" >/dev/null
assert_equal "$PRESERVED_BINARY" "$(/bin/cat "$INSTALLED_BINARY")" "dry-run should not replace an installed CLI"
assert_equal "$PRESERVED_PLIST" "$(/bin/cat "$INSTALLED_PLIST")" "dry-run should not replace an installed plist"
assert_equal "$PRESERVED_TASK" "$(/bin/cat "$LAUNCHCTL_STATE")" "dry-run should not modify a registered LaunchAgent"

ALTERNATE_CODEX_DIRECTORY="$TEMP_DIRECTORY/alternate-codex-bin"
ALTERNATE_CODEX="$ALTERNATE_CODEX_DIRECTORY/codex"
LAUNCHCTL_LOG="$TEMP_DIRECTORY/launchctl.log"
mkdir -p "$ALTERNATE_CODEX_DIRECTORY"
print '#!/usr/bin/env node\nprocess.exit(0)' > "$ALTERNATE_CODEX"
print '#!/bin/zsh\nexit 42' > "$PACKAGE_DIRECTORY/codex-queue-demo"
chmod +x "$ALTERNATE_CODEX"
UPGRADE_STDERR="$TEMP_DIRECTORY/upgrade.stderr"
if HOME="$TEST_HOME" \
  PATH="$FAKE_NODE_DIRECTORY:$FAKE_BIN_DIRECTORY:/usr/bin:/bin:/usr/sbin:/sbin" \
  FAKE_LAUNCHCTL_STATE="$LAUNCHCTL_STATE" \
  FAKE_LAUNCHCTL_LOG="$LAUNCHCTL_LOG" \
  "$PACKAGE_DIRECTORY/install-macos.sh" \
  --codex-bin "$ALTERNATE_CODEX" >/dev/null 2>"$UPGRADE_STDERR"; then
  fail "macOS installer should reject an in-place scheduler upgrade"
fi
assert_file_contains "uninstall-macos.sh" "$UPGRADE_STDERR" "upgrade rejection should direct the user to the uninstaller"
assert_file_contains "queue and logs will be preserved" "$UPGRADE_STDERR" "upgrade rejection should explain preserved data"
assert_equal "$PRESERVED_QUEUE" "$(/bin/cat "$DEFAULT_QUEUE")" "rejected upgrade should preserve the queue"
assert_equal "$PRESERVED_BINARY" "$(/bin/cat "$INSTALLED_BINARY")" "rejected upgrade should preserve the installed CLI"
assert_equal "$PRESERVED_PLIST" "$(/bin/cat "$INSTALLED_PLIST")" "rejected upgrade should preserve the LaunchAgent plist"
assert_equal "$PRESERVED_TASK" "$(/bin/cat "$LAUNCHCTL_STATE")" "rejected upgrade should preserve the registered LaunchAgent"
if /usr/bin/grep -Eq 'bootstrap|bootout|enable' "$LAUNCHCTL_LOG"; then
  fail "rejected upgrade should not modify the registered LaunchAgent"
fi

rm "$PACKAGE_DIRECTORY/codex-queue-demo"
[[ -x "$APP_DATA_DIRECTORY/bin/codex-queue-demo" ]] || fail "installed scheduler CLI should survive removal of the release package"

LOG_MARKER="$APP_DATA_DIRECTORY/logs/preserved.log"
print 'keep me' > "$LOG_MARKER"
HOME="$TEST_HOME" PATH="$FAKE_NODE_DIRECTORY:$FAKE_BIN_DIRECTORY:/usr/bin:/bin:/usr/sbin:/sbin" \
  FAKE_LAUNCHCTL_STATE="$LAUNCHCTL_STATE" \
  "$PACKAGE_DIRECTORY/uninstall-macos.sh" >/dev/null
[[ ! -e "$TEST_HOME/Library/LaunchAgents/io.github.baicie.codex-queue.scheduler.plist" ]] || fail "macOS uninstaller should remove the LaunchAgent plist"
[[ ! -e "$APP_DATA_DIRECTORY/bin/codex-queue-demo" ]] || fail "macOS uninstaller should remove the installed scheduler CLI"
[[ ! -e "$LAUNCHCTL_STATE" ]] || fail "macOS uninstaller should unregister the LaunchAgent"
[[ -f "$DEFAULT_QUEUE" ]] || fail "macOS uninstaller should preserve the queue"
[[ -f "$LOG_MARKER" ]] || fail "macOS uninstaller should preserve logs"

assert_file_contains '[Environment+SpecialFolder]::ApplicationData' "$REPOSITORY_ROOT/scripts/install-windows.ps1" "Windows installer should use roaming ApplicationData"
assert_file_contains "AppIdentifier = 'io.github.baicie.codex-queue'" "$REPOSITORY_ROOT/scripts/install-windows.ps1" "Windows installer should use the Tauri app identifier"
assert_file_contains "\$QueuePath = Join-Path \$appDataDirectory 'queue.json'" "$REPOSITORY_ROOT/scripts/install-windows.ps1" "Windows default queue should match Tauri app_data_dir/queue.json"
assert_file_contains '[string]$CliBin' "$REPOSITORY_ROOT/scripts/install-windows.ps1" "Windows installer should accept an explicit CLI path"
assert_file_contains 'ExportTaskXml' "$REPOSITORY_ROOT/scripts/install-windows.ps1" "Windows installer should support verifiable task XML generation"
assert_file_contains '01:00' "$REPOSITORY_ROOT/scripts/install-windows.ps1" "Windows schedule should remain at 01:00"
assert_file_contains "SetAttribute('version', '1.3')" "$REPOSITORY_ROOT/scripts/install-windows.ps1" "Windows task XML should use the version fixed by the official schema"
assert_file_contains '[System.IO.FileMode]::CreateNew' "$REPOSITORY_ROOT/scripts/install-windows.ps1" "Windows default queue initialization should create a unique temporary file without overwriting"
assert_file_contains '$Stream.Flush($true)' "$REPOSITORY_ROOT/scripts/install-windows.ps1" "Windows default queue initialization should durably flush the complete temporary file"
assert_file_contains '[System.IO.File]::Move($SourcePath, $DestinationPath)' "$REPOSITORY_ROOT/scripts/install-windows.ps1" "Windows default queue initialization should atomically publish without overwriting"
assert_file_contains 'Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue' "$REPOSITORY_ROOT/scripts/install-windows.ps1" "Windows installer should detect an existing registered task"
assert_file_contains 'uninstall-windows.ps1' "$REPOSITORY_ROOT/scripts/install-windows.ps1" "Windows upgrade rejection should direct the user to the uninstaller"
WINDOWS_GUARD_LINE="$(/usr/bin/grep -nF 'Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue' "$REPOSITORY_ROOT/scripts/install-windows.ps1" | /usr/bin/head -n 1 | /usr/bin/cut -d: -f1)"
WINDOWS_BINARY_WRITE_LINE="$(/usr/bin/grep -nF 'Copy-Item -LiteralPath $sourceBinary -Destination $installedBinary' "$REPOSITORY_ROOT/scripts/install-windows.ps1" | /usr/bin/head -n 1 | /usr/bin/cut -d: -f1)"
WINDOWS_RUNNER_WRITE_LINE="$(/usr/bin/grep -nF 'Set-Content -LiteralPath $runnerPath' "$REPOSITORY_ROOT/scripts/install-windows.ps1" | /usr/bin/head -n 1 | /usr/bin/cut -d: -f1)"
WINDOWS_TASK_WRITE_LINE="$(/usr/bin/grep -nF 'Register-ScheduledTask -TaskName $TaskName' "$REPOSITORY_ROOT/scripts/install-windows.ps1" | /usr/bin/head -n 1 | /usr/bin/cut -d: -f1)"
(( WINDOWS_GUARD_LINE < WINDOWS_BINARY_WRITE_LINE &&
  WINDOWS_GUARD_LINE < WINDOWS_RUNNER_WRITE_LINE &&
  WINDOWS_GUARD_LINE < WINDOWS_TASK_WRITE_LINE )) ||
  fail "Windows installer should reject an existing task before writing scheduler files or registration"
if /usr/bin/grep -Fq 'Register-ScheduledTask -TaskName $TaskName -Xml $taskXml -Force' "$REPOSITORY_ROOT/scripts/install-windows.ps1"; then
  fail "Windows installer should not force-overwrite a concurrently registered task"
fi
assert_file_contains 'codex-queue-demo.exe' "$REPOSITORY_ROOT/scripts/uninstall-windows.ps1" "Windows uninstaller should remove the installed scheduler CLI"
assert_file_contains 'run-queue.ps1' "$REPOSITORY_ROOT/scripts/uninstall-windows.ps1" "Windows uninstaller should remove the installed runner"

print "Scheduler script checks passed."
