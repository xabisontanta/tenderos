/**
 * Renders the brand images used by emails into public/email as PNG, at 1x and
 * 2x with a transparent background. Email clients cannot show SVG, and
 * Outlook and Gmail strip most things that would replace it.
 *
 *   mark-light / mark-dark        the TenderOS mark (components/command-centre/logo.tsx)
 *   lockup-light / lockup-dark    mark + wordmark set in Geist
 *   icon-<name>                   gradient chip with a white lucide glyph (emails/icons.ts)
 *
 * Run with: npm run build:email-assets. The PNGs are committed, so this only
 * needs to run when the brand or the icon list changes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as lucide from "lucide-react";
import { EMAIL_ICONS, ICON_CHIP_SIZE, LOCKUP_SIZE, MARK_SIZE, assetFile, type IconName } from "../emails/icons";
import { launchBrowser } from "./lib/browser";

const outDir = path.resolve("public/email");

/** Logo gradient: oklch(0.82 0.12 210) to oklch(0.62 0.17 280), as on the dark app surface. */
const BRAND = { a: "#50d9ef", b: "#7575e9" };
/** The same hues deepened (oklch 0.70/0.50) so the mark holds 3:1 against the light email page. */
const BRAND_ON_LIGHT = { a: "#00b2d1", b: "#544ccb" };
/** Chip fill: oklch(0.60 0.13 225) to oklch(0.50 0.19 280). White glyphs stay above 3:1 on both stops. */
const CHIP = { a: "#008fba", b: "#544ccb" };
const INK = { light: "#11161f", dark: "#e7ecf0" };

function markSvg(theme: "light" | "dark", size: number): string {
  const g = theme === "light" ? BRAND_ON_LIGHT : BRAND;
  const fillOpacity = theme === "light" ? 0.14 : 0.18;
  const strokeOpacity = theme === "light" ? 0.75 : 0.6;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${g.a}"/><stop offset="1" stop-color="${g.b}"/></linearGradient></defs>
<rect x="1" y="1" width="30" height="30" rx="8" fill="url(#g)" opacity="${fillOpacity}"/>
<rect x="1.5" y="1.5" width="29" height="29" rx="7.5" fill="none" stroke="url(#g)" stroke-opacity="${strokeOpacity}"/>
<path d="M9 10h14M16 10v13" stroke="url(#g)" stroke-width="2.6" stroke-linecap="round" fill="none"/>
<circle cx="22.5" cy="21.5" r="2.2" fill="${g.a}"/>
</svg>`;
}

function iconMarkup(name: IconName): string {
  const Icon = (lucide as unknown as Record<string, React.ElementType>)[EMAIL_ICONS[name]];
  if (!Icon) throw new Error(`lucide-react has no ${EMAIL_ICONS[name]}`);
  return renderToStaticMarkup(createElement(Icon, { size: 22, color: "#ffffff", strokeWidth: 2 }));
}

const font = (file: string) => readFileSync(path.resolve("node_modules/geist/dist/fonts/geist-sans", file)).toString("base64");

interface Asset {
  file1x: string;
  file2x: string;
  width: number;
  height: number;
  html: string;
}

function assets(): Asset[] {
  const list: Asset[] = [];
  for (const theme of ["light", "dark"] as const) {
    list.push({
      file1x: assetFile.mark(theme, 1),
      file2x: assetFile.mark(theme, 2),
      width: MARK_SIZE,
      height: MARK_SIZE,
      html: markSvg(theme, MARK_SIZE),
    });
    list.push({
      file1x: assetFile.lockup(theme, 1),
      file2x: assetFile.lockup(theme, 2),
      width: LOCKUP_SIZE.width,
      height: LOCKUP_SIZE.height,
      html: `<div style="display:flex;align-items:center;gap:10px;width:${LOCKUP_SIZE.width}px;height:${LOCKUP_SIZE.height}px">
${markSvg(theme, 32)}
<span style="font:600 21px/1 Geist,sans-serif;letter-spacing:-0.025em;color:${INK[theme]}">TenderOS</span></div>`,
    });
  }
  for (const name of Object.keys(EMAIL_ICONS) as IconName[]) {
    list.push({
      file1x: assetFile.icon(name, 1),
      file2x: assetFile.icon(name, 2),
      width: ICON_CHIP_SIZE,
      height: ICON_CHIP_SIZE,
      html: `<div style="width:${ICON_CHIP_SIZE}px;height:${ICON_CHIP_SIZE}px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,${CHIP.a},${CHIP.b});box-shadow:inset 0 0 0 1px rgba(255,255,255,0.22)">${iconMarkup(name)}</div>`,
    });
  }
  return list;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const browser = await launchBrowser();
  try {
    for (const scale of [1, 2] as const) {
      const context = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 400, height: 200 } });
      const page = await context.newPage();
      for (const a of assets()) {
        await page.setContent(
          `<!doctype html><html><head><style>
@font-face{font-family:Geist;font-weight:600;src:url(data:font/woff2;base64,${font("Geist-SemiBold.woff2")}) format("woff2")}
html,body{margin:0;background:transparent}
#asset{display:inline-block;line-height:0}
</style></head><body><div id="asset">${a.html}</div></body></html>`,
        );
        await page.evaluate(() => document.fonts.ready);
        const buffer = await page.locator("#asset").screenshot({ omitBackground: true, type: "png" });
        const file = scale === 1 ? a.file1x : a.file2x;
        writeFileSync(path.join(outDir, file), buffer);
        console.log(`wrote public/email/${file} (${a.width * scale}x${a.height * scale}, ${(buffer.length / 1024).toFixed(1)} KB)`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
