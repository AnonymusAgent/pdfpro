"use client";

import { useState } from "react";
import JSZip from "jszip";
import { Download, Puzzle, Radio } from "lucide-react";
import { Button, Card, Notice, PageTitle, inputCls, labelCls } from "@/components/ui";
import { downloadBytes } from "@/lib/browser";

const FILES = [
  "manifest.json",
  "background.js",
  "shared.js",
  "popup.html",
  "popup.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
];

const README = `PDF Pro browser extension (Manifest V3)

Install (developer mode):
1. Unzip this folder.
2. Open chrome://extensions and turn on "Developer mode".
3. Click "Load unpacked" and choose the unzipped folder.
4. Open the PDF Pro toolbar popup and set your PDF Pro address (for example http://localhost:3000).
5. Add that address to "externally_connectable" in manifest.json if you use another origin, then reload the extension.

Permissions:
- contextMenus: "Open linked PDF in PDF Pro" and "Open this PDF in PDF Pro" menu items.
- storage: remembers the PDF Pro address.
- activeTab: reads the current tab's address when you click the toolbar icon.
- optional site access: requested only when you click "Allow access" for a site, so the extension can download PDF links from that site.

Hand-off: the extension stores the PDF in its own IndexedDB and opens the editor with a one-time id. The web app asks the extension for the file once; the copy is then deleted.
`;

export default function ExtensionPanel() {
  const [busy, setBusy] = useState(false);
  const [extId, setExtId] = useState("");
  const [pingResult, setPingResult] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    try {
      const zip = new JSZip();
      for (const f of FILES) {
        const res = await fetch(`/extension/${f}`);
        if (!res.ok) throw new Error(`Missing extension file: ${f}`);
        zip.file(f, await res.arrayBuffer());
      }
      zip.file("README.txt", README);
      downloadBytes(await zip.generateAsync({ type: "uint8array" }), "pdf-pro-extension.zip", "application/zip");
    } catch (e) {
      setPingResult(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  };

  const ping = () => {
    setPingResult(null);
    const chromeApi = (globalThis as unknown as { chrome?: { runtime?: { sendMessage: (id: string, m: unknown, cb: (r: unknown) => void) => void; lastError?: { message?: string } } } }).chrome;
    const rt = chromeApi?.runtime;
    if (!rt?.sendMessage) {
      setPingResult("This browser is not Chrome with the extension available. Install the extension and open this page in Chrome.");
      return;
    }
    if (!/^[a-p]{32}$/.test(extId.trim())) {
      setPingResult("Enter the 32-character extension ID shown on chrome://extensions.");
      return;
    }
    rt.sendMessage(extId.trim(), { type: "PDFPRO_PING" }, (resp) => {
      if (rt.lastError) setPingResult(`No response: ${rt.lastError.message ?? "unknown error"}. Check the ID and that this origin is listed in externally_connectable.`);
      else setPingResult(`Connected. Extension version ${(resp as { version?: string })?.version ?? "unknown"}.`);
    });
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8">
      <PageTitle title="Chrome extension" description="A Manifest V3 extension that opens PDFs from links and pages in PDF Pro, and hands local files to the editor. Minimal permissions; no broad site access." />
      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Install in Chrome" icon={<Puzzle size={18} aria-hidden />}>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-600 dark:text-slate-300">
            <li>Download the extension ZIP and unzip it.</li>
            <li>Open <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">chrome://extensions</code>, turn on Developer mode.</li>
            <li>Choose <b>Load unpacked</b> and select the unzipped folder.</li>
            <li>Open the PDF Pro popup, enter this site&apos;s address and save.</li>
          </ol>
          <Button className="mt-4" variant="primary" onClick={download} disabled={busy}><Download size={14} /> {busy ? "Preparing…" : "Download extension ZIP"}</Button>
        </Card>
        <Card title="What it can do">
          <ul className="list-disc space-y-2 pl-5 text-sm text-slate-600 dark:text-slate-300">
            <li>Right-click a PDF link → <b>Open linked PDF in PDF Pro</b>.</li>
            <li>On a PDF page → <b>Open this PDF in PDF Pro</b>.</li>
            <li>Popup → open the full editor, convert, OCR, or pick a PDF from your computer.</li>
            <li>If a site blocks downloads from other origins, click <b>Allow access to this site</b> in the popup. Chrome asks you to confirm.</li>
          </ul>
          <Notice tone="info"><span>The extension cannot read pages, scripts or content of websites, and cannot access browser-internal pages such as chrome://. PDFs larger than 40 MB are not handed off.</span></Notice>
        </Card>
      </div>
      <Card title="Permissions" icon={<Radio size={18} aria-hidden />}>
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2 pr-3">Permission</th><th className="py-2">Why</th></tr></thead>
          <tbody className="divide-y dark:divide-slate-700">
            <tr><td className="py-2 pr-3 font-mono text-xs">contextMenus</td><td className="py-2">Adds the Open-in-PDF-Pro menu items.</td></tr>
            <tr><td className="py-2 pr-3 font-mono text-xs">storage</td><td className="py-2">Remembers the PDF Pro web address.</td></tr>
            <tr><td className="py-2 pr-3 font-mono text-xs">activeTab</td><td className="py-2">Reads the current tab address when you open the popup.</td></tr>
            <tr><td className="py-2 pr-3 font-mono text-xs">optional host access</td><td className="py-2">Requested per site, only when you click “Allow access”, so PDF links on that site can be downloaded.</td></tr>
          </tbody>
        </table>
      </Card>
      <Card title="Test the connection">
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">Paste the extension ID from chrome://extensions to check that this page can talk to the installed extension.</p>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <label><span className={labelCls}>Extension ID</span><input value={extId} onChange={(e) => setExtId(e.target.value)} placeholder="abcdefghijklmnopabcdefghijklmnop" className={inputCls} /></label>
          <Button className="self-end" onClick={ping}>Check connection</Button>
        </div>
        {pingResult && <div className="mt-3"><Notice tone={pingResult.startsWith("Connected") ? "success" : "warn"}>{pingResult}</Notice></div>}
      </Card>
    </div>
  );
}
