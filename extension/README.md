# TenderOS browser helper

A Chrome and Edge extension that fills tender portal forms with your
company's details from TenderOS and attaches your verified company documents.
**It fills; you submit.** You check every field and press the portal's submit
button yourself.

## Safety rules

The helper is a person's tool, not an agent. It only acts when you click
**Fill this page**, only on the tab you are looking at, and:

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

Fields it fills are outlined in green; fields it left for you are outlined in
amber. The popup lists every field it filled, every file it attached and every
field left for you with the reason.

Director ID copies, bank letters and proof of address are only available to
owners and admins, and only attached when you tick the option for that fill.

## Install (unpacked)

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this `extension` folder.
4. Pin **TenderOS browser helper** to the toolbar.

## Pair it with TenderOS

1. In TenderOS, open **Settings → Browser helper** (owners, admins and
   operators) and click **Create pairing code**. Copy the code; it is shown
   once.
2. Click the helper icon, enter your TenderOS address (for example
   `https://tenderos-six.vercel.app`) and paste the code. Click **Save**.
   For a self-hosted TenderOS on another https address, the helper asks your
   browser for permission to reach that address.
3. Codes last 30 days. Revoke a code on the same Settings card at any time;
   removing a member from the organisation revokes theirs.

## Fill a form

1. Open the portal's form (sign in to the portal yourself first).
2. Click the helper icon. Optionally pick the tender from **bids awaiting
   delivery**: the helper then fills the tender or bid number and prefers the
   documents listed in that bid's approved bid pack.
3. Click **Fill this page**. Read the summary, check every field on the page,
   complete what was left for you, then submit it yourself. In TenderOS,
   record the delivery on the tender page.

## How it works

- `src/background.js` (service worker) makes every request to TenderOS with
  the pairing code, so the code never enters a web page. It reads
  `GET /api/autofill/profile` and, for each file, `GET /api/autofill/documents/<id>`.
- `src/content.js` is injected into the current tab only when you click
  **Fill this page**. It runs in the extension's isolated world, reports the
  form fields it sees (labels, names, types; never their contents), and
  applies the plan. It works in same-origin frames too.
- `src/match.js` decides what each field asks for. It is a pure module with
  unit tests in `tests/unit/autofill-match.test.ts`; the skip rules for
  declarations, signatures, prices, passwords, security checks and ID numbers
  run before any match.
- The pairing code is kept in `chrome.storage.local` on this computer only.
  **Forget pairing** removes it.

Plain JavaScript modules, no build step. After changing a file, click the
reload icon on the extension's card in `chrome://extensions`.
