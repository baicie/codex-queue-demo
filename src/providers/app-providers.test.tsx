import { act, cleanup, render, screen } from "@testing-library/react";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createAppI18n } from "@/i18n/config";
import { AppProviders } from "@/providers/app-providers";
import { I18nProvider } from "@/providers/i18n-provider";
import { ThemeProvider } from "@/providers/theme-provider";

function TranslationProbe() {
  const { t } = useTranslation();

  return <span>{t("app.name")}</span>;
}

function ThemeProbe() {
  const { theme, themes } = useTheme();

  return <span>{`${theme}:${themes.join(",")}`}</span>;
}

beforeAll(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("lang");
  document.documentElement.removeAttribute("dir");
  document.documentElement.removeAttribute("class");
  localStorage.clear();
});

describe("I18nProvider", () => {
  it("provides translations and keeps the document language in sync", async () => {
    const instance = createAppI18n({ locale: "en", storage: localStorage });
    render(
      <I18nProvider instance={instance}>
        <TranslationProbe />
      </I18nProvider>,
    );

    expect(screen.getByText("Codex Task Queue")).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("lang", "en");
    expect(document.documentElement).toHaveAttribute("dir", "ltr");

    await act(async () => {
      await instance.changeLanguage("zh-CN");
    });

    expect(screen.getByText("Codex 任务队列")).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
  });
});

describe("ThemeProvider", () => {
  it("enables light, dark, and system themes by default", () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByText("system:light,dark,system")).toBeInTheDocument();
  });
});

describe("AppProviders", () => {
  it("composes the application language and theme providers", () => {
    const instance = createAppI18n({ locale: "en", storage: localStorage });
    render(
      <AppProviders i18nInstance={instance}>
        <TranslationProbe />
        <ThemeProbe />
      </AppProviders>,
    );

    expect(screen.getByText("Codex Task Queue")).toBeInTheDocument();
    expect(screen.getByText("system:light,dark,system")).toBeInTheDocument();
  });
});
