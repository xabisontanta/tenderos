import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Ports TenderOS will use for SMTP submission. Port 25 is not offered: providers block it. */
export const SMTP_PORTS = [465, 587, 2525] as const;

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateV6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("::ffff:")) return privateV4(v.slice(7));
  return (
    v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff")
  );
}

export function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 4 ? privateV4(ip) : isIP(ip) === 6 ? privateV6(ip) : true;
}

/**
 * Resolves a customer-supplied SMTP host and refuses anything that points at a
 * private, loopback, link-local or metadata address, so the mail feature can't
 * be used to probe the hosting network. Returns the address to connect to, so
 * a DNS change between check and connect can't redirect the connection.
 */
export async function resolvePublicHost(host: string): Promise<string> {
  const name = host.trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,253}$/.test(name) || !name.includes(".") || isIP(name)) {
    throw new Error("Enter the mail server's host name, for example smtp.yourcompany.co.za");
  }
  const addresses = await lookup(name, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new Error(`Could not find the mail server ${name}`);
  const bad = addresses.find((a) => isPrivateAddress(a.address));
  if (bad) throw new Error("That mail server address is not allowed");
  return addresses[0].address;
}
