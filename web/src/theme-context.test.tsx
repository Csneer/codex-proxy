/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";

const adminFetch = vi.hoisted(() => vi.fn());

vi.mock("../../shared/http/admin-fetch.js", () => ({ adminFetch }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function renderThemeButton() {
  const { ThemeProvider, useTheme } = await import("../../shared/theme/context");
  function Button() {
    const theme = useTheme();
    return <button onClick={theme.toggle}>{theme.isDark ? "dark" : "light"}</button>;
  }
  render(<ThemeProvider><Button /></ThemeProvider>);
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  adminFetch.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThemeProvider", () => {
  it("defaults to dark before the saved server preference arrives", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));

    await renderThemeButton();

    expect(screen.getByRole("button").textContent).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("does not let an older preference response undo a user theme change", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    localStorage.setItem("codex-proxy-theme", "dark");

    await renderThemeButton();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toBe("light");

    const json = vi.fn().mockResolvedValue({ theme: "dark" });
    await act(async () => {
      pending.resolve({ ok: true, json } as unknown as Response);
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith(
      "/admin/ui-appearance",
      expect.objectContaining({ body: JSON.stringify({ theme: "light" }) }),
    ));
    expect(json).toHaveBeenCalledOnce();
    expect(screen.getByRole("button").textContent).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("serializes rapid theme changes so the last click is persisted last", async () => {
    const firstWrite = deferred<Response>();
    const secondWrite = deferred<Response>();
    adminFetch
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    localStorage.setItem("codex-proxy-theme", "dark");

    await renderThemeButton();
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByRole("button").textContent).toBe("dark");
    await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(1));
    expect(adminFetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ theme: "light" }));

    await act(async () => {
      firstWrite.resolve(new Response("{}", { status: 200 }));
      await firstWrite.promise;
    });
    await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(2));
    expect(adminFetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ theme: "dark" }));

    await act(async () => {
      secondWrite.resolve(new Response("{}", { status: 200 }));
      await secondWrite.promise;
    });
    await waitFor(() => expect(localStorage.getItem("codex-proxy-theme-pending")).toBeNull());
    expect(localStorage.getItem("codex-proxy-theme")).toBe("dark");
  });

  it("coalesces queued toggles when the final theme already matches the in-flight write", async () => {
    const firstWrite = deferred<Response>();
    adminFetch.mockImplementationOnce(() => firstWrite.promise);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    localStorage.setItem("codex-proxy-theme", "dark");

    await renderThemeButton();
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toBe("light");
    await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      firstWrite.resolve(new Response("{}", { status: 200 }));
      await firstWrite.promise;
    });

    await waitFor(() => expect(localStorage.getItem("codex-proxy-theme-pending")).toBeNull());
    expect(adminFetch).toHaveBeenCalledTimes(1);
  });

  it("retains a pending marker when server persistence fails", async () => {
    adminFetch.mockResolvedValue(new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    localStorage.setItem("codex-proxy-theme", "dark");

    await renderThemeButton();
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(localStorage.getItem("codex-proxy-theme-pending")).toBe("light"));
    expect(screen.getByRole("button").textContent).toBe("light");
  });

  it("retries one failed persistence request in the current session", async () => {
    adminFetch
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    localStorage.setItem("codex-proxy-theme", "dark");

    await renderThemeButton();
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(localStorage.getItem("codex-proxy-theme-pending")).toBeNull());
    expect(localStorage.getItem("codex-proxy-theme")).toBe("light");
  });
});
