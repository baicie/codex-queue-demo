use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};

use crate::{QueueRunner, Task};

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
        let status = Command::new(&self.binary)
            .arg("app")
            .arg(workspace)
            .status()
            .with_context(|| format!("failed to start {:?}", self.binary))?;

        if !status.success() {
            bail!("codex app exited with status {status}");
        }
        Ok(())
    }

    fn execute_task(&mut self, task: &Task, workspace: &Path, run_directory: &Path) -> Result<()> {
        let final_output = run_directory.join("final.txt");
        let mut child = Command::new(&self.binary)
            .arg("exec")
            .arg("--json")
            .arg("--ephemeral")
            .arg("--skip-git-repo-check")
            .arg("--ask-for-approval")
            .arg("never")
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
            bail!(
                "codex exec exited with status {}: {}",
                output.status,
                stderr.trim()
            );
        }
        Ok(())
    }
}
