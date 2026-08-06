import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  createEmptyQueue,
  type BlockedReason,
  type QueueSnapshot,
  type RunSummary,
  type Task,
  type TaskStatus,
} from "@/domain/queue";
import { DeleteTaskDialog } from "@/features/queue/delete-task-dialog";
import { QueueSettings } from "@/features/queue/queue-settings";
import {
  QueueEmptyState,
  QueueErrorAlert,
  QueueLoadError,
  QueueNoResults,
  QueueRunProgress,
  type QueueError,
  type QueueErrorKind,
} from "@/features/queue/queue-states";
import { QueueToolbar, type FileAction } from "@/features/queue/queue-toolbar";
import { TaskEditor } from "@/features/queue/task-editor";
import { TaskRow } from "@/features/queue/task-row";
import { TaskRunOutputSheet } from "@/features/queue/task-run-output";
import { desktopClient, type DesktopClient } from "@/lib/desktop/client";
import { Skeleton } from "@/components/ui/skeleton";

type TaskFilter = "all" | TaskStatus;
type RevisionSession = { revision: string };
type TaskSession = RevisionSession & { task: Task };
type EditingSession = TaskSession & { idLocked: boolean };

const filters: TaskFilter[] = [
  "all",
  "pending",
  "running",
  "succeeded",
  "failed",
  "blocked",
];
const CODEX_BIN_STORAGE_KEY = "codex-queue.codex-bin";
const RUN_POLL_INTERVAL_MS = 500;

export function QueueApp({
  client = desktopClient,
}: {
  client?: DesktopClient;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<QueueSnapshot>();
  const snapshotEpochRef = useRef(0);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [error, setError] = useState<QueueError>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [fileAction, setFileAction] = useState<FileAction>();
  const [isRunning, setIsRunning] = useState(false);
  const [runPlanIds, setRunPlanIds] = useState<string[]>([]);
  const [creatingSession, setCreatingSession] = useState<RevisionSession>();
  const [editingSession, setEditingSession] = useState<EditingSession>();
  const [deletingSession, setDeletingSession] = useState<TaskSession>();
  const [settingsSession, setSettingsSession] = useState<RevisionSession>();
  const [outputTask, setOutputTask] = useState<Task>();
  const [codexBin, setCodexBin] = useState(readStoredCodexBin);

  useEffect(() => {
    let cancelled = false;
    const requestEpoch = ++snapshotEpochRef.current;
    void client
      .getAppInfo()
      .then((info) => client.loadQueue(info.defaultQueuePath))
      .then((nextSnapshot) => {
        if (!cancelled && requestEpoch === snapshotEpochRef.current) {
          setSnapshot(nextSnapshot);
          setError(undefined);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled && requestEpoch === snapshotEpochRef.current) {
          setError({ kind: "loadQueue", message: toMessage(reason) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, loadAttempt]);

  useEffect(() => {
    const path = snapshot?.path ?? null;
    if (path === null) return;
    const queuePath = path;

    function refreshOnFocus() {
      const requestEpoch = ++snapshotEpochRef.current;
      void client
        .loadQueue(queuePath)
        .then((nextSnapshot) => {
          if (requestEpoch !== snapshotEpochRef.current) return;
          setSnapshot((current) =>
            current?.path === queuePath ? nextSnapshot : current,
          );
        })
        .catch((reason: unknown) => {
          if (requestEpoch === snapshotEpochRef.current) {
            setError({ kind: "loadQueue", message: toMessage(reason) });
          }
        });
    }

    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [client, snapshot?.path]);

  const blockedById = useMemo(() => {
    const blocked = new Map(
      snapshot?.blocked.map((item) => [item.taskId, item]),
    );
    for (const task of snapshot?.queue.tasks ?? []) {
      const reason =
        task.status === "blocked"
          ? (task.blockedReason ?? legacyBlockedReason(task))
          : undefined;
      if (!blocked.has(task.id) && reason) {
        blocked.set(task.id, { taskId: task.id, ...reason });
      }
    }
    return blocked;
  }, [snapshot]);

  const tasks = useMemo(() => {
    if (!snapshot) return [];
    const planIndex = new Map(
      snapshot.orderedIds.map((taskId, index) => [taskId, index]),
    );
    const blockedIndex = new Map(
      snapshot.blocked.map((item, index) => [
        item.taskId,
        snapshot.orderedIds.length + index,
      ]),
    );
    return snapshot.queue.tasks
      .filter((task) => {
        const effectiveStatus = blockedById.has(task.id)
          ? "blocked"
          : task.status;
        return filter === "all" || effectiveStatus === filter;
      })
      .slice()
      .sort(
        (left, right) =>
          (planIndex.get(left.id) ??
            blockedIndex.get(left.id) ??
            Number.MAX_SAFE_INTEGER) -
          (planIndex.get(right.id) ??
            blockedIndex.get(right.id) ??
            Number.MAX_SAFE_INTEGER),
      );
  }, [blockedById, filter, snapshot]);

  function reportError(kind: QueueErrorKind, reason: unknown) {
    const nextError = { kind, message: toMessage(reason) };
    setError(nextError);
    toast.error(t(`errors.${kind}`), { description: nextError.message });
  }

  function commitSnapshot(nextSnapshot: QueueSnapshot) {
    snapshotEpochRef.current += 1;
    setSnapshot(nextSnapshot);
  }

  async function runQueue() {
    if (!snapshot || isRunning) return;
    const path = snapshot.path;
    const plannedIds = snapshot.orderedIds.slice();
    setError(undefined);
    setRunPlanIds(plannedIds);
    setIsRunning(true);
    toast.info(t("toast.runStarted"));

    const pollId = window.setInterval(() => {
      const requestEpoch = ++snapshotEpochRef.current;
      void client
        .loadQueue(path)
        .then((nextSnapshot) => {
          if (requestEpoch !== snapshotEpochRef.current) return;
          setSnapshot((current) =>
            current?.path === path ? nextSnapshot : current,
          );
        })
        .catch(() => {
          // Atomic queue writes can briefly make a polling read lose the race.
        });
    }, RUN_POLL_INTERVAL_MS);

    try {
      const summary = codexBin
        ? await client.runQueue(path, codexBin)
        : await client.runQueue(path);
      window.clearInterval(pollId);
      await refreshAfterRun(path);
      toast.success(t("toast.runCompleted", summaryCounts(summary)));
    } catch (reason) {
      window.clearInterval(pollId);
      reportError("runQueue", reason);
      await refreshAfterRun(path);
    } finally {
      window.clearInterval(pollId);
      setIsRunning(false);
      setRunPlanIds([]);
    }
  }

  async function refreshAfterRun(path: string) {
    const requestEpoch = ++snapshotEpochRef.current;
    try {
      const nextSnapshot = await client.loadQueue(path);
      if (requestEpoch !== snapshotEpochRef.current) return;
      setSnapshot((current) =>
        current?.path === path ? nextSnapshot : current,
      );
    } catch (reason) {
      if (requestEpoch === snapshotEpochRef.current) {
        reportError("loadQueue", reason);
      }
    }
  }

  async function openQueue() {
    setError(undefined);
    setFileAction("open");
    try {
      const opened = await client.openQueueFile();
      if (opened) {
        commitSnapshot(opened);
        setFilter("all");
        toast.success(t("toast.queueLoaded"));
      }
    } catch (reason) {
      reportError("loadQueue", reason);
    } finally {
      setFileAction(undefined);
    }
  }

  async function createQueue() {
    setError(undefined);
    setFileAction("new");
    try {
      const created = await client.saveQueueFile(createEmptyQueue());
      if (created) {
        commitSnapshot(created);
        setFilter("all");
        toast.success(t("toast.queueSaved"));
      }
    } catch (reason) {
      reportError("saveQueue", reason);
    } finally {
      setFileAction(undefined);
    }
  }

  async function saveQueueAs() {
    if (!snapshot) return;
    setError(undefined);
    setFileAction("saveAs");
    try {
      const saved = await client.saveQueueFile(
        snapshot.queue,
        snapshot.path,
        snapshot.revision,
      );
      if (saved) {
        commitSnapshot(saved);
        toast.success(t("toast.queueSaved"));
      }
    } catch (reason) {
      reportError("saveQueue", reason);
    } finally {
      setFileAction(undefined);
    }
  }

  async function refreshQueue() {
    if (!snapshot) return;
    const path = snapshot.path;
    setError(undefined);
    setFileAction("refresh");
    const requestEpoch = ++snapshotEpochRef.current;
    try {
      const nextSnapshot = await client.loadQueue(path);
      if (requestEpoch === snapshotEpochRef.current) {
        setSnapshot(nextSnapshot);
      }
    } catch (reason) {
      if (requestEpoch === snapshotEpochRef.current) {
        reportError("loadQueue", reason);
      }
    } finally {
      setFileAction(undefined);
    }
  }

  async function saveTask(
    task: Task,
    expectedRevision: string,
    previousId?: string,
  ): Promise<boolean> {
    if (!snapshot) return false;
    const existingIndex = snapshot.queue.tasks.findIndex(
      (item) => item.id === (previousId ?? task.id),
    );
    let nextTasks = snapshot.queue.tasks.slice();
    if (existingIndex === -1) nextTasks.push(task);
    else nextTasks[existingIndex] = task;
    if (previousId && previousId !== task.id) {
      nextTasks = nextTasks.map((item) => {
        const renamed = {
          ...item,
          dependsOn: item.dependsOn.map((dependency) =>
            dependency === previousId ? task.id : dependency,
          ),
        };
        const hasBlockedReason =
          item.blockedReason?.dependencyId === previousId;
        const hasLegacyBlockedReason =
          item.status === "blocked" &&
          item.lastError === `dependency failed or is blocked: ${previousId}`;
        if (hasBlockedReason || hasLegacyBlockedReason) {
          renamed.blockedReason = {
            reasonCode:
              item.blockedReason?.reasonCode ?? "dependencyUnavailable",
            dependencyId: task.id,
          };
          delete renamed.lastError;
        }
        return renamed;
      });
    }

    try {
      commitSnapshot(
        await client.saveQueue(
          snapshot.path,
          {
            ...snapshot.queue,
            tasks: nextTasks,
          },
          expectedRevision,
        ),
      );
      toast.success(
        t(existingIndex === -1 ? "toast.taskCreated" : "toast.taskUpdated"),
      );
      return true;
    } catch (reason) {
      reportError("saveQueue", reason);
      return false;
    }
  }

  async function editTask(task: Task) {
    if (!snapshot) return;
    const revision = snapshot.revision;
    const queuePath = snapshot.path;
    const requestEpoch = snapshotEpochRef.current;
    let idLocked = (task.attempts ?? 0) > 0;

    if (!idLocked) {
      try {
        idLocked = (await client.listTaskRuns(queuePath, task.id)).length > 0;
      } catch {
        idLocked = true;
      }
    }

    if (requestEpoch === snapshotEpochRef.current) {
      setEditingSession({ task, revision, idLocked });
    }
  }

  async function deleteTask(
    task: Task,
    expectedRevision: string,
  ): Promise<boolean> {
    if (!snapshot) return false;
    const tasks = snapshot.queue.tasks
      .filter((item) => item.id !== task.id)
      .map((item) => ({
        ...item,
        dependsOn: item.dependsOn.filter(
          (dependency) => dependency !== task.id,
        ),
      }));
    try {
      commitSnapshot(
        await client.saveQueue(
          snapshot.path,
          {
            ...snapshot.queue,
            tasks,
          },
          expectedRevision,
        ),
      );
      toast.success(t("toast.taskDeleted"));
      return true;
    } catch (reason) {
      reportError("saveQueue", reason);
      return false;
    }
  }

  async function requeueTask(task: Task) {
    if (!snapshot || isRunning) return;
    const nextTask = resetTask(task);
    await saveTask(nextTask, snapshot.revision, task.id);
  }

  async function saveSettings(
    queue: QueueSnapshot["queue"],
    nextCodexBin: string,
    expectedRevision: string,
  ): Promise<boolean> {
    if (!snapshot) return false;
    try {
      commitSnapshot(
        await client.saveQueue(snapshot.path, queue, expectedRevision),
      );
      setCodexBin(nextCodexBin);
      persistCodexBin(nextCodexBin);
      toast.success(t("toast.queueSaved"));
      return true;
    } catch (reason) {
      reportError("saveQueue", reason);
      return false;
    }
  }

  if (!snapshot) {
    if (!error) return <QueueSkeleton />;
    return (
      <QueueLoadError
        error={error}
        onRetry={() => {
          setError(undefined);
          setLoadAttempt((attempt) => attempt + 1);
        }}
      />
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-4 p-4 sm:p-6">
      <QueueToolbar
        snapshot={snapshot}
        fileAction={fileAction}
        isRunning={isRunning}
        onNewQueue={() => void createQueue()}
        onOpenQueue={() => void openQueue()}
        onSaveAs={() => void saveQueueAs()}
        onRefresh={() => void refreshQueue()}
        onOpenSettings={() =>
          setSettingsSession({ revision: snapshot.revision })
        }
        onRun={() => void runQueue()}
        onNewTask={() => setCreatingSession({ revision: snapshot.revision })}
      />

      <div className="overflow-x-auto pb-1">
        <ToggleGroup
          type="single"
          variant="outline"
          value={filter}
          onValueChange={(value) => value && setFilter(value as TaskFilter)}
          aria-label={t("filters.status")}
        >
          {filters.map((value) => (
            <ToggleGroupItem
              key={value}
              value={value}
              aria-label={t(`filters.${value}`)}
            >
              {t(`filters.${value}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {error && (
        <QueueErrorAlert error={error} onDismiss={() => setError(undefined)} />
      )}
      {isRunning && snapshot && (
        <QueueRunProgress snapshot={snapshot} plannedIds={runPlanIds} />
      )}

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{t("queue.executionOrder")}</h2>
        <span className="text-xs text-muted-foreground">
          {t("queue.plannedCount", { count: snapshot?.orderedIds.length ?? 0 })}
        </span>
      </div>

      <section
        className="flex flex-1 flex-col gap-3"
        aria-label={t("queue.executionOrder")}
      >
        {snapshot?.queue.tasks.length === 0 ? (
          <QueueEmptyState
            onCreate={() => setCreatingSession({ revision: snapshot.revision })}
          />
        ) : tasks.length === 0 ? (
          <QueueNoResults onClear={() => setFilter("all")} />
        ) : (
          tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              position={planPosition(snapshot, task.id)}
              blockedReason={blockedById.get(task.id)}
              disabled={isRunning}
              onEdit={(task) => void editTask(task)}
              onDelete={(task) =>
                setDeletingSession({ task, revision: snapshot.revision })
              }
              onRequeue={(nextTask) => void requeueTask(nextTask)}
              onViewOutput={setOutputTask}
            />
          ))
        )}
      </section>

      {snapshot && (
        <>
          {creatingSession && (
            <TaskEditor
              open
              tasks={snapshot.queue.tasks}
              onOpenChange={(open) => !open && setCreatingSession(undefined)}
              onSave={(task, previousId) =>
                saveTask(task, creatingSession.revision, previousId)
              }
            />
          )}
          {editingSession && (
            <TaskEditor
              key={editingSession.task.id}
              open
              task={editingSession.task}
              tasks={snapshot.queue.tasks}
              idLocked={editingSession.idLocked}
              onOpenChange={(open) => !open && setEditingSession(undefined)}
              onSave={(task, previousId) =>
                saveTask(task, editingSession.revision, previousId)
              }
            />
          )}
          <DeleteTaskDialog
            task={deletingSession?.task}
            onOpenChange={(open) => !open && setDeletingSession(undefined)}
            onConfirm={(task) =>
              deleteTask(task, deletingSession?.revision ?? snapshot.revision)
            }
          />
          {settingsSession && (
            <QueueSettings
              open
              queue={snapshot.queue}
              codexBin={codexBin}
              onOpenChange={(open) => !open && setSettingsSession(undefined)}
              onSave={(queue, nextCodexBin) =>
                saveSettings(queue, nextCodexBin, settingsSession.revision)
              }
            />
          )}
          <TaskRunOutputSheet
            task={outputTask}
            queuePath={snapshot.path}
            client={client}
            onOpenChange={(open) => !open && setOutputTask(undefined)}
          />
        </>
      )}
    </main>
  );
}

function QueueSkeleton() {
  const { t } = useTranslation();
  return (
    <main
      className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-4 p-4 sm:p-6"
      aria-busy="true"
      aria-label={t("states.loadingQueue")}
    >
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </main>
  );
}

function resetTask(task: Task): Task {
  const reset: Task = {
    id: task.id,
    title: task.title,
    workspace: task.workspace,
    prompt: task.prompt,
    priority: task.priority,
    dependsOn: task.dependsOn,
    status: "pending",
    createdAt: task.createdAt,
  };
  return reset;
}

function summaryCounts(summary: RunSummary) {
  return {
    succeeded: summary.succeededIds.length,
    failed: summary.failedIds.length,
    blocked: summary.blockedIds.length,
  };
}

function toMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function planPosition(snapshot: QueueSnapshot, taskId: string) {
  const position = snapshot.orderedIds.indexOf(taskId);
  return position >= 0 ? position : undefined;
}

function readStoredCodexBin(): string {
  try {
    return window.localStorage.getItem(CODEX_BIN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function persistCodexBin(codexBin: string): void {
  try {
    if (codexBin) {
      window.localStorage.setItem(CODEX_BIN_STORAGE_KEY, codexBin);
    } else {
      window.localStorage.removeItem(CODEX_BIN_STORAGE_KEY);
    }
  } catch {
    // The queue is already saved; storage is only a local CLI-path preference.
  }
}

function legacyBlockedReason(task: Task): BlockedReason | undefined {
  if (task.status !== "blocked" || !task.lastError) return undefined;
  const dependencyId = task.dependsOn.find(
    (dependency) =>
      task.lastError === `dependency failed or is blocked: ${dependency}`,
  );
  return dependencyId
    ? { reasonCode: "dependencyUnavailable", dependencyId }
    : undefined;
}
