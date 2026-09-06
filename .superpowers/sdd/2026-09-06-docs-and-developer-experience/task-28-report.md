# Task 28: The explorer page

## Status: shipped

An interactive, browsable API explorer at `/docs/reference/api-explorer`, rendering `apps/api/openapi/openapi.json`
(33 `/v1` operations) with a real "try it" panel plus a copyable `curl` command per endpoint as the always-works
fallback.

## How the spec reaches apps/docs, and why

Build-time copy, not a workspace import or a second generator. `apps/docs/scripts/copy-openapi.mjs` copies
`apps/api/openapi/openapi.json` to `apps/docs/public/openapi.json` (gitignored, same pattern as the existing
`/public/api/<sdk>/` generated references). It's wired into both `dev` and `build`
(`apps/docs/package.json`): `"build": "pnpm run generate:errors && pnpm run generate:openapi && react-router build"`.
The explorer component fetches `/openapi.json` client-side at runtime — it is a static asset served by Caddy in
production, not bundled into a JS chunk.

Why a copy over an import: `apps/api/openapi/openapi.json` is a committed JSON document, already kept in sync with
the live route table by `pnpm --filter @rovenue/api openapi:check` in CI — it's data, not a TS module apps/docs
would benefit from importing across the workspace boundary (that would either inline 140KB into a JS bundle via
`resolveJsonModule`, or pull apps/api's runtime deps into the docs build for no reason). A plain static copy, always
refreshed by the docs build itself, mirrors exactly how `generate:errors` already turns `packages/shared/src/
error-catalog.ts` into `api-errors.mdx` on every build — same "can't drift because it's regenerated every build,
never hand-edited, never committed" guarantee.

One consequence caught while implementing: the production Docker builder stage (`apps/docs/Dockerfile`) only copies
`apps/api/package.json` (for `pnpm install`'s workspace resolution), not apps/api's source — so it never had
`apps/api/openapi/openapi.json` available. Added `COPY apps/api/openapi ./apps/api/openapi` before the docs build
step; `copy-openapi.mjs` also fails loudly (not silently) if the source file is missing, so a future refactor to
that COPY line breaks the Docker build immediately and by name rather than shipping a docs site with a missing or
stale spec.

Verified un-stale: edited `openapi.json`'s `info.description` with a canary string, ran `pnpm --filter @rovenue/docs
build`, confirmed the canary appeared in `apps/docs/build/client/openapi.json`; reverted and rebuilt clean.

## Prerender safety

The production image (`caddy:2-alpine`, no Node process) and `react-router.config.ts`'s full-site prerender mean
`apps/docs/app/components/api-explorer.tsx` must never touch `fetch`/`window`/`localStorage` during the Node build
pass. All such calls live inside `useEffect` (React never runs effects during server rendering) behind an explicit
`mounted` boolean set only in an effect, so the very first client render matches the prerendered HTML exactly before
any browser API is touched. Confirmed empirically: `apps/docs/build/client/docs/reference/api-explorer/index.html`
contains the static "Loading the interactive API explorer…" fallback text, not a crash, an empty shell, or leaked
data.

This mirrors, rather than reuses, `app/routes/docs.tsx`'s `createClientLoader` boundary — that mechanism defers an
entire *route's* MDX content module behind a client-side loader; `api-explorer.tsx` is a component *embedded inside*
one MDX page (`api-explorer.mdx`), so the equivalent guarantee is enforced at the component level with the
standard React SSR contract (render body must match server output; only effects touch the browser) instead of a
second `createClientLoader` boundary.

## "Try it," honestly

- Base URL is reader-supplied, no default (self-hosted, no canonical host) — matches `openapi.json`'s own `servers`
  entry, which says the same thing.
- A real "Send request" button performs an actual `fetch()` per endpoint (path/query/header params, editable
  JSON body prefilled from the schema, Bearer token). Genuinely interactive, not a mockup.
- Because a plain `/v1` path is not meant to be called cross-origin, a persistent `Callout` in the connection panel
  says so explicitly and points at the alternative: a toggle for the browser surface (`/v1/web/{publicKey}`, from
  `openapi.json`'s `x-rovenue-browser-surface`), which pairs with `requireMatchingPathKey`. A failed fetch's error
  message repeats this ("almost always CORS, not a broken API") rather than leaving the reader to conclude the API
  is broken.
- Every endpoint also renders a copyable `curl` command built from the same base URL/key/params — the fallback that
  works regardless of CORS, so the page is useful even when a reader's deployment doesn't allow browser calls at all.
- A `SpecProvenance` callout at the top states plainly which parts of the document are generated (endpoint set,
  request bodies, auth — read from `openapi.json`'s own `x-rovenue-generation` object) versus hand-maintained
  (responses, parameters, prose — can drift from a live server). Nothing implies every response example is derived
  from source.

## Error-code linking

Response/parameter/operation descriptions are scanned for backtick-wrapped spans; any span that's an exact match
for a `ERROR_CATALOG` (`@rovenue/shared/error-catalog`, already a docs dependency) wire value becomes a link to
`/docs/reference/api-errors#<code.toLowerCase()>` — the same anchor `generate-error-catalog.mjs` produces. Matching
is on the WIRE value (`entry.code`), not the `ERROR_CODE` key, so the five codes that differ (`asset_in_use`,
`asset_missing`, `purchase_not_paid`, `apple_offer_signing_unavailable`, `apple_offer_signing_failed`) link
correctly; verified `apple_offer_signing_failed` and `asset_in_use` anchors exist in the built `api-errors/
index.html`. Any response whose schema is `$ref: '#/components/schemas/ErrorEnvelope'` also gets a generic "see API
Errors" link, since most responses don't name a specific code in their (hand-written) description text.

## Verification performed

- `pnpm --filter @rovenue/docs typecheck` — clean.
- `pnpm --filter @rovenue/docs build` — clean; prerender completes for `/docs/reference/api-explorer` (HTML +
  `.data` files under `build/client/docs/reference/api-explorer/`), `build/client/openapi.json` present (141KB).
- `pnpm --filter @rovenue/docs check:links` — `46 files checked` (was 45; +1 for the new page), all internal
  `/docs/...` links valid.
- Canary-string staleness check (above) — copy is provably never stale.

## Files

- `apps/docs/app/components/api-explorer.tsx` — new, the client component.
- `apps/docs/content/docs/reference/api-explorer.mdx` — new page.
- `apps/docs/content/docs/reference/meta.json` — added `"api-explorer"` to `pages`.
- `apps/docs/scripts/copy-openapi.mjs` — new, the build-time copy.
- `apps/docs/package.json` — `generate:openapi` script, wired into `dev` and `build`.
- `apps/docs/.gitignore` — `/public/openapi.json`.
- `apps/docs/Dockerfile` — `COPY apps/api/openapi ./apps/api/openapi` before the docs build stage.
