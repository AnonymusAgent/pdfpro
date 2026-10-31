"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BadgeCheck, EyeOff, KeyRound, Lock, PenLine, Trash2, Unlock, Type as TypeIcon, Upload } from "lucide-react";
import { useWorkspace } from "@/lib/store";
import { Button, Card, Notice, PageTitle, Spinner, inputCls, labelCls } from "@/components/ui";
import { apiJson, downloadBytes, formatBytes } from "@/lib/browser";
import { findInPage, getPageText, openPdf, releasePdf } from "@/lib/pdf/pdfjs";
import { encryptDocument, removePassword } from "@/lib/pdf/operations";
import { exportDocument } from "@/lib/pdf/document-export";
import { redactedUids } from "@/lib/pdf/export";
import { MIME_TYPES, verifyOutput } from "@/lib/pdf/validate";
import { uid, type Ann } from "@/lib/pdf/types";
import { setLocal, useLocal } from "@/lib/use-local";

type SavedSig = { id: number; name: string; dataUrl: string; kind: string; createdAt: string };
const SIG_KEY = "pdfpro-signature";

export default function SignSecurity() {
  const { active, notify, commit } = useWorkspace();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [typed, setTyped] = useState("Your Name");
  const [fontChoice, setFontChoice] = useState("'Brush Script MT', cursive");
  const [sigName, setSigName] = useState("My signature");
  const [consent, setConsent] = useState(false);
  const [saved, setSaved] = useState<SavedSig[]>([]);
  const activeSig = useLocal(SIG_KEY);
  const [pwFile, setPwFile] = useState<File | null>(null);
  const [owner, setOwner] = useState("");
  const [userPw, setUserPw] = useState("");
  const [perm, setPerm] = useState({ printing: true, copying: true, modifying: false, annotating: true, fillingForms: true });
  const [encFile, setEncFile] = useState<File | null>(null);
  const [unlockFile, setUnlockFile] = useState<File | null>(null);
  const [unlockPw, setUnlockPw] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    apiJson<{ signatures: SavedSig[] }>("/api/signatures").then((r) => setSaved(r.signatures)).catch(() => setSaved([]));
  }, []);

  /* ---- drawn signature ---- */
  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height };
  };
  const clearCanvas = () => {
    const c = canvasRef.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
  };
  const drawnDataUrl = () => {
    const c = canvasRef.current;
    if (!c) return "";
    // Trim to the strokes so placement sizes are sensible.
    const ctx = c.getContext("2d");
    const data = ctx?.getImageData(0, 0, c.width, c.height).data;
    if (!data) return "";
    let minX = c.width, minY = c.height, maxX = 0, maxY = 0, any = false;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (data[(y * c.width + x) * 4 + 3] > 10) {
        any = true;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    if (!any) return "";
    const pad = 8;
    const w = maxX - minX + 1 + pad * 2;
    const h = maxY - minY + 1 + pad * 2;
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d")?.drawImage(c, minX - pad, minY - pad, w, h, 0, 0, w, h);
    return out.toDataURL("image/png");
  };
  const typedDataUrl = () => {
    const c = document.createElement("canvas");
    c.width = 900;
    c.height = 240;
    const ctx = c.getContext("2d");
    if (!ctx) return "";
    ctx.font = `96px ${fontChoice}`;
    ctx.fillStyle = "#0b1f44";
    ctx.textBaseline = "middle";
    ctx.fillText(typed.slice(0, 40), 24, 120);
    return c.toDataURL("image/png");
  };

  const saveSignature = async (dataUrl: string, kind: string) => {
    if (!dataUrl) {
      notify("error", "Draw, type or upload a signature first.");
      return;
    }
    if (!consent) {
      notify("error", "Tick the consent box to save this signature. You can also use it without saving.");
      return;
    }
    try {
      const r = await apiJson<{ signature: SavedSig }>("/api/signatures", { method: "POST", body: JSON.stringify({ dataUrl, kind, name: sigName }) });
      setSaved((prev) => [r.signature, ...prev]);
      notify("success", "Signature saved to your workspace.");
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Could not save the signature.");
    }
  };

  const applySignature = (dataUrl: string) => {
    setLocal(SIG_KEY, dataUrl);
    notify("success", "This signature is now selected. Use the Signature tool in the editor and click a page to place it.");
  };

  const onUpload = (file: File) => {
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      notify("error", "Upload a PNG or JPEG image of your signature.");
      return;
    }
    if (file.size > 700_000) {
      notify("error", "Signature images must be 700 KB or smaller.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLocal(SIG_KEY, String(reader.result));
    reader.readAsDataURL(file);
  };

  const deleteSaved = async (id: number) => {
    await apiJson(`/api/signatures?id=${id}`, { method: "DELETE" }).catch(() => undefined);
    setSaved((prev) => prev.filter((s) => s.id !== id));
  };

  /* ---- protection ---- */
  const encrypt = async () => {
    const bytes = encFile ? new Uint8Array(await encFile.arrayBuffer()) : active ? new Uint8Array(active.bytes.slice(0)) : null;
    const name = encFile?.name ?? active?.name;
    if (!bytes || !name) return notify("error", "Choose a PDF, or open one in the editor.");
    if (owner.length < 4) return notify("error", "The owner password must be at least 4 characters.");
    setBusy(true);
    try {
      const out = await encryptDocument(bytes, { ownerPassword: owner, userPassword: userPw || undefined, permissions: perm });
      // Verify: an encrypted file with an open password must not open without it.
      if (userPw) {
        let openedWithoutPassword = false;
        try {
          const pdf = await openPdf(out);
          openedWithoutPassword = true;
          releasePdf(pdf);
        } catch {
          openedWithoutPassword = false;
        }
        if (openedWithoutPassword) throw new Error("Verification failed: the file opened without its password.");
      }
      const check = await verifyOutput("pdf", out);
      if (!check.ok && !userPw) throw new Error(check.error);
      const base = name.replace(/\.pdf$/i, "");
      downloadBytes(out, `${base}-protected.pdf`, MIME_TYPES.pdf);
      setResult(`Encrypted with AES-256 (standard PDF security). ${userPw ? "An open password is required." : "No open password — only the permissions are restricted."} Permissions are honored by compliant readers; some viewers ignore them.`);
      apiJson("/api/jobs", { method: "POST", body: JSON.stringify({ kind: "encrypt", fileName: name, inputSize: bytes.length, outputSize: out.length, message: userPw ? "open password set" : "permissions only" }) }).catch(() => undefined);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Encryption failed.");
    } finally {
      setBusy(false);
    }
  };

  const unlock = async () => {
    if (!unlockFile) return notify("error", "Choose the protected PDF.");
    if (!authorized) return notify("error", "Confirm that you are authorized to remove protection from this document.");
    setBusy(true);
    try {
      const bytes = new Uint8Array(await unlockFile.arrayBuffer());
      const out = await removePassword(bytes, unlockPw);
      const check = await verifyOutput("pdf", out);
      if (!check.ok) throw new Error(check.error);
      const pdf = await openPdf(out);
      releasePdf(pdf);
      downloadBytes(out, `${unlockFile.name.replace(/\.pdf$/i, "")}-unlocked.pdf`, MIME_TYPES.pdf);
      setResult("Protection removed and verified: the output opens without a password.");
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Could not remove the password.");
    } finally {
      setBusy(false);
    }
  };

  /* ---- redaction helpers on the open document ---- */
  const markPhrase = async () => {
    if (!active) return notify("error", "Open a document in the editor first.");
    if (!phrase.trim()) return notify("error", "Enter the text to redact.");
    setBusy(true);
    try {
      const added: Ann[] = [];
      const entries = active.edit.pages;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.src === "blank") continue;
        const pdf = active.pdfs[e.src];
        if (!pdf) continue;
        const pt = await getPageText(await pdf.getPage(e.index + 1));
        for (const h of findInPage(pt, phrase.trim(), i)) {
          for (const b of h.boxes) {
            added.push({ id: uid(), uid: e.uid, type: "redact", x: b.x, y: b.y, w: b.w, h: b.h, color: "#000000", fill: "#000000", opacity: 1, fontSize: 12 });
          }
        }
      }
      if (!added.length) {
        notify("info", `No matches for “${phrase}” (scanned pages need OCR first).`);
      } else {
        commit(active.id, { ...active.edit, anns: [...active.edit.anns, ...added] });
        notify("success", `${added.length} redaction mark(s) added to ${active.name}. Open the editor to review, then use Secure export.`);
      }
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  };

  const cleanMetadata = async () => {
    if (!active) return notify("error", "Open a document in the editor first.");
    setBusy(true);
    try {
      const out = await exportDocument(active, { sanitizeMetadata: true, metadata: {} }, { secure: false, edit: { pages: active.edit.pages.map((p) => ({ ...p })), anns: active.edit.anns } });
      const check = await verifyOutput("pdf", out.bytes);
      if (!check.ok) throw new Error(check.error);
      downloadBytes(out.bytes, `${active.name.replace(/\.pdf$/i, "")}-clean.pdf`, MIME_TYPES.pdf);
      setResult(`Exported with creator/producer details removed and verified (${check.detail}). Note: the rebuilt file drops bookmarks and interactive form data.`);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  };

  const redactCount = active ? redactedUids({ pages: active.edit.pages, anns: active.edit.anns }).length : 0;
  const redactMarks = active ? active.edit.anns.filter((a) => a.type === "redact").length : 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <PageTitle title="Sign & secure" description="Visual electronic signatures, standard PDF password protection, and secure redaction. Certificate-based digital signatures are not included in this version." />
      <Notice tone="info">
        <span className="flex items-start gap-2"><BadgeCheck size={16} className="mt-0.5 shrink-0" aria-hidden /> <span><b>Electronic signature ≠ digital signature.</b> A signature image placed on a page shows who signed visually. It does not cryptographically prove identity or detect later changes. Certificate-based (PKCS#7/PAdES) signing needs a signing certificate and a validation service, which this build does not include.</span></span>
      </Notice>
      {result && <div className="mt-4"><Notice tone="success">{result}</Notice></div>}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="1. Create a signature" icon={<PenLine size={18} aria-hidden />}>
          <p className="mb-2 text-sm text-slate-600 dark:text-slate-300">Draw below with a mouse, pen or finger.</p>
          <canvas
            ref={canvasRef}
            width={600}
            height={200}
            aria-label="Signature drawing area"
            className="w-full touch-none rounded-xl border-2 border-dashed border-slate-300 bg-white"
            onPointerDown={(e) => {
              drawing.current = true;
              const ctx = canvasRef.current?.getContext("2d");
              if (!ctx) return;
              const p = pos(e);
              ctx.lineWidth = 3.5;
              ctx.lineCap = "round";
              ctx.strokeStyle = "#0b1f44";
              ctx.beginPath();
              ctx.moveTo(p.x, p.y);
            }}
            onPointerMove={(e) => {
              if (!drawing.current) return;
              const ctx = canvasRef.current?.getContext("2d");
              if (!ctx) return;
              const p = pos(e);
              ctx.lineTo(p.x, p.y);
              ctx.stroke();
            }}
            onPointerUp={() => (drawing.current = false)}
            onPointerLeave={() => (drawing.current = false)}
          />
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={clearCanvas}>Clear</Button>
            <Button size="sm" variant="primary" onClick={() => applySignature(drawnDataUrl())}>Use drawn signature</Button>
          </div>

          <div className="mt-5 space-y-2">
            <label className="block"><span className={labelCls}>Typed signature</span>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} className={inputCls} />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="Signature style" value={fontChoice} onChange={(e) => setFontChoice(e.target.value)} className={inputCls + " !w-auto"}>
                <option value="'Brush Script MT', cursive">Script</option>
                <option value="Georgia, serif">Serif italic</option>
                <option value="'Courier New', monospace">Typewriter</option>
              </select>
              <Button size="sm" variant="primary" onClick={() => applySignature(typedDataUrl())}><TypeIcon size={14} /> Use typed signature</Button>
            </div>
          </div>

          <label className="mt-5 block text-sm"><span className={labelCls}>Upload signature image (PNG or JPEG, up to 700 KB)</span>
            <span className="flex items-center gap-2"><Upload size={16} aria-hidden /><input type="file" accept="image/png,image/jpeg" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ""; }} aria-label="Upload signature image" className="text-xs" /></span>
          </label>

          <div className="mt-5 rounded-xl bg-slate-50 p-3 dark:bg-slate-800">
            <p className="text-xs font-semibold">Selected for placement</p>
            {activeSig ? <img src={activeSig} alt="Selected signature" className="mt-2 h-16 object-contain" /> : <p className="text-xs text-slate-500">None yet.</p>}
            <p className="mt-2 text-xs text-slate-500">Stored only in this browser until you save it. Open the editor, choose the Signature tool and click where the signature belongs.</p>
            <Link href="/editor" className="mt-2 inline-block text-sm font-semibold text-blue-600">Go to editor →</Link>
          </div>

          <div className="mt-5 space-y-2 border-t pt-4 dark:border-slate-700">
            <label className="block"><span className={labelCls}>Name for saved signature</span><input value={sigName} onChange={(e) => setSigName(e.target.value)} className={inputCls} /></label>
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
              I agree to store this signature image in my PDF Pro workspace database so I can reuse it on other devices. I can delete it at any time. Saving is optional.
            </label>
            <Button size="sm" onClick={() => saveSignature(activeSig ?? drawnDataUrl() ?? "", "draw")} disabled={!consent}>Save signature</Button>
          </div>

          {saved.length > 0 && (
            <ul className="mt-4 space-y-2">
              {saved.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 rounded-lg border p-2 dark:border-slate-700">
                  <img src={s.dataUrl} alt={s.name} className="h-10 max-w-[160px] object-contain" />
                  <span className="flex gap-1">
                    <Button size="sm" onClick={() => applySignature(s.dataUrl)}>Use</Button>
                    <Button size="sm" variant="danger" onClick={() => deleteSaved(s.id)} aria-label={`Delete ${s.name}`}><Trash2 size={13} /></Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-6">
          <Card title="2. Password-protect a PDF" icon={<Lock size={18} aria-hidden />}>
            <label className="block text-sm"><span className={labelCls}>PDF (defaults to the open document)</span>
              <input type="file" accept=".pdf,application/pdf" onChange={(e) => setEncFile(e.target.files?.[0] ?? null)} className="text-xs" />
            </label>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="block"><span className={labelCls}>Owner password (required, ≥4 chars)</span><input type="password" autoComplete="new-password" value={owner} onChange={(e) => setOwner(e.target.value)} className={inputCls} /></label>
              <label className="block"><span className={labelCls}>Open password (optional)</span><input type="password" autoComplete="new-password" value={userPw} onChange={(e) => setUserPw(e.target.value)} className={inputCls} /></label>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-1 text-xs">
              {(Object.keys(perm) as (keyof typeof perm)[]).map((k) => (
                <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={perm[k]} onChange={(e) => setPerm({ ...perm, [k]: e.target.checked })} /> Allow {k === "fillingForms" ? "form filling" : k}</label>
              ))}
            </div>
            <Button className="mt-4" variant="primary" onClick={encrypt} disabled={busy}>{busy ? <Spinner label="Encrypting…" /> : <><KeyRound size={14} /> Encrypt and verify</>}</Button>
            <p className="mt-2 text-xs text-slate-500">Uses AES-256 from the standard PDF security handler. Permissions are advisory: they are enforced by compliant readers only. Store the owner password safely; it cannot be recovered.</p>
          </Card>

          <Card title="3. Remove a password" icon={<Unlock size={18} aria-hidden />}>
            <Notice tone="warn">Only remove protection from documents you are authorized to change. You must know the current password.</Notice>
            <div className="mt-3 space-y-3">
              <input type="file" accept=".pdf,application/pdf" onChange={(e) => setUnlockFile(e.target.files?.[0] ?? null)} className="text-xs" aria-label="Protected PDF" />
              <input type="password" placeholder="Current password" autoComplete="off" value={unlockPw} onChange={(e) => setUnlockPw(e.target.value)} className={inputCls} aria-label="Current password" />
              <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} className="mt-0.5" /> I confirm I am authorized to remove protection from this file.</label>
              <Button variant="primary" onClick={unlock} disabled={busy}>Remove password and verify</Button>
            </div>
          </Card>

          <Card title="4. Secure redaction" icon={<EyeOff size={18} aria-hidden />}>
            <p className="text-sm text-slate-600 dark:text-slate-300">Black boxes alone are not redaction. Secure export rasterizes each redacted page, so covered text is removed from the file, and the output is checked to confirm the words cannot be extracted.</p>
            <div className="mt-3 flex gap-2">
              <input value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder="Find and mark every occurrence of…" aria-label="Phrase to redact" className={inputCls} />
              <Button onClick={markPhrase} disabled={busy || !active}>Mark</Button>
            </div>
            <p className="mt-2 text-xs text-slate-500">Marks are added to the open document ({active ? active.name : "none open"}). {redactMarks} mark(s) in total, {redactCount} page(s). Review them in the editor, then choose “Apply secure redaction &amp; export”.</p>
            <Link href="/editor" className="mt-3 inline-block text-sm font-semibold text-blue-600">Open editor →</Link>
          </Card>

          <Card title="5. Clean metadata" icon={<KeyRound size={18} aria-hidden />}>
            <p className="text-sm text-slate-600 dark:text-slate-300">Creates a copy of the open document without creator and producer details. Metadata that the rebuilt file does not carry (XMP packets, tool history) is dropped.</p>
            <Button className="mt-3" onClick={cleanMetadata} disabled={busy || !active}>Export clean copy</Button>
            {active && <p className="mt-2 text-xs text-slate-500">Size of open document: {formatBytes(active.size)}</p>}
          </Card>
        </div>
      </div>
    </div>
  );
}
