import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Client, createUser, db, purgeTestUsers, resetRateLimits, uniqueEmail } from "./helpers";

const cleanup: { documentIds: number[]; signatureIds: number[]; jobIds: number[]; scopes: string[] } = {
  documentIds: [], signatureIds: [], jobIds: [], scopes: [],
};
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==";

beforeEach(async () => { await resetRateLimits(); });
afterAll(async () => {
  for (const id of cleanup.documentIds) await db.query("delete from documents where id = $1", [id]);
  for (const id of cleanup.signatureIds) await db.query("delete from signatures where id = $1", [id]);
  for (const id of cleanup.jobIds) await db.query("delete from jobs where id = $1", [id]);
  for (const scope of cleanup.scopes) await db.query("delete from workspace_settings where workspace_id = $1", [scope]);
  await purgeTestUsers();
  await db.end();
});

describe("private PDF workspace metadata", () => {
  it("keeps guest metadata and signatures separate; rejects cross-guest mutation", async () => {
    const alice = new Client("guest-alice");
    const bob = new Client("guest-bob");
    const name = `${uniqueEmail("work")}.pdf`;
    const created = await alice.post<{ document: { id: number } }>("/api/documents", { name, size: 12, pages: 1 });
    expect(created.status).toBe(201);
    cleanup.documentIds.push(created.body.document.id);
    expect(alice.hasCookie("pdfpro_workspace")).toBe(true);
    expect((await bob.get<{ documents: { id: number }[] }>("/api/documents")).body.documents).toEqual([]);
    expect((await bob.patch("/api/documents", { id: created.body.document.id, starred: true })).status).toBe(404);
    expect((await bob.del(`/api/documents?id=${created.body.document.id}`)).status).toBe(404);
    expect((await alice.get<{ documents: { id: number; starred: boolean }[] }>("/api/documents")).body.documents[0]!.starred).toBe(false);

    const signed = await alice.post<{ signature: { id: number } }>("/api/signatures", { name: "Mine", dataUrl: image });
    expect(signed.status).toBe(201);
    cleanup.signatureIds.push(signed.body.signature.id);
    expect((await bob.get<{ signatures: unknown[] }>("/api/signatures")).body.signatures).toEqual([]);
    expect((await bob.del(`/api/signatures?id=${signed.body.signature.id}`)).status).toBe(404);
    expect((await alice.get<{ signatures: unknown[] }>("/api/signatures")).body.signatures).toHaveLength(1);

    const job = await alice.post<{ job: { id: number } }>("/api/jobs", { kind: "merge", fileName: name });
    expect(job.status).toBe(201);
    cleanup.jobIds.push(job.body.job.id);
    expect((await bob.get<{ jobs: unknown[] }>("/api/jobs")).body.jobs).toEqual([]);
  });

  it("isolates personal preferences from other guests and platform settings", async () => {
    const alice = new Client("prefs-alice");
    const bob = new Client("prefs-bob");
    expect((await alice.put("/api/settings", { theme: "dark", defaultZoom: 125 })).status).toBe(200);
    const aliceScope = `guest:${alice.cookieHeader.split("pdfpro_workspace=")[1]?.split(";")[0]}`;
    cleanup.scopes.push(aliceScope);
    expect((await alice.get<{ settings: Record<string, unknown> }>("/api/settings")).body.settings).toEqual({ theme: "dark", defaultZoom: 125 });
    expect((await bob.get<{ settings: Record<string, unknown> }>("/api/settings")).body.settings).toEqual({});
    expect((await alice.put("/api/settings", { billing: { paused: false } })).status).toBe(400);
    expect((await alice.put("/api/settings", { theme: "light", defaultZoom: "not a number" })).status).toBe(400);
    expect((await alice.put("/api/settings", { theme: "light" })).status).toBe(200);
    const global = await db.query("select value from settings where key = 'billing'");
    expect(global.rows).toHaveLength(1);
  });

  it("keeps legacy records in the database but inaccessible to new visitors", async () => {
    const marker = uniqueEmail("legacy");
    const { rows } = await db.query<{ id: number }>("insert into documents (name, size, pages) values ($1, 1, 1) returning id", [marker]);
    cleanup.documentIds.push(rows[0]!.id);
    const guest = new Client("new-visitor");
    expect((await guest.get<{ documents: { name: string }[] }>("/api/documents")).body.documents.some((r) => r.name === marker)).toBe(false);
    expect((await guest.del(`/api/documents?id=${rows[0]!.id}`)).status).toBe(404);
    expect((await db.query("select id from documents where id = $1", [rows[0]!.id])).rows).toHaveLength(1);
  });

  it("uses the signed-in user's identity across devices, not the guest cookie", async () => {
    const user = await createUser();
    const phone = new Client("phone");
    const login = await phone.post("/api/auth/login", { email: user.email, password: user.password });
    expect(login.status).toBe(200);
    const name = uniqueEmail("device");
    const row = await user.client.post<{ document: { id: number } }>("/api/documents", { name, pages: 1 });
    cleanup.documentIds.push(row.body.document.id);
    expect((await phone.get<{ documents: { id: number }[] }>("/api/documents")).body.documents.some((doc) => doc.id === row.body.document.id)).toBe(true);
    expect((await new Client("stranger").get<{ documents: { id: number }[] }>("/api/documents")).body.documents).toEqual([]);
  });

  it("rejects cross-origin mutations and non-object request bodies", async () => {
    const client = new Client("cross-origin");
    const rejected = await client.request("/api/documents", { method: "POST", json: { name: "no.pdf" }, headers: { Origin: "https://evil.example" } });
    expect(rejected.status).toBe(403);
    const malformed = await client.post("/api/documents", ["not", "an", "object"]);
    expect(malformed.status).toBe(400);
    expect((malformed.body as { code: string }).code).toBe("invalid_json");
  });
});
