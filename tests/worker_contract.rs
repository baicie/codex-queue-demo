use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Result, bail};
use codex_queue_demo::{
    BlockedReasonCode, QueueRunner, RunSummary, TransientTaskError, WorkerOptions, parse_queue,
    run_queue_file,
};
use serde_json::{Value, json};
use tempfile::TempDir;

#[derive(Default)]
struct FakeRunner {
    executed: Vec<String>,
    launched: Vec<PathBuf>,
    fail_task: Option<String>,
    transient_task: Option<String>,
    transient_failures_remaining: usize,
    retry_delays: Vec<Duration>,
    events: Vec<String>,
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
        self.events.push(format!("execute:{}", task.id));
        if self.transient_task.as_deref() == Some(task.id.as_str())
            && self.transient_failures_remaining > 0
        {
            self.transient_failures_remaining -= 1;
            return Err(TransientTaskError::new("temporary network error").into());
        }
        if self.fail_task.as_deref() == Some(task.id.as_str()) {
            bail!("intentional demo failure");
        }
        Ok(())
    }

    fn wait_before_retry(&mut self, delay: Duration) {
        self.retry_delays.push(delay);
        self.events.push(format!("wait:{}", delay.as_secs()));
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
    let blocked_child = persisted
        .tasks
        .iter()
        .find(|task| task.id == "child")
        .expect("blocked child");
    assert_eq!(
        blocked_child
            .blocked_reason
            .as_ref()
            .expect("structured blocked reason")
            .reason_code,
        BlockedReasonCode::DependencyUnavailable
    );
    assert_eq!(
        blocked_child
            .blocked_reason
            .as_ref()
            .expect("structured blocked reason")
            .dependency_id,
        "parent"
    );
    assert!(blocked_child.last_error.is_none());
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

#[test]
fn retries_transient_failures_with_capped_exponential_backoff() {
    let temp = TempDir::new().expect("temp directory");
    let mut input = queue(false, vec![task("network-task")]);
    input["retryPolicy"] = json!({
        "maxAttempts": 4,
        "initialDelaySeconds": 2,
        "maxDelaySeconds": 3
    });
    let queue_path = write_queue(&temp, input);
    let mut runner = FakeRunner {
        transient_task: Some("network-task".to_owned()),
        transient_failures_remaining: 2,
        ..FakeRunner::default()
    };

    let summary = run_queue_file(&queue_path, WorkerOptions::default(), &mut runner)
        .expect("transient failures should recover");

    assert_eq!(
        runner.executed,
        vec!["network-task", "network-task", "network-task"]
    );
    assert_eq!(
        runner.retry_delays,
        vec![Duration::from_secs(2), Duration::from_secs(3)]
    );
    assert_eq!(summary.succeeded_ids, vec!["network-task"]);
    assert!(summary.failed_ids.is_empty());

    let persisted = parse_queue(&fs::read_to_string(&queue_path).expect("read queue"))
        .expect("persisted queue is valid");
    let task = persisted
        .tasks
        .iter()
        .find(|task| task.id == "network-task")
        .unwrap();
    assert_eq!(task.attempts, Some(3));
    assert_eq!(task.status, codex_queue_demo::TaskStatus::Succeeded);
    assert!(task.next_retry_at.is_none());

    let persisted_json = serde_json::from_str::<Value>(
        &fs::read_to_string(queue_path).expect("read persisted queue JSON"),
    )
    .expect("persisted queue JSON is valid");
    assert_eq!(
        persisted_json["retryPolicy"],
        json!({
            "maxAttempts": 4,
            "initialDelaySeconds": 2,
            "maxDelaySeconds": 3
        })
    );
}

#[test]
fn runs_independent_work_while_a_parent_task_is_backing_off() {
    let temp = TempDir::new().expect("temp directory");
    let mut parent = task("parent");
    parent["priority"] = json!(100);
    let mut child = task("child");
    child["priority"] = json!(200);
    child["dependsOn"] = json!(["parent"]);
    let mut independent = task("independent");
    independent["priority"] = json!(50);
    let mut input = queue(false, vec![child, independent, parent]);
    input["retryPolicy"] = json!({
        "maxAttempts": 3,
        "initialDelaySeconds": 2,
        "maxDelaySeconds": 10
    });
    let queue_path = write_queue(&temp, input);
    let mut runner = FakeRunner {
        transient_task: Some("parent".to_owned()),
        transient_failures_remaining: 1,
        ..FakeRunner::default()
    };

    let summary = run_queue_file(&queue_path, WorkerOptions::default(), &mut runner)
        .expect("independent work and the retry should succeed");

    assert_eq!(
        runner.events,
        vec![
            "execute:parent",
            "execute:independent",
            "wait:2",
            "execute:parent",
            "execute:child"
        ]
    );
    assert_eq!(
        summary.succeeded_ids,
        vec!["independent", "parent", "child"]
    );
}

#[test]
fn persists_the_effective_retry_policy_for_legacy_queues() {
    let temp = TempDir::new().expect("temp directory");
    let queue_path = write_queue(&temp, queue(false, vec![task("legacy")]));
    let mut runner = FakeRunner::default();

    run_queue_file(&queue_path, WorkerOptions::default(), &mut runner)
        .expect("legacy queue should use retry defaults");

    let persisted_json = serde_json::from_str::<Value>(
        &fs::read_to_string(queue_path).expect("read persisted queue JSON"),
    )
    .expect("persisted queue JSON is valid");
    assert_eq!(
        persisted_json["retryPolicy"],
        json!({
            "maxAttempts": 4,
            "initialDelaySeconds": 30,
            "maxDelaySeconds": 900
        })
    );
}

#[test]
fn stops_after_the_configured_maximum_attempts() {
    let temp = TempDir::new().expect("temp directory");
    let mut input = queue(false, vec![task("unavailable")]);
    input["retryPolicy"] = json!({
        "maxAttempts": 3,
        "initialDelaySeconds": 2,
        "maxDelaySeconds": 10
    });
    let queue_path = write_queue(&temp, input);
    let mut runner = FakeRunner {
        transient_task: Some("unavailable".to_owned()),
        transient_failures_remaining: 10,
        ..FakeRunner::default()
    };

    let summary = run_queue_file(&queue_path, WorkerOptions::default(), &mut runner)
        .expect("retry exhaustion is a task failure, not a worker error");

    assert_eq!(runner.executed.len(), 3);
    assert_eq!(
        runner.retry_delays,
        vec![Duration::from_secs(2), Duration::from_secs(4)]
    );
    assert_eq!(summary.failed_ids, vec!["unavailable"]);
}

#[test]
fn does_not_exceed_max_attempts_after_the_final_attempt_is_interrupted() {
    let temp = TempDir::new().expect("temp directory");
    let mut interrupted = task("interrupted");
    interrupted["status"] = json!("running");
    interrupted["attempts"] = json!(3);
    let mut input = queue(false, vec![interrupted]);
    input["retryPolicy"] = json!({
        "maxAttempts": 3,
        "initialDelaySeconds": 2,
        "maxDelaySeconds": 10
    });
    let queue_path = write_queue(&temp, input);
    let mut runner = FakeRunner::default();

    let summary = run_queue_file(&queue_path, WorkerOptions::default(), &mut runner)
        .expect("an exhausted interrupted task should become failed");

    assert!(runner.executed.is_empty());
    assert_eq!(summary.failed_ids, vec!["interrupted"]);
    let persisted = parse_queue(&fs::read_to_string(queue_path).expect("read queue"))
        .expect("persisted queue is valid");
    assert_eq!(
        persisted.tasks[0].status,
        codex_queue_demo::TaskStatus::Failed
    );
    assert!(
        persisted.tasks[0]
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("maximum attempt count"))
    );
}

#[test]
fn honors_a_persisted_retry_time_after_worker_restart() {
    let temp = TempDir::new().expect("temp directory");
    let mut retrying = task("recovering");
    retrying["nextRetryAt"] = json!("2099-01-01T00:00:00Z");
    let mut input = queue(false, vec![retrying]);
    input["retryPolicy"] = json!({
        "maxAttempts": 4,
        "initialDelaySeconds": 2,
        "maxDelaySeconds": 7
    });
    let queue_path = write_queue(&temp, input);
    let mut runner = FakeRunner::default();

    let summary = run_queue_file(&queue_path, WorkerOptions::default(), &mut runner)
        .expect("recovered retry should run after waiting");

    assert_eq!(runner.executed, vec!["recovering"]);
    assert_eq!(runner.retry_delays, vec![Duration::from_secs(7)]);
    assert_eq!(summary.succeeded_ids, vec!["recovering"]);

    let persisted = parse_queue(&fs::read_to_string(queue_path).expect("read queue"))
        .expect("persisted queue is valid");
    assert!(persisted.tasks[0].next_retry_at.is_none());
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
