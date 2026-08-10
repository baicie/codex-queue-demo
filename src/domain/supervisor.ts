export const SUPERVISOR_STATUSES = [
  "queued",
  "running",
  "provider_down",
  "waiting",
  "resuming",
  "completed",
  "failed",
  "paused",
] as const;

export type SupervisorStatus = (typeof SUPERVISOR_STATUSES)[number];
export type GoalStatus = "active" | "completed" | "paused";
export type ProviderState = "healthy" | "degraded" | "offline";
export type SupervisorEventKind =
  | "job_created"
  | "turn_started"
  | "provider_down"
  | "retry_scheduled"
  | "provider_restored"
  | "recovery_turn_started"
  | "goal_completed"
  | "job_paused";

export interface SupervisorGoal {
  objective: string;
  status: GoalStatus;
  tokenBudget: number;
}

export interface SupervisorEvent {
  id: string;
  at: string;
  kind: SupervisorEventKind;
  title: string;
  detail: string;
}

export interface ProviderHealth {
  name: string;
  baseUrl: string;
  state: ProviderState;
  latencyMs: number | null;
  checkedAt: string;
  message: string;
}

export interface SupervisorJob {
  id: string;
  title: string;
  threadId: string;
  workspace: string;
  originalGoal: string;
  goal: SupervisorGoal;
  status: SupervisorStatus;
  attempts: number;
  maxAttempts: number;
  turnCount: number;
  recoveryCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  nextRetryAt?: string;
  lastError?: string;
  events: SupervisorEvent[];
}

export interface SupervisorSnapshot {
  version: 1;
  selectedJobId: string;
  provider: ProviderHealth;
  jobs: SupervisorJob[];
}

export interface SupervisorSummary {
  active: number;
  waiting: number;
  completed: number;
  attention: number;
}

export const DEFAULT_SUPERVISOR_RETRY = {
  initialDelaySeconds: 30,
  maxDelaySeconds: 900,
} as const;

export function createDemoSupervisor(now = new Date()): SupervisorSnapshot {
  const timestamp = now.toISOString();
  const releaseJob = createJob({
    id: "release-migration",
    title: "迁移 release pipeline",
    threadId: "thr_release_migration",
    workspace: "~/Workspace/atlas-web",
    originalGoal: "完成 CI 发布流程迁移并保证所有检查通过。",
    status: "running",
    attempts: 3,
    maxAttempts: 6,
    turnCount: 3,
    recoveryCount: 0,
    createdAt: new Date(now.getTime() - 38 * 60_000).toISOString(),
    updatedAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
    startedAt: new Date(now.getTime() - 38 * 60_000).toISOString(),
    events: [
      event("job_created", "任务已创建", "保存 job、thread 和工作区上下文。", now, -38),
      event("turn_started", "Turn 1 已开始", "Codex 正在检查当前工作区和迁移计划。", now, -34),
      event("turn_started", "Turn 3 执行中", "正在等待 provider 返回下一段模型输出。", now, -2),
    ],
  });
  const docsJob = createJob({
    id: "docs-refresh",
    title: "更新 API 文档",
    threadId: "thr_docs_refresh",
    workspace: "~/Workspace/atlas-web",
    originalGoal: "同步 API 文档、示例和变更日志。",
    status: "waiting",
    attempts: 2,
    maxAttempts: 6,
    turnCount: 2,
    recoveryCount: 1,
    createdAt: new Date(now.getTime() - 3 * 60 * 60_000).toISOString(),
    updatedAt: new Date(now.getTime() - 4 * 60_000).toISOString(),
    nextRetryAt: new Date(now.getTime() + 56_000).toISOString(),
    lastError: "Provider request timed out after 300s",
    events: [
      event("job_created", "任务已创建", "原始目标已保存到 Supervisor。", now, -180),
      event("turn_started", "Turn 2 已开始", "已读取上一轮的工作区变更。", now, -12),
      event("provider_down", "Provider 暂时不可用", "请求超时，等待中转站恢复。", now, -4),
      event("retry_scheduled", "已安排下一次探测", "指数退避等待 60 秒。", now, -4),
    ],
  });
  const completedJob = createJob({
    id: "dependency-audit",
    title: "依赖安全审计",
    threadId: "thr_dependency_audit",
    workspace: "~/Workspace/atlas-web",
    originalGoal: "完成依赖审计并记录需要处理的风险。",
    status: "completed",
    attempts: 1,
    maxAttempts: 4,
    turnCount: 2,
    recoveryCount: 0,
    createdAt: new Date(now.getTime() - 8 * 60 * 60_000).toISOString(),
    updatedAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
    finishedAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
    events: [
      event("job_created", "任务已创建", "目标和 thread 已持久化。", now, -480),
      event("turn_started", "Turn 1 已完成", "已完成依赖扫描和结果汇总。", now, -30),
      event("goal_completed", "目标已完成", "所有验证步骤均已通过。", now, -20),
    ],
  });

  return {
    version: 1,
    selectedJobId: releaseJob.id,
    provider: {
      name: "Atlas Relay",
      baseUrl: "http://localhost:3000/v1",
      state: "healthy",
      latencyMs: 182,
      checkedAt: timestamp,
      message: "Responses API 可用",
    },
    jobs: [releaseJob, docsJob, completedJob],
  };
}

export function markProviderDown(
  snapshot: SupervisorSnapshot,
  jobId: string,
  now = new Date(),
): SupervisorSnapshot {
  const job = requireJob(snapshot, jobId);
  const retrySeconds = retryDelaySeconds(job.recoveryCount + 1);
  const nextRetryAt = new Date(now.getTime() + retrySeconds * 1000).toISOString();
  const updatedJob = updateJob(job, {
    status: "waiting",
    recoveryCount: job.recoveryCount + 1,
    nextRetryAt,
    lastError: "Provider request timed out after 300s",
    updatedAt: now.toISOString(),
    events: [
      ...job.events,
      makeEvent(
        "provider_down",
        "Provider 暂时不可用",
        "请求失败，Supervisor 保留当前 thread 并等待恢复。",
        now,
      ),
      makeEvent(
        "retry_scheduled",
        "已安排下一次探测",
        `指数退避等待 ${retrySeconds} 秒。`,
        now,
      ),
    ],
  });

  return {
    ...snapshot,
    provider: {
      ...snapshot.provider,
      state: "offline",
      latencyMs: null,
      checkedAt: now.toISOString(),
      message: "等待中转站恢复",
    },
    jobs: replaceJob(snapshot.jobs, updatedJob),
  };
}

export function markProviderHealthy(
  snapshot: SupervisorSnapshot,
  now = new Date(),
): SupervisorSnapshot {
  const waitingJobs = snapshot.jobs.map((job) => {
    if (job.status !== "waiting") return job;
    return updateJob(job, {
      updatedAt: now.toISOString(),
      events: [
        ...job.events,
        makeEvent(
          "provider_restored",
          "Provider 已恢复",
          "健康检查通过，可以创建恢复 turn。",
          now,
        ),
      ],
    });
  });
  return {
    ...snapshot,
    provider: {
      ...snapshot.provider,
      state: "healthy",
      latencyMs: 164,
      checkedAt: now.toISOString(),
      message: "Responses API 可用",
    },
    jobs: waitingJobs,
  };
}

export function resumeSupervisorJob(
  snapshot: SupervisorSnapshot,
  jobId: string,
  now = new Date(),
): SupervisorSnapshot {
  const job = requireJob(snapshot, jobId);
  if (snapshot.provider.state === "offline") {
    throw new Error("provider is still offline");
  }
  const updatedJob = updateJob(job, {
    status: "resuming",
    attempts: job.attempts + 1,
    turnCount: job.turnCount + 1,
    nextRetryAt: undefined,
    lastError: undefined,
    updatedAt: now.toISOString(),
    events: [
      ...job.events,
      makeEvent(
        "recovery_turn_started",
        `恢复 Turn ${job.turnCount + 1} 已开始`,
        `thread/resume ${job.threadId}，检查工作区后继续原目标。`,
        now,
      ),
    ],
  });
  return { ...snapshot, jobs: replaceJob(snapshot.jobs, updatedJob) };
}

export function completeSupervisorGoal(
  snapshot: SupervisorSnapshot,
  jobId: string,
  now = new Date(),
): SupervisorSnapshot {
  const job = requireJob(snapshot, jobId);
  const updatedJob = updateJob(job, {
    status: "completed",
    finishedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    nextRetryAt: undefined,
    lastError: undefined,
    goal: { ...job.goal, status: "completed" },
    events: [
      ...job.events,
      makeEvent(
        "goal_completed",
        "目标已完成",
        "恢复后的验证通过，Supervisor 已结束该 job。",
        now,
      ),
    ],
  });
  return { ...snapshot, jobs: replaceJob(snapshot.jobs, updatedJob) };
}

export function pauseSupervisorJob(
  snapshot: SupervisorSnapshot,
  jobId: string,
  now = new Date(),
): SupervisorSnapshot {
  const job = requireJob(snapshot, jobId);
  const updatedJob = updateJob(job, {
    status: "paused",
    updatedAt: now.toISOString(),
    goal: { ...job.goal, status: "paused" },
    events: [
      ...job.events,
      makeEvent("job_paused", "任务已暂停", "等待手动恢复执行。", now),
    ],
  });
  return { ...snapshot, jobs: replaceJob(snapshot.jobs, updatedJob) };
}

export function retryDelaySeconds(
  retryNumber: number,
  initialDelaySeconds = DEFAULT_SUPERVISOR_RETRY.initialDelaySeconds,
  maxDelaySeconds = DEFAULT_SUPERVISOR_RETRY.maxDelaySeconds,
): number {
  const exponent = Math.max(0, Math.min(retryNumber - 1, 30));
  return Math.min(maxDelaySeconds, initialDelaySeconds * 2 ** exponent);
}

export function summarizeSupervisor(
  snapshot: SupervisorSnapshot,
): SupervisorSummary {
  return snapshot.jobs.reduce<SupervisorSummary>(
    (summary, job) => {
      if (["running", "resuming", "queued"].includes(job.status)) summary.active += 1;
      if (["waiting", "provider_down"].includes(job.status)) summary.waiting += 1;
      if (job.status === "completed") summary.completed += 1;
      if (["failed", "paused"].includes(job.status)) summary.attention += 1;
      return summary;
    },
    { active: 0, waiting: 0, completed: 0, attention: 0 },
  );
}

function createJob(input: Omit<SupervisorJob, "goal" | "originalGoal"> & { originalGoal: string }): SupervisorJob {
  return {
    ...input,
    goal: { objective: input.originalGoal, status: "active", tokenBudget: 40_000 },
  };
}

function updateJob(
  job: SupervisorJob,
  changes: Partial<SupervisorJob>,
): SupervisorJob {
  return { ...job, ...changes };
}

function replaceJob(jobs: SupervisorJob[], updatedJob: SupervisorJob): SupervisorJob[] {
  return jobs.map((job) => (job.id === updatedJob.id ? updatedJob : job));
}

function requireJob(snapshot: SupervisorSnapshot, jobId: string): SupervisorJob {
  const job = snapshot.jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`supervisor job not found: ${jobId}`);
  return job;
}

function event(
  kind: SupervisorEventKind,
  title: string,
  detail: string,
  now: Date,
  minutesOffset: number,
): SupervisorEvent {
  return makeEvent(kind, title, detail, new Date(now.getTime() + minutesOffset * 60_000));
}

function makeEvent(
  kind: SupervisorEventKind,
  title: string,
  detail: string,
  at: Date,
): SupervisorEvent {
  return {
    id: `${kind}-${at.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    at: at.toISOString(),
    kind,
    title,
    detail,
  };
}
