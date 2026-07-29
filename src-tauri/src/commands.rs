use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use codex_queue_demo::{
    BlockedTask, CodexCli, Queue, RetryPolicy, RunSummary, WorkerOptions, build_execution_plan,
    create_queue_file_if_missing, load_queue_file_with_revision, run_queue_file, save_queue_file,
    save_queue_file_if_revision,
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
    revision: String,
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
    let file_snapshot = load_queue_file_with_revision(&path).map_err(|error| error.to_string())?;
    snapshot_from_queue(&path, file_snapshot.queue, file_snapshot.revision)
}

#[tauri::command]
pub fn save_queue(
    path: String,
    queue: Queue,
    expected_revision: Option<String>,
    expected_revision_path: Option<String>,
) -> Result<QueueSnapshot, String> {
    let path = PathBuf::from(path);
    let expected_revision = match (expected_revision, expected_revision_path) {
        (Some(revision), Some(revision_path)) => {
            paths_resolve_to_same_path(&path, Path::new(&revision_path))?.then_some(revision)
        }
        (Some(revision), None) => Some(revision),
        (None, _) => None,
    };
    let file_snapshot = if let Some(expected_revision) = expected_revision {
        save_queue_file_if_revision(&path, &queue, &expected_revision)
            .map_err(|error| error.to_string())?
    } else {
        save_queue_file(&path, &queue).map_err(|error| error.to_string())?;
        load_queue_file_with_revision(&path).map_err(|error| error.to_string())?
    };
    snapshot_from_queue(&path, file_snapshot.queue, file_snapshot.revision)
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

fn snapshot_from_queue(
    path: &Path,
    queue: Queue,
    revision: String,
) -> Result<QueueSnapshot, String> {
    let plan = build_execution_plan(&queue).map_err(|error| error.to_string())?;
    Ok(QueueSnapshot {
        path: path_string(path),
        revision,
        queue,
        ordered_ids: plan.ordered_ids,
        blocked: plan.blocked,
    })
}

fn ensure_default_queue(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let queue = Queue {
        version: 1,
        launch_app: true,
        retry_policy: RetryPolicy::default(),
        tasks: Vec::new(),
    };
    match create_queue_file_if_missing(path, &queue).map_err(|error| error.to_string())? {
        true => Ok(()),
        false => load_queue_file_with_revision(path)
            .map(|_| ())
            .map_err(|error| error.to_string()),
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn paths_resolve_to_same_path(target: &Path, revision_source: &Path) -> Result<bool, String> {
    let target_path = match std::fs::canonicalize(target) {
        Ok(target) => target,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if target == revision_source {
                return Err(revision_conflict_message(revision_source));
            }
            std::fs::canonicalize(revision_source).map_err(|source_error| {
                if source_error.kind() == std::io::ErrorKind::NotFound {
                    revision_conflict_message(revision_source)
                } else {
                    format!(
                        "cannot resolve queue path {}: {source_error}",
                        revision_source.display()
                    )
                }
            })?;
            return Ok(false);
        }
        Err(error) => {
            return Err(format!(
                "cannot resolve queue path {}: {error}",
                target.display()
            ));
        }
    };
    let revision_source_path = std::fs::canonicalize(revision_source).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            revision_conflict_message(revision_source)
        } else {
            format!(
                "cannot resolve queue path {}: {error}",
                revision_source.display()
            )
        }
    })?;
    Ok(target_path == revision_source_path)
}

fn revision_conflict_message(path: &Path) -> String {
    format!(
        "queue changed since it was loaded: {}; reload before saving",
        path.display()
    )
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use codex_queue_demo::{TaskStatus, parse_queue, save_queue_file};
    use serde_json::json;

    use super::{ensure_default_queue, load_queue, save_queue, snapshot_from_queue};

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

        let snapshot = snapshot_from_queue(Path::new("queue.json"), queue, "revision-1".to_owned())
            .expect("queue should be plannable");

        assert_eq!(snapshot.path, "queue.json");
        assert_eq!(snapshot.revision, "revision-1");
        assert_eq!(snapshot.ordered_ids, vec!["high", "low"]);
        assert!(snapshot.blocked.is_empty());
    }

    #[test]
    fn rejects_a_stale_command_save_and_preserves_scheduler_state() {
        let temp = tempfile::TempDir::new().expect("temp directory");
        let queue_path = temp.path().join("queue.json");
        let queue = parse_queue(
            &json!({
                "version": 1,
                "launchApp": false,
                "tasks": [task("scheduled-task", 10)]
            })
            .to_string(),
        )
        .expect("valid queue");
        save_queue_file(&queue_path, &queue).expect("seed queue");

        let mut stale = load_queue(queue_path.to_string_lossy().into_owned()).expect("load queue");
        let mut scheduler_queue = queue.clone();
        scheduler_queue.tasks[0].status = TaskStatus::Succeeded;
        save_queue_file(&queue_path, &scheduler_queue).expect("scheduler save");
        stale.queue.tasks[0].title = "Stale UI title".to_owned();

        let error = save_queue(
            temp.path()
                .join(".")
                .join("queue.json")
                .to_string_lossy()
                .into_owned(),
            stale.queue,
            Some(stale.revision),
            Some(queue_path.to_string_lossy().into_owned()),
        )
        .expect_err("stale command save must fail");

        assert!(error.contains("queue changed since it was loaded"));
        let preserved = codex_queue_demo::load_queue_file(&queue_path).expect("preserved queue");
        assert_eq!(preserved.tasks[0].status, TaskStatus::Succeeded);
        assert_eq!(preserved.tasks[0].title, "scheduled-task");
    }

    #[test]
    fn treats_a_different_hard_link_path_as_save_as() {
        let temp = tempfile::TempDir::new().expect("temp directory");
        let queue_path = temp.path().join("queue.json");
        let alias_path = temp.path().join("queue-alias.json");
        let mut queue = parse_queue(
            &json!({
                "version": 1,
                "launchApp": false,
                "tasks": [task("scheduled-task", 10)]
            })
            .to_string(),
        )
        .expect("valid queue");
        save_queue_file(&queue_path, &queue).expect("seed queue");
        std::fs::hard_link(&queue_path, &alias_path).expect("create hard link alias");
        let snapshot = load_queue(queue_path.to_string_lossy().into_owned()).expect("load queue");
        queue.tasks[0].title = "Edited title".to_owned();

        save_queue(
            alias_path.to_string_lossy().into_owned(),
            queue,
            Some(snapshot.revision),
            Some(queue_path.to_string_lossy().into_owned()),
        )
        .expect("a different path is a Save As destination");

        let original = codex_queue_demo::load_queue_file(&queue_path).expect("original queue");
        let saved_as = codex_queue_demo::load_queue_file(&alias_path).expect("saved-as queue");
        assert_eq!(original.tasks[0].title, "scheduled-task");
        assert_eq!(saved_as.tasks[0].title, "Edited title");
    }

    #[cfg(unix)]
    #[test]
    fn accepts_a_current_save_through_a_symlink_alias() {
        let temp = tempfile::TempDir::new().expect("temp directory");
        let queue_path = temp.path().join("queue.json");
        let alias_path = temp.path().join("queue-alias.json");
        let mut queue = parse_queue(
            &json!({
                "version": 1,
                "launchApp": false,
                "tasks": [task("scheduled-task", 10)]
            })
            .to_string(),
        )
        .expect("valid queue");
        save_queue_file(&queue_path, &queue).expect("seed queue");
        std::os::unix::fs::symlink(&queue_path, &alias_path).expect("create symlink alias");
        let snapshot = load_queue(queue_path.to_string_lossy().into_owned()).expect("load queue");
        queue.tasks[0].title = "Edited title".to_owned();

        save_queue(
            alias_path.to_string_lossy().into_owned(),
            queue,
            Some(snapshot.revision),
            Some(queue_path.to_string_lossy().into_owned()),
        )
        .expect("symlink aliases should resolve to the original queue path");

        let saved = codex_queue_demo::load_queue_file(&queue_path).expect("saved queue");
        assert_eq!(saved.tasks[0].title, "Edited title");
        assert!(alias_path.is_symlink());
    }

    #[test]
    fn does_not_recreate_a_deleted_revision_source() {
        let temp = tempfile::TempDir::new().expect("temp directory");
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
        save_queue_file(&queue_path, &queue).expect("seed queue");
        let stale = load_queue(queue_path.to_string_lossy().into_owned()).expect("load queue");
        std::fs::remove_file(&queue_path).expect("delete queue");

        let error = save_queue(
            queue_path.to_string_lossy().into_owned(),
            stale.queue,
            Some(stale.revision),
            Some(queue_path.to_string_lossy().into_owned()),
        )
        .expect_err("deleted revision source must not be recreated");

        assert!(error.contains("queue changed since it was loaded"));
        assert!(!queue_path.exists());
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

    #[cfg(unix)]
    #[test]
    fn rejects_a_dangling_default_queue_symlink() {
        let temp = tempfile::TempDir::new().expect("temp directory");
        let queue_path = temp.path().join("queue.json");
        std::os::unix::fs::symlink(temp.path().join("missing.json"), &queue_path)
            .expect("create dangling symlink");

        let error =
            ensure_default_queue(&queue_path).expect_err("a dangling queue symlink must fail");

        assert!(error.contains("cannot resolve queue path"));
        assert!(queue_path.is_symlink());
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
