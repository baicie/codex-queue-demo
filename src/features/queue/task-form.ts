import { createTaskId, type Task } from "@/domain/queue";

export interface TaskDraft {
  id: string;
  title: string;
  workspace: string;
  prompt: string;
  priority: string;
  dependsOn: string[];
}

export type TaskDraftField =
  "id" | "title" | "workspace" | "prompt" | "priority";
export type TaskDraftErrors = Partial<Record<TaskDraftField, string>>;

export function createTaskDraft(task?: Task): TaskDraft {
  return {
    id: task?.id ?? createTaskId(),
    title: task?.title ?? "",
    workspace: task?.workspace ?? ".",
    prompt: task?.prompt ?? "",
    priority: String(task?.priority ?? 0),
    dependsOn: task?.dependsOn ?? [],
  };
}

export function taskFromDraft(
  draft: TaskDraft,
  tasks: Task[],
  previous?: Task,
): { task?: Task; errors: TaskDraftErrors } {
  const errors: TaskDraftErrors = {};
  const id = draft.id.trim();
  const title = draft.title.trim();
  const workspace = draft.workspace.trim();
  const prompt = draft.prompt.trim();
  const priorityInput = draft.priority.trim();
  const priority = Number(priorityInput);

  if (!id) errors.id = "idRequired";
  else if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) errors.id = "idInvalid";
  else if (tasks.some((task) => task.id === id && task.id !== previous?.id)) {
    errors.id = "idDuplicate";
  }
  if (!title) errors.title = "titleRequired";
  if (!workspace) errors.workspace = "workspaceRequired";
  if (!prompt) errors.prompt = "promptRequired";
  if (!priorityInput || !Number.isSafeInteger(priority)) {
    errors.priority = "priorityInvalid";
  }

  if (Object.keys(errors).length > 0) return { errors };

  return {
    errors,
    task: {
      ...previous,
      id,
      title,
      workspace,
      prompt,
      priority,
      dependsOn: draft.dependsOn.filter((dependency) => dependency !== id),
      status: previous?.status ?? "pending",
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    },
  };
}
