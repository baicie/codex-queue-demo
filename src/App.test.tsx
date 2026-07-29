import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import App from "@/App";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppProviders } from "@/providers/app-providers";

describe("App", () => {
  it("renders the Chinese-first task queue experience", async () => {
    window.localStorage.clear();
    render(
      <AppProviders>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </AppProviders>,
    );

    expect(
      await screen.findByRole("heading", { name: "Codex 任务队列" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行队列" })).toBeEnabled();
  });
});
