// =============================================================
// The contract that keeps the OpenAPI document honest
// =============================================================
//
// `scripts/generate-openapi.ts` derives the endpoint set, request bodies and
// auth requirements of the public `/v1` surface by walking the live Hono
// route table (`walkV1Endpoints`). Everything else — responses, parameters,
// prose — is hand-authored in `openapi/responses.ts`
// (`HAND_AUTHORED_OPERATIONS` / `HAND_AUTHORED_ENDPOINTS`), because nothing
// in the codebase describes a response body as data.
//
// The generator itself already refuses to build a document when the two
// endpoint sets disagree (see `buildOpenApiDocument`'s own missing/stale
// check). That is defense-in-depth for `openapi:generate`, not a test — it
// only fires when someone remembers to run the generator. The first
// `describe` block below reproduces the same comparison directly against
// `walkV1Endpoints()` and `HAND_AUTHORED_ENDPOINTS`, so it fails on its own
// terms rather than by riding on `buildOpenApiDocument` throwing.
//
// This file lives in `tests/`, not colocated under `src/`, because it is not
// exercising one module — it is the seam between three: the live app
// (`src/app.ts`), the generator (`scripts/generate-openapi.ts`) and the
// hand-authored half (`openapi/responses.ts`). `tests/lib/openapi-route-walk
// .test.ts` already owns the generator's own unit behaviour (auth
// resolution, request-body conversion); this file owns the cross-cutting
// guarantee that the three stay in sync, which is what actually gates CI.
import { describe, expect, it, beforeAll } from "vitest";
import { Validator } from "@seriousme/openapi-schema-validator";
import { app } from "../src/app";
import { buildOpenApiDocument, walkV1Endpoints } from "../scripts/generate-openapi";
import { HAND_AUTHORED_ENDPOINTS } from "../openapi/responses";

/**
 * The one endpoint that is genuinely unauthenticated, pinned by name.
 *
 * A second endpoint acquiring an empty `security: []` array must fail this
 * test by name rather than pass silently — that is the whole point of
 * pinning it rather than merely asserting "at least the preview endpoint has
 * no auth".
 */
const PREVIEW_ENDPOINT = "GET /v1/preview/paywalls/:token";
const PREVIEW_OPENAPI_PATH = "/v1/preview/paywalls/{token}";
const PREVIEW_OPENAPI_METHOD = "get";

interface OpenApiOperation {
  security?: Array<Record<string, string[]>>;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
}

function asOpenApiDocument(document: Record<string, unknown>): OpenApiDocument {
  return document as unknown as OpenApiDocument;
}

describe("OpenAPI endpoint set matches the route table", () => {
  it("documents every /v1 endpoint the app actually serves, and nothing else", () => {
    // Deliberately NOT `buildOpenApiDocument(app)` — that function performs
    // this exact comparison internally and throws on mismatch, which would
    // make this assertion pass-or-throw for a reason that has nothing to do
    // with this test's own logic. Comparing `walkV1Endpoints()` directly
    // against `HAND_AUTHORED_ENDPOINTS` means this test fails (or passes) on
    // its own, independent of whether the generator would also refuse to run.
    const walked = walkV1Endpoints(app);

    const undocumented = [...walked].filter(
      (endpoint) => !HAND_AUTHORED_ENDPOINTS.has(endpoint),
    );
    const stale = [...HAND_AUTHORED_ENDPOINTS].filter(
      (endpoint) => !walked.has(endpoint),
    );

    expect(
      undocumented,
      undocumented.length > 0
        ? `The app serves ${undocumented.length} endpoint(s) with no entry in ` +
            `openapi/responses.ts HAND_AUTHORED_OPERATIONS: ${undocumented.join(", ")}. ` +
            `Add a hand-authored operation for each, or remove the route.`
        : undefined,
    ).toEqual([]);

    expect(
      stale,
      stale.length > 0
        ? `openapi/responses.ts documents ${stale.length} endpoint(s) the app no ` +
            `longer serves: ${stale.join(", ")}. Remove the stale entry from ` +
            `HAND_AUTHORED_OPERATIONS, or restore the route.`
        : undefined,
    ).toEqual([]);
  });
});

describe("emitted OpenAPI document", () => {
  // `buildOpenApiDocument` is exercised here — its own internal endpoint-set
  // check has already been proven redundant-but-consistent by the block
  // above, so calling it for the document's *content* (as opposed to its
  // endpoint set) is legitimate: there is no other way to get the
  // hand-authored responses, parameters and security merged with the
  // generated auth posture without doing the merge ourselves.
  let document: OpenApiDocument;

  beforeAll(() => {
    document = asOpenApiDocument(buildOpenApiDocument(app));
  });

  it("documents the preview endpoint, by name, as unauthenticated", () => {
    const operation = document.paths[PREVIEW_OPENAPI_PATH]?.[PREVIEW_OPENAPI_METHOD];
    expect(operation, `${PREVIEW_ENDPOINT} is missing from the emitted document`).toBeDefined();
    expect(operation!.security).toEqual([]);

    // Every OTHER operation must carry a non-empty security requirement.
    // Pinned to exactly one unauthenticated endpoint by name: a second one
    // appearing must edit this list, not slip through an "at least one" check.
    const unauthenticated = Object.entries(document.paths).flatMap(([path, operations]) =>
      Object.entries(operations)
        .filter(([, op]) => Array.isArray(op.security) && op.security.length === 0)
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(unauthenticated).toEqual([`${PREVIEW_OPENAPI_METHOD.toUpperCase()} ${PREVIEW_OPENAPI_PATH}`]);
  });

  it("does not list the browser mount (/v1/web/...) as a second endpoint set", () => {
    // The same router is mounted twice — once at `/v1`, once at
    // `/v1/web/:publicKey` for CORS-preflight-safe browser calls. It is
    // documented once, via `x-rovenue-browser-surface`; `paths` must never
    // grow a `/v1/web/...` entry, or every endpoint effectively doubles.
    const webPaths = Object.keys(document.paths).filter((path) => path.startsWith("/v1/web/"));
    expect(webPaths).toEqual([]);
  });

  it("validates as a well-formed OpenAPI 3.1 document", async () => {
    const validator = new Validator();
    const result = await validator.validate(document as unknown as Record<string, unknown>);

    expect(result.valid, result.valid ? undefined : JSON.stringify(result.errors, null, 2)).toBe(
      true,
    );
    expect(validator.version).toBe("3.1");
  });
});
