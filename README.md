# Codex Queue

Codex Queue 是一个面向 macOS 和 Windows 11 的 Tauri 桌面任务队列。桌面端使用 React、Vite 和 shadcn/ui，默认显示中文并支持英文、浅色和深色主题；Rust 内核负责校验队列、解析依赖、按顺序执行任务，以及在网络或 API 暂时不可用时进行指数退避重试。

这个项目提供两个入口，但共用同一份队列格式和 Rust 执行内核：

- **桌面 UI**：查看、编辑和手动运行队列，适合日常交互操作。
- **CLI + 系统调度器**：每天本地时间 01:00 自动拉起 Codex 并运行队列，适合无人值守任务。

Tauri UI 不承担后台定时唤醒。即使桌面窗口关闭，已安装的 macOS LaunchAgent 或 Windows Task Scheduler 任务仍会通过 CLI 执行队列。

## 功能

- 按 `priority` 降序、`createdAt` 升序、`id` 升序选择当前可执行任务。
- 只在全部 `dependsOn` 任务成功后执行依赖任务。
- 依赖失败时将下游任务标记为 `blocked`，同时继续处理互不依赖的任务。
- 将 `running`、`succeeded`、`failed` 和 `blocked` 状态持久化到 JSON 队列。
- 使用文件锁阻止桌面端、CLI 或定时任务重复执行同一队列。
- 在 macOS 通过 bundle ID 打开 Codex Desktop，在 Windows 通过 `codex app <workspace>` 打开工作区。
- 通过标准输入调用 `codex exec` 执行任务；`codex app` 和 `codex exec` 是本 Demo 使用的 Codex CLI 命令契约。
- 将每次执行的事件、标准错误和最终结果保存到 `runs/`。
- 对网络、限流和暂时性 API 错误使用有上限的指数退避。
- 为每次 `codex exec` 设置 45 分钟上限；超时会终止并回收子进程，再按暂时性错误重试。
- 桌面端保存时校验队列 revision，拒绝用旧 UI 快照覆盖调度器刚写入的执行结果。
- 无人值守执行固定使用 `workspace-write` sandbox 和 `never` approval mode。

## 架构

```text
React + Vite + shadcn/ui
          |
          | Tauri commands
          v
   src-tauri (desktop adapter) ----> native file dialog / app data
          |
          v
   Rust queue core <--------------- CLI / OS scheduler at 01:00
          |
          +----> queue.json + file lock
          +----> Codex Desktop + Codex CLI
          +----> runs/<task>/<attempt>/
```

主要目录：

| 路径              | 职责                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| `src/`            | React UI、国际化、主题和 Tauri 前端桥接；Rust 根 crate 同时位于该目录 |
| `src-tauri/`      | Tauri v2 应用、commands、capabilities 和桌面配置                      |
| `tests/`          | 队列契约、CLI 和 worker 行为测试                                      |
| `scripts/`        | macOS LaunchAgent 与 Windows Task Scheduler 安装脚本                  |
| `demo/queue.json` | 可用于 dry-run 的示例队列                                             |

## 环境要求

- 运行桌面应用或 scheduler：已登录且可从 `PATH` 调用的 Codex CLI。
- 当队列设置 `launchApp: true` 时，当前用户需要安装 Codex Desktop。
- 从源码开发：Node.js 24、npm 和 Rust 1.88；crate 清单和 CI 均固定使用这个 MSRV。
- macOS 需要 Xcode Command Line Tools；Windows 11 需要 Microsoft C++ Build Tools 和 WebView2。完整平台依赖参见 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。

## 桌面端开发

安装锁定版本的前端依赖并启动 Tauri：

```bash
npm ci
npm run tauri dev
```

仅启动浏览器前端：

```bash
npm run dev
```

浏览器模式用于 UI 开发；文件对话框、应用数据目录和真实队列执行等原生能力需要在 Tauri 窗口中验证。支持 Web Locks API 时，浏览器模式会跨标签页串行化队列保存；不支持该 API 的开发浏览器仅保证单标签页内的 revision 冲突保护。

常用质量检查：

```bash
npm run format:check
npm run lint
npm test
npm run build
cargo fmt --all -- --check
cargo test --locked --workspace --all-targets
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
```

构建当前平台的安装包：

```bash
npm run tauri build
```

workspace 构建产物位于 `target/release/bundle/`。

## CLI 使用

构建 CLI 并预览执行计划；dry-run 不会启动 Codex，也不会修改队列：

```bash
cargo build --locked --release --package codex-queue-demo
./target/release/codex-queue-demo run --queue demo/queue.json --dry-run
```

示例计划：

```text
Plan: independent-priority -> environment-check -> dependent-finish
```

macOS 实际执行：

```bash
./target/release/codex-queue-demo run --queue demo/queue.json
```

Windows 11 实际执行：

```powershell
.\target\release\codex-queue-demo.exe run --queue .\demo\queue.json
```

如果后台任务的 `PATH` 中没有 `codex`，设置 `CODEX_BIN` 或传入 `--codex-bin`。调度器安装脚本会解析并保存 Codex CLI 的绝对路径，因为后台任务不会继承交互式 shell 配置。

## 每日 01:00 调度

GitHub Release 中的 `codex-queue-scheduler-*.zip` 已包含当前平台的 CLI 和安装脚本。下载与机器架构匹配的 ZIP、核对 `SHA256SUMS` 并解压后，可直接安装当前用户的系统任务，不需要 Rust。源码开发者也可以先运行上面的 CLI release 构建，再使用仓库内脚本。

默认队列与 Tauri UI 使用同一 app-data 文件：macOS 为 `~/Library/Application Support/io.github.baicie.codex-queue/queue.json`，Windows 为 `%APPDATA%\io.github.baicie.codex-queue\queue.json`。安装器会把 scheduler CLI 复制到稳定的用户数据目录，在默认文件缺失时初始化空队列，并保留已有队列内容。

安装器不会原地覆盖已安装的 scheduler。升级时先运行对应平台的卸载脚本，再安装新版本；卸载会保留队列和运行日志。

macOS LaunchAgent：

```bash
# Release ZIP 解压目录
./install-macos.sh --dry-run
./install-macos.sh

# 源码仓库，可选自定义队列
./scripts/install-macos.sh --dry-run
./scripts/install-macos.sh --queue ./demo/queue.json
```

Windows 11 Task Scheduler：

```powershell
# Release ZIP 解压目录
.\install-windows.ps1 -WhatIf
.\install-windows.ps1

# 源码仓库，可选自定义队列
.\scripts\install-windows.ps1 -WhatIf
.\scripts\install-windows.ps1 -QueuePath .\demo\queue.json
```

上例通过 `--queue` / `-QueuePath` 改用 `demo/queue.json`；省略参数即可使用 app-data 默认队列。两个安装器都按本地时间每天 01:00 运行，并禁止重叠执行。Windows 使用 `Interactive` 登录模式，因为 `launchApp: true` 需要当前用户的桌面会话和 Codex 登录状态；支持时会请求 wake timer。macOS LaunchAgent 会在 Mac 唤醒后补跑错过的日历事件。

卸载调度器会保留队列和运行日志：

```bash
./uninstall-macos.sh
```

```powershell
.\uninstall-windows.ps1
```

## 重试策略

队列级策略示例：

```json
{
  "retryPolicy": {
    "maxAttempts": 4,
    "initialDelaySeconds": 30,
    "maxDelaySeconds": 900
  }
}
```

`maxAttempts` 包含第一次执行。以上配置在连续发生暂时性错误后等待 30、60、120 秒，每次翻倍并受 `maxDelaySeconds` 限制。旧队列未配置该字段时使用相同默认值。某个任务等待重试期间，依赖已经满足的其他任务仍会继续执行；只有没有可运行任务时 worker 才会等待。

可重试错误包括 HTTP 408、409、425、429、5xx，以及 Codex 报告的连接、DNS、超时、限流、过载和流中断错误。单次 `codex exec` 超过 45 分钟时，worker 会终止并回收子进程，将该次尝试记录为暂时性超时后进入相同的退避流程。认证失败、无效 API key、额度耗尽、未知错误和任务自身失败不会重试。

每次等待前，worker 会原子写入错误与 `nextRetryAt`。进程中断后，下次运行只等待剩余时间并继续相同的尝试序列。该模型提供 at-least-once execution，因此 prompt 必须可重复执行：先检查 workspace 当前状态，并避免重复执行不可逆的外部操作。

参数约束：`maxAttempts` 为 1-20；延迟必须为正数；`maxDelaySeconds` 不得小于初始延迟，也不得超过 86,400 秒。

## CI 与自动 Release

`.github/workflows/ci.yml` 在 main push、pull request 和手动触发时执行：

- 前端 format、lint、Vitest 和生产构建。
- npm 与 RustSec 依赖安全审计。
- Rust workspace format、tests 和 Clippy，并在 Windows 运行真实 workspace tests。
- GitHub Actions workflow lint。
- macOS 与 Windows 上的 Tauri backend check、原生应用构建和调度脚本验证。

推送与应用版本一致的 `v*` tag 会触发 `.github/workflows/release.yml`：

```bash
git tag v0.2.0
git push origin v0.2.0
```

Release workflow 只接受位于 `main` 历史上的 tag，并在任何发布构建开始前重新执行完整的前端、Rust 和调度脚本质量门。质量门通过后会生成：

- macOS Apple Silicon (`aarch64`) DMG 和 scheduler ZIP。
- macOS Intel (`x86_64`) DMG 和 scheduler ZIP。
- Windows x64 MSI、NSIS installer 和 scheduler ZIP。
- 覆盖全部安装包与 scheduler ZIP 的 `SHA256SUMS`。

每个 scheduler ZIP 都包含对应平台的预编译 CLI、安装/卸载脚本和 MIT License。Workflow 会先核对预期资产并验证校验和，再发布 GitHub Release；所有第三方 Actions 都固定到经过审计的完整 commit SHA。

当前不构建 Linux 安装包。发布前需要同步更新 `package.json`、`Cargo.toml`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 中的版本。

## 安装包签名说明

自动 Release 是演示用途，不包含受信任的 Windows 代码签名证书、Apple Developer ID 签名或 Apple notarization：

- macOS 构建使用 ad-hoc identity `-`，以满足 Apple Silicon 对互联网下载应用的基本签名要求，但 Gatekeeper 仍可能提示来源不明。请从仓库 Release 下载，并通过“系统设置 > 隐私与安全性”确认打开。参见 [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)。
- Windows 安装包未签名，Microsoft Defender SmartScreen 可能显示未知发布者警告。请只运行从本仓库 Release 获取并核对版本的文件。参见 [Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows/)。

面向真实用户分发前，应配置正式证书、macOS notarization 和对应 GitHub Secrets。

## Demo 限制

- 机器完全关机时无法在 01:00 执行。Windows wake timer 取决于硬件和电源设置；macOS 会在唤醒后补跑。
- macOS LaunchAgent 需要用户已登录；Windows 任务也按设计要求交互式会话。
- Windows Task Scheduler 会在四小时后停止任务。中断的 `running` 任务会在仍有尝试次数时于下次调用恢复；最后一次尝试被中断则标记为 `failed`。
- 本 Demo 选择操作系统调度器，使 Tauri UI 未运行时仍可启动 scheduler CLI；任务执行仍要求当前用户的 Codex CLI 登录状态有效。
- JSON 加文件锁适合单 worker demo。生产多 worker 队列应使用带 lease 和 idempotency key 的 SQLite 或服务端数据库。
- 重跑示例队列前，需要将状态重置为 `pending`，并移除 `attempts`、`startedAt`、`finishedAt`、`lastError` 和 `nextRetryAt`。

## License

[MIT](LICENSE)
