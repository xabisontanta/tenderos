// TenderOS browser helper: content script.
//
// Injected only when the person clicks "Fill this page" in the helper or
// "Apply with TenderOS" in TenderOS (those clicks are the permission), and only
// into the top frame and same-origin frames of the page. It runs in the
// extension's isolated world, so the
// page cannot see these functions, the plan or the files. It reports the
// form fields it finds (never their contents), then fills the fields the
// background worker planned and attaches files.
//
// It never clicks a button, never submits a form, never ticks a box and
// never touches password fields. The person checks every field and submits.
(() => {
  if (globalThis.__tenderosHelper) return;

  const MAX_FIELDS = 400;
  const IGNORED_TYPES = new Set(["submit", "button", "reset", "image", "hidden"]);
  const NEVER_FILL_TYPES = new Set(["submit", "button", "reset", "image", "hidden", "checkbox", "radio", "password", "range", "color"]);
  const TEXT_TYPES = new Set(["", "text", "email", "tel", "url", "number", "date", "search"]);
  const FILLED = "#16a34a";
  const LEFT = "#f59e0b";

  /** @type {Element[]} */
  let fields = [];

  const clean = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim();
  const clip = (s, n = 200) => clean(s).slice(0, n);

  /** Text of an element without the text of form controls inside it. */
  function ownText(el) {
    if (!el) return "";
    if (el.nodeType === Node.TEXT_NODE) return clean(el.textContent);
    if (el.nodeType !== Node.ELEMENT_NODE) return "";
    const copy = el.cloneNode(true);
    for (const n of copy.querySelectorAll("input, select, textarea, button, option, script, style")) n.remove();
    return clean(copy.textContent);
  }

  function containsControl(node) {
    return node.nodeType === Node.ELEMENT_NODE && (node.matches("input, select, textarea") || node.querySelector("input, select, textarea"));
  }

  function visible(el) {
    if (el.type === "file") return true; // upload widgets often hide the real input behind a styled button
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  function collect(root, out) {
    for (const el of root.querySelectorAll("input, select, textarea")) out.push(el);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.shadowRoot) collect(n.shadowRoot, out);
  }

  function labelText(el) {
    const parts = [];
    for (const l of Array.from(el.labels || [])) parts.push(ownText(l));
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const root = el.getRootNode();
      for (const id of by.split(/\s+/)) {
        const n = root.getElementById ? root.getElementById(id) : document.getElementById(id);
        if (n) parts.push(ownText(n));
      }
    }
    return clip(parts.filter(Boolean).join(" | "), 300);
  }

  /** The text a person would read next to the field: the previous table cell, a preceding text node, or the legend. */
  function nearbyText(el) {
    const parts = [];
    const cell = el.closest("td, th");
    if (cell) {
      let prev = cell.previousElementSibling;
      while (prev && !ownText(prev)) prev = prev.previousElementSibling;
      if (prev && !containsControl(prev)) parts.push(ownText(prev));
    }
    if (!parts.length) {
      let node = el;
      outer: for (let depth = 0; depth < 3 && node && node.parentNode; depth++) {
        for (let sib = node.previousSibling; sib; sib = sib.previousSibling) {
          if (containsControl(sib)) break outer; // that text belongs to another field
          const t = ownText(sib);
          if (t) {
            parts.push(t);
            break outer;
          }
        }
        node = node.parentElement;
        if (node && (node.matches("form, fieldset, table, body") || node.querySelectorAll("input, select, textarea").length > 1)) break;
      }
    }
    const legend = el.closest("fieldset")?.querySelector("legend");
    if (legend) parts.push(ownText(legend));
    return clip(parts.join(" | "));
  }

  function inLoginForm(el) {
    const form = el.form || el.closest("form");
    if (!form || !form.querySelector('input[type="password"]')) return false;
    const textLike = Array.from(form.querySelectorAll("input")).filter((i) => TEXT_TYPES.has(i.type) && visible(i));
    return textLike.length <= 2;
  }

  function hasValue(el) {
    if (el.tagName === "SELECT") {
      const opt = el.options[el.selectedIndex];
      return el.selectedIndex > 0 && Boolean(opt) && !opt.defaultSelected;
    }
    if (el.type === "file") return Boolean(el.files && el.files.length);
    if (el.type === "checkbox" || el.type === "radio") return el.checked;
    return clean(el.value) !== "";
  }

  function describe(el, index) {
    const tag = el.tagName.toLowerCase();
    const d = {
      index,
      tag,
      type: tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : tag === "select" ? el.type : "textarea",
      name: clip(el.getAttribute("name"), 120),
      id: clip(el.id, 120),
      autocomplete: clip(el.getAttribute("autocomplete"), 60),
      placeholder: clip(el.getAttribute("placeholder"), 120),
      label: labelText(el),
      ariaLabel: clip(el.getAttribute("aria-label"), 200),
      nearby: nearbyText(el),
      inLoginForm: inLoginForm(el),
      hasValue: hasValue(el),
      multiple: Boolean(el.multiple),
      accept: clip(el.getAttribute("accept"), 200),
    };
    if (el.maxLength > 0) d.maxLength = el.maxLength;
    if (tag === "select")
      d.options = Array.from(el.options)
        .slice(0, 300)
        .map((o) => ({ text: clip(o.text, 120), value: clip(o.value, 120) }));
    return d;
  }

  /**
   * The helper works on the top frame and on frames from the same origin as it, never on a
   * frame from another origin (an ad, a widget, an embedded third-party form). The background
   * worker checks the origin reported by the scan again.
   */
  function sameOriginAsTop() {
    if (window === window.top) return true;
    try {
      return window.top.location.origin === window.location.origin;
    } catch {
      return false;
    }
  }

  function scan() {
    if (!sameOriginAsTop()) return null;
    const found = [];
    collect(document, found);
    fields = found
      .filter((el) => !IGNORED_TYPES.has((el.getAttribute("type") || "").toLowerCase()) && !el.disabled && !el.readOnly && visible(el))
      .slice(0, MAX_FIELDS);
    return { origin: window.location.origin, fields: fields.map(describe) };
  }

  function mark(el, colour) {
    const target = el.type === "file" && !(el.getBoundingClientRect().width > 0) ? (el.labels && el.labels[0]) || el.parentElement : el;
    if (!target || !target.style) return;
    target.style.setProperty("outline", `2px solid ${colour}`, "important");
    target.style.setProperty("outline-offset", "2px", "important");
  }

  function fire(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // The native setter updates the DOM value in a way framework-controlled
  // inputs (React and others) notice when the input event arrives.
  function setText(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    fire(el);
  }

  function setOption(el, optionIndex) {
    if (optionIndex < 0 || optionIndex >= el.options.length) throw new Error("option missing");
    el.selectedIndex = optionIndex;
    fire(el);
  }

  function bytesOf(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function setFiles(el, files) {
    const dt = new DataTransfer();
    for (const f of el.multiple ? files : files.slice(0, 1)) dt.items.add(new File([bytesOf(f.base64)], f.name, { type: f.type, lastModified: Date.now() }));
    el.files = dt.files;
    fire(el);
  }

  /**
   * Applies the background worker's plan to the fields found by the last scan.
   * Refuses anything that is not a plain text box, a select or a file upload.
   */
  function apply(steps, files, leftIndexes) {
    if (!sameOriginAsTop()) return { done: [], failed: steps.map((s) => ({ index: s.index, reason: "changed" })) };
    const done = [];
    const failed = [];
    for (const step of steps) {
      const el = fields[step.index];
      const type = el ? (el.getAttribute("type") || "").toLowerCase() : "";
      try {
        if (!el || !el.isConnected || el.disabled || el.readOnly) throw new Error("changed");
        if (step.action === "fill") {
          if (!(el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !NEVER_FILL_TYPES.has(type) && type !== "file"))) throw new Error("changed");
          setText(el, String(step.value));
        } else if (step.action === "select") {
          if (el.tagName !== "SELECT") throw new Error("changed");
          setOption(el, step.optionIndex);
        } else if (step.action === "attach") {
          if (el.tagName !== "INPUT" || type !== "file") throw new Error("changed");
          const chosen = step.documentIds.map((id) => files[id]).filter(Boolean);
          if (!chosen.length) {
            failed.push({ index: step.index, reason: "download_failed" });
            continue;
          }
          setFiles(el, chosen);
        } else {
          throw new Error("changed");
        }
        mark(el, FILLED);
        done.push(step.index);
      } catch {
        failed.push({ index: step.index, reason: "changed" });
      }
    }
    for (const i of leftIndexes) {
      const el = fields[i];
      if (el && el.isConnected) mark(el, LEFT);
    }
    return { done, failed };
  }

  Object.defineProperty(globalThis, "__tenderosHelper", { value: Object.freeze({ scan, apply }), configurable: false, writable: false });
})();
