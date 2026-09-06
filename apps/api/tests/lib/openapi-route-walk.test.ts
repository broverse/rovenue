// =============================================================
// The route walk behind the generated OpenAPI document
// =============================================================
//
// `scripts/generate-openapi.ts` derives three things from the live Hono app:
// which `/v1` endpoints exist, what each accepts, and what each requires of a
// caller. The third is the one that can hurt someone if it is wrong, and it
// is the one a naive walk gets wrong, because two endpoints sit under `/v1`
// without being inside `v1Route` and they have OPPOSITE auth postures:
//
//   - `GET /v1/preview/paywalls/:token` is registered BEFORE the `/v1` mount,
//     so the `apiKeyAuth` wildcard never covers it. It is genuinely
//     unauthenticated.
//   - `GET /v1/config/stream` is registered AFTER it, so the envelope does
//     cover it, on top of the `apiKeyAuth("any")` it registers for itself.
//
// A generator that assumed "path starts with /v1 ⇒ behind the /v1 key
// envelope" would publish the first one as key-protected. These assertions
// exist so that mistake cannot be reintroduced silently — including by the
// registration-order change src/app.ts warns about in a comment but that
// nothing else enforces.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { API_KEY_KIND } from "@rovenue/shared";
import { app } from "../../src/app";
import {
  API_KEY_AUTH_TAG,
  apiKeyAuth,
  getApiKeyAuthTag,
} from "../../src/middleware/api-key-auth";
import {
  collectV1Chains,
  resolveAuth,
  resolveRequestBody,
  walkV1Endpoints,
} from "../../scripts/generate-openapi";

const PREVIEW_ENDPOINT = "GET /v1/preview/paywalls/:token";
const CONFIG_STREAM_ENDPOINT = "GET /v1/config/stream";
const TRANSFER_ENDPOINT = "POST /v1/subscribers/transfer";
const EVENTS_ENDPOINT = "POST /v1/events";

function chainFor(key: string) {
  const chain = collectV1Chains(app).find(
    (candidate) => `${candidate.method} ${candidate.path}` === key,
  );
  if (!chain) throw new Error(`${key} is not in the route table`);
  return chain;
}

describe("apiKeyAuth() tag", () => {
  it("stamps the requirement onto the middleware it returns", () => {
    expect(getApiKeyAuthTag(apiKeyAuth("any"))?.required).toBe("any");
    expect(getApiKeyAuthTag(apiKeyAuth(API_KEY_KIND.SECRET))?.required).toBe(
      API_KEY_KIND.SECRET,
    );
    // Defaulted argument, not just the explicit one.
    expect(getApiKeyAuthTag(apiKeyAuth())?.required).toBe("any");
  });

  it("returns undefined for anything that is not a tagged middleware", () => {
    expect(getApiKeyAuthTag(async () => undefined)).toBeUndefined();
    expect(getApiKeyAuthTag("not a function")).toBeUndefined();
    expect(getApiKeyAuthTag(undefined)).toBeUndefined();
  });

  it("survives a real Hono route walk", () => {
    // `apiKeyAuth()` is a factory, so reference equality — the trick that
    // finds `requireSecretKey` — cannot find it. Reading the tag back off
    // `app.routes` rather than off the local reference is what proves the
    // symbol property is what Hono's table actually carries.
    const guard = apiKeyAuth(API_KEY_KIND.PUBLIC);
    const probe = new Hono().get("/thing", guard, (c) => c.json({ ok: true }));

    const tags = probe.routes
      .map((route) => getApiKeyAuthTag(route.handler))
      .filter((tag): tag is NonNullable<typeof tag> => tag !== undefined);

    expect(tags).toHaveLength(1);
    expect(tags[0]!.required).toBe(API_KEY_KIND.PUBLIC);
  });

  it("uses a well-known Symbol.for() key", () => {
    expect(API_KEY_AUTH_TAG).toBe(Symbol.for("rovenue.api.apiKeyAuthTag"));
  });
});

describe("walkV1Endpoints", () => {
  it("emits nothing for the browser mount, which is the same router twice", () => {
    const browserPaths = [...walkV1Endpoints(app)].filter((key) =>
      key.includes("/v1/web/"),
    );
    expect(browserPaths).toEqual([]);
  });

  it("emits no wildcard or ALL-method middleware registrations", () => {
    for (const key of walkV1Endpoints(app)) {
      expect(key).not.toContain("*");
      expect(key.startsWith("ALL ")).toBe(false);
    }
  });

  it("includes both endpoints that bypass v1Route", () => {
    const endpoints = walkV1Endpoints(app);
    expect(endpoints.has(PREVIEW_ENDPOINT)).toBe(true);
    expect(endpoints.has(CONFIG_STREAM_ENDPOINT)).toBe(true);
  });

  it("collapses a route's middleware chain into one endpoint", () => {
    // `POST /v1/receipts/apple` is registered as several handlers (validate,
    // idempotency, the handler itself). Hono stores one entry per handler;
    // one endpoint is what the document must show.
    const chain = chainFor("POST /v1/receipts/apple");
    expect(chain.entries.length).toBeGreaterThan(1);
    expect(
      [...walkV1Endpoints(app)].filter((k) => k === "POST /v1/receipts/apple"),
    ).toHaveLength(1);
  });
});

describe("resolveAuth", () => {
  it("reports the preview endpoint as unauthenticated", () => {
    // The token is the only credential. If this ever flips to authenticated
    // without the route moving, the walk has started guessing from the path.
    expect(resolveAuth(chainFor(PREVIEW_ENDPOINT), app)).toEqual({
      kind: "none",
    });
  });

  it("reports the SSE stream as key-gated despite living outside v1Route", () => {
    expect(resolveAuth(chainFor(CONFIG_STREAM_ENDPOINT), app).kind).toBe("any");
  });

  it("narrows to SECRET via the shared requireSecretKey guard", () => {
    expect(resolveAuth(chainFor(TRANSFER_ENDPOINT), app)).toEqual({
      kind: "specific",
      required: API_KEY_KIND.SECRET,
    });
  });

  it("narrows to PUBLIC via the shared requirePublicApiKey guard", () => {
    expect(resolveAuth(chainFor(EVENTS_ENDPOINT), app)).toEqual({
      kind: "specific",
      required: API_KEY_KIND.PUBLIC,
    });
  });

  it("leaves every other /v1 endpoint accepting either key kind", () => {
    const unauthenticated = collectV1Chains(app).filter(
      (chain) => resolveAuth(chain, app).kind === "none",
    );
    // Exactly one, by name — a second unauthenticated endpoint appearing is
    // the kind of change that should require someone to edit this line.
    expect(
      unauthenticated.map((chain) => `${chain.method} ${chain.path}`),
    ).toEqual([PREVIEW_ENDPOINT]);
  });
});

describe("resolveRequestBody", () => {
  it("converts the zod schema the route actually validates against", () => {
    const body = resolveRequestBody(chainFor(TRANSFER_ENDPOINT));
    expect(body?.schema).toMatchObject({
      type: "object",
      required: ["fromAppUserId", "toAppUserId"],
    });
  });

  it("says `additionalProperties: false` only when the schema is .strict()", () => {
    // `checkout`'s body is `.strict()` deliberately — the comment in the
    // route calls it a security property, since a stripped-but-accepted
    // customer id would read as accepted to a client. A plain `z.object()`
    // strips instead of rejecting, and documenting THAT as a rejection
    // would be a lie in the other direction.
    expect(
      resolveRequestBody(chainFor("POST /v1/checkout"))?.schema
        .additionalProperties,
    ).toBe(false);
    expect(
      resolveRequestBody(chainFor(TRANSFER_ENDPOINT))?.schema
        .additionalProperties,
    ).toBe(true);
  });

  it("flags a body whose zod refinement JSON Schema cannot express", () => {
    // `/v1/events` superRefines "paywall_* requires paywallContext". The
    // emitted schema is therefore MORE permissive than the server, and the
    // document says so rather than pretending to be complete.
    expect(resolveRequestBody(chainFor(EVENTS_ENDPOINT))?.inexpressible)
      .toHaveLength(1);
    expect(resolveRequestBody(chainFor(TRANSFER_ENDPOINT))?.inexpressible)
      .toHaveLength(0);
  });

  it("returns undefined for a route with no validated body", () => {
    expect(resolveRequestBody(chainFor("GET /v1/config"))).toBeUndefined();
  });
});
