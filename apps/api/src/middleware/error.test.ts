// =============================================================
// Error handler — unit tests for W4.4 hardening
//
// - W4.4: ZodError thrown from route code returns generic
//         "Request validation failed" message with NO field names
//         in the response body.
//
// NOTE: @hono/zod-validator uses safeParseAsync and returns its own
// 400 response, so it does NOT trigger the global errorHandler's
// ZodError branch. This test covers the case where route code calls
// schema.parse() / schema.parseAsync() and lets the ZodError bubble.
// =============================================================

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "redis://localhost:6379";

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { errorHandler } from "./error";

const testSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Build a minimal Hono app that uses the real errorHandler and calls
// schema.parse() (not zValidator) so ZodError bubbles to the handler.
// ---------------------------------------------------------------------------

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);

  app.post("/test", async (c) => {
    const body = await c.req.json();
    // Directly parse — throws ZodError on invalid input, bubbles to errorHandler.
    const validated = testSchema.parse(body);
    return c.json({ data: validated });
  });

  return app;
}

describe("W4.4: ZodError does not leak field names / schema shape", () => {
  it("returns 400 with code VALIDATION_ERROR", async () => {
    const app = buildApp();
    const res = await app.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "", age: -1 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns generic message 'Request validation failed' with NO field names", async () => {
    const app = buildApp();
    const res = await app.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 123, age: "not-a-number" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    // Generic message only — no Zod internals.
    expect(body.error.message).toBe("Request validation failed");
    // Must NOT expose field names like "name", "age", or Zod error details.
    expect(body.error.message).not.toContain("name");
    expect(body.error.message).not.toContain("age");
    expect(body.error.message).not.toContain("String");
    expect(body.error.message).not.toContain("Expected");
    expect(body.error.message).not.toContain("Received");
    expect(body.error.message).not.toContain("invalid_type");
  });

  it("response body has no field names from the schema", async () => {
    const app = buildApp();
    const res = await app.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    // The raw response body must not contain any field name from the schema.
    // (Only "error" and "code" and "message" keys are allowed at the top level.)
    expect(text).not.toContain('"name"');
    expect(text).not.toContain('"age"');
    // Must not contain full Zod error shape.
    expect(text).not.toContain("issues");
    expect(text).not.toContain("ZodError");
  });
});
