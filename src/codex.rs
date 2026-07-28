use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, bail};

use crate::{QueueRunner, Task, TransientTaskError};

pub struct CodexCli {
    binary: OsString,
}

impl CodexCli {
    pub fn new(binary: impl Into<OsString>) -> Self {
        Self {
            binary: binary.into(),
        }
    }
}

impl Default for CodexCli {
    fn default() -> Self {
        let binary = env::var_os("CODEX_BIN").unwrap_or_else(|| {
            if cfg!(windows) {
                OsString::from("codex.cmd")
            } else {
                OsString::from("codex")
            }
        });
        Self::new(binary)
    }
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
        let final_output = run_directory.join("final.txt");
        let mut child = Command::new(&self.binary)
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
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("failed to start {:?}", self.binary))?;

        let mut stdin = child.stdin.take().context("Codex stdin is unavailable")?;
        stdin
            .write_all(task.prompt.as_bytes())
            .context("failed to send task prompt to Codex")?;
        stdin
            .write_all(b"\n")
            .context("failed to terminate task prompt")?;
        drop(stdin);

        let output = child
            .wait_with_output()
            .context("failed while waiting for Codex")?;
        fs::write(run_directory.join("events.jsonl"), &output.stdout)
            .context("failed to write Codex event log")?;
        fs::write(run_directory.join("stderr.log"), &output.stderr)
            .context("failed to write Codex stderr log")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let terminal_error = terminal_failure_message(&output.stdout);
            let details = if let Some(error) = terminal_error.as_deref() {
                error
            } else if !stderr.trim().is_empty() {
                stderr.trim()
            } else {
                "see events.jsonl for details"
            };
            let message = format!(
                "codex exec exited with status {}: {}",
                output.status, details
            );
            if is_transient_codex_failure(&output.stdout, &output.stderr) {
                return Err(TransientTaskError::new(message).into());
            }
            bail!("{message}");
        }
        Ok(())
    }

    fn wait_before_retry(&mut self, delay: Duration) {
        eprintln!(
            "Waiting {} seconds before retrying the Codex task.",
            delay.as_secs()
        );
        thread::sleep(delay);
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
mod retry_tests {
    use super::is_transient_codex_failure;

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
}
