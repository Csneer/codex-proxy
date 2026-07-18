import { createContext } from "preact";
import { useContext, useState, useCallback, useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { adminFetch } from "../http/admin-fetch.js";

interface ThemeContextValue {
  isDark: boolean;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>(null!);

function getInitialDark(): boolean {
  try {
    const saved = localStorage.getItem("codex-proxy-theme");
    if (saved === "dark") return true;
    if (saved === "light") return false;
  } catch {}
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// Sync dark class + color-scheme to <html> on initial load (before first render to avoid flash)
const _initialDark = getInitialDark();
if (_initialDark) {
  document.documentElement.classList.add("dark");
} else {
  document.documentElement.classList.remove("dark");
}
document.documentElement.style.colorScheme = _initialDark ? "dark" : "light";

export function ThemeProvider({ children }: { children: ComponentChildren }) {
  const [isDark, setIsDark] = useState(_initialDark);

  useEffect(() => {
    void fetch("/auth/dashboard-preferences")
      .then((response) => response.ok ? response.json() : null)
      .then((value: { theme?: string } | null) => {
        if (value?.theme !== "dark" && value?.theme !== "light") return;
        const next = value.theme === "dark";
        setIsDark(next);
        document.documentElement.classList.toggle("dark", next);
        document.documentElement.style.colorScheme = next ? "dark" : "light";
        localStorage.setItem("codex-proxy-theme", value.theme);
      })
      .catch(() => undefined);
  }, []);

  const toggle = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      localStorage.setItem("codex-proxy-theme", next ? "dark" : "light");
      if (next) {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
      document.documentElement.style.colorScheme = next ? "dark" : "light";
      void adminFetch("/admin/ui-appearance", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: next ? "dark" : "light" }) }).catch(() => undefined);
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ isDark, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
