use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use codex_queue_demo::{CodexCli, RunSummary, WorkerOptions, run_queue_file};

#[derive(Debug, Parser)]
#[command(
    name = "codex-queue-demo",
    version,
    about = "Run a dependency-aware Codex task queue"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Validate, plan, and execute pending queue tasks.
    Run {
        /// Queue JSON file.
        #[arg(long, default_value = "queue.json")]
        queue: PathBuf,

        /// Print the ordered plan without launching Codex or changing the queue.
        #[arg(long)]
        dry_run: bool,

        /// Codex CLI executable. Defaults to CODEX_BIN, codex, or codex.cmd.
        #[arg(long)]
        codex_bin: Option<OsString>,
    },
}

fn main() -> ExitCode {
    match execute(Cli::parse()) {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("Error: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn execute(cli: Cli) -> anyhow::Result<u8> {
    match cli.command {
        Commands::Run {
            queue,
            dry_run,
            codex_bin,
        } => {
            let mut codex = codex_bin.map_or_else(CodexCli::default, CodexCli::new);
            let summary = run_queue_file(&queue, WorkerOptions { dry_run }, &mut codex)?;
            print_summary(&summary, dry_run);

            if summary.failed_ids.is_empty() && summary.blocked_ids.is_empty() {
                Ok(0)
            } else {
                Ok(2)
            }
        }
    }
}

fn print_summary(summary: &RunSummary, dry_run: bool) {
    println!("Plan: {}", display_ids(&summary.planned_ids));
    if !dry_run {
        println!("Succeeded: {}", display_ids(&summary.succeeded_ids));
    }
    if !dry_run || !summary.failed_ids.is_empty() || !summary.blocked_ids.is_empty() {
        println!("Failed: {}", display_ids(&summary.failed_ids));
        println!("Blocked: {}", display_ids(&summary.blocked_ids));
    }
}

fn display_ids(ids: &[String]) -> String {
    if ids.is_empty() {
        "(none)".to_owned()
    } else {
        ids.join(" -> ")
    }
}
