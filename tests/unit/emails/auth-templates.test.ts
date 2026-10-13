import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAuthTemplates } from "@/emails/build";
import { AUTH_LINK_EXPIRY, AUTH_TEMPLATES } from "@/emails";
import { resolveBrand } from "@/emails/brand";
import { isSafeHref } from "@/emails/layout";

const root = path.resolve(import.meta.dirname, "../../..");
const built = buildAuthTemplates(resolveBrand(process.env));

/** What each Supabase email must contain, from https://supabase.com/docs/guides/auth/auth-email-templates. */
const REQUIRED: Record<string, string[]> = {
  // Sign-up confirmation and password reset link to the app's /auth/confirm route
  // with the token hash (docs/auth.md), so the link works in any browser.
  confirmation: ["{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=email&amp;next=/onboarding", "{{ .Email }}"],
  invite: ["{{ .ConfirmationURL }}", "{{ .Email }}"],
  magic_link: ["{{ .ConfirmationURL }}", "{{ .Email }}"],
  recovery: ["{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=recovery&amp;next=/reset-password", "{{ .Email }}"],
  email_change: ["{{ .ConfirmationURL }}", "{{ .Email }}", "{{ .NewEmail }}"],
  reauthentication: ["{{ .Token }}"],
  password_changed: [],
  email_changed: ["{{ .OldEmail }}", "{{ .Email }}"],
  phone_changed: ["{{ .OldPhone }}", "{{ .Phone }}"],
  mfa_factor_enrolled: ["{{ .FactorType }}"],
  mfa_factor_unenrolled: ["{{ .FactorType }}"],
  identity_linked: ["{{ .Provider }}", "{{ .Email }}"],
  identity_unlinked: ["{{ .Provider }}", "{{ .Email }}"],
};

describe("the set of Supabase emails", () => {
  it("covers every authentication template and every security notification Supabase CLI 2.120 supports", () => {
    expect(
      AUTH_TEMPLATES.filter((s) => s.kind === "template")
        .map((s) => s.key)
        .sort(),
    ).toEqual(["confirmation", "email_change", "invite", "magic_link", "reauthentication", "recovery"].sort());
    expect(
      AUTH_TEMPLATES.filter((s) => s.kind === "notification")
        .map((s) => s.key)
        .sort(),
    ).toEqual(
      ["email_changed", "identity_linked", "identity_unlinked", "mfa_factor_enrolled", "mfa_factor_unenrolled", "password_changed", "phone_changed"].sort(),
    );
  });

  it("names each output file the way the Supabase scaffold does", () => {
    for (const s of AUTH_TEMPLATES) {
      expect(s.file).toBe(s.kind === "template" ? `${s.key}.html` : `${s.key}_notification.html`);
    }
  });
});

describe.each(AUTH_TEMPLATES.map((s) => [s.key, s] as const))("%s", (key, spec) => {
  const out = built.find((b) => b.key === key)!;
  const html = out.html;

  it("has a subject that is non-empty and shorter than 78 characters", () => {
    expect(spec.subject.trim()).not.toBe("");
    expect(spec.subject.length).toBeLessThan(78);
    expect(spec.subject).not.toMatch(/[\r\n]/);
  });

  it("carries its required placeholders", () => {
    for (const placeholder of REQUIRED[key]) expect(html).toContain(placeholder);
  });

  it("uses only Go-template actions Supabase provides for this email", () => {
    const actions = html.match(/\{\{[\s\S]*?\}\}/g) ?? [];
    const allowed = new Set(spec.variables);
    let depth = 0;
    for (const action of actions) {
      const inner = action.slice(2, -2).trim();
      if (/^\.[A-Za-z]+$/.test(inner)) {
        expect(allowed, `${action} is not available in ${key}`).toContain(inner.slice(1));
      } else if (/^(else )?if eq \.[A-Za-z]+ "[a-z_]+"$/.test(inner)) {
        const variable = inner.match(/\.([A-Za-z]+)/)![1];
        expect(allowed).toContain(variable);
        if (inner.startsWith("if")) depth++;
      } else if (inner === "else") {
        expect(depth).toBeGreaterThan(0);
      } else if (inner === "end") {
        depth--;
      } else {
        throw new Error(`Unexpected template action ${action} in ${key}`);
      }
    }
    expect(depth).toBe(0);
  });

  it("never interpolates user-controlled metadata (.Data) into the email", () => {
    expect(html).not.toMatch(/\{\{[^}]*\.Data\b/);
    expect(html).not.toMatch(/\{\{[^}]*\.RedirectTo\b/);
  });

  it("is built from presentation tables with inline styles on every critical element", () => {
    expect(html).toContain('role="presentation"');
    expect((html.match(/<table\b/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(html).not.toMatch(/display:\s*(flex|grid)/);
    for (const tag of ["p", "h1", "ul", "img"]) {
      for (const o of html.match(new RegExp(`<${tag}\\b[^>]*>`, "g")) ?? []) expect(o, `${key}: <${tag}> without inline style`).toMatch(/style="/);
    }
    for (const a of html.match(/<a\b[^>]*>/g) ?? []) expect(a).toMatch(/style="/);
  });

  it("loads nothing external: no scripts, stylesheets, web fonts or imports", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import|@font-face|fonts\.googleapis/i);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
  });

  it("stays well under Gmail's 102 KB clipping limit", () => {
    expect(Buffer.byteLength(html, "utf8")).toBeLessThan(90 * 1024);
  });

  it("gives every image alt, width and height and serves it from the site", () => {
    const imgs = html.match(/<img\b[^>]*>/g) ?? [];
    expect(imgs.length).toBeGreaterThanOrEqual(2);
    for (const img of imgs) {
      expect(img).toMatch(/\balt="[^"]*"/);
      expect(img).toMatch(/\bwidth="\d+"/);
      expect(img).toMatch(/\bheight="\d+"/);
      expect(img).toMatch(/\bsrc="\{\{ \.SiteURL \}\}\/email\/[a-z0-9@-]+\.png"/);
    }
  });

  it("has a hidden preheader before the visible content", () => {
    const m = html.match(/<body[^>]*>\s*<div style="display:none[^"]*">([^<]+)<\/div>/);
    expect(m?.[1].trim().length ?? 0).toBeGreaterThan(20);
  });

  it("only links over https or through Supabase placeholders", () => {
    const withoutNamespaces = html.replace(/xmlns(:\w+)?="[^"]*"/g, "");
    expect(withoutNamespaces).not.toMatch(/http:\/\//);
    for (const [, href] of html.matchAll(/\bhref="([^"]*)"/g)) {
      expect(isSafeHref(href.replace(/&amp;/g, "&"))).toBe(true);
    }
  });

  it("tells the reader what to do if it was not them", () => {
    expect(html).toMatch(/(didn|wasn|weren)&#39;t/i);
  });

  it("renders every image it references from public/email", () => {
    for (const [, file] of html.matchAll(/\{\{ \.SiteURL \}\}\/email\/([a-z0-9@-]+\.png)/g)) {
      expect(existsSync(path.join(root, "public/email", file)), `public/email/${file} is missing`).toBe(true);
    }
  });
});

describe("link and code expiry copy", () => {
  it("states the expiry that supabase/config.toml sets (otp_expiry)", () => {
    const toml = readFileSync(path.join(root, "supabase/config.toml"), "utf8");
    const seconds = Number(toml.match(/^otp_expiry\s*=\s*(\d+)/m)?.[1]);
    expect(seconds, "update AUTH_LINK_EXPIRY in emails/templates/shared.ts to match otp_expiry").toBe(AUTH_LINK_EXPIRY.seconds);
  });

  it("repeats that expiry on every email that carries a link or a code", () => {
    for (const key of ["confirmation", "magic_link", "recovery", "email_change", "reauthentication"]) {
      expect(built.find((b) => b.key === key)!.html, key).toContain(AUTH_LINK_EXPIRY.label);
    }
  });
});

describe("supabase/config.toml and the committed templates", () => {
  const toml = readFileSync(path.join(root, "supabase/config.toml"), "utf8");

  it.each(AUTH_TEMPLATES.map((s) => [s.key, s] as const))("wires %s to its subject and file", (_key, spec) => {
    const header = `[auth.email.${spec.kind}.${spec.key}]`;
    const start = toml.indexOf(header);
    expect(start, `${header} missing from supabase/config.toml`).toBeGreaterThanOrEqual(0);
    const rest = toml.slice(start + header.length);
    const block = rest.slice(0, rest.search(/\n\[/) === -1 ? undefined : rest.search(/\n\[/));
    expect(block).toContain(`subject = ${JSON.stringify(spec.subject)}`);
    expect(block).toContain(`content_path = "./supabase/templates/${spec.file}"`);
    if (spec.kind === "notification") expect(block).toMatch(/enabled = true/);
  });

  it.each(built.map((b) => [b.file, b] as const))("keeps supabase/templates/%s in step with the source", (file, out) => {
    const onDisk = readFileSync(path.join(root, "supabase/templates", file), "utf8");
    expect(onDisk, "run npm run build:emails and commit the result").toBe(out.html);
  });
});
