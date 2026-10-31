/*
 * PDF Pro extension — shared helpers for the service worker and the popup.
 * Hand-off storage lives in the extension's own IndexedDB. Document content is never logged.
 */
var PDFPRO = (function () {
  var DB_NAME = "pdfpro-extension";
  var STORE = "pending";
  var DEFAULT_URL = "http://localhost:3000";
  var MAX_BYTES = 40 * 1024 * 1024;
  var TTL_MS = 15 * 60 * 1000;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function run(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var req = fn(tx.objectStore(STORE));
        tx.oncomplete = function () { db.close(); resolve(req ? req.result : undefined); };
        tx.onerror = function () { db.close(); reject(tx.error); };
        tx.onabort = function () { db.close(); reject(tx.error || new Error("IndexedDB aborted")); };
      });
    });
  }

  function putPending(id, rec) {
    return run("readwrite", function (s) { return s.put(Object.assign({ id: id }, rec)); });
  }

  function takePending(id) {
    return run("readonly", function (s) { return s.get(id); }).then(function (rec) {
      if (!rec) return null;
      return run("readwrite", function (s) { return s.delete(id); }).then(function () { return rec; });
    });
  }

  function cleanup() {
    return run("readonly", function (s) { return s.getAll(); }).then(function (rows) {
      var now = Date.now();
      return Promise.all((rows || []).filter(function (r) { return now - r.createdAt > TTL_MS; })
        .map(function (r) { return run("readwrite", function (s) { return s.delete(r.id); }); }));
    });
  }

  function baseUrl() {
    return chrome.storage.sync.get(["pdfproUrl"]).then(function (r) {
      return String(r.pdfproUrl || DEFAULT_URL).replace(/\/$/, "");
    });
  }

  function isPdfBytes(buf) {
    var u = new Uint8Array(buf, 0, Math.min(buf.byteLength, 1024));
    for (var i = 0; i + 4 < u.length; i++) {
      if (u[i] === 0x25 && u[i + 1] === 0x50 && u[i + 2] === 0x44 && u[i + 3] === 0x46 && u[i + 4] === 0x2d) return true;
    }
    return false;
  }

  function toBase64(buf) {
    var bytes = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  /** Stores the PDF for the web app to pick up, then opens the editor tab with a hand-off id. */
  function openInEditor(name, buf) {
    var id = crypto.randomUUID();
    return cleanup()
      .catch(function () {})
      .then(function () { return putPending(id, { name: name, bytes: buf, createdAt: Date.now() }); })
      .then(function () { return baseUrl(); })
      .then(function (base) {
        return chrome.tabs.create({ url: base + "/editor?handoff=" + id + "&ext=" + chrome.runtime.id });
      });
  }

  function allowedOrigins(base) {
    return [new URL(base).origin, "http://localhost:3000", "http://127.0.0.1:3000"];
  }

  return {
    MAX_BYTES: MAX_BYTES,
    DEFAULT_URL: DEFAULT_URL,
    baseUrl: baseUrl,
    takePending: takePending,
    isPdfBytes: isPdfBytes,
    toBase64: toBase64,
    openInEditor: openInEditor,
    allowedOrigins: allowedOrigins,
  };
})();
