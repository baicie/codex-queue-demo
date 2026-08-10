import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import App from "@/App";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppProviders } from "@/providers/app-providers";

describe("App", () => {
  it("renders the Chinese-first supervisor and keeps the queue accessible", async () => {
    window.localStorage.clear();
    render(
      <AppProviders>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </AppProviders>,
    );

    expect(
      await screen.findByRole("heading", { name: "Task Supervisor" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("迁移 release pipeline").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByRole("button", { name: "立即检查" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "打开任务队列" }));

    expect(
      await screen.findByRole("heading", { name: "Codex 任务队列" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行队列" })).toBeEnabled();
  });
});
