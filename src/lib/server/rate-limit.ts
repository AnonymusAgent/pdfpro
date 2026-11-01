/**
 * Database-backed fixed-window rate limiter.
 *
 * Chosen over an in-memory counter because the application may run on several
 * instances and because limits must survive a restart (login brute-force,
 * uploads, checkout creation).
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { HttpError } from "./api";

export type RateLimitResult = { ok: boolean; count: number; limit: number; retryAfterSeconds: number };

export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const window = Math.max(1, Math.floor(windowSeconds));
  const bucketKey = `${key}:${Math.floor(Date.now() / (window * 1000))}`;
  try {
    const result = await db.execute<{ count: number }>(sql`
      insert into rate_limits (key, count, window_started_at, expires_at)
      values (${bucketKey}, 1, now(), now() + make_interval(secs => ${window}))
      on conflict (key) do update
        set count = rate_limits.count + 1,
            expires_at = rate_limits.expires_at
      returning count
    `);
    const count = Number(result.rows[0]?.count ?? 1);
    return {
      ok: count <= limit,
      count,
      limit,
      retryAfterSeconds: window - Math.floor((Date.now() / 1000) % window),
    };
  } catch {
    // Never lock users out of the product because the limiter table is missing.
    return { ok: true, count: 0, limit, retryAfterSeconds: 0 };
  }
}

export async function enforceRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const result = await rateLimit(key, limit, windowSeconds);
  if (!result.ok) {
    throw new HttpError(429, "Too many attempts. Please wait a moment and try again.", "rate_limited", {
      retryAfterSeconds: result.retryAfterSeconds,
    });
  }
  return result;
}

/** Best-effort cleanup of expired counters, called from the maintenance endpoint. */
export async function pruneRateLimits(): Promise<void> {
  await db.execute(sql`delete from rate_limits where expires_at < now() - interval '1 day'`);
}
