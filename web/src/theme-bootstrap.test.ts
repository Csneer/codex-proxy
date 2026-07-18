/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const bootstrap = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1] ?? "";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
});

describe("theme bootstrap", () => {
  it("uses dark for the first frame when no preference exists", () => {
    new Function(bootstrap)();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("honors an explicit saved light preference", () => {
    localStorage.setItem("codex-proxy-theme", "light");
    new Function(bootstrap)();

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("still applies dark when storage access is blocked", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    new Function(bootstrap)();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    getItem.mockRestore();
  });
});
