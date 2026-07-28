import type {
  BlockedTask,
  ExecutionPlan,
  QueueFile,
  QueueTask,
  TaskStatus,
} from "./types.js";

const TASK_STATUSES = new Set<TaskStatus>([
  "pending",
  "running",
  "succeeded",
  "failed",
  "blocked",
]);

export function parseQueueFile(input: unknown): QueueFile {
  const root = asRecord(input, "Queue must be a JSON object");
  if (root.version !== 1) {
    throw new Error("Queue version must be 1");
  }
  if (typeof root.launchApp !== "boolean") {
    throw new Error("Queue launchApp must be a boolean");
  }
  if (!Array.isArray(root.tasks)) {
    throw new Error("Queue tasks must be an array");
  }

  const tasks = root.tasks.map((value, index) => parseTask(value, index));
  const tasksById = new Map<string, QueueTask>();

  for (const task of tasks) {
    if (tasksById.has(task.id)) {
      throw new Error(`Duplicate task ID: ${task.id}`);
    }
    tasksById.set(task.id, task);
  }

  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      if (!tasksById.has(dependencyId)) {
        throw new Error(
          `Task ${task.id} depends on unknown task: ${dependencyId}`,
        );
      }
    }
  }

  assertAcyclic(tasksById);
  return { version: 1, launchApp: root.launchApp, tasks };
}

export function buildExecutionPlan(queue: QueueFile): ExecutionPlan {
  const satisfied = new Set(
    queue.tasks
      .filter((task) => task.status === "succeeded")
      .map((task) => task.id),
  );
  const unavailable = new Set(
    queue.tasks
      .filter((task) => task.status === "failed" || task.status === "blocked")
      .map((task) => task.id),
  );
  const remaining = new Map(
    queue.tasks
      .filter((task) => task.status === "pending" || task.status === "running")
      .map((task) => [task.id, task]),
  );
  const blocked: BlockedTask[] = [];

  let changed = true;
  while (changed) {
    changed = false;
    for (const task of remaining.values()) {
      const failedDependency = task.dependsOn.find((id) => unavailable.has(id));
      if (failedDependency === undefined) {
        continue;
      }

      blocked.push({
        taskId: task.id,
        reason: `Dependency failed or is blocked: ${failedDependency}`,
      });
      unavailable.add(task.id);
      remaining.delete(task.id);
      changed = true;
    }
  }

  const ordered: QueueTask[] = [];
  while (remaining.size > 0) {
    const runnable = [...remaining.values()]
      .filter((task) => task.dependsOn.every((id) => satisfied.has(id)))
      .sort(compareTasks);

    const next = runnable[0];
    if (next === undefined) {
      throw new Error("No runnable task found; queue contains an unresolved cycle");
    }

    ordered.push(next);
    satisfied.add(next.id);
    remaining.delete(next.id);
  }

  return { ordered, blocked };
}

function compareTasks(left: QueueTask, right: QueueTask): number {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }

  const createdDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdDifference !== 0) {
    return createdDifference;
  }

  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function parseTask(input: unknown, index: number): QueueTask {
  const task = asRecord(input, `Task at index ${index} must be an object`);
  const id = requiredString(task.id, `Task at index ${index} id`);
  const title = requiredString(task.title, `Task ${id} title`);
  const workspace = requiredString(task.workspace, `Task ${id} workspace`);
  const prompt = requiredString(task.prompt, `Task ${id} prompt`);

  if (typeof task.priority !== "number" || !Number.isFinite(task.priority)) {
    throw new Error(`Task ${id} priority must be a finite number`);
  }
  if (!Array.isArray(task.dependsOn) || task.dependsOn.some((item) => typeof item !== "string")) {
    throw new Error(`Task ${id} dependsOn must be an array of task IDs`);
  }
  if (typeof task.status !== "string" || !TASK_STATUSES.has(task.status as TaskStatus)) {
    throw new Error(`Task ${id} has an invalid status`);
  }

  const createdAt = validTimestamp(task.createdAt, `Task ${id} createdAt`);
  const result: QueueTask = {
    id,
    title,
    workspace,
    prompt,
    priority: task.priority,
    dependsOn: [...task.dependsOn],
    status: task.status as TaskStatus,
    createdAt,
  };

  if (task.attempts !== undefined) {
    if (!Number.isInteger(task.attempts) || (task.attempts as number) < 0) {
      throw new Error(`Task ${id} attempts must be a non-negative integer`);
    }
    result.attempts = task.attempts as number;
  }
  copyOptionalTimestamp(task, result, "startedAt");
  copyOptionalTimestamp(task, result, "finishedAt");
  if (task.lastError !== undefined) {
    result.lastError = requiredString(task.lastError, `Task ${id} lastError`);
  }

  return result;
}

function assertAcyclic(tasksById: Map<string, QueueTask>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new Error(`Task dependency cycle detected at: ${id}`);
    }
    if (visited.has(id)) {
      return;
    }

    visiting.add(id);
    for (const dependencyId of tasksById.get(id)?.dependsOn ?? []) {
      visit(dependencyId);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of tasksById.keys()) {
    visit(id);
  }
}

function asRecord(input: unknown, message: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(message);
  }
  return input as Record<string, unknown>;
}

function requiredString(input: unknown, field: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return input;
}

function validTimestamp(input: unknown, field: string): string {
  const value = requiredString(input, field);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return value;
}

function copyOptionalTimestamp(
  source: Record<string, unknown>,
  target: QueueTask,
  field: "startedAt" | "finishedAt",
): void {
  const value = source[field];
  if (value !== undefined) {
    target[field] = validTimestamp(value, `Task ${target.id} ${field}`);
  }
}
