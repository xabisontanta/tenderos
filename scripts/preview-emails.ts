/**
 * Renders every email with sample data and writes:
 *
 *   emails/preview/index.html          all emails, light and dark, desktop and mobile
 *   emails/preview/frames/*.html       one standalone file per email and scheme
 *   emails/preview/screenshots/*.png   full-page captures (needs a Chromium)
 *
 *   npm run preview:emails                 index, frames and screenshots
 *   npm run preview:emails -- --no-screenshots
 *   npm run preview:emails -- --only=auth-recovery
 *   npm run preview:emails -- --check      also fail on horizontal overflow at 375px or a broken image
 *
 * The preview clock is fixed so the screenshots do not change from run to run.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PREVIEW_ORIGIN, previewEmails, type PreviewEmail } from "../emails/preview-data";
import { escapeHtml } from "../emails/layout";
import { launchBrowser } from "./lib/browser";

const args = process.argv.slice(2);
const skipShots = args.includes("--no-screenshots");
const check = args.includes("--check");
const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length);

const previewDir = path.resolve("emails/preview");
const framesDir = path.join(previewDir, "frames");
const shotsDir = path.join(previewDir, "screenshots");
const NOW = new Date("2026-10-12T08:00:00+02:00");

const DARK_QUERY = "@media (prefers-color-scheme: dark)";
/** Pins the colour scheme regardless of the viewer's OS, so light and dark can sit side by side. */
const forceDark = (html: string) => html.replaceAll(DARK_QUERY, "@media all");
const forceLight = (html: string) => html.replaceAll(DARK_QUERY, "@media not all");
/** Points the images at the committed PNGs, relative to the file that holds the HTML. */
const localImages = (html: string, rel: string) => html.replaceAll(`${PREVIEW_ORIGIN}/email/`, `${rel}/public/email/`);

const emails = previewEmails({ now: NOW }).filter((e) => !only || e.id === only);
if (!emails.length) {
  console.error(`No email matches --only=${only}`);
  process.exit(1);
}

rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });

for (const e of emails) {
  const html = localImages(e.html, "../../..");
  writeFileSync(path.join(framesDir, `${e.id}.html`), html);
  writeFileSync(path.join(framesDir, `${e.id}.light.html`), forceLight(html));
  writeFileSync(path.join(framesDir, `${e.id}.dark.html`), forceDark(html));
}

function frame(e: PreviewEmail, scheme: "light" | "dark", width: number): string {
  const html = (scheme === "dark" ? forceDark : forceLight)(localImages(e.html, "../.."));
  return `<iframe title="${escapeHtml(e.label)}, ${scheme}" class="frame" style="width:${width}px" sandbox="allow-same-origin" srcdoc="${escapeHtml(html)}"></iframe>`;
}

function section(e: PreviewEmail): string {
  return `<section id="${e.id}" class="email" data-group="${e.group}">
<header>
<h2>${escapeHtml(e.label)}</h2>
<dl class="inbox">
<dt>From</dt><dd>TenderOS &lt;no-reply@example.co.za&gt;</dd>
<dt>Subject</dt><dd><strong>${escapeHtml(e.subject)}</strong></dd>
<dt>Preview</dt><dd>${escapeHtml(e.preheader)}</dd>
</dl>
</header>
<div class="frames desktop">
<figure><figcaption>Light, 600px column</figcaption>${frame(e, "light", 720)}</figure>
<figure><figcaption>Dark, 600px column</figcaption>${frame(e, "dark", 720)}</figure>
</div>
<div class="frames mobile">
<figure><figcaption>Light, 375px</figcaption>${frame(e, "light", 375)}</figure>
<figure><figcaption>Dark, 375px</figcaption>${frame(e, "dark", 375)}</figure>
</div>
${e.text ? `<details><summary>Plain-text version</summary><pre>${escapeHtml(e.text)}</pre></details>` : ""}
</section>`;
}

function nav(): string {
  const groups = [...new Set(emails.map((e) => e.group))];
  return groups
    .map((g) => `<h3>${g}</h3><ul>${emails.filter((e) => e.group === g).map((e) => `<li><a href="#${e.id}">${escapeHtml(e.label)}</a></li>`).join("")}</ul>`)
    .join("");
}

const index = `<!doctype html>
<html lang="en-ZA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TenderOS email preview</title>
<style>
:root{color-scheme:light dark;--bg:#f4f6f9;--fg:#11161f;--muted:#5d646f;--card:#fff;--bd:#dbdee2;--accent:#006e9e}
@media (prefers-color-scheme:dark){:root{--bg:#090c11;--fg:#e7ecf0;--muted:#9299a2;--card:#10141a;--bd:#272c32;--accent:#3ecce2}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);display:grid;grid-template-columns:260px 1fr;min-height:100vh}
nav{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;padding:20px;border-right:1px solid var(--bd)}
nav h1{font-size:17px;margin:0 0 4px}nav p{margin:0 0 16px;color:var(--muted);font-size:13px}nav h3{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:18px 0 6px}
nav ul{list-style:none;margin:0;padding:0}nav a{display:block;padding:4px 8px;margin:0 -8px;border-radius:6px;color:var(--fg);text-decoration:none}nav a:hover{background:var(--card)}
.tools{display:flex;gap:8px;margin-top:18px}.tools button{flex:1;padding:6px 8px;border:1px solid var(--bd);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer}.tools button[aria-pressed=true]{border-color:var(--accent);color:var(--accent);font-weight:600}
main{padding:24px 28px;min-width:0}.email{margin-bottom:56px}.email h2{margin:0 0 8px;font-size:22px}
.inbox{display:grid;grid-template-columns:70px 1fr;gap:2px 12px;margin:0 0 16px;padding:12px 14px;background:var(--card);border:1px solid var(--bd);border-radius:10px;max-width:760px}.inbox dt{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em;padding-top:2px}.inbox dd{margin:0}
.frames{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}figure{margin:0}figcaption{font-size:12px;color:var(--muted);margin-bottom:6px}
.frame{border:1px solid var(--bd);border-radius:10px;background:#fff;height:900px;max-width:100%}
body[data-view=desktop] .mobile,body[data-view=mobile] .desktop{display:none}
details{margin-top:14px;max-width:760px}pre{white-space:pre-wrap;background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px;font-size:13px}
@media (max-width:900px){body{grid-template-columns:1fr}nav{position:static;height:auto;border:0}}
</style></head>
<body data-view="desktop">
<nav><h1>TenderOS emails</h1><p>${emails.length} emails with sample data. Light and dark are pinned, so they match every viewer.</p>${nav()}
<div class="tools" role="group" aria-label="Viewport"><button type="button" data-view="desktop" aria-pressed="true">Desktop</button><button type="button" data-view="mobile" aria-pressed="false">Mobile</button></div></nav>
<main>${emails.map(section).join("\n")}</main>
<script>
const body=document.body;
document.querySelectorAll('.tools button').forEach(b=>b.addEventListener('click',()=>{body.dataset.view=b.dataset.view;document.querySelectorAll('.tools button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));fit()}));
function fit(){document.querySelectorAll('iframe.frame').forEach(f=>{try{f.style.height=f.contentDocument.documentElement.scrollHeight+'px'}catch(e){}})}
document.querySelectorAll('iframe.frame').forEach(f=>f.addEventListener('load',fit));
</script></body></html>`;
writeFileSync(path.join(previewDir, "index.html"), index);
console.log(`wrote emails/preview/index.html (${emails.length} emails)`);

async function screenshots() {
  const browser = await launchBrowser();
  const problems: string[] = [];
  try {
    for (const scheme of ["light", "dark"] as const) {
      for (const [view, width] of [["desktop", 720], ["mobile", 375]] as const) {
        const context = await browser.newContext({ colorScheme: scheme, viewport: { width, height: 900 }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        for (const e of emails) {
          await page.goto(`file:///${path.join(framesDir, `${e.id}.html`).replaceAll("\\", "/")}`);
          await page.waitForLoadState("load");
          const file = path.join(shotsDir, `${e.id}.${scheme}.${view}.png`);
          await page.screenshot({ path: file, fullPage: true });
          const report = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            broken: Array.from(document.images).filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute("src")),
          }));
          if (report.overflow > 0) problems.push(`${e.id} ${scheme} ${view}: overflows by ${report.overflow}px`);
          if (report.broken.length) problems.push(`${e.id} ${scheme} ${view}: broken images ${report.broken.join(", ")}`);
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`wrote ${emails.length * 4} screenshots to emails/preview/screenshots`);
  if (problems.length) {
    console.error(problems.join("\n"));
    if (check) process.exit(1);
  } else {
    console.log("no horizontal overflow and no broken images");
  }
}

if (!skipShots) {
  screenshots().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
