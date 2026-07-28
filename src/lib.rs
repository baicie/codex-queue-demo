use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

mod codex;
mod worker;

pub use codex::CodexCli;
pub use worker::{
    QueueRunner, RunSummary, TransientTaskError, WorkerError, WorkerOptions, load_queue_file,
    run_queue_file, save_queue_file,
};

#[derive(Debug, Error)]
pub enum QueueError {
    #[error("invalid queue JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Validation(String),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Queue {
    pub version: u8,
    pub launch_app: bool,
    #[serde(default)]
    pub retry_policy: RetryPolicy,
    pub tasks: Vec<Task>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub initial_delay_seconds: u64,
    pub max_delay_seconds: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 4,
            initial_delay_seconds: 30,
            max_delay_seconds: 900,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub workspace: String,
    pub prompt: String,
    pub priority: i64,
    #[serde(default)]
    pub depends_on: Vec<String>,
    pub status: TaskStatus,
    pub created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempts: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_retry_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedTask {
    pub task_id: String,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionPlan {
    pub ordered_ids: Vec<String>,
    pub blocked: Vec<BlockedTask>,
}

pub fn parse_queue(input: &str) -> Result<Queue, QueueError> {
    let queue: Queue = serde_json::from_str(input)?;
    validate_queue(&queue)?;
    Ok(queue)
}

pub fn build_execution_plan(queue: &Queue) -> Result<ExecutionPlan, QueueError> {
    validate_queue(queue)?;

    let mut succeeded = HashSet::new();
    let mut unavailable = HashSet::new();
    let mut pending = HashMap::new();

    for task in &queue.tasks {
        match task.status {
            TaskStatus::Succeeded => {
                succeeded.insert(task.id.as_str());
            }
            TaskStatus::Failed | TaskStatus::Blocked => {
                unavailable.insert(task.id.as_str());
            }
            TaskStatus::Pending | TaskStatus::Running => {
                pending.insert(task.id.as_str(), task);
            }
        }
    }

    let mut blocked = Vec::new();
    loop {
        let mut newly_blocked = pending
            .values()
            .filter_map(|task| {
                task.depends_on
                    .iter()
                    .find(|dependency| unavailable.contains(dependency.as_str()))
                    .map(|dependency| (*task, dependency.as_str()))
            })
            .collect::<Vec<_>>();
        newly_blocked.sort_by(|(left, _), (right, _)| compare_tasks(left, right));

        if newly_blocked.is_empty() {
            break;
        }

        for (task, dependency) in newly_blocked {
            pending.remove(task.id.as_str());
            unavailable.insert(task.id.as_str());
            blocked.push(BlockedTask {
                task_id: task.id.clone(),
                reason: format!("dependency failed or is blocked: {dependency}"),
            });
        }
    }

    let mut ordered_ids = Vec::new();
    while !pending.is_empty() {
        let mut runnable = pending
            .values()
            .filter(|task| {
                task.depends_on
                    .iter()
                    .all(|dependency| succeeded.contains(dependency.as_str()))
            })
            .copied()
            .collect::<Vec<_>>();
        runnable.sort_by(|left, right| compare_tasks(left, right));

        let Some(next) = runnable.first().copied() else {
            return Err(QueueError::Validation(
                "no runnable task found; queue contains an unresolved cycle".to_owned(),
            ));
        };

        pending.remove(next.id.as_str());
        succeeded.insert(next.id.as_str());
        ordered_ids.push(next.id.clone());
    }

    Ok(ExecutionPlan {
        ordered_ids,
        blocked,
    })
}

pub fn validate_queue(queue: &Queue) -> Result<(), QueueError> {
    if queue.version != 1 {
        return Err(QueueError::Validation("queue version must be 1".to_owned()));
    }
    validate_retry_policy(queue.retry_policy)?;

    let mut tasks_by_id = HashMap::new();
    for task in &queue.tasks {
        validate_task_id(&task.id)?;
        validate_non_empty(&task.title, &format!("task {} title", task.id))?;
        validate_non_empty(&task.workspace, &format!("task {} workspace", task.id))?;
        validate_non_empty(&task.prompt, &format!("task {} prompt", task.id))?;

        if tasks_by_id.insert(task.id.as_str(), task).is_some() {
            return Err(QueueError::Validation(format!(
                "duplicate task ID: {}",
                task.id
            )));
        }
    }

    for task in &queue.tasks {
        for dependency in &task.depends_on {
            if !tasks_by_id.contains_key(dependency.as_str()) {
                return Err(QueueError::Validation(format!(
                    "task {} depends on unknown task: {}",
                    task.id, dependency
                )));
            }
        }
    }

    assert_acyclic(&tasks_by_id)
}

fn validate_retry_policy(policy: RetryPolicy) -> Result<(), QueueError> {
    if !(1..=20).contains(&policy.max_attempts) {
        return Err(QueueError::Validation(
            "retryPolicy.maxAttempts must be between 1 and 20".to_owned(),
        ));
    }
    if policy.initial_delay_seconds == 0 {
        return Err(QueueError::Validation(
            "retryPolicy.initialDelaySeconds must be greater than 0".to_owned(),
        ));
    }
    if policy.max_delay_seconds < policy.initial_delay_seconds {
        return Err(QueueError::Validation(
            "retryPolicy.maxDelaySeconds must be at least initialDelaySeconds".to_owned(),
        ));
    }
    if policy.max_delay_seconds > 86_400 {
        return Err(QueueError::Validation(
            "retryPolicy.maxDelaySeconds must not exceed 86400".to_owned(),
        ));
    }
    Ok(())
}

fn validate_task_id(id: &str) -> Result<(), QueueError> {
    let is_safe = !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if !is_safe {
        return Err(QueueError::Validation(format!(
            "task ID must be 1-64 ASCII letters, digits, '-' or '_': {id}"
        )));
    }
    Ok(())
}

fn validate_non_empty(value: &str, field: &str) -> Result<(), QueueError> {
    if value.trim().is_empty() {
        return Err(QueueError::Validation(format!(
            "{field} must be a non-empty string"
        )));
    }
    Ok(())
}

fn assert_acyclic(tasks_by_id: &HashMap<&str, &Task>) -> Result<(), QueueError> {
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();

    fn visit<'a>(
        id: &'a str,
        tasks_by_id: &HashMap<&'a str, &'a Task>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
    ) -> Result<(), QueueError> {
        if visiting.contains(id) {
            return Err(QueueError::Validation(format!(
                "task dependency cycle detected at: {id}"
            )));
        }
        if visited.contains(id) {
            return Ok(());
        }

        visiting.insert(id);
        for dependency in &tasks_by_id
            .get(id)
            .expect("task IDs are validated before cycle detection")
            .depends_on
        {
            visit(dependency.as_str(), tasks_by_id, visiting, visited)?;
        }
        visiting.remove(id);
        visited.insert(id);
        Ok(())
    }

    let mut task_ids = tasks_by_id.keys().copied().collect::<Vec<_>>();
    task_ids.sort_unstable();
    for id in task_ids {
        visit(id, tasks_by_id, &mut visiting, &mut visited)?;
    }
    Ok(())
}

fn compare_tasks(left: &Task, right: &Task) -> Ordering {
    right
        .priority
        .cmp(&left.priority)
        .then_with(|| left.created_at.cmp(&right.created_at))
        .then_with(|| left.id.cmp(&right.id))
}
