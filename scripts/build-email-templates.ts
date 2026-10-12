/**
 * Renders the Supabase Auth emails from emails/ into supabase/templates/*.html.
 * The generated files are committed: the Supabase CLI reads them through the
 * content_path entries in supabase/config.toml.
 *
 *   npm run build:emails            write the files
 *   npm run build:emails -- --check fail if a committed file is out of date
 *   npm run build:emails -- --management-api   print the JSON body that applies the
 *                                   templates to a hosted project (see docs/email.md)
 *
 * Environment (all optional):
 *   EMAIL_LEGAL_NAME, EMAIL_LEGAL_ADDRESS, EMAIL_REGISTRATION_NUMBER,
 *   EMAIL_SUPPORT_ADDRESS   the sender block in every footer
 *   EMAIL_ASSET_BASE_URL    https origin for /email/*.png instead of {{ .SiteURL }}
 *   EMAIL_STRICT=1          fail while any footer value is still a [placeholder]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveBrand, unresolvedPlaceholders } from "../emails/brand";
import { buildAuthTemplates, managementApiPayload } from "../emails/build";

const check = process.argv.includes("--check");
const outDir = path.resolve("supabase/templates");
const brand = resolveBrand(process.env);

const assetBase = process.env.EMAIL_ASSET_BASE_URL?.trim().replace(/\/+$/, "");
if (assetBase && !/^https:\/\/[^\s/]+/.test(assetBase)) {
  console.error("EMAIL_ASSET_BASE_URL must be an https:// origin");
  process.exit(1);
}

const missing = unresolvedPlaceholders(brand);
if (missing.length) {
  const message = `Footer values still hold placeholders: ${missing.join(", ")}. Set EMAIL_LEGAL_NAME, EMAIL_LEGAL_ADDRESS, EMAIL_REGISTRATION_NUMBER and EMAIL_SUPPORT_ADDRESS.`;
  if (process.env.EMAIL_STRICT === "1") {
    console.error(message);
    process.exit(1);
  }
  console.warn(`warning: ${message}`);
}

const templates = buildAuthTemplates(brand, { assetBase });

if (process.argv.includes("--management-api")) {
  // For hosted projects: writes the PATCH body for /v1/projects/{ref}/config/auth to stdout. Sends nothing.
  process.stdout.write(`${JSON.stringify(managementApiPayload(templates), null, 2)}\n`);
  process.exit(0);
}

let stale = 0;
if (!check) mkdirSync(outDir, { recursive: true });
for (const t of templates) {
  const file = path.join(outDir, t.file);
  if (check) {
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {
      /* missing counts as stale */
    }
    if (current !== t.html) {
      stale++;
      console.error(`stale: supabase/templates/${t.file}`);
    }
  } else {
    writeFileSync(file, t.html, "utf8");
    console.log(`wrote supabase/templates/${t.file} (${(Buffer.byteLength(t.html) / 1024).toFixed(1)} KB)`);
  }
}
if (check) {
  if (stale) {
    console.error(`${stale} template(s) out of date; run npm run build:emails`);
    process.exit(1);
  }
  console.log(`${templates.length} templates are up to date`);
}
