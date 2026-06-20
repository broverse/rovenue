import { zValidator as zv } from "@hono/zod-validator";
import type { ZodSchema } from "zod";

// Validation failures throw the ZodError so the global errorHandler
// returns the standard { error: { code: "VALIDATION_ERROR", message: "Request validation failed" } }
// envelope instead of @hono/zod-validator's default { success: false, error: <ZodError> } shape.
// See middleware/error.ts for the ZodError branch.
export const validate = <T extends ZodSchema>(
  target: "json" | "query" | "param" | "form" | "header",
  schema: T,
) =>
  zv(target, schema, (result) => {
    if (!result.success) throw result.error;
  });
