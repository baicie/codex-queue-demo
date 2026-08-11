import { describe, expect, it } from "vitest";

import {
  completeSupervisorGoal,
  createDemoSupervisor,
} from "@/domain/supervisor";
import {
  RECOVERY_INSTRUCTION,
  createGoalSetRequest,
  createInitializeRequest,
  createRecoveryTurnRequest,
  createThreadResumeRequest,
} from "@/lib/supervisor/app-server-protocol";

describe("Codex app-server protocol requests", () => {
  it("initializes with the experimental goal capability enabled", () => {
    expect(createInitializeRequest(1)).toEqual({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codex-queue-supervisor", version: "0.3.0-dev.1" },
        capabilities: { experimentalApi: true },
      },
    });
  });

  it("resumes the persisted thread and starts a recovery turn in its workspace", () => {
    const job = createDemoSupervisor(new Date("2026-08-10T10:00:00.000Z"))
      .jobs[0];

    expect(createThreadResumeRequest(2, job)).toEqual({
      id: 2,
      method: "thread/resume",
      params: {
        threadId: "thr_release_migration",
        cwd: "~/Workspace/atlas-web",
      },
    });
    expect(createRecoveryTurnRequest(3, job)).toEqual({
      id: 3,
      method: "turn/start",
      params: {
        threadId: "thr_release_migration",
        cwd: "~/Workspace/atlas-web",
        input: [{ type: "text", text: RECOVERY_INSTRUCTION }],
      },
    });
    expect(RECOVERY_INSTRUCTION).toContain("git diff");
    expect(RECOVERY_INSTRUCTION).toContain("Do not repeat completed changes");
  });

  it("serializes the app-server goal completion status as complete", () => {
    const initial = createDemoSupervisor(new Date("2026-08-10T10:00:00.000Z"));
    const completed = completeSupervisorGoal(initial, "release-migration");
    const job = completed.jobs.find(
      (candidate) => candidate.id === "release-migration",
    )!;

    expect(createGoalSetRequest(4, job)).toEqual({
      id: 4,
      method: "thread/goal/set",
      params: {
        threadId: "thr_release_migration",
        objective: "完成 CI 发布流程迁移并保证所有检查通过。",
        status: "complete",
        tokenBudget: 40_000,
      },
    });
  });
});
