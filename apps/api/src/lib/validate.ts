import { zValidator as zv } from "@hono/zod-validator";
import type { ZodSchema } from "zod";

// Validation failures throw the ZodError so the global errorHandler
// returns the standard { error: { code: "VALIDATION_ERROR", message: "Request validation failed" } }
// envelope instead of @hono/zod-validator's default { success: false, error: <ZodError> } shape.
// See middleware/error.ts for the ZodError branch.
// `Target` is a generic bound to the literal arg (not the bare union) so
// Hono keeps the per-target ValidationTargets metadata. Widening `target` to
// the union erases it, which collapses the typed `hc` client's input back to
// "any of form/header/param/query/json" and breaks every dashboard RPC call.
export const validate = <
  Target extends "json" | "query" | "param" | "form" | "header",
  T extends ZodSchema,
>(
  target: Target,
  schema: T,
) =>
  zv(target, schema, (result) => {
    if (!result.success) throw result.error;
  });
