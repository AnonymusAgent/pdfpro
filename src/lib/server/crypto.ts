/**
 * Cryptographic helpers shared by authentication, storage and payments.
 *
 * Node's built-in crypto only — no third-party dependency is trusted with
 * password hashing or token signing.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/** promisify() loses the options overload of scrypt, so wrap it explicitly. */
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/* Password hashing: scrypt with a per-password salt. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(hashB64, "base64url");
  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * Number(n) * Number(r) * 2,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Constant-time comparison performed against a real hash. Used to keep the
 * login endpoint's timing identical whether or not the account exists.
 */
export async function burnPasswordCompare(password: string): Promise<void> {
  const salt = Buffer.alloc(16, 7);
  try {
    await scrypt(password.normalize("NFKC"), salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  } catch {
    /* ignore */
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function newId(): string {
  return randomUUID();
}

export { randomUUID };

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacHex(secret: string, data: string, algorithm: "sha256" | "sha512" = "sha256"): string {
  return createHmac(algorithm, secret).update(data).digest("hex");
}

export function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function fromBase64url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export function safeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Strip control characters and collapse whitespace in user-supplied text. */
export function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, maxLength);
}

/** Sensible, conservative file-name normalisation for cloud storage. */
export function sanitizeFileName(value: unknown, fallback = "document.pdf"): string {
  if (typeof value !== "string") return fallback;
  const base = value
    .split(/[\\/]/)
    .pop()!
      .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  const hasPdfExtension = base.toLowerCase().endsWith(".pdf");
  const stem = hasPdfExtension ? base.slice(0, -4) : base;
  const limitedStem = stem.slice(0, hasPdfExtension ? 176 : 176);
  if (!limitedStem.trim()) return fallback;
  return `${limitedStem}${hasPdfExtension ? ".pdf" : ".pdf"}`;
}
