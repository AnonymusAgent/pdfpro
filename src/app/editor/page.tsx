import type { Metadata } from "next";
import { Suspense } from "react";
import EditorWorkspace from "@/components/editor/EditorWorkspace";

export const metadata: Metadata = { title: "Editor" };

export default function EditorPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-slate-500">Loading editor…</div>}>
      <EditorWorkspace />
    </Suspense>
  );
}
