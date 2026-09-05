import { describe, expect, it } from "vitest";
import {
  accountExportDownloadName,
  buildAccountExportUrl,
  prepareAccountImportRequest,
} from "./account-transfer-client";

function makeFile(name: string, text: string, type = "") {
  return {
    name,
    type,
    text: async () => text,
  };
}

describe("account transfer browser client helpers", () => {
  it("preserves long pasted credential JSON byte for byte", async () => {
    const text = JSON.stringify({ credentials: { access_token: "x".repeat(120_000), refresh_token: "rt_test" } });
    expect(await prepareAccountImportRequest(text)).toEqual({ ok: true, contentType: "application/json", body: text });
  });

  it.each(["plain.access.token\nrt_test\n", '{"token":"first"}\n{"token":"second"}\n'])("preserves pasted token/JSON lines: %s", async (text) => {
    expect(await prepareAccountImportRequest(text)).toEqual({ ok: true, contentType: "text/plain", body: text });
  });

  it("rejects blank pasted input", async () => {
    expect(await prepareAccountImportRequest(" \n\t")).toEqual({ ok: false, error: "No importable content" });
  });
  it("builds export URLs and download names for compatibility formats", () => {
    expect(buildAccountExportUrl(["acct-1", "acct-2"], "sub2api"))
      .toBe("/auth/accounts/export?ids=acct-1%2Cacct-2&format=sub2api");
    expect(buildAccountExportUrl(undefined, "full")).toBe("/auth/accounts/export");
    expect(accountExportDownloadName("cockpit_tools", "2026-05-18"))
      .toBe("accounts-export-cockpit-tools-2026-05-18.json");
  });

  it("keeps JSON import payloads intact instead of forcing accounts arrays", async () => {
    const request = await prepareAccountImportRequest(makeFile(
      "sub2api.json",
      JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { access_token: "token" } }] }),
      "application/json",
    ));

    expect(request).toEqual({
      ok: true,
      contentType: "application/json",
      body: JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { access_token: "token" } }] }),
    });
  });

  it("prepares text/plain token line imports", async () => {
    const request = await prepareAccountImportRequest(makeFile(
      "tokens.txt",
      "plain.access.token\nrt_text_only\n",
      "text/plain",
    ));

    expect(request).toEqual({
      ok: true,
      contentType: "text/plain",
      body: "plain.access.token\nrt_text_only\n",
    });
  });

  it("rejects malformed .json files before sending them", async () => {
    const request = await prepareAccountImportRequest(makeFile("broken.json", "{not json", "application/json"));

    expect(request).toEqual({
      ok: false,
      error: "Invalid JSON file",
    });
  });
});
