import { describe, expect, it } from "vitest";
import { extractLinks, pickLink } from "../e2e/helpers/mailbox";

describe("extractLinks", () => {
  it("reads href values from HTML and decodes entities", () => {
    const html = `<p>Follow this link:</p><p><a href="http://127.0.0.1:56321/auth/v1/verify?token=abc&amp;type=signup&amp;redirect_to=http://127.0.0.1:3100/auth/callback%3Fnext%3D%252Fonboarding">Confirm</a></p>`;
    expect(extractLinks({ html, text: "" })).toEqual([
      "http://127.0.0.1:56321/auth/v1/verify?token=abc&type=signup&redirect_to=http://127.0.0.1:3100/auth/callback%3Fnext%3D%252Fonboarding",
    ]);
  });

  it("falls back to bare URLs in the text part and drops trailing punctuation", () => {
    expect(extractLinks({ html: "", text: "Open https://app.tenderos.example/auth/confirm?token_hash=xyz&type=email. Thanks!" })).toEqual([
      "https://app.tenderos.example/auth/confirm?token_hash=xyz&type=email",
    ]);
  });

  it("lists each link once", () => {
    const html = `<a href="https://a.example/x">one</a> <a href="https://a.example/x">two</a>`;
    expect(extractLinks({ html, text: "https://a.example/x" })).toEqual(["https://a.example/x"]);
  });
});

describe("pickLink", () => {
  const mail = { html: `<a href="https://a.example/unsubscribe">u</a><a href="https://a.example/auth/confirm?token_hash=1">c</a>`, text: "" };

  it("returns the first link matching the pattern", () => {
    expect(pickLink(mail, /\/auth\/(confirm|v1\/verify)/)).toBe("https://a.example/auth/confirm?token_hash=1");
  });

  it("throws, naming what it found, when nothing matches", () => {
    expect(() => pickLink(mail, /nothing/)).toThrow(/unsubscribe/);
  });

  it("can rewrite the origin so a link opens against the server under test", () => {
    expect(pickLink(mail, /confirm/, { origin: "http://127.0.0.1:3100" })).toBe("http://127.0.0.1:3100/auth/confirm?token_hash=1");
  });
});
