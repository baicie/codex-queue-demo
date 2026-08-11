use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

const MAX_THREADS: usize = 50;
const MAX_EVENTS: usize = 30;
const MAX_OBJECTIVE_CHARS: usize = 1_000;
const MAX_TITLE_CHARS: usize = 100;
const MAX_ERROR_CHARS: usize = 500;

#[derive(Clone, Default)]
pub struct CodexSupervisorState {
    cache: Arc<Mutex<HashMap<PathBuf, CachedRollout>>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorSnapshot {
    version: u8,
    source: &'static str,
    read_only: bool,
    selected_job_id: Option<String>,
    provider: ProviderHealth,
    jobs: Vec<SupervisorJob>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderHealth {
    name: &'static str,
    base_url: String,
    state: &'static str,
    latency_ms: Option<u64>,
    checked_at: String,
    message: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorJob {
    id: String,
    title: String,
    thread_id: String,
    workspace: String,
    original_goal: String,
    goal: SupervisorGoal,
    status: &'static str,
    attempts: u32,
    max_attempts: u32,
    turn_count: u32,
    recovery_count: u32,
    tokens_used: u64,
    created_at: String,
    updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    events: Vec<SupervisorEvent>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorGoal {
    objective: String,
    status: String,
    token_budget: u64,
}

#[derive(Clone, Debug, Serialize)]
struct SupervisorEvent {
    id: String,
    at: String,
    kind: String,
    title: String,
    detail: String,
}

#[derive(Clone, Debug)]
struct ThreadRecord {
    id: String,
    rollout_path: PathBuf,
    created_at: i64,
    updated_at: i64,
    cwd: String,
    title: String,
    tokens_used: u64,
}

#[derive(Clone, Debug)]
struct GoalRecord {
    objective: String,
    status: String,
    token_budget: Option<u64>,
    tokens_used: u64,
    updated_at_ms: i64,
}

#[derive(Clone, Debug, Default)]
struct RolloutScan {
    turn_count: u32,
    provider_failure_count: u32,
    latest_user_message: Option<String>,
    lifecycle: Option<Lifecycle>,
    goal: Option<GoalRecord>,
    events: VecDeque<SupervisorEvent>,
}

#[derive(Clone, Debug)]
struct CachedRollout {
    length: u64,
    partial_line: String,
    scan: RolloutScan,
}

#[derive(Clone, Debug)]
enum Lifecycle {
    Running {
        turn_id: String,
        started_at: i64,
        objective: Option<String>,
    },
    Completed {
        started_at: i64,
        completed_at: i64,
        error: Option<String>,
        provider_error: bool,
        objective: Option<String>,
    },
    Aborted {
        started_at: i64,
        completed_at: i64,
        objective: Option<String>,
    },
}

#[tauri::command]
pub async fn load_codex_supervisor(
    app: AppHandle,
    state: State<'_, CodexSupervisorState>,
) -> Result<SupervisorSnapshot, String> {
    let codex_home = env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(
            app.path()
                .home_dir()
                .map_err(|error| error.to_string())?
                .join(".codex"),
        );
    let cache = Arc::clone(&state.cache);
    tauri::async_runtime::spawn_blocking(move || {
        load_codex_supervisor_from_home(&codex_home, cache.as_ref())
    })
    .await
    .map_err(|error| format!("Codex supervisor task failed: {error}"))?
}

fn load_codex_supervisor_from_home(
    codex_home: &Path,
    cache: &Mutex<HashMap<PathBuf, CachedRollout>>,
) -> Result<SupervisorSnapshot, String> {
    let state_db = latest_versioned_database(codex_home, "state_")?
        .ok_or_else(|| format!("Codex state database not found in {}", codex_home.display()))?;
    let threads = load_threads(&state_db)?;
    let goals = latest_versioned_database(codex_home, "goals_")?
        .map(|path| load_goals(&path))
        .transpose()?
        .unwrap_or_default();

    let mut cache = cache
        .lock()
        .map_err(|_| "Codex task cache lock is poisoned".to_owned())?;
    let active_rollout_paths = threads
        .iter()
        .map(|thread| thread.rollout_path.clone())
        .collect::<HashSet<_>>();
    let mut jobs = Vec::with_capacity(threads.len());
    for thread in threads {
        let scan = inspect_rollout(&thread.rollout_path, &mut cache).unwrap_or_default();
        let goal = goals.get(&thread.id);
        jobs.push(build_job(thread, goal, scan));
    }

    cache.retain(|path, _| active_rollout_paths.contains(path));
    jobs.sort_by_key(|job| status_rank(job.status));
    let selected_job_id = jobs
        .iter()
        .find(|job| job.status == "running")
        .or_else(|| jobs.first())
        .map(|job| job.id.clone());
    let degraded = jobs
        .iter()
        .any(|job| job.status == "provider_down" || job.status == "failed");

    Ok(SupervisorSnapshot {
        version: 1,
        source: "codex",
        read_only: true,
        selected_job_id,
        provider: ProviderHealth {
            name: "Codex Desktop",
            base_url: codex_home.display().to_string(),
            state: if degraded { "degraded" } else { "healthy" },
            latency_ms: None,
            checked_at: now_iso(),
            message: "Local Codex sessions",
        },
        jobs,
    })
}

fn load_threads(path: &Path) -> Result<Vec<ThreadRecord>, String> {
    let connection = open_read_only(path)?;
    let mut statement = connection
        .prepare(
            "SELECT id, rollout_path, created_at, updated_at, cwd, title, tokens_used, source \
             FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?1",
        )
        .map_err(|error| format!("Cannot query {}: {error}", path.display()))?;
    let rows = statement
        .query_map([MAX_THREADS as i64 * 2], |row| {
            Ok((
                ThreadRecord {
                    id: row.get(0)?,
                    rollout_path: PathBuf::from(row.get::<_, String>(1)?),
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    cwd: row.get(4)?,
                    title: row.get(5)?,
                    tokens_used: row.get::<_, i64>(6)?.max(0) as u64,
                },
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;

    let mut threads = Vec::new();
    for row in rows {
        let (thread, source) = row.map_err(|error| error.to_string())?;
        if !source.to_ascii_lowercase().contains("subagent") {
            threads.push(thread);
        }
        if threads.len() == MAX_THREADS {
            break;
        }
    }
    Ok(threads)
}

fn load_goals(path: &Path) -> Result<HashMap<String, GoalRecord>, String> {
    let connection = open_read_only(path)?;
    let mut statement = connection
        .prepare(
            "SELECT thread_id, objective, status, token_budget, tokens_used, updated_at_ms \
             FROM thread_goals",
        )
        .map_err(|error| format!("Cannot query {}: {error}", path.display()))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                GoalRecord {
                    objective: row.get(1)?,
                    status: row.get(2)?,
                    token_budget: row
                        .get::<_, Option<i64>>(3)?
                        .map(|value| value.max(0) as u64),
                    tokens_used: row.get::<_, i64>(4)?.max(0) as u64,
                    updated_at_ms: row.get(5)?,
                },
            ))
        })
        .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| error.to_string())
}

fn open_read_only(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Cannot open {}: {error}", path.display()))?;
    connection
        .busy_timeout(Duration::from_millis(250))
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn latest_versioned_database(home: &Path, prefix: &str) -> Result<Option<PathBuf>, String> {
    let entries = fs::read_dir(home)
        .map_err(|error| format!("Cannot read Codex home {}: {error}", home.display()))?;
    let mut candidates = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(version) = name
            .strip_prefix(prefix)
            .and_then(|value| value.strip_suffix(".sqlite"))
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        candidates.push((version, entry.path()));
    }
    Ok(candidates
        .into_iter()
        .max_by_key(|(version, _)| *version)
        .map(|(_, path)| path))
}

fn inspect_rollout(
    path: &Path,
    cache: &mut HashMap<PathBuf, CachedRollout>,
) -> Result<RolloutScan, String> {
    let length = fs::metadata(path)
        .map_err(|error| format!("Cannot inspect {}: {error}", path.display()))?
        .len();
    if let Some(cached) = cache.get(path)
        && cached.length == length
    {
        return Ok(cached.scan.clone());
    }

    let (offset, mut scan, prefix) = match cache.get(path) {
        Some(cached) if length >= cached.length => (
            cached.length,
            cached.scan.clone(),
            cached.partial_line.clone(),
        ),
        _ => (0, RolloutScan::default(), String::new()),
    };
    let mut file =
        File::open(path).map_err(|error| format!("Cannot open {}: {error}", path.display()))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut appended = String::new();
    file.read_to_string(&mut appended)
        .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    let input = prefix + &appended;
    let (complete, partial_line) = split_complete_lines(input);
    for line in complete.lines() {
        update_scan(&mut scan, line);
    }
    cache.insert(
        path.to_path_buf(),
        CachedRollout {
            length,
            partial_line,
            scan: scan.clone(),
        },
    );
    Ok(scan)
}

fn split_complete_lines(mut input: String) -> (String, String) {
    if input.ends_with('\n') {
        return (input, String::new());
    }
    match input.rfind('\n') {
        Some(index) => {
            let partial = input.split_off(index + 1);
            (input, partial)
        }
        None => (String::new(), input),
    }
}

fn update_scan(scan: &mut RolloutScan, line: &str) {
    if !line.contains("\"type\":\"event_msg\"") {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let payload = &value["payload"];
    let Some(kind) = payload["type"].as_str() else {
        return;
    };
    let at = value["timestamp"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(now_iso);

    match kind {
        "user_message" => {
            scan.latest_user_message = payload["message"]
                .as_str()
                .map(|message| normalize_text(message, MAX_OBJECTIVE_CHARS));
        }
        "task_started" => {
            scan.turn_count = scan.turn_count.saturating_add(1);
            let turn_id = string_field(payload, "turn_id", "unknown-turn");
            let started_at = payload["started_at"].as_i64().unwrap_or_default();
            scan.lifecycle = Some(Lifecycle::Running {
                turn_id: turn_id.clone(),
                started_at,
                objective: scan.latest_user_message.clone(),
            });
            push_event(
                scan,
                SupervisorEvent {
                    id: format!("{turn_id}-started"),
                    at,
                    kind: "turn_started".to_owned(),
                    title: "Turn started".to_owned(),
                    detail: format!("Codex started turn {turn_id}."),
                },
            );
        }
        "task_complete" => {
            let turn_id = string_field(payload, "turn_id", "unknown-turn");
            let started_at = payload["started_at"].as_i64().unwrap_or_default();
            let completed_at = payload["completed_at"].as_i64().unwrap_or_default();
            let error = payload["error"]["message"]
                .as_str()
                .map(|message| clamp_text(message, MAX_ERROR_CHARS));
            let provider_error = payload.get("error").is_some_and(is_provider_error);
            if provider_error {
                scan.provider_failure_count = scan.provider_failure_count.saturating_add(1);
            }
            scan.lifecycle = Some(Lifecycle::Completed {
                started_at,
                completed_at,
                error: error.clone(),
                provider_error,
                objective: lifecycle_objective(scan, &turn_id),
            });
            let (event_kind, title, detail) = match error {
                Some(error) if provider_error => {
                    ("provider_down", "Provider request failed", error)
                }
                Some(error) => ("turn_failed", "Turn failed", error),
                None => (
                    "turn_completed",
                    "Turn completed",
                    format!("Codex completed turn {turn_id}."),
                ),
            };
            push_event(
                scan,
                SupervisorEvent {
                    id: format!("{turn_id}-completed"),
                    at,
                    kind: event_kind.to_owned(),
                    title: title.to_owned(),
                    detail,
                },
            );
        }
        "turn_aborted" => {
            let turn_id = string_field(payload, "turn_id", "unknown-turn");
            let started_at = payload["started_at"].as_i64().unwrap_or_default();
            let completed_at = payload["completed_at"].as_i64().unwrap_or_default();
            scan.lifecycle = Some(Lifecycle::Aborted {
                started_at,
                completed_at,
                objective: lifecycle_objective(scan, &turn_id),
            });
            push_event(
                scan,
                SupervisorEvent {
                    id: format!("{turn_id}-aborted"),
                    at,
                    kind: "turn_interrupted".to_owned(),
                    title: "Turn interrupted".to_owned(),
                    detail: format!("Codex interrupted turn {turn_id}."),
                },
            );
        }
        "thread_goal_updated" => {
            if let Some(goal) = parse_goal(&payload["goal"]) {
                scan.goal = Some(goal);
            }
        }
        _ => {}
    }
}

fn lifecycle_objective(scan: &RolloutScan, turn_id: &str) -> Option<String> {
    match scan.lifecycle.as_ref() {
        Some(Lifecycle::Running {
            turn_id: active_id,
            objective,
            ..
        }) if active_id == turn_id => objective.clone(),
        _ => scan.latest_user_message.clone(),
    }
}

fn parse_goal(value: &Value) -> Option<GoalRecord> {
    Some(GoalRecord {
        objective: value["objective"].as_str()?.to_owned(),
        status: value["status"].as_str()?.to_owned(),
        token_budget: value["tokenBudget"].as_u64(),
        tokens_used: value["tokensUsed"].as_u64().unwrap_or_default(),
        updated_at_ms: value["updatedAt"].as_i64().unwrap_or_default() * 1_000,
    })
}

fn build_job(
    thread: ThreadRecord,
    stored_goal: Option<&GoalRecord>,
    scan: RolloutScan,
) -> SupervisorJob {
    let current_goal = [stored_goal.cloned(), scan.goal.clone()]
        .into_iter()
        .flatten()
        .max_by_key(|goal| goal.updated_at_ms);
    let status = job_status(current_goal.as_ref(), scan.lifecycle.as_ref());
    let original_goal = scan
        .lifecycle
        .as_ref()
        .and_then(Lifecycle::objective)
        .unwrap_or_else(|| normalize_text(&thread.title, MAX_OBJECTIVE_CHARS));
    let objective = current_goal
        .as_ref()
        .map(|goal| goal.objective.clone())
        .unwrap_or_else(|| original_goal.clone());
    let goal_status = if status == "running" {
        "active".to_owned()
    } else {
        current_goal
            .as_ref()
            .map(|goal| goal_status_for_ui(&goal.status))
            .unwrap_or_else(|| {
                if status == "completed" {
                    "complete"
                } else {
                    "paused"
                }
                .to_owned()
            })
    };
    let started_at = scan
        .lifecycle
        .as_ref()
        .map(|lifecycle| iso_from_seconds(lifecycle.started_at()));
    let finished_at = scan
        .lifecycle
        .as_ref()
        .and_then(Lifecycle::completed_at)
        .map(iso_from_seconds);
    let last_error = scan.lifecycle.as_ref().and_then(Lifecycle::error);
    let tokens_used = current_goal
        .as_ref()
        .map(|goal| goal.tokens_used)
        .unwrap_or(thread.tokens_used);

    SupervisorJob {
        id: thread.id.clone(),
        title: normalize_text(&thread.title, MAX_TITLE_CHARS),
        thread_id: thread.id,
        workspace: thread.cwd,
        original_goal,
        goal: SupervisorGoal {
            objective,
            status: goal_status,
            token_budget: current_goal
                .as_ref()
                .and_then(|goal| goal.token_budget)
                .unwrap_or_default(),
        },
        status,
        attempts: scan.turn_count,
        max_attempts: 0,
        turn_count: scan.turn_count,
        recovery_count: scan.provider_failure_count,
        tokens_used,
        created_at: iso_from_seconds(thread.created_at),
        updated_at: iso_from_seconds(thread.updated_at),
        started_at,
        finished_at,
        last_error,
        events: scan.events.into_iter().collect(),
    }
}

impl Lifecycle {
    fn started_at(&self) -> i64 {
        match self {
            Self::Running { started_at, .. }
            | Self::Completed { started_at, .. }
            | Self::Aborted { started_at, .. } => *started_at,
        }
    }

    fn completed_at(&self) -> Option<i64> {
        match self {
            Self::Running { .. } => None,
            Self::Completed { completed_at, .. } | Self::Aborted { completed_at, .. } => {
                Some(*completed_at)
            }
        }
    }

    fn objective(&self) -> Option<String> {
        match self {
            Self::Running { objective, .. }
            | Self::Completed { objective, .. }
            | Self::Aborted { objective, .. } => objective.clone(),
        }
    }

    fn error(&self) -> Option<String> {
        match self {
            Self::Completed { error, .. } => error.clone(),
            _ => None,
        }
    }
}

fn job_status(goal: Option<&GoalRecord>, lifecycle: Option<&Lifecycle>) -> &'static str {
    match lifecycle {
        Some(Lifecycle::Running { .. }) => return "running",
        Some(Lifecycle::Completed {
            error: Some(_),
            provider_error: true,
            ..
        }) => return "provider_down",
        Some(Lifecycle::Completed { error: Some(_), .. }) => return "failed",
        Some(Lifecycle::Aborted { .. }) => return "paused",
        _ => {}
    }
    match goal.map(|goal| goal.status.as_str()) {
        Some("complete") => "completed",
        Some("blocked") => "failed",
        Some("usage_limited" | "budget_limited") => "waiting",
        Some("paused") => "paused",
        _ => "paused",
    }
}

fn goal_status_for_ui(status: &str) -> String {
    match status {
        "usage_limited" => "usageLimited",
        "budget_limited" => "budgetLimited",
        value => value,
    }
    .to_owned()
}

fn push_event(scan: &mut RolloutScan, event: SupervisorEvent) {
    if scan.events.len() == MAX_EVENTS {
        scan.events.pop_front();
    }
    scan.events.push_back(event);
}

fn is_provider_error(error: &Value) -> bool {
    let text = error.to_string().to_ascii_lowercase();
    [
        "http_connection",
        "response_stream",
        "server_overloaded",
        "too_many_failed",
        "429",
        "503",
        "upstream",
        "provider",
        "stream disconnected",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn string_field(value: &Value, field: &str, fallback: &str) -> String {
    value[field].as_str().unwrap_or(fallback).to_owned()
}

fn normalize_text(value: &str, max_chars: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    clamp_text(&normalized, max_chars)
}

fn clamp_text(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let mut output = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        output.push_str("...");
    }
    output
}

fn status_rank(status: &str) -> u8 {
    match status {
        "running" => 0,
        "provider_down" | "waiting" => 1,
        "failed" => 2,
        "paused" => 3,
        "completed" => 4,
        _ => 5,
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn iso_from_seconds(value: i64) -> String {
    DateTime::<Utc>::from_timestamp(value, 0)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use std::fs::OpenOptions;
    use std::io::Write;

    use rusqlite::params;
    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn discovers_a_running_codex_thread_and_filters_subagents() {
        let directory = tempdir().unwrap();
        let rollout = directory.path().join("rollout-thread-main.jsonl");
        write_events(
            &rollout,
            &[
                json!({"timestamp":"2026-08-11T00:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"Fix the live task list"}}),
                json!({"timestamp":"2026-08-11T00:00:01Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1786406401}}),
            ],
        );
        create_state_database(
            directory.path(),
            &[
                TestThread::main("thread-main", &rollout),
                TestThread::subagent("thread-child", &rollout),
            ],
        );
        create_goal_database(
            directory.path(),
            "thread-main",
            "Ship live tasks",
            "active",
            1786406400000,
        );

        let cache = Mutex::new(HashMap::new());
        let snapshot = load_codex_supervisor_from_home(directory.path(), &cache).unwrap();

        assert_eq!(snapshot.jobs.len(), 1);
        assert_eq!(snapshot.selected_job_id.as_deref(), Some("thread-main"));
        assert_eq!(snapshot.jobs[0].status, "running");
        assert_eq!(snapshot.jobs[0].original_goal, "Fix the live task list");
        assert_eq!(snapshot.jobs[0].goal.objective, "Ship live tasks");
        assert_eq!(snapshot.jobs[0].tokens_used, 1_200);
        assert_eq!(snapshot.jobs[0].turn_count, 1);
    }

    #[test]
    fn incrementally_observes_provider_failure_and_goal_completion() {
        let directory = tempdir().unwrap();
        let rollout = directory.path().join("rollout-thread-main.jsonl");
        write_events(
            &rollout,
            &[
                json!({"timestamp":"2026-08-11T00:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"Publish the app"}}),
                json!({"timestamp":"2026-08-11T00:00:01Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","started_at":1786406401}}),
            ],
        );
        create_state_database(
            directory.path(),
            &[TestThread::main("thread-main", &rollout)],
        );
        create_goal_database(
            directory.path(),
            "thread-main",
            "Publish the app",
            "active",
            1786406400000,
        );
        let cache = Mutex::new(HashMap::new());

        let first = load_codex_supervisor_from_home(directory.path(), &cache).unwrap();
        assert_eq!(first.jobs[0].status, "running");

        append_event(
            &rollout,
            json!({"timestamp":"2026-08-11T00:00:03Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","started_at":1786406401,"completed_at":1786406403,"error":{"message":"503 Service Unavailable","codex_error_info":"server_overloaded"}}}),
        );
        let failed = load_codex_supervisor_from_home(directory.path(), &cache).unwrap();
        assert_eq!(failed.jobs[0].status, "provider_down");
        assert_eq!(failed.jobs[0].turn_count, 1);
        assert_eq!(
            failed.jobs[0].last_error.as_deref(),
            Some("503 Service Unavailable")
        );

        update_goal(directory.path(), "thread-main", "complete", 1786406404000);
        append_event(
            &rollout,
            json!({"timestamp":"2026-08-11T00:00:04Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-2","started_at":1786406404}}),
        );
        append_event(
            &rollout,
            json!({"timestamp":"2026-08-11T00:00:05Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-2","started_at":1786406404,"completed_at":1786406405,"last_agent_message":"done"}}),
        );
        let completed = load_codex_supervisor_from_home(directory.path(), &cache).unwrap();
        assert_eq!(completed.jobs[0].status, "completed");
        assert_eq!(completed.jobs[0].goal.status, "complete");
        assert_eq!(completed.jobs[0].turn_count, 2);
    }

    struct TestThread<'a> {
        id: &'a str,
        rollout: &'a Path,
        source: &'a str,
    }

    impl<'a> TestThread<'a> {
        fn main(id: &'a str, rollout: &'a Path) -> Self {
            Self {
                id,
                rollout,
                source: "vscode",
            }
        }

        fn subagent(id: &'a str, rollout: &'a Path) -> Self {
            Self {
                id,
                rollout,
                source: "{\"subagent\":{}}",
            }
        }
    }

    fn create_state_database(home: &Path, threads: &[TestThread<'_>]) {
        let connection = Connection::open(home.join("state_5.sqlite")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (\
                    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, \
                    updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL, \
                    cwd TEXT NOT NULL, title TEXT NOT NULL, tokens_used INTEGER NOT NULL, archived INTEGER NOT NULL\
                );",
            )
            .unwrap();
        for thread in threads {
            connection
                .execute(
                    "INSERT INTO threads VALUES (?1, ?2, 1786406300, 1786406405, ?3, 'custom', '/workspace', 'Live task', 1234, 0)",
                    params![thread.id, thread.rollout.display().to_string(), thread.source],
                )
                .unwrap();
        }
    }

    fn create_goal_database(
        home: &Path,
        thread_id: &str,
        objective: &str,
        status: &str,
        updated_at_ms: i64,
    ) {
        let connection = Connection::open(home.join("goals_1.sqlite")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE thread_goals (\
                    thread_id TEXT PRIMARY KEY, objective TEXT NOT NULL, status TEXT NOT NULL, \
                    token_budget INTEGER, tokens_used INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL\
                );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO thread_goals VALUES (?1, ?2, ?3, NULL, 1200, ?4)",
                params![thread_id, objective, status, updated_at_ms],
            )
            .unwrap();
    }

    fn update_goal(home: &Path, thread_id: &str, status: &str, updated_at_ms: i64) {
        let connection = Connection::open(home.join("goals_1.sqlite")).unwrap();
        connection
            .execute(
                "UPDATE thread_goals SET status = ?2, updated_at_ms = ?3 WHERE thread_id = ?1",
                params![thread_id, status, updated_at_ms],
            )
            .unwrap();
    }

    fn write_events(path: &Path, events: &[Value]) {
        let mut file = File::create(path).unwrap();
        for event in events {
            writeln!(file, "{event}").unwrap();
        }
    }

    fn append_event(path: &Path, event: Value) {
        let mut file = OpenOptions::new().append(true).open(path).unwrap();
        writeln!(file, "{event}").unwrap();
    }
}
