import { describe, expect, it } from "vitest";
import { compareHosts, evaluateTarget, isLocalhost, parsePortalUrl, registrableDomain } from "@/extension/src/hosts.js";

describe("registrableDomain", () => {
  it("keeps the registrable part of ordinary and South African hosts", () => {
    expect(registrableDomain("www.etenders.gov.za")).toBe("etenders.gov.za");
    expect(registrableDomain("etenders.gov.za")).toBe("etenders.gov.za");
    expect(registrableDomain("secure.csd.gov.za")).toBe("csd.gov.za");
    expect(registrableDomain("tenders.joburg.org.za")).toBe("joburg.org.za");
    expect(registrableDomain("portal.example.co.za")).toBe("example.co.za");
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
    expect(registrableDomain("example.com")).toBe("example.com");
  });

  it("does not let sibling registrations under a public suffix count as one site", () => {
    expect(registrableDomain("good.co.za")).not.toBe(registrableDomain("evil.co.za"));
    expect(registrableDomain("one.gov.za")).not.toBe(registrableDomain("two.gov.za"));
    // Generic second-level labels under a country code are treated as suffixes too, even when not listed.
    expect(registrableDomain("good.co.xx")).toBe("good.co.xx");
    expect(registrableDomain("good.co.xx")).not.toBe(registrableDomain("evil.co.xx"));
  });

  it("is case-insensitive, ignores a trailing dot and returns IP literals and localhost unchanged", () => {
    expect(registrableDomain("WWW.ETenders.GOV.za.")).toBe("etenders.gov.za");
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("isLocalhost", () => {
  it("recognises only loopback names", () => {
    expect(isLocalhost("localhost")).toBe(true);
    expect(isLocalhost("127.0.0.1")).toBe(true);
    expect(isLocalhost("app.localhost")).toBe(true);
    expect(isLocalhost("localhost.evil.com")).toBe(false);
    expect(isLocalhost("127.0.0.2")).toBe(false);
    expect(isLocalhost("notlocalhost")).toBe(false);
  });
});

describe("compareHosts", () => {
  it("separates the same host, the same site and different sites", () => {
    expect(compareHosts("www.etenders.gov.za", "www.etenders.gov.za")).toBe("same_host");
    expect(compareHosts("www.etenders.gov.za", "secure.etenders.gov.za")).toBe("same_site");
    expect(compareHosts("www.etenders.gov.za", "etenders.gov.za")).toBe("same_site");
    expect(compareHosts("www.etenders.gov.za", "etenders.gov.za.evil.com")).toBe("different");
    expect(compareHosts("www.etenders.gov.za", "evil-etenders.gov.za")).toBe("different");
    expect(compareHosts("good.co.za", "evil.co.za")).toBe("different");
  });
});

describe("parsePortalUrl", () => {
  it("accepts a plain https portal address and reports its host", () => {
    const r = parsePortalUrl("https://www.etenders.gov.za/Home/opportunities?id=1");
    expect(r).toMatchObject({ ok: true, host: "www.etenders.gov.za", origin: "https://www.etenders.gov.za" });
  });

  it("refuses http, other schemes, credentials, IP addresses and hostless addresses", () => {
    for (const bad of [
      "http://www.etenders.gov.za/",
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///C:/x.html",
      "ftp://example.com/",
      "https://user:pass@www.etenders.gov.za/",
      "https://192.168.0.1/portal",
      "https://[2001:db8::1]/portal",
      "https://localhost/portal",
      "https://intranet/portal",
      "not a url",
      "",
      "https://" + "a".repeat(300) + ".com/",
    ]) {
      expect(parsePortalUrl(bad).ok, bad).toBe(false);
    }
    expect(parsePortalUrl("x".repeat(3000)).ok).toBe(false);
    expect(parsePortalUrl(undefined as unknown as string).ok).toBe(false);
  });

  it("allows http and https on localhost only when the build allows it", () => {
    expect(parsePortalUrl("http://localhost:4000/portal").ok).toBe(false);
    expect(parsePortalUrl("http://localhost:4000/portal", { allowLocalhost: true })).toMatchObject({ ok: true, host: "localhost" });
    expect(parsePortalUrl("http://127.0.0.1:4000/", { allowLocalhost: true }).ok).toBe(true);
    // The allowance never extends to other http hosts.
    expect(parsePortalUrl("http://www.etenders.gov.za/", { allowLocalhost: true }).ok).toBe(false);
    expect(parsePortalUrl("http://localhost.evil.com/", { allowLocalhost: true }).ok).toBe(false);
  });
});

describe("evaluateTarget", () => {
  const expectedHost = "www.etenders.gov.za";

  it("fills when the tab is on the expected host or the same site", () => {
    expect(evaluateTarget({ expectedHost, tabUrl: "https://www.etenders.gov.za/Home/Bid" }).decision).toBe("match");
    expect(evaluateTarget({ expectedHost, tabUrl: "https://secure.etenders.gov.za/login" }).decision).toBe("match");
  });

  it("asks for a confirmation naming both hosts when the site differs", () => {
    const r = evaluateTarget({ expectedHost, tabUrl: "https://login.example.com/start" });
    expect(r).toEqual({ decision: "confirm", expectedHost, tabHost: "login.example.com" });
    expect(evaluateTarget({ expectedHost, tabUrl: "https://etenders.gov.za.evil.com/" }).decision).toBe("confirm");
  });

  it("refuses pages that are not https, are unreadable or are the browser's own", () => {
    for (const tabUrl of ["http://www.etenders.gov.za/", "chrome://extensions", "file:///C:/x.html", "about:blank", "", undefined, "garbage"]) {
      const r = evaluateTarget({ expectedHost, tabUrl });
      expect(r.decision, String(tabUrl)).toBe("refuse");
    }
  });

  it("allows localhost only when the build allows it, and then only to localhost", () => {
    expect(evaluateTarget({ expectedHost: "localhost", tabUrl: "http://localhost:4000/form" }).decision).toBe("refuse");
    expect(evaluateTarget({ expectedHost: "localhost", tabUrl: "http://localhost:4000/form", allowLocalhost: true }).decision).toBe("match");
    expect(evaluateTarget({ expectedHost, tabUrl: "http://localhost:4000/form", allowLocalhost: true }).decision).toBe("confirm");
  });
});
