import { invoke, isTauri } from "@tauri-apps/api/core";

import {
  SUPERVISOR_STATUSES,
  completeSupervisorGoal,
  createDemoSupervisor,
  markProviderDown,
  markProviderHealthy,
  pauseSupervisorJob,
  resumeSupervisorJob,
  type ProviderState,
  type SupervisorEvent,
  type SupervisorJob,
  type SupervisorSnapshot,
} from "@/domain/supervisor";

export interface SupervisorClient {
  load(): Promise<SupervisorSnapshot>;
  save(snapshot: SupervisorSnapshot): Promise<SupervisorSnapshot>;
  selectJob(jobId: string): Promise<SupervisorSnapshot>;
  markProviderDown(jobId: string, now?: Date): Promise<SupervisorSnapshot>;
  markProviderHealthy(now?: Date): Promise<SupervisorSnapshot>;
  resumeJob(jobId: string, now?: Date): Promise<SupervisorSnapshot>;
  pauseJob(jobId: string, now?: Date): Promise<SupervisorSnapshot>;
  completeGoal(jobId: string, now?: Date): Promise<SupervisorSnapshot>;
  resetDemo(now?: Date): Promise<SupervisorSnapshot>;
}

const STORAGE_KEY = "codex-queue.supervisor:v1";
const LOCK_NAME = "codex-queue.supervisor-lock";
let fallbackLock: Promise<void> = Promise.resolve();

class HybridSupervisorClient implements SupervisorClient {
  private liveSnapshot?: SupervisorSnapshot;

  async load(): Promise<SupervisorSnapshot> {
    if (isTauri()) return this.loadLiveSnapshot();

    this.liveSnapshot = undefined;
    return clone(loadSnapshot());
  }

  async save(snapshot: SupervisorSnapshot): Promise<SupervisorSnapshot> {
    rejectLiveMutation();
    return withSupervisorLock(() => persistSnapshot(snapshot));
  }

  async selectJob(jobId: string): Promise<SupervisorSnapshot> {
    if (isTauri()) {
      const snapshot = this.liveSnapshot ?? (await this.loadLiveSnapshot());
      if (!snapshot.jobs.some((job) => job.id === jobId)) {
        throw new Error(`supervisor job not found: ${jobId}`);
      }
      const selected = { ...snapshot, selectedJobId: jobId };
      this.liveSnapshot = selected;
      return clone(selected);
    }

    return this.mutate((snapshot) => {
      if (!snapshot.jobs.some((job) => job.id === jobId)) {
        throw new Error(`supervisor job not found: ${jobId}`);
      }
      return { ...snapshot, selectedJobId: jobId };
    });
  }

  async markProviderDown(
    jobId: string,
    now = new Date(),
  ): Promise<SupervisorSnapshot> {
    rejectLiveMutation();
    return this.mutate((snapshot) => markProviderDown(snapshot, jobId, now));
  }

  async markProviderHealthy(now = new Date()): Promise<SupervisorSnapshot> {
    rejectLiveMutation();
    return this.mutate((snapshot) => markProviderHealthy(snapshot, now));
  }

  async resumeJob(
    jobId: string,
    now = new Date(),
  ): Promise<SupervisorSnapshot> {
    rejectLiveMutation();
    return this.mutate((snapshot) => resumeSupervisorJob(snapshot, jobId, now));
  }

  async pauseJob(jobId: string, now = new Date()): Promise<SupervisorSnapshot> {
    rejectLiveMutation();
    return this.mutate((snapshot) => pauseSupervisorJob(snapshot, jobId, now));
  }

  async completeGoal(
    jobId: string,
    now = new Date(),
  ): Promise<SupervisorSnapshot> {
    rejectLiveMutation();
    return this.mutate((snapshot) =>
      completeSupervisorGoal(snapshot, jobId, now),
    );
  }

  async resetDemo(now = new Date()): Promise<SupervisorSnapshot> {
    rejectLiveMutation();
    return withSupervisorLock(() => persistSnapshot(createDemoSupervisor(now)));
  }

  private async loadLiveSnapshot(): Promise<SupervisorSnapshot> {
    const value = await invoke<unknown>("load_codex_supervisor");
    if (
      !isSupervisorSnapshot(value) ||
      value.source !== "codex" ||
      !value.readOnly
    ) {
      throw new Error("the Codex supervisor snapshot is invalid");
    }

    const selectedJobId = this.liveSnapshot?.selectedJobId;
    const snapshot =
      selectedJobId !== null &&
      selectedJobId !== undefined &&
      value.jobs.some((job) => job.id === selectedJobId)
        ? { ...value, selectedJobId }
        : value;
    this.liveSnapshot = clone(snapshot);
    return clone(snapshot);
  }

  private async mutate(
    transition: (snapshot: SupervisorSnapshot) => SupervisorSnapshot,
  ): Promise<SupervisorSnapshot> {
    return withSupervisorLock(() =>
      persistSnapshot(transition(loadSnapshot())),
    );
  }
}

export const supervisorClient: SupervisorClient = new HybridSupervisorClient();

function loadSnapshot(): SupervisorSnapshot {
  const input = browserStorage().getItem(STORAGE_KEY);
  if (input === null) return persistSnapshot(createDemoSupervisor());

  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    throw new Error("cannot read the local supervisor snapshot", {
      cause: error,
    });
  }
  const migrated = migrateLegacySnapshot(value);
  if (!isSupervisorSnapshot(migrated.value)) {
    throw new Error("the local supervisor snapshot is invalid");
  }
  return migrated.changed ? persistSnapshot(migrated.value) : migrated.value;
}

function persistSnapshot(snapshot: SupervisorSnapshot): SupervisorSnapshot {
  if (!isSupervisorSnapshot(snapshot)) {
    throw new Error("cannot persist an invalid supervisor snapshot");
  }
  const serialized = JSON.stringify(snapshot);
  browserStorage().setItem(STORAGE_KEY, serialized);
  return JSON.parse(serialized) as SupervisorSnapshot;
}

async function withSupervisorLock<T>(
  action: () => T | PromiseLike<T>,
): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (locks) {
    return locks.request(LOCK_NAME, { mode: "exclusive" }, () => action());
  }

  const previous = fallbackLock;
  let release!: () => void;
  fallbackLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

function isSupervisorSnapshot(value: unknown): value is SupervisorSnapshot {
  return (
    isRecord(value) &&
    value.version === 1 &&
    (value.source === "demo" || value.source === "codex") &&
    typeof value.readOnly === "boolean" &&
    isProviderHealth(value.provider) &&
    Array.isArray(value.jobs) &&
    value.jobs.every(isSupervisorJob) &&
    ((value.selectedJobId === null && value.jobs.length === 0) ||
      (typeof value.selectedJobId === "string" &&
        value.jobs.some((job) => job.id === value.selectedJobId)))
  );
}

function migrateLegacySnapshot(value: unknown): {
  value: unknown;
  changed: boolean;
} {
  if (!isRecord(value) || !Array.isArray(value.jobs)) {
    return { value, changed: false };
  }

  let changed = value.source === undefined || value.readOnly === undefined;
  const jobs = value.jobs.map((job) => {
    if (!isRecord(job)) return job;

    let migratedJob = job;
    if (job.tokensUsed === undefined) {
      changed = true;
      migratedJob = { ...migratedJob, tokensUsed: 0 };
    }
    if (isRecord(job.goal) && job.goal.status === "completed") {
      changed = true;
      migratedJob = {
        ...migratedJob,
        goal: { ...job.goal, status: "complete" },
      };
    }
    return migratedJob;
  });
  return changed
    ? {
        value: {
          ...value,
          source: value.source ?? "demo",
          readOnly: value.readOnly ?? false,
          jobs,
        },
        changed,
      }
    : { value, changed };
}

function isProviderHealth(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.baseUrl === "string" &&
    isProviderState(value.state) &&
    (value.latencyMs === null || isNonNegativeInteger(value.latencyMs)) &&
    isDateTime(value.checkedAt) &&
    typeof value.message === "string"
  );
}

function isSupervisorJob(value: unknown): value is SupervisorJob {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.title === "string" &&
    typeof value.threadId === "string" &&
    typeof value.workspace === "string" &&
    typeof value.originalGoal === "string" &&
    isRecord(value.goal) &&
    typeof value.goal.objective === "string" &&
    [
      "active",
      "paused",
      "blocked",
      "usageLimited",
      "budgetLimited",
      "complete",
    ].includes(String(value.goal.status)) &&
    isNonNegativeInteger(value.goal.tokenBudget) &&
    SUPERVISOR_STATUSES.includes(value.status as SupervisorJob["status"]) &&
    isNonNegativeInteger(value.attempts) &&
    isNonNegativeInteger(value.maxAttempts) &&
    isNonNegativeInteger(value.turnCount) &&
    isNonNegativeInteger(value.recoveryCount) &&
    isNonNegativeInteger(value.tokensUsed) &&
    isDateTime(value.createdAt) &&
    isDateTime(value.updatedAt) &&
    isOptionalDateTime(value.startedAt) &&
    isOptionalDateTime(value.finishedAt) &&
    isOptionalDateTime(value.nextRetryAt) &&
    (value.lastError === undefined || typeof value.lastError === "string") &&
    Array.isArray(value.events) &&
    value.events.every(isSupervisorEvent)
  );
}

function isSupervisorEvent(value: unknown): value is SupervisorEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isDateTime(value.at) &&
    typeof value.kind === "string" &&
    typeof value.title === "string" &&
    typeof value.detail === "string"
  );
}

function isProviderState(value: unknown): value is ProviderState {
  return value === "healthy" || value === "degraded" || value === "offline";
}

function isOptionalDateTime(value: unknown): boolean {
  return value === undefined || isDateTime(value);
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectLiveMutation(): void {
  if (isTauri()) {
    throw new Error("the live Codex supervisor is read-only");
  }
}

function browserStorage(): Storage {
  if (typeof globalThis.localStorage === "undefined") {
    throw new Error("local supervisor storage is unavailable");
  }
  return globalThis.localStorage;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
