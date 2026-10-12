import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { fetchDocumentBytes, type FetchDeps, type Transport, type TransportResponse } from "@/lib/tender-documents/fetcher";
import { checkDocumentUrl, documentHostAllowList, DEFAULT_DOCUMENT_HOSTS } from "@/lib/tender-documents/policy";

const ETENDERS = "https://www.etenders.gov.za/home/Download?blobName=abc.pdf&downloadedFileName=Bid.pdf";
const SOURCE = "https://www.etenders.gov.za/Home/opportunities?id=1";
const ALLOW = ["www.etenders.gov.za"];
const PUBLIC_IP = "196.15.1.2";

async function* chunks(...parts: Array<string | Uint8Array>): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield typeof p === "string" ? new TextEncoder().encode(p) : p;
}

function response(status: number, body: AsyncIterable<Uint8Array> | null, headers: Record<string, string> = {}): TransportResponse {
  return { status, headers, body: body ?? chunks(), destroy: vi.fn() };
}

function deps(transport: Transport, resolve: FetchDeps["resolve"] = async () => [PUBLIC_IP], more: Partial<FetchDeps> = {}): FetchDeps {
  return { resolve, transport, ...more };
}

const fetchIt = (d: FetchDeps, url = ETENDERS, sourceUrl: string | null = SOURCE, allow: string[] = ALLOW) =>
  fetchDocumentBytes({ url, sourceUrl, allowedHosts: allow }, d);

describe("checkDocumentUrl: where a document may come from", () => {
  it("allows https on the tender's own host or an allow-listed host", () => {
    expect(checkDocumentUrl(ETENDERS, SOURCE, ALLOW)).toMatchObject({ ok: true });
    expect(checkDocumentUrl("https://tenders.municipality.gov.za/files/a.pdf", "https://tenders.municipality.gov.za/notice/1", [])).toMatchObject({ ok: true });
    expect(checkDocumentUrl("https://WWW.ETENDERS.GOV.ZA/a.pdf", null, ALLOW)).toMatchObject({ ok: true });
  });

  it.each([
    ["http", "http://www.etenders.gov.za/a.pdf"],
    ["ftp", "ftp://www.etenders.gov.za/a.pdf"],
    ["file", "file:///etc/passwd"],
    ["javascript", "javascript:alert(1)"],
    ["credentials", "https://user:pw@www.etenders.gov.za/a.pdf"],
    ["an explicit port", "https://www.etenders.gov.za:8443/a.pdf"],
    ["another host", "https://evil.example.com/a.pdf"],
    ["a look-alike host", "https://www.etenders.gov.za.evil.example.com/a.pdf"],
    ["a sub-domain of an allowed host", "https://files.www.etenders.gov.za/a.pdf"],
    ["an IPv4 literal", "https://196.15.1.2/a.pdf"],
    ["an IPv6 literal", "https://[2001:4860:4860::8888]/a.pdf"],
    ["a decimal IPv4", "https://3315138818/a.pdf"],
    ["not a URL", "not a url"],
    ["empty", ""],
    ["a very long URL", `https://www.etenders.gov.za/${"a".repeat(3000)}`],
  ])("refuses %s", (_label, url) => {
    expect(checkDocumentUrl(url, SOURCE, ALLOW)).toMatchObject({ ok: false });
  });

  it("does not trust a tender's source host when it is an address or has credentials", () => {
    expect(checkDocumentUrl("https://10.0.0.5/a.pdf", "https://10.0.0.5/notice", [])).toMatchObject({ ok: false });
    expect(checkDocumentUrl("https://a.example.org/a.pdf", "https://u:p@a.example.org/notice", [])).toMatchObject({ ok: false });
    expect(checkDocumentUrl("https://a.example.org/a.pdf", null, [])).toMatchObject({ ok: false });
  });

  it("never echoes the URL in its message", () => {
    const res = checkDocumentUrl("https://evil.example.com/a.pdf?token=SECRET123", SOURCE, ALLOW);
    expect(JSON.stringify(res)).not.toContain("SECRET123");
    expect(JSON.stringify(res)).not.toContain("evil.example.com/a.pdf");
  });
});

describe("documentHostAllowList", () => {
  it("defaults to the eTenders host", () => {
    expect([...DEFAULT_DOCUMENT_HOSTS]).toEqual(["www.etenders.gov.za"]);
    expect(documentHostAllowList({})).toEqual(["www.etenders.gov.za"]);
    expect(documentHostAllowList({ TENDER_DOCUMENT_HOSTS: "  " })).toEqual(["www.etenders.gov.za"]);
  });

  it("reads a comma-separated list of bare host names and drops anything else", () => {
    expect(documentHostAllowList({ TENDER_DOCUMENT_HOSTS: "Files.Gov.ZA, www.etenders.gov.za ,https://x.example.com, 10.0.0.1, a b,,*.gov.za" })).toEqual([
      "files.gov.za",
      "www.etenders.gov.za",
    ]);
  });
});

describe("fetchDocumentBytes", () => {
  it("returns the bytes and their SHA-256, connecting to the checked address", async () => {
    const transport = vi.fn<Transport>(async () => response(200, chunks("%PDF-1.4 ", "body"), { "content-type": "application/pdf" }));
    const res = await fetchIt(deps(transport));
    expect(res).toMatchObject({ ok: true, contentType: "application/pdf" });
    if (!res.ok) throw new Error("unreachable");
    expect(new TextDecoder().decode(res.bytes)).toBe("%PDF-1.4 body");
    expect(res.sha256).toBe(createHash("sha256").update("%PDF-1.4 body").digest("hex"));
    expect(transport).toHaveBeenCalledTimes(1);
    const req = transport.mock.calls[0][0];
    expect(req.address).toBe(PUBLIC_IP);
    expect(req.url.host).toBe("www.etenders.gov.za");
    // Nothing that identifies a person or session goes with the request.
    expect(Object.keys(req.headers).map((h) => h.toLowerCase())).not.toEqual(expect.arrayContaining(["cookie", "authorization"]));
    expect(req.headers["accept-encoding"]).toBe("identity");
  });

  it.each([["10.0.0.5"], ["127.0.0.1"], ["169.254.169.254"], ["192.168.1.1"], ["::1"], ["fd00::1"], ["::ffff:7f00:1"]])(
    "refuses a name that resolves to %s and never connects",
    async (ip) => {
      const transport = vi.fn<Transport>();
      const res = await fetchIt(deps(transport, async () => [ip]));
      expect(res).toMatchObject({ ok: false, reason: "refused", retryable: false });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it("refuses a name when any one of its addresses is private (rebinding mixes them)", async () => {
    const transport = vi.fn<Transport>();
    const res = await fetchIt(deps(transport, async () => [PUBLIC_IP, "10.1.1.1"]));
    expect(res).toMatchObject({ ok: false, reason: "refused" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("fails, retryably, when the name cannot be resolved", async () => {
    const transport = vi.fn<Transport>();
    expect(await fetchIt(deps(transport, async () => []))).toMatchObject({ ok: false, reason: "network", retryable: true });
    expect(await fetchIt(deps(transport, async () => Promise.reject(new Error("ENOTFOUND"))))).toMatchObject({ ok: false, reason: "network", retryable: true });
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses a URL the policy refuses, before any lookup", async () => {
    const resolve = vi.fn(async () => [PUBLIC_IP]);
    const transport = vi.fn<Transport>();
    const res = await fetchIt(deps(transport, resolve), "http://www.etenders.gov.za/a.pdf");
    expect(res).toMatchObject({ ok: false, reason: "refused", retryable: false });
    expect(resolve).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  describe("redirects", () => {
    it("follows a redirect on the same host, checking the address again on every hop", async () => {
      const resolve = vi.fn(async () => [PUBLIC_IP]);
      const transport = vi
        .fn<Transport>()
        .mockResolvedValueOnce(response(302, null, { location: "/files/real.pdf" }))
        .mockResolvedValueOnce(response(200, chunks("%PDF-1.4")));
      const res = await fetchIt(deps(transport, resolve));
      expect(res).toMatchObject({ ok: true });
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(transport.mock.calls[1][0].url.pathname).toBe("/files/real.pdf");
    });

    it.each([
      ["another host", "https://evil.example.com/a.pdf"],
      ["a look-alike host", "https://www.etenders.gov.za.evil.example.com/a.pdf"],
      ["plain http", "http://www.etenders.gov.za/a.pdf"],
      ["an address", "https://169.254.169.254/latest/meta-data"],
      ["another port", "https://www.etenders.gov.za:8080/a.pdf"],
      ["a file URL", "file:///etc/passwd"],
    ])("refuses a redirect to %s", async (_label, location) => {
      const transport = vi.fn<Transport>().mockResolvedValue(response(301, null, { location }));
      const res = await fetchIt(deps(transport));
      expect(res).toMatchObject({ ok: false, reason: "refused", retryable: false });
      expect(transport).toHaveBeenCalledTimes(1);
    });

    it("refuses a same-host redirect when the name now resolves to a private address", async () => {
      const resolve = vi.fn<FetchDeps["resolve"]>().mockResolvedValueOnce([PUBLIC_IP]).mockResolvedValueOnce(["10.0.0.9"]);
      const transport = vi.fn<Transport>().mockResolvedValue(response(307, null, { location: "/elsewhere" }));
      const res = await fetchIt(deps(transport, resolve));
      expect(res).toMatchObject({ ok: false, reason: "refused" });
      expect(transport).toHaveBeenCalledTimes(1);
    });

    it("stops after too many redirects", async () => {
      const transport = vi.fn<Transport>().mockImplementation(async () => response(302, null, { location: "/again" }));
      const res = await fetchIt(deps(transport));
      expect(res).toMatchObject({ ok: false, reason: "redirect", retryable: false });
      expect(transport.mock.calls.length).toBeLessThanOrEqual(4);
    });

    it("treats a redirect with no location as a failure", async () => {
      const transport = vi.fn<Transport>().mockResolvedValue(response(302, null));
      expect(await fetchIt(deps(transport))).toMatchObject({ ok: false, reason: "redirect" });
    });
  });

  describe("status codes", () => {
    it.each([404, 410, 403, 401])("treats HTTP %i as final", async (status) => {
      const res = await fetchIt(deps(async () => response(status, null)));
      expect(res).toMatchObject({ ok: false, reason: "http", status, retryable: false });
    });

    it.each([429, 500, 502, 503, 504])("treats HTTP %i as worth another try", async (status) => {
      const res = await fetchIt(deps(async () => response(status, null)));
      expect(res).toMatchObject({ ok: false, reason: "http", status, retryable: true });
    });

    it("does not take a 204 or 206 for a document", async () => {
      expect(await fetchIt(deps(async () => response(204, null)))).toMatchObject({ ok: false, reason: "http" });
      expect(await fetchIt(deps(async () => response(206, chunks("x"))))).toMatchObject({ ok: false, reason: "http" });
    });
  });

  describe("size", () => {
    it("stops at the cap by the declared length, without reading the body", async () => {
      const r = response(200, chunks("never read"), { "content-length": "1000" });
      const res = await fetchIt(deps(async () => r, undefined, { maxBytes: 999 }));
      expect(res).toMatchObject({ ok: false, reason: "too_large", retryable: false });
      expect(r.destroy).toHaveBeenCalled();
    });

    it("stops at the cap while streaming when the length was not declared or was a lie", async () => {
      const r = response(200, chunks("12345", "67890", "abcde"), { "content-length": "3" });
      const res = await fetchIt(deps(async () => r, undefined, { maxBytes: 12 }));
      expect(res).toMatchObject({ ok: false, reason: "too_large" });
      expect(r.destroy).toHaveBeenCalled();
    });

    it("accepts a file exactly at the cap", async () => {
      const res = await fetchIt(deps(async () => response(200, chunks("1234567890")), undefined, { maxBytes: 10 }));
      expect(res).toMatchObject({ ok: true });
    });

    it("has a 25 MB cap by default", async () => {
      const big = new Uint8Array(25 * 1024 * 1024 + 1);
      const res = await fetchIt(deps(async () => response(200, chunks(big))));
      expect(res).toMatchObject({ ok: false, reason: "too_large" });
    });
  });

  describe("time", () => {
    it("gives up on a connection that never answers, and says so as a timeout", async () => {
      const transport: Transport = ({ signal }) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      const res = await fetchIt(deps(transport, undefined, { timeoutMs: 40 }));
      expect(res).toMatchObject({ ok: false, reason: "timeout", retryable: true });
    });

    it("gives up on a body that stalls part-way", async () => {
      async function* stalls(signal: AbortSignal): AsyncGenerator<Uint8Array> {
        yield new TextEncoder().encode("%PDF-");
        await new Promise((_r, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      const transport: Transport = async ({ signal }) => response(200, stalls(signal));
      const res = await fetchIt(deps(transport, undefined, { timeoutMs: 40 }));
      expect(res).toMatchObject({ ok: false, reason: "timeout", retryable: true });
    });

    it("stops when the caller aborts", async () => {
      const controller = new AbortController();
      const transport: Transport = ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          controller.abort();
        });
      const res = await fetchDocumentBytes({ url: ETENDERS, sourceUrl: SOURCE, allowedHosts: ALLOW, signal: controller.signal }, deps(transport));
      expect(res).toMatchObject({ ok: false });
    });
  });

  it("reports a dropped connection as worth another try", async () => {
    const res = await fetchIt(deps(async () => Promise.reject(new Error("ECONNRESET"))));
    expect(res).toMatchObject({ ok: false, reason: "network", retryable: true });
  });

  it("keeps the URL, its query and the server's words out of every message", async () => {
    const url = "https://www.etenders.gov.za/home/Download?blobName=SECRETTOKEN&downloadedFileName=Bid.pdf";
    const results = [
      await fetchIt(
        deps(async () => response(404, null)),
        url,
      ),
      await fetchIt(
        deps(async () => Promise.reject(new Error(`connect failed for ${url}`))),
        url,
      ),
      await fetchIt(
        deps(async () => response(200, chunks("x"), { "content-length": "999999999999" })),
        url,
      ),
      await fetchIt(
        deps(async () => response(302, null, { location: `https://evil.example.com/?${url}` })),
        url,
      ),
      await fetchIt(
        deps(vi.fn<Transport>(), async () => ["10.0.0.1"]),
        url,
      ),
    ];
    for (const r of results) {
      if (r.ok) throw new Error("expected a failure");
      expect(r.message).not.toContain("SECRETTOKEN");
      expect(r.message).not.toContain("blobName");
      expect(r.message).not.toContain("evil.example.com");
    }
  });
});
