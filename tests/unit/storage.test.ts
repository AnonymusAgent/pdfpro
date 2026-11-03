import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { S3StorageDriver, resolveS3Settings } from "@/lib/server/storage/s3";
import { getStorageDriver, getStorageDriverFor, resetStorageDriver } from "@/lib/server/storage/driver";
import { config } from "@/lib/server/config";

describe("S3 settings resolution", () => {
  it("uses the AWS-standard variables Neon injects", () => {
    const settings = resolveS3Settings({
      AWS_ACCESS_KEY_ID: "neon_access_key",
      AWS_SECRET_ACCESS_KEY: "neon_secret_key",
      AWS_ENDPOINT_URL_S3: "https://us-east-2.aws.neon.tech/storage",
      AWS_REGION: "us-east-2",
      S3_BUCKET: "pdfpro-files",
    });
    expect(settings.endpoint).toBe("https://us-east-2.aws.neon.tech/storage");
    expect(settings.region).toBe("us-east-2");
    expect(settings.accessKeyId).toBe("neon_access_key");
    expect(settings.secretAccessKey).toBe("neon_secret_key");
    expect(settings.bucket).toBe("pdfpro-files");
    expect(settings.missing).toEqual([]);
  });

  it("prefers explicit S3_* variables over the AWS aliases", () => {
    const settings = resolveS3Settings({
      S3_ACCESS_KEY_ID: "explicit",
      S3_SECRET_ACCESS_KEY: "explicit_secret",
      S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      S3_REGION: "auto",
      S3_BUCKET: "pdfpro",
      AWS_ACCESS_KEY_ID: "alias",
      AWS_SECRET_ACCESS_KEY: "alias_secret",
      AWS_ENDPOINT_URL_S3: "https://ignored.example",
      AWS_REGION: "us-east-1",
    });
    expect(settings.accessKeyId).toBe("explicit");
    expect(settings.secretAccessKey).toBe("explicit_secret");
    expect(settings.endpoint).toBe("https://account.r2.cloudflarestorage.com");
    expect(settings.region).toBe("auto");
    expect(settings.bucket).toBe("pdfpro");
  });

  it("defaults to a private, path-style bucket on us-east-2", () => {
    const settings = resolveS3Settings({});
    expect(settings.bucket).toBe("pdfpro-files");
    expect(settings.region).toBe("us-east-2");
    expect(settings.forcePathStyle).toBe(true);
    expect(settings.endpoint).toBe("");
  });

  it("lists the missing credentials instead of failing silently", () => {
    const settings = resolveS3Settings({ S3_BUCKET: "pdfpro-files" });
    expect(settings.missing).toEqual([
      "S3_ACCESS_KEY_ID (or AWS_ACCESS_KEY_ID)",
      "S3_SECRET_ACCESS_KEY (or AWS_SECRET_ACCESS_KEY)",
    ]);
  });

  it("allows path-style addressing to be switched off for AWS S3", () => {
    expect(resolveS3Settings({ S3_FORCE_PATH_STYLE: "false" }).forcePathStyle).toBe(false);
    expect(resolveS3Settings({ S3_FORCE_PATH_STYLE: "true" }).forcePathStyle).toBe(true);
  });
});

describe("S3 driver", () => {
  it("refuses to start with incomplete credentials and says what is missing", () => {
    expect(() => new S3StorageDriver(resolveS3Settings({ S3_BUCKET: "pdfpro-files" }))).toThrow(
      /S3_ACCESS_KEY_ID[\s\S]*S3_SECRET_ACCESS_KEY/,
    );
  });

  it("constructs a driver for a Neon-style configuration without touching the network", () => {
    const driver = new S3StorageDriver({
      bucket: "pdfpro-files",
      endpoint: "https://us-east-2.aws.neon.tech/storage",
      region: "us-east-2",
      accessKeyId: "key",
      secretAccessKey: "secret",
      forcePathStyle: true,
      missing: [],
    });
    expect(driver.name).toBe("s3");
  });
});

describe("S3 driver command mapping", () => {
  const settings = {
    bucket: "pdfpro-files",
    endpoint: "https://us-east-2.aws.neon.tech/storage",
    region: "us-east-2",
    accessKeyId: "key",
    secretAccessKey: "secret",
    forcePathStyle: true,
    missing: [],
  };

  /** Builds a driver whose client records commands instead of calling S3. */
  function instrumented() {
    const driver = new S3StorageDriver(settings);
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const responses: Record<string, unknown> = {};
    (driver as unknown as { client: { config: unknown; send: (command: unknown) => Promise<unknown> } }).client = {
      // lib-storage reads `client.config.requestHandler`; an empty config keeps
      // it on the plain PutObject path without touching the network.
      config: {},
      send: async (command: unknown) => {
        const cmd = command as { constructor: { name: string }; input: Record<string, unknown> };
        calls.push({ name: cmd.constructor.name, input: cmd.input });
        const key = cmd.constructor.name;
        if (typeof responses[key] === "function") return (responses[key] as () => unknown)();
        return responses[key] ?? {};
      },
    };
    return { driver, calls, responses };
  }

  it("writes objects into the configured private bucket", async () => {
    const { driver, calls } = instrumented();
    await driver.put("users/u1/f1.pdf", Buffer.from("%PDF-1.7 body"), { contentType: "application/pdf" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("PutObjectCommand");
    expect(calls[0]!.input).toMatchObject({
      Bucket: "pdfpro-files",
      Key: "users/u1/f1.pdf",
      ContentType: "application/pdf",
      ContentLength: 13,
    });
  });

  it("streams a known-length upload as a single PutObject with ContentLength", async () => {
    const { driver, calls } = instrumented();
    const body = Buffer.from("%PDF-1.7 streamed");
    await driver.putStream("users/u1/f2.pdf", Readable.from([body]), {
      contentType: "application/pdf",
      contentLength: body.byteLength,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("PutObjectCommand");
    expect(calls[0]!.input).toMatchObject({
      Bucket: "pdfpro-files",
      Key: "users/u1/f2.pdf",
      ContentType: "application/pdf",
      ContentLength: body.byteLength,
    });
  });

  it("reads, streams and deletes by key", async () => {
    const { driver, calls, responses } = instrumented();
    responses.GetObjectCommand = () => ({
      Body: {
        transformToByteArray: async () => new Uint8Array(Buffer.from("%PDF-data")),
        transformToWebStream: () => new ReadableStream({ start: (c) => c.close() }),
      },
    });
    expect((await driver.get("users/u1/f1.pdf")).toString()).toBe("%PDF-data");
    await driver.getStream("users/u1/f1.pdf");
    await driver.delete("users/u1/f1.pdf");
    expect(calls.map((call) => call.name)).toEqual(["GetObjectCommand", "GetObjectCommand", "DeleteObjectCommand"]);
    expect(calls[2]!.input).toMatchObject({ Bucket: "pdfpro-files", Key: "users/u1/f1.pdf" });
  });

  it("treats a 404 from HeadObject as a missing object and rethrows anything else", async () => {
    const { driver, responses } = instrumented();
    responses.HeadObjectCommand = () => {
      throw Object.assign(new Error("NotFound"), { $metadata: { httpStatusCode: 404 } });
    };
    expect(await driver.exists("users/u1/missing.pdf")).toBe(false);

    responses.HeadObjectCommand = () => ({});
    expect(await driver.exists("users/u1/f1.pdf")).toBe(true);

    responses.HeadObjectCommand = () => {
      throw Object.assign(new Error("Denied"), { $metadata: { httpStatusCode: 403 } });
    };
    await expect(driver.exists("users/u1/f1.pdf")).rejects.toThrow(/Denied/);
  });
});

describe("driver selection", () => {
  it("defaults to the local directory driver when nothing is configured", () => {
    expect(process.env.STORAGE_DRIVER ?? "local").not.toBe("s3");
    expect(getStorageDriver().name).toBe("local");
  });
  it("opens existing local objects even after configuration switches to S3", () => {
    const mutableStorage = config.storage as { driver: "local" | "s3" };
    const previous = mutableStorage.driver;
    try {
      mutableStorage.driver = "s3";
      resetStorageDriver();
      expect(getStorageDriverFor("local").name).toBe("local");
      expect(() => getStorageDriverFor("unsupported")).toThrow(/Unsupported storage driver/);
    } finally {
      mutableStorage.driver = previous;
      resetStorageDriver();
    }
  });
});
