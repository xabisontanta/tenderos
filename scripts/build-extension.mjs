// Builds the TenderOS browser helper into extension/dist: a folder to "Load
// unpacked" in Chrome or Edge. No dependencies, no bundler: it copies the
// extension's plain JavaScript and rewrites three things for the TenderOS
// address you build for.
//
//   TENDEROS_ORIGIN        the TenderOS address, e.g. https://app.example.co.za
//                          (default https://tenderos-six.vercel.app). A build
//                          for http://localhost:3000 is a development build.
//   TENDEROS_PORTAL_HOSTS  comma-separated exact host names of the tender
//                          portals the helper may open and fill by itself
//                          (default www.etenders.gov.za,etenders.gov.za).
//                          No wildcards. Any other portal is filled from the
//                          toolbar button, on the page the person is looking at.
//
// What it rewrites: manifest.json (host permissions, the bridge content
// script's match, name), src/config.js (the origin and the dev flag) and a
// README.md with the install steps. It then checks the manifest against the
// safety rules and refuses to write one that breaks them: no wildcard hosts,
// no optional host permissions, no localhost outside a dev build.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ORIGIN = "https://tenderos-six.vercel.app";
const DEFAULT_PORTAL_HOSTS = ["www.etenders.gov.za", "etenders.gov.za"];
const ALLOWED_PERMISSIONS = ["activeTab", "scripting", "storage"];
const HOST_NAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/**
 * @typedef {{ origin: string, dev: boolean, portalHosts: string[] }} BuildConfig
 */

/** @param {string} host */
function isPlainHostName(host) {
  return HOST_NAME.test(host) && !/^\d+(\.\d+)+$/.test(host) && /[a-z]/.test(host.split(".").pop() ?? "") && host.length <= 253;
}

/**
 * Reads and validates the build settings.
 * @param {Record<string, string | undefined>} env
 * @returns {BuildConfig}
 */
export function resolveBuildConfig(env) {
  const raw = (env.TENDEROS_ORIGIN ?? DEFAULT_ORIGIN).trim();
  if (raw.includes("*")) throw new Error(`TENDEROS_ORIGIN must be one exact address, not a pattern: ${raw}`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`TENDEROS_ORIGIN is not a web address: "${raw}"`);
  }
  if (url.username || url.password) throw new Error("TENDEROS_ORIGIN must not contain a user name or password.");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash)
    throw new Error("TENDEROS_ORIGIN must be an address without a path, e.g. https://app.example.co.za");
  let dev = false;
  if (url.protocol === "http:") {
    if (url.hostname !== "localhost") throw new Error("TENDEROS_ORIGIN must be https (http is only allowed for http://localhost:3000, a development build).");
    dev = true;
  } else if (url.protocol === "https:") {
    if (!isPlainHostName(url.hostname)) throw new Error(`TENDEROS_ORIGIN must be a normal host name, not an IP address or an intranet name: ${url.hostname}`);
  } else {
    throw new Error(`TENDEROS_ORIGIN must start with https://: "${raw}"`);
  }

  const hostsRaw = env.TENDEROS_PORTAL_HOSTS;
  const portalHosts =
    hostsRaw === undefined || hostsRaw.trim() === ""
      ? [...DEFAULT_PORTAL_HOSTS]
      : hostsRaw
          .split(",")
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean);
  for (const h of portalHosts) {
    if (!isPlainHostName(h))
      throw new Error(`TENDEROS_PORTAL_HOSTS takes exact host names such as portal.example.gov.za (no wildcards, schemes, paths or IP addresses): "${h}"`);
  }
  return { origin: url.origin, dev, portalHosts: [...new Set(portalHosts)] };
}

/**
 * The manifest for a build: the source manifest with the configured origin and portals.
 * @param {Record<string, any>} base
 * @param {BuildConfig} config
 * @returns {Record<string, any>}
 */
export function buildManifest(base, config) {
  const m = JSON.parse(JSON.stringify(base));
  const origin = `${config.origin}/*`;
  m.host_permissions = [origin, ...config.portalHosts.map((h) => `https://${h}/*`), ...(config.dev ? ["http://localhost/*"] : [])];
  delete m.optional_host_permissions;
  if (m.content_scripts) for (const cs of m.content_scripts) cs.matches = [origin];
  if (m.web_accessible_resources) for (const w of m.web_accessible_resources) w.matches = [origin];
  if (config.dev) m.name = `${m.name} (dev)`;
  return m;
}

/**
 * The safety rules for the helper's manifest. Throws when one is broken.
 * @param {Record<string, any>} manifest
 */
export function assertSafeManifest(manifest) {
  const fail = (/** @type {string} */ why) => {
    throw new Error(`Unsafe extension manifest: ${why}`);
  };
  if (manifest.optional_host_permissions !== undefined) fail("optional_host_permissions are not allowed");
  if (manifest.optional_permissions !== undefined) fail("optional_permissions are not allowed");
  if (manifest.externally_connectable !== undefined) fail("externally_connectable is not allowed");
  for (const p of manifest.permissions ?? []) if (!ALLOWED_PERMISSIONS.includes(p)) fail(`permission "${p}" is not allowed`);
  const dev = /\(dev\)/.test(String(manifest.name));
  const hosts = manifest.host_permissions ?? [];
  if (hosts.length === 0) fail("no host permission for the TenderOS address");
  for (const h of hosts) {
    const m = /^(https?):\/\/([^/*:]+)(:\d+)?\/\*$/.exec(String(h));
    if (!m) fail(`host permission "${h}" must name one exact host`);
    const [, scheme, host] = /** @type {RegExpExecArray} */ (m);
    if (host === "localhost") {
      if (!dev) fail(`localhost ("${h}") is only allowed in a development build`);
    } else if (scheme !== "https" || !isPlainHostName(host ?? "")) {
      fail(`host permission "${h}" must be an https host name`);
    }
  }
  const origin = hosts[0];
  const only = (/** @type {string} */ what, /** @type {string[] | undefined} */ matches) => {
    for (const m of matches ?? []) if (m !== origin) fail(`${what} may only match the TenderOS address (found "${m}")`);
  };
  for (const cs of manifest.content_scripts ?? []) only("a content script", cs.matches);
  for (const w of manifest.web_accessible_resources ?? []) only("web_accessible_resources", w.matches);
}

/**
 * src/config.js for a build.
 * @param {BuildConfig} config
 */
export function configSource(config) {
  return `// @ts-check
// Generated by \`npm run build:extension\`. Do not edit: rebuild instead.

/** The only TenderOS address this helper sends the pairing code to. */
export const TENDEROS_ORIGIN = ${JSON.stringify(config.origin)};

/** Development builds may also fill portals on http://localhost. Never true in a production build. */
export const DEV_BUILD = ${config.dev ? "true" : "false"};
`;
}

/**
 * README.md placed in the built folder.
 * @param {BuildConfig} config
 */
export function distReadme(config) {
  return `# TenderOS browser helper${config.dev ? " (development build)" : ""}

Built for **${config.origin}**. It opens your tender portal from TenderOS, fills
your company's details and attaches your verified documents. **You check every
field and submit it yourself.** It never presses Submit, ticks a declaration,
enters a price or signs.

## Install in Chrome or Edge (4 steps)

1. Open \`chrome://extensions\` (in Edge: \`edge://extensions\`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder.
4. Pin **TenderOS browser helper** to the toolbar. Then, in TenderOS, open
   **Settings, Browser helper** and press **Connect browser**. There is no code
   to copy.

To apply for a tender, open it in TenderOS and press **Apply with TenderOS**.
The helper opens the portal in a new tab, fills what it can, attaches the
approved documents and shows a review panel of what is left for you.

## Which portals it opens by itself

${config.portalHosts.map((h) => `- ${h}`).join("\n")}

For any other portal, open it yourself, click the helper's toolbar icon and press
**Fill this page**. The helper only ever acts on the page you are looking at.

## Updating

Rebuild (\`npm run build:extension\`) and click the reload icon on the helper's card
in the extensions page.

## One-click install

Loading a folder is how the helper is installed today. Publishing it to the
Chrome Web Store (and the Edge Add-ons store) is the later one-click-install
route: you would add it from the store listing and updates would arrive by
themselves. Nothing about how it works changes.
`;
}

/**
 * Builds the extension.
 * @param {{ srcDir: string, outDir: string, env: Record<string, string | undefined> }} options
 * @returns {BuildConfig}
 */
export function buildExtension({ srcDir, outDir, env }) {
  const src = path.resolve(srcDir);
  const out = path.resolve(outDir);
  const rel = path.relative(out, src);
  if (out === src || (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)))
    throw new Error("Refusing to build into the extension's source folder or a folder that contains it.");
  for (const part of ["src", "popup"]) {
    const inside = path.relative(path.join(src, part), out);
    if (inside === "" || (!inside.startsWith("..") && !path.isAbsolute(inside))) throw new Error(`Refusing to build into the extension's ${part} folder.`);
  }

  const config = resolveBuildConfig(env);
  const manifest = buildManifest(JSON.parse(readFileSync(path.join(src, "manifest.json"), "utf8")), config);
  assertSafeManifest(manifest);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const dir of ["src", "popup"]) cpSync(path.join(src, dir), path.join(out, dir), { recursive: true });
  writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(out, "src", "config.js"), configSource(config));
  writeFileSync(path.join(out, "README.md"), distReadme(config));

  // Every file the manifest names must be in the build.
  const named = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    ...(manifest.content_scripts ?? []).flatMap((c) => c.js ?? []),
    ...(manifest.web_accessible_resources ?? []).flatMap((w) => w.resources ?? []),
  ];
  for (const f of named.filter(Boolean)) if (!existsSync(path.join(out, f))) throw new Error(`The manifest names ${f}, which is not in the build.`);
  if (readdirSync(out).length === 0) throw new Error("Nothing was built.");
  return config;
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  const root = path.resolve(path.dirname(here), "..");
  try {
    const out = path.join(root, "extension", "dist");
    const config = buildExtension({ srcDir: path.join(root, "extension"), outDir: out, env: process.env });
    console.log(`Built the TenderOS browser helper${config.dev ? " (development build)" : ""} for ${config.origin}`);
    console.log(`  portals it opens by itself: ${config.portalHosts.join(", ")}`);
    console.log(`  folder: ${out}`);
    console.log("Install: open chrome://extensions (or edge://extensions), turn on Developer mode, press Load unpacked and choose that folder.");
  } catch (err) {
    console.error(`build:extension failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
