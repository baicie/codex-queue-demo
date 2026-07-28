use codex_queue_demo::{build_execution_plan, parse_queue};
use serde_json::{Value, json};

#[test]
fn rejects_duplicate_task_ids() {
    let input = queue(vec![task("same"), task("same")]);

    let error = parse_queue(&input.to_string()).expect_err("duplicate IDs must fail");

    assert_eq!(error.to_string(), "duplicate task ID: same");
}

#[test]
fn rejects_unknown_dependencies() {
    let mut child = task("child");
    child["dependsOn"] = json!(["missing"]);
    let input = queue(vec![child]);

    let error = parse_queue(&input.to_string()).expect_err("unknown dependency must fail");

    assert_eq!(
        error.to_string(),
        "task child depends on unknown task: missing"
    );
}

#[test]
fn applies_safe_retry_defaults_to_existing_queue_files() {
    let queue = parse_queue(&queue(vec![task("existing")]).to_string()).expect("valid queue");

    assert_eq!(queue.retry_policy.max_attempts, 4);
    assert_eq!(queue.retry_policy.initial_delay_seconds, 30);
    assert_eq!(queue.retry_policy.max_delay_seconds, 900);
}

#[test]
fn rejects_an_unbounded_retry_policy() {
    let mut input = queue(vec![task("retry")]);
    input["retryPolicy"] = json!({
        "maxAttempts": 0,
        "initialDelaySeconds": 30,
        "maxDelaySeconds": 900
    });

    let error = parse_queue(&input.to_string()).expect_err("zero attempts must fail");

    assert_eq!(
        error.to_string(),
        "retryPolicy.maxAttempts must be between 1 and 20"
    );
}

#[test]
fn rejects_retry_delays_longer_than_one_day() {
    let mut input = queue(vec![task("retry")]);
    input["retryPolicy"] = json!({
        "maxAttempts": 4,
        "initialDelaySeconds": 30,
        "maxDelaySeconds": 86401
    });

    let error = parse_queue(&input.to_string()).expect_err("unbounded delay must fail");

    assert_eq!(
        error.to_string(),
        "retryPolicy.maxDelaySeconds must not exceed 86400"
    );
}

#[test]
fn rejects_a_zero_initial_retry_delay() {
    let mut input = queue(vec![task("retry")]);
    input["retryPolicy"] = json!({
        "maxAttempts": 4,
        "initialDelaySeconds": 0,
        "maxDelaySeconds": 900
    });

    let error = parse_queue(&input.to_string()).expect_err("zero delay must fail");

    assert_eq!(
        error.to_string(),
        "retryPolicy.initialDelaySeconds must be greater than 0"
    );
}

#[test]
fn rejects_a_retry_cap_below_the_initial_delay() {
    let mut input = queue(vec![task("retry")]);
    input["retryPolicy"] = json!({
        "maxAttempts": 4,
        "initialDelaySeconds": 30,
        "maxDelaySeconds": 29
    });

    let error = parse_queue(&input.to_string()).expect_err("invalid retry cap must fail");

    assert_eq!(
        error.to_string(),
        "retryPolicy.maxDelaySeconds must be at least initialDelaySeconds"
    );
}

#[test]
fn rejects_task_ids_that_are_unsafe_as_log_directory_names() {
    let input = queue(vec![task("parent/child")]);

    let error = parse_queue(&input.to_string()).expect_err("unsafe task ID must fail");

    assert_eq!(
        error.to_string(),
        "task ID must be 1-64 ASCII letters, digits, '-' or '_': parent/child"
    );
}

#[test]
fn rejects_dependency_cycles() {
    let mut first = task("first");
    first["dependsOn"] = json!(["second"]);
    let mut second = task("second");
    second["dependsOn"] = json!(["first"]);

    let error = parse_queue(&queue(vec![first, second]).to_string())
        .expect_err("dependency cycle must fail");

    assert_eq!(
        error.to_string(),
        "task dependency cycle detected at: first"
    );
}

#[test]
fn orders_by_dependencies_priority_creation_time_and_id() {
    let mut dependent = task("dependent-high");
    dependent["priority"] = json!(100);
    dependent["dependsOn"] = json!(["foundation"]);
    dependent["createdAt"] = json!("2026-07-28T00:00:04Z");

    let mut later = task("later");
    later["priority"] = json!(50);
    later["createdAt"] = json!("2026-07-28T00:00:03Z");

    let mut earlier_b = task("earlier-b");
    earlier_b["priority"] = json!(50);
    earlier_b["createdAt"] = json!("2026-07-28T00:00:01Z");

    let mut earlier_a = task("earlier-a");
    earlier_a["priority"] = json!(50);
    earlier_a["createdAt"] = json!("2026-07-28T00:00:01Z");

    let mut foundation = task("foundation");
    foundation["priority"] = json!(10);
    foundation["createdAt"] = json!("2026-07-28T00:00:02Z");

    let queue =
        parse_queue(&queue(vec![dependent, later, earlier_b, earlier_a, foundation]).to_string())
            .expect("valid queue");

    let plan = build_execution_plan(&queue).expect("queue should be plannable");

    assert_eq!(
        plan.ordered_ids,
        vec![
            "earlier-a",
            "earlier-b",
            "later",
            "foundation",
            "dependent-high"
        ]
    );
    assert!(plan.blocked.is_empty());
}

#[test]
fn blocks_tasks_whose_dependencies_failed() {
    let mut failed_parent = task("failed-parent");
    failed_parent["status"] = json!("failed");
    let mut child = task("child");
    child["dependsOn"] = json!(["failed-parent"]);
    let queue = parse_queue(&queue(vec![failed_parent, child]).to_string()).expect("valid queue");

    let plan = build_execution_plan(&queue).expect("queue should be plannable");

    assert!(plan.ordered_ids.is_empty());
    assert_eq!(plan.blocked.len(), 1);
    assert_eq!(plan.blocked[0].task_id, "child");
    assert_eq!(
        plan.blocked[0].reason,
        "dependency failed or is blocked: failed-parent"
    );
}

fn queue(tasks: Vec<Value>) -> Value {
    json!({
        "version": 1,
        "launchApp": false,
        "tasks": tasks
    })
}

fn task(id: &str) -> Value {
    json!({
        "id": id,
        "title": id,
        "workspace": ".",
        "prompt": format!("Complete {id}"),
        "priority": 0,
        "dependsOn": [],
        "status": "pending",
        "createdAt": "2026-07-28T00:00:00Z"
    })
}
