import { afterEach, describe, expect, it } from "vitest";
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

const dirs: string[] = [];

afterEach(() => {
  closeCallRecordService();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("call record service", () => {
  it("initializes one queryable store and recorder, then closes cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "call-record-service-"));
    dirs.push(dir);
    const config = ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
      call_records: { enabled: true, max_body_bytes: 4096 },
    });

    initializeCallRecordService(config, join(dir, "calls.sqlite"));

    expect(getCallRecordStore()).not.toBeNull();
    expect(getCallRecordRecorder()).not.toBeNull();
    closeCallRecordService();
    expect(getCallRecordStore()).toBeNull();
    expect(getCallRecordRecorder()).toBeNull();
  });
});
