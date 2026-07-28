use std::fs;

use codex_queue_demo::{load_queue_file, parse_queue, save_queue_file};
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
