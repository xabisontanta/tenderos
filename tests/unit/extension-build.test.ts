import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { assertSafeManifest, buildExtension, buildManifest, configSource, distReadme, resolveBuildConfig } from "@/scripts/build-extension.mjs";

const SOURCE = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../extension/manifest.json"), "utf8"));
const env = (over: Record<string, string | undefined> = {}) => ({ ...over });

describe("resolveBuildConfig", () => {
  it("defaults to the hosted TenderOS and the eTenders portal", () => {
    const c = resolveBuildConfig(env());
    expect(c).toEqual({ origin: "https://tenderos-six.vercel.app", dev: false, portalHosts: ["www.etenders.gov.za", "etenders.gov.za"] });
  });

  it("takes the configured origin and normalises it", () => {
    expect(resolveBuildConfig(env({ TENDEROS_ORIGIN: "https://app.example.co.za/" })).origin).toBe("https://app.example.co.za");
    expect(resolveBuildConfig(env({ TENDEROS_ORIGIN: "HTTPS://App.Example.co.za" })).origin).toBe("https://app.example.co.za");
  });

  it("makes a dev build only for http://localhost", () => {
    const dev = resolveBuildConfig(env({ TENDEROS_ORIGIN: "http://localhost:3000" }));
    expect(dev).toMatchObject({ origin: "http://localhost:3000", dev: true });
    expect(resolveBuildConfig(env({ TENDEROS_ORIGIN: "https://app.example.co.za" })).dev).toBe(false);
  });

  it("refuses origins a production helper must never talk to", () => {
    for (const bad of [
      "http://app.example.co.za",
      "ftp://app.example.co.za",
      "https://user:pw@app.example.co.za",
      "https://app.example.co.za/settings",
      "https://app.example.co.za?x=1",
      "https://*.example.co.za",
      "https://192.168.0.2",
      "not a url",
      "",
      "http://localhost.evil.com",
      "http://127.0.0.1:3000",
    ]) {
      expect(() => resolveBuildConfig(env({ TENDEROS_ORIGIN: bad })), bad).toThrow();
    }
  });

  it("takes portal hosts as exact host names, never wildcards", () => {
    expect(resolveBuildConfig(env({ TENDEROS_PORTAL_HOSTS: "portal.joburg.org.za, Tenders.Example.gov.za" })).portalHosts).toEqual([
      "portal.joburg.org.za",
      "tenders.example.gov.za",
    ]);
    for (const bad of ["*.gov.za", "*", "https://portal.example.gov.za", "portal.example.gov.za/path", "localhost", "10.0.0.1", "intranet", "exa mple.com"]) {
      expect(() => resolveBuildConfig(env({ TENDEROS_PORTAL_HOSTS: bad })), bad).toThrow();
    }
  });
});

describe("buildManifest", () => {
  it("points everything at the configured origin and lists the portals by exact host", () => {
    const m = buildManifest(SOURCE, resolveBuildConfig(env({ TENDEROS_ORIGIN: "https://app.example.co.za", TENDEROS_PORTAL_HOSTS: "portal.example.gov.za" })));
    expect(m.host_permissions).toEqual(["https://app.example.co.za/*", "https://portal.example.gov.za/*"]);
    expect(m.content_scripts[0].matches).toEqual(["https://app.example.co.za/*"]);
    expect(m.web_accessible_resources[0].matches).toEqual(["https://app.example.co.za/*"]);
    expect(m.optional_host_permissions).toBeUndefined();
    expect(m.permissions).toEqual(["activeTab", "scripting", "storage"]);
    expect(m.name).toBe("TenderOS browser helper");
  });

  it("adds localhost only to a dev build, and says so in its name", () => {
    const m = buildManifest(SOURCE, resolveBuildConfig(env({ TENDEROS_ORIGIN: "http://localhost:3000" })));
    expect(m.host_permissions).toContain("http://localhost:3000/*");
    expect(m.host_permissions).toContain("http://localhost/*");
    expect(m.name).toMatch(/dev/i);
    const prod = buildManifest(SOURCE, resolveBuildConfig(env()));
    expect(JSON.stringify(prod)).not.toContain("localhost");
    expect(prod.name).not.toMatch(/dev/i);
  });

  it("does not change the source manifest it was given", () => {
    const copy = JSON.parse(JSON.stringify(SOURCE));
    buildManifest(SOURCE, resolveBuildConfig(env({ TENDEROS_ORIGIN: "https://app.example.co.za" })));
    expect(SOURCE).toEqual(copy);
  });
});

describe("assertSafeManifest", () => {
  const good = () => buildManifest(SOURCE, resolveBuildConfig(env()));

  it("accepts the production manifest and the dev manifest", () => {
    expect(() => assertSafeManifest(good())).not.toThrow();
    expect(() => assertSafeManifest(buildManifest(SOURCE, resolveBuildConfig(env({ TENDEROS_ORIGIN: "http://localhost:3000" }))))).not.toThrow();
  });

  it("rejects wildcard hosts, optional host permissions, localhost in production and extra permissions", () => {
    const withHosts = (hosts: string[]) => ({ ...good(), host_permissions: hosts });
    for (const hosts of [
      ["https://*/*"],
      ["*://*/*"],
      ["<all_urls>"],
      ["https://*.gov.za/*"],
      ["http://localhost/*"],
      ["http://www.etenders.gov.za/*"],
      ["https://tenderos-six.vercel.app/*", "https://192.168.0.1/*"],
    ]) {
      expect(() => assertSafeManifest(withHosts(hosts)), hosts.join()).toThrow();
    }
    expect(() => assertSafeManifest({ ...good(), optional_host_permissions: ["https://*/*"] })).toThrow();
    expect(() => assertSafeManifest({ ...good(), permissions: ["activeTab", "scripting", "storage", "tabs"] })).toThrow();
    expect(() => assertSafeManifest({ ...good(), permissions: ["activeTab", "scripting", "storage", "webRequest"] })).toThrow();
    expect(() => assertSafeManifest({ ...good(), content_scripts: [{ matches: ["https://*/*"], js: ["src/bridge.js"] }] })).toThrow();
    expect(() => assertSafeManifest({ ...good(), externally_connectable: { matches: ["https://*/*"] } })).toThrow();
  });
});

describe("generated files", () => {
  it("writes the origin and dev flag into config.js", () => {
    const c = configSource(resolveBuildConfig(env({ TENDEROS_ORIGIN: "https://app.example.co.za" })));
    expect(c).toContain('export const TENDEROS_ORIGIN = "https://app.example.co.za";');
    expect(c).toContain("export const DEV_BUILD = false;");
    expect(configSource(resolveBuildConfig(env({ TENDEROS_ORIGIN: "http://localhost:3000" })))).toContain("export const DEV_BUILD = true;");
  });

  it("explains the four install steps and the Chrome Web Store path", () => {
    const text = distReadme(resolveBuildConfig(env()));
    for (const step of ["1.", "2.", "3.", "4."]) expect(text).toContain(step);
    expect(text).toMatch(/Load unpacked/);
    expect(text).toMatch(/Developer mode/);
    expect(text).toMatch(/chrome:\/\/extensions/);
    expect(text).toMatch(/edge:\/\/extensions/);
    expect(text).toMatch(/Chrome Web Store/);
    expect(text).toMatch(/Connect browser/);
    expect(text).toContain("https://tenderos-six.vercel.app");
  });
});

describe("buildExtension", () => {
  it("produces a loadable folder with the rewritten manifest, config and readme, and no tests or stray files", () => {
    const out = mkdtempSync(path.join(tmpdir(), "tenderos-ext-"));
    try {
      buildExtension({ srcDir: path.resolve(import.meta.dirname, "../../extension"), outDir: out, env: env({ TENDEROS_ORIGIN: "https://app.example.co.za" }) });
      const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
      expect(manifest.host_permissions[0]).toBe("https://app.example.co.za/*");
      expect(readFileSync(path.join(out, "src/config.js"), "utf8")).toContain('"https://app.example.co.za"');
      expect(readFileSync(path.join(out, "README.md"), "utf8")).toContain("Load unpacked");
      for (const f of [
        "src/background.js",
        "src/bridge.js",
        "src/bridge-main.js",
        "src/content.js",
        "src/panel.js",
        "src/match.js",
        "popup/popup.html",
        "popup/popup.js",
      ]) {
        expect(existsSync(path.join(out, f)), f).toBe(true);
      }
      expect(readdirSync(out).sort()).toEqual(["README.md", "manifest.json", "popup", "src"]);
      // Every file the manifest names exists in the build.
      expect(existsSync(path.join(out, manifest.background.service_worker))).toBe(true);
      expect(existsSync(path.join(out, manifest.action.default_popup))).toBe(true);
      for (const cs of manifest.content_scripts) for (const js of cs.js) expect(existsSync(path.join(out, js)), js).toBe(true);
      for (const w of manifest.web_accessible_resources) for (const r of w.resources) expect(existsSync(path.join(out, r)), r).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("refuses to build into the source folder", () => {
    const src = path.resolve(import.meta.dirname, "../../extension");
    expect(() => buildExtension({ srcDir: src, outDir: src, env: env() })).toThrow();
    expect(() => buildExtension({ srcDir: src, outDir: path.join(src, "src"), env: env() })).toThrow();
  });
});
