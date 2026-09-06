// =============================================================
// Route introspection — the two source corrections task 25 needs
// =============================================================
//
// ROADMAP §11's "interactive API explorer" plan generates an OpenAPI 3.1
// spec by walking Hono's route table at build time, so request shapes
// can't drift from the zod schemas. Two things block that walk today:
//
//   1. `validate()`'s returned middleware carries no recoverable link
//      back to the zod schema it wraps — `app.routes` gives you the
//      handler function, not the schema.
//   2. `/v1/events` and `/v1/sdk/sessions` each declared their own
//      `requirePublicApiKey` closure, so a route walk can't detect
//      "this route requires a public key" by reference equality the
//      way it already can for `requireSecretKey` (a single shared
//      export).
//
// Both assertions below fail on the pre-fix code: the first because
// `getRouteSchemaTag` didn't exist / returned undefined, the second
// because `eventsRoute`'s guard and `sdkSessionsRoute`'s guard were two
// distinct function objects with the same name.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import {
  getRouteSchemaTag,
  ROUTE_SCHEMA_TAG,
  validate,
} from "../../src/lib/validate";
import { requirePublicApiKey } from "../../src/middleware/api-key-auth";
import { eventsRoute } from "../../src/routes/v1/events";
import { sdkSessionsRoute } from "../../src/routes/v1/sdk-sessions";

describe("validate() route-schema tag", () => {
  it("tags the returned middleware with { target, schema }, schema by identity", () => {
    const schema = z.object({ foo: z.string() });
    const middleware = validate("json", schema);

    const tag = getRouteSchemaTag(middleware);
    expect(tag).toBeDefined();
    expect(tag?.target).toBe("json");
    // Same object, not a structurally-equal clone — a generator reading
    // .shape off a copy would silently drift from the schema Zod
    // actually validates against.
    expect(tag?.schema).toBe(schema);
  });

  it("distinguishes target per call, and returns undefined for an untagged function", () => {
    const querySchema = z.object({ page: z.string().optional() });
    const middleware = validate("query", querySchema);
    expect(getRouteSchemaTag(middleware)?.target).toBe("query");

    const plainMiddleware = async (
      _c: unknown,
      next: () => Promise<void>,
    ) => next();
    expect(getRouteSchemaTag(plainMiddleware)).toBeUndefined();
    expect(getRouteSchemaTag("not a function")).toBeUndefined();
  });

  it("tag survives a real Hono route walk", () => {
    // Mirrors how the generator will actually recover schemas: mount a
    // route with a tagged validator, then read the tag back off
    // `app.routes` rather than off the local `middleware` reference —
    // proving the symbol property is what Hono's route table carries,
    // not just something visible in this closure.
    const schema = z.object({ name: z.string() });
    const app = new Hono().post("/widgets", validate("json", schema), (c) =>
      c.json({ ok: true }),
    );

    const tagged = app.routes
      .map((route) => getRouteSchemaTag(route.handler))
      .filter((tag): tag is NonNullable<typeof tag> => tag !== undefined);

    expect(tagged).toHaveLength(1);
    expect(tagged[0].target).toBe("json");
    expect(tagged[0].schema).toBe(schema);
  });

  it("uses a well-known Symbol.for() key so a second module load still finds it", () => {
    // If this were `Symbol()` instead of `Symbol.for()`, a duplicate
    // module instance (a real risk in a monorepo with multiple
    // dependency graphs) would mint a different symbol and the tag
    // would become permanently unreadable from that copy.
    expect(ROUTE_SCHEMA_TAG).toBe(Symbol.for("rovenue.api.routeSchemaTag"));
  });
});

describe("requirePublicApiKey — single shared guard", () => {
  it("events.ts and sdk-sessions.ts reference the SAME exported function object", () => {
    expect(requirePublicApiKey).toBeTypeOf("function");

    // Extract each route's registered public-key guard by finding the
    // handler that IS the shared export, rather than by name/position —
    // this is the exact detection strategy a route walk would use.
    const eventsGuard = eventsRoute.routes.find(
      (r) => r.handler === requirePublicApiKey,
    );
    const sdkSessionsGuard = sdkSessionsRoute.routes.find(
      (r) => r.handler === requirePublicApiKey,
    );

    expect(eventsGuard).toBeDefined();
    expect(sdkSessionsGuard).toBeDefined();
    // Reference equality to each other, transitively via the shared
    // export — this is the property that makes the guard detectable at
    // all. Two independently-declared closures with the same name and
    // body would fail this even though they behave identically.
    expect(eventsGuard?.handler).toBe(sdkSessionsGuard?.handler);
  });
});
