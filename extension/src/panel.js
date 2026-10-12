// TenderOS browser helper: the review panel on the portal page.
//
// Injected (as a plain script, in the extension's isolated world) into the top
// frame of a portal tab that "Apply with TenderOS" opened, or that the person
// chose to fill. It draws what the background worker gives it (the model comes
// from summary.js, which is unit-tested) inside a closed shadow root, so the
// portal's styles and scripts cannot reach it. Everything the page could
// influence (labels, file names) is set with textContent, never as HTML.
//
// The panel has buttons for the helper's own actions only: fill again, close,
// confirm or cancel a different site. It never clicks, submits or ticks
// anything on the portal itself. Button presses count only when they are real
// user clicks (event.isTrusted).
(() => {
  if (globalThis.__tenderosPanel) return;
  if (window !== window.top) return;

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel { position: fixed; top: 12px; right: 12px; z-index: 2147483647; width: min(380px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow: auto;
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111827; background: #ffffff; border: 1px solid #9ca3af; border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.28); padding: 12px 14px; }
    .panel:focus { outline: 3px solid #1d4ed8; outline-offset: 2px; }
    .brand { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 6px; }
    h2 { font-size: 15px; line-height: 1.35; margin: 0 0 2px; color: #111827; font-weight: 700; }
    .meta { margin: 0 0 8px; font-size: 12px; color: #4b5563; word-break: break-word; }
    .counts { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; padding: 0; list-style: none; }
    .counts li { border-radius: 999px; padding: 2px 9px; font-size: 12px; font-weight: 600; }
    .c-filled { background: #dcfce7; color: #14532d; }
    .c-left { background: #fef3c7; color: #78350f; }
    p.note { margin: 0 0 8px; font-size: 13px; color: #1f2937; }
    details { margin: 0 0 6px; border-top: 1px solid #e5e7eb; padding-top: 6px; }
    summary { cursor: pointer; font-weight: 600; font-size: 13px; }
    summary:focus-visible, button:focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
    ul.items { margin: 4px 0 2px; padding-left: 18px; font-size: 13px; }
    ul.items small { display: block; color: #4b5563; font-size: 12px; }
    .left summary { color: #78350f; }
    .reminders { margin: 8px 0; padding: 8px 10px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; }
    .reminders strong { display: block; font-size: 13px; color: #1e3a8a; margin-bottom: 2px; }
    .reminders ul { margin: 0; padding-left: 18px; font-size: 13px; color: #1f2937; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    button { font: inherit; font-weight: 600; border-radius: 8px; padding: 6px 12px; cursor: pointer; border: 1px solid #1d4ed8; background: #1d4ed8; color: #ffffff; }
    button.secondary { background: #ffffff; color: #1d4ed8; }
    button.mini { padding: 1px 8px; font-size: 12px; background: #ffffff; color: #1f2937; border-color: #9ca3af; }
    button:disabled { opacity: .6; cursor: default; }
    .error h2 { color: #991b1b; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .collapsed .body { display: none; }
    @media (prefers-color-scheme: dark) {
      .panel { background: #111827; color: #f3f4f6; border-color: #4b5563; }
      h2 { color: #f9fafb; } .brand, .meta, ul.items small { color: #d1d5db; } p.note, .reminders ul { color: #e5e7eb; }
      details { border-top-color: #374151; } .left summary { color: #fcd34d; } .error h2 { color: #fca5a5; }
      .reminders { background: #172554; border-color: #1e40af; } .reminders strong { color: #bfdbfe; }
      .c-filled { background: #14532d; color: #dcfce7; } .c-left { background: #78350f; color: #fef3c7; }
      button.secondary, button.mini { background: #111827; color: #bfdbfe; border-color: #60a5fa; }
    }
    @media (prefers-reduced-motion: no-preference) { .panel { transition: none; } }
  `;

  /** @type {HTMLElement | null} */
  let host = null;
  /** @type {ShadowRoot | null} */
  let root = null;
  let collapsed = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function act(id) {
    try {
      chrome.runtime.sendMessage({ source: "panel", action: id });
    } catch {
      // The extension was reloaded: the panel is stale. Closing it is all that is left to do.
      hide();
    }
    if (id === "close" || id === "cancel") hide();
  }

  function button(action, onlyOnce) {
    const b = el("button", action.id === "refill" || action.id === "confirm" ? "" : "secondary", action.label);
    b.type = "button";
    b.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      if (onlyOnce) b.disabled = true;
      act(action.id);
    });
    return b;
  }

  function list(items, render) {
    const ul = el("ul", "items");
    for (const item of items) {
      const li = document.createElement("li");
      render(li, item);
      ul.append(li);
    }
    return ul;
  }

  function section(title, count, body, className, open) {
    const d = el("details", className);
    d.open = open;
    d.append(el("summary", "", `${title} (${count})`), body);
    return d;
  }

  function ensureRoot() {
    if (host && host.isConnected && root) return root;
    host = document.createElement("div");
    host.setAttribute("data-tenderos-helper", "panel");
    root = host.attachShadow({ mode: "closed" });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement("style");
      style.textContent = STYLE;
      root.append(style);
    }
    (document.body || document.documentElement).append(host);
    return root;
  }

  function show(model) {
    const first = !(host && host.isConnected);
    const shadow = ensureRoot();
    for (const child of Array.from(shadow.children)) if (child.tagName !== "STYLE") child.remove();

    const panel = el("section", `panel ${model.mode === "error" ? "error" : ""} ${collapsed ? "collapsed" : ""}`);
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "TenderOS review panel");
    panel.tabIndex = -1;

    const brand = el("div", "brand");
    brand.append(el("span", "", "TenderOS browser helper"));
    const toggle = el("button", "mini", collapsed ? "Show" : "Hide");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      collapsed = !collapsed;
      show(model);
    });
    brand.append(toggle);
    panel.append(brand);

    const body = el("div", "body");
    const heading = el("h2", "", model.headline);
    heading.id = "tenderos-headline";
    panel.setAttribute("aria-labelledby", "tenderos-headline");
    body.append(heading);
    const meta = [model.tender, model.host].filter(Boolean).join(" · ");
    if (meta) body.append(el("p", "meta", meta));

    if (model.counts) {
      const counts = el("ul", "counts");
      counts.append(
        el("li", "c-filled", `${model.counts.filled} fields filled`),
        el("li", "c-filled", `${model.counts.attached} documents attached`),
        el("li", "c-left", `${model.counts.left} left for you`),
      );
      body.append(counts);
    }
    for (const note of model.notes) body.append(el("p", "note", note));

    if (model.filled.length) {
      body.append(
        section(
          "Fields filled",
          model.filled.length,
          list(model.filled, (li, f) => {
            li.append(document.createTextNode(f.label));
            li.append(el("small", "", f.check ? `${f.what} · check this one` : f.what));
          }),
          "",
          false,
        ),
      );
    }
    if (model.attached.length) {
      body.append(
        section(
          "Documents attached",
          model.attached.length,
          list(model.attached, (li, a) => {
            li.append(document.createTextNode(a.label));
            li.append(el("small", "", a.files.join(", ")));
          }),
          "",
          false,
        ),
      );
    }
    for (const group of model.groups) {
      body.append(
        section(
          group.title,
          group.items.length,
          list(group.items, (li, item) => {
            li.append(document.createTextNode(item.label));
            li.append(el("small", "", item.reason));
          }),
          "left",
          true,
        ),
      );
    }
    if (model.reminders.length) {
      const box = el("div", "reminders");
      box.append(el("strong", "", "Yours to do"));
      box.append(list(model.reminders, (li, text) => (li.textContent = text)));
      body.append(box);
    }

    const actions = el("div", "actions");
    for (const a of model.actions) actions.append(button(a, a.id === "confirm" || a.id === "cancel"));
    body.append(actions);
    panel.append(body);

    const live = el("div", "visually-hidden", model.headline);
    live.setAttribute("role", "status");
    panel.append(live);

    panel.addEventListener("keydown", (event) => {
      if (event.isTrusted && event.key === "Escape") act("close");
    });
    shadow.append(panel);
    if (first) panel.focus({ preventScroll: true });
  }

  function hide() {
    if (host) host.remove();
    host = null;
    root = null;
  }

  Object.defineProperty(globalThis, "__tenderosPanel", { value: Object.freeze({ show, hide }), configurable: false, writable: false });
})();
