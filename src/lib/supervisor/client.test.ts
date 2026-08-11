import { invoke, isTauri } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDemoSupervisor,
  type SupervisorSnapshot,
} from "@/domain/supervisor";
import { supervisorClient } from "@/lib/supervisor/client";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const isTauriMock = vi.mocked(isTauri);

describe("supervisorClient", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    isTauriMock.mockReturnValue(false);
  });

  it("seeds a local supervisor and persists provider recovery", async () => {
    const initial = await supervisorClient.load();
    const waiting = await supervisorClient.markProviderDown(
      initial.selectedJobId!,
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

describe("supervisorClient in Tauri", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    isTauriMock.mockReturnValue(true);
  });

  it("loads live Codex tasks and preserves the selected thread across refreshes", async () => {
    const live = createLiveSnapshot();
    invokeMock.mockResolvedValue(live);

    const loaded = await supervisorClient.load();
    await supervisorClient.selectJob("live-thread-2");
    const refreshed = await supervisorClient.load();

    expect(invokeMock.mock.calls).toEqual([
      ["load_codex_supervisor"],
      ["load_codex_supervisor"],
    ]);
    expect(loaded.source).toBe("codex");
    expect(loaded.readOnly).toBe(true);
    expect(refreshed.selectedJobId).toBe("live-thread-2");
    await expect(supervisorClient.pauseJob("live-thread-2")).rejects.toThrow(
      "read-only",
    );
  });

  it("resumes a live Codex thread through Tauri and reloads the snapshot", async () => {
    const live = createLiveSnapshot();
    const refreshed = {
      ...live,
      selectedJobId: "live-thread-2",
      jobs: live.jobs.map((job) =>
        job.id === "live-thread-2"
          ? { ...job, status: "resuming" as const }
          : job,
      ),
    };
    invokeMock.mockImplementation(async (command) => {
      if (command === "load_codex_supervisor") return refreshed;
      return undefined;
    });

    await supervisorClient.load();
    const result = await supervisorClient.resumeJob("live-thread-2");

    expect(invokeMock.mock.calls).toEqual([
      ["load_codex_supervisor"],
      ["resume_codex_thread", { threadId: "live-thread-2" }],
      ["load_codex_supervisor"],
    ]);
    expect(result).toEqual(refreshed);
  });

  it("completes a live Codex goal through Tauri and reloads the snapshot", async () => {
    const live = createLiveSnapshot();
    const refreshed = {
      ...live,
      jobs: live.jobs.map((job) =>
        job.id === "live-thread-1"
          ? {
              ...job,
              status: "completed" as const,
              goal: { ...job.goal, status: "complete" as const },
            }
          : job,
      ),
    };
    invokeMock.mockImplementation(async (command) => {
      if (command === "load_codex_supervisor") return refreshed;
      return undefined;
    });

    await supervisorClient.load();
    await supervisorClient.selectJob("live-thread-1");
    const result = await supervisorClient.completeGoal("live-thread-1");

    expect(invokeMock.mock.calls).toEqual([
      ["load_codex_supervisor"],
      ["complete_codex_goal", { threadId: "live-thread-1" }],
      ["load_codex_supervisor"],
    ]);
    expect(result).toEqual(refreshed);
  });
});

function createLiveSnapshot(): SupervisorSnapshot {
  const demo = createDemoSupervisor(new Date("2026-08-11T00:00:00.000Z"));
  const jobs = demo.jobs.slice(0, 2).map((job, index) => ({
    ...job,
    id: `live-thread-${index + 1}`,
    threadId: `live-thread-${index + 1}`,
    title: `Live task ${index + 1}`,
    tokensUsed: 1_200 + index,
  }));
  return {
    ...demo,
    source: "codex",
    readOnly: true,
    selectedJobId: jobs[0].id,
    jobs,
  };
}
