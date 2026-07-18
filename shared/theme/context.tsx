import { createContext } from "preact";
import { useContext, useState, useCallback, useEffect, useRef } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { adminFetch } from "../http/admin-fetch.js";

interface ThemeContextValue {
  isDark: boolean;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>(null!);
const THEME_KEY = "codex-proxy-theme";
const PENDING_THEME_KEY = "codex-proxy-theme-pending";

type ThemeName = "light" | "dark";
const THEME_WRITE_TIMEOUT_MS = 8_000;

function readTheme(key: string): ThemeName | null {
  try {
    const value = localStorage.getItem(key);
    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null;
  }
}

function getInitialDark(): boolean {
  return readTheme(THEME_KEY) !== "light";
}

function applyTheme(isDark: boolean): void {
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";
}

function rememberTheme(isDark: boolean): void {
  try {
    localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
  } catch {}
}

function setPendingTheme(theme: ThemeName | null): void {
  try {
    if (theme) localStorage.setItem(PENDING_THEME_KEY, theme);
    else localStorage.removeItem(PENDING_THEME_KEY);
  } catch {}
}

async function writeTheme(theme: ThemeName): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        adminFetch("/admin/ui-appearance", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theme }),
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("Theme persistence timed out"));
          }, THEME_WRITE_TIMEOUT_MS);
        }),
      ]);
      if (response.ok) return true;
    } catch {
      // Retry once. A pending marker keeps the choice recoverable on reload.
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  return false;
}

// Sync dark class + color-scheme to <html> on initial load (before first render to avoid flash)
const _initialDark = getInitialDark();
applyTheme(_initialDark);

export function ThemeProvider({ children }: { children: ComponentChildren }) {
  const [isDark, setIsDark] = useState(_initialDark);
  const currentTheme = useRef(_initialDark);
  const userThemeRevision = useRef(0);
  const queuedTheme = useRef<ThemeName | null>(null);
  const writingTheme = useRef(false);

  const persistTheme = useCallback((theme: ThemeName) => {
    setPendingTheme(theme);
    queuedTheme.current = theme;
    if (writingTheme.current) return;
    writingTheme.current = true;
    void (async () => {
      try {
        while (queuedTheme.current) {
          const next = queuedTheme.current;
          queuedTheme.current = null;
          const persisted = await writeTheme(next);
          if (persisted && queuedTheme.current === next) queuedTheme.current = null;
          if (persisted && queuedTheme.current === null && readTheme(PENDING_THEME_KEY) === next) {
            setPendingTheme(null);
          }
          if (!persisted && (queuedTheme.current === null || queuedTheme.current === next)) {
            queuedTheme.current = null;
          }
        }
      } finally {
        writingTheme.current = false;
      }
    })();
  }, []);

  useEffect(() => {
    const pendingTheme = readTheme(PENDING_THEME_KEY);
    if (pendingTheme) {
      userThemeRevision.current += 1;
      persistTheme(pendingTheme);
      return;
    }
    const revisionAtRequest = userThemeRevision.current;
    void fetch("/auth/dashboard-preferences", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((value: { theme?: string } | null) => {
        if (value?.theme !== "dark" && value?.theme !== "light") return;
        if (userThemeRevision.current !== revisionAtRequest) return;
        const next = value.theme === "dark";
        currentTheme.current = next;
        setIsDark(next);
        applyTheme(next);
        rememberTheme(next);
      })
      .catch(() => undefined);
  }, [persistTheme]);

  const toggle = useCallback(() => {
    userThemeRevision.current += 1;
    const next = !currentTheme.current;
    currentTheme.current = next;
    setIsDark(next);
    rememberTheme(next);
    applyTheme(next);
    persistTheme(next ? "dark" : "light");
  }, [persistTheme]);

  return (
    <ThemeContext.Provider value={{ isDark, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
