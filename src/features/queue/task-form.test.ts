import { describe, expect, it } from "vitest";

import type { Task } from "@/domain/queue";
import { createTaskDraft, taskFromDraft } from "@/features/queue/task-form";

const task: Task = {
  id: "prepare-release",
  title: "Prepare release",
  workspace: "/projects/release",
  prompt: "Prepare the release.",
  priority: 80,
  dependsOn: [],
  status: "pending",
  createdAt: "2026-07-28T01:00:00Z",
};

describe("taskFromDraft", () => {
  it.each(["", "   "])("rejects a blank priority (%j)", (priority) => {
    const result = taskFromDraft(
      { ...createTaskDraft(task), priority },
      [task],
      task,
    );

    expect(result.task).toBeUndefined();
    expect(result.errors.priority).toBe("priorityInvalid");
  });
});
