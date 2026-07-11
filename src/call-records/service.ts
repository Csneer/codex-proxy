import { resolve } from "node:path";
import type { AppConfig } from "../config.js";
import { getDataDir } from "../paths.js";
import { createCallRecorder, type CallRecorder } from "./recorder.js";
import { CallRecordStore } from "./store.js";

let store: CallRecordStore | null = null;
let recorder: CallRecorder | null = null;

export function initializeCallRecordService(
  config: AppConfig,
  path = resolve(getDataDir(), "call-records.sqlite"),
): void {
  closeCallRecordService();
  try {
    store = new CallRecordStore({ path });
    recorder = createCallRecorder({
      store,
      isEnabled: () => config.call_records.enabled,
      maxBodyBytes: () => config.call_records.max_body_bytes,
      onError: (error, requestId) => {
        console.error(`[CallRecords] Failed to persist request ${requestId}:`, error);
      },
    });
  } catch (error) {
    store = null;
    recorder = null;
    console.error("[CallRecords] Failed to initialize:", error);
  }
}

export function getCallRecordStore(): CallRecordStore | null {
  return store;
}

export function getCallRecordRecorder(): CallRecorder | null {
  return recorder;
}

export function closeCallRecordService(): void {
  try {
    store?.close();
  } catch (error) {
    console.error("[CallRecords] Failed to close:", error);
  } finally {
    store = null;
    recorder = null;
  }
}
