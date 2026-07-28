import { DEFAULT_LOCALE, normalizeLocale } from "@/i18n/config";

export type DateTimeValue = Date | string | number;

export function formatDateTime(
  value: DateTimeValue,
  locale: string = DEFAULT_LOCALE,
  options: Intl.DateTimeFormatOptions = {},
) {
  const date = value instanceof Date ? value : new Date(value);

  return new Intl.DateTimeFormat(normalizeLocale(locale), {
    dateStyle: "medium",
    timeStyle: "short",
    ...options,
  }).format(date);
}

export function formatDate(
  value: DateTimeValue,
  locale: string = DEFAULT_LOCALE,
  options: Intl.DateTimeFormatOptions = {},
) {
  const date = value instanceof Date ? value : new Date(value);

  return new Intl.DateTimeFormat(normalizeLocale(locale), {
    dateStyle: "medium",
    ...options,
  }).format(date);
}

export function formatNumber(
  value: number,
  locale: string = DEFAULT_LOCALE,
  options: Intl.NumberFormatOptions = {},
) {
  return new Intl.NumberFormat(normalizeLocale(locale), options).format(value);
}
