import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeCallRecordService,
  getCallRecordRecorder,
  getCallRecordStore,
  initializeCallRecordService,
} from "@src/call-records/service.js";
import { ConfigSchema } from "@src/config-schema.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallRecordStore } from "@src/call-records/store.js";

const dirs: string[] = [];

afterEach(() => {
  closeCallRecordService();
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("call record service", () => {
  it("initializes one queryable store and recorder, then closes cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "call-record-service-"));
    dirs.push(dir);
    const config = ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, dashboard: { admin_key: "test-admin-key" }, session: {},
      call_records: { enabled: true, max_body_bytes: 4096 },
    });

    initializeCallRecordService(config, join(dir, "calls.sqlite"));

    expect(getCallRecordStore()).not.toBeNull();
    expect(getCallRecordRecorder()).not.toBeNull();
    closeCallRecordService();
    expect(getCallRecordStore()).toBeNull();
    expect(getCallRecordRecorder()).toBeNull();
  });

  it("runs configured retention cleanup at startup and daily until closed", () => {
    vi.useFakeTimers();
    const cleanup = vi.spyOn(CallRecordStore.prototype, "cleanup").mockReturnValue(0);
    const dir = mkdtempSync(join(tmpdir(), "call-record-retention-"));
    dirs.push(dir);
    const config = ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, dashboard: { admin_key: "test-admin-key" }, session: {},
      call_records: { enabled: true, retention_days: 7, max_body_bytes: 4096, max_rows: 10000 },
    });

    initializeCallRecordService(config, join(dir, "calls.sqlite"));
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenLastCalledWith(7, expect.any(Date), 10000);

    vi.advanceTimersByTime(86_400_000);
    expect(cleanup).toHaveBeenCalledTimes(2);

    closeCallRecordService();
    vi.advanceTimersByTime(86_400_000);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("keeps recording available when retention cleanup fails", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(CallRecordStore.prototype, "cleanup").mockImplementation(() => {
      throw new Error("cleanup failed");
    });
    const dir = mkdtempSync(join(tmpdir(), "call-record-retention-failure-"));
    dirs.push(dir);
    const config = ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, dashboard: { admin_key: "test-admin-key" }, session: {},
      call_records: { enabled: true, retention_days: 7, max_body_bytes: 4096, max_rows: 10000 },
    });

    initializeCallRecordService(config, join(dir, "calls.sqlite"));

    expect(getCallRecordStore()).not.toBeNull();
    expect(getCallRecordRecorder()).not.toBeNull();
  });
});
