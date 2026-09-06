import { ERROR_CODE, type ErrorCode } from "./index";

// =============================================================
// API error-code catalog (ROADMAP §11)
// =============================================================
//
// One documented entry per ERROR_CODE key, keyed EXACTLY like ERROR_CODE
// itself so the two can never drift silently. `ERROR_CATALOG` is typed as
// a TOTAL `Record<keyof typeof ERROR_CODE, ...>` (never `Partial` or an
// index signature) — adding a new code to ERROR_CODE without adding its
// entry here is a compile error, not a documentation gap someone notices
// later. See packages/db's `Partial<Record>` incident (store lifecycle
// normalization, 2026-09-03): a missing key there compiled and shipped a
// silently-dropped provider event.
//
// `code` is always the WIRE value (`ERROR_CODE.KEY`), never the key
// string. Five codes are lowercase on the wire while their key is
// SCREAMING_CASE (APPLE_OFFER_SIGNING_UNAVAILABLE, APPLE_OFFER_SIGNING_
// FAILED, ASSET_IN_USE, ASSET_MISSING, PURCHASE_NOT_PAID) — referencing
// `ERROR_CODE.KEY` here rather than hand-typing a literal is what keeps
// this catalog correct even if a client only ever sees `error.code`.
//
// `httpStatus` is the PRIMARY status this code is actually returned with,
// read from its real throw site(s) — not assumed from the code's name.
// A few codes are genuinely returned at more than one status; that is
// called out explicitly in the relevant `summary` rather than silently
// picking one.
//
// A handful of codes have NO current producer anywhere in apps/api/src
// (BEARER_REQUIRED, INVALID_API_KEY, INVALID_API_KEY_FORMAT,
// API_KEY_KIND_MISMATCH) — the auth failures they were presumably meant
// to name are, today, generic HTTPExceptions that fall through
// middleware/error.ts's status→code mapping (401 -> UNAUTHORIZED, 403 ->
// FORBIDDEN) instead. Each says so plainly rather than describing
// behavior that doesn't exist on the wire.

export type ErrorCatalogEntry = {
  /** The WIRE value, not the key. Five codes differ. */
  code: ErrorCode;
  httpStatus: number;
  summary: string;
  resolution: string;
};

export const ERROR_CATALOG: Record<keyof typeof ERROR_CODE, ErrorCatalogEntry> = {
  // ---- Generic / transport-level ---------------------------------
  HTTP_ERROR: {
    code: ERROR_CODE.HTTP_ERROR,
    // No single status is honest here — see the summary. 409 is the plurality
    // (dozens of bare `new HTTPException(409, ...)` call sites with no
    // `cause`, roughly 4x the next most common), not "the" status this code
    // means. Do not read this field as diagnostic for this entry.
    httpStatus: 409,
    summary:
      "`mapHttpStatus` in middleware/error.ts returns this for EVERY HTTPException whose status is not one of the six explicitly mapped ones (400/401/403/404/429/501, which each get their own specific code) and whose `cause` isn't a recognized ERROR_CODE. In practice this is dozens of call sites across apps/api/src — invitations, paywalls, imports, products, cohorts, funnel-payment, copilot credentials, Stripe integration — throwing bare `new HTTPException(status, { message })` with no `cause` at a status outside that list of six. A repo-wide scan of every such call site found this actually happening at status 409, 410, 412, 413, 422, 500, 502, and 503, with 409 the plurality (roughly four times the next most common). This code is therefore NOT a signal of any single failure class or status the way every other code in this catalog is — it is what's left over. Notably, it includes 500s: `dashboard/invitations.ts`'s 'just-created invitation vanished' check throws a bare `HTTPException(500, ...)`, which arrives on the wire as HTTP_ERROR, not INTERNAL_ERROR (see that entry).",
    resolution:
      "Do not branch on this code alone — it groups together conflicts, preconditions, payload-size rejections, upstream failures, and even some 500s that all happen to route through an HTTPException without a typed `cause`. Read the actual HTTP status and `message` on the response to know what really happened; if you need to react programmatically to a specific one of these cases, ask for it to be promoted to its own typed code (give the throw site a `cause: ERROR_CODE.<NEW_CODE>`) rather than parsing `message`.",
  },
  VALIDATION_ERROR: {
    code: ERROR_CODE.VALIDATION_ERROR,
    httpStatus: 400,
    summary:
      "The default for a rejected HTTPException(400, ...) and for any unhandled ZodError (body/query/param schema failure) — by far the most common error code in the API. It is also returned at 422 from the two refund routes for 'this store doesn't support refunding this purchase' (apple_unsupported) or 'no store reference to refund against' (missing_store_ref); 400 is the primary status.",
    resolution:
      "Fix the request: re-check required fields, types, and enum values against the route's schema in `message`. This is a client-side mistake, not a transient failure — retrying unchanged will fail again.",
  },
  INTERNAL_ERROR: {
    code: ERROR_CODE.INTERNAL_ERROR,
    httpStatus: 500,
    summary:
      "The final fallback in middleware/error.ts for any thrown value that is neither an HTTPException nor a ZodError — an unexpected bug, not a modeled failure mode. The real error is logged server-side; the client only ever sees a generic message. IMPORTANT: not every 500 arrives as this code — a bare `new HTTPException(500, { message })` with no `cause` (e.g. dashboard/invitations.ts's 'just-created invitation vanished' check) falls through to `HTTP_ERROR` instead, because middleware/error.ts's specific-status map doesn't include 500. Don't assume `error.code === 'INTERNAL_ERROR'` on every 500 response — check `HTTP_ERROR` too.",
    resolution:
      "Retry with backoff once (some causes are transient — a dropped DB connection, an unhandled edge case under load), then stop and report it if it persists. There is nothing the caller can do to avoid triggering this; it means the server hit a case it didn't expect. If you're specifically trying to catch all server-side failures, match on the HTTP status (>= 500) rather than this code alone, since some 500s arrive as HTTP_ERROR.",
  },
  UNAUTHORIZED: {
    code: ERROR_CODE.UNAUTHORIZED,
    httpStatus: 401,
    summary:
      "The status→code mapping's answer for any HTTPException(401, ...) whose `cause` isn't a recognized ERROR_CODE — which today is every 401 in the codebase, since none of the dedicated auth codes (BEARER_REQUIRED, INVALID_API_KEY, INVALID_API_KEY_FORMAT) are actually wired up. Covers a missing/malformed Authorization header and an unknown, revoked, or expired API key alike.",
    resolution:
      "Re-check the Authorization header is present as `Bearer <key>` and that the key itself is current in the dashboard (not revoked or expired). There is currently no way to tell these apart from the code alone — read `message` for which one it was.",
  },
  FORBIDDEN: {
    code: ERROR_CODE.FORBIDDEN,
    httpStatus: 403,
    summary:
      "The status→code mapping's answer for any HTTPException(403, ...) without a recognized `cause` — the authenticated caller is real but not allowed to do this. Producers include a public key used where a secret key is required (`requireSecretKey`), a public/secret key presented where the route demanded the other kind, and a dashboard user's role lacking the capability the route checks (`assertProjectCapability`/`assertProjectAccess`).",
    resolution:
      "For SDK callers: switch to a secret key for server-to-server endpoints (credit grants and similar) — never ship a secret key in a client app. For dashboard callers: the signed-in user's project role doesn't include the needed capability; ask a project owner to grant it.",
  },
  NOT_FOUND: {
    code: ERROR_CODE.NOT_FOUND,
    httpStatus: 404,
    summary:
      "Returned both by the generic status→code mapping for any bare HTTPException(404, ...) and directly by many routes for 'no row with that id in this project' (subscriptions, transactions, assets, font faces, projects). It never distinguishes 'never existed' from 'exists in a different project' — both look identical to avoid leaking cross-project existence.",
    resolution:
      "Double-check the id and that it belongs to the project the request is authenticated against — a valid id for someone else's project 404s exactly like a nonexistent one. Don't treat this as retryable.",
  },
  NOT_IMPLEMENTED: {
    code: ERROR_CODE.NOT_IMPLEMENTED,
    httpStatus: 501,
    summary:
      "Reserved slot in the status→code mapping for an HTTPException(501, ...); at the time of writing no route in apps/api/src throws status 501, so this code has never actually been observed on the wire. It exists so a future not-yet-built endpoint stub has a machine-readable code to return instead of a bare 500.",
    resolution:
      "If you see this in practice, treat it the same as a permanent client-side dead end — the endpoint exists in the route table but its implementation isn't live yet. Don't retry; check the changelog for when it ships.",
  },
  RATE_LIMITED: {
    code: ERROR_CODE.RATE_LIMITED,
    httpStatus: 429,
    summary:
      "Thrown by the shared `endpointRateLimit`/`apiKeyRateLimit` middleware (middleware/rate-limit.ts) whenever a caller exceeds a route's per-minute cap — asset uploads, the paywall preview poll, and general API-key traffic are all gated this way. `ROVI_QUOTA_EXCEEDED` below is a distinct, unrelated 429 for a different limit (monthly AI usage, not request rate).",
    resolution:
      "Back off and retry after a short delay; the response should carry standard rate-limit headers to tell you how long. If this fires under normal usage, the per-minute cap for that route is probably too low for your traffic pattern — reduce polling frequency or batch requests.",
  },

  // ---- Rovi (AI copilot) ------------------------------------------
  ROVI_NOT_CONFIGURED: {
    code: ERROR_CODE.ROVI_NOT_CONFIGURED,
    httpStatus: 412,
    summary:
      "The project has no working AI provider for Rovi (copilot chat, AI paywall generation, and auto-translate all route through the same `resolveProviderForProject`): no BYOK credentials saved for the project AND no server-wide default provider/API key configured in env either.",
    resolution:
      "An operator must fix configuration: either save BYOK provider credentials for this project in the dashboard, or set `ROVI_DEFAULT_PROVIDER`/`ROVI_DEFAULT_API_KEY` (and friends) in the API's environment. A caller cannot work around this by retrying.",
  },
  ROVI_QUOTA_EXCEEDED: {
    code: ERROR_CODE.ROVI_QUOTA_EXCEEDED,
    httpStatus: 429,
    summary:
      "The project's monthly Rovi usage (message count or token count, whichever the tier caps first) has been exhausted, per `evaluateQuota`/`resolveTier` in middleware/rovi-quota-guard.ts. The response body carries `tier`, `exceeded`, and `resetAt` alongside the envelope for a client to show a real countdown.",
    resolution:
      "Wait until `resetAt` (the first of next month, UTC) or upgrade the project's billing tier for a higher cap. Retrying before the reset always fails identically — this is not a transient rate limit.",
  },

  // ---- API-key auth (defined, not currently emitted) ---------------
  BEARER_REQUIRED: {
    code: ERROR_CODE.BEARER_REQUIRED,
    httpStatus: 401,
    summary:
      "Named for 'the Authorization header is missing or not a Bearer token', which `middleware/api-key-auth.ts` does check for — but that check throws a bare `HTTPException(401, { message: 'Bearer token required' })` with no `cause`, so it resolves through the generic status mapping to UNAUTHORIZED on the wire, never to this code. No current call site sets `cause: ERROR_CODE.BEARER_REQUIRED`.",
    resolution:
      "Do not match on this code today — a missing/malformed Authorization header currently arrives as the generic UNAUTHORIZED (401) instead. If you need to detect this specific case, inspect `message` for 'Bearer token required' until the middleware is updated to set the typed cause.",
  },
  INVALID_API_KEY: {
    code: ERROR_CODE.INVALID_API_KEY,
    httpStatus: 401,
    summary:
      "Named for an API key that doesn't resolve to a live record — unknown, revoked, or expired. `api-key-auth.ts`'s actual check throws a bare `HTTPException(401, { message: 'Invalid or expired API key' })` with no `cause`, so this also resolves to the generic UNAUTHORIZED on the wire. No current call site produces this exact code.",
    resolution:
      "Do not match on this code today — treat any UNAUTHORIZED (401) from a `/v1` route as covering this case, and inspect `message` if you need to distinguish it from a missing header. Rotate the key in the dashboard if it's genuinely invalid or expired.",
  },
  INVALID_API_KEY_FORMAT: {
    code: ERROR_CODE.INVALID_API_KEY_FORMAT,
    httpStatus: 401,
    summary:
      "Named for a Bearer token that doesn't match either recognized key prefix (`rov_pub_`/`rov_sec_`, via `detectKind`). The actual check in `api-key-auth.ts` throws a bare `HTTPException(401, { message: 'Invalid API key format' })` with no `cause`, so it also resolves to the generic UNAUTHORIZED, never to this code.",
    resolution:
      "Do not match on this code today. Verify the key was copied in full and unmodified from the dashboard — a truncated or hand-edited key is the usual cause of a format mismatch, which currently surfaces as generic UNAUTHORIZED (401).",
  },
  API_KEY_KIND_MISMATCH: {
    code: ERROR_CODE.API_KEY_KIND_MISMATCH,
    httpStatus: 403,
    summary:
      "Named for presenting a public key where a secret key is required, or vice versa. `api-key-auth.ts`'s `required !== detected` branch throws a bare `HTTPException(403, { message: '<kind> API key required' })` with no `cause`, so it resolves to the generic FORBIDDEN, never to this code; `requireSecretKey` follows the same pattern.",
    resolution:
      "Do not match on this code today — a wrong-kind key currently surfaces as generic FORBIDDEN (403). Read `message` for which kind was required, and use a secret key for server-to-server endpoints (never ship one in a client app) or a public key for SDK/client endpoints.",
  },

  // ---- Store catalog / App Store import ----------------------------
  STORE_NOT_CONFIGURED: {
    code: ERROR_CODE.STORE_NOT_CONFIGURED,
    httpStatus: 400,
    summary:
      "The dashboard product-catalog lookup (`getStoreCatalog`) has no usable store credentials for the requested platform: Apple App Store Connect creds missing keyId/issuerId/privateKey, or no Google Play service-account credentials saved for the project at all.",
    resolution:
      "An operator must add the missing store credentials for this project in the dashboard (App Store Connect API key, or the Google Play service-account JSON) before the catalog can be fetched. Not retryable without that.",
  },
  STORE_API_ERROR: {
    code: ERROR_CODE.STORE_API_ERROR,
    httpStatus: 502,
    summary:
      "The store's own API (App Store Connect or Google Play Developer API) returned an error while listing products, fetching a subscription, or looking up a transaction — credentials were valid enough to authenticate, but the upstream call itself failed (rate limit, transient outage, a malformed/unauthorized request Apple or Google rejected).",
    resolution:
      "Retry after a short delay — most causes are transient upstream issues. If it persists, check the store's own status page and verify the configured credentials still have the needed scopes/permissions (an API key that used to work can be revoked or downgraded on Apple/Google's side).",
  },
  APP_STORE_LOOKUP_FAILED: {
    code: ERROR_CODE.APP_STORE_LOOKUP_FAILED,
    httpStatus: 422,
    summary:
      "The AI paywall 'import from App Store listing' flow (paywall-ai/app-store-import.ts) called Apple's public iTunes lookup API for the pasted apps.apple.com URL and got a non-OK HTTP response — the lookup service itself failed, not 'no such app'.",
    resolution:
      "Retry — this is usually a transient failure of Apple's public lookup endpoint. If it keeps failing, verify the pasted URL is a real, reachable apps.apple.com listing page.",
  },
  APP_NOT_FOUND: {
    code: ERROR_CODE.APP_NOT_FOUND,
    httpStatus: 422,
    summary:
      "The same App Store import flow got a successful response from Apple's iTunes lookup API, but `resultCount` was zero — the URL parsed as a plausible App Store listing link, but no app exists at that id/bundle in Apple's catalog (removed, region-restricted, or a mistyped id).",
    resolution:
      "Verify the App Store URL points at an app that's actually live in the store, and that the id in it hasn't changed. This is not retryable as-is — a different URL is needed, or build the paywall by hand instead of importing.",
  },

  // ---- Apple promotional-offer signing -----------------------------
  APPLE_OFFER_SIGNING_UNAVAILABLE: {
    code: ERROR_CODE.APPLE_OFFER_SIGNING_UNAVAILABLE,
    httpStatus: 400,
    summary:
      "`POST /v1/apple-offer-signature` couldn't load complete Apple credentials for the project (missing private key, keyId, or bundleId) — promotional-offer signing needs the same in-app-purchase signing key used for StoreKit offer signatures, and it isn't fully configured.",
    resolution:
      "An operator must upload the project's Apple in-app-purchase signing key (and confirm keyId/bundleId are set) in the dashboard before this endpoint can sign offers. Not something the SDK caller can fix.",
  },
  APPLE_OFFER_SIGNING_FAILED: {
    code: ERROR_CODE.APPLE_OFFER_SIGNING_FAILED,
    httpStatus: 400,
    summary:
      "Credentials were present, but `signOfferPayload` threw while actually producing the cryptographic signature for the promotional offer — most likely a malformed or corrupted stored private key, since the payload itself is built from validated request fields.",
    resolution:
      "Not retryable by the SDK caller as-is; if this is new, an operator should re-upload the project's Apple in-app-purchase signing key in the dashboard, since the stored key material is likely invalid. If it was working and suddenly isn't, check for a recent credential rotation.",
  },

  // ---- Paywall AI (generation / translation) -----------------------
  GENERATION_INVALID: {
    code: ERROR_CODE.GENERATION_INVALID,
    httpStatus: 422,
    summary:
      "The Rovi-backed 'generate a paywall from a prompt' flow (paywall-ai/generate.ts) either got back a response it couldn't turn into a valid builder config, or the prompt itself was rejected before ever calling the model. Distinct from `ROVI_NOT_CONFIGURED` (no provider available) and from `STORE_API_ERROR`-style upstream failures.",
    resolution:
      "Rephrase the prompt and try again — this usually means the request was too vague or ambiguous for the model to produce a usable paywall tree, not a transient failure. If it repeats on a clearly reasonable prompt, it may indicate a real generation-pipeline bug worth reporting.",
  },
  TRANSLATION_INVALID: {
    code: ERROR_CODE.TRANSLATION_INVALID,
    httpStatus: 422,
    summary:
      "The Rovi auto-translate flow rejected the REQUEST itself — an empty translation batch, more keys than the per-call cap, or a request to translate a locale into itself. This is distinct from an individual key coming back badly translated: bad-but-present translations return 200 with those keys listed in `rejected`, because the good ones in the same batch are still worth applying.",
    resolution:
      "Fix the request shape: ensure the batch is non-empty, under the per-call key cap, and that source and target locales differ. This is a client-side request problem, not a translation-quality issue — retrying unchanged will fail again.",
  },

  // ---- On-device paywall preview ------------------------------------
  PREVIEW_SESSION_INVALID: {
    code: ERROR_CODE.PREVIEW_SESSION_INVALID,
    httpStatus: 404,
    summary:
      "By deliberate design, `GET /v1/preview/paywalls/:token` returns this exact code and status for every failure mode — missing, expired, revoked, and garbage tokens are made indistinguishable so a scanning attacker can't use response shape as an oracle to enumerate live preview sessions.",
    resolution:
      "Mint a fresh preview session from the dashboard (`POST /dashboard/projects/:projectId/paywalls/:id/preview-sessions`) and re-scan the QR code — this code never tells you which specific thing was wrong with the old token, by design.",
  },

  // ---- Paywall fonts --------------------------------------------------
  FONT_FORMAT_UNSUPPORTED: {
    code: ERROR_CODE.FONT_FORMAT_UNSUPPORTED,
    httpStatus: 400,
    summary:
      "The uploaded font file's bytes didn't match any allowed font format under `detectFontFormat`'s magic-byte check. This is a shape check on the actual bytes, never the filename — a `.ttf`-named file carrying non-font bytes (or bytes for an unsupported format) triggers this regardless of its extension.",
    resolution:
      "Upload an actual TTF/OTF/WOFF/WOFF2 font file (whichever formats `detectFontFormat` currently allows) — renaming a file's extension does not change how it's detected. Verify the file wasn't corrupted in transfer.",
  },
  FONT_FILE_TOO_LARGE: {
    code: ERROR_CODE.FONT_FILE_TOO_LARGE,
    httpStatus: 400,
    summary:
      "The uploaded font face exceeds `FONT_FACE_MAX_BYTES`. Returned by two gates that produce the identical code/message on purpose: `hono/body-limit`'s transport-level rejection for a body large enough to exceed even the framing allowance, and the in-handler `file.size` check for the ordinary case where the file itself is just too big.",
    resolution:
      "Compress or subset the font file (e.g. drop unused glyphs/hinting) to fit under the documented per-face size limit before uploading again.",
  },
  FONT_QUOTA_EXCEEDED: {
    code: ERROR_CODE.FONT_QUOTA_EXCEEDED,
    httpStatus: 400,
    summary:
      "The project already has `FONT_FACES_MAX_PER_PROJECT` font faces and this upload would add a new one (not replace an existing `(familyId, weight, style)` combination, which is exempt from this check since it replaces a row rather than growing the count).",
    resolution:
      "Delete an unused font face first, or upload this as a replacement weight/style for an existing family instead of a new face. This is a hard per-project cap, not a billing-tier limit that can be upgraded away.",
  },
  FONT_FAMILY_NOT_FOUND: {
    code: ERROR_CODE.FONT_FAMILY_NOT_FOUND,
    httpStatus: 404,
    summary:
      "A client-supplied `familyId` (on face upload, or on the family-level routes) doesn't resolve to a live font family owned by this project — missing entirely, belonging to a different project, or soft-deleted.",
    resolution:
      "Re-fetch the project's current font families and use a live `familyId` from that list. A previously valid id that now 404s here was most likely deleted since you last fetched it.",
  },

  // ---- Paywall asset CDN ------------------------------------------------
  ASSET_FORMAT_UNSUPPORTED: {
    code: ERROR_CODE.ASSET_FORMAT_UNSUPPORTED,
    httpStatus: 400,
    summary:
      "The uploaded bytes don't match the asset kind the upload route claims (image/video/lottie), per `detectAssetKind`'s magic-byte check — for example, non-video bytes posted to the `video` upload endpoint. Like the font check, this is a byte-shape check, never a filename or declared-Content-Type check.",
    resolution:
      "Upload to the endpoint matching the file's actual kind (`/image`, `/video`, or `/lottie`), and confirm the file isn't corrupted or a placeholder — SVG is deliberately blocked here regardless of endpoint (see the asset-CDN libvips allowlist).",
  },
  ASSET_FILE_TOO_LARGE: {
    code: ERROR_CODE.ASSET_FILE_TOO_LARGE,
    httpStatus: 413,
    summary:
      "The uploaded asset exceeds that asset kind's own size cap (`ASSET_MAX_BYTES[kind]`), enforced entirely at the transport level by a per-kind `hono/body-limit` registration — each of `/image`, `/video`, and `/lottie` has its own cap, so this always means the specific kind's own limit, not a shared one.",
    resolution:
      "Compress the asset (re-encode the image/video, or strip unused data from the Lottie JSON) to fit the size limit for its kind, or use a smaller source file.",
  },
  ASSET_QUOTA_EXCEEDED: {
    code: ERROR_CODE.ASSET_QUOTA_EXCEEDED,
    httpStatus: 402,
    summary:
      "The project's total paywall-asset storage usage has reached its billing-tier limit (`getStorageUsage` against the tier's cap) — checked before any normalization or upload work is done, so this is returned cheaply without ever touching the file's bytes.",
    resolution:
      "Delete unused assets to free up quota, or upgrade the project's billing tier for a higher storage cap — this is a paid-plan limit, not a per-request or per-file cap.",
  },
  ASSET_STORAGE_UNAVAILABLE: {
    code: ERROR_CODE.ASSET_STORAGE_UNAVAILABLE,
    httpStatus: 503,
    summary:
      "Either the asset storage backend (S3-compatible object store) isn't configured for this deployment at all (`store.isStorageConfigured()` false), or it was configured but the actual write to it failed — both return the same code so a caller doesn't need to distinguish 'not set up' from 'temporarily down'.",
    resolution:
      "Retry shortly for the transient-outage case. If it never succeeds, an operator needs to check the deployment's object-storage configuration (endpoint, credentials, bucket) — this is not something an SDK/dashboard caller can fix by retrying indefinitely.",
  },
  ASSET_INVALID_NAME: {
    code: ERROR_CODE.ASSET_INVALID_NAME,
    httpStatus: 400,
    summary:
      "The `name` query parameter on an asset upload failed `isValidAssetName` — missing, empty, or containing characters the asset naming scheme doesn't allow.",
    resolution:
      "Pass a non-empty `name` using only the allowed character set (see `isValidAssetName`) — this is checked before authentication-adjacent work runs, so it's the cheapest possible rejection and always means the request itself is malformed.",
  },
  ASSET_PROCESSING_FAILED: {
    code: ERROR_CODE.ASSET_PROCESSING_FAILED,
    httpStatus: 400,
    summary:
      "Image normalization (`normalizeImage` — resizing, EXIF/GPS stripping, format conversion via libvips/sharp) threw while processing an otherwise format-valid image. The bytes passed the magic-byte format check but libvips couldn't actually decode/process them — a truncated, corrupted, or unusually malformed file.",
    resolution:
      "Re-export the image from its source application and re-upload — this usually means the file is subtly corrupted or uses an edge-case encoding libvips can't handle, not that the format itself is wrong (that's `ASSET_FORMAT_UNSUPPORTED`).",
  },
  ASSET_IN_USE: {
    code: ERROR_CODE.ASSET_IN_USE,
    httpStatus: 409,
    summary:
      "A `DELETE` on a paywall asset was refused because it's still referenced by at least one published paywall version or a draft's `builderConfig` — the response message lists which paywalls reference it. Hard-deleting the underlying object anyway would turn that reference into a device-visible broken image.",
    resolution:
      "Remove the asset from the paywalls listed in the error message first, or re-issue the same delete request with `?force=true` if you specifically intend to break those references (the S3 object is then hard-deleted immediately).",
  },
  ASSET_MISSING: {
    code: ERROR_CODE.ASSET_MISSING,
    httpStatus: 400,
    summary:
      "Publishing a paywall version was refused because its builder config references one of this project's own asset URLs whose row is soft-deleted or no longer exists. External image URLs (not on this project's asset CDN) are never checked and always pass.",
    resolution:
      "Re-upload the missing asset(s) named in the error message, or edit the paywall to point at a still-live asset before publishing again — this always means a genuinely stale reference, never a false positive on an external URL.",
  },

  // ---- Data import tool ------------------------------------------------
  IMPORT_FILE_TOO_LARGE: {
    code: ERROR_CODE.IMPORT_FILE_TOO_LARGE,
    httpStatus: 413,
    summary:
      "The uploaded subscriber-import file (CSV) exceeds `IMPORT_MAX_UPLOAD_BYTES`, enforced by `hono/body-limit` at the transport level on `POST /dashboard/projects/:projectId/imports` before the body is ever fully buffered.",
    resolution:
      "Split the import into smaller batches under the documented size limit, or remove unnecessary columns/rows from the CSV before re-uploading.",
  },
  IMPORT_STORAGE_UNAVAILABLE: {
    code: ERROR_CODE.IMPORT_STORAGE_UNAVAILABLE,
    httpStatus: 503,
    summary:
      "The dedicated private import-file bucket (never the public paywall-asset bucket — see `lib/import-store.ts`) is either unconfigured for this deployment or the write to it failed. Both cases return the same code, mirroring the `ASSET_STORAGE_UNAVAILABLE` pattern.",
    resolution:
      "Retry shortly for a possible transient outage. If it never succeeds, an operator needs to check the deployment's import-storage configuration — this bucket is configured separately from the public asset CDN bucket and both must be set up independently.",
  },

  // ---- Purchases / receipts ------------------------------------------
  PURCHASE_NOT_PAID: {
    code: ERROR_CODE.PURCHASE_NOT_PAID,
    httpStatus: 400,
    summary:
      "A Google receipt was submitted for verification while the underlying purchase is still `PENDING` (subscription `subscriptionState` or one-time `purchaseState`) — the user has started but not finished paying (e.g. a pending cash/carrier-billing payment method). This is machine-readable specifically because the purchase may still complete.",
    resolution:
      "Retry receipt verification after the payment actually completes on-device — don't treat this as a hard failure or show a generic purchase-failed error. Poll or wait for the client's own purchase-update callback before re-verifying.",
  },

  // ---- Global request body ceiling -----------------------------------
  PAYLOAD_TOO_LARGE: {
    code: ERROR_CODE.PAYLOAD_TOO_LARGE,
    httpStatus: 413,
    summary:
      "The API-wide global body-size ceiling (`app.ts`'s root `bodyLimit`) was exceeded on a route that doesn't own a larger, more specific limit of its own (asset/font/import uploads are carved out with their own bigger caps via `ROUTE_OWNED_BODY_LIMIT_PATH`). This code exists specifically because Hono's default body-limit rejection surfaced as `HTTP_ERROR` with an EMPTY message before it was added — a real incident, not a hypothetical.",
    resolution:
      "This means the request body is far larger than any ordinary JSON payload this API expects on a non-upload route — check you're posting to the right endpoint, and use one of the dedicated upload routes (assets/fonts/imports) for large file bodies instead.",
  },

  // ---- Stripe billing portal --------------------------------------------
  STRIPE_NOT_CONNECTED: {
    code: ERROR_CODE.STRIPE_NOT_CONNECTED,
    httpStatus: 503,
    summary:
      "On `POST /v1/billing-portal` (the SDK-facing endpoint), the project has no active Stripe Connect account to open a portal session on. Note: the funnel-builder validation route and the public funnel-payment checkout route separately reject with the SAME string `STRIPE_NOT_CONNECTED`, but embedded inside a JSON-stringified `message` on a generic HTTPException — those do NOT set this as the envelope's actual `error.code` (they resolve to VALIDATION_ERROR/HTTP_ERROR on the wire), so don't expect this code from those two routes.",
    resolution:
      "An operator must connect Stripe for this project (dashboard's Stripe Connect flow) before the billing portal can be used. For the funnel/checkout routes specifically, parse `message` as JSON to see the embedded `{ code: 'STRIPE_NOT_CONNECTED' }` instead of relying on `error.code`.",
  },
  STRIPE_CUSTOMER_NOT_FOUND: {
    code: ERROR_CODE.STRIPE_CUSTOMER_NOT_FOUND,
    httpStatus: 404,
    summary:
      "The authenticated subscriber (resolved from `X-Rovenue-App-User-Id`) has no Stripe customer record on file. This is the normal, expected case for a subscriber whose entitlements come entirely from Apple or Google — not an error state in the usual sense.",
    resolution:
      "Don't show this as a generic error to an Apple/Google-only subscriber — hide or disable the 'manage billing' entry point for them instead of surfacing this code as a failure, since it's expected rather than exceptional.",
  },
  RETURN_URL_NOT_ALLOWED: {
    code: ERROR_CODE.RETURN_URL_NOT_ALLOWED,
    httpStatus: 400,
    summary:
      "The `returnUrl` posted to `/v1/billing-portal` isn't one of the project's verified custom domains served over https — this request's URL is never echoed back to Stripe unchecked, precisely because the returned session URL grants access to payment data.",
    resolution:
      "Verify the domain in the dashboard's project settings first, and pass an https URL on that exact verified domain. This is a security check, not something to work around by retrying with the same value.",
  },
} as const;
