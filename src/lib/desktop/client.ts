import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

import {
  createDemoQueue,
  createQueueSnapshot,
  type AppInfo,
  type Queue,
  type QueueSnapshot,
  type RunSummary,
  type TaskRunOutput,
  type TaskRunSummary,
  type Task,
  validateQueue,
} from "@/domain/queue";

export interface DesktopClient {
  getAppInfo(): Promise<AppInfo>;
  loadQueue(path: string): Promise<QueueSnapshot>;
  saveQueue(
    path: string,
    queue: Queue,
    expectedRevision: string,
  ): Promise<QueueSnapshot>;
  runQueue(path: string, codexBin?: string): Promise<RunSummary>;
  listTaskRuns(path: string, taskId: string): Promise<TaskRunSummary[]>;
  readTaskRun(
    path: string,
    taskId: string,
    runId: string,
  ): Promise<TaskRunOutput>;
  openQueueFile(): Promise<QueueSnapshot | null>;
  saveQueueFile(
    queue: Queue,
    suggestedPath?: string,
    expectedRevision?: string,
  ): Promise<QueueSnapshot | null>;
}

const BROWSER_QUEUE_PATH = "browser://queues/demo.json";
const STORAGE_PREFIX = "codex-queue.queue:";
const RUN_STORAGE_PREFIX = "codex-queue.runs:";
const MAX_BROWSER_TASK_RUNS = 100;
const JSON_FILTERS = [{ name: "JSON", extensions: ["json"] }];
let fallbackRevisionCounter = 0;
const fallbackBrowserLocks = new Map<string, Promise<void>>();

interface BrowserQueueEnvelope {
  revision: string;
  queue: Queue;
}

interface BrowserRunRecord {
  taskId: string;
  taskCreatedAt: string;
  output: TaskRunOutput;
}

class TauriDesktopClient implements DesktopClient {
  async getAppInfo(): Promise<AppInfo> {
    return withReadableError(async () => {
      if (isTauri()) {
        return invoke<AppInfo>("app_info");
      }

      ensureBrowserDemoQueue();
      return {
        defaultQueuePath: BROWSER_QUEUE_PATH,
        platform: "browser",
      };
    });
  }

  async loadQueue(path: string): Promise<QueueSnapshot> {
    return withReadableError(async () => {
      if (isTauri()) {
        return invoke<QueueSnapshot>("load_queue", { path });
      }

      return loadBrowserQueue(path);
    });
  }

  async saveQueue(
    path: string,
    queue: Queue,
    expectedRevision: string,
  ): Promise<QueueSnapshot> {
    return withReadableError(async () => {
      return this.persistQueue(path, queue, expectedRevision, path);
    });
  }

  async runQueue(path: string, codexBin?: string): Promise<RunSummary> {
    return withReadableError(async () => {
      if (isTauri()) {
        return invoke<RunSummary>("run_queue", {
          path,
          codexBin: codexBin ?? null,
        });
      }

      return runBrowserQueue(path);
    });
  }

  async listTaskRuns(path: string, taskId: string): Promise<TaskRunSummary[]> {
    return withReadableError(async () => {
      if (isTauri()) {
        return invoke<TaskRunSummary[]>("list_task_runs", { path, taskId });
      }

      return listBrowserTaskRuns(path, taskId);
    });
  }

  async readTaskRun(
    path: string,
    taskId: string,
    runId: string,
  ): Promise<TaskRunOutput> {
    return withReadableError(async () => {
      if (isTauri()) {
        return invoke<TaskRunOutput>("read_task_run", {
          path,
          taskId,
          runId,
        });
      }

      return readBrowserTaskRun(path, taskId, runId);
    });
  }

  async openQueueFile(): Promise<QueueSnapshot | null> {
    return withReadableError(async () => {
      if (!isTauri()) {
        const { defaultQueuePath } = await this.getAppInfo();
        return this.loadQueue(defaultQueuePath);
      }

      const path = await open({
        multiple: false,
        directory: false,
        filters: JSON_FILTERS,
      });
      return path ? this.loadQueue(path) : null;
    });
  }

  async saveQueueFile(
    queue: Queue,
    suggestedPath?: string,
    expectedRevision?: string,
  ): Promise<QueueSnapshot | null> {
    return withReadableError(async () => {
      if (!isTauri()) {
        const path =
          suggestedPath ?? (await this.getAppInfo()).defaultQueuePath;
        return this.persistQueue(path, queue, expectedRevision, suggestedPath);
      }

      const path = await save({
        defaultPath: suggestedPath,
        filters: JSON_FILTERS,
      });
      return path
        ? this.persistQueue(path, queue, expectedRevision, suggestedPath)
        : null;
    });
  }

  private async persistQueue(
    path: string,
    queue: Queue,
    expectedRevision?: string,
    expectedRevisionPath?: string,
  ): Promise<QueueSnapshot> {
    validateQueue(queue);
    if (isTauri()) {
      return invoke<QueueSnapshot>("save_queue", {
        path,
        queue,
        expectedRevision: expectedRevision ?? null,
        expectedRevisionPath: expectedRevisionPath ?? null,
      });
    }

    return saveBrowserQueue(path, queue, expectedRevision);
  }
}

export const desktopClient: DesktopClient = new TauriDesktopClient();

function ensureBrowserDemoQueue(): void {
  const storage = browserStorage();
  const key = storageKey(BROWSER_QUEUE_PATH);
  if (storage.getItem(key) === null) {
    storage.setItem(key, serializeBrowserQueue(createDemoQueue()));
  }
}

function loadBrowserQueue(path: string): QueueSnapshot {
  if (path === BROWSER_QUEUE_PATH) {
    ensureBrowserDemoQueue();
  }

  const envelope = readBrowserQueue(path);
  return createQueueSnapshot(path, envelope.queue, envelope.revision);
}

function readBrowserQueue(path: string): BrowserQueueEnvelope {
  const storage = browserStorage();
  const key = storageKey(path);
  const input = storage.getItem(key);
  if (input === null) {
    throw new Error(`Queue file not found: ${path}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    throw new Error(`Cannot read queue ${path}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (isBrowserQueueEnvelope(value)) {
    validateQueue(value.queue);
    return value;
  }

  validateQueue(value);
  const envelope = createBrowserQueueEnvelope(value);
  storage.setItem(key, JSON.stringify(envelope));
  return envelope;
}

async function saveBrowserQueue(
  path: string,
  queue: Queue,
  expectedRevision?: string,
): Promise<QueueSnapshot> {
  return withBrowserQueueLock(path, () =>
    saveBrowserQueueUnlocked(path, queue, expectedRevision),
  );
}

function saveBrowserQueueUnlocked(
  path: string,
  queue: Queue,
  expectedRevision?: string,
): QueueSnapshot {
  validateQueue(queue);
  if (expectedRevision !== undefined) {
    const current = readBrowserQueue(path);
    if (current.revision !== expectedRevision) {
      throw new Error(
        `queue changed since it was loaded: ${path}; reload before saving`,
      );
    }
  }

  const serialized = serializeBrowserQueue(queue);
  browserStorage().setItem(storageKey(path), serialized);

  const savedValue: unknown = JSON.parse(serialized);
  if (!isBrowserQueueEnvelope(savedValue)) {
    throw new Error(`Cannot read queue ${path}: invalid storage envelope`);
  }
  validateQueue(savedValue.queue);
  return createQueueSnapshot(path, savedValue.queue, savedValue.revision);
}

async function runBrowserQueue(path: string): Promise<RunSummary> {
  const snapshot = loadBrowserQueue(path);
  const plannedIds = new Set(snapshot.orderedIds);
  const newlyBlocked = new Map(
    snapshot.blocked.map((blocked) => [blocked.taskId, blocked]),
  );
  const finishedAt = new Date().toISOString();
  const tasks = snapshot.queue.tasks.map((task) => {
    if (plannedIds.has(task.id)) {
      return succeededTask(task, finishedAt);
    }

    const blockedReason = newlyBlocked.get(task.id);
    return blockedReason ? blockedTask(task, blockedReason, finishedAt) : task;
  });
  const summary: RunSummary = {
    plannedIds: snapshot.orderedIds,
    succeededIds: snapshot.orderedIds,
    failedIds: tasks
      .filter((task) => task.status === "failed")
      .map((task) => task.id),
    blockedIds: tasks
      .filter((task) => task.status === "blocked")
      .map((task) => task.id),
  };
  const newRunRecords = tasks
    .filter((task) => plannedIds.has(task.id))
    .map(createBrowserRunRecord);
  const existingRunRecords =
    newRunRecords.length > 0 ? readBrowserRunRecords(path) : [];

  await saveBrowserQueue(path, { ...snapshot.queue, tasks }, snapshot.revision);
  appendBrowserRunRecords(path, newRunRecords, existingRunRecords);
  return summary;
}

function listBrowserTaskRuns(path: string, taskId: string): TaskRunSummary[] {
  const task = findBrowserTask(path, taskId);
  return readBrowserRunRecords(path)
    .filter(
      (record) =>
        record.taskId === task.id && record.taskCreatedAt === task.createdAt,
    )
    .map((record) => record.output.run)
    .sort(compareBrowserRunsNewest)
    .slice(0, MAX_BROWSER_TASK_RUNS);
}

function readBrowserTaskRun(
  path: string,
  taskId: string,
  runId: string,
): TaskRunOutput {
  const task = findBrowserTask(path, taskId);
  const record = readBrowserRunRecords(path).find(
    (candidate) =>
      candidate.taskId === task.id &&
      candidate.taskCreatedAt === task.createdAt &&
      candidate.output.run.id === runId,
  );
  if (!record) {
    throw new Error(`run not found for task ${taskId}: ${runId}`);
  }
  return record.output;
}

function findBrowserTask(path: string, taskId: string): Task {
  const task = loadBrowserQueue(path).queue.tasks.find(
    (candidate) => candidate.id === taskId,
  );
  if (!task) {
    throw new Error(`task not found in queue: ${taskId}`);
  }
  return task;
}

function createBrowserRunRecord(task: Task): BrowserRunRecord {
  const startedAt = task.startedAt ?? task.finishedAt;
  const attempt = task.attempts;
  if (!startedAt || !attempt) {
    throw new Error(`cannot create browser run output for task ${task.id}`);
  }

  const run: TaskRunSummary = {
    id: createBrowserRunId(task.id, attempt, startedAt),
    attempt,
    startedAt,
  };
  return {
    taskId: task.id,
    taskCreatedAt: task.createdAt,
    output: {
      run,
      finalOutput: {
        content: JSON.stringify(
          {
            mode: "browser-demo",
            taskId: task.id,
            status: task.status,
          },
          null,
          2,
        ),
        truncated: false,
      },
      events: {
        content: `${JSON.stringify({
          type: "task.completed",
          taskId: task.id,
          attempt,
          startedAt,
        })}\n`,
        truncated: false,
      },
      stderr: { content: "", truncated: false },
    },
  };
}

function createBrowserRunId(
  taskId: string,
  attempt: number,
  startedAt: string,
): string {
  const timestamp = startedAt.replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
  const suffix = createBrowserRevision().replace(/[^A-Za-z0-9]/g, "");
  return `${timestamp}-${taskId}-attempt-${attempt}-${suffix}`;
}

function appendBrowserRunRecords(
  path: string,
  records: BrowserRunRecord[],
  existingRecords: BrowserRunRecord[],
): void {
  if (records.length === 0) return;

  const counts = new Map<string, number>();
  const bounded = [...records, ...existingRecords]
    .sort((left, right) =>
      compareBrowserRunsNewest(left.output.run, right.output.run),
    )
    .filter((record) => {
      const taskInstance = `${record.taskId}\u0000${record.taskCreatedAt}`;
      const count = counts.get(taskInstance) ?? 0;
      if (count >= MAX_BROWSER_TASK_RUNS) return false;
      counts.set(taskInstance, count + 1);
      return true;
    });
  browserStorage().setItem(runStorageKey(path), JSON.stringify(bounded));
}

function readBrowserRunRecords(path: string): BrowserRunRecord[] {
  const input = browserStorage().getItem(runStorageKey(path));
  if (input === null) return [];

  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    throw new Error(
      `cannot read browser run storage for ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!Array.isArray(value) || !value.every(isBrowserRunRecord)) {
    throw new Error(`invalid browser run storage for ${path}`);
  }
  return value;
}

function isBrowserRunRecord(value: unknown): value is BrowserRunRecord {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    isDateTime(value.taskCreatedAt) &&
    isTaskRunOutput(value.output)
  );
}

function isTaskRunOutput(value: unknown): value is TaskRunOutput {
  return (
    isRecord(value) &&
    isTaskRunSummary(value.run) &&
    isRunArtifact(value.finalOutput) &&
    isRunArtifact(value.events) &&
    isRunArtifact(value.stderr)
  );
}

function isTaskRunSummary(value: unknown): value is TaskRunSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    Number.isSafeInteger(value.attempt) &&
    (value.attempt as number) > 0 &&
    isDateTime(value.startedAt)
  );
}

function isRunArtifact(value: unknown): value is TaskRunOutput["finalOutput"] {
  return (
    isRecord(value) &&
    typeof value.content === "string" &&
    typeof value.truncated === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function compareBrowserRunsNewest(
  left: TaskRunSummary,
  right: TaskRunSummary,
): number {
  return (
    right.startedAt.localeCompare(left.startedAt) ||
    right.id.localeCompare(left.id)
  );
}

async function withBrowserQueueLock<T>(
  path: string,
  action: () => T | PromiseLike<T>,
): Promise<T> {
  const lockName = `codex-queue.queue-lock:${path}`;
  const locks = globalThis.navigator?.locks;
  if (locks) {
    return locks.request(lockName, { mode: "exclusive" }, () => action());
  }

  const previous = fallbackBrowserLocks.get(lockName) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  fallbackBrowserLocks.set(lockName, tail);
  await previous;

  try {
    return await action();
  } finally {
    release();
    if (fallbackBrowserLocks.get(lockName) === tail) {
      fallbackBrowserLocks.delete(lockName);
    }
  }
}

function serializeBrowserQueue(queue: Queue): string {
  return JSON.stringify(createBrowserQueueEnvelope(queue));
}

function createBrowserQueueEnvelope(queue: Queue): BrowserQueueEnvelope {
  return { revision: createBrowserRevision(), queue };
}

function createBrowserRevision(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `browser:${globalThis.crypto.randomUUID()}`;
  }

  fallbackRevisionCounter += 1;
  return `browser:${Date.now().toString(36)}:${fallbackRevisionCounter.toString(36)}`;
}

function isBrowserQueueEnvelope(value: unknown): value is BrowserQueueEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "revision" in value &&
    typeof value.revision === "string" &&
    "queue" in value
  );
}

function succeededTask(task: Task, finishedAt: string): Task {
  const succeeded = {
    ...task,
    status: "succeeded" as const,
    attempts: (task.attempts ?? 0) + 1,
    startedAt: finishedAt,
    finishedAt,
  };
  delete succeeded.lastError;
  delete succeeded.blockedReason;
  delete succeeded.nextRetryAt;
  return succeeded;
}

function blockedTask(
  task: Task,
  reason: QueueSnapshot["blocked"][number],
  finishedAt: string,
): Task {
  const blocked = {
    ...task,
    status: "blocked" as const,
    finishedAt,
    blockedReason: {
      reasonCode: reason.reasonCode,
      dependencyId: reason.dependencyId,
    },
  };
  delete blocked.lastError;
  delete blocked.nextRetryAt;
  return blocked;
}

function browserStorage(): Storage {
  if (typeof globalThis.localStorage === "undefined") {
    throw new Error("Browser storage is unavailable");
  }
  return globalThis.localStorage;
}

function storageKey(path: string): string {
  return `${STORAGE_PREFIX}${path}`;
}

function runStorageKey(path: string): string {
  return `${RUN_STORAGE_PREFIX}${path}`;
}

async function withReadableError<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(errorMessage(error), { cause: error });
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Unknown desktop error";
}
