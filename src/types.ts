export type TaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked";

export interface QueueTask {
  id: string;
  title: string;
  workspace: string;
  prompt: string;
  priority: number;
  dependsOn: string[];
  status: TaskStatus;
  createdAt: string;
  attempts?: number;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
}

export interface QueueFile {
  version: 1;
  launchApp: boolean;
  tasks: QueueTask[];
}

export interface BlockedTask {
  taskId: string;
  reason: string;
}

export interface ExecutionPlan {
  ordered: QueueTask[];
  blocked: BlockedTask[];
}
