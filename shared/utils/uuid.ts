type WebCryptoLike = {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
};

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function randomBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  const webCrypto = (globalThis as typeof globalThis & { crypto?: WebCryptoLike }).crypto;
  if (typeof webCrypto?.getRandomValues === "function") {
    try {
      return webCrypto.getRandomValues(bytes);
    } catch {
      // Some older or restricted web views expose crypto but reject the call.
    }
  }

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/**
 * Generate a UUID-shaped idempotency key in browsers with varying Web Crypto
 * support. `randomUUID` is unavailable in some older or non-secure contexts,
 * while `getRandomValues` is still widely available there.
 */
export function createUuid(): string {
  const webCrypto = (globalThis as typeof globalThis & { crypto?: WebCryptoLike }).crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    try {
      return webCrypto.randomUUID();
    } catch {
      // Fall through to the getRandomValues/Math.random implementation.
    }
  }

  const bytes = randomBytes();
  // Set UUID v4/version and RFC 4122 variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}
