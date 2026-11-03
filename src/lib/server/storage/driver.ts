/**
 * Private object storage.
 *
 * Two drivers ship with the application:
 *
 *   local  – a directory outside `public/`, served only through signed,
 *            authenticated API routes. Default; needs no cloud account.
 *   s3     – any S3-compatible private bucket: Neon Object Storage, Cloudflare
 *            R2, AWS S3, MinIO, Backblaze. Credentials stay on the server and
 *            object URLs are never public.
 *
 * The interface is intentionally small so another driver (GCS, Azure Blob) can
 * be added without touching the file service.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config";
import { S3StorageDriver } from "./s3";

export type PutOptions = {
  contentType?: string;
  /** Exact byte length when it is known up front (it always is for uploads). */
  contentLength?: number;
};

export interface StorageDriver {
  readonly name: string;
  put(key: string, data: Buffer, options?: PutOptions): Promise<void>;
  putStream(key: string, stream: Readable, options?: PutOptions): Promise<void>;
  get(key: string): Promise<Buffer>;
  getStream(key: string): Promise<ReadableStream<Uint8Array>>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/* ------------------------------------------------------------------ */
/* Local private directory driver                                      */
/* ------------------------------------------------------------------ */

// Resolve against the working directory without touching `process.cwd()`
// directly: Turbopack's file tracer otherwise assumes the *entire* project is
// reachable from this route and inlines it into the server bundle.
const LOCAL_ROOT = resolve(config.storage.dir);

function localPath(key: string): string {
  const target = resolve(join(LOCAL_ROOT), key);
  if (target !== LOCAL_ROOT && !target.startsWith(LOCAL_ROOT + sep)) {
    throw new Error("Storage key escapes the storage root");
  }
  return target;
}

class LocalDriver implements StorageDriver {
  readonly name = "local";

  async put(key: string, data: Buffer): Promise<void> {
    const target = localPath(key);
    await mkdir(dirname(target), { recursive: true });
    await pipeline(Readable.from(data), createWriteStream(target, { mode: 0o600 }));
  }

  async putStream(key: string, stream: Readable): Promise<void> {
    const target = localPath(key);
    await mkdir(dirname(target), { recursive: true });
    await pipeline(stream, createWriteStream(target, { mode: 0o600 }));
  }

  async get(key: string): Promise<Buffer> {
    return readFile(localPath(key));
  }

  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const nodeStream = createReadStream(localPath(key));
    return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  }

  async delete(key: string): Promise<void> {
    await rm(localPath(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      const info = await stat(localPath(key));
      return info.isFile();
    } catch {
      return false;
    }
  }
}

/* ------------------------------------------------------------------ */

const drivers: Partial<Record<"local" | "s3", StorageDriver>> = {};

/** Existing files must be read from the driver recorded at upload, even after configuration changes. */
export function getStorageDriver(name: string = config.storage.driver): StorageDriver {
  if (name !== "local" && name !== "s3") throw new Error(`Unsupported storage driver: ${name}`);
  return (drivers[name] ??= name === "s3" ? new S3StorageDriver() : new LocalDriver());
}

/** Test helper: drop cached drivers so a new configuration is picked up. */
export function resetStorageDriver(): void {
  delete drivers.local;
  delete drivers.s3;
}

export const storageRoot = LOCAL_ROOT;
