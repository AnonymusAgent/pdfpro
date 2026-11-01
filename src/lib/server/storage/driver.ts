/**
 * Private object storage.
 *
 * Two drivers ship with the application:
 *
 *   local     – a directory outside `public/`, served only through signed,
 *               authenticated API routes. Default; needs no cloud account.
 *   supabase  – a private Supabase Storage bucket, accessed with the service
 *               role key from the server only. Object URLs are never public.
 *
 * The interface is intentionally small so an S3/R2/GCS driver can be added
 * without touching the file service.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config";

export type PutOptions = { contentType?: string };

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

const LOCAL_ROOT = resolve(process.cwd(), config.storage.dir);

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
/* Supabase Storage driver (private bucket)                            */
/* ------------------------------------------------------------------ */

class SupabaseDriver implements StorageDriver {
  readonly name = "supabase";
  private readonly base: string;
  private readonly bucket: string;
  private readonly key: string;

  constructor() {
    this.base = config.storage.supabaseUrl.replace(/\/+$/, "");
    this.bucket = config.storage.bucket;
    this.key = config.storage.supabaseServiceKey;
    if (!this.base || !this.key) {
      throw new Error("Supabase storage requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    }
  }

  private url(key: string): string {
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    return `${this.base}/storage/v1/object/${encodeURIComponent(this.bucket)}/${encodedKey}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.key}`, apikey: this.key, ...extra };
  }

  private async ensureOk(response: Response, action: string): Promise<void> {
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Supabase storage ${action} failed (${response.status}): ${detail.slice(0, 200)}`);
    }
  }

  async put(key: string, data: Buffer, options: PutOptions = {}): Promise<void> {
    const response = await fetch(this.url(key), {
      method: "POST",
      headers: this.headers({
        "Content-Type": options.contentType ?? "application/octet-stream",
        "x-upsert": "false",
      }),
      body: new Uint8Array(data),
    });
    await this.ensureOk(response, "upload");
  }

  async putStream(key: string, stream: Readable, options: PutOptions = {}): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    await this.put(key, Buffer.concat(chunks), options);
  }

  async get(key: string): Promise<Buffer> {
    const response = await fetch(this.url(key), { headers: this.headers() });
    await this.ensureOk(response, "download");
    return Buffer.from(await response.arrayBuffer());
  }

  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const response = await fetch(this.url(key), { headers: this.headers() });
    await this.ensureOk(response, "download");
    if (!response.body) throw new Error("Supabase storage returned an empty body");
    return response.body;
  }

  async delete(key: string): Promise<void> {
    const response = await fetch(this.url(key), { method: "DELETE", headers: this.headers() });
    if (response.status === 404) return;
    await this.ensureOk(response, "delete");
  }

  async exists(key: string): Promise<boolean> {
    const response = await fetch(this.url(key), { method: "HEAD", headers: this.headers() });
    return response.ok;
  }
}

/* ------------------------------------------------------------------ */

let driver: StorageDriver | null = null;

export function getStorageDriver(): StorageDriver {
  if (driver) return driver;
  driver = config.storage.driver === "supabase" ? new SupabaseDriver() : new LocalDriver();
  return driver;
}

/** Test helper: drop the cached driver so a new configuration is picked up. */
export function resetStorageDriver(): void {
  driver = null;
}

export const storageRoot = LOCAL_ROOT;
