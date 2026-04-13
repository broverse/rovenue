import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { fail } from "../lib/response";

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    return c.json(fail("HTTP_ERROR", err.message), err.status);
  }

  if (err instanceof ZodError) {
    return c.json(fail("VALIDATION_ERROR", err.message), 400);
  }

  console.error("[api] unhandled error:", err);
  return c.json(fail("INTERNAL_ERROR", "Internal server error"), 500);
};
