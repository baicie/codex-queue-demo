import { createAppI18n } from "@/i18n/config";
import type { AppLocale } from "@/i18n/config";

export const i18n = createAppI18n();

export async function setAppLanguage(locale: AppLocale) {
  await i18n.changeLanguage(locale);
}

export {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  createAppI18n,
  normalizeLocale,
} from "@/i18n/config";
export type {
  AppLocale,
  CreateAppI18nOptions,
  LanguageStorage,
} from "@/i18n/config";
export { formatDate, formatDateTime, formatNumber } from "@/i18n/formatters";
