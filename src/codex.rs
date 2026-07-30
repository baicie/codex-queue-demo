use std::env;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
#[cfg(windows)]
use process_wrap::std::CommandWrapper;
#[cfg(windows)]
use process_wrap::std::JobObject;
#[cfg(unix)]
use process_wrap::std::ProcessGroup;
use process_wrap::std::{ChildWrapper, CommandWrap};

use crate::{QueueRunner, Task, TransientTaskError};

// Four 45-minute attempts plus the default backoff fit below the scheduler's
// four-hour Windows limit, while each attempt can still handle substantial work.
const DEFAULT_EXECUTION_TIMEOUT: Duration = Duration::from_secs(45 * 60);
const CLI_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(25);

pub struct CodexCli {
    binary: OsString,
    execution_timeout: Duration,
}

impl CodexCli {
    pub fn new(binary: impl Into<OsString>) -> Self {
        Self::with_timeout(binary, DEFAULT_EXECUTION_TIMEOUT)
    }

    /// Creates a Codex runner with a custom timeout for each `codex exec` process.
    pub fn with_timeout(binary: impl Into<OsString>, execution_timeout: Duration) -> Self {
        Self {
            binary: binary.into(),
            execution_timeout,
        }
    }

    /// Resolves and verifies the Codex CLI before a queue can mutate task state.
    pub fn discover(explicit: Option<OsString>) -> Result<Self> {
        let search_path = env::var_os("PATH");
        let explicit = explicit
            .filter(|value| !value.is_empty())
            .or_else(|| env::var_os("CODEX_BIN").filter(|value| !value.is_empty()));
        let binary = select_codex_binary(
            explicit,
            search_path.as_deref(),
            &default_codex_candidates(),
            probe_codex_binary,
        )?;
        Ok(Self::new(binary))
    }
}

impl Default for CodexCli {
    fn default() -> Self {
        let search_path = env::var_os("PATH");
        let binary = select_codex_binary(
            env::var_os("CODEX_BIN"),
            search_path.as_deref(),
            &default_codex_candidates(),
            |_| Ok(()),
        )
        .unwrap_or_else(|_| default_codex_command());
        Self::new(binary)
    }
}

fn select_codex_binary(
    explicit: Option<OsString>,
    search_path: Option<&OsStr>,
    fallback_candidates: &[PathBuf],
    mut probe: impl FnMut(&OsStr) -> Result<()>,
) -> Result<OsString> {
    if let Some(explicit) = explicit.filter(|value| !value.is_empty()) {
        probe(&explicit)
            .with_context(|| format!("Codex CLI is not runnable: {:?}", Path::new(&explicit)))?;
        return Ok(explicit);
    }

    let mut candidates = find_codex_on_path(search_path);
    candidates.extend(
        fallback_candidates
            .iter()
            .filter(|candidate| is_executable_file(candidate))
            .cloned(),
    );
    let mut last_failure = None;
    for candidate in candidates {
        match probe(candidate.as_os_str()) {
            Ok(()) => return Ok(candidate.into_os_string()),
            Err(error) => last_failure = Some((candidate, error)),
        }
    }

    if let Some((candidate, error)) = last_failure {
        bail!(
            "Codex CLI is not runnable: {}: {error:#}. Choose a working CLI in queue settings",
            candidate.display()
        );
    }
    bail!(
        "Codex CLI was not found. Install Codex CLI or set an absolute Codex CLI path in queue settings"
    )
}

fn find_codex_on_path(search_path: Option<&OsStr>) -> Vec<PathBuf> {
    let Some(search_path) = search_path else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    for directory in env::split_paths(search_path) {
        for command in codex_command_names() {
            let candidate = directory.join(command);
            if is_executable_file(&candidate) {
                candidates.push(candidate);
            }
        }
    }
    candidates
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(windows)]
    {
        true
    }
}

fn default_codex_command() -> OsString {
    if cfg!(windows) {
        OsString::from("codex.cmd")
    } else {
        OsString::from("codex")
    }
}

fn probe_codex_binary(binary: &OsStr) -> Result<()> {
    let mut command = Command::new(binary);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = spawn_command_group(command)
        .with_context(|| format!("failed to start {:?}", Path::new(binary)))?;
    let mut child = SpawnedChildGuard::new(child);
    let status = wait_for_exit(child.child_mut(), CLI_PROBE_TIMEOUT)
        .context("failed while checking the Codex CLI")?;
    let Some(status) = status else {
        child
            .terminate_and_reap()
            .context("failed to stop the Codex CLI check")?;
        bail!("Codex CLI check timed out after {CLI_PROBE_TIMEOUT:?}");
    };
    child
        .terminate_and_reap()
        .context("failed to clean up the Codex CLI check")?;

    if status.success() {
        Ok(())
    } else {
        bail!("`codex --version` exited with status {status}")
    }
}

#[cfg(windows)]
fn codex_command_names() -> &'static [&'static str] {
    &["codex.exe", "codex.cmd", "codex.bat"]
}

#[cfg(not(windows))]
fn codex_command_names() -> &'static [&'static str] {
    &["codex"]
}

fn default_codex_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = env::var_os("HOME").filter(|value| !value.is_empty()) {
            let home = PathBuf::from(home);
            candidates.push(home.join(".local/bin/codex"));
            candidates.push(home.join("Applications/ChatGPT.app/Contents/Resources/codex"));
            candidates.push(home.join("Applications/Codex.app/Contents/Resources/codex"));
        }
        candidates.push(PathBuf::from(
            "/Applications/ChatGPT.app/Contents/Resources/codex",
        ));
        candidates.push(PathBuf::from(
            "/Applications/Codex.app/Contents/Resources/codex",
        ));
    }

    #[cfg(windows)]
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA").filter(|value| !value.is_empty()) {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Programs/OpenAI/Codex/bin")
                .join("codex.exe"),
        );
    }

    candidates
}

impl QueueRunner for CodexCli {
    fn launch_app(&mut self, workspace: &Path) -> Result<()> {
        let app_command = build_app_command(self.binary.clone(), workspace);
        let status = Command::new(&app_command.program)
            .args(&app_command.arguments)
            .status()
            .with_context(|| format!("failed to start {:?}", app_command.program))?;

        if !status.success() {
            bail!("Codex app launcher exited with status {status}");
        }
        Ok(())
    }

    fn execute_task(&mut self, task: &Task, workspace: &Path, run_directory: &Path) -> Result<()> {
        execute_task_with_spawn(
            &self.binary,
            self.execution_timeout,
            task,
            workspace,
            run_directory,
            spawn_command_group,
        )
    }

    fn wait_before_retry(&mut self, delay: Duration) {
        eprintln!(
            "Waiting {} seconds before retrying the Codex task.",
            delay.as_secs()
        );
        thread::sleep(delay);
    }
}

fn execute_task_with_spawn(
    binary: &OsString,
    execution_timeout: Duration,
    task: &Task,
    workspace: &Path,
    run_directory: &Path,
    spawn: impl FnOnce(Command) -> io::Result<Box<dyn ChildWrapper>>,
) -> Result<()> {
    let final_output = run_directory.join("final.txt");
    let events_output = run_directory.join("events.jsonl");
    let stderr_output = run_directory.join("stderr.log");
    let events_file = File::create(&events_output)
        .with_context(|| format!("failed to create {}", events_output.display()))?;
    let stderr_file = File::create(&stderr_output)
        .with_context(|| format!("failed to create {}", stderr_output.display()))?;
    let mut command = Command::new(binary);
    command
        .arg("-a")
        .arg("never")
        .arg("exec")
        .arg("--json")
        .arg("--ephemeral")
        .arg("--skip-git-repo-check")
        .arg("--sandbox")
        .arg("workspace-write")
        .arg("-C")
        .arg(workspace)
        .arg("-o")
        .arg(&final_output)
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(events_file))
        .stderr(Stdio::from(stderr_file));
    let child = spawn(command).with_context(|| format!("failed to start {binary:?}"))?;
    let mut child = SpawnedChildGuard::new(child);

    let mut stdin = child
        .child_mut()
        .stdin()
        .take()
        .context("Codex stdin is unavailable")?;
    let prompt = task.prompt.clone();
    let stdin_writer = thread::spawn(move || -> Result<()> {
        stdin
            .write_all(prompt.as_bytes())
            .context("failed to send task prompt to Codex")?;
        stdin
            .write_all(b"\n")
            .context("failed to terminate task prompt")?;
        Ok(())
    });

    let status = wait_for_exit(child.child_mut(), execution_timeout)
        .context("failed while waiting for Codex")?;
    let Some(status) = status else {
        let cleanup_error = child.terminate_and_reap().err();
        if cleanup_error.is_none() {
            let _ = join_stdin_writer(stdin_writer);
        }
        return Err(timeout_error(execution_timeout, cleanup_error));
    };
    child
        .terminate_and_reap()
        .context("failed to clean up the Codex process tree")?;
    let stdin_result = join_stdin_writer(stdin_writer);

    let stdout = fs::read(&events_output).context("failed to read Codex event log")?;
    let stderr = fs::read(&stderr_output).context("failed to read Codex stderr log")?;

    if !status.success() {
        let stderr_text = String::from_utf8_lossy(&stderr);
        let terminal_error = terminal_failure_message(&stdout);
        let details = if let Some(error) = terminal_error.as_deref() {
            error
        } else if !stderr_text.trim().is_empty() {
            stderr_text.trim()
        } else {
            "see events.jsonl for details"
        };
        let message = format!("codex exec exited with status {status}: {details}");
        if is_transient_codex_failure(&stdout, &stderr) {
            return Err(TransientTaskError::new(message).into());
        }
        bail!("{message}");
    }
    stdin_result?;
    Ok(())
}

fn spawn_command_group(command: Command) -> io::Result<Box<dyn ChildWrapper>> {
    let mut command = CommandWrap::from(command);

    #[cfg(windows)]
    {
        command.wrap(SpawnCleanup);
        command.wrap(JobObject);
    }

    #[cfg(unix)]
    command.wrap(ProcessGroup::leader());

    command.spawn()
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug)]
struct SpawnCleanup;

#[cfg(windows)]
impl CommandWrapper for SpawnCleanup {
    fn wrap_child(
        &mut self,
        child: Box<dyn ChildWrapper>,
        _command: &CommandWrap,
    ) -> io::Result<Box<dyn ChildWrapper>> {
        Ok(Box::new(SpawnCleanupChild::new(child)))
    }
}

#[cfg(any(windows, test))]
#[derive(Debug)]
struct SpawnCleanupChild {
    child: Option<Box<dyn ChildWrapper>>,
    armed: bool,
}

#[cfg(any(windows, test))]
impl SpawnCleanupChild {
    fn new(child: Box<dyn ChildWrapper>) -> Self {
        Self {
            child: Some(child),
            armed: true,
        }
    }

    fn child(&self) -> &dyn ChildWrapper {
        self.child.as_deref().expect("spawn cleanup child exists")
    }

    fn child_mut(&mut self) -> &mut dyn ChildWrapper {
        self.child
            .as_deref_mut()
            .expect("spawn cleanup child exists")
    }
}

#[cfg(any(windows, test))]
impl ChildWrapper for SpawnCleanupChild {
    fn inner(&self) -> &dyn ChildWrapper {
        self.child().inner()
    }

    fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
        self.child_mut().inner_mut()
    }

    fn into_inner(mut self: Box<Self>) -> Box<dyn ChildWrapper> {
        self.armed = false;
        self.child.take().expect("spawn cleanup child exists")
    }

    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.child_mut().try_wait()?;
        if status.is_some() {
            self.armed = false;
        }
        Ok(status)
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        let status = self.child_mut().wait()?;
        self.armed = false;
        Ok(status)
    }
}

#[cfg(any(windows, test))]
impl Drop for SpawnCleanupChild {
    fn drop(&mut self) {
        if self.armed
            && let Some(child) = self.child.as_deref_mut()
        {
            let _ = terminate_and_reap(child);
        }
    }
}

struct SpawnedChildGuard {
    child: Box<dyn ChildWrapper>,
    armed: bool,
}

impl SpawnedChildGuard {
    fn new(child: Box<dyn ChildWrapper>) -> Self {
        Self { child, armed: true }
    }

    fn child_mut(&mut self) -> &mut dyn ChildWrapper {
        self.child.as_mut()
    }

    fn terminate_and_reap(&mut self) -> Result<()> {
        let result = terminate_and_reap(self.child.as_mut());
        if result.is_ok() {
            self.disarm();
        }
        result
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for SpawnedChildGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = terminate_and_reap(self.child.as_mut());
        }
    }
}

fn wait_for_exit(
    child: &mut dyn ChildWrapper,
    timeout: Duration,
) -> io::Result<Option<ExitStatus>> {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }

        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return Ok(None);
        }
        thread::sleep(PROCESS_POLL_INTERVAL.min(timeout - elapsed));
    }
}

fn terminate_and_reap(child: &mut dyn ChildWrapper) -> Result<()> {
    if let Err(kill_error) = child.start_kill() {
        match child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) => return Err(kill_error).context("failed to kill Codex process"),
            Err(wait_error) => {
                bail!(
                    "failed to kill Codex process: {kill_error}; failed to inspect it afterward: {wait_error}"
                );
            }
        }
    }
    child.wait().context("failed to reap Codex process")?;
    Ok(())
}

fn timeout_error(
    execution_timeout: Duration,
    cleanup_error: Option<anyhow::Error>,
) -> anyhow::Error {
    let timeout_message = format!("codex exec timed out after {execution_timeout:?}");
    if let Some(error) = cleanup_error {
        anyhow::anyhow!("{timeout_message}; failed to clean up the process: {error:#}")
    } else {
        TransientTaskError::new(timeout_message).into()
    }
}

fn join_stdin_writer(writer: JoinHandle<Result<()>>) -> Result<()> {
    match writer.join() {
        Ok(result) => result,
        Err(_) => bail!("Codex stdin writer panicked"),
    }
}

fn is_transient_codex_failure(stdout: &[u8], stderr: &[u8]) -> bool {
    if let Some(message) = terminal_failure_message(stdout) {
        return !is_permanent_message(&message) && is_transient_message(&message);
    }

    let stderr = String::from_utf8_lossy(stderr);
    !is_permanent_message(&stderr) && is_transient_message(&stderr)
}

fn terminal_failure_message(stdout: &[u8]) -> Option<String> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter_map(|line| {
            let event = serde_json::from_str::<serde_json::Value>(line).ok()?;
            if event.get("type")?.as_str()? != "turn.failed" {
                return None;
            }
            event.pointer("/error/message")?.as_str().map(str::to_owned)
        })
        .next_back()
}

fn is_permanent_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();

    const PERMANENT_MARKERS: &[&str] = &[
        "billing hard limit",
        "exceeded your current quota",
        "insufficient_quota",
        "invalid api key",
        "invalid authentication",
        "invalid_api_key",
        "quota exceeded",
    ];
    PERMANENT_MARKERS
        .iter()
        .any(|marker| message.contains(marker))
}

fn is_transient_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();

    const TRANSIENT_MARKERS: &[&str] = &[
        "bad gateway",
        "connection aborted",
        "connection closed",
        "connection refused",
        "connection reset",
        "dns error",
        "error sending request",
        "failed to resolve",
        "gateway timeout",
        "internal server error",
        "network error",
        "rate limit",
        "server overloaded",
        "service unavailable",
        "stream disconnected",
        "temporarily unavailable",
        "timed out",
        "timeout",
        "too many requests",
        "transport error",
    ];
    if TRANSIENT_MARKERS
        .iter()
        .any(|marker| message.contains(marker))
    {
        return true;
    }

    contains_transient_status(&message)
}

fn contains_transient_status(message: &str) -> bool {
    let tokens = message
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();

    tokens.iter().enumerate().any(|(index, token)| {
        let Ok(status) = token.parse::<u16>() else {
            return false;
        };
        if !matches!(status, 408 | 409 | 425 | 429 | 500..=599) {
            return false;
        }

        let context = &tokens[index.saturating_sub(3)..index];
        context.ends_with(&["http"])
            || context.ends_with(&["status"])
            || context.ends_with(&["status", "code"])
            || context.ends_with(&["response", "code"])
            || context.ends_with(&["response", "status"])
            || context.ends_with(&["api", "error"])
            || context.ends_with(&["http", "1", "1"])
            || context.ends_with(&["http", "2"])
    })
}

struct AppCommand {
    program: OsString,
    arguments: Vec<OsString>,
}

#[cfg(target_os = "macos")]
fn build_app_command(_codex_binary: OsString, workspace: &Path) -> AppCommand {
    AppCommand {
        program: OsString::from("/usr/bin/open"),
        arguments: vec![
            OsString::from("-b"),
            OsString::from("com.openai.codex"),
            workspace.as_os_str().to_owned(),
        ],
    }
}

#[cfg(not(target_os = "macos"))]
fn build_app_command(codex_binary: OsString, workspace: &Path) -> AppCommand {
    AppCommand {
        program: codex_binary,
        arguments: vec![OsString::from("app"), workspace.as_os_str().to_owned()],
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use std::ffi::OsString;
    use std::path::Path;

    use super::build_app_command;

    #[test]
    fn launches_the_existing_codex_bundle_on_macos() {
        let command = build_app_command(OsString::from("codex"), Path::new("/tmp/project"));

        assert_eq!(command.program, OsString::from("/usr/bin/open"));
        assert_eq!(
            command.arguments,
            vec![
                OsString::from("-b"),
                OsString::from("com.openai.codex"),
                OsString::from("/tmp/project")
            ]
        );
    }
}

#[cfg(test)]
mod binary_resolution_tests {
    use std::env;
    use std::fs;
    use std::thread;
    use std::time::Duration;

    use tempfile::TempDir;

    use super::{probe_codex_binary, select_codex_binary};

    #[test]
    fn finds_an_installed_cli_when_the_gui_path_has_no_codex() {
        let temp = TempDir::new().expect("temp directory");
        let binary = temp
            .path()
            .join(format!("codex{}", env::consts::EXE_SUFFIX));
        fs::write(&binary, b"test binary").expect("fake Codex CLI");
        make_executable(&binary);
        let restricted_path =
            env::join_paths([temp.path().join("missing")]).expect("restricted PATH");

        let resolved = select_codex_binary(
            None,
            Some(&restricted_path),
            std::slice::from_ref(&binary),
            |candidate| {
                (candidate == binary.as_os_str())
                    .then_some(())
                    .ok_or_else(|| anyhow::anyhow!("not runnable"))
            },
        )
        .expect("fallback CLI should resolve");

        assert_eq!(resolved, binary.into_os_string());
    }

    #[test]
    fn skips_a_broken_path_cli_for_a_working_native_fallback() {
        let temp = TempDir::new().expect("temp directory");
        let path_directory = temp.path().join("path-bin");
        fs::create_dir(&path_directory).expect("PATH directory");
        let broken = path_directory.join(format!("codex{}", env::consts::EXE_SUFFIX));
        let native = temp
            .path()
            .join(format!("native-codex{}", env::consts::EXE_SUFFIX));
        fs::write(&broken, b"broken wrapper").expect("broken CLI");
        fs::write(&native, b"native CLI").expect("native CLI");
        make_executable(&broken);
        make_executable(&native);
        let search_path = env::join_paths([&path_directory]).expect("test PATH");

        let resolved = select_codex_binary(
            None,
            Some(&search_path),
            std::slice::from_ref(&native),
            |candidate| {
                (candidate == native.as_os_str())
                    .then_some(())
                    .ok_or_else(|| anyhow::anyhow!("missing interpreter"))
            },
        )
        .expect("native fallback should resolve");

        assert_eq!(resolved, native.into_os_string());
    }

    #[test]
    fn reports_an_actionable_error_when_no_cli_is_available() {
        let temp = TempDir::new().expect("temp directory");
        let restricted_path =
            env::join_paths([temp.path().join("missing")]).expect("restricted PATH");

        let error = select_codex_binary(None, Some(&restricted_path), &[], |_| Ok(()))
            .expect_err("missing CLI should fail before queue execution");

        assert!(error.to_string().contains("Codex CLI was not found"));
        assert!(error.to_string().contains("queue settings"));
    }

    #[test]
    fn probe_terminates_descendants_after_the_cli_exits() {
        let temp = TempDir::new().expect("temp directory");
        let successful_binary = probe_with_delayed_descendant(&temp.path().join("successful"), 0);
        let failing_binary = probe_with_delayed_descendant(&temp.path().join("failing"), 23);

        probe_codex_binary(successful_binary.as_os_str())
            .expect("successful parent CLI probe should succeed");
        probe_codex_binary(failing_binary.as_os_str())
            .expect_err("failing parent CLI probe should fail");

        thread::sleep(Duration::from_secs(2));
        for binary in [successful_binary, failing_binary] {
            assert!(
                !binary.with_extension("marker").exists(),
                "the CLI probe left a descendant process running"
            );
        }
    }

    #[cfg(unix)]
    fn probe_with_delayed_descendant(
        directory: &std::path::Path,
        exit_code: u8,
    ) -> std::path::PathBuf {
        fs::create_dir(directory).expect("fake CLI directory");
        let binary = directory.join("codex");
        fs::write(
            &binary,
            format!("#!/bin/sh\n(sleep 1; printf leaked > \"$0.marker\") &\nexit {exit_code}\n"),
        )
        .expect("fake Codex CLI");
        make_executable(&binary);
        binary
    }

    #[cfg(windows)]
    fn probe_with_delayed_descendant(
        directory: &std::path::Path,
        exit_code: u8,
    ) -> std::path::PathBuf {
        fs::create_dir(directory).expect("fake CLI directory");
        let binary = directory.join("codex.cmd");
        fs::write(
            &binary,
            format!(
                "@echo off\r\nstart \"\" /b cmd.exe /d /s /c \"ping.exe -n 2 127.0.0.1 >nul & echo leaked>\"\"%~dpn0.marker\"\"\"\r\nexit /b {exit_code}\r\n"
            ),
        )
        .expect("fake Codex CLI");
        binary
    }

    #[cfg(unix)]
    fn make_executable(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = fs::metadata(path).expect("fake CLI metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("executable fake CLI");
    }

    #[cfg(windows)]
    fn make_executable(_path: &std::path::Path) {}
}

#[cfg(test)]
mod retry_tests {
    use std::io;
    use std::process::{ChildStdin, ExitStatus};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use chrono::Utc;
    use process_wrap::std::ChildWrapper;
    use tempfile::TempDir;

    use crate::{Task, TaskStatus, TransientTaskError};

    use super::{
        SpawnCleanupChild, execute_task_with_spawn, is_transient_codex_failure, timeout_error,
    };

    #[derive(Debug)]
    struct RecordingChild {
        stdin: Option<ChildStdin>,
        killed: Arc<AtomicBool>,
        waited: Arc<AtomicBool>,
        status: ExitStatus,
    }

    impl ChildWrapper for RecordingChild {
        fn inner(&self) -> &dyn ChildWrapper {
            self
        }

        fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
            self
        }

        fn into_inner(self: Box<Self>) -> Box<dyn ChildWrapper> {
            self
        }

        fn stdin(&mut self) -> &mut Option<ChildStdin> {
            &mut self.stdin
        }

        fn start_kill(&mut self) -> io::Result<()> {
            self.killed.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            Ok(None)
        }

        fn wait(&mut self) -> io::Result<ExitStatus> {
            self.waited.store(true, Ordering::SeqCst);
            Ok(self.status)
        }
    }

    #[cfg(unix)]
    fn successful_exit_status() -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;

        ExitStatus::from_raw(0)
    }

    #[cfg(windows)]
    fn successful_exit_status() -> ExitStatus {
        use std::os::windows::process::ExitStatusExt;

        ExitStatus::from_raw(0)
    }

    #[test]
    fn reaps_a_spawned_child_when_setup_fails() {
        let temp = TempDir::new().expect("temp directory");
        let workspace = temp.path().join("workspace");
        let run_directory = temp.path().join("run");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&run_directory).unwrap();
        let killed = Arc::new(AtomicBool::new(false));
        let waited = Arc::new(AtomicBool::new(false));
        let child_killed = Arc::clone(&killed);
        let child_waited = Arc::clone(&waited);

        let error = execute_task_with_spawn(
            &"unused-codex".into(),
            Duration::from_secs(1),
            &task(),
            &workspace,
            &run_directory,
            move |_| {
                Ok(Box::new(RecordingChild {
                    stdin: None,
                    killed: child_killed,
                    waited: child_waited,
                    status: successful_exit_status(),
                }))
            },
        )
        .expect_err("missing child stdin should fail setup");

        assert!(error.to_string().contains("stdin is unavailable"));
        assert!(
            killed.load(Ordering::SeqCst),
            "spawned child was not killed"
        );
        assert!(
            waited.load(Ordering::SeqCst),
            "spawned child was not reaped"
        );
    }

    #[test]
    fn reaps_a_raw_child_dropped_during_spawn_wrapping() {
        let killed = Arc::new(AtomicBool::new(false));
        let waited = Arc::new(AtomicBool::new(false));
        let cleanup = SpawnCleanupChild::new(Box::new(RecordingChild {
            stdin: None,
            killed: Arc::clone(&killed),
            waited: Arc::clone(&waited),
            status: successful_exit_status(),
        }));

        drop(cleanup);

        assert!(killed.load(Ordering::SeqCst), "raw child was not killed");
        assert!(waited.load(Ordering::SeqCst), "raw child was not reaped");
    }

    #[test]
    fn disarms_spawn_cleanup_after_a_successful_wait() {
        let killed = Arc::new(AtomicBool::new(false));
        let waited = Arc::new(AtomicBool::new(false));
        let mut cleanup = SpawnCleanupChild::new(Box::new(RecordingChild {
            stdin: None,
            killed: Arc::clone(&killed),
            waited: Arc::clone(&waited),
            status: successful_exit_status(),
        }));

        cleanup.wait().expect("child wait succeeds");
        drop(cleanup);

        assert!(!killed.load(Ordering::SeqCst), "exited child was killed");
        assert!(waited.load(Ordering::SeqCst), "raw child was reaped");
    }

    fn task() -> Task {
        Task {
            id: "cleanup-test".to_owned(),
            title: "Cleanup test".to_owned(),
            workspace: ".".to_owned(),
            prompt: "test".to_owned(),
            priority: 1,
            depends_on: Vec::new(),
            status: TaskStatus::Pending,
            created_at: Utc::now(),
            attempts: None,
            started_at: None,
            finished_at: None,
            last_error: None,
            blocked_reason: None,
            next_retry_at: None,
        }
    }

    #[test]
    fn recognizes_retryable_network_and_api_failures() {
        assert!(is_transient_codex_failure(
            br#"{"type":"turn.failed","error":{"message":"rate limit exceeded (429)"}}"#,
            b""
        ));
        assert!(is_transient_codex_failure(b"", b"HTTP 502 bad gateway"));
        assert!(is_transient_codex_failure(
            b"",
            b"stream disconnected before completion"
        ));
        assert!(is_transient_codex_failure(
            b"",
            b"request timed out while connecting"
        ));
        assert!(is_transient_codex_failure(b"", b"HTTP 503"));
        assert!(is_transient_codex_failure(
            br#"{"type":"turn.failed","error":{"message":"HTTP 429"}}"#,
            b""
        ));
    }

    #[test]
    fn rejects_permanent_and_unknown_failures() {
        assert!(!is_transient_codex_failure(
            b"",
            b"HTTP 401 invalid authentication"
        ));
        assert!(!is_transient_codex_failure(b"", b"workspace tests failed"));
        assert!(!is_transient_codex_failure(
            b"",
            b"workspace tests failed after checking 500 cases"
        ));
        assert!(!is_transient_codex_failure(
            b"",
            b"HTTP 429: You exceeded your current quota"
        ));
        assert!(!is_transient_codex_failure(
            br#"{"type":"item.completed","item":{"type":"agent_message","text":"rate limit 429"}}"#,
            b"task command failed"
        ));
        assert!(is_transient_codex_failure(
            br#"{"type":"item.completed","item":{"type":"agent_message","text":"invalid api key"}}"#,
            b"HTTP 503"
        ));
        assert!(!is_transient_codex_failure(
            br#"{"type":"turn.failed","error":{"message":"unsupported region"}}"#,
            b"remote plugin sync failed with status 503 Service Unavailable"
        ));
    }

    #[test]
    fn does_not_retry_when_a_timed_out_process_tree_cannot_be_terminated() {
        let error = timeout_error(
            Duration::from_secs(1),
            Some(anyhow::anyhow!("job termination failed")),
        );

        assert!(error.downcast_ref::<TransientTaskError>().is_none());
        assert!(error.to_string().contains("failed to clean up the process"));
    }
}
