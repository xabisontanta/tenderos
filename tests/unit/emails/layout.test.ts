import { describe, expect, it } from "vitest";
import { resolveBrand, unresolvedPlaceholders } from "@/emails/brand";
import {
  CONTRAST_PAIRS,
  appContext,
  contrastRatio,
  escapeHtml,
  isSafeHref,
  renderEmail,
  sanitizeSubject,
  supabaseContext,
  type EmailContent,
} from "@/emails/layout";

const brand = resolveBrand({});
const sample: EmailContent = {
  title: "Confirm your email address",
  preheader: "One click to verify your address.",
  eyebrow: { label: "Account", icon: "mail-check" },
  headline: "Confirm your email address",
  blocks: [
    { type: "p", text: ["Confirm ", { strong: "{{ .Email }}" }, " to continue."] },
    { type: "button", label: "Confirm email address", href: "{{ .ConfirmationURL }}", note: "Works once and expires in 1 hour." },
    { type: "linkFallback", href: "{{ .ConfirmationURL }}" },
    { type: "safety", title: "Didn't ask for this?", body: "Ignore this email." },
  ],
  reason: "you signed up for TenderOS",
};

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;");
  });
});

describe("isSafeHref", () => {
  it.each(["https://app.example.co.za/a?b=1&c=2", "{{ .ConfirmationURL }}", "{{ .SiteURL }}/privacy", "mailto:help@example.co.za"])("accepts %s", (href) =>
    expect(isSafeHref(href)).toBe(true),
  );
  it.each(["javascript:alert(1)", "data:text/html;base64,AAAA", "//evil.example", "http://evil.example/x", "ftp://x", "", "  https://x.example"])("rejects %s", (href) =>
    expect(isSafeHref(href)).toBe(false),
  );
  it("allows http only for local development hosts when asked", () => {
    expect(isSafeHref("http://localhost:3000/x")).toBe(false);
    expect(isSafeHref("http://localhost:3000/x", { allowLocalHttp: true })).toBe(true);
    expect(isSafeHref("http://127.0.0.1:3000/x", { allowLocalHttp: true })).toBe(true);
    expect(isSafeHref("http://evil.example/x", { allowLocalHttp: true })).toBe(false);
  });
});

describe("sanitizeSubject", () => {
  it("removes line breaks so a name cannot inject headers", () => {
    expect(sanitizeSubject("Hi\r\nBcc: evil@example.com")).toBe("Hi Bcc: evil@example.com");
  });
  it("clamps to 78 characters with an ellipsis", () => {
    const out = sanitizeSubject("x".repeat(200));
    expect(out.length).toBe(78);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("renderEmail shell", () => {
  const { html, text } = renderEmail(sample, supabaseContext(brand));

  it("is a complete HTML5 document in South African English with both colour schemes declared", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('lang="en-ZA"');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('<meta name="supported-color-schemes" content="light dark">');
    expect(html).toContain('<meta name="viewport"');
  });

  it("has a hidden preheader that carries the preview text", () => {
    expect(html).toMatch(/<div[^>]*display:none[^>]*mso-hide:all[^>]*>One click to verify your address\./);
  });

  it("lays out with presentation tables, a 600px container and inline styles", () => {
    expect(html).toContain('role="presentation"');
    expect(html).toMatch(/max-width:600px/);
    expect(html).toMatch(/width="600"/);
    expect(html).not.toMatch(/<(div|p|h1)[^>]*display:flex/);
    expect(html).toMatch(/<h1[^>]*style="[^"]*font-size:28px/);
  });

  it("has dark mode and mobile rules in one inline style block and nothing external", () => {
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain("@media (max-width: 620px)");
    expect(html).toContain("[data-ogsc]");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import|@font-face/);
    expect(html).not.toMatch(/<style[^>]*src=/i);
    expect((html.match(/<style/g) ?? []).length).toBe(1);
  });

  it("draws the 4px cyan to violet accent bar on the card", () => {
    expect(html).toMatch(/height:4px[^"]*linear-gradient\(90deg,#50d9ef[^"]*#7575e9/);
  });

  it("uses a bulletproof button with a VML fallback for Outlook", () => {
    expect(html).toContain("<v:roundrect");
    expect(html).toContain('href="{{ .ConfirmationURL }}"');
    expect(html).toContain("Confirm email address");
    expect(html).toContain("<w:anchorlock/>");
  });

  it("references brand images through the asset base with explicit size and alt", () => {
    const imgs = html.match(/<img\b[^>]*>/g) ?? [];
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      expect(img).toMatch(/\balt="/);
      expect(img).toMatch(/\bwidth="\d+"/);
      expect(img).toMatch(/\bheight="\d+"/);
      expect(img).toMatch(/src="\{\{ \.SiteURL \}\}\/email\/[a-z0-9@-]+\.png"/);
    }
  });

  it("swaps the logo for dark mode", () => {
    expect(html).toContain("mark-light@2x.png");
    expect(html).toContain("mark-dark@2x.png");
  });

  it("names the product, links Help, Privacy and Terms, and carries the legal sender block", () => {
    expect(html).toContain("Tender operations command centre");
    expect(html).toContain('href="{{ .SiteURL }}/help"');
    expect(html).toContain('href="{{ .SiteURL }}/privacy"');
    expect(html).toContain('href="{{ .SiteURL }}/terms"');
    expect(html).toContain("[Registered company name]");
    expect(html).toContain("You are receiving this email because you signed up for TenderOS.");
  });

  it("produces a readable plain-text twin", () => {
    expect(text).toContain("Confirm your email address");
    expect(text).toContain("Confirm email address: {{ .ConfirmationURL }}");
    expect(text).toContain("Didn't ask for this?");
    expect(text).not.toMatch(/<[a-z]/i);
  });
});

describe("renderEmail safety", () => {
  it("escapes every interpolated string and refuses unsafe links", () => {
    const evil = `<script>alert(1)</script>"'`;
    const content: EmailContent = {
      ...sample,
      headline: evil,
      preheader: evil,
      eyebrow: { label: evil, icon: "mail-check" },
      blocks: [
        { type: "p", text: [evil, { strong: evil }] },
        { type: "details", rows: [{ label: evil, value: evil }] },
        { type: "notice", tone: "warning", title: evil, body: evil },
      ],
      reason: evil,
    };
    const { html } = renderEmail(content, appContext({ appUrl: "https://app.example.co.za", brand }));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(() => renderEmail({ ...sample, blocks: [{ type: "button", label: "x", href: "javascript:alert(1)" }] }, supabaseContext(brand))).toThrow(/unsafe link/i);
  });
});

describe("contexts", () => {
  it("builds Supabase contexts from the SiteURL placeholder", () => {
    const ctx = supabaseContext(brand);
    expect(ctx.assetBase).toBe("{{ .SiteURL }}");
    expect(ctx.siteUrl).toBe("{{ .SiteURL }}");
  });
  it("normalises the app URL and requires https in production", () => {
    expect(appContext({ appUrl: "https://app.example.co.za/", brand }).siteUrl).toBe("https://app.example.co.za");
    expect(() => appContext({ appUrl: "http://app.example.co.za", brand, production: true })).toThrow(/https/);
    expect(appContext({ appUrl: "http://localhost:3000", brand, production: false }).siteUrl).toBe("http://localhost:3000");
    expect(() => appContext({ appUrl: "", brand })).toThrow(/APP_URL/);
  });
  it("lets an asset base override keep links on SiteURL", () => {
    const ctx = supabaseContext(brand, { assetBase: "https://cdn.example.co.za" });
    expect(ctx.assetBase).toBe("https://cdn.example.co.za");
    expect(ctx.siteUrl).toBe("{{ .SiteURL }}");
  });
});

describe("accessibility of the palette", () => {
  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });
  it.each(CONTRAST_PAIRS.map((p) => [p.name, p] as const))("keeps %s at 4.5:1 or better", (_name, pair) => {
    expect(contrastRatio(pair.fg, pair.bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("brand", () => {
  it("falls back to visible placeholders for the legal sender block", () => {
    expect(unresolvedPlaceholders(brand)).toEqual(["legalName", "legalAddress", "registrationNumber", "supportEmail"]);
  });
  it("takes the legal block from the environment", () => {
    const b = resolveBrand({
      EMAIL_LEGAL_NAME: "Example (Pty) Ltd",
      EMAIL_LEGAL_ADDRESS: "1 Long Street, Cape Town, 8001",
      EMAIL_REGISTRATION_NUMBER: "2026/000000/07",
      EMAIL_SUPPORT_ADDRESS: "help@example.co.za",
    });
    expect(unresolvedPlaceholders(b)).toEqual([]);
    expect(b.legalName).toBe("Example (Pty) Ltd");
  });
});
