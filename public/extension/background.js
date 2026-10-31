/*
 * PDF Pro — MV3 service worker.
 * - Context menu: "Open linked PDF in PDF Pro" / "Open this PDF in PDF Pro".
 * - Fetches the PDF only from origins the user allowed (optional host permission) or that
 *   answer without CORS restrictions, verifies the %PDF signature, then hands it to the editor.
 * - Answers hand-off requests ONLY from the PDF Pro web origins listed in manifest.externally_connectable.
 */
importScripts("shared.js");

var MENU_LINK = "pdfpro-open-link";
var MENU_PAGE = "pdfpro-open-page";

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({ id: MENU_LINK, title: "Open linked PDF in PDF Pro", contexts: ["link"] });
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: "Open this PDF in PDF Pro",
      contexts: ["page"],
      documentUrlPatterns: ["http://*/*.pdf", "https://*/*.pdf", "http://*/*.pdf?*", "https://*/*.pdf?*"],
    });
  });
});

function reportError(message) {
  chrome.storage.local.set({ pdfproLastError: { message: message, at: Date.now() } });
  chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
  chrome.action.setBadgeText({ text: "!" });
  setTimeout(function () { chrome.action.setBadgeText({ text: "" }); }, 8000);
}

function hasOriginAccess(origin) {
  return chrome.permissions.contains({ origins: [origin + "/*"] });
}

async function openPdfFromUrl(rawUrl) {
  var url;
  try { url = new URL(rawUrl); } catch (e) { throw new Error("The link is not a valid URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) PDF links can be opened in PDF Pro.");
  }
  var resp;
  try {
    resp = await fetch(url.href, { credentials: "omit", redirect: "follow", cache: "no-store" });
  } catch (e) {
    var granted = await hasOriginAccess(url.origin);
    throw new Error(granted
      ? "The PDF could not be downloaded. Check the link and try again."
      : "Access to " + url.origin + " is required. Open the PDF Pro toolbar popup and click \"Allow access\" for this site, then try again.");
  }
  if (!resp.ok) throw new Error("The server returned HTTP " + resp.status + ".");
  var declared = Number(resp.headers.get("content-length") || 0);
  if (declared > PDFPRO.MAX_BYTES) throw new Error("The PDF is larger than the 40 MB hand-off limit.");
  var buf = await resp.arrayBuffer();
  if (buf.byteLength > PDFPRO.MAX_BYTES) throw new Error("The PDF is larger than the 40 MB hand-off limit.");
  if (!PDFPRO.isPdfBytes(buf)) throw new Error("The link did not return a PDF file.");
  var last = "";
  try { last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || ""); } catch (e) { last = ""; }
  var name = (last || "download.pdf").slice(0, 180);
  if (!/\.pdf$/i.test(name)) name += ".pdf";
  await PDFPRO.openInEditor(name, buf);
}

chrome.contextMenus.onClicked.addListener(function (info) {
  var url = info.menuItemId === MENU_LINK ? info.linkUrl : info.pageUrl;
  if (!url) return;
  openPdfFromUrl(url).catch(function (err) { reportError(err.message || String(err)); });
});

// Web app → extension hand-off. Only externally_connectable origins can reach this listener,
// and we re-check the sender origin against the configured PDF Pro origin.
chrome.runtime.onMessageExternal.addListener(function (msg, sender, sendResponse) {
  (async function () {
    var base = await PDFPRO.baseUrl();
    var origin = sender.origin || (sender.url ? new URL(sender.url).origin : "");
    if (PDFPRO.allowedOrigins(base).indexOf(origin) === -1) {
      sendResponse({ ok: false, error: "Origin is not allowed to request files." });
      return;
    }
    if (msg && msg.type === "PDFPRO_PING") {
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
      return;
    }
    if (msg && msg.type === "PDFPRO_TAKE_HANDOFF" && typeof msg.id === "string" && /^[0-9a-f-]{36}$/i.test(msg.id)) {
      var rec = await PDFPRO.takePending(msg.id);
      if (!rec) { sendResponse({ ok: false, error: "This hand-off has expired. Open the file again from the browser." }); return; }
      sendResponse({ ok: true, name: rec.name, base64: PDFPRO.toBase64(rec.bytes) });
      return;
    }
    sendResponse({ ok: false, error: "Unknown request." });
  })().catch(function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); });
  return true;
});
