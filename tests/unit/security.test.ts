import { describe, expect, it } from "vitest";
import {
  hmacHex,
  hashPassword,
  safeEqualStrings,
  sanitizeFileName,
  sanitizeText,
  sha256Hex,
  verifyPassword,
} from "@/lib/server/crypto";
import { isValidEmail, normalizeEmail, validatePassword } from "@/lib/server/auth";

describe("password hashing", () => {
  it("produces a salted, verifiable scrypt hash", async () => {
    const hash = await hashPassword("correct horse battery 9");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery 9", hash)).toBe(true);
    expect(await verifyPassword("wrong password 1", hash)).toBe(false);
  });

  it("salts each hash so identical passwords differ", async () => {
    const a = await hashPassword("same-password-123");
    const b = await hashPassword("same-password-123");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password-123", a)).toBe(true);
    expect(await verifyPassword("same-password-123", b)).toBe(true);
  });

  it("rejects malformed stored hashes instead of throwing", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything", "scrypt$1$2$3$bad")).toBe(false);
  });
});

describe("signing helpers", () => {
  it("computes stable HMAC digests", () => {
    expect(hmacHex("secret", "payload")).toBe(hmacHex("secret", "payload"));
    expect(hmacHex("secret", "payload")).not.toBe(hmacHex("other", "payload"));
    expect(hmacHex("secret", "payload", "sha512")).toHaveLength(128);
  });

  it("compares in constant time without throwing on unequal lengths", () => {
    expect(safeEqualStrings("abc", "abc")).toBe(true);
    expect(safeEqualStrings("abc", "abcd")).toBe(false);
  });

  it("hashes tokens deterministically", () => {
    expect(sha256Hex("token")).toBe(sha256Hex("token"));
    expect(sha256Hex("token")).toHaveLength(64);
  });
});

describe("input validation", () => {
  it("accepts reasonable email addresses and rejects malformed ones", () => {
    expect(isValidEmail("person@example.com")).toBe(true);
    expect(isValidEmail("person.name+tag@sub.example.co.uk")).toBe(true);
    expect(isValidEmail("person@example")).toBe(false);
    expect(isValidEmail("person example.com")).toBe(false);
    expect(isValidEmail("@example.com")).toBe(false);
    expect(normalizeEmail("  Person@Example.COM ")).toBe("person@example.com");
  });

  it("enforces the password policy", () => {
    expect(validatePassword("short1")).toMatch(/at least/i);
    expect(validatePassword("alllettersnonumber")).toMatch(/letter and one number/i);
    expect(validatePassword("password")).toMatch(/too common|at least/i);
    expect(validatePassword("person2@example.com", "person2@example.com")).toMatch(/email/i);
    expect(validatePassword("StrongPass123")).toBeNull();
  });

  it("sanitises display text", () => {
    expect(sanitizeText("  hello\u0000 world  ", 50)).toBe("hello world");
    expect(sanitizeText("x".repeat(100), 10)).toHaveLength(10);
    expect(sanitizeText(42, 10)).toBe("");
  });

  it("normalises file names and blocks traversal", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd.pdf");
    expect(sanitizeFileName("Report Final")).toBe("Report Final.pdf");
    expect(sanitizeFileName("report.PDF")).toBe("report.pdf");
    expect(sanitizeFileName("bad:name?.pdf")).toBe("badname.pdf");
    expect(sanitizeFileName("")).toBe("document.pdf");
    expect(sanitizeFileName("x".repeat(400)).length).toBeLessThanOrEqual(180);
  });
});
