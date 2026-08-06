use std::fs::{self, File};
use std::io::{self, Read};
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunSummary {
    pub id: String,
    pub attempt: u32,
    pub started_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunArtifact {
    pub content: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunOutput {
    pub run: TaskRunSummary,
    pub final_output: RunArtifact,
    pub events: RunArtifact,
    pub stderr: RunArtifact,
}

const MAX_ARTIFACT_BYTES: usize = 2 * 1024 * 1024;
const MAX_TASK_RUNS: usize = 100;

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
        let mut codex =
            CodexCli::discover(codex_bin.map(Into::into)).map_err(|error| error.to_string())?;
        run_queue_file(&path, WorkerOptions::default(), &mut codex)
            .map_err(|error| error.to_string())
    })
    .await;

    app.state::<RunState>()
        .running
        .store(false, Ordering::Release);
    task_result.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn list_task_runs(path: String, task_id: String) -> Result<Vec<TaskRunSummary>, String> {
    let (runs_directory, task_created_at) = resolve_runs_directory(Path::new(&path), &task_id)?;
    let Some(runs_directory) = runs_directory else {
        return Ok(Vec::new());
    };
    let mut runs = scan_task_runs(&runs_directory, &task_id, &task_created_at)?;
    sort_task_runs_newest(&mut runs);
    runs.truncate(MAX_TASK_RUNS);
    Ok(runs)
}

#[tauri::command]
pub fn read_task_run(
    path: String,
    task_id: String,
    run_id: String,
) -> Result<TaskRunOutput, String> {
    let not_found = || format!("run not found for task {task_id}: {run_id}");
    let (runs_directory, task_created_at) = resolve_runs_directory(Path::new(&path), &task_id)?;
    let Some(summary) = parse_task_run_id(&run_id, &task_id) else {
        return Err(not_found());
    };
    if &run_id[..16] < task_created_at.as_str() {
        return Err(not_found());
    }

    let runs_directory = runs_directory.ok_or_else(&not_found)?;
    let run_directory = canonical_run_directory(&runs_directory, &runs_directory.join(&run_id))
        .map_err(|_| not_found())?;

    Ok(TaskRunOutput {
        run: summary,
        final_output: read_run_artifact(&run_directory, "final.txt")?,
        events: read_run_artifact(&run_directory, "events.jsonl")?,
        stderr: read_run_artifact(&run_directory, "stderr.log")?,
    })
}

fn resolve_runs_directory(
    queue_path: &Path,
    task_id: &str,
) -> Result<(Option<PathBuf>, String), String> {
    let queue_path = fs::canonicalize(queue_path).map_err(|error| {
        format!(
            "cannot resolve queue path {}: {error}",
            queue_path.display()
        )
    })?;
    let queue = load_queue_file_with_revision(&queue_path)
        .map_err(|error| error.to_string())?
        .queue;
    let task = queue
        .tasks
        .iter()
        .find(|task| task.id == task_id)
        .ok_or_else(|| format!("task not found in queue: {task_id}"))?;
    let task_created_at = task.created_at.format("%Y%m%dT%H%M%SZ").to_string();

    let queue_directory = queue_path.parent().unwrap_or(Path::new("."));
    let runs_path = queue_directory.join("runs");
    let metadata = match fs::symlink_metadata(&runs_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok((None, task_created_at));
        }
        Err(error) => {
            return Err(format!(
                "cannot inspect runs directory {}: {error}",
                runs_path.display()
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "runs path must be a real directory: {}",
            runs_path.display()
        ));
    }

    let runs_directory = fs::canonicalize(&runs_path).map_err(|error| {
        format!(
            "cannot resolve runs directory {}: {error}",
            runs_path.display()
        )
    })?;
    if runs_directory.parent() != Some(queue_directory) {
        return Err(format!(
            "runs directory resolves outside the queue directory: {}",
            runs_path.display()
        ));
    }
    Ok((Some(runs_directory), task_created_at))
}

fn scan_task_runs(
    runs_directory: &Path,
    task_id: &str,
    task_created_at: &str,
) -> Result<Vec<TaskRunSummary>, String> {
    let entries = fs::read_dir(runs_directory).map_err(|error| {
        format!(
            "cannot read runs directory {}: {error}",
            runs_directory.display()
        )
    })?;
    let mut runs = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "cannot read an entry in {}: {error}",
                runs_directory.display()
            )
        })?;
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "cannot inspect run path {}: {error}",
                entry.path().display()
            )
        })?;
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let Some(run_id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(summary) = parse_task_run_id(&run_id, task_id) else {
            continue;
        };
        if &run_id[..16] < task_created_at {
            continue;
        }
        runs.push(summary);
        if runs.len() >= MAX_TASK_RUNS * 2 {
            sort_task_runs_newest(&mut runs);
            runs.truncate(MAX_TASK_RUNS);
        }
    }
    Ok(runs)
}

fn sort_task_runs_newest(runs: &mut [TaskRunSummary]) {
    runs.sort_by(|left, right| {
        right
            .started_at
            .cmp(&left.started_at)
            .then_with(|| right.id.cmp(&left.id))
    });
}

fn parse_task_run_id(run_id: &str, task_id: &str) -> Option<TaskRunSummary> {
    if !run_id.is_ascii()
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        || run_id.len() <= 17
    {
        return None;
    }

    let (timestamp, remainder) = run_id.split_at(16);
    let remainder = remainder.strip_prefix('-')?;
    let (run_task_id, attempt_and_suffix) = remainder.rsplit_once("-attempt-")?;
    if run_task_id != task_id {
        return None;
    }
    let (attempt, suffix) = attempt_and_suffix.split_once('-')?;
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return None;
    }
    let attempt = attempt.parse::<u32>().ok().filter(|attempt| *attempt > 0)?;
    let started_at = run_timestamp(timestamp)?;

    Some(TaskRunSummary {
        id: run_id.to_owned(),
        attempt,
        started_at,
    })
}

fn run_timestamp(timestamp: &str) -> Option<String> {
    let bytes = timestamp.as_bytes();
    if bytes.len() != 16
        || bytes[8] != b'T'
        || bytes[15] != b'Z'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| !matches!(index, 8 | 15) && !byte.is_ascii_digit())
    {
        return None;
    }

    let year = timestamp[0..4].parse::<u32>().ok()?;
    let month = timestamp[4..6].parse::<u32>().ok()?;
    let day = timestamp[6..8].parse::<u32>().ok()?;
    let hour = timestamp[9..11].parse::<u32>().ok()?;
    let minute = timestamp[11..13].parse::<u32>().ok()?;
    let second = timestamp[13..15].parse::<u32>().ok()?;
    if year == 0
        || !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }

    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"
    ))
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        _ => 31,
    }
}

fn canonical_run_directory(runs_directory: &Path, run_path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(run_path)
        .map_err(|error| format!("cannot inspect run path {}: {error}", run_path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "run path must be a real directory: {}",
            run_path.display()
        ));
    }
    let run_directory = fs::canonicalize(run_path)
        .map_err(|error| format!("cannot resolve run path {}: {error}", run_path.display()))?;
    if run_directory.parent() != Some(runs_directory) {
        return Err(format!(
            "run path resolves outside the runs directory: {}",
            run_path.display()
        ));
    }
    Ok(run_directory)
}

fn read_run_artifact(run_directory: &Path, file_name: &str) -> Result<RunArtifact, String> {
    let artifact_path = run_directory.join(file_name);
    let metadata = match fs::symlink_metadata(&artifact_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(RunArtifact {
                content: String::new(),
                truncated: false,
            });
        }
        Err(error) => {
            return Err(format!(
                "cannot inspect run artifact {}: {error}",
                artifact_path.display()
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "run artifact must be a regular file: {}",
            artifact_path.display()
        ));
    }

    let resolved_path = fs::canonicalize(&artifact_path).map_err(|error| {
        format!(
            "cannot resolve run artifact {}: {error}",
            artifact_path.display()
        )
    })?;
    if resolved_path.parent() != Some(run_directory) {
        return Err(format!(
            "run artifact resolves outside its run directory: {}",
            artifact_path.display()
        ));
    }

    let file = File::open(&resolved_path).map_err(|error| {
        format!(
            "cannot read run artifact {}: {error}",
            artifact_path.display()
        )
    })?;
    let mut bytes = Vec::with_capacity(MAX_ARTIFACT_BYTES + 1);
    file.take((MAX_ARTIFACT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            format!(
                "cannot read run artifact {}: {error}",
                artifact_path.display()
            )
        })?;

    let mut truncated = bytes.len() > MAX_ARTIFACT_BYTES;
    if truncated {
        bytes.truncate(MAX_ARTIFACT_BYTES);
    }
    let mut content = String::from_utf8_lossy(&bytes).into_owned();
    if content.len() > MAX_ARTIFACT_BYTES {
        let mut boundary = MAX_ARTIFACT_BYTES;
        while !content.is_char_boundary(boundary) {
            boundary -= 1;
        }
        content.truncate(boundary);
        truncated = true;
    }

    Ok(RunArtifact { content, truncated })
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

    use super::{
        MAX_ARTIFACT_BYTES, ensure_default_queue, list_task_runs, load_queue, read_task_run,
        save_queue, snapshot_from_queue,
    };

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
    fn lists_and_reads_task_outputs_newest_first() {
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

        let runs_path = temp.path().join("runs");
        let older_id = "20260730T010000Z-scheduled-task-attempt-1-older";
        let newer_id = "20260730T020000Z-scheduled-task-attempt-2-newer";
        let unrelated_id = "20260730T030000Z-other-task-attempt-1-unrelated";
        for run_id in [older_id, newer_id, unrelated_id] {
            std::fs::create_dir_all(runs_path.join(run_id)).expect("create run directory");
        }
        std::fs::write(runs_path.join(newer_id).join("final.txt"), "任务完成")
            .expect("write final output");
        std::fs::write(
            runs_path.join(newer_id).join("events.jsonl"),
            "{\"type\":\"turn.completed\"}\n",
        )
        .expect("write events");
        std::fs::write(runs_path.join(newer_id).join("stderr.log"), "").expect("write stderr");

        let runs = list_task_runs(
            queue_path.to_string_lossy().into_owned(),
            "scheduled-task".to_owned(),
        )
        .expect("list task runs");

        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].id, newer_id);
        assert_eq!(runs[0].attempt, 2);
        assert_eq!(runs[0].started_at, "2026-07-30T02:00:00Z");
        assert_eq!(runs[1].id, older_id);

        let output = read_task_run(
            queue_path.to_string_lossy().into_owned(),
            "scheduled-task".to_owned(),
            newer_id.to_owned(),
        )
        .expect("read task run");

        assert_eq!(output.run, runs[0]);
        assert_eq!(output.final_output.content, "任务完成");
        assert!(!output.final_output.truncated);
        assert_eq!(output.events.content, "{\"type\":\"turn.completed\"}\n");
        assert_eq!(output.stderr.content, "");
    }

    #[test]
    fn limits_task_run_history_to_the_latest_entries() {
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
        let runs_path = temp.path().join("runs");
        for index in 0..105 {
            let hour = index / 60;
            let minute = index % 60;
            let run_id =
                format!("20260730T{hour:02}{minute:02}00Z-scheduled-task-attempt-1-run{index:03}");
            std::fs::create_dir_all(runs_path.join(run_id)).expect("create run directory");
        }

        let runs = list_task_runs(
            queue_path.to_string_lossy().into_owned(),
            "scheduled-task".to_owned(),
        )
        .expect("list bounded task history");

        assert_eq!(runs.len(), 100);
        assert_eq!(
            runs.first().map(|run| run.id.as_str()),
            Some("20260730T014400Z-scheduled-task-attempt-1-run104")
        );
        assert_eq!(
            runs.last().map(|run| run.id.as_str()),
            Some("20260730T000500Z-scheduled-task-attempt-1-run005")
        );
    }

    #[test]
    fn rejects_a_run_that_does_not_belong_to_the_task() {
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
        std::fs::create_dir_all(
            temp.path()
                .join("runs")
                .join("20260730T010000Z-other-task-attempt-1-run"),
        )
        .expect("create unrelated run");

        let error = read_task_run(
            queue_path.to_string_lossy().into_owned(),
            "scheduled-task".to_owned(),
            "20260730T010000Z-other-task-attempt-1-run".to_owned(),
        )
        .expect_err("a task cannot read another task's output");

        assert!(error.contains("run not found for task scheduled-task"));
    }

    #[test]
    fn does_not_expose_runs_from_a_deleted_task_that_reused_the_same_id() {
        let temp = tempfile::TempDir::new().expect("temp directory");
        let queue_path = temp.path().join("queue.json");
        let mut reused_task = task("scheduled-task", 10);
        reused_task["createdAt"] = json!("2026-07-30T01:30:00Z");
        let queue = parse_queue(
            &json!({
                "version": 1,
                "launchApp": false,
                "tasks": [reused_task]
            })
            .to_string(),
        )
        .expect("valid queue");
        save_queue_file(&queue_path, &queue).expect("seed queue");
        std::fs::create_dir_all(
            temp.path()
                .join("runs")
                .join("20260730T010000Z-scheduled-task-attempt-1-old"),
        )
        .expect("create old run");

        let runs = list_task_runs(
            queue_path.to_string_lossy().into_owned(),
            "scheduled-task".to_owned(),
        )
        .expect("list task runs");

        assert!(runs.is_empty());
    }

    #[test]
    fn bounds_artifacts_read_over_the_tauri_ipc_boundary() {
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
        let run_id = "20260730T020000Z-scheduled-task-attempt-1-large";
        let run_path = temp.path().join("runs").join(run_id);
        std::fs::create_dir_all(&run_path).expect("create run directory");
        std::fs::write(
            run_path.join("final.txt"),
            vec![b'x'; MAX_ARTIFACT_BYTES + 64],
        )
        .expect("write large output");

        let output = read_task_run(
            queue_path.to_string_lossy().into_owned(),
            "scheduled-task".to_owned(),
            run_id.to_owned(),
        )
        .expect("read bounded task run");

        assert_eq!(output.final_output.content.len(), MAX_ARTIFACT_BYTES);
        assert!(output.final_output.truncated);
        assert_eq!(output.events.content, "");
        assert!(!output.events.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_path_traversal_and_symlinked_run_artifacts() {
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
        let traversal = read_task_run(
            queue_path.to_string_lossy().into_owned(),
            "scheduled-task".to_owned(),
            "../outside".to_owned(),
        )
        .expect_err("path traversal must not identify a run");
        assert!(traversal.contains("run not found for task scheduled-task"));

        let run_id = "20260730T020000Z-scheduled-task-attempt-1-symlink";
        let run_path = temp.path().join("runs").join(run_id);
        std::fs::create_dir_all(&run_path).expect("create run directory");
        let outside = temp.path().join("outside.txt");
        std::fs::write(&outside, "secret").expect("write outside artifact");
        std::os::unix::fs::symlink(&outside, run_path.join("final.txt"))
            .expect("create artifact symlink");

        let error = read_task_run(
            queue_path.to_string_lossy().into_owned(),
            "scheduled-task".to_owned(),
            run_id.to_owned(),
        )
        .expect_err("artifact symlinks must not be followed");

        assert!(error.contains("run artifact must be a regular file"));
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
