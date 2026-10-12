// TenderOS browser helper: popup. Connection state, a waiting "Apply with
// TenderOS" session for this tab, the tender picker, the "Fill this page"
// button and the summary of what was filled and what is left for you.
// Page-derived text is only ever set with textContent. The popup never holds
// the pairing code: it asks the background worker, which is the only place
// the code lives (a pasted code is passed straight on and cleared).

import { TENDEROS_ORIGIN } from "../src/config.js";
import { compareHosts } from "../src/hosts.js";
import { TOKEN_PATTERN } from "../src/protocol.js";

const $ = (id) => document.getElementById(id);
const SENSITIVE = new Set(["director_ids", "bank_confirmation", "proof_of_address"]);
let payload = null;
let activeTab = null;
let sessionInfo = null;

function show(id, visible) {
  $(id).hidden = !visible;
}

function setError(message) {
  $("error").textContent = message || "";
  show("error", Boolean(message));
}

function setStatus(message) {
  $("status").textContent = message || "";
  show("status", Boolean(message));
}

async function ask(message) {
  const res = await chrome.runtime.sendMessage({ source: "popup", ...message });
  if (!res) throw new Error("The helper did not answer. Reload the extension and try again.");
  if (!res.ok) throw new Error(res.error?.message ?? "Something went wrong.");
  return res.data;
}

function formatDate(iso) {
  try {
    return new Intl.DateTimeFormat("en-ZA", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Johannesburg" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function li(text, note) {
  const item = document.createElement("li");
  item.textContent = text;
  if (note) {
    const small = document.createElement("small");
    small.textContent = note;
    item.append(small);
  }
  return item;
}

function renderSummary(summary) {
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const left = [...summary.left.map((l) => li(l.label, l.reason)), ...(summary.unattached ?? []).map((u) => li(u.label, u.reason))];
  $("summary-title").textContent =
    `Filled ${n(summary.filled.length, "field", "fields")} and attached ${n(summary.attached.length, "file", "files")} on ${summary.page}`;
  $("filled-title").textContent = `Fields filled (${summary.filled.length})`;
  $("attached-title").textContent = `Files attached (${summary.attached.length})`;
  $("left-title").textContent = `Left for you (${left.length})`;
  $("filled").replaceChildren(...summary.filled.map((f) => li(f.label, `${f.what}${f.check ? " · check this one" : ""}`)));
  $("attached").replaceChildren(...summary.attached.map((a) => li(a.label, a.files.join(", "))));
  $("left").replaceChildren(...left);
  if (!summary.filled.length && !summary.attached.length && !left.length) {
    $("left").replaceChildren(li("No form fields found on this page.", "Open the portal's form, then try again."));
  }
  show("summary", true);
}

function renderBids() {
  const select = $("bid");
  const keep = select.value;
  select.replaceChildren(select.options[0]);
  for (const b of payload.bids) {
    const opt = document.createElement("option");
    opt.value = b.submission_id;
    opt.textContent = `${b.tender.reference_number ? `${b.tender.reference_number} · ` : ""}${b.tender.title}`.slice(0, 120);
    select.append(opt);
  }
  if ([...select.options].some((o) => o.value === keep)) select.value = keep;
  renderBidInfo();
}

function renderBidInfo() {
  const info = $("bid-info");
  info.replaceChildren();
  const bid = payload?.bids.find((b) => b.submission_id === $("bid").value);
  if (!bid) {
    info.textContent = payload?.bids.length
      ? "Pick a tender to fill its number and prefer the documents in its approved bid pack."
      : "No approved bids are waiting for delivery.";
    return;
  }
  const missing = bid.attachments.filter((a) => !a.available).length;
  info.append(`${bid.tender.issuing_organisation} · closes ${formatDate(bid.tender.closing_at)}.`);
  if (bid.tender.submission_destination) info.append(` Deliver to: ${bid.tender.submission_destination}.`);
  if (missing) info.append(` ${missing} bid pack document${missing === 1 ? " is" : "s are"} not available to the helper.`);
}

function tabHost() {
  try {
    return activeTab?.url ? new URL(activeTab.url).hostname : "";
  } catch {
    return "";
  }
}

function renderSession() {
  const s = sessionInfo;
  show("session", Boolean(s));
  if (!s) return;
  const here = tabHost();
  $("session-text").textContent =
    `TenderOS is ready to prepare "${s.tender}" on ${s.expectedHost}. Nothing is submitted: you check the form and submit it yourself.`;
  const mismatch = !here || compareHosts(s.expectedHost, here) === "different";
  show("session-confirm-row", mismatch);
  $("session-confirm-text").textContent = here
    ? `This tab is on ${here}, not ${s.expectedHost}. I am sure it is the right portal.`
    : "The helper cannot read this tab's address.";
  $("session-confirm").checked = false;
  $("session-fill").disabled = mismatch;
}

async function load() {
  setError("");
  let state;
  try {
    state = await ask({ action: "state", tabId: activeTab?.id ?? null });
  } catch (err) {
    setError(err.message);
    return;
  }
  sessionInfo = state.session;
  if (!state.pairing.paired) {
    $("paired").textContent = "Not connected.";
    show("connect", true);
    show("fill", false);
    show("session", false);
    return;
  }
  show("connect", false);
  setStatus("Loading your company details…");
  try {
    payload = await ask({ action: "load" });
  } catch (err) {
    setStatus("");
    setError(err.message);
    $("paired").textContent = "Connection needs attention.";
    show("connect", true);
    show("fill", false);
    return;
  }
  setStatus("");
  const role = payload.member?.role ?? "member";
  $("paired").textContent = `Connected to ${payload.organisation?.name ?? "your organisation"} as ${role}.`;
  const sensitiveDocs = payload.documents.some((d) => SENSITIVE.has(d.doc_type));
  show("sensitive-row", sensitiveDocs && (role === "owner" || role === "admin"));
  renderBids();
  renderSession();
  show("fill", true);
}

$("open-settings").addEventListener("click", () => {
  chrome.tabs.create({ url: `${TENDEROS_ORIGIN}/settings#browser-helper` });
});

$("save").addEventListener("click", async () => {
  setError("");
  const token = $("token").value.trim();
  if (!TOKEN_PATTERN.test(token)) {
    setError("Paste the whole pairing code. It starts with tos_ and is 68 characters long.");
    return;
  }
  $("save").disabled = true;
  try {
    await ask({ action: "pair", token });
    $("token").value = "";
    await load();
  } catch (err) {
    setError(err.message);
  } finally {
    $("save").disabled = false;
  }
});

$("forget").addEventListener("click", async () => {
  try {
    await ask({ action: "forget" });
  } catch (err) {
    setError(err.message);
    return;
  }
  payload = null;
  show("summary", false);
  await load();
});

$("bid").addEventListener("change", renderBidInfo);

$("session-confirm").addEventListener("change", () => {
  $("session-fill").disabled = !$("session-confirm").checked;
});

async function runFill(request, button) {
  setError("");
  if (!activeTab?.id) {
    setError("Open the tender portal's form in this tab first.");
    return;
  }
  button.disabled = true;
  setStatus("Filling… Nothing will be submitted.");
  try {
    renderSummary(await ask({ ...request, tabId: activeTab.id }));
  } catch (err) {
    setError(err.message);
  } finally {
    setStatus("");
    button.disabled = false;
    if (button === $("session-fill")) renderSession();
  }
}

$("fill-btn").addEventListener("click", () =>
  runFill({ action: "fill", submissionId: $("bid").value || null, includeSensitive: $("sensitive").checked }, $("fill-btn")),
);

$("session-fill").addEventListener("click", () => runFill({ action: "session_fill", confirmMismatch: $("session-confirm").checked }, $("session-fill")));

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab ?? null;
  $("page").textContent = tabHost() || "this tab";
  try {
    const { lastSummary } = await chrome.storage.session.get("lastSummary");
    const url = tab?.url ? new URL(tab.url) : null;
    if (lastSummary && url && lastSummary.tabId === tab.id && lastSummary.url === url.origin + url.pathname) renderSummary(lastSummary.summary);
  } catch {
    // No saved summary to show.
  }
  await load();
})();
