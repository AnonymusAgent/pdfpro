import { cookies } from "next/headers";
import { randomToken } from "./crypto";
import { readSession } from "./session";

const COOKIE = "pdfpro_workspace";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Isolate the browser-only PDF tools without forcing visitors to register.
 * Signed-in records follow the user across devices; guests get an opaque
 * HttpOnly cookie. Historical unscoped rows remain archived as `legacy`.
 */
export async function workspaceScope(request: Request): Promise<string> {
  const session = await readSession();
  if (session) return `user:${session.user.id}`;

  const jar = await cookies();
  const existing = jar.get(COOKIE)?.value;
  if (existing && TOKEN.test(existing)) return `guest:${existing}`;

  const token = randomToken(32);
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https",
    path: "/",
    maxAge: 365 * 24 * 3600,
  });
  return `guest:${token}`;
}
