use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use codex_queue_demo::{
    BlockedTask, CodexCli, Queue, RetryPolicy, RunSummary, WorkerOptions, build_execution_plan,
    load_queue_file, run_queue_file, save_queue_file,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct RunState {
    running: AtomicBool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    default_queue_path: String,
    platform: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    path: String,
    queue: Queue,
    ordered_ids: Vec<String>,
    blocked: Vec<BlockedTask>,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> Result<AppInfo, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let default_queue_path = app_data.join("queue.json");
    ensure_default_queue(&default_queue_path)?;

    Ok(AppInfo {
        default_queue_path: path_string(&default_queue_path),
        platform: std::env::consts::OS,
    })
}

#[tauri::command]
pub fn load_queue(path: String) -> Result<QueueSnapshot, String> {
    let path = PathBuf::from(path);
    let queue = load_queue_file(&path).map_err(|error| error.to_string())?;
    snapshot_from_queue(&path, queue)
}

#[tauri::command]
pub fn save_queue(path: String, queue: Queue) -> Result<QueueSnapshot, String> {
    let path = PathBuf::from(path);
    save_queue_file(&path, &queue).map_err(|error| error.to_string())?;
    snapshot_from_queue(&path, queue)
}

#[tauri::command]
pub async fn run_queue(
    app: AppHandle,
    path: String,
    codex_bin: Option<String>,
) -> Result<RunSummary, String> {
    let state = app.state::<RunState>();
    if state
        .running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("a queue run is already active".to_owned());
    }

    let path = PathBuf::from(path);
    let task_result = tauri::async_runtime::spawn_blocking(move || {
        let mut codex = codex_bin.map_or_else(CodexCli::default, CodexCli::new);
        run_queue_file(&path, WorkerOptions::default(), &mut codex)
            .map_err(|error| error.to_string())
    })
    .await;

    app.state::<RunState>()
        .running
        .store(false, Ordering::Release);
    task_result.map_err(|error| error.to_string())?
}

fn snapshot_from_queue(path: &Path, queue: Queue) -> Result<QueueSnapshot, String> {
    let plan = build_execution_plan(&queue).map_err(|error| error.to_string())?;
    Ok(QueueSnapshot {
        path: path_string(path),
        queue,
        ordered_ids: plan.ordered_ids,
        blocked: plan.blocked,
    })
}

fn ensure_default_queue(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let queue = Queue {
        version: 1,
        launch_app: true,
        retry_policy: RetryPolicy::default(),
        tasks: Vec::new(),
    };
    save_queue_file(path, &queue).map_err(|error| error.to_string())
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use codex_queue_demo::parse_queue;
    use serde_json::json;

    use super::{ensure_default_queue, snapshot_from_queue};

    #[test]
    fn snapshot_exposes_the_authoritative_execution_order() {
        let queue = parse_queue(
            &json!({
                "version": 1,
                "launchApp": false,
                "tasks": [
                    task("low", 1),
                    task("high", 20)
                ]
            })
            .to_string(),
        )
        .expect("valid queue");

        let snapshot =
            snapshot_from_queue(Path::new("queue.json"), queue).expect("queue should be plannable");

        assert_eq!(snapshot.path, "queue.json");
        assert_eq!(snapshot.ordered_ids, vec!["high", "low"]);
        assert!(snapshot.blocked.is_empty());
    }

    #[test]
    fn creates_a_valid_default_queue_only_when_missing() {
        let temp = tempfile::TempDir::new().expect("temp directory");
        let queue_path = temp.path().join("nested").join("queue.json");

        ensure_default_queue(&queue_path).expect("default queue should be created");
        let original = std::fs::read_to_string(&queue_path).expect("default queue");
        ensure_default_queue(&queue_path).expect("existing queue should be preserved");

        let queue = codex_queue_demo::load_queue_file(&queue_path).expect("valid default queue");
        assert!(queue.launch_app);
        assert!(queue.tasks.is_empty());
        assert_eq!(
            std::fs::read_to_string(queue_path).expect("preserved queue"),
            original
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
}
