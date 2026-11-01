/**
 * S3-compatible object storage.
 *
 * One driver covers every S3 API backend we care about:
 *
 *   Neon Object Storage  – S3 endpoint injected into the project (`AWS_*` vars)
 *   Cloudflare R2        – https://<account>.r2.cloudflarestorage.com
 *   Amazon S3            – omit the endpoint to use the regional AWS endpoint
 *   MinIO / Backblaze    – any S3-compatible endpoint
 *
 * Buckets are always private: nothing here produces a public URL. Downloads
 * leave the application only through `/api/files/{id}/download`, which checks
 * the owner's session or a short-lived HMAC signature.
 *
 * Keys are `users/<userId>/<fileId>.pdf`, so a leaked bucket listing still does
 * not reveal file names.
 */
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { PutOptions, StorageDriver } from "./driver";

export type S3Settings = {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Variables that are still missing for a working S3 configuration. */
  missing: string[];
};

type Env = Record<string, string | undefined>;

const first = (...values: (string | undefined)[]): string =>
  values.map((value) => (value ?? "").trim()).find(Boolean) ?? "";

const flag = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};

/**
 * Resolves the S3 settings from the environment.
 *
 * `S3_*` variables win; the AWS-standard names that Neon injects on deploy
 * (`AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
 * `AWS_REGION`) are used as fallbacks so a Neon project works without renaming
 * anything.
 */
export function resolveS3Settings(env: Env = process.env): S3Settings {
  const bucket = first(env.S3_BUCKET, env.NEON_STORAGE_BUCKET, "pdfpro-files");
  const endpoint = first(env.S3_ENDPOINT, env.AWS_ENDPOINT_URL_S3, env.AWS_ENDPOINT_URL);
  const region = first(env.S3_REGION, env.AWS_REGION, env.AWS_DEFAULT_REGION, "us-east-2");
  const accessKeyId = first(env.S3_ACCESS_KEY_ID, env.AWS_ACCESS_KEY_ID);
  const secretAccessKey = first(env.S3_SECRET_ACCESS_KEY, env.AWS_SECRET_ACCESS_KEY);
  const forcePathStyle = flag(env.S3_FORCE_PATH_STYLE, true);

  const missing: string[] = [];
  if (!bucket) missing.push("S3_BUCKET");
  if (!accessKeyId) missing.push("S3_ACCESS_KEY_ID (or AWS_ACCESS_KEY_ID)");
  if (!secretAccessKey) missing.push("S3_SECRET_ACCESS_KEY (or AWS_SECRET_ACCESS_KEY)");

  return { bucket, endpoint, region, accessKeyId, secretAccessKey, forcePathStyle, missing };
}

export class S3StorageDriver implements StorageDriver {
  readonly name = "s3";
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(settings: S3Settings = resolveS3Settings()) {
    if (settings.missing.length) {
      throw new Error(
        `STORAGE_DRIVER=s3 but the object storage credentials are incomplete (missing ${settings.missing.join(", ")}). ` +
          "Set S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY, or use the AWS_* variables Neon injects.",
      );
    }
    const clientConfig: S3ClientConfig = {
      region: settings.region,
      forcePathStyle: settings.forcePathStyle,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
      // Object bodies are streamed; leave SDK retries at the default (3) so a
      // transient network error does not fail an upload.
      maxAttempts: 3,
    };
    if (settings.endpoint) clientConfig.endpoint = settings.endpoint;
    this.client = new S3Client(clientConfig);
    this.bucket = settings.bucket;
  }

  async put(key: string, data: Buffer, options: PutOptions = {}): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: options.contentType ?? "application/octet-stream",
        ContentLength: data.byteLength,
      }),
    );
  }

  /**
   * Streams an upload without buffering the whole file.
   *
   * The API route knows the byte length from the multipart part, so the common
   * path is a single `PutObject` with `Content-Length` — one request, constant
   * memory, and any truncation surfaces as a signature/size error instead of a
   * silently short object. Only an unknown length falls back to the multipart
   * uploader.
   */
  async putStream(key: string, stream: Readable, options: PutOptions = {}): Promise<void> {
    if (options.contentLength && options.contentLength > 0) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: stream,
          ContentType: options.contentType ?? "application/octet-stream",
          ContentLength: options.contentLength,
        }),
      );
      return;
    }
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: stream,
        ContentType: options.contentType ?? "application/octet-stream",
      },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await upload.done();
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body) throw new Error(`Object ${key} returned an empty body`);
    const bytes = await response.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body) throw new Error(`Object ${key} returned an empty body`);
    return response.Body.transformToWebStream() as ReadableStream<Uint8Array>;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (error as { name?: string }).name === "NotFound") return false;
      throw error;
    }
  }
}
