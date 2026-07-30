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

#[test]
fn an_unavailable_codex_cli_does_not_mutate_the_queue() {
    let temp = TempDir::new().unwrap();
    let queue_path = temp.path().join("queue.json");
    let missing_codex = temp.path().join("missing-codex");
    let queue = json!({
        "version": 1,
        "launchApp": false,
        "tasks": [task("waiting", 10)]
    });
    let original = format!("{}\n", serde_json::to_string_pretty(&queue).unwrap());
    fs::write(&queue_path, &original).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_codex-queue-demo"))
        .arg("run")
        .arg("--queue")
        .arg(&queue_path)
        .arg("--codex-bin")
        .arg(&missing_codex)
        .output()
        .expect("run demo CLI");

    assert!(!output.status.success());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("Codex CLI is not runnable")
    );
    assert_eq!(fs::read_to_string(queue_path).unwrap(), original);
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn discovers_the_platform_cli_when_the_gui_path_is_restricted() {
    let temp = TempDir::new().unwrap();
    let queue_path = temp.path().join("queue.json");
    let queue = json!({
        "version": 1,
        "launchApp": false,
        "tasks": []
    });
    fs::write(
        &queue_path,
        format!("{}\n", serde_json::to_string_pretty(&queue).unwrap()),
    )
    .unwrap();

    #[cfg(target_os = "macos")]
    let installed_codex = temp.path().join("home/.local/bin/codex");
    #[cfg(windows)]
    let installed_codex = temp
        .path()
        .join("local-app-data/Programs/OpenAI/Codex/bin/codex.exe");
    fs::create_dir_all(installed_codex.parent().unwrap()).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_codex-queue-demo"), &installed_codex).unwrap();
    make_executable(&installed_codex);

    let mut command = Command::new(env!("CARGO_BIN_EXE_codex-queue-demo"));
    command
        .arg("run")
        .arg("--queue")
        .arg(&queue_path)
        .env_remove("CODEX_BIN")
        .env("PATH", temp.path().join("missing-path"));
    #[cfg(target_os = "macos")]
    command.env("HOME", temp.path().join("home"));
    #[cfg(windows)]
    command.env("LOCALAPPDATA", temp.path().join("local-app-data"));

    let output = command.output().expect("run demo CLI");

    assert!(
        output.status.success(),
        "platform CLI discovery failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
fn make_executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}

#[cfg(windows)]
fn make_executable(_path: &std::path::Path) {}

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
