import type { ThemeProviderProps } from "next-themes";
import { ThemeProvider as NextThemesProvider } from "next-themes";

export const THEME_STORAGE_KEY = "codex-queue-theme";

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey={THEME_STORAGE_KEY}
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
