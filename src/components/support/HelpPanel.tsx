import { CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { PageTitle, Card } from "@/components/ui";

const SHORTCUTS: [string, string][] = [
  ["Ctrl/Cmd + Z", "Undo the last change (annotations, page order, rotation, crop)"],
  ["Ctrl/Cmd + Shift + Z  or  Ctrl + Y", "Redo"],
  ["Ctrl/Cmd + F", "Focus the find box; Enter runs the search, Enter again goes to the next result"],
  ["Ctrl/Cmd + S", "Open the export dialog"],
  ["Ctrl/Cmd + P", "Print the current edited document"],
  ["V / H / E / T / R / C", "Select, pan, edit text, add text, redact, crop tools"],
  ["Delete or Backspace", "Delete the selected annotation"],
  ["Double-click an annotation", "Edit its text"],
  ["Escape", "Clear selection and return to the Select tool"],
  ["← → / PageUp PageDown", "Previous / next page"],
  ["+ / −  and  0", "Zoom in / out, fit width"],
];

const STATUS: { label: string; state: "yes" | "partial" | "no"; text: string }[] = [
  { label: "PDF → DOCX (editable / layout)", state: "partial", text: "Paragraphs, headings, lists and tables from layout analysis; complex layouts are simplified. Layout mode embeds page images." },
  { label: "PDF → XLSX / CSV", state: "partial", text: "Tables are detected from text alignment; numeric cells become numbers. Ruled tables with merged cells may need review." },
  { label: "PDF → PPTX (editable / image)", state: "partial", text: "One slide per page at the same size. Editable text and tables, or full-page images." },
  { label: "PDF → TXT / MD / HTML / RTF / ODT / EPUB", state: "yes", text: "Text in reading order. EPUB and ODT are reflowable." },
  { label: "PDF → PNG / JPEG / TIFF / SVG", state: "yes", text: "Per-page renders (ZIP for multiple pages). SVG keeps selectable text over the image." },
  { label: "PDF → Searchable PDF", state: "partial", text: "Use the OCR workspace. Accuracy depends on the scan." },
  { label: "PDF → PDF/A", state: "no", text: "Requires a validated engine (not in this build)." },
  { label: "DOCX / XLSX / PPTX / TXT / MD / HTML / images → PDF", state: "partial", text: "Text, tables, images and positions are mapped; fonts and complex layout are approximated." },
  { label: "Legacy DOC / XLS / PPT → PDF", state: "no", text: "Requires LibreOffice (not configured). Save as the modern format first." },
  { label: "Edit existing PDF text", state: "partial", text: "Replacement overlay with a white cover. The original text remains beneath unless you use secure export." },
  { label: "Secure redaction", state: "yes", text: "Redacted pages are rasterized and verified by text extraction." },
  { label: "Password protection (AES-256)", state: "yes", text: "Open and permissions passwords via the standard PDF security handler." },
  { label: "Certificate-based digital signatures", state: "no", text: "Not included. Visual e-signatures only." },
  { label: "Bookmarks / forms in rebuilt output", state: "partial", text: "Rebuilt exports (after reordering or resizing) do not carry bookmarks or interactive form data yet." },
  { label: "Optional-content layers (toggle)", state: "no", text: "Layers are shown as stored; visibility toggles are not implemented." },
];

const ICON = { yes: CheckCircle2, partial: AlertTriangle, no: XCircle } as const;
const COLOR = { yes: "text-emerald-600", partial: "text-amber-600", no: "text-red-600" } as const;

export default function HelpPanel() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8">
      <PageTitle title="Help, shortcuts & limitations" description="What works, what is approximate, and what is not available in this build. Stated plainly so you can plan." />
      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Keyboard shortcuts">
          <ul className="divide-y text-sm dark:divide-slate-700">
            {SHORTCUTS.map(([k, v]) => (
              <li key={k} className="flex flex-col gap-1 py-2 sm:flex-row sm:justify-between sm:gap-4">
                <kbd className="w-fit rounded bg-slate-100 px-2 py-0.5 font-mono text-xs dark:bg-slate-800">{k}</kbd>
                <span className="text-slate-600 dark:text-slate-300">{v}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Working in the editor">
          <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-600 dark:text-slate-300">
            <li>Open a PDF (or the sample). Pages render lazily as you scroll.</li>
            <li>Pick a tool in the dark toolbar, then click or drag on the page. Properties appear at right.</li>
            <li>Reorder, rotate, duplicate, delete, extract or insert pages from the Pages panel.</li>
            <li>Undo and redo cover every change. Unsaved edits are autosaved in this browser.</li>
            <li>Export with <b>Export…</b>. The file is checked before download and the status shows Saved.</li>
          </ol>
        </Card>
      </div>
      <Card title="Capability status">
        <ul className="divide-y text-sm dark:divide-slate-700">
          {STATUS.map((s) => {
            const I = ICON[s.state];
            return (
              <li key={s.label} className="flex gap-3 py-3">
                <I size={18} className={`mt-0.5 shrink-0 ${COLOR[s.state]}`} aria-hidden />
                <div>
                  <p className="font-semibold">{s.label} <span className="ml-1 text-xs font-normal uppercase text-slate-500">{s.state === "yes" ? "supported" : s.state === "partial" ? "approximate" : "not available"}</span></p>
                  <p className="text-slate-600 dark:text-slate-300">{s.text}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
      <Card title="Limits you should know about">
        <ul className="list-disc space-y-2 pl-5 text-sm text-slate-600 dark:text-slate-300">
          <li><b>Existing text:</b> PDF text is positioned glyphs, not paragraphs. Replacing text covers the original with a white box and places new text. Only secure export removes the original text.</li>
          <li><b>Scanned pages:</b> no text layer until you run OCR. Search, text editing and text exports need OCR first.</li>
          <li><b>Compression:</b> lossless optimization keeps everything but saves little; raster presets shrink files by re-encoding pages as images.</li>
          <li><b>Encryption:</b> standard AES-256 PDF security. Permissions are advisory and some viewers ignore them.</li>
          <li><b>Signatures:</b> visual electronic signatures only; not certificate-based digital signatures.</li>
          <li><b>Large files:</b> the default limit is 100 MB (Settings). Very large documents render page by page and may take time to export.</li>
        </ul>
      </Card>
      <Card title="Privacy and security">
        <ul className="list-disc space-y-2 pl-5 text-sm text-slate-600 dark:text-slate-300">
          <li>Conversions, OCR, compression and editing run in your browser. The site does not upload your documents for these tools.</li>
          <li>The workspace database keeps only metadata (name, size, pages), settings, saved signatures you approved, and a processing log.</li>
          <li>Uploaded images and signatures are validated by type and size; file contents are never written to logs.</li>
          <li>Chrome extension: see the Extension page for its minimal permissions and how files are handed to the editor.</li>
        </ul>
      </Card>
    </div>
  );
}
