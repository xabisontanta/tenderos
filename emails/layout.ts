/**
 * Shared shell, design tokens and block renderers for every TenderOS email.
 *
 * Authors describe an email as data (EmailContent: eyebrow, headline, blocks)
 * and renderEmail() turns it into HTML and a plain-text twin. Nothing here
 * builds markup from raw strings: every interpolated value goes through
 * escapeHtml(), every link through isSafeHref().
 *
 * Email clients are a hostile target, so the markup is deliberately old
 * school: nested presentation tables, inline styles for everything that
 * matters, one <style> block only for dark mode and the 375px layout, VML for
 * the Outlook button. No scripts, no web fonts, no external stylesheets.
 *
 * Design tokens come from app/globals.css (oklch converted to sRGB hex).
 * Where the app's primary fails 4.5:1 for text or a button on white, the
 * email uses a deeper shade of the same hue; CONTRAST_PAIRS is asserted in
 * tests/unit/emails/layout.test.ts so the palette cannot regress.
 */
import { BRAND_NAME, BRAND_TAGLINE, type Brand } from "./brand";
import { ICON_CHIP_SIZE, MARK_SIZE, assetFile, type IconName } from "./icons";

// ---------------------------------------------------------------- tokens

/** oklch values in comments are the app/globals.css tokens each hex came from. */
export const LIGHT = {
  page: "#f4f6f9", // email page, one step deeper than --background so the white card lifts
  card: "#ffffff", // --card oklch(1 0 0)
  panel: "#f0f4f9", // oklch(0.965 0.008 250)
  text: "#11161f", // --foreground oklch(0.2 0.02 260)
  muted: "#5d646f", // --muted-foreground oklch(0.5 0.02 260)
  border: "#dbdee2", // --border oklch(0.9 0.006 250)
  primary: "#007eb7", // --primary oklch(0.55 0.15 230), decorative only (4.5:1 on white)
  link: "#006e9e", // oklch(0.5 0.13 230): text-safe primary
  btn: "#006ea0", // oklch(0.5 0.13 232): button fill, 5.6:1 with white text
  btnText: "#ffffff",
  tint: "#dff4fd", // oklch(0.955 0.025 225): chip and step badge fill
} as const;

export const DARK = {
  page: "#090c11", // --background .dark oklch(0.155 0.012 260)
  card: "#10141a", // --card .dark oklch(0.19 0.014 260)
  panel: "#181c22", // oklch(0.225 0.014 260)
  text: "#e7ecf0", // --foreground .dark oklch(0.94 0.008 250)
  muted: "#9299a2", // --muted-foreground .dark oklch(0.68 0.015 255)
  border: "#272c32", // --border .dark oklch(0.29 0.014 260)
  primary: "#3ecce2", // --primary .dark oklch(0.78 0.12 210)
  link: "#3ecce2",
  btn: "#3ecce2",
  btnText: "#0a1018", // --primary-foreground .dark oklch(0.17 0.02 260)
  tint: "#022632", // oklch(0.25 0.045 225)
} as const;

/** Brand gradient (logo): oklch(0.82 0.12 210) to oklch(0.62 0.17 280). */
export const GRADIENT = { from: "#50d9ef", to: "#7575e9" } as const;

export type Tone = "info" | "success" | "warning" | "danger" | "neutral";

/** Notice panel colours per tone: bg tint, and fg used for title text and the accent bar. */
export const TONES: Record<Tone, { light: { bg: string; fg: string }; dark: { bg: string; fg: string } }> = {
  info: { light: { bg: "#dff4fd", fg: "#006e9e" }, dark: { bg: "#022632", fg: "#3ecce2" } },
  success: { light: { bg: "#e0f9e8", fg: "#00713e" }, dark: { bg: "#102a1a", fg: "#72d699" } },
  warning: { light: { bg: "#fff2d6", fg: "#7e4f04" }, dark: { bg: "#32240a", fg: "#edbb64" } },
  danger: { light: { bg: "#ffedeb", fg: "#b71824" }, dark: { bg: "#3b1c1b", fg: "#ff918e" } },
  neutral: { light: { bg: "#f0f4f9", fg: "#11161f" }, dark: { bg: "#181c22", fg: "#e7ecf0" } },
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

// ---------------------------------------------------------------- contrast

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
/** WCAG 2.x contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastPair {
  name: string;
  fg: string;
  bg: string;
}
/** Every text-on-background pair the layout uses. Tests hold each at 4.5:1 or better. */
export const CONTRAST_PAIRS: ContrastPair[] = (["light", "dark"] as const).flatMap((mode) => {
  const t = mode === "light" ? LIGHT : DARK;
  const pairs: ContrastPair[] = [
    { name: `${mode}: text on card`, fg: t.text, bg: t.card },
    { name: `${mode}: muted on card`, fg: t.muted, bg: t.card },
    { name: `${mode}: muted on page`, fg: t.muted, bg: t.page },
    { name: `${mode}: text on panel`, fg: t.text, bg: t.panel },
    { name: `${mode}: muted on panel`, fg: t.muted, bg: t.panel },
    { name: `${mode}: link on card`, fg: t.link, bg: t.card },
    { name: `${mode}: link on panel`, fg: t.link, bg: t.panel },
    { name: `${mode}: link on page`, fg: t.link, bg: t.page },
    { name: `${mode}: link on tint`, fg: t.link, bg: t.tint },
    { name: `${mode}: button label on button`, fg: t.btnText, bg: t.btn },
  ];
  for (const [tone, v] of Object.entries(TONES) as Array<[Tone, (typeof TONES)[Tone]]>) {
    pairs.push({ name: `${mode}: ${tone} title on ${tone} panel`, fg: v[mode].fg, bg: v[mode].bg });
    pairs.push({ name: `${mode}: text on ${tone} panel`, fg: t.text, bg: v[mode].bg });
  }
  return pairs;
});

// ---------------------------------------------------------------- escaping and links

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Supabase Go-template placeholder at the start of a URL, e.g. {{ .ConfirmationURL }}. */
const PLACEHOLDER_URL = /^\{\{ \.[A-Za-z]+ \}\}/;
const LOCAL_HTTP = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/;

/** Links in email must be https (or a Supabase placeholder, or mailto). http is for local development only. */
export function isSafeHref(href: string, opts: { allowLocalHttp?: boolean } = {}): boolean {
  if (!href || href !== href.trim() || /[\u0000-\u001f\u007f\s]/.test(href.replace(/^\{\{ \.[A-Za-z]+ \}\}/, ""))) return false;
  if (PLACEHOLDER_URL.test(href)) return true;
  if (/^https:\/\/[^/\s]/i.test(href)) return true;
  if (/^mailto:[^\s]+$/i.test(href)) return true;
  return Boolean(opts.allowLocalHttp) && LOCAL_HTTP.test(href);
}

/** One line, no control characters, at most 78 characters (RFC 5322 recommended line length). */
export function sanitizeSubject(subject: string, max = 78): string {
  const oneLine = subject
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------- contexts

export interface RenderContext {
  /** Prefix for /email/*.png. {{ .SiteURL }} for Supabase templates, the app origin for app emails. */
  assetBase: string;
  /** Prefix for Help, Privacy and Terms links. */
  siteUrl: string;
  brand: Brand;
  /** http://localhost is accepted for links (local development only). */
  allowLocalHttp: boolean;
}

export function supabaseContext(brand: Brand, opts: { assetBase?: string } = {}): RenderContext {
  return { assetBase: opts.assetBase ?? "{{ .SiteURL }}", siteUrl: "{{ .SiteURL }}", brand, allowLocalHttp: false };
}

export function appContext(opts: { appUrl: string | undefined; brand: Brand; production?: boolean }): RenderContext {
  const production = opts.production ?? process.env.NODE_ENV === "production";
  if (!opts.appUrl?.trim()) throw new Error("APP_URL is required to render app emails");
  let url: URL;
  try {
    url = new URL(opts.appUrl.trim());
  } catch {
    throw new Error("APP_URL is not a valid URL");
  }
  const local = LOCAL_HTTP.test(`${url.origin}/`);
  if (url.protocol !== "https:" && !(local && !production)) throw new Error("APP_URL must use https in production");
  return { assetBase: url.origin, siteUrl: url.origin, brand: opts.brand, allowLocalHttp: !production };
}

// ---------------------------------------------------------------- content model

/**
 * `raw` is verbatim markup for the template author only (Go-template conditionals in
 * Supabase emails). It is never fed user data; app email renderers do not use it.
 */
export type Inline = string | { strong: string } | { code: string } | { raw: string } | { link: { href: string; text: string } };
export type Rich = Inline | readonly Inline[];

export interface TenderRow {
  title: string;
  href: string;
  /** Reference, buyer, province. Shown dot-separated under the title. */
  meta: string[];
  closes: string;
  remaining: string;
  status?: string;
}

export interface StepItem {
  title: string;
  body: Rich;
  done?: boolean;
  link?: { href: string; text: string };
}

export type Block =
  | { type: "p"; text: Rich; muted?: boolean; tight?: boolean }
  | { type: "button"; label: string; href: string; note?: Rich }
  | { type: "linkFallback"; href: string }
  | { type: "code"; code: string; caption?: string }
  | { type: "notice"; tone: Tone; title: string; body: Rich }
  | { type: "details"; rows: ReadonlyArray<{ label: string; value: Rich }> }
  | { type: "list"; items: readonly Rich[] }
  | { type: "steps"; items: readonly StepItem[] }
  | { type: "tenders"; heading: string; tone: Tone; items: readonly TenderRow[] }
  | { type: "divider" }
  | { type: "safety"; title: string; body: Rich };

export interface EmailContent {
  /** <title>; also what some clients show in the tab or share sheet. */
  title: string;
  /** Hidden inbox preview text, ideally 40 to 110 characters. */
  preheader: string;
  eyebrow: { label: string; icon: IconName };
  headline: string;
  blocks: readonly Block[];
  /** Completes "You are receiving this email because ...". */
  reason: string;
}

// ---------------------------------------------------------------- theme classes

type Themed = ReadonlyArray<readonly [prop: "color" | "background-color" | "border-color", light: string, dark: string]>;

/** Each class carries its light value inline and its dark value in the media query. */
const THEMED: Record<string, Themed> = {
  "bg-page": [["background-color", LIGHT.page, DARK.page]],
  "bg-card": [["background-color", LIGHT.card, DARK.card]],
  "bg-panel": [["background-color", LIGHT.panel, DARK.panel]],
  "bg-tint": [["background-color", LIGHT.tint, DARK.tint]],
  "bg-rule": [["background-color", LIGHT.border, DARK.border]],
  tx: [["color", LIGHT.text, DARK.text]],
  "tx-muted": [["color", LIGHT.muted, DARK.muted]],
  "tx-link": [["color", LIGHT.link, DARK.link]],
  bd: [["border-color", LIGHT.border, DARK.border]],
  "btn-bg": [
    ["background-color", LIGHT.btn, DARK.btn],
    ["border-color", LIGHT.btn, DARK.btn],
  ],
  "btn-tx": [["color", LIGHT.btnText, DARK.btnText]],
  ...Object.fromEntries(
    (Object.keys(TONES) as Tone[]).flatMap((tone): Array<[string, Themed]> => [
      [`n-${tone}-bg`, [["background-color", TONES[tone].light.bg, TONES[tone].dark.bg]]],
      [`n-${tone}-fg`, [["color", TONES[tone].light.fg, TONES[tone].dark.fg]]],
      [`n-${tone}-ac`, [["background-color", TONES[tone].light.fg, TONES[tone].dark.fg]]],
    ]),
  ),
};

/** class="..." plus a style="..." with the light values, then any extra declarations first. */
function t(classes: string, extra = "", extraClass = ""): string {
  const names = classes.split(" ");
  const themed = names.flatMap((n) => {
    const def = THEMED[n];
    if (!def) throw new Error(`Unknown theme class ${n}`);
    return def.map(([prop, light]) => `${prop}:${light}`);
  });
  const style = [extra.replace(/;$/, ""), ...themed].filter(Boolean).join(";");
  return `class="${[...names, extraClass].filter(Boolean).join(" ")}" style="${style}"`;
}

function darkRules(): string {
  const all: string[] = [];
  const bg: string[] = [];
  const fg: string[] = [];
  for (const [name, defs] of Object.entries(THEMED)) {
    const decl = defs.map(([prop, , dark]) => `${prop}:${dark}!important`).join(";");
    all.push(`.${name}{${decl}}`);
    const bgDecl = defs
      .filter(([p]) => p === "background-color")
      .map(([p, , d]) => `${p}:${d}!important`)
      .join(";");
    const fgDecl = defs
      .filter(([p]) => p !== "background-color")
      .map(([p, , d]) => `${p}:${d}!important`)
      .join(";");
    if (bgDecl) bg.push(`[data-ogsb] .${name}{${bgDecl}}`);
    if (fgDecl) fg.push(`[data-ogsc] .${name}{${fgDecl}}`);
  }
  return [
    "@media (prefers-color-scheme: dark) {",
    ...all.map((r) => `  ${r}`),
    "  .only-light{display:none!important;max-height:0!important;overflow:hidden!important}",
    "  .only-dark{display:inline-block!important;max-height:none!important;overflow:visible!important}",
    "}",
    // Outlook.com and the Outlook apps tag dark-mode elements with data-ogsc / data-ogsb.
    ...bg,
    ...fg,
    "[data-ogsb] .only-light{display:none!important}",
    "[data-ogsb] .only-dark{display:inline-block!important;max-height:none!important;overflow:visible!important}",
  ].join("\n");
}

const MOBILE_RULES = `@media (max-width: 620px) {
  .container{width:100%!important}
  .px{padding-left:22px!important;padding-right:22px!important}
  .h1{font-size:24px!important;line-height:30px!important}
  .btn-block{display:block!important;box-sizing:border-box!important;width:100%!important;text-align:center!important}
  .code{font-size:30px!important;letter-spacing:6px!important;padding-left:6px!important}
  .stack{display:block!important;width:100%!important;box-sizing:border-box!important}
  .stack-label{padding-bottom:2px!important}
  .stack-pad{padding-top:0!important;border-top:none!important}
  .hide-mobile{display:none!important}
}`;

function styleBlock(): string {
  return `<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}
img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none}
a{text-decoration:underline}
${MOBILE_RULES}
${darkRules()}
</style>`;
}

// ---------------------------------------------------------------- inline rendering

function inlineHtml(i: Inline, ctx: RenderContext): string {
  if (typeof i === "string") return escapeHtml(i);
  if ("raw" in i) return i.raw;
  if ("strong" in i) return `<strong style="font-weight:600">${escapeHtml(i.strong)}</strong>`;
  if ("code" in i) return `<span ${t("bg-panel", `font-family:${MONO};font-size:0.92em;padding:1px 5px;border-radius:5px`)}>${escapeHtml(i.code)}</span>`;
  assertSafe(i.link.href, ctx);
  return `<a href="${escapeHtml(i.link.href)}" target="_blank" ${t("tx-link", "text-decoration:underline")}>${escapeHtml(i.link.text)}</a>`;
}
function richHtml(r: Rich, ctx: RenderContext): string {
  return (Array.isArray(r) ? (r as readonly Inline[]) : [r as Inline]).map((i) => inlineHtml(i, ctx)).join("");
}
function inlineText(i: Inline): string {
  if (typeof i === "string") return i;
  if ("raw" in i) return i.raw;
  if ("strong" in i) return i.strong;
  if ("code" in i) return i.code;
  return `${i.link.text} (${i.link.href})`;
}
function richText(r: Rich): string {
  return (Array.isArray(r) ? (r as readonly Inline[]) : [r as Inline]).map(inlineText).join("");
}

function assertSafe(href: string, ctx: RenderContext): void {
  if (!isSafeHref(href, { allowLocalHttp: ctx.allowLocalHttp })) throw new Error(`Refusing to render an unsafe link: ${href.slice(0, 60)}`);
}

// ---------------------------------------------------------------- images

interface ImgOptions {
  src: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  style?: string;
}
function img(o: ImgOptions): string {
  const cls = o.className ? ` class="${o.className}"` : "";
  return `<img src="${escapeHtml(o.src)}" alt="${escapeHtml(o.alt)}" width="${o.width}" height="${o.height}"${cls} style="display:block;border:0;width:${o.width}px;height:${o.height}px;${o.style ?? ""}">`;
}

function assetUrl(ctx: RenderContext, file: string): string {
  return `${ctx.assetBase}/email/${file}`;
}

// ---------------------------------------------------------------- blocks

const SIDE = 40;

function row(inner: string, bottom = 18): string {
  return `<tr><td class="px" style="padding:0 ${SIDE}px ${bottom}px">${inner}</td></tr>`;
}

function paragraph(b: Extract<Block, { type: "p" }>, ctx: RenderContext): string {
  const size = b.muted ? "14px;line-height:22px" : "16px;line-height:26px";
  const cls = b.muted ? "tx-muted" : "tx";
  return row(`<p ${t(cls, `margin:0;font-family:${FONT};font-size:${size}`)}>${richHtml(b.text, ctx)}</p>`, b.tight ? 8 : 18);
}

function button(b: Extract<Block, { type: "button" }>, ctx: RenderContext): string {
  assertSafe(b.href, ctx);
  const href = escapeHtml(b.href);
  const label = escapeHtml(b.label);
  const width = Math.min(360, Math.max(220, b.label.length * 9 + 72));
  const note = b.note ? `<p ${t("tx-muted", `margin:12px 0 0;font-family:${FONT};font-size:13px;line-height:20px`)}>${richHtml(b.note, ctx)}</p>` : "";
  return row(
    `<table role="presentation" border="0" cellpadding="0" cellspacing="0" class="btn-block-wrap"><tr><td>
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:50px;v-text-anchor:middle;width:${width}px;" arcsize="20%" strokecolor="${LIGHT.btn}" fillcolor="${LIGHT.btn}">
<w:anchorlock/>
<center style="color:${LIGHT.btnText};font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${label}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-- -->
<a href="${href}" target="_blank" ${t("btn-bg btn-tx", `display:inline-block;border:1px solid;border-radius:10px;padding:14px 30px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;text-decoration:none;text-align:center;mso-hide:all`, "btn-block")}>${label}</a>
<!--<![endif]-->
</td></tr></table>${note}`,
    22,
  );
}

function linkFallback(b: Extract<Block, { type: "linkFallback" }>, ctx: RenderContext): string {
  assertSafe(b.href, ctx);
  const href = escapeHtml(b.href);
  return row(
    `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" ${t("bg-panel bd", "border:1px solid;border-radius:10px")}><tr><td style="padding:14px 16px">
<p ${t("tx-muted", `margin:0 0 6px;font-family:${FONT};font-size:13px;line-height:20px`)}>Button not working? Copy this link and paste it into your browser:</p>
<a href="${href}" target="_blank" ${t("tx-link", `font-family:${MONO};font-size:12px;line-height:18px;word-break:break-all;overflow-wrap:anywhere;text-decoration:underline`)}>${href}</a>
</td></tr></table>`,
    24,
  );
}

function codeBox(b: Extract<Block, { type: "code" }>): string {
  const caption = b.caption
    ? `<p ${t("tx-muted", `margin:10px 0 0;text-align:center;font-family:${FONT};font-size:13px;line-height:20px`)}>${escapeHtml(b.caption)}</p>`
    : "";
  return row(
    `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td align="center" ${t("bg-panel bd tx", `border:1px solid;border-radius:12px;padding:20px 12px 20px 22px;font-family:${MONO};font-size:36px;line-height:44px;font-weight:700;letter-spacing:10px;text-align:center;-webkit-user-select:all;user-select:all`, "code")}>${escapeHtml(b.code)}</td></tr></table>${caption}`,
    22,
  );
}

function notice(b: Extract<Block, { type: "notice" }>, ctx: RenderContext): string {
  return row(
    `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" ${t(`n-${b.tone}-bg`, "border-radius:12px;overflow:hidden")}><tr>
<td width="4" ${t(`n-${b.tone}-ac`, "width:4px;font-size:0;line-height:0")}>&nbsp;</td>
<td style="padding:14px 18px 15px">
<p ${t(`n-${b.tone}-fg`, `margin:0;font-family:${FONT};font-size:15px;line-height:22px;font-weight:600`)}>${escapeHtml(b.title)}</p>
<p ${t("tx", `margin:3px 0 0;font-family:${FONT};font-size:14px;line-height:22px`)}>${richHtml(b.body, ctx)}</p>
</td></tr></table>`,
    22,
  );
}

function details(b: Extract<Block, { type: "details" }>, ctx: RenderContext): string {
  const rows = b.rows
    .map(
      (r, i) =>
        `<tr><td width="34%" valign="top" ${t("tx-muted bd", `padding:11px 16px;${i ? "border-top:1px solid;" : ""}font-family:${FONT};font-size:13px;line-height:20px`, "stack stack-label")}>${escapeHtml(r.label)}</td>
<td valign="top" ${t("tx bd", `padding:11px 16px;${i ? "border-top:1px solid;" : ""}font-family:${FONT};font-size:14px;line-height:21px;word-break:break-word`, "stack stack-pad")}>${richHtml(r.value, ctx)}</td></tr>`,
    )
    .join("\n");
  return row(
    `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" ${t("bg-card bd", "border:1px solid;border-radius:12px;border-collapse:separate")}>\n${rows}\n</table>`,
    22,
  );
}

function list(b: Extract<Block, { type: "list" }>, ctx: RenderContext): string {
  const items = b.items.map((i) => `<li style="margin:0 0 6px">${richHtml(i, ctx)}</li>`).join("");
  return row(`<ul ${t("tx", `margin:0;padding:0 0 0 20px;font-family:${FONT};font-size:15px;line-height:23px`)}>${items}</ul>`);
}

function steps(b: Extract<Block, { type: "steps" }>, ctx: RenderContext): string {
  const rows = b.items
    .map((s, i) => {
      const badge = s.done
        ? `<td width="30" height="30" align="center" valign="middle" ${t("n-success-bg n-success-fg", `width:30px;height:30px;border-radius:15px;font-family:${FONT};font-size:15px;line-height:30px;font-weight:700;text-align:center`)}>&#10003;</td>`
        : `<td width="30" height="30" align="center" valign="middle" ${t("bg-tint tx-link", `width:30px;height:30px;border-radius:15px;font-family:${FONT};font-size:14px;line-height:30px;font-weight:700;text-align:center`)}>${i + 1}</td>`;
      let link = "";
      if (s.link) {
        assertSafe(s.link.href, ctx);
        link = `<p style="margin:6px 0 0"><a href="${escapeHtml(s.link.href)}" target="_blank" ${t("tx-link", `font-family:${FONT};font-size:14px;line-height:20px;font-weight:600;text-decoration:underline`)}>${escapeHtml(s.link.text)} &rarr;</a></p>`;
      }
      return `<tr><td ${t("bd", `padding:${i ? 14 : 4}px 0 14px;${i ? "border-top:1px solid;" : ""}`)}>
<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0"><tr>
<td width="46" valign="top" style="width:46px;padding-top:1px"><table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>${badge}</tr></table></td>
<td valign="top">
<p ${t(s.done ? "tx-muted" : "tx", `margin:0;font-family:${FONT};font-size:15px;line-height:22px;font-weight:600`)}>${escapeHtml(s.title)}${s.done ? ` <span ${t("n-success-fg", "font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase")}>&middot; Done</span>` : ""}</p>
<p ${t("tx-muted", `margin:2px 0 0;font-family:${FONT};font-size:14px;line-height:22px`)}>${richHtml(s.body, ctx)}</p>${link}
</td></tr></table></td></tr>`;
    })
    .join("\n");
  return row(`<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">\n${rows}\n</table>`, 22);
}

function tenders(b: Extract<Block, { type: "tenders" }>, ctx: RenderContext): string {
  const rows = b.items
    .map((it, i) => {
      assertSafe(it.href, ctx);
      const status = it.status
        ? ` <span ${t("bg-panel tx-muted", `display:inline-block;border-radius:999px;padding:1px 9px;font-family:${FONT};font-size:12px;line-height:18px;font-weight:500;white-space:nowrap`)}>${escapeHtml(it.status)}</span>`
        : "";
      return `<tr><td ${t("bd", `padding:14px 18px;${i ? "border-top:1px solid;" : ""}`)}>
<a href="${escapeHtml(it.href)}" target="_blank" ${t("tx", `font-family:${FONT};font-size:15px;line-height:22px;font-weight:600;text-decoration:none`)}>${escapeHtml(it.title)}</a>
<p ${t("tx-muted", `margin:2px 0 0;font-family:${FONT};font-size:13px;line-height:20px`)}>${escapeHtml(it.meta.join("  ·  "))}</p>
<p ${t(`n-${b.tone}-fg`, `margin:6px 0 0;font-family:${FONT};font-size:14px;line-height:21px;font-weight:600`)}>${escapeHtml(it.remaining)} <span ${t("tx-muted", "font-weight:400")}>&middot; ${escapeHtml(it.closes)}</span>${status}</p>
</td></tr>`;
    })
    .join("\n");
  return row(
    `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0"><tr>
<td width="4" ${t(`n-${b.tone}-ac`, "width:4px;border-radius:2px;font-size:0;line-height:0")}>&nbsp;</td>
<td style="padding:0 0 0 12px"><p ${t("tx", `margin:0;font-family:${FONT};font-size:13px;line-height:20px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase`)}>${escapeHtml(b.heading)} <span ${t("tx-muted", "font-weight:500")}>(${b.items.length})</span></p></td>
</tr></table>
<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" ${t("bg-card bd", "margin-top:10px;border:1px solid;border-radius:12px;border-collapse:separate")}>\n${rows}\n</table>`,
    24,
  );
}

function divider(): string {
  return `<tr><td class="px" style="padding:6px ${SIDE}px 22px"><table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td height="1" ${t("bg-rule", "height:1px;font-size:1px;line-height:1px")}>&nbsp;</td></tr></table></td></tr>`;
}

function safety(b: Extract<Block, { type: "safety" }>, ctx: RenderContext): string {
  return `${divider()}${row(
    `<p ${t("tx", `margin:0;font-family:${FONT};font-size:14px;line-height:22px;font-weight:600`)}>${escapeHtml(b.title)}</p>
<p ${t("tx-muted", `margin:3px 0 0;font-family:${FONT};font-size:14px;line-height:22px`)}>${richHtml(b.body, ctx)}</p>`,
    12,
  )}`;
}

function blockHtml(b: Block, ctx: RenderContext): string {
  switch (b.type) {
    case "p":
      return paragraph(b, ctx);
    case "button":
      return button(b, ctx);
    case "linkFallback":
      return linkFallback(b, ctx);
    case "code":
      return codeBox(b);
    case "notice":
      return notice(b, ctx);
    case "details":
      return details(b, ctx);
    case "list":
      return list(b, ctx);
    case "steps":
      return steps(b, ctx);
    case "tenders":
      return tenders(b, ctx);
    case "divider":
      return divider();
    case "safety":
      return safety(b, ctx);
  }
}

function blockText(b: Block): string {
  switch (b.type) {
    case "p":
      return richText(b.text);
    case "button":
      return `${b.label}: ${b.href}${b.note ? `\n${richText(b.note)}` : ""}`;
    case "linkFallback":
      return `Button not working? Copy this link and paste it into your browser:\n${b.href}`;
    case "code":
      return `${b.code}${b.caption ? `\n${b.caption}` : ""}`;
    case "notice":
      return `${b.title}\n${richText(b.body)}`;
    case "details":
      return b.rows.map((r) => `${r.label}: ${richText(r.value)}`).join("\n");
    case "list":
      return b.items.map((i) => `- ${richText(i)}`).join("\n");
    case "steps":
      return b.items
        .map((s, i) => `${s.done ? "[x]" : `${i + 1}.`} ${s.title}\n   ${richText(s.body)}${s.link ? `\n   ${s.link.text}: ${s.link.href}` : ""}`)
        .join("\n");
    case "tenders":
      return `${b.heading.toUpperCase()} (${b.items.length})\n${b.items
        .map((it) => `- ${it.title}\n  ${it.meta.join(" · ")}\n  ${it.remaining} · ${it.closes}${it.status ? ` · ${it.status}` : ""}\n  ${it.href}`)
        .join("\n")}`;
    case "divider":
      return "";
    case "safety":
      return `${b.title}\n${richText(b.body)}`;
  }
}

// ---------------------------------------------------------------- shell

function header(ctx: RenderContext): string {
  const alt = ""; // The wordmark is live text beside the mark, so the mark is decorative.
  const mark = (theme: "light" | "dark") =>
    img({
      src: assetUrl(ctx, assetFile.mark(theme)),
      alt,
      width: MARK_SIZE,
      height: MARK_SIZE,
      className: theme === "light" ? "only-light" : "only-dark",
      style: theme === "dark" ? "display:none;max-height:0;overflow:hidden;mso-hide:all" : "",
    });
  return `<tr><td align="center" style="padding:0 0 22px">
<table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center"><tr>
<td valign="middle" style="padding:0 10px 0 0;line-height:0">${mark("light")}${mark("dark")}</td>
<td valign="middle" ${t("tx", `font-family:${FONT};font-size:21px;line-height:32px;font-weight:700;letter-spacing:-0.02em`)}>${BRAND_NAME}</td>
</tr></table>
<p ${t("tx-muted", `margin:4px 0 0;font-family:${FONT};font-size:12px;line-height:18px;letter-spacing:0.02em;text-align:center`)}>${BRAND_TAGLINE}</p>
</td></tr>`;
}

function eyebrow(c: EmailContent, ctx: RenderContext): string {
  const chip = img({ src: assetUrl(ctx, assetFile.icon(c.eyebrow.icon)), alt: "", width: ICON_CHIP_SIZE, height: ICON_CHIP_SIZE });
  return `<tr><td class="px" style="padding:36px ${SIDE}px 0">
<table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>
<td valign="middle" width="${ICON_CHIP_SIZE}" style="width:${ICON_CHIP_SIZE}px;padding:0 14px 0 0;line-height:0">${chip}</td>
<td valign="middle" ${t("tx-link", `font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase`)}>${escapeHtml(c.eyebrow.label)}</td>
</tr></table></td></tr>
<tr><td class="px" style="padding:20px ${SIDE}px 16px"><h1 class="h1 tx" style="margin:0;font-family:${FONT};font-size:28px;line-height:34px;font-weight:700;letter-spacing:-0.02em;color:${LIGHT.text}">${escapeHtml(c.headline)}</h1></td></tr>`;
}

function footer(c: EmailContent, ctx: RenderContext): string {
  const b = ctx.brand;
  const link = (path: string, label: string) =>
    `<a href="${escapeHtml(`${ctx.siteUrl}${path}`)}" target="_blank" ${t("tx-muted", "text-decoration:underline")}>${label}</a>`;
  const muted = (inner: string, extra = "") =>
    `<p ${t("tx-muted", `margin:0 0 8px;font-family:${FONT};font-size:12px;line-height:19px;text-align:center;${extra}`)}>${inner}</p>`;
  return `<tr><td align="center" class="px" style="padding:26px 24px 0">
${muted(`<strong style="font-weight:600">${BRAND_NAME}</strong> &middot; ${BRAND_TAGLINE}`)}
${muted(`${link("/help", "Help")} &nbsp;&middot;&nbsp; ${link("/privacy", "Privacy")} &nbsp;&middot;&nbsp; ${link("/terms", "Terms")}`, "font-size:13px;")}
${muted(`${escapeHtml(b.legalName)} &middot; ${escapeHtml(b.legalAddress)} &middot; Reg. no. ${escapeHtml(b.registrationNumber)}<br>Questions? Write to ${escapeHtml(b.supportEmail)}.`)}
${muted(`You are receiving this email because ${escapeHtml(c.reason)}.`, "margin-bottom:0;")}
</td></tr>`;
}

export interface RenderedEmail {
  html: string;
  text: string;
}

export function renderEmail(c: EmailContent, ctx: RenderContext): RenderedEmail {
  const body = c.blocks.map((b) => blockHtml(b, ctx)).join("\n");
  const pad = "&#847;&zwnj;&nbsp;".repeat(40);
  const html = `<!doctype html>
<html lang="en-ZA" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(c.title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
${styleBlock()}
</head>
<body ${t("bg-page", "margin:0;padding:0;width:100%;word-spacing:normal")}>
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${escapeHtml(c.preheader)}</div>
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${pad}</div>
<div role="article" aria-roledescription="email" lang="en-ZA" style="width:100%">
<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" ${t("bg-page", "width:100%")}><tr><td align="center" style="padding:32px 12px 40px">
<!--[if mso]><table role="presentation" width="600" align="center" border="0" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" width="600" class="container" border="0" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px">
${header(ctx)}
<tr><td>
<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" ${t("bg-card bd", "border:1px solid;border-radius:16px;border-collapse:separate;overflow:hidden;box-shadow:0 1px 2px rgba(17,22,31,0.05),0 12px 32px rgba(17,22,31,0.07)")}>
<tr><td height="4" style="height:4px;line-height:4px;font-size:0;border-radius:15px 15px 0 0;background-color:${GRADIENT.from};background-image:linear-gradient(90deg,${GRADIENT.from} 0%,${GRADIENT.to} 100%)">&nbsp;</td></tr>
${eyebrow(c, ctx)}
${body}
<tr><td height="22" style="height:22px;font-size:0;line-height:0">&nbsp;</td></tr>
</table>
</td></tr>
${footer(c, ctx)}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</div>
</body>
</html>
`;

  const rule = "-".repeat(44);
  const text = [
    `${BRAND_NAME} · ${BRAND_TAGLINE}`,
    "",
    c.eyebrow.label.toUpperCase(),
    c.headline,
    "",
    ...c.blocks
      .map(blockText)
      .filter(Boolean)
      .flatMap((s) => [s, ""]),
    rule,
    `Help: ${ctx.siteUrl}/help`,
    `Privacy: ${ctx.siteUrl}/privacy`,
    `Terms: ${ctx.siteUrl}/terms`,
    "",
    `${ctx.brand.legalName} · ${ctx.brand.legalAddress} · Reg. no. ${ctx.brand.registrationNumber}`,
    `Questions? Write to ${ctx.brand.supportEmail}.`,
    `You are receiving this email because ${c.reason}.`,
    "",
  ].join("\n");

  return { html, text };
}
