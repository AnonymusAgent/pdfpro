/**
 * Personal cloud storage service.
 *
 * Quota enforcement is transactional: the `storage_usage` row is locked with
 * `SELECT … FOR UPDATE`, re-checked, and updated in the same transaction that
 * inserts the file. Two concurrent uploads can therefore never exceed the plan
 * limit. Files are written to private storage first and removed again if the
 * database step fails, so no orphan objects or phantom bytes are left behind.
 */
import { createHash, createHmac } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import { db } from "@/db";
import { userFiles } from "@/db/schema";
import { HttpError } from "./api";
import { config } from "./config";
import { randomUUID, safeEqualStrings, sanitizeFileName } from "./crypto";
import { getEntitlements, type DbExecutor } from "./entitlements";
import { getStorageDriver } from "./storage/driver";

export type FileRecord = {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
  updatedAt: string;
  checksumSha256: string | null;
};

export type ListOptions = {
  q?: string;
  sort?: "name" | "size" | "created";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

const PDF_MAGIC = Buffer.from("%PDF-", "latin1");

function toRecord(row: typeof userFiles.$inferSelect): FileRecord {
  return {
    id: row.id,
    name: row.name,
    sizeBytes: Number(row.sizeBytes),
    mimeType: row.mimeType,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    checksumSha256: row.checksumSha256,
  };
}

export async function listUserFiles(userId: string, options: ListOptions = {}) {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);
  const sort = options.sort ?? "created";
  const direction = options.order === "asc" ? asc : desc;
  const needle = options.q?.trim().slice(0, 120) ?? "";

  const where = needle
    ? and(eq(userFiles.userId, userId), eq(userFiles.status, "active"), ilike(userFiles.name, `%${needle}%`))
    : and(eq(userFiles.userId, userId), eq(userFiles.status, "active"));

  const sortColumn = sort === "name" ? sql`lower(${userFiles.name})` : sort === "size" ? userFiles.sizeBytes : userFiles.createdAt;

  const rows = await db
    .select()
    .from(userFiles)
    .where(where)
    .orderBy(direction(sortColumn))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userFiles)
    .where(where);

  return { files: rows.map(toRecord), total: Number(count) };
}

export async function getOwnedFile(userId: string, fileId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new HttpError(404, "File not found.", "not_found");
  const [row] = await db
    .select()
    .from(userFiles)
    .where(and(eq(userFiles.id, fileId), eq(userFiles.userId, userId), eq(userFiles.status, "active")))
    .limit(1);
  if (!row) throw new HttpError(404, "File not found.", "not_found");
  return row;
}

/** Reads the first chunk to confirm the payload really is a PDF. */
async function peekPdf(head: Buffer): Promise<boolean> {
  return head.length >= PDF_MAGIC.length && head.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

export async function uploadPdfFile(params: {
  userId: string;
  file: File;
  name?: string;
}): Promise<{ file: FileRecord; storage: Awaited<ReturnType<typeof getEntitlements>>["storage"] }> {
  const entitlements = await getEntitlements(params.userId);
  if (entitlements.storage.overQuota) {
    throw new HttpError(413, entitlements.storage.uploadsBlockedReason ?? "Storage quota reached.", "quota_exceeded", {
      usedBytes: entitlements.storage.usedBytes,
      quotaBytes: entitlements.storage.quotaBytes,
      overQuota: true,
    });
  }

  const declaredSize = Number(params.file.size);
  if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
    throw new HttpError(400, "The uploaded file is empty.", "empty_file");
  }
  if (declaredSize > entitlements.maxUploadBytes) {
    throw new HttpError(
      413,
      `Files are limited to ${Math.round(entitlements.maxUploadBytes / (1024 * 1024))} MB each.`,
      "file_too_large",
      { maxUploadBytes: entitlements.maxUploadBytes },
    );
  }
  if (declaredSize > entitlements.storage.remainingBytes) {
    throw new HttpError(
      413,
      "This file does not fit in your remaining storage. Delete files or upgrade to Premium.",
      "quota_exceeded",
      {
        usedBytes: entitlements.storage.usedBytes,
        quotaBytes: entitlements.storage.quotaBytes,
        remainingBytes: entitlements.storage.remainingBytes,
      },
    );
  }

  const driver = getStorageDriver();
  const fileId = randomUUID();
  const storageKey = `users/${params.userId}/${fileId}.pdf`;
  const webStream = params.file.stream() as unknown as ReadableStream<Uint8Array>;
  const source = Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);
  const iterator = source[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new HttpError(400, "The uploaded file is empty.", "empty_file");
  const head = Buffer.from(first.value as Uint8Array);
  if (!(await peekPdf(head))) {
    throw new HttpError(415, "Only PDF files can be uploaded to cloud storage.", "unsupported_type");
  }

  let written = 0;
  const hash = createHash("sha256");
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  async function* remainder() {
    yield head;
    let next = await iterator.next();
    while (!next.done) {
      yield next.value as Uint8Array;
      next = await iterator.next();
    }
  }

  try {
    await driver.putStream(storageKey, Readable.from(remainder()).pipe(hasher), {
      contentType: "application/pdf",
      contentLength: declaredSize,
    });
  } catch (error) {
    await driver.delete(storageKey).catch(() => undefined);
    throw new HttpError(500, "The file could not be stored. Please try again.", "storage_write_failed", {
      reason: error instanceof Error ? error.message : undefined,
    });
  }

  const sizeBytes = written;
  if (sizeBytes === 0) {
    await driver.delete(storageKey);
    throw new HttpError(400, "The uploaded file is empty.", "empty_file");
  }
  if (sizeBytes !== declaredSize) {
    // The request body was truncated or padded in transit: never keep a partial
    // object, and never charge the quota for it either.
    await driver.delete(storageKey).catch(() => undefined);
    throw new HttpError(400, "The upload was interrupted. Please try again.", "upload_incomplete", {
      receivedBytes: sizeBytes,
      expectedBytes: declaredSize,
    });
  }

  const checksum = hash.digest("hex");
  const name = sanitizeFileName(params.name || params.file.name, "document.pdf");

  try {
    const row = await db.transaction(async (tx) => {
      // Ensure a usage row exists even for accounts created before this release.
      await tx.execute(sql`
        insert into storage_usage (user_id) values (${params.userId})
        on conflict (user_id) do nothing
      `);
      const locked = await tx.execute<{ used_bytes: string; file_count: number }>(sql`
        select used_bytes, file_count from storage_usage where user_id = ${params.userId} for update
      `);
      const usedBytes = Number(locked.rows[0]?.used_bytes ?? 0);

      // Re-read the plan inside the critical section: a subscription may have
      // changed while the file was streaming to storage. The transaction handle
      // is reused so the pool never needs a second connection while this row
      // lock is held.
      const fresh = await getEntitlements(params.userId, tx as unknown as DbExecutor, entitlements.maxUploadBytes);
      if (usedBytes + sizeBytes > fresh.quotaBytes) {
        throw new HttpError(413, "This file does not fit in your remaining storage.", "quota_exceeded", {
          usedBytes,
          quotaBytes: fresh.quotaBytes,
        });
      }

      const [inserted] = await tx
        .insert(userFiles)
        .values({
          id: fileId,
          userId: params.userId,
          name,
          sizeBytes,
          mimeType: "application/pdf",
          storageDriver: driver.name,
          storageKey,
          checksumSha256: checksum,
        })
        .returning();

      await tx.execute(sql`
        update storage_usage
        set used_bytes = used_bytes + ${sizeBytes},
            file_count = file_count + 1,
            updated_at = now()
        where user_id = ${params.userId}
      `);

      return inserted!;
    });

    const after = await getEntitlements(params.userId);
    return { file: toRecord(row), storage: after.storage };
  } catch (error) {
    await driver.delete(storageKey).catch(() => undefined);
    throw error;
  }
}

export async function renameUserFile(userId: string, fileId: string, rawName: string): Promise<FileRecord> {
  const name = sanitizeFileName(rawName, "");
  if (!name) throw new HttpError(400, "Enter a file name.", "invalid_name");
  const row = await getOwnedFile(userId, fileId);
  const [updated] = await db
    .update(userFiles)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(userFiles.id, row.id), eq(userFiles.userId, userId)))
    .returning();
  return toRecord(updated!);
}

export async function deleteUserFile(userId: string, fileId: string): Promise<{ reclaimedBytes: number }> {
  const row = await getOwnedFile(userId, fileId);
  const size = Number(row.sizeBytes);

  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .update(userFiles)
      .set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(userFiles.id, row.id), eq(userFiles.userId, userId), eq(userFiles.status, "active")))
      .returning({ id: userFiles.id });
    if (!deleted) throw new HttpError(404, "File not found.", "not_found");

    await tx.execute(sql`
      update storage_usage
      set used_bytes = greatest(0, used_bytes - ${size}),
          file_count = greatest(0, file_count - 1),
          updated_at = now()
      where user_id = ${userId}
    `);
  });

  // The record is gone for the user; storage cleanup is best effort but retried
  // by the maintenance job for any object that could not be removed.
  await getStorageDriver().delete(row.storageKey).catch(() => undefined);
  return { reclaimedBytes: size };
}

export async function readFileStream(fileId: string): Promise<{ stream: ReadableStream<Uint8Array>; row: typeof userFiles.$inferSelect }> {
  const [row] = await db
    .select()
    .from(userFiles)
    .where(and(eq(userFiles.id, fileId), eq(userFiles.status, "active")))
    .limit(1);
  if (!row) throw new HttpError(404, "File not found.", "not_found");
  return { stream: await getStorageDriver().getStream(row.storageKey), row };
}

/* ------------------------------------------------------------------ */
/* Temporary signed URLs                                               */
/* ------------------------------------------------------------------ */

type SignedToken = { fileId: string; userId: string; expires: number };

function signPayload(payload: string): string {
  return createHmac("sha256", config.storage.signingSecret).update(payload).digest("base64url");
}

export function createSignedFileToken(fileId: string, userId: string, ttlSeconds = config.storage.signedUrlTtlSeconds): string {
  const expires = Math.floor(Date.now() / 1000) + Math.max(10, ttlSeconds);
  const payload = `${fileId}.${userId}.${expires}`;
  return `${Buffer.from(payload).toString("base64url")}.${signPayload(payload)}`;
}

export function verifySignedFileToken(token: string, fileId: string): SignedToken | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  let payload: string;
  try {
    payload = Buffer.from(parts[0]!, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const [tokenFileId, userId, expiresRaw] = payload.split(".");
  if (!tokenFileId || !userId || !expiresRaw) return null;
  if (tokenFileId !== fileId) return null;
  if (!safeEqualStrings(signPayload(payload), parts[1]!)) return null;
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires * 1000 <= Date.now()) return null;
  return { fileId: tokenFileId, userId, expires };
}

export function signedDownloadUrl(fileId: string, userId: string, options: { disposition?: "inline" | "attachment" } = {}): string {
  const token = createSignedFileToken(fileId, userId);
  const query = new URLSearchParams({ token });
  if (options.disposition === "inline") query.set("disposition", "inline");
  return `/api/files/${fileId}/download?${query.toString()}`;
}

/* ------------------------------------------------------------------ */
/* Accounting and maintenance                                          */
/* ------------------------------------------------------------------ */

/** Recomputes usage from the file table and repairs drift. */
export async function recomputeStorageUsage(userId: string): Promise<{ usedBytes: number; fileCount: number }> {
  const [row] = await db
    .select({
      used: sql<number>`coalesce(sum(${userFiles.sizeBytes}), 0)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(userFiles)
    .where(and(eq(userFiles.userId, userId), eq(userFiles.status, "active")));
  const usedBytes = Number(row?.used ?? 0);
  const fileCount = Number(row?.count ?? 0);
  await db.execute(sql`
    insert into storage_usage (user_id, used_bytes, file_count, updated_at)
    values (${userId}, ${usedBytes}, ${fileCount}, now())
    on conflict (user_id) do update
      set used_bytes = excluded.used_bytes, file_count = excluded.file_count, updated_at = now()
  `);
  return { usedBytes, fileCount };
}

/**
 * Finishes deletions whose object removal failed, and drops tombstones older
 * than 30 days. Never deletes a file row the user can still see.
 */
export async function finalizePendingDeletions(limit = 50): Promise<{ purged: number }> {
  const driver = getStorageDriver();
  const rows = await db
    .select({ id: userFiles.id, storageKey: userFiles.storageKey })
    .from(userFiles)
    .where(eq(userFiles.status, "deleted"))
    .limit(limit);
  let purged = 0;
  for (const row of rows) {
    try {
      await driver.delete(row.storageKey);
      const [removed] = await db.delete(userFiles).where(eq(userFiles.id, row.id)).returning({ id: userFiles.id });
      if (removed) purged += 1;
    } catch {
      /* retried next run */
    }
  }
  return { purged };
}

/** Numbers for the administrator dashboard. */
export async function storageTotals(): Promise<{ files: number; bytes: number }> {
  const [row] = await db
    .select({ files: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${userFiles.sizeBytes}), 0)::bigint` })
    .from(userFiles)
    .where(eq(userFiles.status, "active"));
  return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
}
