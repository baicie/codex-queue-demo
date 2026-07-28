use std::fs;
use std::process::Command;

use serde_json::json;
use tempfile::TempDir;

#[test]
fn dry_run_prints_the_plan_without_mutating_the_queue() {
    let temp = TempDir::new().unwrap();
    let queue_path = temp.path().join("queue.json");
    let queue = json!({
        "version": 1,
        "launchApp": false,
        "tasks": [task("low", 1), task("high", 10)]
    });
    let original = format!("{}\n", serde_json::to_string_pretty(&queue).unwrap());
    fs::write(&queue_path, &original).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_codex-queue-demo"))
        .arg("run")
        .arg("--queue")
        .arg(&queue_path)
        .arg("--dry-run")
        .output()
        .expect("run demo CLI");

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "Plan: high -> low\n"
    );
    assert_eq!(fs::read_to_string(queue_path).unwrap(), original);
}

#[test]
fn invalid_queue_returns_a_non_zero_exit_code() {
    let temp = TempDir::new().unwrap();
    let queue_path = temp.path().join("queue.json");
    fs::write(
        &queue_path,
        "{\"version\":2,\"launchApp\":false,\"tasks\":[]}",
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_codex-queue-demo"))
        .arg("run")
        .arg("--queue")
        .arg(&queue_path)
        .arg("--dry-run")
        .output()
        .expect("run demo CLI");

    assert!(!output.status.success());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("queue version must be 1")
    );
}

#[test]
fn dry_run_separates_blocked_tasks_from_the_executable_plan() {
    let temp = TempDir::new().unwrap();
    let queue_path = temp.path().join("queue.json");
    let mut failed = task("failed", 0);
    failed["status"] = json!("failed");
    let mut child = task("child", 100);
    child["dependsOn"] = json!(["failed"]);
    fs::write(
        &queue_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({
                "version": 1,
                "launchApp": false,
                "tasks": [failed, child]
            }))
            .unwrap()
        ),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_codex-queue-demo"))
        .arg("run")
        .arg("--queue")
        .arg(&queue_path)
        .arg("--dry-run")
        .output()
        .expect("run demo CLI");

    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "Plan: (none)\nFailed: failed\nBlocked: child\n"
    );
}

fn task(id: &str, priority: i64) -> serde_json::Value {
    json!({
        "id": id,
        "title": id,
        "workspace": ".",
        "prompt": format!("Complete {id}"),
        "priority": priority,
        "dependsOn": [],
        "status": "pending",
        "createdAt": "2026-07-28T00:00:00Z"
    })
}
