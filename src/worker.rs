use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use anyhow::Result;
use chrono::{Duration as ChronoDuration, Utc};
use fs2::FileExt;
use sha2::{Digest, Sha256};
use tempfile::{Builder, NamedTempFile};
use thiserror::Error;

use crate::{
    BlockedReason, Queue, QueueError, RetryPolicy, Task, TaskStatus, build_execution_plan,
    parse_queue, validate_queue,
};

#[derive(Debug, Error)]
#[error("{message}")]
pub struct TransientTaskError {
    message: String,
}

impl TransientTaskError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub trait QueueRunner {
    fn launch_app(&mut self, workspace: &Path) -> Result<()>;

    fn execute_task(&mut self, task: &Task, workspace: &Path, run_directory: &Path) -> Result<()>;

    fn wait_before_retry(&mut self, delay: Duration) {
        thread::sleep(delay);
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct WorkerOptions {
    pub dry_run: bool,
}

#[derive(Clone, Debug)]
pub struct QueueFileSnapshot {
    pub queue: Queue,
    pub revision: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub planned_ids: Vec<String>,
    pub succeeded_ids: Vec<String>,
    pub failed_ids: Vec<String>,
    pub blocked_ids: Vec<String>,
}

#[derive(Debug, Error)]
pub enum WorkerError {
    #[error("cannot resolve queue path {path}: {source}")]
    ResolveQueue { path: PathBuf, source: io::Error },
    #[error("cannot read {path}: {source}")]
    Read { path: PathBuf, source: io::Error },
    #[error("cannot write {path}: {source}")]
    Write { path: PathBuf, source: io::Error },
    #[error("another queue worker already holds {0}")]
    AlreadyRunning(PathBuf),
    #[error("cannot lock {path}: {source}")]
    Lock { path: PathBuf, source: io::Error },
    #[error("queue changed since it was loaded: {path}; reload before saving")]
    RevisionConflict {
        path: PathBuf,
        expected_revision: String,
        actual_revision: String,
    },
    #[error(transparent)]
    Queue(#[from] QueueError),
    #[error("cannot serialize queue: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("cannot launch Codex app: {0}")]
    Launch(anyhow::Error),
    #[error("task {task_id} has reached the maximum attempt count")]
    AttemptOverflow { task_id: String },
}

pub fn load_queue_file(queue_path: &Path) -> Result<Queue, WorkerError> {
    Ok(load_queue_file_with_revision(queue_path)?.queue)
}

pub fn load_queue_file_with_revision(queue_path: &Path) -> Result<QueueFileSnapshot, WorkerError> {
    let queue_path = fs::canonicalize(queue_path).map_err(|source| WorkerError::ResolveQueue {
        path: queue_path.to_path_buf(),
        source,
    })?;
    let input = fs::read_to_string(&queue_path).map_err(|source| WorkerError::Read {
        path: queue_path,
        source,
    })?;
    Ok(QueueFileSnapshot {
        queue: parse_queue(&input)?,
        revision: queue_revision(input.as_bytes()),
    })
}

pub fn create_queue_file_if_missing(queue_path: &Path, queue: &Queue) -> Result<bool, WorkerError> {
    validate_queue(queue)?;
    let _lock = QueueLock::acquire(queue_path)?;
    let output = serialize_queue(queue)?;
    atomic_create(queue_path, |file| file.write_all(&output)).map_err(|source| WorkerError::Write {
        path: queue_path.to_path_buf(),
        source,
    })
}

pub fn save_queue_file(queue_path: &Path, queue: &Queue) -> Result<(), WorkerError> {
    validate_queue(queue)?;
    let _lock = QueueLock::acquire(queue_path)?;
    write_queue(queue_path, queue)
}

pub fn save_queue_file_if_revision(
    queue_path: &Path,
    queue: &Queue,
    expected_revision: &str,
) -> Result<QueueFileSnapshot, WorkerError> {
    validate_queue(queue)?;
    let queue_path = fs::canonicalize(queue_path).map_err(|source| WorkerError::ResolveQueue {
        path: queue_path.to_path_buf(),
        source,
    })?;
    let _lock = QueueLock::acquire(&queue_path)?;
    let input = fs::read(&queue_path).map_err(|source| WorkerError::Read {
        path: queue_path.clone(),
        source,
    })?;
    let actual_revision = queue_revision(&input);
    if actual_revision != expected_revision {
        return Err(WorkerError::RevisionConflict {
            path: queue_path,
            expected_revision: expected_revision.to_owned(),
            actual_revision,
        });
    }

    let output = serialize_queue(queue)?;
    write_queue_bytes(&queue_path, &output)?;
    Ok(QueueFileSnapshot {
        queue: queue.clone(),
        revision: queue_revision(&output),
    })
}

pub fn run_queue_file(
    queue_path: &Path,
    options: WorkerOptions,
    runner: &mut impl QueueRunner,
) -> Result<RunSummary, WorkerError> {
    let queue_path = fs::canonicalize(queue_path).map_err(|source| WorkerError::ResolveQueue {
        path: queue_path.to_path_buf(),
        source,
    })?;
    let queue_directory = queue_path.parent().unwrap_or(Path::new("."));
    let _lock = QueueLock::acquire(&queue_path)?;
    let input = fs::read_to_string(&queue_path).map_err(|source| WorkerError::Read {
        path: queue_path.clone(),
        source,
    })?;
    let mut queue = parse_queue(&input)?;
    let retry_state_changed = normalize_retry_state(&mut queue)?;
    let initial_plan = build_execution_plan(&queue)?;
    let mut summary = RunSummary {
        planned_ids: initial_plan.ordered_ids.clone(),
        failed_ids: queue
            .tasks
            .iter()
            .filter(|task| task.status == TaskStatus::Failed)
            .map(|task| task.id.clone())
            .collect(),
        blocked_ids: queue
            .tasks
            .iter()
            .filter(|task| task.status == TaskStatus::Blocked)
            .map(|task| task.id.clone())
            .chain(
                options
                    .dry_run
                    .then_some(&initial_plan.blocked)
                    .into_iter()
                    .flatten()
                    .map(|blocked| blocked.task_id.clone()),
            )
            .collect(),
        ..RunSummary::default()
    };

    if options.dry_run {
        return Ok(summary);
    }

    if retry_state_changed {
        write_queue(&queue_path, &queue)?;
    }

    if queue.launch_app {
        let first_task = initial_plan
            .ordered_ids
            .first()
            .and_then(|first_id| queue.tasks.iter().find(|task| &task.id == first_id));
        if let Some(task) = first_task {
            let workspace = resolve_workspace(queue_directory, &task.workspace);
            runner.launch_app(&workspace).map_err(WorkerError::Launch)?;
        }
    }

    loop {
        let plan = build_execution_plan(&queue)?;
        let mut queue_changed = false;

        for blocked in &plan.blocked {
            if let Some(task) = task_mut(&mut queue, &blocked.task_id) {
                task.status = TaskStatus::Blocked;
                task.finished_at = Some(Utc::now());
                task.last_error = None;
                task.blocked_reason = Some(BlockedReason {
                    reason_code: blocked.reason_code,
                    dependency_id: blocked.dependency_id.clone(),
                });
                task.next_retry_at = None;
                summary.blocked_ids.push(task.id.clone());
                queue_changed = true;
            }
        }

        if queue_changed {
            write_queue(&queue_path, &queue)?;
        }

        let now = Utc::now();
        let next_id = plan
            .ordered_ids
            .iter()
            .find(|task_id| task_is_ready(&queue, task_id, now))
            .cloned();
        let Some(next_id) = next_id else {
            let Some((task_id, retry_at)) = next_scheduled_retry(&queue, &plan, now) else {
                break;
            };
            wait_for_scheduled_retry(&queue_path, &mut queue, &task_id, retry_at, runner)?;
            continue;
        };

        let started_at = Utc::now();
        let task = task_mut(&mut queue, &next_id).expect("planned task must exist");
        task.status = TaskStatus::Running;
        task.attempts = Some(task.attempts.unwrap_or(0).checked_add(1).ok_or_else(|| {
            WorkerError::AttemptOverflow {
                task_id: task.id.clone(),
            }
        })?);
        task.started_at = Some(started_at);
        task.finished_at = None;
        task.last_error = None;
        task.blocked_reason = None;
        task.next_retry_at = None;
        let task_snapshot = task.clone();
        write_queue(&queue_path, &queue)?;

        let workspace = resolve_workspace(queue_directory, &task_snapshot.workspace);
        let attempt = task_snapshot.attempts.unwrap_or(1);
        let result = create_run_directory(queue_directory, started_at, &task_snapshot.id, attempt)
            .map_err(anyhow::Error::from)
            .and_then(|run_directory| {
                runner.execute_task(&task_snapshot, &workspace, &run_directory)
            });

        let finished_at = Utc::now();
        let retry_policy = queue.retry_policy;
        let task = task_mut(&mut queue, &next_id).expect("running task must exist");
        match result {
            Ok(()) => {
                task.status = TaskStatus::Succeeded;
                task.finished_at = Some(finished_at);
                task.next_retry_at = None;
                summary.succeeded_ids.push(task.id.clone());
            }
            Err(error) => {
                let attempts = task.attempts.unwrap_or(1);
                if is_transient_error(&error) && attempts < retry_policy.max_attempts {
                    let delay = retry_delay(retry_policy, attempts);
                    let chrono_delay = ChronoDuration::from_std(delay)
                        .expect("validated retry delay must fit chrono duration");
                    task.status = TaskStatus::Pending;
                    task.finished_at = None;
                    task.last_error = Some(format!("{error:#}"));
                    task.next_retry_at = Some(finished_at + chrono_delay);
                } else {
                    task.status = TaskStatus::Failed;
                    task.finished_at = Some(finished_at);
                    task.last_error = Some(format!("{error:#}"));
                    task.next_retry_at = None;
                    summary.failed_ids.push(task.id.clone());
                }
            }
        }
        write_queue(&queue_path, &queue)?;
    }

    Ok(summary)
}

fn normalize_retry_state(queue: &mut Queue) -> Result<bool, WorkerError> {
    let now = Utc::now();
    let mut changed = false;

    for task in &mut queue.tasks {
        if matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
            && task.attempts == Some(u32::MAX)
        {
            return Err(WorkerError::AttemptOverflow {
                task_id: task.id.clone(),
            });
        }

        let attempts_exhausted = task
            .attempts
            .is_some_and(|attempts| attempts >= queue.retry_policy.max_attempts);
        match task.status {
            TaskStatus::Running if attempts_exhausted => {
                task.status = TaskStatus::Failed;
                task.finished_at = Some(now);
                task.next_retry_at = None;
                task.last_error = Some(format!(
                    "interrupted worker run reached the maximum attempt count ({})",
                    queue.retry_policy.max_attempts
                ));
                changed = true;
            }
            TaskStatus::Running => {
                task.status = TaskStatus::Pending;
                task.next_retry_at = None;
                task.last_error
                    .get_or_insert_with(|| "recovered from an interrupted worker run".to_owned());
                changed = true;
            }
            TaskStatus::Pending if attempts_exhausted => {
                task.status = TaskStatus::Failed;
                task.finished_at = Some(now);
                task.next_retry_at = None;
                task.last_error = Some(format!(
                    "maximum attempt count ({}) reached before execution",
                    queue.retry_policy.max_attempts
                ));
                changed = true;
            }
            _ => {}
        }
    }

    Ok(changed)
}

fn task_is_ready(queue: &Queue, task_id: &str, now: chrono::DateTime<Utc>) -> bool {
    let Some(task) = queue.tasks.iter().find(|task| task.id == task_id) else {
        return false;
    };
    task.status == TaskStatus::Pending
        && task.next_retry_at.is_none_or(|retry_at| retry_at <= now)
        && task.depends_on.iter().all(|dependency| {
            queue
                .tasks
                .iter()
                .find(|task| task.id == *dependency)
                .is_some_and(|task| task.status == TaskStatus::Succeeded)
        })
}

fn next_scheduled_retry(
    queue: &Queue,
    plan: &crate::ExecutionPlan,
    now: chrono::DateTime<Utc>,
) -> Option<(String, chrono::DateTime<Utc>)> {
    plan.ordered_ids
        .iter()
        .filter_map(|task_id| {
            let task = queue.tasks.iter().find(|task| task.id == *task_id)?;
            let retry_at = task.next_retry_at?;
            (task.status == TaskStatus::Pending
                && retry_at > now
                && task.depends_on.iter().all(|dependency| {
                    queue
                        .tasks
                        .iter()
                        .find(|task| task.id == *dependency)
                        .is_some_and(|task| task.status == TaskStatus::Succeeded)
                }))
            .then_some((task.id.clone(), retry_at))
        })
        .min_by_key(|(_, retry_at)| *retry_at)
}

fn wait_for_scheduled_retry(
    queue_path: &Path,
    queue: &mut Queue,
    task_id: &str,
    retry_at: chrono::DateTime<Utc>,
    runner: &mut impl QueueRunner,
) -> Result<(), WorkerError> {
    let remaining_delay = retry_at
        .signed_duration_since(Utc::now())
        .to_std()
        .ok()
        .filter(|delay| !delay.is_zero())
        .map(|delay| delay.min(Duration::from_secs(queue.retry_policy.max_delay_seconds)))
        .map(round_up_to_second);
    if let Some(delay) = remaining_delay {
        runner.wait_before_retry(delay);
    }

    let task = task_mut(queue, task_id).expect("scheduled retry task must exist");
    task.next_retry_at = None;
    write_queue(queue_path, queue)
}

fn round_up_to_second(delay: Duration) -> Duration {
    if delay.subsec_nanos() == 0 {
        delay
    } else {
        Duration::from_secs(delay.as_secs().saturating_add(1))
    }
}

fn is_transient_error(error: &anyhow::Error) -> bool {
    error.downcast_ref::<TransientTaskError>().is_some()
}

fn retry_delay(policy: RetryPolicy, completed_attempts: u32) -> Duration {
    let exponent = completed_attempts.saturating_sub(1).min(19);
    let multiplier = 1_u64 << exponent;
    Duration::from_secs(
        policy
            .initial_delay_seconds
            .saturating_mul(multiplier)
            .min(policy.max_delay_seconds),
    )
}

fn task_mut<'a>(queue: &'a mut Queue, id: &str) -> Option<&'a mut Task> {
    queue.tasks.iter_mut().find(|task| task.id == id)
}

fn resolve_workspace(queue_directory: &Path, workspace: &str) -> PathBuf {
    let workspace = Path::new(workspace);
    if workspace.is_absolute() {
        workspace.to_path_buf()
    } else {
        queue_directory.join(workspace)
    }
}

fn safe_file_name(id: &str) -> String {
    id.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn create_run_directory(
    queue_directory: &Path,
    started_at: chrono::DateTime<Utc>,
    task_id: &str,
    attempt: u32,
) -> io::Result<PathBuf> {
    let runs_directory = queue_directory.join("runs");
    fs::create_dir_all(&runs_directory)?;
    let prefix = format!(
        "{}-{}-attempt-{attempt}-",
        started_at.format("%Y%m%dT%H%M%SZ"),
        safe_file_name(task_id)
    );
    let directory = Builder::new()
        .prefix(&prefix)
        .rand_bytes(8)
        .tempdir_in(runs_directory)?;
    Ok(directory.keep())
}

fn write_queue(path: &Path, queue: &Queue) -> Result<(), WorkerError> {
    let output = serialize_queue(queue)?;
    write_queue_bytes(path, &output)
}

fn serialize_queue(queue: &Queue) -> Result<Vec<u8>, WorkerError> {
    let mut output = serde_json::to_string_pretty(queue)?;
    output.push('\n');
    Ok(output.into_bytes())
}

fn write_queue_bytes(path: &Path, output: &[u8]) -> Result<(), WorkerError> {
    atomic_replace(path, |file| file.write_all(output)).map_err(|source| WorkerError::Write {
        path: path.to_path_buf(),
        source,
    })
}

fn queue_revision(input: &[u8]) -> String {
    format!("{:x}", Sha256::digest(input))
}

fn atomic_replace(path: &Path, write: impl FnOnce(&mut File) -> io::Result<()>) -> io::Result<()> {
    let parent = path.parent().unwrap_or(Path::new("."));
    let mut temporary = NamedTempFile::new_in(parent)?;
    write(temporary.as_file_mut())?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;

    #[cfg(unix)]
    File::open(parent)?.sync_all()?;

    Ok(())
}

fn atomic_create(path: &Path, write: impl FnOnce(&mut File) -> io::Result<()>) -> io::Result<bool> {
    let parent = path.parent().unwrap_or(Path::new("."));
    let mut temporary = NamedTempFile::new_in(parent)?;
    write(temporary.as_file_mut())?;
    temporary.as_file().sync_all()?;

    match temporary.persist_noclobber(path) {
        Ok(_) => {
            #[cfg(unix)]
            File::open(parent)?.sync_all()?;
            Ok(true)
        }
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error.error),
    }
}

struct QueueLock {
    file: File,
}

impl QueueLock {
    fn acquire(queue_path: &Path) -> Result<Self, WorkerError> {
        let mut lock_path = queue_path.as_os_str().to_os_string();
        lock_path.push(".lock");
        let lock_path = PathBuf::from(lock_path);
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|source| WorkerError::Lock {
                path: lock_path.clone(),
                source,
            })?;

        file.try_lock_exclusive().map_err(|source| {
            if source.kind() == io::ErrorKind::WouldBlock {
                WorkerError::AlreadyRunning(lock_path.clone())
            } else {
                WorkerError::Lock {
                    path: lock_path.clone(),
                    source,
                }
            }
        })?;

        Ok(Self { file })
    }
}

impl Drop for QueueLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{self, Write};

    use chrono::{TimeZone, Utc};
    use tempfile::TempDir;

    use super::{atomic_create, atomic_replace, create_run_directory};

    #[test]
    fn atomic_create_preserves_a_concurrently_created_queue() {
        let temp = TempDir::new().expect("temp directory");
        let path = temp.path().join("queue.json");

        let created = atomic_create(&path, |temporary| {
            temporary.write_all(b"default queue\n")?;
            fs::write(&path, "concurrent queue\n")
        })
        .expect("an existing target is not an I/O failure");

        assert!(!created);
        assert_eq!(fs::read_to_string(path).unwrap(), "concurrent queue\n");
    }

    #[test]
    fn failed_atomic_write_preserves_the_previous_queue() {
        let temp = TempDir::new().expect("temp directory");
        let path = temp.path().join("queue.json");
        fs::write(&path, "original\n").expect("seed queue");

        let error = atomic_replace(&path, |file| {
            file.write_all(b"partial")?;
            Err(io::Error::other("injected write failure"))
        })
        .expect_err("injected write must fail");

        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(fs::read_to_string(path).unwrap(), "original\n");
    }

    #[test]
    fn creates_a_unique_directory_for_each_attempt_log() {
        let temp = TempDir::new().expect("temp directory");
        let started_at = Utc.with_ymd_and_hms(2026, 7, 28, 1, 0, 0).single().unwrap();

        let first = create_run_directory(temp.path(), started_at, "same-task", 1).unwrap();
        let second = create_run_directory(temp.path(), started_at, "same-task", 1).unwrap();

        assert_ne!(first, second);
        assert!(first.is_dir());
        assert!(second.is_dir());
    }
}
