/**
 * Cloudflare for SaaS custom-hostname challenge.
 *
 * Cloudflare verifies ownership of a custom hostname by requesting
 * `https://<host>/.well-known/cf-custom-hostname-challenge/<token>` and expecting
 * the token back. The token is supplied through `CLOUDFLARE_CUSTOM_HOSTNAME_TOKEN`;
 * when it is unset (or does not match) the path answers 404 so nothing leaks.
 */
import { config } from "@/lib/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const expected = config.cloudflare.customHostnameToken;
  const { token } = await context.params;
  let decoded = token;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    decoded = token;
  }
  if (!expected || decoded !== expected) {
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  return new Response(`${expected}\n`, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
