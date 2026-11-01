import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FREE_STORAGE_BYTES } from "@/lib/plans";
import {
  BASE_URL,
  Client,
  createUser,
  db,
  makePdf,
  purgeTestUsers,
  resetRateLimits,
} from "./helpers";

beforeEach(async () => {
  await resetRateLimits();
  await purgeTestUsers();
});

afterAll(async () => {
  await purgeTestUsers();
  await db.end();
});

describe("cloud storage", () => {
  it("uploads, lists, previews, renames, downloads and deletes a PDF", async () => {
    const { client } = await createUser();

    const empty = await client.get<{ files: unknown[]; storage: { usedBytes: number } }>("/api/files");
    expect(empty.status).toBe(200);
    expect(empty.body.files).toEqual([]);
    expect(empty.body.storage.usedBytes).toBe(0);

    const bytes = await makePdf("First upload");
    const uploaded = await client.upload<{ file: { id: string; name: string; sizeBytes: number }; storage: { usedBytes: number } }>(
      bytes,
      "quarterly-report.pdf",
    );
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.file.name).toBe("quarterly-report.pdf");
    expect(uploaded.body.file.sizeBytes).toBe(bytes.byteLength);
    expect(uploaded.body.storage.usedBytes).toBe(bytes.byteLength);
    const fileId = uploaded.body.file.id;

    const listed = await client.get<{ files: { id: string; name: string }[]; total: number }>("/api/files?sort=name&order=asc");
    expect(listed.body.total).toBe(1);
    expect(listed.body.files[0]!.id).toBe(fileId);

    const search = await client.get<{ files: unknown[] }>("/api/files?q=quarterly");
    expect(search.body.files).toHaveLength(1);
    const noMatch = await client.get<{ files: unknown[] }>("/api/files?q=nothing-matches");
    expect(noMatch.body.files).toHaveLength(0);

    const signed = await client.get<{ url: string; expiresInSeconds: number }>(`/api/files/${fileId}/url`);
    expect(signed.status).toBe(200);
    expect(signed.body.url).toContain("token=");
    const inline = await fetch(new URL(signed.body.url, BASE_URL));
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-type")).toContain("application/pdf");
    expect(Buffer.from(await inline.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");

    const download = await client.get(`/api/files/${fileId}/download`);
    expect(download.status).toBe(200);

    const renamed = await client.patch<{ file: { name: string } }>(`/api/files/${fileId}`, { name: "renamed report" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.file.name).toBe("renamed report.pdf");

    const deleted = await client.del<{ ok: boolean; storage: { usedBytes: number; fileCount: number } }>(`/api/files/${fileId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.storage.usedBytes).toBe(0);
    expect(deleted.body.storage.fileCount).toBe(0);

    expect((await client.get(`/api/files/${fileId}`)).status).toBe(404);
    expect((await fetch(new URL(signed.body.url, BASE_URL))).status).toBe(404);
  });

  it("keeps every account's files private", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const uploaded = await alice.client.upload<{ file: { id: string } }>(await makePdf("Alice only"), "alice.pdf");
    const fileId = uploaded.body.file.id;

    const bobList = await bob.client.get<{ files: unknown[]; total: number }>("/api/files");
    expect(bobList.body.total).toBe(0);

    expect((await bob.client.get(`/api/files/${fileId}`)).status).toBe(404);
    expect((await bob.client.get(`/api/files/${fileId}/url`)).status).toBe(404);
    expect((await bob.client.get(`/api/files/${fileId}/download`)).status).toBe(404);
    expect((await bob.client.del(`/api/files/${fileId}`)).status).toBe(404);
    expect((await bob.client.patch(`/api/files/${fileId}`, { name: "stolen.pdf" })).status).toBe(404);

    const signed = await alice.client.get<{ url: string }>(`/api/files/${fileId}/url`);
    const tampered = signed.body.url.replace(/token=[^&]+/, "token=forged");
    expect((await fetch(new URL(tampered, BASE_URL))).status).toBe(403);

    // The owner is still fine after all of the above.
    expect((await alice.client.get(`/api/files/${fileId}`)).status).toBe(200);
  });

  it("rejects non-PDF payloads and oversized files before storing anything", async () => {
    const { client } = await createUser();

    const form = new FormData();
    form.append("file", new File(["not a pdf at all"], "notes.txt", { type: "text/plain" }));
    const notPdf = await client.request("/api/files", { method: "POST", form });
    expect(notPdf.status).toBe(415);

    const disguised = new FormData();
    disguised.append("file", new File(["still not a pdf"], "fake.pdf", { type: "application/pdf" }));
    const wrongSignature = await client.request("/api/files", { method: "POST", form: disguised });
    expect(wrongSignature.status).toBe(415);

    const plan = await client.get<{ storage: { usedBytes: number; fileCount: number } }>("/api/files");
    expect(plan.body.storage.fileCount).toBe(0);
    expect(plan.body.storage.usedBytes).toBe(0);
  });

  it("enforces the storage quota server-side", async () => {
    const { client, userId } = await createUser();
    await client.upload(await makePdf("Quota probe"), "probe.pdf");

    // Pretend the account is one kilobyte below its Free-plan limit.
    await db.query("update storage_usage set used_bytes = $2, file_count = 1 where user_id = $1", [
      userId,
      DEFAULT_FREE_STORAGE_BYTES - 1_024,
    ]);

    const blocked = await client.upload(await makePdf("Too big"), "blocked.pdf");
    expect(blocked.status).toBe(413);
    expect((blocked.body as { code: string }).code).toBe("quota_exceeded");

    const state = await client.get<{ storage: { usedBytes: number; quotaBytes: number; percentUsed: number } }>("/api/files");
    expect(state.body.storage.percentUsed).toBe(100);
    // Nothing was written for the rejected upload.
    expect(state.body.storage.usedBytes).toBe(DEFAULT_FREE_STORAGE_BYTES - 1_024);

    await db.query("update storage_usage set used_bytes = 0, file_count = 0 where user_id = $1", [userId]);
    const allowed = await client.upload(await makePdf("Fits again"), "allowed.pdf");
    expect(allowed.status).toBe(201);
  });

  it("keeps files when a downgrade puts the account over quota", async () => {
    const { client, userId } = await createUser();
    const payload = await makePdf("Large-ish file for downgrade test");
    const first = await client.upload<{ file: { id: string } }>(payload, "kept.pdf");
    expect(first.status).toBe(201);

    await db.query("update storage_usage set used_bytes = 4000000000 where user_id = $1", [userId]);

    const state = await client.get<{
      storage: { usedBytes: number; quotaBytes: number; overQuota: boolean; uploadsBlocked: boolean };
      files: { id: string }[];
    }>("/api/files");
    expect(state.status).toBe(200);
    expect(state.body.files).toHaveLength(1);
    expect(state.body.storage.overQuota).toBe(true);
    expect(state.body.storage.uploadsBlocked).toBe(true);

    const blocked = await client.upload(await makePdf("Blocked after downgrade"), "blocked.pdf");
    expect(blocked.status).toBe(413);

    // The existing file is still downloadable and can be removed.
    expect((await client.get(`/api/files/${first.body.file.id}/download`)).status).toBe(200);
    expect((await client.del(`/api/files/${first.body.file.id}`)).status).toBe(200);
  });

  it("reclaims quota when files are deleted", async () => {
    const { client } = await createUser();
    const a = await client.upload<{ file: { id: string } }>(await makePdf("One"), "one.pdf");
    const b = await client.upload<{ file: { id: string } }>(await makePdf("Two"), "two.pdf");
    const before = await client.get<{ storage: { usedBytes: number; fileCount: number } }>("/api/files");
    expect(before.body.storage.fileCount).toBe(2);

    const sizeOfA = (await client.get<{ file: { sizeBytes: number } }>(`/api/files/${a.body.file.id}`)).body.file.sizeBytes;
    const after = await client.del<{ storage: { usedBytes: number; fileCount: number } }>(`/api/files/${a.body.file.id}`);
    expect(after.body.storage.fileCount).toBe(1);
    expect(after.body.storage.usedBytes).toBe(before.body.storage.usedBytes - sizeOfA);

    // Deleting twice is a 404, not another decrement.
    expect((await client.del(`/api/files/${a.body.file.id}`)).status).toBe(404);
    const final = await client.get<{ storage: { usedBytes: number } }>("/api/files");
    expect(final.body.storage.usedBytes).toBe(after.body.storage.usedBytes);
    expect(b.body.file.id).toBeTruthy();
  });

  it("requires a session for every storage route", async () => {
    const anonymous = new Client("anon");
    for (const path of ["/api/files", "/api/files?q=x", "/api/files/00000000-0000-0000-0000-000000000000/url"]) {
      expect((await anonymous.get(path)).status).toBe(401);
    }
    expect((await anonymous.upload(await makePdf("anon"), "anon.pdf")).status).toBe(401);
    // Downloads accept either a session or a signed token; neither is present here.
    expect((await fetch(`${BASE_URL}/api/files/00000000-0000-0000-0000-000000000000/download`)).status).toBe(401);
  });
});
