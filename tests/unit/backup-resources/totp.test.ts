import { describe, expect, it } from "vitest";
import { generateTotpCode, InvalidTotpSecretError } from "@src/backup-resources/totp.js";

const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("TOTP code generation", () => {
  it.each([
    [59, "287082"],
    [1_111_111_109, "081804"],
    [1_111_111_111, "050471"],
    [1_234_567_890, "005924"],
    [2_000_000_000, "279037"],
    [20_000_000_000, "353130"],
  ])("matches RFC 6238 SHA-1 vector at %s seconds", (timestamp, expected) => {
    expect(generateTotpCode(RFC_SECRET, timestamp * 1000)).toMatchObject({
      code: expected,
      period: 30,
      digits: 6,
      expiresAt: (Math.floor(timestamp / 30) + 1) * 30 * 1000,
    });
  });

  it("accepts otpauth URIs and common algorithm settings", () => {
    const snapshot = generateTotpCode(
      `otpauth://totp/Example:user@example.com?secret=${RFC_SECRET}&issuer=Example&algorithm=SHA1&digits=8&period=60`,
      59 * 1000,
    );

    expect(snapshot).toEqual({
      code: "84755224",
      expiresAt: 60 * 1000,
      period: 60,
      digits: 8,
    });
  });

  it.each(["", "not a base32 secret!", "otpauth://hotp/example?secret=ABC"]) (
    "rejects invalid TOTP secret %j",
    (secret) => {
      expect(() => generateTotpCode(secret, 0)).toThrow(InvalidTotpSecretError);
    },
  );
});
