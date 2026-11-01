import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  BASE_URL,
  Client,
  PASSWORD,
  createUser,
  db,
  extractToken,
  purgeTestUsers,
  resetRateLimits,
  uniqueEmail,
} from "./helpers";

beforeEach(async () => {
  await resetRateLimits();
  await purgeTestUsers();
});

afterAll(async () => {
  await purgeTestUsers();
  await db.end();
});

describe("registration and email verification", () => {
  it("rejects weak passwords, malformed emails and duplicates", async () => {
    const client = new Client("validation");
    const weak = await client.post("/api/auth/register", { email: uniqueEmail(), password: "short" });
    expect(weak.status).toBe(400);
    expect((weak.body as { code: string }).code).toBe("weak_password");

    const badEmail = await client.post("/api/auth/register", { email: "not-an-email", password: PASSWORD });
    expect(badEmail.status).toBe(400);
    expect((badEmail.body as { code: string }).code).toBe("invalid_email");

    const email = uniqueEmail();
    const first = await client.post<{ ok: boolean; previewUrl: string }>("/api/auth/register", { email, password: PASSWORD });
    expect(first.status).toBe(201);
    const duplicate = await new Client("dup").post("/api/auth/register", { email, password: PASSWORD });
    expect(duplicate.status).toBe(409);
    expect((duplicate.body as { code: string }).code).toBe("email_taken");
  });

  it("serves every page that needs auth without a session", async () => {
    for (const path of ["/dashboard", "/cloud", "/account", "/admin"]) {
      const response = await new Client(path).get(path);
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/login");
    }
  });

  it("blocks unverified accounts from uploading or paying", async () => {
    const client = new Client("unverified");
    const registered = await client.post<{ ok: boolean; user: { emailVerified: boolean } }>("/api/auth/register", {
      email: uniqueEmail(),
      password: PASSWORD,
    });
    expect(registered.status).toBe(201);
    expect(registered.body.user.emailVerified).toBe(false);

    const upload = await client.upload(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect(upload.status).toBe(403);
    expect((upload.body as { code: string }).code).toBe("email_unverified");

    const checkout = await client.post("/api/billing/checkout", { planId: "premium_monthly" });
    expect(checkout.status).toBe(403);
  });

  it("verifies the email token exactly once", async () => {
    const client = new Client("verify");
    const registered = await client.post<{ previewUrl: string }>("/api/auth/register", {
      email: uniqueEmail(),
      password: PASSWORD,
    });
    const token = extractToken(registered.body.previewUrl);
    expect(token).toBeTruthy();

    const ok = await client.post<{ ok: boolean }>("/api/auth/verify-email", { token });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);

    // Replaying the link for an already-verified account is harmless: it reports
    // the existing state and never creates a second verification.
    const replay = await new Client("verify-replay").post<{ ok: boolean; alreadyVerified: boolean }>(
      "/api/auth/verify-email",
      { token },
    );
    expect(replay.status).toBe(200);
    expect(replay.body.alreadyVerified).toBe(true);

    const garbage = await new Client("verify-garbage").post("/api/auth/verify-email", { token: "not-a-real-token" });
    expect(garbage.status).toBe(400);
    expect((garbage.body as { code: string }).code).toBe("invalid_token");
  });
});

describe("login, sessions and logout", () => {
  it("registers a Free account with the 2 GB quota", async () => {
    const { client, email } = await createUser();
    const session = await client.get<{
      user: { email: string; plan: string; isAdmin: boolean } | null;
      entitlements: { plan: string; quotaBytes: number; storage: { quotaBytes: number; usedBytes: number } };
      features: { googleSignIn: boolean; cardCheckout: boolean };
    }>("/api/auth/session");
    expect(session.status).toBe(200);
    expect(session.body.user?.email).toBe(email);
    expect(session.body.user?.plan).toBe("free");
    expect(session.body.user?.isAdmin).toBe(false);
    expect(session.body.entitlements.plan).toBe("free");
    expect(session.body.entitlements.quotaBytes).toBe(2_000_000_000);
    expect(session.body.entitlements.storage.usedBytes).toBe(0);
    expect(session.body.features.googleSignIn).toBe(false);
  });

  it("rejects a wrong password and accepts the right one", async () => {
    const { email, password } = await createUser();
    const client = new Client("login");
    const wrong = await client.post("/api/auth/login", { email, password: "WrongPassword123" });
    expect(wrong.status).toBe(401);
    expect((wrong.body as { code: string }).code).toBe("invalid_credentials");

    const right = await client.post<{ ok: boolean }>("/api/auth/login", { email, password });
    expect(right.status).toBe(200);
    expect(client.hasCookie("pdfpro_session")).toBe(true);
  });

  it("supports two devices independently and revokes only one", async () => {
    const { email, password, client: laptop } = await createUser();
    const phone = new Client("phone");
    expect((await phone.post("/api/auth/login", { email, password })).status).toBe(200);

    const devices = await laptop.get<{ sessions: { id: string; current: boolean }[] }>("/api/account/sessions");
    expect(devices.status).toBe(200);
    expect(devices.body.sessions.length).toBe(2);

    const other = devices.body.sessions.find((session) => !session.current);
    expect(other).toBeTruthy();
    const revoked = await laptop.post("/api/account/sessions", { sessionId: other!.id });
    expect(revoked.status).toBe(200);

    const phoneSession = await phone.get<{ user: unknown }>("/api/auth/session");
    expect(phoneSession.body.user).toBeNull();
    const laptopSession = await laptop.get<{ user: { email: string } | null }>("/api/auth/session");
    expect(laptopSession.body.user?.email).toBe(email);
  });

  it("invalidates the session on logout", async () => {
    const { client } = await createUser();
    expect((await client.get<{ user: unknown }>("/api/auth/session")).body.user).toBeTruthy();
    expect((await client.post("/api/auth/logout")).status).toBe(200);
    expect((await client.get<{ user: unknown }>("/api/auth/session")).body.user).toBeNull();
    const files = await client.get("/api/files");
    expect(files.status).toBe(401);
  });

  it("rotates the password, revoking other devices and killing the old password", async () => {
    const { email, password, client: laptop } = await createUser();
    const phone = new Client("phone");
    await phone.post("/api/auth/login", { email, password });

    const changed = await laptop.post("/api/auth/password", {
      currentPassword: password,
      newPassword: "Brand-New-Pass9",
    });
    expect(changed.status).toBe(200);

    expect((await phone.get<{ user: unknown }>("/api/auth/session")).body.user).toBeNull();
    expect((await laptop.get<{ user: unknown }>("/api/auth/session")).body.user).toBeTruthy();

    const oldPassword = await new Client("old").post("/api/auth/login", { email, password });
    expect(oldPassword.status).toBe(401);
    const newPassword = await new Client("new").post("/api/auth/login", { email, password: "Brand-New-Pass9" });
    expect(newPassword.status).toBe(200);
  });
});

describe("forgot / reset password", () => {
  it("issues a single-use reset link and revokes sessions afterwards", async () => {
    const { email, client } = await createUser();
    const anonymous = new Client("reset");
    const forgot = await anonymous.post<{ ok: boolean; previewUrl?: string }>("/api/auth/forgot-password", { email });
    expect(forgot.status).toBe(200);
    const token = extractToken(forgot.body.previewUrl);
    expect(token).toBeTruthy();

    const reset = await anonymous.post<{ ok: boolean }>("/api/auth/reset-password", { token, password: "Reset-Pass-42" });
    expect(reset.status).toBe(200);

    const replay = await new Client("replay").post("/api/auth/reset-password", { token, password: "Reset-Pass-43" });
    expect(replay.status).toBe(400);

    expect((await client.get<{ user: unknown }>("/api/auth/session")).body.user).toBeNull();
    const login = await new Client("login").post("/api/auth/login", { email, password: "Reset-Pass-42" });
    expect(login.status).toBe(200);
  });

  it("does not reveal whether an address is registered", async () => {
    const anonymous = new Client("enum");
    const response = await anonymous.post<{ ok: boolean }>("/api/auth/forgot-password", { email: uniqueEmail("nobody") });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });
});

describe("request protection", () => {
  it("rejects cross-site mutations without an Origin header", async () => {
    const { client } = await createUser();
    const response = await client.request("/api/account", {
      method: "PATCH",
      json: { displayName: "Hacked" },
      omitOrigin: true,
    });
    expect(response.status).toBe(403);
  });

  it("rejects mutations from another origin", async () => {
    const { client } = await createUser();
    const response = await client.request("/api/account", {
      method: "PATCH",
      json: { displayName: "Hacked" },
      headers: { Origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });

  it("redirects Google sign-in with a clear message when unconfigured", async () => {
    const response = await new Client("google").get("/api/auth/google/start");
    expect([302, 307]).toContain(response.status);
    expect(response.headers.get("location")).toBe(`${BASE_URL}/login?error=google_unavailable`);
  });
});
