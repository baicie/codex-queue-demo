use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use codex_queue_demo::{QueueRunner, RunSummary, WorkerOptions, parse_queue, run_queue_file};
use serde_json::{Value, json};
use tempfile::TempDir;

#[derive(Default)]
struct FakeRunner {
    executed: Vec<String>,
    launched: Vec<PathBuf>,
    fail_task: Option<String>,
}

impl QueueRunner for FakeRunner {
    fn launch_app(&mut self, workspace: &Path) -> Result<()> {
        self.launched.push(workspace.to_path_buf());
        Ok(())
    }

    fn execute_task(
        &mut self,
        task: &codex_queue_demo::Task,
        _workspace: &Path,
        _run_directory: &Path,
    ) -> Result<()> {
        self.executed.push(task.id.clone());
        if self.fail_task.as_deref() == Some(task.id.as_str()) {
            bail!("intentional demo failure");
        }
        Ok(())
    }
}

#[test]
fn continues_independent_work_and_blocks_children_after_failure() {
    let temp = TempDir::new().expect("temp directory");
    let mut child = task("child");
    child["priority"] = json!(100);
    child["dependsOn"] = json!(["parent"]);
    let mut independent = task("independent");
    independent["priority"] = json!(50);
    let mut parent = task("parent");
    parent["priority"] = json!(10);
    let queue_path = write_queue(&temp, queue(false, vec![child, independent, parent]));
    let mut runner = FakeRunner {
        fail_task: Some("parent".to_owned()),
        ..FakeRunner::default()
    };

    let summary = run_queue_file(&queue_path, WorkerOptions::default(), &mut runner)
        .expect("worker should finish the queue");

    assert_eq!(runner.executed, vec!["independent", "parent"]);
    assert_eq!(
        summary,
        RunSummary {
            planned_ids: vec!["independent".into(), "parent".into(), "child".into()],
            succeeded_ids: vec!["independent".into()],
            failed_ids: vec!["parent".into()],
            blocked_ids: vec!["child".into()],
        }
    );

    let persisted = parse_queue(&fs::read_to_string(&queue_path).expect("read queue"))
        .expect("persisted queue is valid");
    assert_eq!(status(&persisted, "independent"), "succeeded");
    assert_eq!(status(&persisted, "parent"), "failed");
    assert_eq!(status(&persisted, "child"), "blocked");
    assert!(
        persisted
            .tasks
            .iter()
            .find(|task| task.id == "parent")
            .and_then(|task| task.last_error.as_deref())
            .is_some_and(|error| error.contains("intentional demo failure"))
    );
}

#[test]
fn dry_run_does_not_launch_execute_or_mutate_the_queue() {
    let temp = TempDir::new().expect("temp directory");
    let mut low = task("low");
    low["priority"] = json!(1);
    let mut high = task("high");
    high["priority"] = json!(10);
    let original = queue(true, vec![low, high]);
    let queue_path = write_queue(&temp, original.clone());
    let mut runner = FakeRunner::default();

    let summary = run_queue_file(&queue_path, WorkerOptions { dry_run: true }, &mut runner)
        .expect("dry-run should succeed");

    assert_eq!(summary.planned_ids, vec!["high", "low"]);
    assert!(runner.executed.is_empty());
    assert!(runner.launched.is_empty());
    assert_eq!(
        serde_json::from_str::<Value>(&fs::read_to_string(queue_path).expect("read queue"))
            .expect("valid JSON"),
        original
    );
}

#[test]
fn launches_codex_once_with_the_first_planned_workspace() {
    let temp = TempDir::new().expect("temp directory");
    let mut first = task("first");
    first["workspace"] = json!("project-a");
    let queue_path = write_queue(&temp, queue(true, vec![first, task("second")]));
    let mut runner = FakeRunner::default();

    run_queue_file(&queue_path, WorkerOptions::default(), &mut runner)
        .expect("worker should finish the queue");

    assert_eq!(
        runner.launched,
        vec![fs::canonicalize(temp.path()).unwrap().join("project-a")]
    );
}

#[test]
fn reports_failures_and_blocks_that_were_already_persisted() {
    let temp = TempDir::new().expect("temp directory");
    let mut failed = task("failed");
    failed["status"] = json!("failed");
    let mut blocked = task("blocked");
    blocked["status"] = json!("blocked");
    let queue_path = write_queue(&temp, queue(false, vec![failed, blocked]));
    let mut runner = FakeRunner::default();

    let summary = run_queue_file(&queue_path, WorkerOptions::default(), &mut runner)
        .expect("existing failures should be reported");

    assert_eq!(summary.failed_ids, vec!["failed"]);
    assert_eq!(summary.blocked_ids, vec!["blocked"]);
    assert!(runner.executed.is_empty());
}

#[test]
fn rejects_an_attempt_counter_that_cannot_be_incremented() {
    let temp = TempDir::new().expect("temp directory");
    let mut overflow = task("overflow");
    overflow["attempts"] = json!(u32::MAX);
    let queue_path = write_queue(&temp, queue(false, vec![overflow]));
    let mut runner = FakeRunner::default();

    let error = run_queue_file(&queue_path, WorkerOptions::default(), &mut runner)
        .expect_err("attempt overflow must be reported without panicking");

    assert_eq!(
        error.to_string(),
        "task overflow has reached the maximum attempt count"
    );
    assert!(runner.executed.is_empty());
}

fn write_queue(temp: &TempDir, value: Value) -> PathBuf {
    let path = temp.path().join("queue.json");
    fs::write(
        &path,
        format!("{}\n", serde_json::to_string_pretty(&value).unwrap()),
    )
    .expect("write queue");
    path
}

fn queue(launch_app: bool, tasks: Vec<Value>) -> Value {
    json!({ "version": 1, "launchApp": launch_app, "tasks": tasks })
}

fn task(id: &str) -> Value {
    json!({
        "id": id,
        "title": id,
        "workspace": ".",
        "prompt": format!("Complete {id}"),
        "priority": 0,
        "dependsOn": [],
        "status": "pending",
        "createdAt": "2026-07-28T00:00:00Z"
    })
}

fn status(queue: &codex_queue_demo::Queue, id: &str) -> &'static str {
    use codex_queue_demo::TaskStatus;

    match queue
        .tasks
        .iter()
        .find(|task| task.id == id)
        .unwrap()
        .status
    {
        TaskStatus::Pending => "pending",
        TaskStatus::Running => "running",
        TaskStatus::Succeeded => "succeeded",
        TaskStatus::Failed => "failed",
        TaskStatus::Blocked => "blocked",
    }
}
