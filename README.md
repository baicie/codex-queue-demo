# Codex Queue Demo

A small Rust worker that opens Codex and then executes a dependency-aware JSON task queue. The same source and CLI compile to native macOS and Windows 11 binaries; only the operating-system scheduler registration differs.

## Behavior

- Runs pending tasks sequentially.
- Selects currently runnable tasks by `priority` descending, `createdAt` ascending, then `id`.
- Executes a task only after all `dependsOn` tasks succeed.
- Marks dependent tasks `blocked` when a dependency fails, while continuing independent work.
- Persists `running`, `succeeded`, `failed`, and `blocked` states in the queue file.
- Uses a file lock to prevent overlapping workers.
- Opens the existing `com.openai.codex` app bundle on macOS instead of invoking the CLI installer path.
- Sends prompts to `codex exec` over stdin and stores each attempt under `runs/`.
- Uses `workspace-write` sandboxing and `never` approval mode for unattended runs.

## Build And Try

Requirements: Rust 1.85 or newer and an authenticated Codex CLI available on `PATH`. Queues with `launchApp: true` also require Codex Desktop to be installed for the current user.

```bash
cargo build --release
./target/release/codex-queue-demo run --queue demo/queue.json --dry-run
```

Expected plan:

```text
Plan: independent-priority -> environment-check -> dependent-finish
```

Run the real queue on macOS:

```bash
./target/release/codex-queue-demo run --queue demo/queue.json
```

Run it on Windows 11:

```powershell
.\target\release\codex-queue-demo.exe run --queue .\demo\queue.json
```

Set `CODEX_BIN` or pass `--codex-bin` when `codex` is not on your interactive `PATH`. The scheduler installers resolve and persist the Codex CLI's absolute path because background jobs do not inherit shell configuration.

## Schedule At 01:00

macOS LaunchAgent, for the current logged-in user:

```bash
./scripts/install-macos.sh --dry-run
./scripts/install-macos.sh --queue ./demo/queue.json
```

Windows 11 Task Scheduler, for the current logged-in user:

```powershell
.\scripts\install-windows.ps1 -WhatIf
.\scripts\install-windows.ps1 -QueuePath .\demo\queue.json
```

The Windows task uses `Interactive` logon because `launchApp: true` needs a desktop session and the current user's Codex authentication. Both installers use local time and prevent overlapping execution. Windows requests a wake timer when supported; a macOS LaunchAgent runs a missed calendar event after the Mac wakes.

## Limits Of This Demo

- A powered-off machine cannot run at 01:00. Windows wake timers depend on hardware and power settings; macOS runs the missed job after the machine wakes.
- macOS LaunchAgents require the user to be logged in. The Windows task is also interactive by design.
- Windows Task Scheduler stops a run after four hours. An interrupted `running` task is recovered and retried at the next invocation.
- Built-in Codex scheduled tasks cannot launch Codex after the app has been fully closed, so this demo uses the OS scheduler.
- JSON plus a file lock is sufficient for this single-worker demo. A production multi-worker queue should use SQLite or a server database with leases and idempotency keys.
- Reset task statuses to `pending` before rerunning the sample queue.
