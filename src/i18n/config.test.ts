import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE,
  LANGUAGE_STORAGE_KEY,
  createAppI18n,
  normalizeLocale,
} from "@/i18n/config";
import { SUPPORTED_LOCALES, i18n, setAppLanguage } from "@/i18n/index";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const requiredTranslationKeys = [
  "app.name",
  "app.subtitle",
  "navigation.queue",
  "toolbar.newTask",
  "toolbar.openQueue",
  "toolbar.runQueue",
  "toolbar.theme",
  "toolbar.language",
  "filters.all",
  "filters.searchPlaceholder",
  "status.pending",
  "status.running",
  "status.succeeded",
  "status.failed",
  "status.blocked",
  "queue.launchApp",
  "queue.executionOrder",
  "queue.path",
  "queue.taskCount",
  "queue.plannedCount",
  "queue.run",
  "queue.open",
  "queue.new",
  "queue.saveAs",
  "queue.settings",
  "queue.refresh",
  "queue.running",
  "queue.runComplete",
  "queue.loadError",
  "queue.saveError",
  "queue.runError",
  "queue.emptyTitle",
  "queue.emptyDescription",
  "task.new",
  "task.edit",
  "task.delete",
  "task.deleteTitle",
  "task.deleteDescription",
  "task.title",
  "task.id",
  "task.workspace",
  "task.prompt",
  "task.priority",
  "task.dependencies",
  "task.noDependencies",
  "task.attempts",
  "task.nextRetry",
  "task.lastError",
  "task.blockedReason.dependencyUnavailable",
  "task.planPosition",
  "task.createdAt",
  "task.save",
  "task.cancel",
  "task.idHint",
  "task.fields.title",
  "task.fields.workspace",
  "task.fields.prompt",
  "task.fields.priority",
  "task.fields.dependencies",
  "task.meta.createdAt",
  "task.meta.startedAt",
  "task.meta.finishedAt",
  "task.meta.nextRetryAt",
  "task.form.createTitle",
  "task.form.editTitle",
  "task.validation.titleRequired",
  "retryPolicy.title",
  "retryPolicy.maxAttempts",
  "retryPolicy.initialDelaySeconds",
  "retryPolicy.maxDelaySeconds",
  "retryPolicy.exponentialBackoff",
  "settings.title",
  "settings.description",
  "settings.launchApp",
  "settings.retryPolicy",
  "settings.maxAttempts",
  "settings.initialDelay",
  "settings.maxDelay",
  "settings.seconds",
  "settings.codexBin",
  "confirmation.deleteTaskTitle",
  "confirmation.deleteTaskDescription",
  "states.loadingQueue",
  "states.emptyQueueTitle",
  "states.noResultsTitle",
  "errors.loadQueue",
  "errors.saveQueue",
  "errors.runQueue",
  "toast.queueLoaded",
  "toast.queueSaved",
  "toast.taskCreated",
  "toast.taskUpdated",
  "toast.taskDeleted",
  "toast.runCompleted",
  "common.save",
  "common.cancel",
  "common.delete",
  "common.retry",
  "common.more",
  "common.language",
  "common.theme",
  "common.light",
  "common.dark",
  "common.system",
  "common.close",
  "date.notAvailable",
] as const;

describe("createAppI18n", () => {
  it("uses Chinese by default", () => {
    const instance = createAppI18n({ storage: new MemoryStorage() });

    expect(instance.resolvedLanguage).toBe(DEFAULT_LOCALE);
    expect(instance.t("app.name")).toBe("Codex 任务队列");
  });

  it("restores and persists the selected language", async () => {
    const storage = new MemoryStorage();
    storage.setItem(LANGUAGE_STORAGE_KEY, "en");
    const instance = createAppI18n({ storage });

    expect(instance.t("app.name")).toBe("Codex Task Queue");

    await instance.changeLanguage("zh-CN");

    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBe("zh-CN");
  });

  it("falls back to Chinese for unsupported locales", () => {
    const instance = createAppI18n({
      locale: "fr-FR",
      storage: new MemoryStorage(),
    });

    expect(instance.resolvedLanguage).toBe("zh-CN");
    expect(instance.t("errors.generic", { lng: "fr-FR" })).toBe("发生未知错误");
  });

  it("ships every queue-management key in both languages", () => {
    const instance = createAppI18n({ storage: new MemoryStorage() });

    for (const locale of ["zh-CN", "en"] as const) {
      for (const key of requiredTranslationKeys) {
        expect(instance.exists(key, { lng: locale }), `${locale}: ${key}`).toBe(
          true,
        );
      }
    }
  });

  it("formats attempt counts with locale-aware plurals", () => {
    const instance = createAppI18n({ storage: new MemoryStorage() });

    expect(instance.t("task.meta.attempts", { count: 1, lng: "en" })).toBe(
      "1 attempt",
    );
    expect(instance.t("task.meta.attempts", { count: 3, lng: "en" })).toBe(
      "3 attempts",
    );
    expect(instance.t("task.meta.attempts", { count: 3, lng: "zh-CN" })).toBe(
      "3 次尝试",
    );
  });
});

describe("normalizeLocale", () => {
  it.each([
    ["zh", "zh-CN"],
    ["zh_CN", "zh-CN"],
    ["en-US", "en"],
    ["EN_gb", "en"],
    ["de-DE", "zh-CN"],
    [null, "zh-CN"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeLocale(input)).toBe(expected);
  });
});

describe("public i18n entry point", () => {
  it("exports the initialized instance and typed language switcher", async () => {
    expect(i18n.isInitialized).toBe(true);
    expect(SUPPORTED_LOCALES).toEqual(["zh-CN", "en"]);

    await setAppLanguage("en");
    expect(i18n.resolvedLanguage).toBe("en");

    await setAppLanguage("zh-CN");
  });
});
