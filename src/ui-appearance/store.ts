import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../paths.js";
import { inspectImage } from "./image-metadata.js";

export interface AppearanceSettings { panelOpacity: number; cardOpacity: number; brightness: number; blurPx: number; enabled: boolean; theme: "light" | "dark"; backgroundContentType: "image/png" | "image/jpeg" | "image/webp"; }
// Keep the background visible around the workbench, while giving text and
// controls a stable, readable surface similar to the approved reference.
const defaults: AppearanceSettings = { panelOpacity: 0.70, cardOpacity: 0.74, brightness: 0.72, blurPx: 2, enabled: false, theme: "dark", backgroundContentType: "image/png" };
const dir = () => { const value = join(getDataDir(), "ui"); mkdirSync(value, { recursive: true }); return value; };
const metaPath = () => join(dir(), "appearance.json");
const imagePath = () => join(dir(), "background.bin");
export function getAppearance(): AppearanceSettings & { hasBackground: boolean } {
  let value: Partial<AppearanceSettings> = {};
  try { value = JSON.parse(readFileSync(metaPath(), "utf8")); } catch {}
  return { ...defaults, ...value, hasBackground: existsSync(imagePath()) };
}
export function updateAppearance(patch: Partial<AppearanceSettings>): AppearanceSettings & { hasBackground: boolean } {
  const next = { ...getAppearance(), ...patch };
  writeFileSync(metaPath(), JSON.stringify(next, null, 2));
  return next;
}
export function replaceBackground(bytes: Buffer, contentType: string): void {
  if (bytes.length > 16 * 1024 * 1024) throw new Error("image_too_large");
  if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) throw new Error("unsupported_image");
  const metadata = inspectImage(bytes);
  if (metadata.width > 8192 || metadata.height > 8192) throw new Error("image_dimensions_too_large");
  const target = imagePath(); const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, bytes); renameSync(temp, target); updateAppearance({ enabled: true, backgroundContentType: contentType as AppearanceSettings["backgroundContentType"] });
}
export function readBackground(): Buffer | null { try { return readFileSync(imagePath()); } catch { return null; } }
export function getBackgroundContentType(): AppearanceSettings["backgroundContentType"] { return getAppearance().backgroundContentType; }
export function getBackgroundRevision(): number {
  try { return Math.trunc(statSync(imagePath()).mtimeMs); } catch { return 0; }
}
export function removeBackground(): void { try { unlinkSync(imagePath()); } catch {} updateAppearance({ enabled: false }); }
