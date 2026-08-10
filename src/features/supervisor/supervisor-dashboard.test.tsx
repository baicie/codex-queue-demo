import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { SupervisorDashboard } from "@/features/supervisor/supervisor-dashboard";
import { i18n } from "@/i18n";
import { supervisorClient } from "@/lib/supervisor/client";
import { AppProviders } from "@/providers/app-providers";

function renderDashboard() {
  return render(
    <AppProviders>
      <TooltipProvider>
        <SupervisorDashboard client={supervisorClient} onOpenQueue={vi.fn()} />
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
});
