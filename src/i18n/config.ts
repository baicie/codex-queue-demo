import { createInstance } from "i18next";
import type { i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next";

import { resources } from "@/i18n/resources";

export const DEFAULT_LOCALE = "zh-CN" as const;
export const FALLBACK_LOCALE = DEFAULT_LOCALE;
export const SUPPORTED_LOCALES = [DEFAULT_LOCALE, "en"] as const;
export const LANGUAGE_STORAGE_KEY = "codex-queue-language";

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];
export type LanguageStorage = Pick<Storage, "getItem" | "setItem">;

export interface CreateAppI18nOptions {
  locale?: string | null;
  storage?: LanguageStorage | null;
}

export function normalizeLocale(locale: string | null | undefined): AppLocale {
  const normalized = locale?.trim().replaceAll("_", "-").toLowerCase();

  if (normalized === "zh" || normalized?.startsWith("zh-")) {
    return "zh-CN";
  }

  if (normalized === "en" || normalized?.startsWith("en-")) {
    return "en";
  }

  return DEFAULT_LOCALE;
}

export function createAppI18n(
  options: CreateAppI18nOptions = {},
): I18nInstance {
  const storage =
    options.storage === undefined ? getBrowserStorage() : options.storage;
  const locale = normalizeLocale(
    options.locale ?? readStoredLocale(storage ?? undefined),
  );
  const instance = createInstance();

  instance.on("languageChanged", (language) => {
    writeStoredLocale(storage ?? undefined, normalizeLocale(language));
  });

  void instance.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    load: "currentOnly",
    defaultNS: "translation",
    ns: ["translation"],
    interpolation: {
      escapeValue: false,
    },
    initAsync: false,
    returnNull: false,
    react: {
      useSuspense: false,
    },
  });

  return instance;
}

function getBrowserStorage(): LanguageStorage | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readStoredLocale(storage: LanguageStorage | undefined): string | null {
  try {
    return storage?.getItem(LANGUAGE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStoredLocale(
  storage: LanguageStorage | undefined,
  locale: AppLocale,
) {
  try {
    storage?.setItem(LANGUAGE_STORAGE_KEY, locale);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}
