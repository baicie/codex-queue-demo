import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppInfo, Queue, QueueSnapshot, RunSummary } from "@/domain/queue";
import { QueueApp } from "@/features/queue/queue-app";
import type { DesktopClient } from "@/lib/desktop/client";
import { AppProviders } from "@/providers/app-providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";

const queue: Queue = {
  version: 1,
  launchApp: true,
  retryPolicy: {
    maxAttempts: 4,
    initialDelaySeconds: 30,
    maxDelaySeconds: 900,
  },
  tasks: [
    {
      id: "prepare-release",
      title: "准备发布说明",
      workspace: "/projects/docs",
      prompt: "整理本次版本的发布说明。",
      priority: 80,
      dependsOn: [],
      status: "pending",
      createdAt: "2026-07-28T01:00:00Z",
    },
    {
      id: "verify-build",
      title: "验证跨平台构建",
      workspace: "/projects/app",
      prompt: "验证 macOS 与 Windows 构建。",
      priority: 40,
      dependsOn: ["prepare-release"],
      status: "succeeded",
      createdAt: "2026-07-28T01:01:00Z",
      attempts: 1,
      finishedAt: "2026-07-28T02:00:00Z",
    },
  ],
};

const snapshot: QueueSnapshot = {
  path: "/demo/queue.json",
  revision: "revision-1",
  queue,
  orderedIds: ["prepare-release"],
  blocked: [],
};

function createClient() {
  return {
    getAppInfo: vi.fn<() => Promise<AppInfo>>().mockResolvedValue({
      defaultQueuePath: snapshot.path,
      platform: "macos",
    }),
    loadQueue: vi
      .fn<(path: string) => Promise<QueueSnapshot>>()
      .mockResolvedValue(snapshot),
    saveQueue: vi
      .fn<
        (
          path: string,
          nextQueue: Queue,
          expectedRevision: string,
        ) => Promise<QueueSnapshot>
      >()
      .mockResolvedValue(snapshot),
    runQueue: vi
      .fn<(path: string, codexBin?: string) => Promise<RunSummary>>()
      .mockResolvedValue({
        plannedIds: ["prepare-release"],
        succeededIds: ["prepare-release"],
        failedIds: [],
        blockedIds: [],
      }),
    openQueueFile: vi
      .fn<() => Promise<QueueSnapshot | null>>()
      .mockResolvedValue(null),
    saveQueueFile: vi
      .fn<
        (
          nextQueue: Queue,
          path?: string,
          expectedRevision?: string,
        ) => Promise<QueueSnapshot | null>
      >()
      .mockResolvedValue(null),
  } satisfies DesktopClient;
}

function renderQueueApp(client: DesktopClient) {
  return render(
    <AppProviders>
      <TooltipProvider>
        <QueueApp client={client} />
      </TooltipProvider>
    </AppProviders>,
  );
}

describe("QueueApp", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    await i18n.changeLanguage("zh-CN");
  });

  it("loads the default queue in Chinese", async () => {
    const client = createClient();

    renderQueueApp(client);

    expect(
      await screen.findByRole("heading", { name: "Codex 任务队列" }),
    ).toBeInTheDocument();
    expect(screen.getByText("准备发布说明")).toBeInTheDocument();
    expect(screen.getByText("/projects/docs")).toBeInTheDocument();
    expect(client.loadQueue).toHaveBeenCalledWith("/demo/queue.json");
  });

  it("filters tasks by status", async () => {
    renderQueueApp(createClient());
    await screen.findByText("准备发布说明");

    fireEvent.click(screen.getByRole("radio", { name: "已成功" }));

    expect(screen.queryByText("准备发布说明")).not.toBeInTheDocument();
    expect(screen.getByText("验证跨平台构建")).toBeInTheDocument();
  });

  it("runs the queue and refreshes the snapshot", async () => {
    const client = createClient();
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    fireEvent.click(screen.getByRole("button", { name: "运行队列" }));

    await waitFor(() =>
      expect(client.runQueue).toHaveBeenCalledWith(snapshot.path),
    );
    await waitFor(() => expect(client.loadQueue).toHaveBeenCalledTimes(2));
  });

  it("creates and persists a task", async () => {
    const client = createClient();
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    fireEvent.change(screen.getByLabelText("任务 ID"), {
      target: { value: "publish-release" },
    });
    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "发布桌面版本" },
    });
    fireEvent.change(screen.getByLabelText("工作区"), {
      target: { value: "/projects/release" },
    });
    fireEvent.change(screen.getByLabelText("任务指令"), {
      target: { value: "构建并发布跨平台安装包。" },
    });
    fireEvent.change(screen.getByLabelText("优先级"), {
      target: { value: "90" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存任务" }));

    await waitFor(() => expect(client.saveQueue).toHaveBeenCalledTimes(1));
    const [path, savedQueue, expectedRevision] = client.saveQueue.mock.calls[0];
    expect(path).toBe(snapshot.path);
    expect(expectedRevision).toBe(snapshot.revision);
    expect(savedQueue.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "publish-release",
          title: "发布桌面版本",
          workspace: "/projects/release",
          prompt: "构建并发布跨平台安装包。",
          priority: 90,
          status: "pending",
        }),
      ]),
    );
  });

  it("edits an existing task without duplicating it", async () => {
    const client = createClient();
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "准备发布说明的更多操作" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑任务" }));
    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "整理并校对发布说明" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存任务" }));

    await waitFor(() => expect(client.saveQueue).toHaveBeenCalledTimes(1));
    const savedQueue = client.saveQueue.mock.calls[0][1];
    expect(client.saveQueue.mock.calls[0][2]).toBe(snapshot.revision);
    expect(savedQueue.tasks).toHaveLength(queue.tasks.length);
    expect(savedQueue.tasks[0]).toEqual(
      expect.objectContaining({
        id: "prepare-release",
        title: "整理并校对发布说明",
      }),
    );
  });

  it("updates blocked dependency metadata when a failed task ID changes", async () => {
    const client = createClient();
    const failedParent = {
      ...queue.tasks[0],
      status: "failed" as const,
      lastError: "API unavailable",
    };
    const structuredChild = {
      ...queue.tasks[1],
      id: "structured-child",
      title: "结构化阻塞任务",
      status: "blocked" as const,
      dependsOn: [failedParent.id],
      blockedReason: {
        reasonCode: "dependencyUnavailable" as const,
        dependencyId: failedParent.id,
      },
      lastError: "stale blocked error",
    };
    const legacyChild = {
      ...queue.tasks[1],
      id: "legacy-child",
      title: "旧版阻塞任务",
      status: "blocked" as const,
      dependsOn: [failedParent.id],
      lastError: `dependency failed or is blocked: ${failedParent.id}`,
    };
    client.loadQueue.mockResolvedValue({
      ...snapshot,
      orderedIds: [],
      queue: {
        ...queue,
        tasks: [failedParent, structuredChild, legacyChild],
      },
    });
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "准备发布说明的更多操作" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑任务" }));
    fireEvent.change(screen.getByLabelText("任务 ID"), {
      target: { value: "renamed-parent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存任务" }));

    await waitFor(() => expect(client.saveQueue).toHaveBeenCalledTimes(1));
    const savedTasks = client.saveQueue.mock.calls[0][1].tasks;
    expect(savedTasks.find((task) => task.id === "structured-child")).toEqual(
      expect.objectContaining({
        dependsOn: ["renamed-parent"],
        blockedReason: {
          reasonCode: "dependencyUnavailable",
          dependencyId: "renamed-parent",
        },
      }),
    );
    expect(
      savedTasks.find((task) => task.id === "structured-child"),
    ).not.toHaveProperty("lastError");
    expect(savedTasks.find((task) => task.id === "legacy-child")).toEqual(
      expect.objectContaining({
        dependsOn: ["renamed-parent"],
        blockedReason: {
          reasonCode: "dependencyUnavailable",
          dependencyId: "renamed-parent",
        },
      }),
    );
    expect(
      savedTasks.find((task) => task.id === "legacy-child"),
    ).not.toHaveProperty("lastError");
  });

  it("confirms deletion and removes dependency references", async () => {
    const client = createClient();
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "准备发布说明的更多操作" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除任务" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => expect(client.saveQueue).toHaveBeenCalledTimes(1));
    const savedQueue = client.saveQueue.mock.calls[0][1];
    expect(client.saveQueue.mock.calls[0][2]).toBe(snapshot.revision);
    expect(savedQueue.tasks).toHaveLength(1);
    expect(savedQueue.tasks[0]).toEqual(
      expect.objectContaining({ id: "verify-build", dependsOn: [] }),
    );
  });

  it("persists queue and retry settings", async () => {
    const client = createClient();
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    fireEvent.click(screen.getByRole("button", { name: "队列设置" }));
    fireEvent.click(
      screen.getByRole("switch", { name: "运行前启动 Codex 应用" }),
    );
    fireEvent.change(screen.getByLabelText("最大尝试次数"), {
      target: { value: "6" },
    });
    fireEvent.change(screen.getByLabelText("初始延迟（秒）"), {
      target: { value: "45" },
    });
    fireEvent.change(screen.getByLabelText("最大延迟（秒）"), {
      target: { value: "720" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(client.saveQueue).toHaveBeenCalledTimes(1));
    const savedQueue = client.saveQueue.mock.calls[0][1];
    expect(client.saveQueue.mock.calls[0][2]).toBe(snapshot.revision);
    expect(savedQueue.launchApp).toBe(false);
    expect(savedQueue.retryPolicy).toEqual({
      maxAttempts: 6,
      initialDelaySeconds: 45,
      maxDelaySeconds: 720,
    });
  });

  it("opens a queue selected from the desktop dialog", async () => {
    const client = createClient();
    const openedSnapshot: QueueSnapshot = {
      path: "/queues/nightly.json",
      revision: "revision-nightly",
      orderedIds: ["nightly-check"],
      blocked: [],
      queue: {
        ...queue,
        tasks: [
          {
            ...queue.tasks[0],
            id: "nightly-check",
            title: "夜间构建检查",
            dependsOn: [],
          },
        ],
      },
    };
    client.openQueueFile.mockResolvedValue(openedSnapshot);
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    fireEvent.click(screen.getByRole("button", { name: "打开队列" }));

    expect(await screen.findByText("夜间构建检查")).toBeInTheDocument();
    expect(screen.getByText("/queues/nightly.json")).toBeInTheDocument();
    expect(client.openQueueFile).toHaveBeenCalledTimes(1);
  });

  it("creates a new queue only after choosing a save path", async () => {
    const client = createClient();
    const emptySnapshot: QueueSnapshot = {
      path: "/queues/new-queue.json",
      revision: "revision-new",
      orderedIds: [],
      blocked: [],
      queue: {
        version: 1,
        launchApp: true,
        retryPolicy: {
          maxAttempts: 4,
          initialDelaySeconds: 30,
          maxDelaySeconds: 900,
        },
        tasks: [],
      },
    };
    client.saveQueueFile.mockResolvedValue(emptySnapshot);
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    fireEvent.click(screen.getByRole("button", { name: "新建队列" }));

    expect(
      await screen.findByText("/queues/new-queue.json"),
    ).toBeInTheDocument();
    expect(client.saveQueueFile).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1, tasks: [] }),
    );
  });

  it("saves the current queue under a new path", async () => {
    const client = createClient();
    client.saveQueueFile.mockResolvedValue({
      ...snapshot,
      path: "/queues/copied.json",
    });
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    fireEvent.click(screen.getByRole("button", { name: "队列另存为" }));

    expect(await screen.findByText("/queues/copied.json")).toBeInTheDocument();
    expect(client.saveQueueFile).toHaveBeenCalledWith(
      queue,
      snapshot.path,
      snapshot.revision,
    );
  });

  it("shows an actionable empty state for a new queue", async () => {
    const client = createClient();
    client.loadQueue.mockResolvedValue({
      path: "/queues/empty.json",
      revision: "revision-empty",
      orderedIds: [],
      blocked: [],
      queue: { ...queue, tasks: [] },
    });

    renderQueueApp(client);

    expect(await screen.findByText("队列中还没有任务")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "新建任务" }).length,
    ).toBeGreaterThan(0);
  });

  it("explains an empty filter and can clear it", async () => {
    renderQueueApp(createClient());
    await screen.findByText("准备发布说明");

    fireEvent.click(screen.getByRole("radio", { name: "已阻塞" }));

    expect(await screen.findByText("没有匹配的任务")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(await screen.findByText("准备发布说明")).toBeInTheDocument();
  });

  it("recovers from an initial queue load error", async () => {
    const client = createClient();
    client.loadQueue
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValue(snapshot);

    renderQueueApp(client);

    expect(await screen.findByText("队列加载失败")).toBeInTheDocument();
    expect(screen.getByText("network unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("准备发布说明")).toBeInTheDocument();
  });

  it("keeps settings open and reports a failed save", async () => {
    const client = createClient();
    client.saveQueue.mockRejectedValue(
      new Error(
        "queue changed since it was loaded: /demo/queue.json; reload before saving",
      ),
    );
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    fireEvent.click(screen.getByRole("button", { name: "队列设置" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("队列保存失败")).toBeInTheDocument();
    expect(
      screen.getByText(/queue changed since it was loaded/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "队列设置" }),
    ).toBeInTheDocument();
    expect(client.loadQueue).toHaveBeenCalledTimes(1);
  });

  it("refreshes task state while a queue run is active", async () => {
    const client = createClient();
    let finishRun!: (summary: RunSummary) => void;
    client.runQueue.mockReturnValue(
      new Promise((resolve) => {
        finishRun = resolve;
      }),
    );
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    fireEvent.click(screen.getByRole("button", { name: "运行队列" }));

    expect(await screen.findByText("正在运行队列…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "队列设置" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "准备发布说明的更多操作" }),
    ).toBeDisabled();
    await waitFor(
      () => expect(client.loadQueue.mock.calls.length).toBeGreaterThan(1),
      {
        timeout: 2_000,
      },
    );

    finishRun({
      plannedIds: ["prepare-release"],
      succeededIds: ["prepare-release"],
      failedIds: [],
      blockedIds: [],
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "运行队列" })).toBeEnabled(),
    );
  });

  it("switches language and theme from the toolbar", async () => {
    renderQueueApp(createClient());
    await screen.findByText("准备发布说明");

    fireEvent.pointerDown(screen.getByRole("button", { name: "切换语言" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "English" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Codex Task Queue" }),
    ).toBeInTheDocument();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Change theme" }),
      {
        button: 0,
        ctrlKey: false,
      },
    );
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Dark" }));
    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
  });

  it("shows dependency-derived blocked state and reason", async () => {
    const client = createClient();
    client.loadQueue.mockResolvedValue({
      ...snapshot,
      orderedIds: [],
      blocked: [
        {
          taskId: "prepare-release",
          reasonCode: "dependencyUnavailable",
          dependencyId: "source-task",
        },
      ],
    });

    renderQueueApp(client);

    await screen.findByText("准备发布说明");
    expect(screen.getAllByText("已阻塞").length).toBeGreaterThan(1);
    expect(
      screen.getByText(/依赖任务 source-task 已失败或被阻塞/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/dependency failed or is blocked/),
    ).not.toBeInTheDocument();
  });

  it("localizes a dependency reason persisted by an older worker", async () => {
    const client = createClient();
    client.loadQueue.mockResolvedValue({
      ...snapshot,
      orderedIds: [],
      blocked: [],
      queue: {
        ...queue,
        tasks: queue.tasks.map((task) => {
          if (task.id === "prepare-release") {
            return { ...task, status: "failed" as const };
          }
          return {
            ...task,
            status: "blocked" as const,
            lastError: "dependency failed or is blocked: prepare-release",
          };
        }),
      },
    });

    renderQueueApp(client);

    await screen.findByText("验证跨平台构建");
    expect(
      screen.getByText(/依赖任务 prepare-release 已失败或被阻塞/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/dependency failed or is blocked/),
    ).not.toBeInTheDocument();
  });

  it("continues loading when the stored Codex path cannot be read", async () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(function (key) {
        if (key === "codex-queue.codex-bin") {
          throw new DOMException("Storage access denied", "SecurityError");
        }
        return null;
      });

    try {
      renderQueueApp(createClient());

      expect(await screen.findByText("准备发布说明")).toBeInTheDocument();
      expect(screen.queryByText("队列加载失败")).not.toBeInTheDocument();
    } finally {
      getItem.mockRestore();
    }
  });

  it("does not turn a saved queue into an error when Codex path storage fails", async () => {
    const client = createClient();
    const savedSnapshot = {
      ...snapshot,
      revision: "revision-2",
      queue: { ...queue, launchApp: false },
    };
    client.saveQueue
      .mockResolvedValueOnce(savedSnapshot)
      .mockResolvedValueOnce({ ...savedSnapshot, revision: "revision-3" });
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === "codex-queue.codex-bin") {
          throw new DOMException(
            "Storage quota exceeded",
            "QuotaExceededError",
          );
        }
        return originalSetItem.call(this, key, value);
      });

    try {
      fireEvent.click(screen.getByRole("button", { name: "队列设置" }));
      fireEvent.change(screen.getByLabelText("Codex CLI 路径"), {
        target: { value: "/opt/codex" },
      });
      fireEvent.click(screen.getByRole("button", { name: "保存" }));

      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: "队列设置" }),
        ).not.toBeInTheDocument(),
      );
      expect(screen.queryByText("队列保存失败")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "队列设置" }));
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() => expect(client.saveQueue).toHaveBeenCalledTimes(2));
      expect(client.saveQueue.mock.calls[1][2]).toBe("revision-2");
    } finally {
      setItem.mockRestore();
    }
  });

  it("requeues a completed task without stale execution metadata", async () => {
    const client = createClient();
    renderQueueApp(client);
    await screen.findByText("验证跨平台构建");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "验证跨平台构建的更多操作" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "重新入队" }));

    await waitFor(() => expect(client.saveQueue).toHaveBeenCalledTimes(1));
    const savedTask = client.saveQueue.mock.calls[0][1].tasks.find(
      (task) => task.id === "verify-build",
    );
    expect(client.saveQueue.mock.calls[0][2]).toBe(snapshot.revision);
    expect(savedTask).toEqual(
      expect.objectContaining({
        status: "pending",
        createdAt: queue.tasks[1].createdAt,
      }),
    );
    expect(savedTask).not.toHaveProperty("attempts");
    expect(savedTask).not.toHaveProperty("finishedAt");
  });

  it("disables dependencies that would create a cycle", async () => {
    renderQueueApp(createClient());
    await screen.findByText("准备发布说明");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "准备发布说明的更多操作" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑任务" }));

    expect(
      screen.getByRole("checkbox", { name: /验证跨平台构建/ }),
    ).toBeDisabled();
    expect(screen.getByText("会形成循环依赖")).toBeInTheDocument();
  });

  it("refreshes the current queue when the window regains focus", async () => {
    const client = createClient();
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    fireEvent(window, new Event("focus"));

    await waitFor(() => expect(client.loadQueue).toHaveBeenCalledTimes(2));
  });

  it("rejects a task edit when the queue changed after the editor opened", async () => {
    const client = createClient();
    const refreshedSnapshot: QueueSnapshot = {
      ...snapshot,
      revision: "revision-2",
      queue: {
        ...queue,
        tasks: queue.tasks.map((task) =>
          task.id === "prepare-release"
            ? {
                ...task,
                title: "外部写入的新标题",
                status: "succeeded",
                attempts: 1,
                finishedAt: "2026-07-28T03:00:00Z",
              }
            : task,
        ),
      },
    };
    client.saveQueue.mockImplementation(
      async (_path, nextQueue, expectedRevision) => {
        if (expectedRevision !== refreshedSnapshot.revision) {
          throw new Error(
            "queue changed since it was loaded: /demo/queue.json; reload before saving",
          );
        }
        return {
          ...refreshedSnapshot,
          revision: "revision-3",
          queue: nextQueue,
        };
      },
    );
    renderQueueApp(client);
    await screen.findByText("准备发布说明");
    client.loadQueue.mockResolvedValueOnce(refreshedSnapshot);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "准备发布说明的更多操作" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑任务" }));
    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "陈旧编辑不应覆盖状态" },
    });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(client.loadQueue).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("外部写入的新标题")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存任务" }));

    expect(await screen.findByText("队列保存失败")).toBeInTheDocument();
    expect(client.saveQueue.mock.calls[0][2]).toBe(snapshot.revision);
    expect(
      screen.getByRole("heading", { name: "编辑任务" }),
    ).toBeInTheDocument();
  });

  it("rejects stale settings after a focus refresh", async () => {
    const client = createClient();
    const refreshedSnapshot: QueueSnapshot = {
      ...snapshot,
      revision: "revision-2",
      queue: {
        ...queue,
        tasks: queue.tasks.map((task) =>
          task.id === "prepare-release"
            ? { ...task, title: "设置打开后的外部更新" }
            : task,
        ),
        retryPolicy: {
          maxAttempts: 8,
          initialDelaySeconds: 90,
          maxDelaySeconds: 1_800,
        },
      },
    };
    client.saveQueue.mockRejectedValue(
      new Error(
        "queue changed since it was loaded: /demo/queue.json; reload before saving",
      ),
    );
    renderQueueApp(client);
    await screen.findByText("准备发布说明");
    client.loadQueue.mockResolvedValueOnce(refreshedSnapshot);

    fireEvent.click(screen.getByRole("button", { name: "队列设置" }));
    fireEvent.change(screen.getByLabelText("最大尝试次数"), {
      target: { value: "6" },
    });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(client.loadQueue).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("设置打开后的外部更新")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("队列保存失败")).toBeInTheDocument();
    expect(client.saveQueue.mock.calls[0][2]).toBe(snapshot.revision);
    expect(
      screen.getByRole("heading", { name: "队列设置" }),
    ).toBeInTheDocument();
  });

  it("ignores a focus refresh that resolves after a newer save", async () => {
    const client = createClient();
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    let resolveFocus!: (value: QueueSnapshot) => void;
    const focusLoad = new Promise<QueueSnapshot>((resolve) => {
      resolveFocus = resolve;
    });
    client.loadQueue.mockReturnValueOnce(focusLoad);
    const savedSnapshot: QueueSnapshot = {
      ...snapshot,
      revision: "revision-2",
      queue: {
        ...queue,
        tasks: queue.tasks.map((task) =>
          task.id === "prepare-release"
            ? { ...task, title: "保存后的新标题" }
            : task,
        ),
      },
    };
    client.saveQueue.mockResolvedValue(savedSnapshot);

    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(client.loadQueue).toHaveBeenCalledTimes(2));
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "准备发布说明的更多操作" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑任务" }));
    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "保存后的新标题" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存任务" }));

    expect(await screen.findByText("保存后的新标题")).toBeInTheDocument();
    await act(async () => {
      resolveFocus(snapshot);
      await focusLoad;
    });

    expect(screen.getByText("保存后的新标题")).toBeInTheDocument();
    expect(screen.queryByText("准备发布说明")).not.toBeInTheDocument();
  });

  it("keeps the task editor revision fixed while a focus refresh updates the queue", async () => {
    const client = createClient();
    client.saveQueue.mockRejectedValue(
      new Error("queue changed since it was loaded"),
    );
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "准备发布说明的更多操作" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑任务" }));
    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "编辑器中的草稿标题" },
    });

    client.loadQueue.mockResolvedValue({
      ...snapshot,
      revision: "revision-from-scheduler",
      queue: {
        ...queue,
        tasks: queue.tasks.map((task) =>
          task.id === "prepare-release"
            ? {
                ...task,
                status: "succeeded" as const,
                attempts: 2,
                finishedAt: "2026-07-28T03:00:00Z",
              }
            : task,
        ),
      },
    });
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(client.loadQueue.mock.calls.length).toBeGreaterThan(1),
    );
    await screen.findByText("2 次尝试");

    fireEvent.click(screen.getByRole("button", { name: "保存任务" }));

    await waitFor(() => expect(client.saveQueue).toHaveBeenCalledTimes(1));
    expect(client.saveQueue.mock.calls[0][2]).toBe(snapshot.revision);
    expect(
      screen.getByRole("heading", { name: "编辑任务" }),
    ).toBeInTheDocument();
  });

  it("keeps the settings revision fixed while a focus refresh updates the queue", async () => {
    const client = createClient();
    client.saveQueue.mockRejectedValue(
      new Error("queue changed since it was loaded"),
    );
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    fireEvent.click(screen.getByRole("button", { name: "队列设置" }));
    fireEvent.click(
      screen.getByRole("switch", { name: "运行前启动 Codex 应用" }),
    );

    client.loadQueue.mockResolvedValue({
      ...snapshot,
      revision: "revision-from-scheduler",
      queue: {
        ...queue,
        tasks: queue.tasks.map((task) =>
          task.id === "prepare-release"
            ? { ...task, status: "succeeded" as const, attempts: 2 }
            : task,
        ),
      },
    });
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(client.loadQueue.mock.calls.length).toBeGreaterThan(1),
    );
    await screen.findByText("2 次尝试");

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(client.saveQueue).toHaveBeenCalledTimes(1));
    expect(client.saveQueue.mock.calls[0][2]).toBe(snapshot.revision);
    expect(
      screen.getByRole("heading", { name: "队列设置" }),
    ).toBeInTheDocument();
  });

  it("ignores a pending run poll after the final refresh", async () => {
    const client = createClient();
    let finishRun!: (summary: RunSummary) => void;
    let resolvePoll!: (value: QueueSnapshot) => void;
    const pollLoad = new Promise<QueueSnapshot>((resolve) => {
      resolvePoll = resolve;
    });
    const finalSnapshot: QueueSnapshot = {
      ...snapshot,
      revision: "revision-final",
      queue: {
        ...queue,
        tasks: queue.tasks.map((task) =>
          task.id === "prepare-release"
            ? { ...task, title: "运行后的最终状态" }
            : task,
        ),
      },
    };
    client.loadQueue
      .mockReset()
      .mockResolvedValueOnce(snapshot)
      .mockReturnValueOnce(pollLoad)
      .mockResolvedValueOnce(finalSnapshot)
      .mockResolvedValue(finalSnapshot);
    client.runQueue.mockReturnValue(
      new Promise((resolve) => {
        finishRun = resolve;
      }),
    );
    renderQueueApp(client);
    await screen.findByText("准备发布说明");

    fireEvent.click(screen.getByRole("button", { name: "运行队列" }));
    await waitFor(
      () => expect(client.loadQueue.mock.calls.length).toBeGreaterThan(1),
      { timeout: 2_000 },
    );
    await act(async () => {
      finishRun({
        plannedIds: ["prepare-release"],
        succeededIds: ["prepare-release"],
        failedIds: [],
        blockedIds: [],
      });
    });
    expect(await screen.findByText("运行后的最终状态")).toBeInTheDocument();

    await act(async () => {
      resolvePoll(snapshot);
      await pollLoad;
    });

    expect(screen.getByText("运行后的最终状态")).toBeInTheDocument();
    expect(screen.queryByText("准备发布说明")).not.toBeInTheDocument();
  });
});
