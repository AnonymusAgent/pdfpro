import { describe, expect, it, vi } from "vitest";
import {
  TURNSTILE_VERIFY_URL,
  normalizeHost,
  requireTurnstile,
  verifyTurnstile,
} from "@/lib/server/turnstile";

/** Minimal `fetch` double: records the call and answers with a canned reply. */
function fakeFetch(reply: Response | Error) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const KEYS = { siteKey: "0x4AAAAAAA-site", secretKey: "0x4AAAAAAA-secret" };

describe("Turnstile verification", () => {
  it("is a no-op when the deployment has no keys", async () => {
    const { impl, calls } = fakeFetch(json({ success: true }));
    const result = await verifyTurnstile({ token: "", secretKey: "", siteKey: "", fetchImpl: impl });
    expect(result).toEqual({ ok: true, skipped: true });
    expect(calls).toHaveLength(0);
  });

  it("requires a token when it is configured", async () => {
    const { impl, calls } = fakeFetch(json({ success: true }));
    const result = await verifyTurnstile({ ...KEYS, token: "   ", fetchImpl: impl });
    expect(result).toMatchObject({ ok: false, status: 400, code: "turnstile_required" });
    expect(calls).toHaveLength(0);
  });

  it("posts the secret, token and client IP to siteverify", async () => {
    const { impl, calls } = fakeFetch(json({ success: true, hostname: "pdfpro.example" }));
    const result = await verifyTurnstile({
      ...KEYS,
      token: "tok_123",
      remoteIp: "203.0.113.9",
      expectedHost: "pdfpro.example:443",
      fetchImpl: impl,
    });

    expect(result).toEqual({ ok: true, skipped: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TURNSTILE_VERIFY_URL);
    expect(calls[0].init?.method).toBe("POST");
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(body.get("secret")).toBe(KEYS.secretKey);
    expect(body.get("response")).toBe("tok_123");
    expect(body.get("remoteip")).toBe("203.0.113.9");
  });

  it("rejects a token Cloudflare does not accept, and reports why", async () => {
    const { impl } = fakeFetch(json({ success: false, "error-codes": ["invalid-input-response"] }));
    const result = await verifyTurnstile({ ...KEYS, token: "bad", fetchImpl: impl });
    expect(result).toMatchObject({ ok: false, status: 403, code: "turnstile_failed" });
    if (!result.ok) expect(result.details?.reason).toEqual(["invalid-input-response"]);
  });

  it("rejects a token minted for another hostname", async () => {
    const { impl } = fakeFetch(json({ success: true, hostname: "attacker.example" }));
    const result = await verifyTurnstile({
      ...KEYS,
      token: "tok",
      expectedHost: "pdfpro.example",
      fetchImpl: impl,
    });
    expect(result).toMatchObject({ ok: false, status: 403, code: "turnstile_hostname_mismatch" });
  });

  it("fails closed when Cloudflare answers with an error status", async () => {
    const { impl } = fakeFetch(new Response("upstream boom", { status: 502 }));
    const result = await verifyTurnstile({ ...KEYS, token: "tok", fetchImpl: impl });
    expect(result).toMatchObject({ ok: false, status: 503, code: "turnstile_unavailable" });
  });

  it("fails closed when siteverify is unreachable", async () => {
    const { impl } = fakeFetch(new Error("ECONNREFUSED"));
    const result = await verifyTurnstile({ ...KEYS, token: "tok", fetchImpl: impl });
    expect(result).toMatchObject({ ok: false, status: 503, code: "turnstile_unavailable" });
  });

  it("normalises hosts before comparing them", () => {
    expect(normalizeHost("PDFPro.Example:3000")).toBe("pdfpro.example");
    expect(normalizeHost("www.pdfpro.example")).toBe("pdfpro.example");
    expect(normalizeHost(undefined)).toBe("");
  });

  it("does not gate the auth routes while unconfigured", async () => {
    const request = new Request("http://127.0.0.1:3300/api/auth/login", { method: "POST" });
    await expect(requireTurnstile(request, undefined)).resolves.toBeUndefined();
  });
});
