import { afterEach, describe, expect, it, vi } from "vitest";
import { createUuid } from "./uuid";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createUuid", () => {
  it("uses the native randomUUID implementation when available", () => {
    const randomUUID = vi.fn(() => "native-uuid");
    vi.stubGlobal("crypto", { randomUUID });

    expect(createUuid()).toBe("native-uuid");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("uses getRandomValues when randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0);
        return bytes;
      },
    });

    expect(createUuid()).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("still returns a UUID v4 when Web Crypto is unavailable", () => {
    vi.stubGlobal("crypto", {});
    vi.spyOn(Math, "random").mockReturnValue(0);

    expect(createUuid()).toBe("00000000-0000-4000-8000-000000000000");
  });
});
