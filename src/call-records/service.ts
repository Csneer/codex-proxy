import { resolve } from "node:path";
import type { AppConfig } from "../config.js";
import { getDataDir } from "../paths.js";
import { createCallRecorder, type CallRecorder } from "./recorder.js";
import { CallRecordStore } from "./store.js";

let store: CallRecordStore | null = null;
let recorder: CallRecorder | null = null;
let serviceConfig: AppConfig["call_records"] | null = null;
let retentionTimer: NodeJS.Timeout | null = null;

const RETENTION_INTERVAL_MS = 86_400_000;

function stopRetentionTimer(): void {
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = null;
}

function runRetentionCleanup(): void {
  const retentionDays = serviceConfig?.retention_days ?? null;
  if (!store || retentionDays === null) return;
  try {
    store.cleanup(retentionDays);
  } catch (error) {
    console.error("[CallRecords] Retention cleanup failed:", error);
  }
}

function startRetentionTimer(): void {
  stopRetentionTimer();
  if (!store || serviceConfig?.retention_days === null) return;
  runRetentionCleanup();
  retentionTimer = setInterval(runRetentionCleanup, RETENTION_INTERVAL_MS);
  retentionTimer.unref();
}

export function initializeCallRecordService(
  config: AppConfig,
  path = resolve(getDataDir(), "call-records.sqlite"),
): void {
  closeCallRecordService();
  serviceConfig = config.call_records;
  try {
    store = new CallRecordStore({ path });
    recorder = createCallRecorder({
      store,
      isEnabled: () => serviceConfig?.enabled ?? false,
      maxBodyBytes: () => serviceConfig?.max_body_bytes ?? 1_048_576,
      onError: (error, requestId) => {
        console.error(`[CallRecords] Failed to persist request ${requestId}:`, error);
      },
    });
    startRetentionTimer();
  } catch (error) {
    store = null;
    recorder = null;
    console.error("[CallRecords] Failed to initialize:", error);
  }
}

export function updateCallRecordServiceConfig(config: AppConfig): void {
  serviceConfig = config.call_records;
  startRetentionTimer();
}

export function getCallRecordStore(): CallRecordStore | null {
  return store;
}

export function getCallRecordRecorder(): CallRecorder | null {
  return recorder;
}

export function closeCallRecordService(): void {
  stopRetentionTimer();
  try {
    store?.close();
  } catch (error) {
    console.error("[CallRecords] Failed to close:", error);
  } finally {
    store = null;
    recorder = null;
    serviceConfig = null;
  }
}
