use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use anyhow::Result;
use chrono::Utc;
use fs2::FileExt;
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
        planned_ids: initial_plan
            .ordered_ids
            .iter()
            .cloned()
            .chain(
                initial_plan
                    .blocked
                    .iter()
                    .map(|blocked| blocked.task_id.clone()),
            )
            .collect(),
        blocked_ids: if options.dry_run {
            initial_plan
                .blocked
                .iter()
                .map(|blocked| blocked.task_id.clone())
                .collect()
        } else {
            Vec::new()
        },
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
    if queue.launch_app
        && let Some(first_id) = recovered_plan.ordered_ids.first()
        && let Some(task) = queue.tasks.iter().find(|task| &task.id == first_id)
    {
        let workspace = resolve_workspace(queue_directory, &task.workspace);
        runner.launch_app(&workspace).map_err(WorkerError::Launch)?;
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
        task.attempts = Some(task.attempts.unwrap_or(0) + 1);
        task.started_at = Some(started_at);
        task.finished_at = None;
        task.last_error = None;
        let task_snapshot = task.clone();
        write_queue(&queue_path, &queue)?;

        let workspace = resolve_workspace(queue_directory, &task_snapshot.workspace);
        let attempt = task_snapshot.attempts.unwrap_or(1);
        let run_directory = queue_directory.join("runs").join(format!(
            "{}-{}-attempt-{attempt}",
            started_at.format("%Y%m%dT%H%M%SZ"),
            safe_file_name(&task_snapshot.id)
        ));
        let result = fs::create_dir_all(&run_directory)
            .map_err(anyhow::Error::from)
            .and_then(|()| runner.execute_task(&task_snapshot, &workspace, &run_directory));

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

fn write_queue(path: &Path, queue: &Queue) -> Result<(), WorkerError> {
    let mut output = serde_json::to_string_pretty(queue)?;
    output.push('\n');
    fs::write(path, output).map_err(|source| WorkerError::Write {
        path: path.to_path_buf(),
        source,
    })
}

struct QueueLock {
    file: File,
}

impl QueueLock {
    fn acquire(queue_path: &Path) -> Result<Self, WorkerError> {
        let lock_path = PathBuf::from(format!("{}.lock", queue_path.display()));
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
