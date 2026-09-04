import { createHmac } from "node:crypto";

const DEFAULT_ALGORITHM = "sha1" as const;
const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD = 30;

type TotpAlgorithm = "sha1" | "sha256" | "sha512";

interface TotpConfig {
  secret: Buffer;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

export interface TotpCodeSnapshot {
  code: string;
  expiresAt: number;
  period: number;
  digits: number;
}

export class InvalidTotpSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTotpSecretError";
  }
}

function decodeBase32(value: string): Buffer {
  const normalized = value.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new InvalidTotpSecretError("TOTP secret must be a base32 value or otpauth URI");
  }

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of normalized) {
    const digit = character.charCodeAt(0) <= 57
      ? character.charCodeAt(0) - 50 + 26
      : character.charCodeAt(0) - 65;
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }

  if (bytes.length === 0) {
    throw new InvalidTotpSecretError("TOTP secret is empty");
  }
  return Buffer.from(bytes);
}

function parseTotpSecret(input: string): TotpConfig {
  const value = input.trim();
  if (!value) throw new InvalidTotpSecretError("TOTP secret is empty");

  let secretValue = value;
  let algorithm: TotpAlgorithm = DEFAULT_ALGORITHM;
  let digits = DEFAULT_DIGITS;
  let period = DEFAULT_PERIOD;

  if (value.toLowerCase().startsWith("otpauth://")) {
    let uri: URL;
    try {
      uri = new URL(value);
    } catch {
      throw new InvalidTotpSecretError("TOTP otpauth URI is invalid");
    }
    if (uri.protocol !== "otpauth:" || uri.hostname.toLowerCase() !== "totp") {
      throw new InvalidTotpSecretError("TOTP otpauth URI must use the totp type");
    }

    secretValue = uri.searchParams.get("secret") ?? "";
    const algorithmValue = (uri.searchParams.get("algorithm") ?? "SHA1").toUpperCase().replace(/-/g, "");
    if (algorithmValue === "SHA1") algorithm = "sha1";
    else if (algorithmValue === "SHA256") algorithm = "sha256";
    else if (algorithmValue === "SHA512") algorithm = "sha512";
    else throw new InvalidTotpSecretError("TOTP algorithm must be SHA1, SHA256, or SHA512");

    const digitsValue = uri.searchParams.get("digits");
    if (digitsValue !== null) digits = Number(digitsValue);
    if (!Number.isSafeInteger(digits) || (digits !== 6 && digits !== 8)) {
      throw new InvalidTotpSecretError("TOTP digits must be 6 or 8");
    }

    const periodValue = uri.searchParams.get("period");
    if (periodValue !== null) period = Number(periodValue);
    if (!Number.isSafeInteger(period) || period < 1 || period > 86_400) {
      throw new InvalidTotpSecretError("TOTP period must be between 1 and 86400 seconds");
    }
  }

  return {
    secret: decodeBase32(secretValue),
    algorithm,
    digits,
    period,
  };
}

export function generateTotpCode(secret: string, nowMs = Date.now()): TotpCodeSnapshot {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new InvalidTotpSecretError("TOTP timestamp is invalid");
  }

  const config = parseTotpSecret(secret);
  const counter = Math.floor(nowMs / 1000 / config.period);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(config.algorithm, config.secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = (
    ((digest[offset]! & 0x7f) << 24)
    | (digest[offset + 1]! << 16)
    | (digest[offset + 2]! << 8)
    | digest[offset + 3]!
  ) >>> 0;
  const code = String(binary % (10 ** config.digits)).padStart(config.digits, "0");

  return {
    code,
    expiresAt: (counter + 1) * config.period * 1000,
    period: config.period,
    digits: config.digits,
  };
}
