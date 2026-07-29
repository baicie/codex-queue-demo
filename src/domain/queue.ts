export const TASK_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "blocked",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface RetryPolicy {
  maxAttempts: number;
  initialDelaySeconds: number;
  maxDelaySeconds: number;
}

export interface Task {
  id: string;
  title: string;
  workspace: string;
  prompt: string;
  priority: number;
  dependsOn: string[];
  status: TaskStatus;
  createdAt: string;
  attempts?: number;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
  blockedReason?: BlockedReason;
  nextRetryAt?: string;
}

export interface Queue {
  version: 1;
  launchApp: boolean;
  retryPolicy: RetryPolicy;
  tasks: Task[];
}

export type BlockedReasonCode = "dependencyUnavailable";

export interface BlockedReason {
  reasonCode: BlockedReasonCode;
  dependencyId: string;
}

export interface BlockedTask extends BlockedReason {
  taskId: string;
}

export interface QueueSnapshot {
  path: string;
  revision: string;
  queue: Queue;
  orderedIds: string[];
  blocked: BlockedTask[];
}

export interface AppInfo {
  defaultQueuePath: string;
  platform: string;
}

export interface RunSummary {
  plannedIds: string[];
  succeededIds: string[];
  failedIds: string[];
  blockedIds: string[];
}

const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = {
  maxAttempts: 4,
  initialDelaySeconds: 30,
  maxDelaySeconds: 900,
};

let fallbackIdCounter = 0;

export function createEmptyQueue(): Queue {
  return {
    version: 1,
    launchApp: true,
    retryPolicy: { ...DEFAULT_RETRY_POLICY },
    tasks: [],
  };
}

export function createDemoQueue(now = new Date()): Queue {
  const queue = createEmptyQueue();
  const createdAt = [2, 1, 0].map((minutesAgo) =>
    new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
  );

  queue.tasks = [
    {
      id: "inspect-project",
      title: "梳理项目上下文",
      workspace: ".",
      prompt: "检查项目结构、现有约定和测试，整理实现所需的上下文。",
      priority: 30,
      dependsOn: [],
      status: "pending",
      createdAt: createdAt[0],
    },
    {
      id: "implement-change",
      title: "实现目标改动",
      workspace: ".",
      prompt: "根据现有项目约定实现目标改动，并保持变更范围清晰。",
      priority: 20,
      dependsOn: ["inspect-project"],
      status: "pending",
      createdAt: createdAt[1],
    },
    {
      id: "verify-result",
      title: "验证并汇总结果",
      workspace: ".",
      prompt: "运行相关检查和测试，修复问题后汇总最终结果。",
      priority: 10,
      dependsOn: ["implement-change"],
      status: "pending",
      createdAt: createdAt[2],
    },
  ];

  return queue;
}

export function createTaskId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `task-${globalThis.crypto.randomUUID()}`;
  }

  fallbackIdCounter += 1;
  return `task-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`;
}

export function createQueueSnapshot(
  path: string,
  queue: Queue,
  revision: string,
): QueueSnapshot {
  validateQueue(queue);
  const { orderedIds, blocked } = buildExecutionPlan(queue);

  return { path, revision, queue, orderedIds, blocked };
}

export function validateQueue(value: unknown): asserts value is Queue {
  if (!isRecord(value)) {
    throw new Error("queue must be an object");
  }
  if (value.version !== 1) {
    throw new Error("queue version must be 1");
  }
  if (typeof value.launchApp !== "boolean") {
    throw new Error("launchApp must be a boolean");
  }

  validateRetryPolicy(value.retryPolicy);
  if (!Array.isArray(value.tasks)) {
    throw new Error("tasks must be an array");
  }

  const tasksById = new Map<string, Task>();
  for (const valueTask of value.tasks) {
    validateTask(valueTask);
    if (tasksById.has(valueTask.id)) {
      throw new Error(`duplicate task ID: ${valueTask.id}`);
    }
    tasksById.set(valueTask.id, valueTask);
  }

  for (const task of tasksById.values()) {
    for (const dependency of task.dependsOn) {
      if (!tasksById.has(dependency)) {
        throw new Error(
          `task ${task.id} depends on unknown task: ${dependency}`,
        );
      }
    }
  }

  assertAcyclic(tasksById);
}

function buildExecutionPlan(queue: Queue): {
  orderedIds: string[];
  blocked: BlockedTask[];
} {
  const succeeded = new Set<string>();
  const unavailable = new Set<string>();
  const pending = new Map<string, Task>();

  for (const task of queue.tasks) {
    if (task.status === "succeeded") {
      succeeded.add(task.id);
    } else if (task.status === "failed" || task.status === "blocked") {
      unavailable.add(task.id);
    } else {
      pending.set(task.id, task);
    }
  }

  const blocked: BlockedTask[] = [];
  while (true) {
    const newlyBlocked = [...pending.values()]
      .map((task) => ({
        task,
        dependency: task.dependsOn.find((id) => unavailable.has(id)),
      }))
      .filter(
        (item): item is { task: Task; dependency: string } =>
          item.dependency !== undefined,
      )
      .sort((left, right) => compareTasks(left.task, right.task));

    if (newlyBlocked.length === 0) {
      break;
    }

    for (const { task, dependency } of newlyBlocked) {
      pending.delete(task.id);
      unavailable.add(task.id);
      blocked.push({
        taskId: task.id,
        reasonCode: "dependencyUnavailable",
        dependencyId: dependency,
      });
    }
  }

  const orderedIds: string[] = [];
  while (pending.size > 0) {
    const next = [...pending.values()]
      .filter((task) => task.dependsOn.every((id) => succeeded.has(id)))
      .sort(compareTasks)[0];

    if (!next) {
      throw new Error(
        "no runnable task found; queue contains an unresolved cycle",
      );
    }

    pending.delete(next.id);
    succeeded.add(next.id);
    orderedIds.push(next.id);
  }

  return { orderedIds, blocked };
}

function validateRetryPolicy(value: unknown): asserts value is RetryPolicy {
  if (!isRecord(value)) {
    throw new Error("retryPolicy must be an object");
  }

  const { maxAttempts, initialDelaySeconds, maxDelaySeconds } = value;
  if (
    !isNonNegativeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 20
  ) {
    throw new Error("retryPolicy.maxAttempts must be between 1 and 20");
  }
  if (!isNonNegativeInteger(initialDelaySeconds) || initialDelaySeconds === 0) {
    throw new Error("retryPolicy.initialDelaySeconds must be greater than 0");
  }
  if (
    !isNonNegativeInteger(maxDelaySeconds) ||
    maxDelaySeconds < initialDelaySeconds
  ) {
    throw new Error(
      "retryPolicy.maxDelaySeconds must be at least initialDelaySeconds",
    );
  }
  if (maxDelaySeconds > 86_400) {
    throw new Error("retryPolicy.maxDelaySeconds must not exceed 86400");
  }
}

function validateTask(value: unknown): asserts value is Task {
  if (!isRecord(value)) {
    throw new Error("task must be an object");
  }

  const id = value.id;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 64 ||
    !/^[A-Za-z0-9_-]+$/.test(id)
  ) {
    throw new Error(
      `task ID must be 1-64 ASCII letters, digits, '-' or '_': ${String(id ?? "")}`,
    );
  }

  validateNonEmptyString(value.title, `task ${id} title`);
  validateNonEmptyString(value.workspace, `task ${id} workspace`);
  validateNonEmptyString(value.prompt, `task ${id} prompt`);

  if (!Number.isSafeInteger(value.priority)) {
    throw new Error(`task ${id} priority must be an integer`);
  }
  if (
    !Array.isArray(value.dependsOn) ||
    !value.dependsOn.every((dependency) => typeof dependency === "string")
  ) {
    throw new Error(`task ${id} dependsOn must be an array of task IDs`);
  }
  if (!TASK_STATUSES.includes(value.status as TaskStatus)) {
    throw new Error(`task ${id} status is invalid`);
  }
  if (!isDateTimeString(value.createdAt)) {
    throw new Error(`task ${id} createdAt must be an ISO date-time`);
  }
  validateOptionalInteger(value.attempts, `task ${id} attempts`);
  validateOptionalDateTime(value.startedAt, `task ${id} startedAt`);
  validateOptionalDateTime(value.finishedAt, `task ${id} finishedAt`);
  validateOptionalString(value.lastError, `task ${id} lastError`);
  validateOptionalBlockedReason(
    value.blockedReason,
    `task ${id} blockedReason`,
  );
  validateOptionalDateTime(value.nextRetryAt, `task ${id} nextRetryAt`);
}

function validateOptionalBlockedReason(value: unknown, name: string): void {
  if (value === undefined) return;
  if (
    !isRecord(value) ||
    value.reasonCode !== "dependencyUnavailable" ||
    typeof value.dependencyId !== "string" ||
    value.dependencyId.length === 0
  ) {
    throw new Error(`${name} is invalid`);
  }
}

function assertAcyclic(tasksById: ReadonlyMap<string, Task>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new Error(`task dependency cycle detected at: ${id}`);
    }
    if (visited.has(id)) {
      return;
    }

    visiting.add(id);
    for (const dependency of tasksById.get(id)!.dependsOn) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of [...tasksById.keys()].sort()) {
    visit(id);
  }
}

function compareTasks(left: Task, right: Task): number {
  return (
    right.priority - left.priority ||
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    compareAscii(left.id, right.id)
  );
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function validateOptionalInteger(value: unknown, field: string): void {
  if (value !== undefined && !isNonNegativeInteger(value)) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

function validateOptionalDateTime(value: unknown, field: string): void {
  if (value !== undefined && !isDateTimeString(value)) {
    throw new Error(`${field} must be an ISO date-time`);
  }
}

function validateOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
}

function isDateTimeString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
