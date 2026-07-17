/**
 * Tests for centralized path management (src/paths.ts).
 * Uses vi.resetModules() + dynamic imports to isolate module state.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "path";

const packageRoot = resolve(import.meta.dirname, "../..");

// Each test re-imports the module to get a fresh _paths = null state
async function importPaths() {
  const mod = await import("@src/paths.js");
  return mod;
}

describe("paths — CLI mode (default)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("uses the package root even when launched from a different working directory", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/tmp/migrated-working-directory");
    const { getRootDir } = await importPaths();
    expect(getRootDir()).toBe(packageRoot);
    cwd.mockRestore();
  });

  it("getConfigDir returns package-root/config by default", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/tmp/migrated-working-directory");
    const { getConfigDir } = await importPaths();
    expect(getConfigDir()).toBe(resolve(packageRoot, "config"));
    cwd.mockRestore();
  });

  it("getDataDir returns package-root/data by default", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/tmp/migrated-working-directory");
    const { getDataDir } = await importPaths();
    expect(getDataDir()).toBe(resolve(packageRoot, "data"));
    cwd.mockRestore();
  });

  it("getBinDir returns package-root/bin by default", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/tmp/migrated-working-directory");
    const { getBinDir } = await importPaths();
    expect(getBinDir()).toBe(resolve(packageRoot, "bin"));
    cwd.mockRestore();
  });

  it("getPublicDir returns package-root/public by default", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/tmp/migrated-working-directory");
    const { getPublicDir } = await importPaths();
    expect(getPublicDir()).toBe(resolve(packageRoot, "public"));
    cwd.mockRestore();
  });

  it("isEmbedded returns false by default", async () => {
    const { isEmbedded } = await importPaths();
    expect(isEmbedded()).toBe(false);
  });
});

describe("paths — Electron mode (setPaths)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("setPaths overrides all path getters", async () => {
    const { setPaths, getRootDir, getConfigDir, getDataDir, getBinDir, getPublicDir } = await importPaths();
    setPaths({
      rootDir: "/app",
      configDir: "/app/resources/config",
      dataDir: "/app/data",
      binDir: "/app/bin",
      publicDir: "/app/public",
    });
    expect(getRootDir()).toBe("/app");
    expect(getConfigDir()).toBe("/app/resources/config");
    expect(getDataDir()).toBe("/app/data");
    expect(getBinDir()).toBe("/app/bin");
    expect(getPublicDir()).toBe("/app/public");
  });

  it("isEmbedded returns true after setPaths", async () => {
    const { setPaths, isEmbedded } = await importPaths();
    setPaths({
      rootDir: "/app",
      configDir: "/app/config",
      dataDir: "/app/data",
      binDir: "/app/bin",
      publicDir: "/app/public",
    });
    expect(isEmbedded()).toBe(true);
  });

});
