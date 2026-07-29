import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Queue, Task } from "@/domain/queue";
import { QueueSettings } from "@/features/queue/queue-settings";
import { TaskEditor } from "@/features/queue/task-editor";
import { i18n } from "@/i18n";

const task: Task = {
  id: "prepare-release",
  title: "准备发布说明",
  workspace: "/projects/docs",
  prompt: "整理本次版本的发布说明。",
  priority: 80,
  dependsOn: [],
  status: "pending",
  createdAt: "2026-07-28T01:00:00Z",
};

const queue: Queue = {
  version: 1,
  launchApp: true,
  retryPolicy: {
    maxAttempts: 4,
    initialDelaySeconds: 30,
    maxDelaySeconds: 900,
  },
  tasks: [task],
};

type CloseMethod = "cancel" | "close" | "escape" | "outside";

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe.each<{
  name: string;
  renderEditor: (onOpenChange: (open: boolean) => void) => void;
  makeDirty: () => void;
}>([
  {
    name: "任务编辑器",
    renderEditor: (onOpenChange) => {
      renderWithI18n(
        <TaskEditor
          open
          task={task}
          tasks={[task]}
          onOpenChange={onOpenChange}
          onSave={vi.fn().mockResolvedValue(true)}
        />,
      );
    },
    makeDirty: () => {
      fireEvent.change(screen.getByLabelText("标题"), {
        target: { value: "未保存的新标题" },
      });
    },
  },
  {
    name: "队列设置",
    renderEditor: (onOpenChange) => {
      renderWithI18n(
        <QueueSettings
          open
          queue={queue}
          codexBin=""
          onOpenChange={onOpenChange}
          onSave={vi.fn().mockResolvedValue(true)}
        />,
      );
    },
    makeDirty: () => {
      fireEvent.click(
        screen.getByRole("switch", { name: "运行前启动 Codex 应用" }),
      );
    },
  },
])("$name", ({ renderEditor, makeDirty }) => {
  it.each<CloseMethod>(["cancel", "close", "escape", "outside"])(
    "confirms before discarding a dirty draft via %s",
    async (method) => {
      const onOpenChange = vi.fn();
      renderEditor(onOpenChange);
      makeDirty();

      await requestClose(method);

      expect(
        screen.getByRole("alertdialog", { name: "放弃未保存的更改？" }),
      ).toBeInTheDocument();
      expect(screen.getByText("继续操作将丢失当前更改。")).toBeInTheDocument();
      expect(onOpenChange).not.toHaveBeenCalledWith(false);

      fireEvent.click(screen.getByRole("button", { name: "确认" }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
    },
  );

  it("closes an unchanged draft without confirmation", () => {
    const onOpenChange = vi.fn();
    renderEditor(onOpenChange);

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(
      screen.queryByRole("alertdialog", { name: "放弃未保存的更改？" }),
    ).not.toBeInTheDocument();
  });
});

describe.each<{
  name: string;
  renderEditor: (
    onOpenChange: (open: boolean) => void,
    onSave: () => Promise<boolean>,
  ) => void;
  makeDirty: () => void;
  saveLabel: string;
}>([
  {
    name: "任务编辑器",
    renderEditor: (onOpenChange, onSave) => {
      renderWithI18n(
        <TaskEditor
          open
          task={task}
          tasks={[task]}
          onOpenChange={onOpenChange}
          onSave={onSave}
        />,
      );
    },
    makeDirty: () => {
      fireEvent.change(screen.getByLabelText("标题"), {
        target: { value: "保存中的新标题" },
      });
    },
    saveLabel: "保存任务",
  },
  {
    name: "队列设置",
    renderEditor: (onOpenChange, onSave) => {
      renderWithI18n(
        <QueueSettings
          open
          queue={queue}
          codexBin=""
          onOpenChange={onOpenChange}
          onSave={onSave}
        />,
      );
    },
    makeDirty: () => {
      fireEvent.click(
        screen.getByRole("switch", { name: "运行前启动 Codex 应用" }),
      );
    },
    saveLabel: "保存",
  },
])("$name", ({ renderEditor, makeDirty, saveLabel }) => {
  it("cannot be dismissed while a save is pending", async () => {
    const saving = deferred<boolean>();
    const onOpenChange = vi.fn();
    const onSave = vi.fn(() => saving.promise);
    renderEditor(onOpenChange, onSave);
    makeDirty();

    fireEvent.click(screen.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    const close = screen.getByRole("button", { name: "关闭" });
    const cancel = screen.getByRole("button", { name: "取消" });
    expect(close).toBeDisabled();
    expect(cancel).toBeDisabled();

    fireEvent.click(close);
    fireEvent.click(cancel);
    await requestClose("escape");
    await requestClose("outside");

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(
      screen.queryByRole("alertdialog", { name: "放弃未保存的更改？" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      saving.resolve(true);
      await saving.promise;
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

async function requestClose(method: CloseMethod) {
  switch (method) {
    case "cancel":
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      break;
    case "close":
      fireEvent.click(screen.getByRole("button", { name: "关闭" }));
      break;
    case "escape":
      fireEvent.keyDown(document, { key: "Escape" });
      break;
    case "outside": {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      const overlay = document.querySelector<HTMLElement>(
        '[data-slot="sheet-overlay"]',
      );
      expect(overlay).not.toBeNull();
      fireEvent.pointerDown(overlay!, {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse",
      });
      fireEvent.click(overlay!);
      break;
    }
  }
}

function renderWithI18n(children: React.ReactNode) {
  return render(<I18nextProvider i18n={i18n}>{children}</I18nextProvider>);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
