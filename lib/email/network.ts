import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateAddress } from "@/lib/security/public-address";

/** Ports TenderOS will use for SMTP submission. Port 25 is not offered: providers block it. */
export const SMTP_PORTS = [465, 587, 2525] as const;

// The address rules are shared with the tender document fetcher (lib/tender-documents), so both refuse the same ranges.
export { isPrivateAddress };

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
