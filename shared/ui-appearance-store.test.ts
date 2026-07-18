import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ui appearance defaults", () => {
  let directory = "";

  afterEach(() => {
    vi.resetModules();
    vi.unmock("../src/paths.js");
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("uses dark theme when no preference has been stored", async () => {
    directory = mkdtempSync(join(tmpdir(), "codex-appearance-"));
    vi.doMock("../src/paths.js", () => ({ getDataDir: () => directory }));
    const { getAppearance } = await import("../src/ui-appearance/store.js");

    expect(getAppearance().theme).toBe("dark");
  });
});
