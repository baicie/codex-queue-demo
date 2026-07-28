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
      });

    await desktopClient.getAppInfo();
    await desktopClient.loadQueue(snapshot.path);
    await desktopClient.saveQueue(snapshot.path, queue);
    await desktopClient.runQueue(snapshot.path, "/opt/codex");

    expect(invokeMock.mock.calls).toEqual([
      ["app_info"],
      ["load_queue", { path: snapshot.path }],
      ["save_queue", { path: snapshot.path, queue }],
      ["run_queue", { path: snapshot.path, codexBin: "/opt/codex" }],
    ]);
  });

  it("opens a selected JSON queue and treats dialog cancellation as a no-op", async () => {
    const queue = createEmptyQueue();
    const snapshot: QueueSnapshot = {
      path: "/tmp/opened.json",
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
      queue,
      orderedIds: [],
      blocked: [],
    };
    saveMock.mockResolvedValueOnce(null).mockResolvedValueOnce(snapshot.path);
    invokeMock.mockResolvedValueOnce(snapshot);

    await expect(
      desktopClient.saveQueueFile(queue, "/tmp/suggested.json"),
    ).resolves.toBeNull();
    await expect(
      desktopClient.saveQueueFile(queue, "/tmp/suggested.json"),
    ).resolves.toEqual(snapshot);

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("save_queue", {
      path: snapshot.path,
      queue,
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

    await desktopClient.saveQueue(appInfo.defaultQueuePath, edited);
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

  it("simulates a queue run and persists succeeded task state", async () => {
    const { defaultQueuePath } = await desktopClient.getAppInfo();
    const before = await desktopClient.loadQueue(defaultQueuePath);

    const summary = await desktopClient.runQueue(defaultQueuePath);
    const after = await desktopClient.loadQueue(defaultQueuePath);

    expect(summary.plannedIds).toEqual(before.orderedIds);
    expect(summary.succeededIds).toEqual(before.orderedIds);
    expect(after.queue.tasks.every((task) => task.status === "succeeded")).toBe(
      true,
    );
  });

  it("reports missing browser queues with a readable path", async () => {
    await expect(
      desktopClient.loadQueue("browser://queues/missing.json"),
    ).rejects.toThrow("Queue file not found: browser://queues/missing.json");
  });
});
