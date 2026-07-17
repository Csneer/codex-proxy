/**
 * Centralized path management for CLI and Electron modes.
 *
 * CLI mode (default): install-time resources are relative to the package
 * root, not process.cwd(). Runtime data uses the same root unless an
 * embedding host supplies an explicit dataDir via setPaths().
 * Electron mode: paths set by setPaths() before backend imports.
 */

import { fileURLToPath } from "url";
import { resolve } from "path";

interface PathConfig {
  rootDir: string;
  configDir: string;
  dataDir: string;
  binDir: string;
  publicDir: string;
}

let _paths: PathConfig | null = null;

// Resources are installed alongside the package, while process.cwd() may be
// changed by a service manager or a caller that launches the migrated binary.
// `src/paths.ts` and compiled `dist/paths.js` are both one level below root.
const PACKAGE_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * Set custom paths (called by Electron main process before importing backend).
 * Must be called before any getXxxDir() calls.
 */
export function setPaths(config: PathConfig): void {
  _paths = config;
}

/** App root directory (where package.json lives). */
export function getRootDir(): string {
  return _paths?.rootDir ?? PACKAGE_ROOT;
}

/** Directory containing YAML config files. */
export function getConfigDir(): string {
  return _paths?.configDir ?? resolve(PACKAGE_ROOT, "config");
}

/** Directory for runtime data (accounts.json, cookies.json, etc.). */
export function getDataDir(): string {
  return _paths?.dataDir ?? resolve(PACKAGE_ROOT, "data");
}

/** Directory for curl-impersonate binaries. */
export function getBinDir(): string {
  return _paths?.binDir ?? resolve(PACKAGE_ROOT, "bin");
}

/** Directory for static web assets (Vite build output). */
export function getPublicDir(): string {
  return _paths?.publicDir ?? resolve(PACKAGE_ROOT, "public");
}

/** Whether running in embedded mode (Electron). */
export function isEmbedded(): boolean {
  return _paths !== null;
}
