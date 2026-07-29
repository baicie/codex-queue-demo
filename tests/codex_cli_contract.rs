use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use chrono::Utc;
use codex_queue_demo::{CodexCli, QueueRunner, Task, TaskStatus, TransientTaskError};
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
    assert_eq!(
        arguments.lines().take(3).collect::<Vec<_>>(),
        vec!["-a", "never", "exec"]
    );
    assert!(
        !arguments
            .lines()
            .any(|argument| argument == "--ask-for-approval")
    );
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
fn distinguishes_transient_api_failures_from_authentication_failures() {
    let temp = TempDir::new().expect("temp directory");
    let fake_codex = compile_fake_codex(temp.path());
    let workspace = temp.path().join("workspace");
    let transient_run = temp.path().join("transient-run");
    let permanent_run = temp.path().join("permanent-run");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&transient_run).unwrap();
    fs::create_dir_all(&permanent_run).unwrap();
    let mut codex = CodexCli::new(fake_codex);

    let transient = codex
        .execute_task(&task("TRANSIENT_API_FAILURE"), &workspace, &transient_run)
        .expect_err("503 should fail");
    let permanent = codex
        .execute_task(&task("PERMANENT_API_FAILURE"), &workspace, &permanent_run)
        .expect_err("401 should fail");

    assert!(transient.downcast_ref::<TransientTaskError>().is_some());
    assert!(permanent.downcast_ref::<TransientTaskError>().is_none());
}

#[test]
fn classifies_early_transient_failure_before_stdin_broken_pipe() {
    let temp = TempDir::new().expect("temp directory");
    let fake_codex = compile_fake_codex(temp.path());
    let workspace = temp.path().join("workspace");
    let run_directory = temp.path().join("early-transient-run");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&run_directory).unwrap();
    let mut codex = CodexCli::new(fake_codex);
    let large_prompt = "large prompt content ".repeat(100_000);

    let error = codex
        .execute_task(&task(&large_prompt), &workspace, &run_directory)
        .expect_err("an early HTTP 503 should fail transiently");

    assert!(
        error.downcast_ref::<TransientTaskError>().is_some(),
        "HTTP 503 should not be hidden by a stdin write failure: {error:#}"
    );
    assert!(
        fs::read_to_string(run_directory.join("stderr.log"))
            .unwrap()
            .contains("HTTP 503 service unavailable")
    );
}

#[test]
fn times_out_hanging_codex_and_terminates_its_process_tree() {
    let temp = TempDir::new().expect("temp directory");
    let fake_codex = compile_fake_codex(temp.path());
    let workspace = temp.path().join("workspace");
    let run_directory = temp.path().join("timeout-run");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&run_directory).unwrap();
    let mut codex = CodexCli::with_timeout(fake_codex, Duration::from_secs(5));
    let hanging_prompt = "HANGING_INPUT".repeat(100_000);

    let started = Instant::now();
    let error = codex
        .execute_task(&task(&hanging_prompt), &workspace, &run_directory)
        .expect_err("a hanging Codex process should time out");

    assert!(
        started.elapsed() < Duration::from_secs(7),
        "timeout should stop the child promptly"
    );
    assert!(error.downcast_ref::<TransientTaskError>().is_some());
    assert!(error.to_string().contains("timed out"));
    let events = fs::read_to_string(run_directory.join("events.jsonl")).unwrap();
    let stderr = fs::read_to_string(run_directory.join("stderr.log")).unwrap();
    assert!(
        events.contains("partial output before timeout"),
        "partial stdout was not preserved: {events:?}"
    );
    assert!(
        stderr.contains("partial stderr before timeout"),
        "partial stderr was not preserved: {stderr:?}"
    );

    thread::sleep(Duration::from_secs(4));
    assert!(
        !run_directory.join("finished-after-hang.txt").exists(),
        "the timed-out process tree should be terminated, not left running"
    );
}

#[test]
fn successful_codex_terminates_its_remaining_process_tree() {
    let temp = TempDir::new().expect("temp directory");
    let fake_codex = compile_fake_codex(temp.path());
    let workspace = temp.path().join("workspace");
    let run_directory = temp.path().join("success-with-descendant-run");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&run_directory).unwrap();
    let mut codex = CodexCli::new(fake_codex);

    codex
        .execute_task(&task("SPAWN_DESCENDANT"), &workspace, &run_directory)
        .expect("the parent Codex process succeeds");

    thread::sleep(Duration::from_secs(2));
    assert!(
        !run_directory.join("finished-after-success.txt").exists(),
        "a successful parent must not leave its process tree running"
    );
}

#[test]
#[cfg(not(target_os = "macos"))]
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
        blocked_reason: None,
        next_retry_at: None,
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
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) == Some("DESCENDANT_AFTER_TIMEOUT") {
        thread::sleep(Duration::from_secs(8));
        fs::write(&args[1], "finished\n").unwrap();
        return;
    }
    if args.first().map(String::as_str) == Some("DESCENDANT_AFTER_SUCCESS") {
        thread::sleep(Duration::from_secs(1));
        fs::write(&args[1], "finished\n").unwrap();
        return;
    }
    if args.first().map(String::as_str) == Some("app") {
        let workspace = PathBuf::from(&args[1]);
        fs::write(workspace.join("app-launched.txt"), "launched\n").unwrap();
        return;
    }

    let output_index = args.iter().position(|arg| arg == "-o").unwrap() + 1;
    let final_path = PathBuf::from(&args[output_index]);
    let run_directory = final_path.parent().unwrap();
    if run_directory.file_name().and_then(|name| name.to_str()) == Some("early-transient-run") {
        eprintln!("HTTP 503 service unavailable");
        io::stderr().flush().unwrap();
        std::process::exit(1);
    }
    if run_directory.file_name().and_then(|name| name.to_str()) == Some("timeout-run") {
        println!("{{\"type\":\"turn.started\",\"message\":\"partial output before timeout\"}}");
        io::stdout().flush().unwrap();
        eprintln!("partial stderr before timeout");
        io::stderr().flush().unwrap();
        let marker = run_directory.join("finished-after-hang.txt");
        let mut descendant = std::process::Command::new(env::current_exe().unwrap())
            .arg("DESCENDANT_AFTER_TIMEOUT")
            .arg(marker)
            .spawn()
            .unwrap();
        thread::sleep(Duration::from_secs(30));
        let _ = descendant.wait();
        unreachable!("the fake Codex wrapper should have been terminated");
    }
    let mut prompt = String::new();
    io::stdin().read_to_string(&mut prompt).unwrap();
    fs::write(run_directory.join("args.txt"), format!("{}\n", args.join("\n"))).unwrap();
    fs::write(run_directory.join("prompt.txt"), &prompt).unwrap();
    if prompt.contains("TRANSIENT_API_FAILURE") {
        eprintln!("HTTP 503 service unavailable");
        std::process::exit(1);
    }
    if prompt.contains("PERMANENT_API_FAILURE") {
        eprintln!("HTTP 401 invalid authentication");
        std::process::exit(1);
    }
    if prompt.contains("SPAWN_DESCENDANT") {
        std::process::Command::new(env::current_exe().unwrap())
            .arg("DESCENDANT_AFTER_SUCCESS")
            .arg(run_directory.join("finished-after-success.txt"))
            .spawn()
            .unwrap();
    }
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
