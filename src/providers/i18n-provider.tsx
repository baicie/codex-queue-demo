import { useEffect } from "react";
import type { PropsWithChildren } from "react";
import type { i18n as I18nInstance } from "i18next";
import { I18nextProvider } from "react-i18next";

import { i18n as defaultI18n, normalizeLocale } from "@/i18n";

export interface I18nProviderProps extends PropsWithChildren {
  instance?: I18nInstance;
}

export function I18nProvider({
  children,
  instance = defaultI18n,
}: I18nProviderProps) {
  useEffect(() => {
    const updateDocumentLocale = (language: string) => {
      const locale = normalizeLocale(language);
      document.documentElement.lang = locale;
      document.documentElement.dir = instance.dir(locale);
    };

    updateDocumentLocale(instance.resolvedLanguage ?? instance.language);
    instance.on("languageChanged", updateDocumentLocale);

    return () => {
      instance.off("languageChanged", updateDocumentLocale);
    };
  }, [instance]);

  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}
