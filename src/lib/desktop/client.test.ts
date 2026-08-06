import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyQueue, type QueueSnapshot } from "@/domain/queue";
import { desktopClient } from "@/lib/desktop/client";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const isTauriMock = vi.mocked(isTauri);
const openMock = vi.mocked(open);
const saveMock = vi.mocked(save);

describe("desktopClient in Tauri", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    isTauriMock.mockReturnValue(true);
  });

  it("uses the exact Tauri command names and camelCase arguments", async () => {
    const queue = createEmptyQueue();
    const snapshot: QueueSnapshot = {
      path: "/tmp/queue.json",
      revision: "revision-1",
      queue,
      orderedIds: [],
      blocked: [],
    };
    invokeMock
      .mockResolvedValueOnce({
        defaultQueuePath: "/tmp/queue.json",
        platform: "macos",
      })
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({
        plannedIds: [],
        succeededIds: [],
        failedIds: [],
        blockedIds: [],
      })
      .mockResolvedValueOnce([
        {
          id: "20260730T020000Z-task-a-attempt-2-newer",
          attempt: 2,
          startedAt: "2026-07-30T02:00:00Z",
        },
      ])
      .mockResolvedValueOnce({
        run: {
          id: "20260730T020000Z-task-a-attempt-2-newer",
          attempt: 2,
          startedAt: "2026-07-30T02:00:00Z",
        },
        finalOutput: { content: "done", truncated: false },
        events: { content: "{}\n", truncated: false },
        stderr: { content: "", truncated: false },
      });

    await desktopClient.getAppInfo();
    await desktopClient.loadQueue(snapshot.path);
    await desktopClient.saveQueue(snapshot.path, queue, snapshot.revision);
    await desktopClient.runQueue(snapshot.path, "/opt/codex");
    await desktopClient.listTaskRuns(snapshot.path, "task-a");
    await desktopClient.readTaskRun(
      snapshot.path,
      "task-a",
      "20260730T020000Z-task-a-attempt-2-newer",
    );

    expect(invokeMock.mock.calls).toEqual([
      ["app_info"],
      ["load_queue", { path: snapshot.path }],
      [
        "save_queue",
        {
          path: snapshot.path,
          queue,
          expectedRevision: snapshot.revision,
          expectedRevisionPath: snapshot.path,
        },
      ],
      ["run_queue", { path: snapshot.path, codexBin: "/opt/codex" }],
      ["list_task_runs", { path: snapshot.path, taskId: "task-a" }],
      [
        "read_task_run",
        {
          path: snapshot.path,
          taskId: "task-a",
          runId: "20260730T020000Z-task-a-attempt-2-newer",
        },
      ],
    ]);
  });

  it("opens a selected JSON queue and treats dialog cancellation as a no-op", async () => {
    const queue = createEmptyQueue();
    const snapshot: QueueSnapshot = {
      path: "/tmp/opened.json",
      revision: "revision-opened",
      queue,
      orderedIds: [],
      blocked: [],
    };
    openMock.mockResolvedValueOnce(null).mockResolvedValueOnce(snapshot.path);
    invokeMock.mockResolvedValueOnce(snapshot);

    await expect(desktopClient.openQueueFile()).resolves.toBeNull();
    await expect(desktopClient.openQueueFile()).resolves.toEqual(snapshot);

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("load_queue", {
      path: snapshot.path,
    });
  });

  it("saves to a selected JSON path and treats dialog cancellation as a no-op", async () => {
    const queue = createEmptyQueue();
    const snapshot: QueueSnapshot = {
      path: "/tmp/saved.json",
      revision: "revision-saved",
      queue,
      orderedIds: [],
      blocked: [],
    };
    const selectedPath = "/tmp/./saved.json";
    saveMock.mockResolvedValueOnce(null).mockResolvedValueOnce(selectedPath);
    invokeMock.mockResolvedValueOnce(snapshot);

    await expect(
      desktopClient.saveQueueFile(queue, snapshot.path, "revision-before-save"),
    ).resolves.toBeNull();
    await expect(
      desktopClient.saveQueueFile(queue, snapshot.path, "revision-before-save"),
    ).resolves.toEqual(snapshot);

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("save_queue", {
      path: selectedPath,
      queue,
      expectedRevision: "revision-before-save",
      expectedRevisionPath: snapshot.path,
    });
  });

  it("preserves human-readable backend failures", async () => {
    invokeMock.mockRejectedValue(
      "another queue worker already holds queue.json.lock",
    );

    await expect(desktopClient.loadQueue("queue.json")).rejects.toThrow(
      "another queue worker already holds queue.json.lock",
    );
  });
});

describe("desktopClient in a browser", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    isTauriMock.mockReturnValue(false);
  });

  it("seeds a demo queue and persists edits in localStorage", async () => {
    const appInfo = await desktopClient.getAppInfo();
    const seeded = await desktopClient.loadQueue(appInfo.defaultQueuePath);
    const edited = {
      ...seeded.queue,
      launchApp: false,
      tasks: seeded.queue.tasks.map((task, index) =>
        index === 0 ? { ...task, title: "Persisted title" } : task,
      ),
    };

    await desktopClient.saveQueue(
      appInfo.defaultQueuePath,
      edited,
      seeded.revision,
    );
    const reloaded = await desktopClient.loadQueue(appInfo.defaultQueuePath);

    expect(appInfo.platform).toBe("browser");
    expect(seeded.queue.tasks.length).toBeGreaterThan(0);
    expect(reloaded.queue.launchApp).toBe(false);
    expect(reloaded.queue.tasks[0].title).toBe("Persisted title");
  });

  it("keeps browser file actions usable without a native dialog", async () => {
    const opened = await desktopClient.openQueueFile();
    expect(opened).not.toBeNull();

    const saved = await desktopClient.saveQueueFile(
      opened!.queue,
      "browser://queues/custom.json",
    );

    expect(saved?.path).toBe("browser://queues/custom.json");
    await expect(
      desktopClient.loadQueue("browser://queues/custom.json"),
    ).resolves.toEqual(saved);
  });

  it("migrates an existing raw browser queue to a revisioned envelope", async () => {
    const path = "browser://queues/legacy.json";
    const queue = createEmptyQueue();
    localStorage.setItem(`codex-queue.queue:${path}`, JSON.stringify(queue));

    const loaded = await desktopClient.loadQueue(path);
    const stored = JSON.parse(
      localStorage.getItem(`codex-queue.queue:${path}`) ?? "null",
    );

    expect(loaded.revision).toEqual(expect.any(String));
    expect(loaded.revision).not.toBe("");
    expect(stored).toEqual({ revision: loaded.revision, queue });
  });

  it("serializes browser saves with a cross-context exclusive lock", async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(
      window.navigator,
      "locks",
    );
    const request = vi.fn(
      async (_name: string, _options: LockOptions, callback: () => unknown) =>
        callback(),
    );
    Object.defineProperty(window.navigator, "locks", {
      configurable: true,
      value: { request } as unknown as LockManager,
    });

    try {
      const { defaultQueuePath } = await desktopClient.getAppInfo();
      const loaded = await desktopClient.loadQueue(defaultQueuePath);

      await desktopClient.saveQueue(
        defaultQueuePath,
        { ...loaded.queue, launchApp: false },
        loaded.revision,
      );

      expect(request).toHaveBeenCalledWith(
        `codex-queue.queue-lock:${defaultQueuePath}`,
        { mode: "exclusive" },
        expect.any(Function),
      );
    } finally {
      if (originalLocks) {
        Object.defineProperty(window.navigator, "locks", originalLocks);
      } else {
        Reflect.deleteProperty(window.navigator, "locks");
      }
    }
  });

  it("simulates a queue run and persists succeeded task state", async () => {
    const { defaultQueuePath } = await desktopClient.getAppInfo();
    const before = await desktopClient.loadQueue(defaultQueuePath);

    const summary = await desktopClient.runQueue(defaultQueuePath);
    const after = await desktopClient.loadQueue(defaultQueuePath);
    const completedTask = after.queue.tasks[0];
    const runs = await desktopClient.listTaskRuns(
      defaultQueuePath,
      completedTask.id,
    );
    expect(runs).toHaveLength(1);
    const output = await desktopClient.readTaskRun(
      defaultQueuePath,
      completedTask.id,
      runs[0].id,
    );

    expect(summary.plannedIds).toEqual(before.orderedIds);
    expect(summary.succeededIds).toEqual(before.orderedIds);
    expect(after.queue.tasks.every((task) => task.status === "succeeded")).toBe(
      true,
    );
    expect(runs).toEqual([
      expect.objectContaining({
        attempt: 1,
        startedAt: completedTask.finishedAt,
      }),
    ]);
    expect(output.finalOutput.content).toContain('"mode": "browser-demo"');
    expect(output.events.content).toContain('"type":"task.completed"');
    expect(output.stderr.content).toBe("");
  });

  it("does not expose browser runs after a task ID is recreated", async () => {
    const { defaultQueuePath } = await desktopClient.getAppInfo();
    await desktopClient.runQueue(defaultQueuePath);
    const completed = await desktopClient.loadQueue(defaultQueuePath);
    const task = completed.queue.tasks[0];
    const [oldRun] = await desktopClient.listTaskRuns(
      defaultQueuePath,
      task.id,
    );
    const recreatedQueue = {
      ...completed.queue,
      tasks: completed.queue.tasks.map((candidate) =>
        candidate.id === task.id
          ? { ...candidate, createdAt: "2099-01-01T00:00:00Z" }
          : candidate,
      ),
    };

    await desktopClient.saveQueue(
      defaultQueuePath,
      recreatedQueue,
      completed.revision,
    );

    await expect(
      desktopClient.listTaskRuns(defaultQueuePath, task.id),
    ).resolves.toEqual([]);
    await expect(
      desktopClient.readTaskRun(
        defaultQueuePath,
        task.id,
        oldRun?.id ?? "missing-run",
      ),
    ).rejects.toThrow(`run not found for task ${task.id}`);
  });

  it("rejects malformed browser run storage", async () => {
    const { defaultQueuePath } = await desktopClient.getAppInfo();
    const before = await desktopClient.loadQueue(defaultQueuePath);
    const task = before.queue.tasks[0];
    localStorage.setItem(
      `codex-queue.runs:${defaultQueuePath}`,
      JSON.stringify([{ taskId: task.id }]),
    );

    await expect(
      desktopClient.listTaskRuns(defaultQueuePath, task.id),
    ).rejects.toThrow("invalid browser run storage");
    await expect(desktopClient.runQueue(defaultQueuePath)).rejects.toThrow(
      "invalid browser run storage",
    );

    const after = await desktopClient.loadQueue(defaultQueuePath);
    expect(after.queue.tasks.map((candidate) => candidate.status)).toEqual(
      before.queue.tasks.map((candidate) => candidate.status),
    );
  });

  it("rolls back browser task state when run output cannot be stored", async () => {
    const { defaultQueuePath } = await desktopClient.getAppInfo();
    const before = await desktopClient.loadQueue(defaultQueuePath);
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === `codex-queue.runs:${defaultQueuePath}`) {
          throw new DOMException("run storage is full", "QuotaExceededError");
        }
        return originalSetItem.call(this, key, value);
      });

    try {
      await expect(desktopClient.runQueue(defaultQueuePath)).rejects.toThrow(
        "run storage is full",
      );

      const after = await desktopClient.loadQueue(defaultQueuePath);
      expect(after.revision).toBe(before.revision);
      expect(after.queue).toEqual(before.queue);
    } finally {
      setItem.mockRestore();
    }
  });

  it("keeps browser run persistence inside the queue's exclusive lock", async () => {
    const { defaultQueuePath } = await desktopClient.getAppInfo();
    await desktopClient.loadQueue(defaultQueuePath);
    const originalLocks = Object.getOwnPropertyDescriptor(
      window.navigator,
      "locks",
    );
    let lockDepth = 0;
    const request = vi.fn(
      async (_name: string, _options: LockOptions, callback: () => unknown) => {
        lockDepth += 1;
        try {
          return await callback();
        } finally {
          lockDepth -= 1;
        }
      },
    );
    Object.defineProperty(window.navigator, "locks", {
      configurable: true,
      value: { request } as unknown as LockManager,
    });
    const originalSetItem = Storage.prototype.setItem;
    let storedRunInsideLock = false;
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === `codex-queue.runs:${defaultQueuePath}`) {
          storedRunInsideLock = lockDepth === 1;
        }
        return originalSetItem.call(this, key, value);
      });

    try {
      await desktopClient.runQueue(defaultQueuePath);

      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(
        `codex-queue.queue-lock:${defaultQueuePath}`,
        { mode: "exclusive" },
        expect.any(Function),
      );
      expect(storedRunInsideLock).toBe(true);
    } finally {
      setItem.mockRestore();
      if (originalLocks) {
        Object.defineProperty(window.navigator, "locks", originalLocks);
      } else {
        Reflect.deleteProperty(window.navigator, "locks");
      }
    }
  });

  it("prunes browser run records for deleted task instances", async () => {
    const { defaultQueuePath } = await desktopClient.getAppInfo();
    await desktopClient.runQueue(defaultQueuePath);
    const completed = await desktopClient.loadQueue(defaultQueuePath);
    const retainedTask = completed.queue.tasks[0];
    const requeued = {
      ...completed.queue,
      tasks: [
        {
          ...retainedTask,
          status: "pending" as const,
          dependsOn: [],
        },
      ],
    };
    await desktopClient.saveQueue(
      defaultQueuePath,
      requeued,
      completed.revision,
    );

    await desktopClient.runQueue(defaultQueuePath);

    const stored: unknown = JSON.parse(
      localStorage.getItem(`codex-queue.runs:${defaultQueuePath}`) ?? "null",
    );
    expect(stored).toEqual([
      expect.objectContaining({ taskId: retainedTask.id }),
      expect.objectContaining({ taskId: retainedTask.id }),
    ]);
  });

  it("persists a structured reason when a browser task is blocked", async () => {
    const path = "browser://queues/blocked.json";
    const queue = createEmptyQueue();
    queue.tasks = [
      {
        id: "failed-parent",
        title: "Failed parent",
        workspace: ".",
        prompt: "Fail",
        priority: 10,
        dependsOn: [],
        status: "failed",
        createdAt: "2026-07-28T00:00:00Z",
      },
      {
        id: "blocked-child",
        title: "Blocked child",
        workspace: ".",
        prompt: "Wait for parent",
        priority: 5,
        dependsOn: ["failed-parent"],
        status: "pending",
        createdAt: "2026-07-28T00:01:00Z",
      },
    ];
    await desktopClient.saveQueueFile(queue, path);

    await desktopClient.runQueue(path);
    const persisted = await desktopClient.loadQueue(path);
    const child = persisted.queue.tasks.find(
      (task) => task.id === "blocked-child",
    );

    expect(child).toEqual(
      expect.objectContaining({
        status: "blocked",
        blockedReason: {
          reasonCode: "dependencyUnavailable",
          dependencyId: "failed-parent",
        },
      }),
    );
    expect(child).not.toHaveProperty("lastError");
  });

  it("rejects a stale browser save without overwriting newer task state", async () => {
    const { defaultQueuePath } = await desktopClient.getAppInfo();
    const stale = await desktopClient.loadQueue(defaultQueuePath);
    const schedulerQueue = {
      ...stale.queue,
      tasks: stale.queue.tasks.map((task, index) =>
        index === 0 ? { ...task, status: "succeeded" as const } : task,
      ),
    };
    const schedulerSnapshot = await desktopClient.saveQueue(
      defaultQueuePath,
      schedulerQueue,
      stale.revision,
    );
    const staleUiQueue = { ...stale.queue, launchApp: false };

    await expect(
      desktopClient.saveQueue(defaultQueuePath, staleUiQueue, stale.revision),
    ).rejects.toThrow("queue changed since it was loaded");

    const preserved = await desktopClient.loadQueue(defaultQueuePath);
    expect(preserved.revision).toBe(schedulerSnapshot.revision);
    expect(preserved.queue.tasks[0].status).toBe("succeeded");
    expect(preserved.queue.launchApp).toBe(stale.queue.launchApp);
  });

  it("reports missing browser queues with a readable path", async () => {
    await expect(
      desktopClient.loadQueue("browser://queues/missing.json"),
    ).rejects.toThrow("Queue file not found: browser://queues/missing.json");
  });
});
