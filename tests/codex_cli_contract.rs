use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use chrono::Utc;
use codex_queue_demo::{CodexCli, QueueRunner, Task, TaskStatus};
use tempfile::TempDir;

#[test]
fn passes_prompt_over_stdin_and_records_codex_outputs() {
    let temp = TempDir::new().expect("temp directory");
    let fake_codex = compile_fake_codex(temp.path());
    let workspace = temp.path().join("workspace");
    let run_directory = temp.path().join("run");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&run_directory).unwrap();
    let mut codex = CodexCli::new(fake_codex);

    codex
        .execute_task(
            &task("a prompt with spaces & shell symbols"),
            &workspace,
            &run_directory,
        )
        .expect("fake Codex execution succeeds");

    let arguments = fs::read_to_string(run_directory.join("args.txt")).unwrap();
    assert!(arguments.lines().any(|argument| argument == "exec"));
    assert!(
        arguments
            .lines()
            .any(|argument| argument == "workspace-write")
    );
    assert_eq!(arguments.lines().last(), Some("-"));
    assert!(!arguments.contains("a prompt with spaces & shell symbols"));
    assert_eq!(
        fs::read_to_string(run_directory.join("prompt.txt")).unwrap(),
        "a prompt with spaces & shell symbols\n"
    );
    assert_eq!(
        fs::read_to_string(run_directory.join("final.txt")).unwrap(),
        "FAKE_CODEX_OK\n"
    );
    assert!(
        fs::read_to_string(run_directory.join("events.jsonl"))
            .unwrap()
            .contains("completed")
    );
    assert!(run_directory.join("stderr.log").is_file());
}

#[test]
fn opens_the_codex_app_for_the_requested_workspace() {
    let temp = TempDir::new().expect("temp directory");
    let fake_codex = compile_fake_codex(temp.path());
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let mut codex = CodexCli::new(fake_codex);

    codex
        .launch_app(&workspace)
        .expect("fake Codex app launch succeeds");

    assert_eq!(
        fs::read_to_string(workspace.join("app-launched.txt")).unwrap(),
        "launched\n"
    );
}

fn task(prompt: &str) -> Task {
    Task {
        id: "demo-task".to_owned(),
        title: "Demo task".to_owned(),
        workspace: ".".to_owned(),
        prompt: prompt.to_owned(),
        priority: 10,
        depends_on: Vec::new(),
        status: TaskStatus::Pending,
        created_at: Utc::now(),
        attempts: Some(1),
        started_at: None,
        finished_at: None,
        last_error: None,
    }
}

fn compile_fake_codex(directory: &Path) -> PathBuf {
    let source = directory.join("fake_codex.rs");
    let binary = directory.join(format!("fake-codex{}", std::env::consts::EXE_SUFFIX));
    fs::write(
        &source,
        r#"
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::PathBuf;

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) == Some("app") {
        let workspace = PathBuf::from(&args[1]);
        fs::write(workspace.join("app-launched.txt"), "launched\n").unwrap();
        return;
    }

    let output_index = args.iter().position(|arg| arg == "-o").unwrap() + 1;
    let final_path = PathBuf::from(&args[output_index]);
    let run_directory = final_path.parent().unwrap();
    let mut prompt = String::new();
    io::stdin().read_to_string(&mut prompt).unwrap();
    fs::write(run_directory.join("args.txt"), format!("{}\n", args.join("\n"))).unwrap();
    fs::write(run_directory.join("prompt.txt"), prompt).unwrap();
    fs::write(final_path, "FAKE_CODEX_OK\n").unwrap();
    println!("{{\"type\":\"completed\"}}");
}
"#,
    )
    .unwrap();

    let status = Command::new("rustc")
        .arg("--edition=2024")
        .arg(&source)
        .arg("-o")
        .arg(&binary)
        .status()
        .expect("rustc is available");
    assert!(status.success(), "fake Codex should compile");
    binary
}
