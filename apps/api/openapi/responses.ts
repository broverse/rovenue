// =============================================================
// Hand-maintained half of the OpenAPI document
// =============================================================
//
// `scripts/generate-openapi.ts` derives the *endpoint set*, the *request
// bodies* and the *auth requirement* of the public `/v1` surface from the
// running Hono app — those three cannot drift, because they are read out of
// the thing that serves traffic.
//
// Everything in THIS file is hand-written, because nothing in the codebase
// describes it as data:
//
//   - Response bodies. `ok<T>(data)` (src/lib/response.ts) is a bare identity
//     generic: `T` is inferred structurally at compile time and erased at
//     runtime. There is no value to read at generation time, so a generator
//     that emitted response schemas would be inventing them.
//   - Parameters. No route in the tree calls `validate("query")` or
//     `validate("param")`; every `:appUserId`, `:identifier` and `?locale` is
//     read ad hoc via `c.req.param()` / `c.req.query()`. Same problem.
//
// The consequence a reader deserves to know: this half CAN silently drift
// from the implementation, and the generated half cannot. The contract test
// that pairs `walkV1Endpoints()` with `HAND_AUTHORED_ENDPOINTS` closes the
// drift that matters most — an endpoint appearing, disappearing or being
// renamed with nobody updating its documentation — but it cannot tell you
// that a response field was added.
//
// Keys are `"<METHOD> <hono path>"`, using Hono's `:param` syntax exactly as
// it appears in `app.routes`, so the two sets are comparable without any
// normalisation step that could paper over a real difference. The generator
// rewrites `:param` to OpenAPI's `{param}` when it emits the document.

export type JsonSchema = Record<string, unknown>;

export interface ParameterObject {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  description: string;
  schema: JsonSchema;
}

export interface ResponseObject {
  description: string;
  content?: Record<string, { schema: JsonSchema }>;
  headers?: Record<string, { description: string; schema: JsonSchema }>;
}

export interface HandAuthoredOperation {
  summary: string;
  description?: string;
  tags: string[];
  parameters?: ParameterObject[];
  responses: Record<string, ResponseObject>;
}

// -------------------------------------------------------------
// Envelope helpers
// -------------------------------------------------------------

const JSON_MEDIA_TYPE = "application/json";

/** `{ data: T }` — the success half of the response convention. */
function data(schema: JsonSchema, description: string): ResponseObject {
  return {
    description,
    content: {
      [JSON_MEDIA_TYPE]: {
        schema: {
          type: "object",
          required: ["data"],
          additionalProperties: false,
          properties: { data: schema },
        },
      },
    },
  };
}

/**
 * A payload this file does not describe field-by-field, because the handler
 * returns a service result whose shape lives only in TypeScript types.
 * Marked rather than guessed: `{}` in JSON Schema 2020-12 accepts anything,
 * which is the honest statement here.
 */
function opaque(what: string): JsonSchema {
  return {
    description: `${what}. Shape is not machine-derived — see the note at the top of openapi/responses.ts.`,
  };
}

const ERROR_ENVELOPE_REF: JsonSchema = {
  $ref: "#/components/schemas/ErrorEnvelope",
};

function error(description: string): ResponseObject {
  return {
    description,
    content: { [JSON_MEDIA_TYPE]: { schema: ERROR_ENVELOPE_REF } },
  };
}

/** Schemas the generator copies into `components.schemas`. */
export const SHARED_SCHEMAS: Record<string, JsonSchema> = {
  ErrorEnvelope: {
    type: "object",
    required: ["error"],
    additionalProperties: false,
    description:
      "Every non-2xx response in the API uses this shape. `code` is a stable machine-readable identifier; `message` is human-facing and may change.",
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        additionalProperties: false,
        properties: {
          code: { type: "string" },
          message: { type: "string" },
        },
      },
    },
  },
  SubscriberSummary: {
    type: "object",
    required: ["id", "appUserId", "attributes"],
    properties: {
      id: { type: "string", description: "Rovenue-owned subscriber id (cuid2)." },
      appUserId: {
        type: "string",
        description: "The SDK wire identity (`rovenueId`) for this subscriber.",
      },
      attributes: {
        type: "object",
        additionalProperties: { type: ["string", "null"] },
        description: "Flattened custom attributes.",
      },
    },
  },
};

// -------------------------------------------------------------
// Reusable parameters
// -------------------------------------------------------------

const SUBSCRIBER_ID_QUERY: ParameterObject = {
  name: "subscriberId",
  in: "query",
  required: false,
  description:
    "SDK wire identity of the subscriber. Required unless supplied via the `X-Rovenue-User-Id` header; a request carrying neither is rejected with 400.",
  schema: { type: "string" },
};

const SUBSCRIBER_ID_HEADER: ParameterObject = {
  name: "X-Rovenue-User-Id",
  in: "header",
  required: false,
  description:
    "SDK wire identity of the subscriber. Fallback for the `subscriberId` query parameter; the query parameter wins when both are present.",
  schema: { type: "string" },
};

const ENV_QUERY: ParameterObject = {
  name: "env",
  in: "query",
  required: false,
  description:
    "Feature-flag environment to evaluate against. Defaults to `prod` when absent from both the query and the `X-Rovenue-Env` header.",
  schema: {
    type: "string",
    enum: [
      "prod",
      "production",
      "PROD",
      "PRODUCTION",
      "staging",
      "STAGING",
      "development",
      "dev",
      "DEVELOPMENT",
      "DEV",
    ],
  },
};

const ENV_HEADER: ParameterObject = {
  name: "X-Rovenue-Env",
  in: "header",
  required: false,
  description: "Fallback for the `env` query parameter.",
  schema: { type: "string" },
};

const APP_USER_ID_HEADER: ParameterObject = {
  name: "X-Rovenue-App-User-Id",
  in: "header",
  required: true,
  description:
    "Device key (the SDK's permanent `rovenueId`). `appUserContext` resolves or creates the subscriber from it; absent, the request is rejected with 400.",
  schema: { type: "string" },
};

const PLATFORM_HEADER: ParameterObject = {
  name: "X-Rovenue-Platform",
  in: "header",
  required: false,
  description:
    "First-install platform (`ios`, `android`, `web`). Persisted only when this call creates the subscriber; ignored otherwise.",
  schema: { type: "string", enum: ["ios", "android", "web"] },
};

const IDEMPOTENCY_KEY_HEADER: ParameterObject = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  description:
    "Opaque client-chosen key (≤255 chars). The first 2xx response is cached for 24h per project and replayed for repeats; a repeat carrying a different body is rejected with 422. Redis failures fail open, so dedup is best-effort.",
  schema: { type: "string", maxLength: 255 },
};

function pathParam(name: string, description: string): ParameterObject {
  return { name, in: "path", required: true, description, schema: { type: "string" } };
}

const APP_USER_ID_PATH = pathParam(
  "appUserId",
  "SDK wire identity of the subscriber.",
);

// -------------------------------------------------------------
// Reusable responses
// -------------------------------------------------------------

const UNAUTHORIZED = error(
  "Missing, malformed, revoked or expired API key.",
);
const FORBIDDEN_KIND = error(
  "The presented key is the wrong kind for this endpoint.",
);
const VALIDATION_FAILED = error(
  "Request body failed Zod validation (`VALIDATION_ERROR`), or a required identity/parameter was absent.",
);
const RATE_LIMITED = error(
  "Rate limit exceeded — the global per-IP limiter or the 500 req/min per-API-key envelope.",
);
const SERVER_ERROR = error("Unhandled server error.");

/** The error responses every key-gated `/v1` endpoint can return. */
function guarded(extra: Record<string, ResponseObject> = {}) {
  return {
    "401": UNAUTHORIZED,
    "429": RATE_LIMITED,
    "500": SERVER_ERROR,
    ...extra,
  };
}

const ACCESS_MAP: JsonSchema = opaque(
  "Denormalised entitlement access map, keyed by entitlement identifier",
);


// -------------------------------------------------------------
// Data subject requests
// -------------------------------------------------------------

const DSAR_ID_PATH: ParameterObject = {
  name: "id",
  in: "path",
  required: true,
  description: "The DSAR request id.",
  schema: { type: "string" },
};

// Mirrors `serializeDsarRequest` in routes/v1/dsar.ts. `downloadReady` is
// derived there, not stored: COMPLETED, with an artifact, not past
// `expiresAt`.
const DSAR_REQUEST_ENVELOPE: JsonSchema = {
  type: "object",
  required: ["request"],
  properties: {
    request: {
      type: "object",
      required: ["id", "type", "status", "requestedBy", "downloadReady"],
      properties: {
        id: { type: "string" },
        type: { type: "string", enum: ["EXPORT", "ERASURE"] },
        status: {
          type: "string",
          enum: ["PENDING", "RUNNING", "COMPLETED", "FAILED"],
        },
        requestedBy: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        completedAt: { type: "string", format: "date-time", nullable: true },
        expiresAt: { type: "string", format: "date-time", nullable: true },
        error: { type: "string", nullable: true },
        downloadReady: {
          type: "boolean",
          description:
            "True only when the artifact can be fetched right now: status COMPLETED, an artifact present, and not past expiresAt.",
        },
      },
    },
  },
};

const DSAR_SUBSCRIBER_NOT_FOUND = error(
  "No subscriber matches the supplied `appUserId` in this project.",
);
const DSAR_REQUEST_NOT_FOUND = error(
  "No DSAR request with this id belongs to the calling project. Returned for another project's id too, deliberately.",
);
const DSAR_DOWNLOAD_UNAVAILABLE = error(
  "No download is available: the request is not COMPLETED, has no artifact, the link has expired, or the object is no longer in storage.",
);

// -------------------------------------------------------------
// Operations
// -------------------------------------------------------------

const TAG_CONFIG = "Remote config";
const TAG_SUBSCRIBERS = "Subscribers";
const TAG_COMMERCE = "Commerce";
const TAG_PAYWALLS = "Paywalls & placements";
const TAG_EXPERIMENTS = "Experiments";
const TAG_TELEMETRY = "Telemetry";
const TAG_CREDITS = "Virtual currencies";
const TAG_FUNNELS = "Funnels";
const TAG_DSAR = "Data subject requests";

/** Description per tag. The generator emits only the tags actually used. */
export const TAG_DESCRIPTIONS: Record<string, string> = {
  [TAG_DSAR]:
    "GDPR/KVKK data subject requests: open an export or erasure for a subscriber, poll its status, and download the finished artifact. Every route requires the project SECRET key, never the public one — these act on a subscriber's behalf and must not be reachable from a shipped app bundle.",
  [TAG_CONFIG]:
    "Per-subscriber feature flags and experiment assignments, by request or over a live SSE stream.",
  [TAG_SUBSCRIBERS]:
    "Reading and mutating subscriber identity, attributes and entitlement access. `/v1/me/*` resolves the subscriber from a header; the `/v1/subscribers/*` family names them in the path.",
  [TAG_COMMERCE]:
    "Store receipts, offerings and the Stripe checkout/billing-portal handoff.",
  [TAG_PAYWALLS]:
    "Resolving a placement to the paywall a subscriber should see, plus the draft-preview and font-delivery endpoints that support the builder.",
  [TAG_EXPERIMENTS]:
    "Exposure and conversion recording, and the ClickHouse-backed results read.",
  [TAG_TELEMETRY]:
    "Fire-and-forget event ingestion. Both endpoints answer 202 with no body and require a PUBLIC key.",
  [TAG_CREDITS]:
    "Virtual-currency balances and ledger transactions. Grants and spends are server-side only.",
  [TAG_FUNNELS]:
    "Claiming a web-funnel purchase onto an app install.",
};

export const HAND_AUTHORED_OPERATIONS: Record<string, HandAuthoredOperation> = {
  // -----------------------------------------------------------
  // Data subject requests (GDPR/KVKK)
  //
  // Every route here is `requireSecretKey`, not the public API key. That
  // is deliberate and documented at routes/v1/dsar.ts:29 — these act on a
  // subscriber's behalf and must never be reachable from a shipped app
  // bundle. `guarded()` supplies 401/429/500.
  // -----------------------------------------------------------
  "POST /v1/dsar/export": {
    summary: "Open a data-export request for a subscriber",
    description:
      "Server-to-server only (secret key). Enqueues an export job and returns the request row. Opening a second request of the same type while one is still PENDING or RUNNING returns the request already open rather than creating a duplicate, so the call is safe to retry.",
    tags: [TAG_DSAR],
    responses: guarded({
      "200": data(DSAR_REQUEST_ENVELOPE, "The DSAR request, newly created or already open."),
      "400": VALIDATION_FAILED,
      "404": DSAR_SUBSCRIBER_NOT_FOUND,
    }),
  },

  "POST /v1/dsar/erasure": {
    summary: "Open an erasure request for a subscriber",
    description:
      "Server-to-server only (secret key). Enqueues an erasure job and returns the request row. Same single-open-request semantics as the export route.",
    tags: [TAG_DSAR],
    responses: guarded({
      "200": data(DSAR_REQUEST_ENVELOPE, "The DSAR request, newly created or already open."),
      "400": VALIDATION_FAILED,
      "404": DSAR_SUBSCRIBER_NOT_FOUND,
    }),
  },

  "GET /v1/dsar/:id": {
    summary: "Read one DSAR request's status",
    description:
      "Server-to-server only (secret key). Scoped to the calling project: a request belonging to another project is reported as 404, never as 403, so the endpoint does not confirm the existence of other projects' ids.",
    tags: [TAG_DSAR],
    parameters: [DSAR_ID_PATH],
    responses: guarded({
      "200": data(DSAR_REQUEST_ENVELOPE, "The DSAR request."),
      "404": DSAR_REQUEST_NOT_FOUND,
    }),
  },

  "GET /v1/dsar/:id/download": {
    summary: "Download a completed export artifact",
    description:
      "Server-to-server only (secret key). Streams the artifact as `application/octet-stream` with a `Content-Disposition` attachment filename — this is the one `/v1` response that is not a JSON envelope. Returns 404, not 410, for every unavailable case: the request is not COMPLETED, it has no artifact, the link has expired, or the object is gone from storage. Check `downloadReady` on the request first.",
    tags: [TAG_DSAR],
    parameters: [DSAR_ID_PATH],
    responses: guarded({
      "200": {
        description:
          "The export artifact, streamed. Not JSON — an opaque binary body.",
        content: {
          "application/octet-stream": {
            schema: { type: "string", format: "binary" },
          },
        },
      },
      "404": DSAR_DOWNLOAD_UNAVAILABLE,
    }),
  },

  // ---------------- Remote config ----------------
  "GET /v1/config": {
    summary: "Evaluate remote config for a subscriber",
    description:
      "Returns the subscriber's evaluated feature flags and experiment assignments.",
    tags: [TAG_CONFIG],
    parameters: [SUBSCRIBER_ID_QUERY, SUBSCRIBER_ID_HEADER, ENV_QUERY, ENV_HEADER],
    responses: guarded({
      "200": data(
        {
          type: "object",
          required: ["flags", "experiments"],
          properties: {
            flags: opaque("Evaluated feature flags, keyed by flag key"),
            experiments: opaque("Experiment assignments for this subscriber"),
          },
        },
        "Evaluated config.",
      ),
      "400": VALIDATION_FAILED,
    }),
  },
  "POST /v1/config": {
    summary: "Evaluate remote config with request-scoped attributes",
    description:
      "Identical to `GET /v1/config`, but the body carries attributes that participate in audience evaluation for this call only — they are not persisted on the subscriber.",
    tags: [TAG_CONFIG],
    parameters: [SUBSCRIBER_ID_QUERY, SUBSCRIBER_ID_HEADER, ENV_QUERY, ENV_HEADER],
    responses: guarded({
      "200": data(
        {
          type: "object",
          required: ["flags", "experiments"],
          properties: {
            flags: opaque("Evaluated feature flags, keyed by flag key"),
            experiments: opaque("Experiment assignments for this subscriber"),
          },
        },
        "Evaluated config.",
      ),
      "400": VALIDATION_FAILED,
    }),
  },
  "GET /v1/config/stream": {
    summary: "Stream remote config over SSE",
    description:
      "Server-sent events carrying the same evaluated `{ flags, experiments }` payload as `GET /v1/config`: an `initial` event on connect, an `invalidate` event whenever the project's flag/experiment/audience config changes, and a `ping` keepalive every 25s. The connection is held open until the client disconnects.\n\nMounted at the root app rather than inside `v1Route` (see `routes/v1/config-stream.ts`), and it registers its OWN `apiKeyAuth(\"any\")`. Because it is registered *after* the `/v1` mount, the `v1Route` envelope's `apiKeyAuth` and per-key rate limiter also apply — so the key check runs twice.",
    tags: [TAG_CONFIG],
    parameters: [SUBSCRIBER_ID_QUERY, SUBSCRIBER_ID_HEADER, ENV_QUERY, ENV_HEADER],
    responses: guarded({
      "200": {
        description:
          "An open `text/event-stream`. Event names: `initial`, `invalidate`, `ping`. The `data` of `initial`/`invalidate` is `{ flags, experiments, projectId }` — note this is NOT wrapped in the `{ data }` envelope.",
        content: { "text/event-stream": { schema: { type: "string" } } },
      },
      "400": VALIDATION_FAILED,
    }),
  },

  // ---------------- Subscribers ----------------
  "GET /v1/me": {
    summary: "Fetch the calling subscriber and their access map",
    tags: [TAG_SUBSCRIBERS],
    parameters: [APP_USER_ID_HEADER, PLATFORM_HEADER],
    responses: guarded({
      "200": data(
        {
          type: "object",
          required: ["subscriber", "access"],
          properties: {
            subscriber: { $ref: "#/components/schemas/SubscriberSummary" },
            access: ACCESS_MAP,
          },
        },
        "The subscriber and their entitlement access map.",
      ),
      "400": VALIDATION_FAILED,
    }),
  },
  "GET /v1/me/access": {
    summary: "Fetch the calling subscriber's access map",
    tags: [TAG_SUBSCRIBERS],
    parameters: [APP_USER_ID_HEADER, PLATFORM_HEADER],
    responses: guarded({
      "200": data(
        { type: "object", required: ["access"], properties: { access: ACCESS_MAP } },
        "Entitlement access map.",
      ),
      "400": VALIDATION_FAILED,
    }),
  },
  "GET /v1/me/entitlements": {
    summary: "List the calling subscriber's entitlements",
    tags: [TAG_SUBSCRIBERS],
    parameters: [APP_USER_ID_HEADER, PLATFORM_HEADER],
    responses: guarded({
      "200": data(
        {
          type: "object",
          required: ["entitlements"],
          properties: {
            entitlements: opaque("Entitlement records granted to the subscriber"),
          },
        },
        "Entitlements.",
      ),
      "400": VALIDATION_FAILED,
    }),
  },
  "POST /v1/me/attributes": {
    summary: "Merge custom attributes onto the calling subscriber",
    tags: [TAG_SUBSCRIBERS],
    parameters: [APP_USER_ID_HEADER, PLATFORM_HEADER],
    responses: guarded({
      "200": data(
        {
          type: "object",
          required: ["subscriber"],
          properties: {
            subscriber: { $ref: "#/components/schemas/SubscriberSummary" },
          },
        },
        "The subscriber with merged attributes.",
      ),
      "400": VALIDATION_FAILED,
    }),
  },
  "GET /v1/subscribers/:appUserId/access": {
    summary: "Fetch a subscriber's access map by wire identity",
    tags: [TAG_SUBSCRIBERS],
    parameters: [APP_USER_ID_PATH],
    responses: guarded({
      "200": data(
        { type: "object", required: ["access"], properties: { access: ACCESS_MAP } },
        "Entitlement access map.",
      ),
    }),
  },
  "POST /v1/subscribers/:appUserId/restore": {
    summary: "Restore purchases for a subscriber",
    description:
      "Re-validates the supplied store receipts and re-derives entitlements.",
    tags: [TAG_SUBSCRIBERS],
    parameters: [APP_USER_ID_PATH],
    responses: guarded({
      "200": data(
        {
          type: "object",
          required: ["access", "restored"],
          properties: {
            access: ACCESS_MAP,
            restored: opaque("Purchases recovered by this call"),
          },
        },
        "Restored purchases and the resulting access map.",
      ),
      "400": VALIDATION_FAILED,
    }),
  },
  "POST /v1/subscribers/:appUserId/attributes": {
    summary: "Merge custom attributes onto a subscriber by wire identity",
    tags: [TAG_SUBSCRIBERS],
    parameters: [APP_USER_ID_PATH],
    responses: guarded({
      "200": data(
        {
          type: "object",
          required: ["subscriber"],
          properties: {
            subscriber: { $ref: "#/components/schemas/SubscriberSummary" },
          },
        },
        "The subscriber with merged attributes.",
      ),
      "400": VALIDATION_FAILED,
    }),
  },
  "POST /v1/subscribers/transfer": {
    summary: "Merge one subscriber into another",
    description:
      "The server-side half of the SDK's `identify()`. `identify()` itself is client-local — there is no public-key alias endpoint — so an actual merge must come through here with a SECRET key.",
    tags: [TAG_SUBSCRIBERS],
    responses: guarded({
      "200": data(
        opaque("Merge result"),
        "The merge outcome.",
      ),
      "400": VALIDATION_FAILED,
      "403": FORBIDDEN_KIND,
    }),
  },
  "POST /v1/identify": {
    summary: "Resolve or create a subscriber for the SDK's wire identity",
    tags: [TAG_SUBSCRIBERS],
    responses: guarded({
      "200": data(opaque("Resolved subscriber"), "The resolved subscriber."),
      "400": VALIDATION_FAILED,
    }),
  },

  // ---------------- Commerce ----------------
  "POST /v1/receipts/apple": {
    summary: "Submit an Apple App Store receipt",
    description:
      "The JWS chain is verified against the pinned Apple Root CAs; the verifier fails closed in production when `APPLE_ROOT_CERTS_DIR` is unset.",
    tags: [TAG_COMMERCE],
    parameters: [IDEMPOTENCY_KEY_HEADER],
    responses: guarded({
      "200": data(
        opaque("Normalised purchase/subscription state derived from the receipt"),
        "Receipt accepted.",
      ),
      "400": VALIDATION_FAILED,
      "422": error(
        "The `Idempotency-Key` was reused with a different request body.",
      ),
    }),
  },
  "POST /v1/receipts/google": {
    summary: "Submit a Google Play purchase token",
    tags: [TAG_COMMERCE],
    parameters: [IDEMPOTENCY_KEY_HEADER],
    responses: guarded({
      "200": data(
        opaque("Normalised purchase/subscription state derived from the purchase"),
        "Receipt accepted.",
      ),
      "400": VALIDATION_FAILED,
      "422": error(
        "The `Idempotency-Key` was reused with a different request body.",
      ),
    }),
  },
  "POST /v1/checkout": {
    summary: "Create a Stripe Checkout session",
    tags: [TAG_COMMERCE],
    parameters: [APP_USER_ID_HEADER, PLATFORM_HEADER],
    responses: guarded({
      "200": data(opaque("Stripe Checkout session"), "Checkout session created."),
      "400": error(
        "Validation failed, or the project has no connected Stripe account.",
      ),
    }),
  },
  "POST /v1/billing-portal": {
    summary: "Create a Stripe billing-portal session",
    tags: [TAG_COMMERCE],
    parameters: [APP_USER_ID_HEADER, PLATFORM_HEADER],
    responses: guarded({
      "200": data(opaque("Stripe billing-portal session"), "Portal session created."),
      "400": VALIDATION_FAILED,
    }),
  },
  "POST /v1/purchases/apple-offer-signature": {
    summary: "Sign an Apple promotional offer",
    description:
      "Signs with the project's In-App Purchase key (which is NOT the App Store Connect API key).",
    tags: [TAG_COMMERCE],
    responses: guarded({
      "200": data(
        {
          type: "object",
          required: ["keyIdentifier", "nonce", "signature", "timestamp"],
          properties: {
            keyIdentifier: { type: "string" },
            nonce: { type: "string" },
            signature: { type: "string" },
            timestamp: { type: "integer" },
          },
        },
        "Signature material for `SKPaymentDiscount` / StoreKit 2.",
      ),
      "400": error(
        "Validation failed, `apple_offer_signing_unavailable` (no configured credentials), or `apple_offer_signing_failed`.",
      ),
    }),
  },
  "GET /v1/offerings": {
    summary: "List offerings with hydrated products",
    description:
      "An OFFERING-type experiment can override which offering is marked current when the caller identifies a subscriber.",
    tags: [TAG_COMMERCE],
    parameters: [SUBSCRIBER_ID_QUERY, SUBSCRIBER_ID_HEADER],
    responses: guarded({
      "200": data(
        {
          type: "object",
          required: ["offerings"],
          properties: { offerings: { type: "array", items: opaque("Offering") } },
        },
        "The project's offerings.",
      ),
    }),
  },
  "GET /v1/offerings/:identifier": {
    summary: "Fetch one offering by identifier",
    tags: [TAG_COMMERCE],
    parameters: [
      pathParam("identifier", "Offering identifier."),
      SUBSCRIBER_ID_QUERY,
      SUBSCRIBER_ID_HEADER,
    ],
    responses: guarded({
      "200": data(
        {
          type: "object",
          required: ["identifier", "isDefault", "packages", "metadata"],
          properties: {
            identifier: { type: "string" },
            isDefault: { type: "boolean" },
            packages: { type: "array", items: opaque("Package entry") },
            metadata: opaque("Offering metadata"),
          },
        },
        "The offering. `packages` is empty when no product could be hydrated.",
      ),
      "404": error("No offering with that identifier in this project."),
    }),
  },

  // ---------------- Paywalls & placements ----------------
  "GET /v1/placements/:identifier": {
    summary: "Resolve a placement to a paywall or paywall experiment",
    description:
      "Walks the placement's ordered audience rows to a remote-config paywall or a `type=PAYWALL` experiment. An unknown identifier returns an empty envelope with 200 — never a 404 — so a placement removed server-side degrades to 'show nothing' rather than an SDK error.",
    tags: [TAG_PAYWALLS],
    parameters: [
      pathParam("identifier", "Placement identifier."),
      {
        name: "locale",
        in: "query",
        required: false,
        description:
          "BCP-47 tag. Text resolves by LANGUAGE: the exact tag, then shorter prefixes, then the paywall's default — case-insensitively.",
        schema: { type: "string" },
      },
      SUBSCRIBER_ID_QUERY,
      SUBSCRIBER_ID_HEADER,
    ],
    responses: guarded({
      "200": data(
        {
          type: "object",
          required: ["placement", "paywall", "experiment"],
          properties: {
            placement: opaque("The matched placement, or null"),
            paywall: opaque("The published paywall snapshot, or null"),
            experiment: opaque("The paywall experiment envelope, or null"),
          },
        },
        "The resolved placement. All three fields are null for an unknown or unmatched placement.",
      ),
    }),
  },
  "GET /v1/preview/paywalls/:token": {
    summary: "Fetch a DRAFT paywall for on-device preview",
    description:
      "**Unauthenticated.** Mounted at the root app *before* `v1Route`, so the `/v1` API-key envelope never runs for it (see the registration-order comment in `src/app.ts`). The opaque token minted by `POST /dashboard/projects/:projectId/paywalls/:id/preview-sessions` is the only credential, and a dedicated 120 req/min limiter keyed on its hash is the only other guard.\n\nServes `paywalls.builderConfig` — the DRAFT — which is the one sanctioned exception to the draft/publish split.\n\nMissing, expired, revoked and malformed tokens are deliberately indistinguishable: all four return the same 404 `PREVIEW_SESSION_INVALID`, so the endpoint cannot be used as an enumeration oracle.",
    tags: [TAG_PAYWALLS],
    parameters: [
      pathParam("token", "Opaque preview-session token."),
      {
        name: "locale",
        in: "query",
        required: false,
        description: "BCP-47 tag; resolved by language as elsewhere.",
        schema: { type: "string" },
      },
      {
        name: "If-None-Match",
        in: "header",
        required: false,
        description:
          "Conditional fetch against the draft's revision. The SDK polls every 2s and relies on this.",
        schema: { type: "string" },
      },
    ],
    responses: {
      "200": data(
        opaque("Hydrated draft paywall, plus a `revision` cache-buster"),
        "The draft paywall.",
      ),
      "404": error(
        "`PREVIEW_SESSION_INVALID` — token missing, expired, revoked, or unknown. Indistinguishable by design.",
      ),
      "429": RATE_LIMITED,
      "500": SERVER_ERROR,
    },
  },
  "GET /v1/fonts/:faceId/:contentHash/file": {
    summary: "Download a paywall font face",
    description:
      "Content-addressed: the response is `immutable` for a year, so a changed face is a changed URL.",
    tags: [TAG_PAYWALLS],
    parameters: [
      pathParam("faceId", "Font face id."),
      pathParam(
        "contentHash",
        "Content hash of the face. A mismatch is reported as 404, not as a redirect.",
      ),
    ],
    responses: guarded({
      "200": {
        description:
          "The raw font bytes. Content-Type is the face's format (woff2/woff/ttf/otf), or `application/octet-stream` when unrecognised.",
        content: {
          "application/octet-stream": { schema: { type: "string", format: "binary" } },
        },
        headers: {
          ETag: {
            description: "The face's content hash, quoted.",
            schema: { type: "string" },
          },
          "Cache-Control": {
            description: "`public, max-age=…, immutable`.",
            schema: { type: "string" },
          },
        },
      },
      "404": error(
        "No such face, wrong content hash, or the face belongs to another project — all reported identically.",
      ),
    }),
  },

  // ---------------- Experiments ----------------
  "POST /v1/experiments/track": {
    summary: "Record experiment conversion events",
    tags: [TAG_EXPERIMENTS],
    parameters: [SUBSCRIBER_ID_QUERY, SUBSCRIBER_ID_HEADER],
    responses: guarded({
      "200": data(
        {
          type: "object",
          required: ["recorded"],
          properties: {
            recorded: {
              type: "integer",
              description: "Number of events accepted from the batch.",
            },
          },
        },
        "Events recorded.",
      ),
      "400": VALIDATION_FAILED,
    }),
  },
  "POST /v1/experiments/:id/expose": {
    summary: "Record an experiment exposure",
    tags: [TAG_EXPERIMENTS],
    parameters: [pathParam("id", "Experiment id.")],
    responses: guarded({
      "200": data(
        {
          type: "object",
          required: ["accepted"],
          properties: { accepted: { type: "boolean" } },
        },
        "Exposure accepted.",
      ),
      "400": VALIDATION_FAILED,
    }),
  },
  "GET /v1/experiments/:id/results": {
    summary: "Fetch experiment results",
    description:
      "ClickHouse-backed statistics (SRM plus per-variant exposures). Scoped to the authenticated project, so a cross-project id surfaces as 'experiment not found' rather than leaking existence.",
    tags: [TAG_EXPERIMENTS],
    parameters: [pathParam("id", "Experiment id.")],
    responses: guarded({
      "200": data(opaque("Experiment result statistics"), "Results."),
      "404": error("No such experiment in this project."),
    }),
  },

  // ---------------- Telemetry ----------------
  "POST /v1/events": {
    summary: "Ingest an SDK event",
    description:
      "Writes an `outbox_events` row inside the request transaction; the dispatcher publishes to Kafka. This is the only path to Kafka — nothing here dual-writes.",
    tags: [TAG_TELEMETRY],
    responses: guarded({
      "202": { description: "Accepted. Empty body." },
      "400": VALIDATION_FAILED,
      "403": FORBIDDEN_KIND,
    }),
  },
  "POST /v1/sdk/sessions": {
    summary: "Ingest a batch of SDK session events",
    description:
      "Produced straight to Kafka with a content-derived, therefore stable, `eventId` — the SDK dispatcher is at-least-once, so a replayed batch must collapse rather than duplicate.",
    tags: [TAG_TELEMETRY],
    responses: guarded({
      "202": { description: "Accepted. Empty body." },
      "400": VALIDATION_FAILED,
      "403": FORBIDDEN_KIND,
      "503": error(
        "`TELEMETRY_UNAVAILABLE` — Kafka is unreachable or unconfigured. Deliberately not a 2xx, so the SDK keeps the buffered batch and retries instead of dropping it.",
      ),
    }),
  },

  // ---------------- Virtual currencies ----------------
  "GET /v1/virtual-currencies/me": {
    summary: "Fetch the calling subscriber's virtual-currency balances",
    tags: [TAG_CREDITS],
    parameters: [APP_USER_ID_HEADER, PLATFORM_HEADER],
    responses: guarded({
      "200": data(
        {
          type: "object",
          required: ["balances"],
          properties: {
            balances: {
              type: "object",
              additionalProperties: { type: "integer" },
              description: "Balance per currency code.",
            },
          },
        },
        "Balances.",
      ),
      "400": VALIDATION_FAILED,
    }),
  },
  "GET /v1/virtual-currencies/:appUserId": {
    summary: "Fetch a subscriber's virtual-currency balances",
    tags: [TAG_CREDITS],
    parameters: [APP_USER_ID_PATH],
    responses: guarded({
      "200": data(
        {
          type: "object",
          required: ["balances"],
          properties: {
            balances: {
              type: "object",
              additionalProperties: { type: "integer" },
              description: "Balance per currency code.",
            },
          },
        },
        "Balances.",
      ),
      "403": FORBIDDEN_KIND,
    }),
  },
  "POST /v1/virtual-currencies/:appUserId/:code/transactions": {
    summary: "Grant or spend virtual currency",
    description:
      "Appends to `credit_ledger`, which is append-only and enforced as such by a database trigger. Spending is server-side only — the SDK has no client-side spend path.",
    tags: [TAG_CREDITS],
    parameters: [
      APP_USER_ID_PATH,
      pathParam("code", "Virtual-currency code."),
      IDEMPOTENCY_KEY_HEADER,
    ],
    responses: guarded({
      "200": data(
        {
          type: "object",
          required: ["code", "balance"],
          properties: {
            code: { type: "string" },
            balance: { type: "integer", description: "Balance after the transaction." },
          },
        },
        "The new balance.",
      ),
      "400": VALIDATION_FAILED,
      "403": FORBIDDEN_KIND,
      "422": error(
        "The `Idempotency-Key` was reused with a different request body.",
      ),
    }),
  },

  // ---------------- Funnels ----------------
  "POST /v1/subscribers/claim-funnel-token": {
    summary: "Claim a web-funnel purchase onto an app subscriber",
    tags: [TAG_FUNNELS],
    responses: guarded({
      "200": data(opaque("Claim outcome"), "Claim processed."),
      "400": VALIDATION_FAILED,
    }),
  },
  "POST /v1/sdk/claim-install": {
    summary: "Look up a funnel claim token for a fresh install",
    tags: [TAG_FUNNELS],
    responses: guarded({
      "200": {
        description: "A claim token was found.",
        content: {
          [JSON_MEDIA_TYPE]: {
            schema: {
              type: "object",
              required: ["data"],
              properties: {
                data: {
                  type: "object",
                  required: ["token"],
                  properties: { token: { type: "string" } },
                },
              },
            },
          },
        },
      },
      "404": {
        description:
          "No claimable install matched. Returns `{ \"data\": null }` — the success envelope with a null payload, NOT the error envelope.",
        content: {
          [JSON_MEDIA_TYPE]: {
            schema: {
              type: "object",
              required: ["data"],
              properties: { data: { type: "null" } },
            },
          },
        },
      },
      "400": VALIDATION_FAILED,
    }),
  },
  "POST /v1/sdk/claim-via-email": {
    summary: "Request a funnel claim by email address",
    description:
      "Always 202 with a null payload, whether or not the address matched anything — so the endpoint cannot be used to test whether an email address is a customer.",
    tags: [TAG_FUNNELS],
    responses: guarded({
      "202": {
        description:
          "Accepted. Returns `{ \"data\": null }` regardless of whether an address matched.",
        content: {
          [JSON_MEDIA_TYPE]: {
            schema: {
              type: "object",
              required: ["data"],
              properties: { data: { type: "null" } },
            },
          },
        },
      },
      "400": VALIDATION_FAILED,
    }),
  },
};

/**
 * The endpoint set this file documents, as `"<METHOD> <hono path>"`.
 *
 * Paired with `walkV1Endpoints()` from `scripts/generate-openapi.ts` by the
 * contract test: the two sets must be equal, so an endpoint cannot be added,
 * removed or renamed without this file being updated in the same change.
 */
export const HAND_AUTHORED_ENDPOINTS: ReadonlySet<string> = new Set(
  Object.keys(HAND_AUTHORED_OPERATIONS),
);
