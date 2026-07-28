import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildExecutionPlan, parseQueueFile } from "../src/queue.js";
import type { QueueTask } from "../src/types.js";

describe("parseQueueFile", () => {
  it("rejects duplicate task IDs", () => {
    const input = {
      version: 1,
      launchApp: false,
      tasks: [task("same"), task("same")],
    };

    assert.throws(() => parseQueueFile(input), /Duplicate task ID: same/);
  });

  it("rejects dependencies that do not exist", () => {
    const input = {
      version: 1,
      launchApp: false,
      tasks: [task("child", { dependsOn: ["missing"] })],
    };

    assert.throws(
      () => parseQueueFile(input),
      /Task child depends on unknown task: missing/,
    );
  });
});

describe("buildExecutionPlan", () => {
  it("orders runnable work by dependencies, priority, creation time, then ID", () => {
    const queue = parseQueueFile({
      version: 1,
      launchApp: false,
      tasks: [
        task("dependent-high", {
          priority: 100,
          dependsOn: ["foundation"],
          createdAt: "2026-07-28T00:00:04.000Z",
        }),
        task("later", {
          priority: 50,
          createdAt: "2026-07-28T00:00:03.000Z",
        }),
        task("earlier-b", {
          priority: 50,
          createdAt: "2026-07-28T00:00:01.000Z",
        }),
        task("earlier-a", {
          priority: 50,
          createdAt: "2026-07-28T00:00:01.000Z",
        }),
        task("foundation", {
          priority: 10,
          createdAt: "2026-07-28T00:00:02.000Z",
        }),
      ],
    });

    const plan = buildExecutionPlan(queue);

    assert.deepEqual(
      plan.ordered.map((item: QueueTask) => item.id),
      ["earlier-a", "earlier-b", "later", "foundation", "dependent-high"],
    );
    assert.deepEqual(plan.blocked, []);
  });

  it("blocks pending tasks whose dependencies have failed", () => {
    const queue = parseQueueFile({
      version: 1,
      launchApp: false,
      tasks: [
        task("failed-parent", { status: "failed" }),
        task("child", { dependsOn: ["failed-parent"] }),
      ],
    });

    const plan = buildExecutionPlan(queue);

    assert.deepEqual(plan.ordered, []);
    assert.deepEqual(plan.blocked, [
      {
        taskId: "child",
        reason: "Dependency failed or is blocked: failed-parent",
      },
    ]);
  });
});

function task(
  id: string,
  overrides: Partial<QueueTask> = {},
): QueueTask {
  return { ...baseTask(id), ...overrides };
}

function baseTask(id: string): QueueTask {
  return {
    id,
    title: id,
    workspace: ".",
    prompt: `Complete ${id}`,
    priority: 0,
    dependsOn: [] as string[],
    status: "pending",
    createdAt: "2026-07-28T00:00:00.000Z",
  };
}
