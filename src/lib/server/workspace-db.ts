import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Scope the database RLS context to this one transaction/connection. A pooled
 * connection must never retain one request's user ID for the next request.
 * The route queries also include an explicit owner predicate for defense in depth.
 */
export function withWorkspaceUser<T>(
  userId: string,
  run: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user_id', ${userId}, true)`);
    return run(tx);
  });
}
