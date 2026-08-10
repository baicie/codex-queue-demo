import { beforeEach, describe, expect, it } from "vitest";

import { supervisorClient } from "@/lib/supervisor/client";

describe("supervisorClient", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("seeds a local supervisor and persists provider recovery", async () => {
    const initial = await supervisorClient.load();
    const waiting = await supervisorClient.markProviderDown(
      initial.selectedJobId,
      new Date("2026-08-10T10:00:00.000Z"),
    );
    const reloaded = await supervisorClient.load();
    const job = reloaded.jobs.find(
      (candidate) => candidate.id === initial.selectedJobId,
    );

    expect(initial.jobs.length).toBeGreaterThan(0);
    expect(waiting.provider.state).toBe("offline");
    expect(job?.status).toBe("waiting");
    expect(job?.nextRetryAt).toBe("2026-08-10T10:00:30.000Z");
  });

  it("resumes the same thread and completes the persisted goal", async () => {
    const initial = await supervisorClient.load();
    const down = await supervisorClient.markProviderDown(
      "release-migration",
      new Date("2026-08-10T10:00:00.000Z"),
    );
    const healthy = await supervisorClient.markProviderHealthy(
      new Date("2026-08-10T10:01:00.000Z"),
    );
    const resumed = await supervisorClient.resumeJob(
      "release-migration",
      new Date("2026-08-10T10:01:05.000Z"),
    );
    const completed = await supervisorClient.completeGoal(
      "release-migration",
      new Date("2026-08-10T10:02:00.000Z"),
    );
    const job = completed.jobs.find(
      (candidate) => candidate.id === "release-migration",
    );

    expect(down.jobs[0]).toBeDefined();
    expect(healthy.provider.state).toBe("healthy");
    expect(
      resumed.jobs.find((candidate) => candidate.id === "release-migration")
        ?.threadId,
    ).toBe(
      initial.jobs.find((candidate) => candidate.id === "release-migration")
        ?.threadId,
    );
    expect(job?.status).toBe("completed");
    expect(job?.goal.status).toBe("complete");
  });

  it("migrates the earlier completed goal spelling to the app-server enum", async () => {
    const snapshot = await supervisorClient.load();
    const legacy = {
      ...snapshot,
      jobs: snapshot.jobs.map((job, index) =>
        index === 0
          ? { ...job, goal: { ...job.goal, status: "completed" } }
          : job,
      ),
    };
    localStorage.setItem("codex-queue.supervisor:v1", JSON.stringify(legacy));

    const migrated = await supervisorClient.load();

    expect(migrated.jobs[0].goal.status).toBe("complete");
    expect(
      JSON.parse(localStorage.getItem("codex-queue.supervisor:v1") ?? "null"),
    ).toEqual(migrated);
  });
});
