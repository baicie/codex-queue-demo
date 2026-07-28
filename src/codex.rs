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
            bail!(
                "codex exec exited with status {}: {}",
                output.status,
                stderr.trim()
            );
        }
        Ok(())
    }
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
