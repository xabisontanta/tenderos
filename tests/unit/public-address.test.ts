import { describe, expect, it } from "vitest";
import { isPrivateAddress } from "@/lib/security/public-address";

describe("isPrivateAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "127.8.8.8",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.10",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
  ])("refuses the reserved IPv4 address %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each([
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "febf::1",
    "ff02::1",
    "2001:db8::1",
    "64:ff9b::7f00:1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::127.0.0.1",
  ])("refuses the reserved IPv6 address %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each([
    "8.8.8.8",
    "41.0.0.1",
    "154.0.0.1",
    "172.15.0.1",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "2001:4860:4860::8888",
    "2a00:1450:4001::1",
    "::ffff:8.8.8.8",
  ])("treats %s as public", (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it.each(["", "not an address", "1.2.3", "999.1.1.1", "1.2.3.4.5", "example.com", "0x7f.0.0.1", "017700000001", "2130706433"])(
    "refuses %s, which is not a plain address",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
});
