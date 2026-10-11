// TenderOS browser helper: content script for the TenderOS site (see manifest
// content_scripts: it matches the TenderOS origin and nothing else).
//
// Content scripts cannot use import statements, so this loads the bridge as a
// module from the extension's own files. The module is listed in
// web_accessible_resources for the TenderOS origin only.
(async () => {
  try {
    const { startBridge } = await import(chrome.runtime.getURL("src/bridge-main.js"));
    startBridge();
  } catch {
    // The extension was reloaded or the page is not allowed to load it: the page simply sees no helper.
  }
})();
