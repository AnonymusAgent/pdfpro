import { describe, expect, it, vi } from "vitest";
import { errorResponse, HttpError } from "@/lib/server/api";

describe("API error responses", () => {
  it("does not expose database details when a table is missing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = new Error("query failed", { cause: Object.assign(new Error("private SQL"), { code: "42P01" }) });
      const response = errorResponse(error);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Account service is temporarily unavailable. Please contact the site administrator.",
        code: "database_unavailable",
      });
    } finally {
      log.mockRestore();
    }
  });

  it("preserves an intentional validation error", async () => {
    const response = errorResponse(new HttpError(403, "Accounts are created by an administrator.", "registration_closed"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Accounts are created by an administrator.", code: "registration_closed" });
  });

  it("keeps unknown server errors generic", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = errorResponse(new Error("private details"));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Something went wrong. Please try again.", code: "internal_error" });
    } finally {
      log.mockRestore();
    }
  });
});
