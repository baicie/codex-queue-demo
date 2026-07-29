import { describe, expect, it } from "vitest";

import {
  createDemoQueue,
  createEmptyQueue,
  createQueueSnapshot,
  createTaskId,
  type AppInfo,
  type BlockedTask,
  type Queue,
  type QueueSnapshot,
  type RetryPolicy,
  type RunSummary,
  type Task,
  type TaskStatus,
} from "@/domain/queue";

describe("queue domain contract", () => {
  it("matches the Rust camelCase transport shapes", () => {
    const status: TaskStatus = "pending";
    const retryPolicy: RetryPolicy = {
      maxAttempts: 4,
      initialDelaySeconds: 30,
      maxDelaySeconds: 900,
    };
    const task: Task = {
      id: "prepare-release",
      title: "Prepare release",
      workspace: "/workspace",
      prompt: "Prepare the release notes",
      priority: 20,
      dependsOn: [],
      status,
      createdAt: "2026-07-28T00:00:00.000Z",
      attempts: 1,
      startedAt: "2026-07-28T00:01:00.000Z",
      finishedAt: "2026-07-28T00:02:00.000Z",
      lastError: "network unavailable",
      nextRetryAt: "2026-07-28T00:03:00.000Z",
    };
    const queue: Queue = {
      version: 1,
      launchApp: true,
      retryPolicy,
      tasks: [task],
    };
    const blocked: BlockedTask = {
      taskId: task.id,
      reasonCode: "dependencyUnavailable",
      dependencyId: "build",
    };
    const snapshot: QueueSnapshot = {
      path: "/tmp/queue.json",
      revision: "revision-1",
      queue,
      orderedIds: [task.id],
      blocked: [blocked],
    };
    const appInfo: AppInfo = {
      defaultQueuePath: "/tmp/queue.json",
      platform: "macos",
    };
    const summary: RunSummary = {
      plannedIds: [task.id],
      succeededIds: [],
      failedIds: [],
      blockedIds: [task.id],
    };

    expect({ snapshot, appInfo, summary }).toEqual({
      snapshot: {
        path: "/tmp/queue.json",
        revision: "revision-1",
        queue,
        orderedIds: [task.id],
        blocked: [blocked],
      },
      appInfo: {
        defaultQueuePath: "/tmp/queue.json",
        platform: "macos",
      },
      summary: {
        plannedIds: [task.id],
        succeededIds: [],
        failedIds: [],
        blockedIds: [task.id],
      },
    });
  });

  it("creates the same safe defaults as the Rust backend", () => {
    expect(createEmptyQueue()).toEqual({
      version: 1,
      launchApp: true,
      retryPolicy: {
        maxAttempts: 4,
        initialDelaySeconds: 30,
        maxDelaySeconds: 900,
      },
      tasks: [],
    });
  });

  it("creates a useful deterministic demo queue", () => {
    const queue = createDemoQueue(new Date("2026-07-28T00:00:00.000Z"));

    expect(queue.tasks).toHaveLength(3);
    expect(queue.tasks.map((task) => task.id)).toEqual([
      "inspect-project",
      "implement-change",
      "verify-result",
    ]);
    expect(queue.tasks[1].dependsOn).toEqual(["inspect-project"]);
    expect(queue.tasks[2].dependsOn).toEqual(["implement-change"]);
    expect(queue.tasks.every((task) => task.status === "pending")).toBe(true);
  });

  it("generates IDs accepted by Rust validation", () => {
    const first = createTaskId();
    const second = createTaskId();

    expect(first).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(second).not.toBe(first);
  });

  it("orders runnable tasks by priority, creation time, then ID", () => {
    const queue = createEmptyQueue();
    queue.tasks = [
      task({ id: "later", priority: 20, createdAt: "2026-07-28T00:02:00Z" }),
      task({ id: "z-task", priority: 20, createdAt: "2026-07-28T00:01:00Z" }),
      task({ id: "a-task", priority: 20, createdAt: "2026-07-28T00:01:00Z" }),
      task({ id: "low", priority: 1, createdAt: "2026-07-28T00:00:00Z" }),
    ];

    expect(
      createQueueSnapshot("queue.json", queue, "revision-1").orderedIds,
    ).toEqual(["a-task", "z-task", "later", "low"]);
  });

  it("uses Rust-compatible ASCII ordering when task IDs break a tie", () => {
    const queue = createEmptyQueue();
    queue.tasks = ["a", "A", "_", "-", "0"].map((id) => task({ id }));

    expect(
      createQueueSnapshot("queue.json", queue, "revision-1").orderedIds,
    ).toEqual(["-", "0", "A", "_", "a"]);
  });

  it("propagates failed dependencies into blocked tasks", () => {
    const queue = createEmptyQueue();
    queue.tasks = [
      task({ id: "failed", status: "failed" }),
      task({ id: "blocked-child", dependsOn: ["failed"] }),
      task({ id: "blocked-grandchild", dependsOn: ["blocked-child"] }),
    ];

    const snapshot = createQueueSnapshot("queue.json", queue, "revision-1");

    expect(snapshot.revision).toBe("revision-1");
    expect(snapshot.orderedIds).toEqual([]);
    expect(snapshot.blocked).toEqual([
      {
        taskId: "blocked-child",
        reasonCode: "dependencyUnavailable",
        dependencyId: "failed",
      },
      {
        taskId: "blocked-grandchild",
        reasonCode: "dependencyUnavailable",
        dependencyId: "blocked-child",
      },
    ]);
  });
});

function task(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    title: overrides.id,
    workspace: ".",
    prompt: `Complete ${overrides.id}`,
    priority: 10,
    dependsOn: [],
    status: "pending",
    createdAt: "2026-07-28T00:00:00Z",
    ...overrides,
  };
}
