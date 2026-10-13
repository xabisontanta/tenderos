// @ts-check
// Build settings. `npm run build:extension` rewrites this file in extension/dist
// for the TenderOS address given in TENDEROS_ORIGIN. The helper talks to this
// one origin and no other, and its manifest only lets it do so.

/** The only TenderOS address this helper sends the pairing code to. */
export const TENDEROS_ORIGIN = "https://tenderos-six.vercel.app";

/** Development builds may also fill portals on http://localhost. Never true in a production build. */
export const DEV_BUILD = false;
