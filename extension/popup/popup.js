// TenderOS browser helper: popup. Pairing, the tender picker, the "Fill this
// page" button and the summary of what was filled and what is left for you.
// Page-derived text is only ever set with textContent.

import { BUILT_IN_SERVERS, DEFAULT_SERVER, HelperError, TOKEN_PATTERN, getSettings, normaliseServer } from "../src/api.js";

const $ = (id) => document.getElementById(id);
const SENSITIVE = new Set(["director_ids", "bank_confirmation", "proof_of_address"]);
let payload = null;
let activeTab = null;

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

function ask(message) {
  return chrome.runtime.sendMessage(message).then((res) => {
    if (!res) throw new HelperError("The helper did not answer. Reload the extension and try again.");
    if (!res.ok) throw new HelperError(res.error);
    return res.data;
  });
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
  $("summary-title").textContent =
    `Filled ${n(summary.filled.length, "field", "fields")} and attached ${n(summary.attached.length, "file", "files")} on ${summary.page}`;
  $("filled-title").textContent = `Fields filled (${summary.filled.length})`;
  $("attached-title").textContent = `Files attached (${summary.attached.length})`;
  $("left-title").textContent = `Left for you (${summary.left.length})`;
  $("filled").replaceChildren(...summary.filled.map((f) => li(f.label, `${f.what}${f.check ? " · check this one" : ""}`)));
  $("attached").replaceChildren(...summary.attached.map((a) => li(a.label, a.files.join(", "))));
  $("left").replaceChildren(...summary.left.map((l) => li(l.label, l.reason)));
  if (!summary.filled.length && !summary.attached.length && !summary.left.length) {
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
  if (/^https?:\/\//.test(bid.tender.source_url || "")) {
    const a = document.createElement("a");
    a.href = bid.tender.source_url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = " Open the tender notice";
    info.append(a);
  }
}

async function load() {
  setError("");
  const settings = await getSettings();
  $("server").value = settings.server;
  if (!settings.token) {
    $("paired").textContent = "Not paired yet.";
    show("setup", true);
    show("fill", false);
    return;
  }
  setStatus("Loading your company details…");
  try {
    payload = await ask({ type: "load" });
  } catch (err) {
    setStatus("");
    setError(err.message);
    $("paired").textContent = `Server: ${new URL(settings.server).host}`;
    show("setup", true);
    show("fill", false);
    return;
  }
  setStatus("");
  const role = payload.member?.role ?? "member";
  $("paired").textContent = `Paired with ${payload.organisation?.name ?? "your organisation"} as ${role}.`;
  const sensitiveDocs = payload.documents.some((d) => SENSITIVE.has(d.doc_type));
  show("sensitive-row", sensitiveDocs && (role === "owner" || role === "admin"));
  renderBids();
  show("setup", false);
  show("fill", true);
}

$("save").addEventListener("click", async () => {
  setError("");
  let origin;
  try {
    origin = normaliseServer($("server").value || DEFAULT_SERVER);
  } catch (err) {
    setError(err.message);
    return;
  }
  const token = $("token").value.trim();
  if (!TOKEN_PATTERN.test(token)) {
    setError("Paste the whole pairing code. It starts with tos_ and is 68 characters long.");
    return;
  }
  // A self-hosted TenderOS needs its own host permission; ask while the click still counts.
  if (!BUILT_IN_SERVERS.includes(origin)) {
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    } catch {
      granted = false;
    }
    if (!granted) {
      setError(`The helper needs permission to talk to ${new URL(origin).host}.`);
      return;
    }
  }
  await chrome.storage.local.set({ server: origin, token });
  $("token").value = "";
  await load();
});

$("forget").addEventListener("click", async () => {
  await chrome.storage.local.remove("token");
  payload = null;
  setError("");
  show("summary", false);
  await load();
});

$("change").addEventListener("click", () => {
  show("setup", true);
  $("token").focus();
});

$("bid").addEventListener("change", renderBidInfo);

$("fill-btn").addEventListener("click", async () => {
  setError("");
  if (!activeTab?.id) {
    setError("Open the tender portal's form in this tab first.");
    return;
  }
  $("fill-btn").disabled = true;
  setStatus("Filling… Nothing will be submitted.");
  try {
    const summary = await ask({
      type: "fill",
      tabId: activeTab.id,
      submissionId: $("bid").value || null,
      includeSensitive: $("sensitive").checked,
    });
    renderSummary(summary);
  } catch (err) {
    setError(err.message);
  } finally {
    setStatus("");
    $("fill-btn").disabled = false;
  }
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab ?? null;
  let here = "";
  try {
    here = tab?.url ? new URL(tab.url).host : "";
  } catch {
    here = "";
  }
  $("page").textContent = here || "this tab";
  try {
    const { lastSummary } = await chrome.storage.session.get("lastSummary");
    const url = tab?.url ? new URL(tab.url) : null;
    if (lastSummary && url && lastSummary.tabId === tab.id && lastSummary.url === url.origin + url.pathname) renderSummary(lastSummary.summary);
  } catch {
    // No saved summary to show.
  }
  await load();
})();
