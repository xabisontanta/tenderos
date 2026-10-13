import { afterEach, describe, expect, it, vi } from "vitest";
import { TENDEROS_ORIGIN } from "@/extension/src/config.js";
import { fetchApplyPlan, fetchDocument, fetchPayload, postApplyReport, verifyPairing } from "@/extension/src/api.js";
import { HelperError } from "@/extension/src/errors.js";

const TOKEN = `tos_${"d4".repeat(32)}`;
const TENDER = "3f9c2f4e-6a0b-4d6e-9a43-0b7f6f0d2c11";
const settings = { server: TENDEROS_ORIGIN, token: TOKEN };

function stubFetch(response: Response | (() => Response) | Error) {
  const fn = vi.fn(async (..._args: unknown[]) => {
    if (response instanceof Error) throw response;
    return typeof response === "function" ? response() : response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

async function failure(promise: Promise<unknown>): Promise<HelperError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HelperError);
    return err as HelperError;
  }
  throw new Error("expected a HelperError");
}

describe("requests to TenderOS", () => {
  it("send the code only as a bearer header, with no cookies, no caching and no redirects", async () => {
    const fetchMock = stubFetch(jsonResponse({ profile: {}, documents: [], bids: [] }));
    await fetchPayload(settings);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${TENDEROS_ORIGIN}/api/autofill/profile`);
    expect(init).toMatchObject({ credentials: "omit", cache: "no-store", redirect: "manual", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(url).not.toContain(TOKEN);
  });

  it("refuse to send the code to any other origin", async () => {
    const fetchMock = stubFetch(jsonResponse({}));
    for (const server of [
      "https://evil.example",
      "http://tenderos-six.vercel.app",
      `${TENDEROS_ORIGIN}.evil.example`,
      "https://tenderos-six.vercel.app@evil.example",
    ]) {
      await failure(fetchPayload({ server, token: TOKEN }));
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuse a request without a code, with a plain message", async () => {
    const fetchMock = stubFetch(jsonResponse({}));
    const err = await failure(fetchPayload({ server: TENDEROS_ORIGIN, token: null }));
    expect(err.code).toBe("unauthorized");
    expect(err.message).toMatch(/connect/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turn each kind of failure into a message that says what to do, without the code in it", async () => {
    const cases: Array<[Response | Error, string, RegExp]> = [
      [new Response("", { status: 401 }), "unauthorized", /connect the browser again/i],
      [new Response("", { status: 429 }), "rate_limited", /wait/i],
      [jsonResponse({ error: "This tender has no approved bid waiting for delivery." }, 409), "conflict", /no approved bid/i],
      [jsonResponse({ error: "TenderOS does not hold a usable web address." }, 422), "unprocessable", /web address/i],
      [jsonResponse({ error: "Tender not found" }, 404), "not_found", /not found/i],
      [new Response("", { status: 500 }), "server", /error \(500\)/i],
      [new Response("", { status: 302, headers: { location: "https://tenderos-six.vercel.app/login" } }), "invalid_response", /sign-in/i],
      [new TypeError("Failed to fetch"), "network", /could not reach/i],
    ];
    for (const [response, code, message] of cases) {
      stubFetch(response);
      const err = await failure(fetchApplyPlan(settings, TENDER, false));
      expect(err.code, String(code)).toBe(code);
      expect(err.message).toMatch(message);
      expect(err.message).not.toContain(TOKEN);
    }
  });

  it("do not show a server-supplied message that is not plain text", async () => {
    stubFetch(jsonResponse({ error: "x".repeat(2000) }, 409));
    const err = await failure(fetchApplyPlan(settings, TENDER, false));
    expect(err.message.length).toBeLessThan(400);
  });
});

describe("fetchApplyPlan", () => {
  it("asks for the plan of one tender, and for personal documents only when told to", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ version: 1 }));
    await fetchApplyPlan(settings, TENDER, false);
    await fetchApplyPlan(settings, TENDER, true);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`${TENDEROS_ORIGIN}/api/autofill/tenders/${TENDER}/apply-plan`);
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe(`${TENDEROS_ORIGIN}/api/autofill/tenders/${TENDER}/apply-plan?sensitive=1`);
  });

  it("refuses an id that is not a uuid before making any request", async () => {
    const fetchMock = stubFetch(jsonResponse({}));
    await failure(fetchApplyPlan(settings, "../../profile", false));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("insists on a JSON answer", async () => {
    stubFetch(new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect((await failure(fetchApplyPlan(settings, TENDER, false))).code).toBe("invalid_response");
  });
});

describe("postApplyReport", () => {
  it("posts the counts as JSON to the tender's report address", async () => {
    const fetchMock = stubFetch(jsonResponse({ ok: true }));
    const body = { host: "www.etenders.gov.za", fields: 9, documents: 2, left: 4, sensitive: false, confirmed_host: false };
    await postApplyReport(settings, TENDER, body);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${TENDEROS_ORIGIN}/api/autofill/tenders/${TENDER}/apply-report`);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "manual",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(init.body))).toEqual(body);
  });
});

describe("fetchDocument", () => {
  it("returns the bytes as base64 with their size and type", async () => {
    stubFetch(new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { "content-type": "application/pdf" } }));
    expect(await fetchDocument(settings, TENDER)).toEqual({ base64: "JVBERg==", size: 4, type: "application/pdf" });
  });

  it("maps a missing document to not_found so the fill can say it was removed", async () => {
    stubFetch(jsonResponse({ error: "Document not found" }, 404));
    expect((await failure(fetchDocument(settings, TENDER))).code).toBe("not_found");
  });
});

describe("verifyPairing", () => {
  it("checks a new code against the profile and returns who it belongs to", async () => {
    const fetchMock = stubFetch(jsonResponse({ organisation: { name: "Acme (Pty) Ltd" }, member: { role: "admin" }, profile: {}, documents: [], bids: [] }));
    expect(await verifyPairing(TENDEROS_ORIGIN, TOKEN)).toEqual({ organisation: "Acme (Pty) Ltd", role: "admin" });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`${TENDEROS_ORIGIN}/api/autofill/profile`);
  });

  it("reports a refused code as unauthorized", async () => {
    stubFetch(new Response("", { status: 401 }));
    expect((await failure(verifyPairing(TENDEROS_ORIGIN, TOKEN))).code).toBe("unauthorized");
  });
});
