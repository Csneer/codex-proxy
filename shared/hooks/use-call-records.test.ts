import { describe, expect, it } from "vitest";
import {
  buildCallRecordsQuery,
  normalizeCallRecordsQueryState,
  type CallRecordFilters,
} from "./use-call-records";

const filters: CallRecordFilters = {
  from: "",
  to: "",
  contextId: "",
  search: "",
  sessionId: "",
  taskId: "",
  cwd: "",
  model: "",
  provider: "",
  accountId: "",
  protocol: "",
  stream: "",
  sort: "completed_at",
  order: "desc",
};

describe("call record query state", () => {
  it("encodes only active server filters and pagination", () => {
    const query = buildCallRecordsQuery({
      ...filters,
      search: "token 浪费",
      from: "2026-07-01T08:00:00.000Z",
      to: "2026-07-31T08:00:00.000Z",
      contextId: "context-1",
      cwd: "/workspace/app",
      accountId: "account-1",
      protocol: "responses",
      stream: "true",
      sort: "input_tokens",
      order: "asc",
    }, 2, 50);

    expect(query.toString()).toBe(
      "from=2026-07-01T08%3A00%3A00.000Z&to=2026-07-31T08%3A00%3A00.000Z&context_id=context-1&search=token+%E6%B5%AA%E8%B4%B9&cwd=%2Fworkspace%2Fapp&account_id=account-1&protocol=responses&stream=true&sort=input_tokens&order=asc&limit=50&offset=100",
    );
  });

  it("resets pagination and selection whenever filters or view change", () => {
    expect(normalizeCallRecordsQueryState({
      view: "calls",
      filters,
      page: 3,
      selectedId: "record-1",
    }, { filters: { ...filters, model: "gpt-5.4" } })).toMatchObject({
      page: 0,
      selectedId: null,
    });

    expect(normalizeCallRecordsQueryState({
      view: "calls",
      filters,
      page: 3,
      selectedId: "record-1",
    }, { view: "contexts" })).toMatchObject({
      view: "contexts",
      page: 0,
      selectedId: null,
    });
  });
});
