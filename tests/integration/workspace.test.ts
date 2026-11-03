import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Client, createUser, db, purgeTestUsers, resetRateLimits } from "./helpers";

beforeEach(async () => { await resetRateLimits(); await purgeTestUsers(); });
afterAll(async () => { await purgeTestUsers(); await db.end(); });

describe("workspace metadata isolation", () => {
  it("rejects anonymous access to global document, job, signature and preference records", async () => {
    const visitor = new Client("anonymous");
    for (const path of ["documents", "jobs", "signatures"]) {
      expect((await visitor.get(`/api/${path}`)).status).toBe(401);
      expect((await visitor.post(`/api/${path}`, {})).status).toBe(401);
    }
    expect((await visitor.get("/api/settings")).status).toBe(401);
    expect((await visitor.request("/api/settings", { method: "PUT", json: { theme: "dark" } })).status).toBe(401);
  });

  it("isolates document history, processing jobs, saved signatures and preferences per account", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const doc = await alice.client.post<{ document: { id: number } }>("/api/documents", { name: "private.pdf", size: 8, pages: 1 });
    expect(doc.status).toBe(201);
    const job = await alice.client.post("/api/jobs", { kind: "merge", fileName: "private.pdf" });
    expect(job.status).toBe(201);
    const sig = await alice.client.post<{ signature: { id: number } }>("/api/signatures", { name: "private", dataUrl: "data:image/png;base64,AA==" });
    expect(sig.status).toBe(201);
    expect((await alice.client.request("/api/settings", { method: "PUT", json: { theme: "dark" } })).status).toBe(200);
    for (const path of ["documents", "jobs", "signatures"]) {
      const own = await alice.client.get<Record<string, unknown[]>>(`/api/${path}`);
      const other = await bob.client.get<Record<string, unknown[]>>(`/api/${path}`);
      expect(own.body[path]).toHaveLength(1);
      expect(other.body[path]).toHaveLength(0);
    }
    expect((await bob.client.get<{ settings: Record<string, unknown> }>("/api/settings")).body.settings).toEqual({});
    expect((await alice.client.get<{ settings: Record<string, unknown> }>("/api/settings")).body.settings).toEqual({ theme: "dark" });
    expect((await bob.client.patch("/api/documents", { id: doc.body.document.id, starred: true })).status).toBe(404);
    expect((await bob.client.request(`/api/documents?id=${doc.body.document.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await bob.client.request(`/api/signatures?id=${sig.body.signature.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await alice.client.get<{ documents: { starred: boolean }[] }>("/api/documents")).body.documents[0]?.starred).toBe(false);
    expect((await bob.client.request("/api/settings", { method: "PUT", json: { billing: { paused: false } } })).status).toBe(400);
    expect((await bob.client.get<{ settings: Record<string, unknown> }>("/api/settings")).body.settings).toEqual({});
    expect((await alice.client.request("/api/signatures", { method: "POST", json: { dataUrl: "data:image/png;base64," + "A".repeat(710_000) } })).status).toBe(413);
  });

  it("retains old unowned rows without disclosing them to any account", async () => {
    const [doc] = (await db.query<{ id: number }>("insert into documents (name) values ('archived-private-name.pdf') returning id")).rows;
    const [sig] = (await db.query<{ id: number }>("insert into signatures (name, data_url) values ('archived signature', 'data:image/png;base64,AA==') returning id")).rows;
    try {
      const alice = await createUser();
      expect((await alice.client.get<{ documents: { id: number }[] }>("/api/documents")).body.documents).not.toContainEqual(expect.objectContaining({ id: doc.id }));
      expect((await alice.client.get<{ signatures: { id: number }[] }>("/api/signatures")).body.signatures).not.toContainEqual(expect.objectContaining({ id: sig.id }));
      expect((await alice.client.request(`/api/documents?id=${doc.id}`, { method: "DELETE" })).status).toBe(404);
      expect((await alice.client.request(`/api/signatures?id=${sig.id}`, { method: "DELETE" })).status).toBe(404);
      expect((await db.query("select id from documents where id = $1", [doc.id])).rows).toHaveLength(1);
      expect((await db.query("select id from signatures where id = $1", [sig.id])).rows).toHaveLength(1);
    } finally {
      await db.query("delete from documents where id = $1", [doc.id]);
      await db.query("delete from signatures where id = $1", [sig.id]);
    }
  });
});
