import { createHash } from "node:crypto";
import { isPrivateAddress } from "@/lib/security/public-address";
import { checkDocumentUrl, FETCH_TIMEOUT_MS, MAX_DOCUMENT_BYTES, MAX_REDIRECTS, sameHostHttps } from "./policy";

/** One request to one checked address. The transport connects to `address` and nowhere else, whatever the name says. */
export interface TransportRequest {
  url: URL;
  address: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Drops the connection without reading the rest. */
  destroy(): void;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface FetchDeps {
  /** Every address the host name resolves to. */
  resolve(host: string): Promise<string[]>;
  transport: Transport;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface FetchRequest {
  url: string;
  /** The tender's own source link: its host is the one host allowed without being on the list. */
  sourceUrl: string | null;
  allowedHosts: readonly string[];
  signal?: AbortSignal;
}

export type FetchResult =
  | { ok: true; bytes: Uint8Array; sha256: string; contentType: string | null }
  | {
      ok: false;
      reason: "refused" | "too_large" | "http" | "timeout" | "network" | "redirect";
      /** Plain words for the person looking at the tender. Never the URL, its query or anything the server said. */
      message: string;
      /** Another attempt may succeed. */
      retryable: boolean;
      status?: number;
    };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const HEADERS = {
  accept: "application/pdf, application/octet-stream, */*;q=0.1",
  "accept-encoding": "identity",
  "user-agent": "TenderOS tender document fetch",
};

const fail = (reason: Extract<FetchResult, { ok: false }>["reason"], message: string, retryable: boolean, status?: number): FetchResult => ({
  ok: false,
  reason,
  message,
  retryable,
  ...(status !== undefined ? { status } : {}),
});

/**
 * Downloads one tender document for the worker, hardened for a URL a stranger can influence:
 *   - https only, to the tender's own host or an allow-listed one (policy.ts);
 *   - the name is resolved here and every address must be public (lib/security/public-address.ts); the connection is
 *     then made to that address, so a name that changes its answer cannot redirect it;
 *   - redirects are followed by hand, only on the same host over https, with the check repeated on every hop;
 *   - no cookies or credentials are sent, and compression is refused so a small download cannot unpack into a large one;
 *   - one deadline covers the whole download, and the body stops at the size cap, declared or not.
 * Nothing about the URL, its query or the server's reply goes into the result.
 */
export async function fetchDocumentBytes(req: FetchRequest, deps: FetchDeps): Promise<FetchResult> {
  const checked = checkDocumentUrl(req.url, req.sourceUrl, req.allowedHosts);
  if (!checked.ok) return fail("refused", checked.message, false);

  const maxBytes = deps.maxBytes ?? MAX_DOCUMENT_BYTES;
  const deadline = AbortSignal.timeout(deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  const signal = req.signal ? AbortSignal.any([req.signal, deadline]) : deadline;
  const stopped = (): FetchResult =>
    deadline.aborted ? fail("timeout", "The portal took too long to send the file", true) : fail("network", "The download was stopped", false);

  let current = checked.url;
  for (let hop = 0; hop <= (deps.maxRedirects ?? MAX_REDIRECTS); hop++) {
    let addresses: string[];
    try {
      addresses = await deps.resolve(current.hostname);
    } catch {
      return signal.aborted ? stopped() : fail("network", "The portal's address could not be found", true);
    }
    if (addresses.length === 0) return fail("network", "The portal's address could not be found", true);
    if (addresses.some((a) => isPrivateAddress(a))) return fail("refused", "The portal's address is not one TenderOS will connect to", false);

    let res: TransportResponse | undefined;
    try {
      res = await deps.transport({ url: current, address: addresses[0], headers: HEADERS, signal });

      if (REDIRECTS.has(res.status)) {
        const location = res.headers.location;
        res.destroy();
        if (!location) return fail("redirect", "The portal redirected the download without saying where", false);
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return fail("refused", "The portal redirected the download somewhere that is not allowed", false);
        }
        if (!sameHostHttps(current, next)) return fail("refused", "The portal redirected the download somewhere that is not allowed", false);
        current = next;
        continue;
      }

      if (res.status !== 200) {
        res.destroy();
        const retryable = res.status === 429 || res.status >= 500;
        return fail(
          "http",
          res.status === 404 || res.status === 410 ? "The portal no longer has this file" : `The portal answered HTTP ${res.status}`,
          retryable,
          res.status,
        );
      }

      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        return fail("too_large", `The file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit`, false);
      }

      const parts: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of res.body) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          res.destroy();
          return fail("too_large", `The file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit`, false);
        }
        parts.push(chunk);
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const p of parts) {
        bytes.set(p, at);
        at += p.byteLength;
      }
      return {
        ok: true,
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        contentType: res.headers["content-type"]?.split(";")[0].trim() || null,
      };
    } catch {
      res?.destroy();
      return signal.aborted ? stopped() : fail("network", "The connection to the portal failed", true);
    }
  }
  return fail("redirect", "The portal redirected the download too many times", false);
}
