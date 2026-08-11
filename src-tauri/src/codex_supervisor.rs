use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use codex_queue_demo::{CodexCli, codex_thread_writer_available};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

const MAX_THREADS: usize = 50;
const MAX_EVENTS: usize = 30;
const MAX_OBJECTIVE_CHARS: usize = 1_000;
const MAX_TITLE_CHARS: usize = 100;
const MAX_ERROR_CHARS: usize = 500;
const STALE_AFTER_SECONDS: i64 = 15 * 60;
const MAX_RECOVERY_ATTEMPTS: u32 = 6;
const MAX_CONCURRENT_RECOVERIES: usize = 4;
const WATCH_INTERVAL: Duration = Duration::from_secs(3);
const RECOVERY_MARKER: &str = "[codex-queue recovery]";
const RECOVERY_PROMPT: &str = "[codex-queue recovery]\nContinue the existing active goal on this same thread. First inspect the current working tree, git diff, completed work, and test status. Do not repeat completed or irreversible actions. Continue from the first unfinished step. Before ending, verify the objective and mark the Thread Goal complete only when it is genuinely achieved; if blocked, record that status instead.";
const COMPLETION_PROMPT: &str = "[codex-queue completion]\nVerify the existing Thread Goal against the current workspace and relevant checks. If it is genuinely achieved, mark the goal complete. If it is not achieved, continue the unfinished work instead of claiming completion.";

#[derive(Clone, Default)]
pub struct CodexSupervisorState {
    cache: Arc<Mutex<HashMap<PathBuf, CachedRollout>>>,
    recoveries: Arc<Mutex<RecoveryGate>>,
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
    #[serde(skip)]
    goal_created_at_ms: i64,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    next_retry_at: Option<String>,
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
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Clone, Debug, Default)]
struct RolloutScan {
    turn_count: u32,
    recovery_turn_count: u32,
    recovery_goal_created_at_ms: i64,
    last_activity_at: i64,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RecoveryReason {
    TurnEnded,
    Stalled,
}

#[derive(Clone, Debug)]
struct RecoveryFailure {
    goal_created_at_ms: i64,
    count: u32,
    next_retry_at: i64,
    error: String,
}

#[derive(Debug, Default)]
struct RecoveryGate {
    active: HashSet<String>,
    failures: HashMap<String, RecoveryFailure>,
}

impl RecoveryGate {
    fn try_start(
        &mut self,
        thread_id: &str,
        goal_created_at_ms: i64,
        now: i64,
        force: bool,
    ) -> bool {
        if self.active.contains(thread_id) || self.active.len() >= MAX_CONCURRENT_RECOVERIES {
            return false;
        }
        if self
            .failures
            .get(thread_id)
            .is_some_and(|failure| failure.goal_created_at_ms != goal_created_at_ms)
        {
            self.failures.remove(thread_id);
        }
        if !force
            && self.failures.get(thread_id).is_some_and(|failure| {
                failure.count >= MAX_RECOVERY_ATTEMPTS || now < failure.next_retry_at
            })
        {
            return false;
        }
        self.active.insert(thread_id.to_owned())
    }

    fn finish(&mut self, thread_id: &str, goal_created_at_ms: i64, error: Option<&str>, now: i64) {
        self.active.remove(thread_id);
        let Some(error) = error else {
            self.failures.remove(thread_id);
            return;
        };
        let failure = self
            .failures
            .entry(thread_id.to_owned())
            .or_insert_with(|| RecoveryFailure {
                goal_created_at_ms,
                count: 0,
                next_retry_at: now,
                error: String::new(),
            });
        if failure.goal_created_at_ms != goal_created_at_ms {
            *failure = RecoveryFailure {
                goal_created_at_ms,
                count: 0,
                next_retry_at: now,
                error: String::new(),
            };
        }
        failure.count = failure.count.saturating_add(1);
        failure.next_retry_at = now.saturating_add(retry_delay_seconds(failure.count));
        failure.error = clamp_text(error, MAX_ERROR_CHARS);
    }
}

#[tauri::command]
pub async fn load_codex_supervisor(
    app: AppHandle,
    state: State<'_, CodexSupervisorState>,
) -> Result<SupervisorSnapshot, String> {
    let codex_home = codex_home(&app)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || load_with_recovery_state(&codex_home, &state))
        .await
        .map_err(|error| format!("Codex supervisor task failed: {error}"))?
}

#[tauri::command]
pub async fn resume_codex_thread(
    app: AppHandle,
    state: State<'_, CodexSupervisorState>,
    thread_id: String,
) -> Result<bool, String> {
    launch_for_thread(app, state.inner().clone(), thread_id, RECOVERY_PROMPT).await
}

#[tauri::command]
pub async fn complete_codex_goal(
    app: AppHandle,
    state: State<'_, CodexSupervisorState>,
    thread_id: String,
) -> Result<bool, String> {
    launch_for_thread(app, state.inner().clone(), thread_id, COMPLETION_PROMPT).await
}

pub fn start_watchdog(app: AppHandle, state: CodexSupervisorState) -> Result<(), String> {
    let codex_home = codex_home(&app)?;
    thread::Builder::new()
        .name("codex-queue-watchdog".to_owned())
        .spawn(move || {
            loop {
                // ponytail: four workers bound local resource use; add a pool only if this grows.
                let _ = watch_once(&codex_home, &state);
                thread::sleep(WATCH_INTERVAL);
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Cannot start Codex watchdog: {error}"))
}

async fn launch_for_thread(
    app: AppHandle,
    state: CodexSupervisorState,
    thread_id: String,
    prompt: &'static str,
) -> Result<bool, String> {
    let codex_home = codex_home(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = load_codex_supervisor_from_home(&codex_home, state.cache.as_ref())?;
        let job = snapshot
            .jobs
            .iter()
            .find(|job| job.thread_id == thread_id)
            .ok_or_else(|| format!("Codex thread not found: {thread_id}"))?;
        if job.goal.status == "complete" {
            return Err("Codex thread goal is already complete".to_owned());
        }
        if job.goal.status != "active" {
            return Err(format!(
                "Codex thread goal is not active: {}",
                job.goal.status
            ));
        }
        if !codex_thread_writer_available(&codex_home, &job.thread_id)
            .map_err(|error| format!("Cannot inspect Codex thread writer: {error:#}"))?
        {
            return Err("Codex thread still has an active writer".to_owned());
        }
        queue_recovery(&state, job, prompt, true).and_then(|started| {
            started
                .then_some(true)
                .ok_or_else(|| "Codex recovery is already running or at capacity".to_owned())
        })
    })
    .await
    .map_err(|error| format!("Codex recovery task failed: {error}"))?
}

fn codex_home(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(
            app.path()
                .home_dir()
                .map_err(|error| error.to_string())?
                .join(".codex"),
        ))
}

fn load_with_recovery_state(
    codex_home: &Path,
    state: &CodexSupervisorState,
) -> Result<SupervisorSnapshot, String> {
    let mut snapshot = load_codex_supervisor_from_home(codex_home, state.cache.as_ref())?;
    apply_recovery_state(&mut snapshot, state.recoveries.as_ref())?;
    Ok(snapshot)
}

fn watch_once(codex_home: &Path, state: &CodexSupervisorState) -> Result<bool, String> {
    let snapshot = load_codex_supervisor_from_home(codex_home, state.cache.as_ref())?;
    let mut started = false;
    for job in snapshot.jobs.iter().filter(|job| {
        job.goal.status == "active"
            && job.recovery_count < MAX_RECOVERY_ATTEMPTS
            && matches!(job.status, "waiting" | "provider_down" | "failed")
    }) {
        if !codex_thread_writer_available(codex_home, &job.thread_id)
            .map_err(|error| format!("Cannot inspect Codex thread writer: {error:#}"))?
        {
            continue;
        }
        started |= queue_recovery(state, job, RECOVERY_PROMPT, false)?;
    }
    Ok(started)
}

fn queue_recovery(
    state: &CodexSupervisorState,
    job: &SupervisorJob,
    prompt: &'static str,
    force: bool,
) -> Result<bool, String> {
    let now = Utc::now().timestamp();
    if !state
        .recoveries
        .lock()
        .map_err(|_| "Codex recovery lock is poisoned".to_owned())?
        .try_start(&job.thread_id, job.goal_created_at_ms, now, force)
    {
        return Ok(false);
    }

    let thread_id = job.thread_id.clone();
    let workspace = job.workspace.clone();
    let goal_created_at_ms = job.goal_created_at_ms;
    let worker_state = state.clone();
    let worker_thread_id = thread_id.clone();
    match thread::Builder::new()
        .name("codex-queue-recovery".to_owned())
        .spawn(move || {
            let result = CodexCli::discover(None).and_then(|codex| {
                codex.resume_thread(&worker_thread_id, Path::new(&workspace), prompt)
            });
            let error = result.as_ref().err().map(|error| format!("{error:#}"));
            if let Err(lock_error) = finish_recovery(
                &worker_state,
                &worker_thread_id,
                goal_created_at_ms,
                error.as_deref(),
            ) {
                eprintln!("{lock_error}");
            }
        }) {
        Ok(_) => Ok(true),
        Err(error) => {
            let error = format!("Cannot start Codex recovery worker: {error}");
            finish_recovery(state, &thread_id, goal_created_at_ms, Some(&error))?;
            Err(error)
        }
    }
}

fn finish_recovery(
    state: &CodexSupervisorState,
    thread_id: &str,
    goal_created_at_ms: i64,
    error: Option<&str>,
) -> Result<(), String> {
    state
        .recoveries
        .lock()
        .map_err(|_| "Codex recovery lock is poisoned".to_owned())?
        .finish(thread_id, goal_created_at_ms, error, Utc::now().timestamp());
    Ok(())
}

fn apply_recovery_state(
    snapshot: &mut SupervisorSnapshot,
    recoveries: &Mutex<RecoveryGate>,
) -> Result<(), String> {
    let mut gate = recoveries
        .lock()
        .map_err(|_| "Codex recovery lock is poisoned".to_owned())?;
    let active_goals = snapshot
        .jobs
        .iter()
        .filter(|job| job.goal.status == "active")
        .map(|job| (job.thread_id.clone(), job.goal_created_at_ms))
        .collect::<HashMap<_, _>>();
    gate.failures.retain(|thread_id, failure| {
        active_goals.get(thread_id) == Some(&failure.goal_created_at_ms)
    });

    for job in &mut snapshot.jobs {
        if job.goal.status == "complete" {
            continue;
        }
        if gate.active.contains(&job.thread_id) {
            job.status = "resuming";
            job.next_retry_at = None;
            job.last_error = None;
        } else if let Some(failure) = gate.failures.get(&job.thread_id) {
            job.recovery_count = job.recovery_count.max(failure.count);
            job.next_retry_at = Some(iso_from_seconds(failure.next_retry_at));
            job.last_error = Some(format!("Automatic recovery failed: {}", failure.error));
        }
    }
    let degraded = snapshot
        .jobs
        .iter()
        .any(|job| job.status == "provider_down" || job.status == "failed");
    snapshot.provider.state = if degraded { "degraded" } else { "healthy" };
    Ok(())
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
        let writer_available =
            codex_thread_writer_available(codex_home, &thread.id).unwrap_or(false);
        jobs.push(build_job(thread, goal, scan, writer_available));
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
            "SELECT thread_id, objective, status, token_budget, tokens_used, created_at_ms, updated_at_ms \
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
                    created_at_ms: row.get(5)?,
                    updated_at_ms: row.get(6)?,
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
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Cannot inspect {}: {error}", path.display()))?;
    let length = metadata.len();
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
    scan.last_activity_at = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(scan.last_activity_at);
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
            if let Some(message) = payload["message"].as_str() {
                if message.starts_with(RECOVERY_MARKER) {
                    scan.recovery_turn_count = scan.recovery_turn_count.saturating_add(1);
                }
                scan.latest_user_message = Some(normalize_text(message, MAX_OBJECTIVE_CHARS));
            }
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
                if scan.recovery_goal_created_at_ms != goal.created_at_ms {
                    scan.recovery_turn_count = 0;
                    scan.recovery_goal_created_at_ms = goal.created_at_ms;
                }
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
        created_at_ms: value["createdAt"].as_i64().unwrap_or_default() * 1_000,
        updated_at_ms: value["updatedAt"].as_i64().unwrap_or_default() * 1_000,
    })
}

fn build_job(
    thread: ThreadRecord,
    stored_goal: Option<&GoalRecord>,
    scan: RolloutScan,
    writer_available: bool,
) -> SupervisorJob {
    let current_goal = [stored_goal.cloned(), scan.goal.clone()]
        .into_iter()
        .flatten()
        .max_by_key(|goal| goal.updated_at_ms);
    let status = match recovery_reason(
        current_goal.as_ref().map(|goal| goal.status.as_str()),
        scan.lifecycle.as_ref(),
        scan.last_activity_at,
        Utc::now().timestamp(),
        writer_available,
        false,
    ) {
        Some(RecoveryReason::Stalled | RecoveryReason::TurnEnded) => {
            match job_status(current_goal.as_ref(), scan.lifecycle.as_ref()) {
                "provider_down" => "provider_down",
                "failed" => "failed",
                _ => "waiting",
            }
        }
        None => job_status(current_goal.as_ref(), scan.lifecycle.as_ref()),
    };
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
        goal_created_at_ms: current_goal
            .as_ref()
            .map(|goal| goal.created_at_ms)
            .unwrap_or_default(),
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
        max_attempts: MAX_RECOVERY_ATTEMPTS,
        turn_count: scan.turn_count,
        recovery_count: recovery_count_for_goal(current_goal.as_ref(), &scan),
        tokens_used,
        created_at: iso_from_seconds(thread.created_at),
        updated_at: iso_from_seconds(thread.updated_at),
        started_at,
        finished_at,
        last_error,
        next_retry_at: None,
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
    if goal.is_some_and(|goal| goal.status == "complete") {
        return "completed";
    }
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
        Some("blocked") => "failed",
        Some("usage_limited" | "budget_limited") => "waiting",
        Some("paused") => "paused",
        _ => "paused",
    }
}

fn recovery_reason(
    goal_status: Option<&str>,
    lifecycle: Option<&Lifecycle>,
    last_activity_at: i64,
    now: i64,
    writer_available: bool,
    recovery_in_progress: bool,
) -> Option<RecoveryReason> {
    if recovery_in_progress || !writer_available || goal_status != Some("active") {
        return None;
    }
    match lifecycle {
        Some(Lifecycle::Running { .. })
            if now.saturating_sub(last_activity_at) > STALE_AFTER_SECONDS =>
        {
            Some(RecoveryReason::Stalled)
        }
        Some(Lifecycle::Completed { .. } | Lifecycle::Aborted { .. }) => {
            Some(RecoveryReason::TurnEnded)
        }
        _ => None,
    }
}

fn recovery_count_for_goal(goal: Option<&GoalRecord>, scan: &RolloutScan) -> u32 {
    // Rollout goal events use seconds while the goals database preserves milliseconds.
    goal.filter(|goal| {
        goal.created_at_ms > 0
            && scan.recovery_goal_created_at_ms > 0
            && goal.created_at_ms.div_euclid(1_000)
                == scan.recovery_goal_created_at_ms.div_euclid(1_000)
    })
    .map(|_| scan.recovery_turn_count)
    .unwrap_or_default()
}

fn retry_delay_seconds(attempt: u32) -> i64 {
    (30_i64.saturating_mul(1_i64 << attempt.saturating_sub(1).min(5))).min(900)
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
        assert_eq!(failed.jobs[0].recovery_count, 0);
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

    #[test]
    fn completed_goal_wins_over_every_lifecycle_and_never_recovers() {
        let goal = test_goal("complete");
        let lifecycles = [
            Lifecycle::Running {
                turn_id: "running".to_owned(),
                started_at: 0,
                objective: None,
            },
            Lifecycle::Completed {
                started_at: 0,
                completed_at: 1,
                error: Some("failed".to_owned()),
                provider_error: false,
                objective: None,
            },
            Lifecycle::Aborted {
                started_at: 0,
                completed_at: 1,
                objective: None,
            },
        ];

        for lifecycle in &lifecycles {
            assert_eq!(job_status(Some(&goal), Some(lifecycle)), "completed");
            assert_eq!(
                recovery_reason(Some("complete"), Some(lifecycle), 0, 901, true, false),
                None
            );
        }
    }

    #[test]
    fn active_goal_recovers_after_any_ended_turn() {
        let lifecycles = [
            Lifecycle::Completed {
                started_at: 0,
                completed_at: 1,
                error: Some("503 Service Unavailable".to_owned()),
                provider_error: true,
                objective: None,
            },
            Lifecycle::Aborted {
                started_at: 0,
                completed_at: 1,
                objective: None,
            },
            Lifecycle::Completed {
                started_at: 0,
                completed_at: 1,
                error: None,
                provider_error: false,
                objective: None,
            },
        ];

        for lifecycle in &lifecycles {
            assert_eq!(
                recovery_reason(Some("active"), Some(lifecycle), 1, 1, true, false),
                Some(RecoveryReason::TurnEnded)
            );
        }
    }

    #[test]
    fn running_goal_recovers_only_after_fifteen_idle_minutes_without_a_live_writer() {
        let lifecycle = Lifecycle::Running {
            turn_id: "running".to_owned(),
            started_at: 0,
            objective: None,
        };

        assert_eq!(
            recovery_reason(Some("active"), Some(&lifecycle), 0, 901, false, false),
            None
        );
        assert_eq!(
            recovery_reason(Some("active"), Some(&lifecycle), 0, 900, true, false),
            None
        );
        assert_eq!(
            recovery_reason(Some("active"), Some(&lifecycle), 0, 901, true, false),
            Some(RecoveryReason::Stalled)
        );
        assert_eq!(
            recovery_reason(Some("active"), Some(&lifecycle), 0, 901, true, true),
            None
        );
    }

    #[test]
    fn recovery_attempts_belong_only_to_the_current_goal() {
        let mut scan = RolloutScan {
            recovery_turn_count: 6,
            recovery_goal_created_at_ms: 1_000,
            ..RolloutScan::default()
        };
        let mut goal = test_goal("active");
        goal.created_at_ms = 2_000;

        assert_eq!(recovery_count_for_goal(Some(&goal), &scan), 0);
        goal.created_at_ms = 1_000;
        assert_eq!(recovery_count_for_goal(Some(&goal), &scan), 6);

        scan.recovery_turn_count = 0;
        assert_eq!(recovery_count_for_goal(Some(&goal), &scan), 0);

        scan.recovery_goal_created_at_ms = 2_000;
        assert_eq!(recovery_count_for_goal(Some(&goal), &scan), 0);
    }

    #[test]
    fn recovery_attempts_match_database_milliseconds_to_rollout_seconds() {
        let scan = RolloutScan {
            recovery_turn_count: 6,
            recovery_goal_created_at_ms: 1_786_423_719_000,
            ..RolloutScan::default()
        };
        let mut goal = test_goal("active");
        goal.created_at_ms = 1_786_423_719_052;

        assert_eq!(recovery_count_for_goal(Some(&goal), &scan), 6);
    }

    #[test]
    fn recovery_gate_deduplicates_and_backs_off_failures() {
        let mut gate = RecoveryGate::default();

        assert!(gate.try_start("thread-main", 1_000, 0, false));
        assert!(!gate.try_start("thread-main", 1_000, 0, false));
        gate.finish("thread-main", 1_000, Some("provider unavailable"), 0);
        assert!(!gate.try_start("thread-main", 1_000, 29, false));
        assert!(gate.try_start("thread-main", 1_000, 30, false));
        gate.finish("thread-main", 1_000, None, 30);
        assert!(gate.try_start("thread-main", 1_000, 30, false));
    }

    #[test]
    fn recovery_gate_does_not_carry_failures_into_a_new_goal() {
        let mut gate = RecoveryGate::default();

        assert!(gate.try_start("thread-main", 1_000, 0, false));
        gate.finish("thread-main", 1_000, Some("provider unavailable"), 0);
        assert!(!gate.try_start("thread-main", 1_000, 1, false));
        assert!(gate.try_start("thread-main", 2_000, 1, false));
    }

    #[test]
    fn recovery_gate_caps_parallel_workers() {
        let mut gate = RecoveryGate::default();
        for index in 0..4 {
            assert!(gate.try_start(&format!("thread-{index}"), 1_000, 0, false));
        }
        assert!(!gate.try_start("thread-4", 1_000, 0, false));
        gate.finish("thread-0", 1_000, None, 0);
        assert!(gate.try_start("thread-4", 1_000, 0, false));
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
                    token_budget INTEGER, tokens_used INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, \
                    updated_at_ms INTEGER NOT NULL\
                );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO thread_goals VALUES (?1, ?2, ?3, NULL, 1200, ?4, ?4)",
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

    fn test_goal(status: &str) -> GoalRecord {
        GoalRecord {
            objective: "Finish the task".to_owned(),
            status: status.to_owned(),
            token_budget: None,
            tokens_used: 0,
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }
}
