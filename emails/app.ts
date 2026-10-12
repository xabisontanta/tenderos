import { resolveBrand, type Brand } from "./brand";
import { appContext, renderEmail, sanitizeSubject, type EmailContent, type RenderContext } from "./layout";

/** What every app-sent email needs from its caller, besides its own input. */
export interface AppEmailOptions {
  /** APP_URL: the public origin of the app. Links and images are built from it. */
  appUrl: string | undefined;
  /** Overrides the sender block (tests); defaults to the EMAIL_* environment variables. */
  brand?: Brand;
  /** Overrides NODE_ENV === "production" (tests). Production requires https. */
  production?: boolean;
  /** The clock, so renderers stay pure. Defaults to the current time. */
  now?: Date;
}

export interface AppEmail {
  subject: string;
  html: string;
  text: string;
}

export function contextFor(options: AppEmailOptions): RenderContext {
  return appContext({ appUrl: options.appUrl, brand: options.brand ?? resolveBrand(), production: options.production });
}

export function nowFor(options: AppEmailOptions): Date {
  return options.now ?? new Date();
}

/** Renders content with the app context and a sanitised, length-limited subject. */
export function renderApp(content: EmailContent, subject: string, ctx: RenderContext): AppEmail {
  const { html, text } = renderEmail(content, ctx);
  return { subject: sanitizeSubject(subject), html, text };
}

/** Joins a path to the app origin. */
export function appLink(ctx: RenderContext, path: string): string {
  return `${ctx.siteUrl}${path}`;
}
