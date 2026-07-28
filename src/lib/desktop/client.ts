import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

import {
  createDemoQueue,
  createQueueSnapshot,
  type AppInfo,
  type Queue,
  type QueueSnapshot,
  type RunSummary,
  type Task,
  validateQueue,
} from "@/domain/queue";

export interface DesktopClient {
  getAppInfo(): Promise<AppInfo>;
  loadQueue(path: string): Promise<QueueSnapshot>;
  saveQueue(path: string, queue: Queue): Promise<QueueSnapshot>;
  runQueue(path: string, codexBin?: string): Promise<RunSummary>;
  openQueueFile(): Promise<QueueSnapshot | null>;
  saveQueueFile(
    queue: Queue,
    suggestedPath?: string,
  ): Promise<QueueSnapshot | null>;
}

const BROWSER_QUEUE_PATH = "browser://queues/demo.json";
const STORAGE_PREFIX = "codex-queue.queue:";
const JSON_FILTERS = [{ name: "JSON", extensions: ["json"] }];

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

  async saveQueue(path: string, queue: Queue): Promise<QueueSnapshot> {
    return withReadableError(async () => {
      validateQueue(queue);
      if (isTauri()) {
        return invoke<QueueSnapshot>("save_queue", { path, queue });
      }

      return saveBrowserQueue(path, queue);
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
  ): Promise<QueueSnapshot | null> {
    return withReadableError(async () => {
      if (!isTauri()) {
        const path =
          suggestedPath ?? (await this.getAppInfo()).defaultQueuePath;
        return this.saveQueue(path, queue);
      }

      const path = await save({
        defaultPath: suggestedPath,
        filters: JSON_FILTERS,
      });
      return path ? this.saveQueue(path, queue) : null;
    });
  }
}

export const desktopClient: DesktopClient = new TauriDesktopClient();

function ensureBrowserDemoQueue(): void {
  const storage = browserStorage();
  const key = storageKey(BROWSER_QUEUE_PATH);
  if (storage.getItem(key) === null) {
    storage.setItem(key, JSON.stringify(createDemoQueue()));
  }
}

function loadBrowserQueue(path: string): QueueSnapshot {
  if (path === BROWSER_QUEUE_PATH) {
    ensureBrowserDemoQueue();
  }

  const input = browserStorage().getItem(storageKey(path));
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
  validateQueue(value);
  return createQueueSnapshot(path, value);
}

function saveBrowserQueue(path: string, queue: Queue): QueueSnapshot {
  validateQueue(queue);
  const serialized = JSON.stringify(queue);
  browserStorage().setItem(storageKey(path), serialized);

  const savedValue: unknown = JSON.parse(serialized);
  validateQueue(savedValue);
  return createQueueSnapshot(path, savedValue);
}

function runBrowserQueue(path: string): RunSummary {
  const snapshot = loadBrowserQueue(path);
  const plannedIds = new Set(snapshot.orderedIds);
  const newlyBlocked = new Map(
    snapshot.blocked.map((blocked) => [blocked.taskId, blocked.reason]),
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

  saveBrowserQueue(path, { ...snapshot.queue, tasks });
  return summary;
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
  delete succeeded.nextRetryAt;
  return succeeded;
}

function blockedTask(task: Task, reason: string, finishedAt: string): Task {
  const blocked = {
    ...task,
    status: "blocked" as const,
    finishedAt,
    lastError: reason,
  };
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
