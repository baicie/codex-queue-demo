import type { PropsWithChildren } from "react";
import type { i18n as I18nInstance } from "i18next";
import type { ThemeProviderProps } from "next-themes";

import { I18nProvider } from "@/providers/i18n-provider";
import { ThemeProvider } from "@/providers/theme-provider";

export interface AppProvidersProps extends PropsWithChildren {
  i18nInstance?: I18nInstance;
  themeProps?: Omit<ThemeProviderProps, "children">;
}

export function AppProviders({
  children,
  i18nInstance,
  themeProps,
}: AppProvidersProps) {
  return (
    <ThemeProvider {...themeProps}>
      <I18nProvider instance={i18nInstance}>{children}</I18nProvider>
    </ThemeProvider>
  );
}
