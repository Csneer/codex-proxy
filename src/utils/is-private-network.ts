import { isIP } from "node:net";

function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const withoutBrackets = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  const zoneIndex = withoutBrackets.indexOf("%");
  return zoneIndex === -1 ? withoutBrackets : withoutBrackets.slice(0, zoneIndex);
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first, second] = octets;
  return first === 127 ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254);
}

/** True for loopback, RFC1918, IPv4 link-local, IPv6 ULA, and IPv6 link-local addresses. */
export function isPrivateNetworkAddress(rawAddress: string): boolean {
  const address = normalizeAddress(rawAddress);
  if (!address) return false;

  const mappedIpv4 = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) !== 6) return false;

  if (address === "::1") return true;
  const firstHextet = Number.parseInt(address.split(":", 1)[0] || "0", 16);
  return (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) ||
    (firstHextet >= 0xfe80 && firstHextet <= 0xfebf);
}
