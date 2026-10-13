import { lookup } from "node:dns/promises";
import https from "node:https";
import { isPrivateAddress } from "@/lib/security/public-address";
import type { FetchDeps, Transport } from "./fetcher";

/** Every address a host name resolves to (the fetcher refuses the request if any one of them is private). */
export async function resolveAddresses(host: string): Promise<string[]> {
  const found = await lookup(host, { all: true, verbatim: true });
  return found.map((a) => a.address);
}

/**
 * One GET over TLS to an address the fetcher has already checked. The connection is pinned to that address (the `lookup`
 * hook returns it, so the name is never looked up again), the certificate is checked against the host name, and the
 * address actually connected to is checked once more when the response starts. Cookies, credentials and compression are
 * never offered (the fetcher sends only its fixed headers).
 */
export const httpsTransport: Transport = ({ url, address, headers, signal }) =>
  new Promise((resolve, reject) => {
    const family = address.includes(":") ? 6 : 4;
    const req = https.request(
      {
        protocol: "https:",
        hostname: url.hostname,
        servername: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        agent: false,
        signal,
        rejectUnauthorized: true,
        lookup: (_host, options, callback) => {
          if (options && typeof options === "object" && "all" in options && options.all) {
            (callback as unknown as (e: Error | null, a: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]);
          } else {
            (callback as unknown as (e: Error | null, a: string, f: number) => void)(null, address, family);
          }
        },
      },
      (res) => {
        const peer = res.socket?.remoteAddress;
        if (!peer || isPrivateAddress(peer)) {
          res.destroy();
          reject(new Error("connected to an address that is not allowed"));
          return;
        }
        const out: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(res.headers)) out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
        resolve({ status: res.statusCode ?? 0, headers: out, body: res, destroy: () => res.destroy() });
      },
    );
    req.on("error", reject);
    req.end();
  });

/** The fetcher's production dependencies. */
export function defaultFetchDeps(): FetchDeps {
  return { resolve: resolveAddresses, transport: httpsTransport };
}
