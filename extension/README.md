# TenderOS browser helper

A Chrome and Edge extension that opens your tender portal from TenderOS, fills
the form with your company's details and attaches your verified company
documents. **It fills; you submit.** You check every field and press the
portal's submit button yourself.

## Install (4 steps)

1. Build it: `npm run build:extension` (Node only, no extra packages). This
   writes `extension/dist`. Set `TENDEROS_ORIGIN` to your TenderOS address
   (default `https://tenderos-six.vercel.app`; `http://localhost:3000` makes a
   development build) and `TENDEROS_PORTAL_HOSTS` to the exact portal hosts the
   helper may open by itself (default `www.etenders.gov.za,etenders.gov.za`).
2. Open `chrome://extensions` (Edge: `edge://extensions`) and turn on
   **Developer mode**.
3. Click **Load unpacked** and choose `extension/dist`.
4. Pin **TenderOS browser helper** to the toolbar, then in TenderOS open
   **Settings → Browser helper** and press **Connect browser**.

The built folder has its own `README.md` with the same steps. Publishing the
helper in the Chrome Web Store is the later one-click-install route; the
unpacked folder is how it is installed today. After changing code, rebuild and
click the reload icon on the extension's card.

`extension/` itself can also be loaded unpacked for the default address, but
only a build can target another TenderOS address.

## Use it

1. **Connect once.** In TenderOS, Settings → Browser helper → **Connect
   browser**. TenderOS creates the pairing code and gives it straight to the
   helper; you never see or copy it. It lasts 30 days. Disconnect or revoke it
   on the same card (removing a member from the organisation revokes theirs).
   If the browser cannot connect by itself, **Use a pairing code instead** on
   that card still works: create a code and paste it into the helper's popup.
2. **Apply.** Open an approved tender that is delivered through a web portal and
   press **Apply with TenderOS**. The helper opens the portal in a new tab,
   fills what it can match, attaches the approved bid pack documents and shows a
   review panel: what was filled, what was attached, and what is left for you.
3. **Finish yourself.** Sign in to the portal yourself if it asks, open the bid
   form and press **Fill this page** on the panel if the form was not on the
   first page. Check every field, complete declarations, prices and signatures,
   then submit on the portal. Record the delivery on the tender page.

For a portal the helper was not built to open by itself, TenderOS opens the tab
and asks you to click the toolbar icon; press **Fill this page** there. You can
always open any portal yourself and use the toolbar button on that page.

## Safety rules

The helper is a person's tool, not an agent. It only acts after you pressed
**Apply with TenderOS** or **Fill this page**, and:

- never clicks a submit, send, confirm or any other button, and never submits a form;
- never ticks a declaration, attestation, consent or any other tick box or option button;
- never fills a price, amount, rate, total or other figure;
- never signs, and leaves signature, initials and "date signed" fields alone;
- never fills passwords, security checks (captcha, OTP) or sign-in forms;
- never fills SA ID numbers, personal details (date of birth, gender, race, nationality) or banking details;
- never overwrites a field that already has something in it;
- never guesses. A value that is not in TenderOS is left empty and listed as
  "Not in your TenderOS company profile". Expired tax PINs and B-BBEE levels
  are not filled.

Where it may act:

- **Only the portal TenderOS named.** It fills a page only when the page's site
  (registrable domain) is the tender's portal. On any other site, for example
  when the portal sent you to a different login domain, the panel asks you to
  confirm and names both hosts. The page must still be on that host when the fill
  starts.
- **Only https** (http on localhost in a development build), and only the top
  frame and same-origin frames. Frames from other sites are never read.
- **Minimal permissions.** The production manifest has no wildcard or optional
  host permissions and no localhost. Besides `activeTab`, `scripting` and
  `storage` it can reach only the TenderOS address it was built for and the
  portal hosts it was built with. The build refuses to produce a manifest that
  breaks this.
- **Only your documents, only what you allow.** Apply attaches only the
  documents of the approved bid pack. Director ID copies, bank letters and proof
  of address are available to owners and admins only, and only when they tick
  the option on the tender page. Every file download is audited in TenderOS.
- **The pairing code never leaves the background worker.** It is kept in
  extension storage that content scripts cannot read, is sent only to the one
  TenderOS origin the helper was built for (no cookies, no redirects followed),
  and never reaches a web page.

Fields it fills are outlined in green; fields it left for you are outlined in
amber.

## How it works

- `src/background.js` (service worker) is the only code that holds the pairing
  code and talks to TenderOS. It identifies who is asking by the extension
  runtime (`sender.id`, tab, frame and URL), never by what a message claims.
- `src/bridge.js` / `src/bridge-main.js` is a content script on the TenderOS
  origin only. TenderOS pages and the helper talk through `window.postMessage`
  (`TENDEROS_EXTENSION_READY`, `TENDEROS_PAIR`, `TENDEROS_APPLY` and their
  acknowledgements, version 1). The bridge believes only messages the page's own
  window posted from the TenderOS origin that pass the strict schema in
  `src/protocol.js`, and replies carry the request's nonce.
- `src/apply.js` runs Apply with TenderOS: validate the plan, open the portal,
  check the host, fill, show the panel, report. `src/fill.js` is the fill shared
  with the toolbar button. `src/content.js` is injected into the portal tab,
  reports the form fields it sees (labels, names, types; never their contents)
  and applies the plan. `src/panel.js` draws the review panel in a closed shadow
  root.
- `src/match.js` decides what each field asks for; its skip rules for
  declarations, signatures, prices, passwords, security checks and ID numbers run
  before any match and are never relaxed.
- Pure, unit-tested modules: `protocol.js`, `hosts.js`, `plan.js`, `pairing.js`,
  `fill.js`, `summary.js`, `apply.js`, `api.js`, `match.js` (tests in
  `tests/unit/extension-*.test.ts` and `tests/unit/autofill-match.test.ts`).
  Plain JavaScript modules, no bundler.
- TenderOS endpoints used: `GET /api/autofill/profile`,
  `GET /api/autofill/documents/<id>`, `GET /api/autofill/tenders/<id>/apply-plan`
  and `POST /api/autofill/tenders/<id>/apply-report` (host and counts only).
