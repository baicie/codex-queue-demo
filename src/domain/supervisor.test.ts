import { describe, expect, it } from "vitest";

import {
  completeSupervisorGoal,
  createDemoSupervisor,
  markProviderDown,
  markProviderHealthy,
  pauseSupervisorJob,
  resumeSupervisorJob,
  type SupervisorSnapshot,
} from "@/domain/supervisor";

describe("supervisor state transitions", () => {
  it("moves a running job into provider recovery with exponential backoff", () => {
    const now = new Date("2026-08-10T10:00:00.000Z");
    const snapshot = createDemoSupervisor(now);

    const waiting = markProviderDown(snapshot, "release-migration", now);
    const job = findJob(waiting, "release-migration");

    expect(waiting.provider.state).toBe("offline");
    expect(job.status).toBe("waiting");
    expect(job.nextRetryAt).toBe("2026-08-10T10:00:30.000Z");
    expect(job.events.at(-1)?.kind).toBe("retry_scheduled");
  });

  it("keeps the thread and starts a recovery turn after the provider returns", () => {
    const now = new Date("2026-08-10T10:00:00.000Z");
    const snapshot = createDemoSupervisor(now);
    const waiting = markProviderDown(snapshot, "release-migration", now);
    const healthy = markProviderHealthy(
      waiting,
      new Date("2026-08-10T10:01:00.000Z"),
    );
    const resumed = resumeSupervisorJob(
      healthy,
      "release-migration",
      new Date("2026-08-10T10:01:05.000Z"),
    );
    const job = findJob(resumed, "release-migration");

    expect(job.threadId).toBe("thr_release_migration");
    expect(job.status).toBe("resuming");
    expect(job.turnCount).toBe(4);
    expect(job.events.at(-1)?.kind).toBe("recovery_turn_started");
    expect(job.events.at(-1)?.detail).toContain("thr_release_migration");
  });

  it("reactivates a paused goal when its job resumes", () => {
    const now = new Date("2026-08-10T10:00:00.000Z");
    const snapshot = createDemoSupervisor(now);
    const paused = pauseSupervisorJob(snapshot, "release-migration", now);

    const resumed = resumeSupervisorJob(
      paused,
      "release-migration",
      new Date("2026-08-10T10:01:00.000Z"),
    );
    const job = findJob(resumed, "release-migration");

    expect(job.status).toBe("resuming");
    expect(job.goal.status).toBe("active");
  });

  it("clears the retry schedule when provider recovery is paused", () => {
    const now = new Date("2026-08-10T10:00:00.000Z");
    const snapshot = createDemoSupervisor(now);
    const waiting = markProviderDown(snapshot, "release-migration", now);

    const paused = pauseSupervisorJob(
      waiting,
      "release-migration",
      new Date("2026-08-10T10:00:05.000Z"),
    );
    const job = findJob(paused, "release-migration");

    expect(job.status).toBe("paused");
    expect(job.goal.status).toBe("paused");
    expect(job.nextRetryAt).toBeUndefined();
  });

  it("marks both the goal and its job complete", () => {
    const now = new Date("2026-08-10T10:00:00.000Z");
    const snapshot = createDemoSupervisor(now);

    const completed = completeSupervisorGoal(
      snapshot,
      "release-migration",
      now,
    );
    const job = findJob(completed, "release-migration");

    expect(job.status).toBe("completed");
    expect(job.goal.status).toBe("complete");
    expect(job.nextRetryAt).toBeUndefined();
    expect(job.events.at(-1)?.kind).toBe("goal_completed");
  });

  it("does not move a completed job back into recovery", () => {
    const snapshot = createDemoSupervisor(new Date("2026-08-10T10:00:00.000Z"));

    expect(() =>
      markProviderDown(
        snapshot,
        "dependency-audit",
        new Date("2026-08-10T10:00:00.000Z"),
      ),
    ).toThrow("completed job cannot enter provider recovery");
  });

  it("does not pause a completed job", () => {
    const snapshot = createDemoSupervisor(new Date("2026-08-10T10:00:00.000Z"));

    expect(() =>
      pauseSupervisorJob(
        snapshot,
        "dependency-audit",
        new Date("2026-08-10T10:00:00.000Z"),
      ),
    ).toThrow("completed job cannot be paused");
  });
});

function findJob(snapshot: SupervisorSnapshot, jobId: string) {
  const job = snapshot.jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`missing test job ${jobId}`);
  return job;
}
