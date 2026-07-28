use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use anyhow::Result;
use chrono::Utc;
use fs2::FileExt;
use tempfile::{Builder, NamedTempFile};
use thiserror::Error;

use crate::{Queue, QueueError, Task, TaskStatus, build_execution_plan, parse_queue};

pub trait QueueRunner {
    fn launch_app(&mut self, workspace: &Path) -> Result<()>;

    fn execute_task(&mut self, task: &Task, workspace: &Path, run_directory: &Path) -> Result<()>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct WorkerOptions {
    pub dry_run: bool,
}

#[derive(Debug, Default, Eq, PartialEq)]
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
    #[error(transparent)]
    Queue(#[from] QueueError),
    #[error("cannot serialize queue: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("cannot launch Codex app: {0}")]
    Launch(anyhow::Error),
    #[error("task {task_id} has reached the maximum attempt count")]
    AttemptOverflow { task_id: String },
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

    for task in &mut queue.tasks {
        if task.status == TaskStatus::Running {
            task.status = TaskStatus::Pending;
            task.last_error = Some("recovered from an interrupted worker run".to_owned());
        }
    }

    let recovered_plan = build_execution_plan(&queue)?;
    if queue.launch_app {
        let first_task = recovered_plan
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

        for blocked in plan.blocked {
            if let Some(task) = task_mut(&mut queue, &blocked.task_id) {
                task.status = TaskStatus::Blocked;
                task.finished_at = Some(Utc::now());
                task.last_error = Some(blocked.reason);
                summary.blocked_ids.push(task.id.clone());
                queue_changed = true;
            }
        }

        if queue_changed {
            write_queue(&queue_path, &queue)?;
        }

        let Some(next_id) = plan.ordered_ids.first() else {
            break;
        };

        let started_at = Utc::now();
        let task = task_mut(&mut queue, next_id).expect("planned task must exist");
        task.status = TaskStatus::Running;
        task.attempts = Some(task.attempts.unwrap_or(0).checked_add(1).ok_or_else(|| {
            WorkerError::AttemptOverflow {
                task_id: task.id.clone(),
            }
        })?);
        task.started_at = Some(started_at);
        task.finished_at = None;
        task.last_error = None;
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
        let task = task_mut(&mut queue, next_id).expect("running task must exist");
        task.finished_at = Some(finished_at);
        match result {
            Ok(()) => {
                task.status = TaskStatus::Succeeded;
                summary.succeeded_ids.push(task.id.clone());
            }
            Err(error) => {
                task.status = TaskStatus::Failed;
                task.last_error = Some(format!("{error:#}"));
                summary.failed_ids.push(task.id.clone());
            }
        }
        write_queue(&queue_path, &queue)?;
    }

    Ok(summary)
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
    let mut output = serde_json::to_string_pretty(queue)?;
    output.push('\n');
    atomic_replace(path, |file| file.write_all(output.as_bytes())).map_err(|source| {
        WorkerError::Write {
            path: path.to_path_buf(),
            source,
        }
    })
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

    use super::{atomic_replace, create_run_directory};

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
