/* PDF Pro popup. Uses shared.js helpers. */
(function () {
  var MAX = PDFPRO.MAX_BYTES;
  function $(id) { return document.getElementById(id); }
  function showError(msg) {
    var el = $("error");
    el.textContent = msg || "";
    el.style.display = msg ? "block" : "none";
  }
  function status(msg) { $("status").textContent = msg || ""; }

  function openPage(path) {
    PDFPRO.baseUrl().then(function (base) {
      chrome.tabs.create({ url: base + path });
      window.close();
    }).catch(function (e) { showError(String(e.message || e)); });
  }

  $("open-editor").addEventListener("click", function () { openPage("/editor"); });
  $("convert").addEventListener("click", function () { openPage("/convert"); });
  $("ocr").addEventListener("click", function () { openPage("/ocr"); });
  $("open-file").addEventListener("click", function () { $("file-input").click(); });

  $("file-input").addEventListener("change", async function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    showError("");
    if (file.size > MAX) return showError("This PDF is larger than the 40 MB hand-off limit. Open it from the editor page instead.");
    try {
      var buf = await file.arrayBuffer();
      if (!PDFPRO.isPdfBytes(buf)) return showError("The selected file is not a PDF.");
      await PDFPRO.openInEditor(file.name.slice(0, 180), buf);
      window.close();
    } catch (err) {
      showError("Could not hand the file to PDF Pro: " + (err.message || err));
    }
  });

  function checkSiteAccess() {
    chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      var url = tabs && tabs[0] && tabs[0].url;
      if (!url || !/^https?:/.test(url)) return;
      var origin = new URL(url).origin;
      chrome.permissions.contains({ origins: [origin + "/*"] }).then(function (granted) {
        $("grant-wrap").hidden = granted;
        $("grant").onclick = function () {
          // Must run from a user gesture (this click) — Chrome shows its own consent dialog.
          chrome.permissions.request({ origins: [origin + "/*"] }).then(function (ok) {
            status(ok ? "Access granted for " + origin + "." : "Access was not granted.");
            $("grant-wrap").hidden = ok;
          });
        };
      });
    }).catch(function () {});
  }

  PDFPRO.baseUrl().then(function (base) { $("url").value = base; });
  $("save-url").addEventListener("click", function () {
    var value = $("url").value.trim();
    try {
      var u = new URL(value);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
    } catch (e) {
      return status("Enter a full http(s) address, for example https://pdfpro.example.com");
    }
    chrome.storage.sync.set({ pdfproUrl: new URL(value).origin }).then(function () {
      status("Saved. Note: add this origin to externally_connectable in manifest.json, then reload the extension.");
    });
  });

  chrome.storage.local.get(["pdfproLastError"]).then(function (r) {
    if (r.pdfproLastError && Date.now() - r.pdfproLastError.at < 60000) showError(r.pdfproLastError.message);
  });
  checkSiteAccess();
})();
