import { zValidator as zv } from "@hono/zod-validator";
import type { ZodSchema } from "zod";

// Validation failures throw the ZodError so the global errorHandler
// returns the standard { error: { code: "VALIDATION_ERROR", message: "Request validation failed" } }
// envelope instead of @hono/zod-validator's default { success: false, error: <ZodError> } shape.
// See middleware/error.ts for the ZodError branch.
//
// A namespaced Symbol.for() key (not a plain Symbol()) so the tag is
// recoverable even if this module is loaded twice (e.g. two copies of
// @rovenue/api in the module graph) — both loads read/write the same
// well-known symbol out of the global symbol registry.
export const ROUTE_SCHEMA_TAG = Symbol.for("rovenue.api.routeSchemaTag");

export type ValidateTarget = "json" | "query" | "param" | "form" | "header";

export interface RouteSchemaTag<
  Target extends ValidateTarget = ValidateTarget,
  T extends ZodSchema = ZodSchema,
> {
  target: Target;
  schema: T;
}

/**
 * Recovers the `{ target, schema }` tag a `validate()` middleware was
 * stamped with, if any. Used by the OpenAPI generator walking Hono's
 * `app.routes` to find which zod schema validates a given route — without
 * this, request shapes can silently drift from the generated spec.
 */
export function getRouteSchemaTag(
  handler: unknown,
): RouteSchemaTag | undefined {
  if (typeof handler !== "function") return undefined;
  return (handler as unknown as Record<symbol, unknown>)[
    ROUTE_SCHEMA_TAG
  ] as RouteSchemaTag | undefined;
}

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
) => {
  const middleware = zv(target, schema, (result) => {
    if (!result.success) throw result.error;
  });

  // Symbol-keyed so it never collides with (or is enumerated alongside)
  // any property Hono/zod-validator itself might put on the function.
  // Non-enumerable for the same reason — this is metadata for the route
  // walker, not part of the middleware's public shape.
  Object.defineProperty(middleware, ROUTE_SCHEMA_TAG, {
    value: { target, schema } satisfies RouteSchemaTag<Target, T>,
    enumerable: false,
    configurable: true,
  });

  return middleware;
};
