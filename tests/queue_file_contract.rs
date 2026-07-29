use std::fs;

use codex_queue_demo::{
    TaskStatus, WorkerError, load_queue_file, load_queue_file_with_revision, parse_queue,
    save_queue_file, save_queue_file_if_revision,
};
use serde_json::json;
use tempfile::TempDir;

#[test]
fn saves_and_loads_a_valid_queue() {
    let temp = TempDir::new().expect("temp directory");
    let queue_path = temp.path().join("queue.json");
    let queue = parse_queue(
        &json!({
            "version": 1,
            "launchApp": false,
            "tasks": []
        })
        .to_string(),
    )
    .expect("valid queue");

    save_queue_file(&queue_path, &queue).expect("queue should be saved");
    let loaded = load_queue_file(&queue_path).expect("queue should be loaded");

    assert_eq!(loaded.version, 1);
    assert!(!loaded.launch_app);
    assert!(loaded.tasks.is_empty());
    assert!(
        fs::read_to_string(queue_path)
            .expect("saved queue")
            .ends_with('\n')
    );
}

#[test]
fn rejects_an_invalid_queue_without_overwriting_the_file() {
    let temp = TempDir::new().expect("temp directory");
    let queue_path = temp.path().join("queue.json");
    fs::write(&queue_path, "original\n").expect("seed queue");
    let mut queue = parse_queue(
        &json!({
            "version": 1,
            "launchApp": false,
            "tasks": []
        })
        .to_string(),
    )
    .expect("valid queue");
    queue.version = 2;

    let error = save_queue_file(&queue_path, &queue).expect_err("invalid queue must fail");

    assert!(error.to_string().contains("queue version must be 1"));
    assert_eq!(fs::read_to_string(queue_path).unwrap(), "original\n");
}

#[test]
fn rejects_a_stale_save_without_overwriting_scheduler_state() {
    let temp = TempDir::new().expect("temp directory");
    let queue_path = temp.path().join("queue.json");
    let queue = parse_queue(
        &json!({
            "version": 1,
            "launchApp": false,
            "tasks": [{
                "id": "scheduled-task",
                "title": "Scheduled task",
                "workspace": ".",
                "prompt": "Complete the task",
                "priority": 10,
                "dependsOn": [],
                "status": "pending",
                "createdAt": "2026-07-28T00:00:00Z"
            }]
        })
        .to_string(),
    )
    .expect("valid queue");
    save_queue_file(&queue_path, &queue).expect("queue should be saved");

    let mut stale_ui_snapshot =
        load_queue_file_with_revision(&queue_path).expect("UI should load the queue");
    let mut scheduler_queue = load_queue_file(&queue_path).expect("scheduler should load queue");
    scheduler_queue.tasks[0].status = TaskStatus::Succeeded;
    save_queue_file(&queue_path, &scheduler_queue).expect("scheduler should persist task state");

    stale_ui_snapshot.queue.tasks[0].title = "Stale UI title".to_owned();
    let error = save_queue_file_if_revision(
        &queue_path,
        &stale_ui_snapshot.queue,
        &stale_ui_snapshot.revision,
    )
    .expect_err("stale UI save must fail");

    assert!(matches!(error, WorkerError::RevisionConflict { .. }));
    assert!(
        error
            .to_string()
            .contains("queue changed since it was loaded")
    );
    let preserved = load_queue_file(&queue_path).expect("queue should remain readable");
    assert_eq!(preserved.tasks[0].status, TaskStatus::Succeeded);
    assert_eq!(preserved.tasks[0].title, "Scheduled task");
}
