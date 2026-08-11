import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  createDemoSupervisor,
  type SupervisorSnapshot,
} from "@/domain/supervisor";
import { SupervisorDashboard } from "@/features/supervisor/supervisor-dashboard";
import { i18n } from "@/i18n";
import {
  supervisorClient,
  type SupervisorClient,
} from "@/lib/supervisor/client";
import { AppProviders } from "@/providers/app-providers";

function renderDashboard(client: SupervisorClient = supervisorClient) {
  return render(
    <AppProviders>
      <TooltipProvider>
        <SupervisorDashboard client={client} onOpenQueue={vi.fn()} />
      </TooltipProvider>
    </AppProviders>,
  );
}

describe("SupervisorDashboard", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("zh-CN");
  });

  it("recovers a waiting job on its existing thread and completes the goal", async () => {
    renderDashboard();

    expect(
      await screen.findByRole("heading", { name: "Task Supervisor" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("thr_release_migration").length).toBeGreaterThan(
      0,
    );

    fireEvent.click(screen.getByRole("button", { name: "标记 Provider 故障" }));
    await waitFor(() =>
      expect(screen.getByText("正在等待 Provider 恢复")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "恢复执行" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "立即检查" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "恢复执行" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "恢复执行" }));
    await waitFor(() =>
      expect(screen.getAllByText("恢复中").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText("thr_release_migration").length).toBeGreaterThan(
      0,
    );

    fireEvent.click(screen.getByRole("button", { name: "目标完成" }));
    await waitFor(() =>
      expect(screen.getAllByText("已完成").length).toBeGreaterThan(0),
    );
    expect(screen.getByRole("button", { name: "目标完成" })).toBeDisabled();
  });

  it("refreshes live Codex tasks, shows recovery actions, and hides demo controls", async () => {
    const live = createLiveSnapshot();
    const client = createReadOnlyClient(live);
    let intervalHandler: TimerHandler | undefined;
    const interval = vi
      .spyOn(window, "setInterval")
      .mockImplementation((handler) => {
        intervalHandler = handler;
        return 1;
      });

    try {
      renderDashboard(client);

      expect(
        await screen.findByRole("heading", { name: "Live Codex task" }),
      ).toBeInTheDocument();
      expect(screen.getByText("4,321 / 40,000")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "标记 Provider 故障" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "重置演示数据" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "暂停任务" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "恢复执行" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "目标完成" }),
      ).toBeInTheDocument();
      expect(interval).toHaveBeenCalledWith(expect.any(Function), 3_000);

      await act(async () => {
        if (typeof intervalHandler === "function") intervalHandler();
      });
      expect(client.load).toHaveBeenCalledTimes(2);
    } finally {
      interval.mockRestore();
    }
  });

  it("shows an empty state when Codex has no visible tasks", async () => {
    const live = createLiveSnapshot();
    const client = createReadOnlyClient({
      ...live,
      selectedJobId: null,
      jobs: [],
    });

    renderDashboard(client);

    expect(await screen.findByText("没有 Codex 任务")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("正在加载任务监督器"),
    ).not.toBeInTheDocument();
  });
});

function createLiveSnapshot(): SupervisorSnapshot {
  const demo = createDemoSupervisor(new Date("2026-08-11T00:00:00.000Z"));
  const job = {
    ...demo.jobs[0],
    id: "live-thread",
    threadId: "live-thread",
    title: "Live Codex task",
    tokensUsed: 4_321,
  };
  return {
    ...demo,
    source: "codex",
    readOnly: true,
    selectedJobId: job.id,
    jobs: [job],
  };
}

function createReadOnlyClient(snapshot: SupervisorSnapshot): SupervisorClient {
  return {
    load: vi.fn().mockResolvedValue(snapshot),
    save: vi.fn(),
    selectJob: vi.fn().mockResolvedValue(snapshot),
    markProviderDown: vi.fn(),
    markProviderHealthy: vi.fn(),
    resumeJob: vi.fn(),
    pauseJob: vi.fn(),
    completeGoal: vi.fn(),
    resetDemo: vi.fn(),
  };
}
