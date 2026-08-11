import type { SupervisorJob } from "@/domain/supervisor";

export type AppServerRequestId = number | string;

export interface AppServerRequest {
  id: AppServerRequestId;
  method: string;
  params: Record<string, unknown>;
}

export const RECOVERY_INSTRUCTION = `The previous turn was interrupted because the model provider became unavailable.

Continue the existing goal.

First inspect:
- the current working tree
- git diff
- previous completed work
- current test status

Do not repeat completed changes.
Continue from the first unfinished step.`;

export function createInitializeRequest(
  id: AppServerRequestId,
): AppServerRequest {
  return {
    id,
    method: "initialize",
    params: {
      clientInfo: {
        name: "codex-queue-supervisor",
        version: "0.3.0-dev.1",
      },
      capabilities: { experimentalApi: true },
    },
  };
}

export function createThreadResumeRequest(
  id: AppServerRequestId,
  job: SupervisorJob,
): AppServerRequest {
  return {
    id,
    method: "thread/resume",
    params: {
      threadId: job.threadId,
      cwd: job.workspace,
    },
  };
}

export function createRecoveryTurnRequest(
  id: AppServerRequestId,
  job: SupervisorJob,
): AppServerRequest {
  return {
    id,
    method: "turn/start",
    params: {
      threadId: job.threadId,
      cwd: job.workspace,
      input: [{ type: "text", text: RECOVERY_INSTRUCTION }],
    },
  };
}

export function createGoalSetRequest(
  id: AppServerRequestId,
  job: SupervisorJob,
): AppServerRequest {
  return {
    id,
    method: "thread/goal/set",
    params: {
      threadId: job.threadId,
      objective: job.goal.objective,
      status: job.goal.status,
      tokenBudget: job.goal.tokenBudget,
    },
  };
}
