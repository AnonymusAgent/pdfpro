"use client";

import { useEffect, useState } from "react";
import { Save, Shield } from "lucide-react";
import { useWorkspace } from "@/lib/store";
import { DEFAULT_SETTINGS, applyTheme, apiJson, loadSettings, saveSettings, formatBytes, type LocalSettings } from "@/lib/browser";
import { Button, Card, Notice, PageTitle, inputCls, labelCls } from "@/components/ui";
import { OCR_LANGUAGES } from "@/lib/pdf/ocr";

export default function SettingsPanel() {
  const { notify } = useWorkspace();
  const [s, setS] = useState<LocalSettings>(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [usage, setUsage] = useState<string>("");
  const [serverNote, setServerNote] = useState<string>("");

  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => {
      if (e.usage !== undefined && e.quota) setUsage(`${formatBytes(e.usage)} used of ${formatBytes(e.quota)} available to this site`);
    });
    apiJson<{ settings: Record<string, unknown> }>("/api/settings")
      .then((r) => {
        const merged = { ...loadSettings(), ...(r.settings as Partial<LocalSettings>) };
        setS(merged);
        setServerNote("Loaded from your workspace database.");
      })
      .catch(() => {
        setS(loadSettings());
        setServerNote("Workspace database unavailable — settings are kept in this browser only.");
      });
  }, []);

  const set = <K extends keyof LocalSettings>(k: K, v: LocalSettings[K]) => setS((prev) => ({ ...prev, [k]: v }));

  const save = async () => {
    if (s.maxFileMB < 1 || s.maxFileMB > 500) return notify("error", "Maximum file size must be between 1 and 500 MB.");
    if (s.defaultZoom < 25 || s.defaultZoom > 400) return notify("error", "Default zoom must be between 25% and 400%.");
    setSaving(true);
    saveSettings(s);
    applyTheme(s.theme);
    try {
      await apiJson("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ theme: s.theme, defaultZoom: s.defaultZoom, defaultView: s.defaultView, maxFileMB: s.maxFileMB, autosave: s.autosave, ocrLang: s.ocrLang }),
      });
      notify("success", "Settings saved in this browser and in your workspace.");
    } catch (e) {
      notify("info", `Saved in this browser. The workspace database did not accept the change: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <PageTitle title="Settings" description="Preferences are stored in this browser. Shared preferences are also saved to your workspace database when it is available." />
      <div className="space-y-6">
        <Card title="Appearance and editor">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block"><span className={labelCls}>Theme</span>
              <select className={inputCls} value={s.theme} onChange={(e) => { const t = e.target.value as "light" | "dark"; set("theme", t); applyTheme(t); }}>
                <option value="light">Light</option><option value="dark">Dark</option>
              </select>
            </label>
            <label className="block"><span className={labelCls}>Default zoom (%)</span>
              <input type="number" min={25} max={400} className={inputCls} value={s.defaultZoom} onChange={(e) => set("defaultZoom", Number(e.target.value))} />
            </label>
            <label className="block"><span className={labelCls}>Default view</span>
              <select className={inputCls} value={s.defaultView} onChange={(e) => set("defaultView", e.target.value as LocalSettings["defaultView"])}>
                <option value="continuous">Continuous scrolling</option><option value="single">Single page</option><option value="two-page">Two pages</option>
              </select>
            </label>
            <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={s.autosave} onChange={(e) => set("autosave", e.target.checked)} /> Autosave unsaved edits in this browser (recovery)</label>
          </div>
        </Card>
        <Card title="Files and OCR">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block"><span className={labelCls}>Maximum file size (MB)</span>
              <input type="number" min={1} max={500} className={inputCls} value={s.maxFileMB} onChange={(e) => set("maxFileMB", Number(e.target.value))} />
              <span className="mt-1 block text-xs text-slate-500">Larger files are rejected before processing to protect memory.</span>
            </label>
            <label className="block"><span className={labelCls}>Default OCR language</span>
              <select className={inputCls} value={s.ocrLang} onChange={(e) => set("ocrLang", e.target.value)}>
                {OCR_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </label>
          </div>
        </Card>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={save} disabled={saving}><Save size={14} /> Save settings</Button>
          <Button variant="ghost" onClick={() => { setS(DEFAULT_SETTINGS); }}>Reset to defaults</Button>
          {serverNote && <span className="text-xs text-slate-500">{serverNote}</span>}
        </div>
        <Card title="Storage and privacy" icon={<Shield size={18} aria-hidden />}>
          <ul className="list-disc space-y-2 pl-5 text-sm text-slate-600 dark:text-slate-300">
            <li>{usage || "Storage usage is not available in this browser."}</li>
            <li>Documents are processed in your browser. They are not uploaded for the tools on this site.</li>
            <li>The workspace database stores only file names, sizes, page counts, settings, signatures you chose to save, and a short processing log.</li>
            <li>Recovery copies live in IndexedDB until you export, discard them, or clear them on the Recent page.</li>
          </ul>
        </Card>
        <Notice tone="info">OCR language packs other than English are downloaded from the jsDelivr CDN the first time they are used. The download contains only language data, never your documents.</Notice>
      </div>
    </div>
  );
}
