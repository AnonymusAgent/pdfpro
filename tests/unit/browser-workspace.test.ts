import { afterEach, describe, expect, it, vi } from "vitest";
import { guestWorkspaceRequest } from "@/lib/browser-workspace";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const data = new Map<string, string>();
  vi.stubGlobal("window", { location: { origin: "https://example.test" } });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  });
  return data;
}

describe("guest workspace fallback", () => {
  it("stores recent documents locally, updates stars and deletes only selected rows", () => {
    setup();
    const doc = guestWorkspaceRequest<{ document: { id: number } }>("/api/documents", {
      method: "POST", body: JSON.stringify({ name: "a.pdf", size: 42, pages: 2 }),
    })!.document;
    expect(doc.id).toBe(1);
    const starred = guestWorkspaceRequest<{ document: { starred: boolean } }>("/api/documents", {
      method: "PATCH", body: JSON.stringify({ id: doc.id, starred: true }),
    });
    expect(starred?.document.starred).toBe(true);
    expect(guestWorkspaceRequest<{ documents: unknown[] }>("/api/documents")?.documents).toHaveLength(1);
    expect(guestWorkspaceRequest("/api/documents?id=1", { method: "DELETE" })).toEqual({ ok: true });
    expect(guestWorkspaceRequest<{ documents: unknown[] }>("/api/documents")?.documents).toEqual([]);
  });

  it("keeps signatures and jobs on-device, never accepting a non-image signature", () => {
    const data = setup();
    expect(() => guestWorkspaceRequest("/api/signatures", { method: "POST", body: JSON.stringify({ dataUrl: "javascript:evil" }) })).toThrow();
    const saved = guestWorkspaceRequest<{ signature: { id: number } }>("/api/signatures", {
      method: "POST", body: JSON.stringify({ dataUrl: "data:image/png;base64,AA==", name: "my signature" }),
    });
    expect(saved?.signature.id).toBe(1);
    guestWorkspaceRequest("/api/jobs", { method: "POST", body: JSON.stringify({ kind: "merge", fileName: "private.pdf" }) });
    expect(guestWorkspaceRequest<{ jobs: unknown[] }>("/api/jobs")?.jobs).toHaveLength(1);
    expect([...data.keys()]).toEqual(expect.arrayContaining(["pdfpro-guest-workspace:signatures", "pdfpro-guest-workspace:jobs"]));
    expect(guestWorkspaceRequest("/api/admin/users")).toBeNull();
  });
});
