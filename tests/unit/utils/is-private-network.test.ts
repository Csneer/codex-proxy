import { describe, expect, it } from "vitest";
import { isPrivateNetworkAddress } from "@src/utils/is-private-network.js";

describe("isPrivateNetworkAddress", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.8",
    "172.16.100.175",
    "172.31.255.254",
    "192.168.1.20",
    "169.254.1.2",
    "::1",
    "::ffff:172.16.100.175",
    "fd12:3456::1",
    "fe80::1%eth0",
  ])("allows private or local address %s", (address) => {
    expect(isPrivateNetworkAddress(address)).toBe(true);
  });

  it.each([
    "",
    "8.8.8.8",
    "172.15.255.255",
    "172.32.0.1",
    "192.0.2.1",
    "2001:4860:4860::8888",
    "not-an-ip",
  ])("rejects non-private address %s", (address) => {
    expect(isPrivateNetworkAddress(address)).toBe(false);
  });
});
