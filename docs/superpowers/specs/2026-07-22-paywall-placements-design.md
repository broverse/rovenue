# Paywall Builder + Placements — Phase A Design

Date: 2026-07-22
Status: approved (brainstormed 2026-07-21, amended for Stripe Connect B1 landing)

## Overview

Rovenue gets an Adapty/RevenueCat-style **placements** layer: the app asks
`getPaywall("onboarding_end")` and the server decides — per audience, per
experiment — which paywall to show. Phase A ships placements, audience-ordered
targeting, a first-class **paywall entity** (remote-config JSON + offering
reference), client-side deterministic A/B variant draw, paywall analytics
events, and purchase attribution. No visual builder and no native renderer yet.

### Phase map

- **Phase A (this spec):** placements + targeting + remote-config paywalls,
  SDK `getPaywall(placementId)`, `paywall_view` event, purchase attribution.
- **Phase B (later):** visual builder in the dashboard + platform-neutral
  component-tree wire format + **React (web) renderer** — the same renderer
  serves builder live-preview, the funnel builder's `paywall` page type, and
  customers' web apps. Convergence point with funnel-payment sub-project B2.
- **Phase C (later):** Swift/Kotlin native renderers reading the Phase-B
  schema (battle-tested on web first).

### Key decisions (from brainstorming)

1. **Client-side variant draw** (Adapty model): the server matches the
   audience and returns the full weighted variant list; the SDK picks the
   variant with the existing deterministic bucketing math
   (`packages/shared/src/experiments/bucketing.ts`: SHA-256 →
   uint32 → mod 10,000 → weighted select). Stickiness needs no server state;
   cached/offline responses yield the same variant; responses are not
   per-user personalized (segment-level cacheability).
2. **Paywall is a first-class entity** referencing an offering. Presentation
   (paywall) and catalog (offering) stay separate; the same offering can be
   A/B-tested with different designs.
3. **A/B runs on the existing `experiments` infrastructure**: a placement row
   targets either a paywall directly or a `type=PAYWALL` experiment whose
   variants carry `paywallId` references. Exposure, results UI, mutual
   exclusion, and ClickHouse plumbing are reused unchanged.
4. **Offline = existing disk-cache ladder** (`OfferingsClient` pattern):
   successful fetch → cache; connectivity error → serve cache. Bundled
   fallback-file export is out of scope (Phase B+).
5. **Schema is platform-neutral from day one.** Remote-config JSON is
   free-form and serves native and web clients identically. The Phase-B
   component tree must contain no platform-specific concepts (nested-stack
   layout, `{light, dark}` color pairs, key-indirection localization).

## Data model (packages/db)

### `paywalls` (new table)

| column | type | notes |
|---|---|---|
| `id` | text (cuid2) | PK |
| `projectId` | FK → projects, cascade | |
| `identifier` | text | unique per project, slug |
| `name` | text | display name |
| `offeringId` | FK → offerings | restrict delete while referenced |
| `remoteConfig` | jsonb | `{ defaultLocale: string, locales: { [locale]: object } }` — locale values are free-form JSON (Adapty remote-config model). The legacy flat `PaywallConfig` shape is a valid but not enforced payload. |
| `configFormatVersion` | integer, default 1 | day-one version negotiation; Phase-B builder configs bump this |
| `builderConfig` | jsonb, nullable | reserved for Phase B, always null in Phase A |
| `isActive` | boolean, default true | |
| `metadata` | jsonb | |
| timestamps | | standard `createdAt`/`updatedAt` |

### `placements` (new table)

| column | type | notes |
|---|---|---|
| `id` | text (cuid2) | PK |
| `projectId` | FK → projects, cascade | |
| `identifier` | text | unique per project — the string used in app code |
| `name` | text | |
| `revision` | integer, default 1 | bumped on every `rows` edit; echoed in responses and events |
| `rows` | jsonb | ordered array, see below |
| `isActive` | boolean, default true | |
| timestamps | | |

`rows` element shape (Zod-validated on write):

```jsonc
{
  "audienceId": "aud_x" | null,   // null = "All users" catch-all
  "target":
      { "type": "paywall",    "paywallId": "..." }
    | { "type": "experiment", "experimentId": "..." }   // must be type=PAYWALL
    | { "type": "none" }                                 // explicitly show nothing
}
```

Priority = array order (top wins), same embedded-jsonb pattern as
`offerings.packages`. Write-time validation: referenced audiences, paywalls,
and experiments must belong to the project; experiment targets must be
`type=PAYWALL`; at most one `audienceId: null` row, and if present it must be
last.

### `experiments` (convention change, no migration)

`type=PAYWALL` variants now carry `value: { "paywallId": "..." }` (reference)
instead of an inline `PaywallConfig`. Enforced by Zod on the dashboard
experiment write path when `type=PAYWALL`. Existing inline-config experiments
keep working through the legacy remote-config path; new placements only
resolve reference-style variants.

## API (apps/api)

### `GET /v1/placements/:identifier` (public Bearer)

Headers/query: `x-rovenue-user-id` (optional), `?locale=` (optional).

Resolution: load placement (active, project-scoped) → walk `rows` top-down →
first row whose audience matches `matchesAudience(subscriberAttributes,
audience.rules)` (existing sift engine; `audienceId: null` always matches) →
resolve target:

```jsonc
// target=paywall
{ "data": {
    "placement": { "identifier": "onboarding_end", "revision": 7 },
    "paywall": {
      "id": "...", "identifier": "...", "name": "...",
      "configFormatVersion": 1,
      "remoteConfig": { "locale": "tr", "data": { ... } },   // requested locale resolved server-side, falls back to defaultLocale
      "offering": { ...same hydrated shape as /v1/offerings items... }
    },
    "experiment": null } }

// target=experiment (status RUNNING; otherwise treated as row miss → continue walking)
{ "data": {
    "placement": { ... },
    "paywall": null,
    "experiment": {
      "key": "onboarding-price-test",
      "id": "exp_...",
      "variants": [ { "variantId": "a", "weight": 50, "paywall": { ...hydrated... } }, ... ] } }

// target=none, no matching row, or inactive/unknown placement
{ "data": { "placement": { ... } | null, "paywall": null, "experiment": null } }
```

Offering hydration reuses the `/v1/offerings` product-batch path, including
`storeIds` (with `storeIds.stripe` price ids — web consumers get their Stripe
binding for free, see Connect section). Unknown placement identifier returns
the empty envelope with `placement: null` (not 404): a shipped app must never
crash because a placement was retired.

Caching: requests without a subscriber id are edge-cacheable exactly like
`/v1/offerings` (add the path to `CACHEABLE_PREFIXES`); subscriber-scoped
requests bypass. Placement/paywall/audience/experiment mutations call the
existing `purgeProjectCatalogCache`.

### Exposure reporting

`POST /v1/experiments/:id/expose` gains optional `variantId` and
`placementId` fields. When `variantId` is present (client-side draw), the
server lazily persists the assignment via
`experimentAssignmentRepo.insertAssignmentsSkipDuplicates` before recording
the exposure — the existing results UI and ClickHouse exposure pipeline work
unchanged; assignments are simply created at exposure time instead of fetch
time. Server-side validation: `variantId` must exist on the experiment.

### `paywall_view` event

`POST /v1/events` accepts a new event type `paywall_view` with payload
`{ paywallId, placementId, placementRevision, variantId?, experimentKey? }`
→ outbox → Kafka → ClickHouse (see Analytics).

### Purchase attribution (`presentedContext`)

Receipt endpoints (Apple/Google) accept an optional

```jsonc
"presentedContext": { "placementId": "...", "paywallId": "...",
                      "variantId": "...", "experimentKey": "..." }
```

stored on the purchase and stamped into `revenue_events` metadata so revenue
is attributable to placement/paywall/variant in ClickHouse. All fields are
opaque strings; unknown ids are stored as-is (never rejected — attribution
must not fail a purchase).

## Stripe Connect intersection (B1 landed 2026-07-22)

Connect B1 replaced per-project Stripe keys with per-project connected
accounts (`project_stripe_connections`, `getConnectedStripe`,
`chargesEnabled(projectId)`) and routes connected-account webhooks into the
existing subscription/revenue pipeline. Implications adopted by this spec:

1. **Web serving works day one.** `/v1/placements/:identifier` returns
   hydrated offerings including `storeIds.stripe` price ids, so a web client
   can already resolve a placement to Stripe prices. The actual on-page
   charge remains funnel sub-project **B3** (Checkout/Payment Element) — out
   of scope here.
2. **Attribution contract for future web checkout (B3 hook point).** When B3
   creates Stripe checkout sessions, it must set
   `metadata.rovenue_presented_context = JSON.stringify(presentedContext)` on
   the session/subscription; `processStripeEvent` will then copy it into
   `revenue_events` metadata the same way receipt endpoints do. This spec
   defines the contract; Phase A implements the receipt-side path and the
   webhook-side copy (cheap: read `subscription.metadata`), so web attribution
   lights up automatically when B3 ships.
3. **No Connect gate on placements paywalls.** The funnel publish gate
   (`chargesEnabled` check in `funnels.ts` publish route) exists because
   funnel paywalls charge via Stripe on the web. Placements paywalls serve
   native apps where Stripe is irrelevant; gating their activation on Connect
   would be wrong. If a Phase-B web renderer later initiates Stripe checkout,
   that flow reuses the same `chargesEnabled` gate at checkout-creation time,
   not at paywall-save time.
4. **Convergence path with funnel paywall pages (B2).** The funnel `paywall`
   page today binds a single `productId` string. The new `paywalls` entity
   (offering-referenced) is the natural object for funnel pages to reference
   when B2 is built — one paywall definition served to placements *and*
   funnels. Phase A does not touch the funnel schema; this is recorded as the
   intended B2 direction.

## SDK (packages/core-rs + façades)

### Rust core

- `get_paywall(placement_id: String, locale: Option<String>) -> RovenueResult<CorePaywall>`.
- New module `placements/` mirroring `offerings/` (client, wire types, cache
  repo with resource key `placement:{identifier}`); connectivity errors serve
  the cached response (`OfferingsClient` pattern), auth/server errors
  propagate.
- **Bucketing port:** `assignBucket` + `selectVariant` reimplemented in Rust
  with byte-identical semantics (SHA-256 over `"{subscriberId}:{seed}"`,
  first 4 bytes big-endian → mod 10,000; weighted walk). Seed =
  `experiment.key`. Verified by **shared test vectors**: a JSON fixture
  checked into `packages/shared` consumed by both the Vitest and the Rust
  test suites — same inputs must produce the same variant on both sides.
- When the response carries an experiment, the core draws the variant,
  emits the exposure report (`POST /v1/experiments/:id/expose` with
  `variantId` + `placementId`, fire-and-forget with the telemetry retry
  queue), and returns the chosen variant's paywall.
- `CorePaywall` carries `presented_context` (placementId, paywallId,
  variantId?, experimentKey?, revision); the context is stamped onto the
  purchase flow so the next `purchase()` for a product obtained through this
  paywall attaches `presentedContext` automatically (RC
  `presented_offering_context` pattern). Wire identity rules unchanged
  (rovenue_id).

### Façades (Swift / Kotlin / RN)

- `getPaywall(placementId:locale:)` returning a `Paywall` DTO:
  `{ placementId, revision, remoteConfig (decoded JSON), offering (existing
  offering DTO), presentedContext }`.
- `logPaywallShown(paywall)` — explicit, Adapty remote-config model (we ship
  no renderer in Phase A); sends `paywall_view` through the existing
  at-least-once session-telemetry dispatcher.
- RN bridges follow the DTO-contract gate (bridges don't build standalone).

## Dashboard (apps/dashboard)

- **Paywalls section** (modeled on `components/offerings/`): list, create/edit
  form (identifier slugging, offering select, active toggle), remote-config
  editor with per-locale tabs (reuse `funnel-builder`'s `localized-input`
  pattern) and a raw-JSON textarea with validation.
- **Placements section**: list + editor. Editor shows ordered audience rows
  with drag-reorder; each row: audience select (existing audiences hooks),
  target picker (paywall / A/B test / nothing). Saving bumps `revision`.
  Existing experiment pages gain nothing new except that `type=PAYWALL`
  experiment variant editing becomes a paywall picker.
- Catalog cache purge wired into all mutations.

## Analytics (ClickHouse)

- New Kafka topic `rovenue.paywall_events` → raw table
  `raw_paywall_events` (ReplacingMergeTree on deterministic event id, same
  dedup pattern as SDK sessions) → MV `mv_paywall_daily` aggregating views
  and unique views by `(project, placement, paywall, variant, day)`.
- Conversion = join with `revenue_events` on presented-context metadata
  (query-time, idempotent-view pattern — no new rollup tables).
- Dashboard Phase A: a simple metrics card on the placement detail page
  (views, unique views, purchases, CR); experiment results stay on the
  existing experiments screens.

## Testing

- **Cross-language bucketing vectors** (critical): shared JSON fixture, both
  Vitest and `cargo test` assert identical variant selection.
- Unit: placement row precedence, `audienceId: null` semantics, RUNNING-only
  experiment resolution, Zod row validation.
- Integration (testcontainers): `/v1/placements/:identifier` happy paths +
  audience matching + locale fallback; expose-with-variantId persists
  assignment; receipt `presentedContext` lands in revenue-event metadata.
- Kotlin façade via `testDebugUnitTest`; RN via DTO-contract tests.
- ClickHouse migration verified with `db:verify:clickhouse`; splitter caveat
  (comment-prefixed statements) respected.

## Non-goals (Phase A)

- Visual builder, component-tree schema, any renderer (web or native).
- Bundled fallback-file export / `setFallback` API.
- Segment-hash CDN URLs (Adapty-style cacheable personalized GETs).
- Cross-placement A/B tests.
- `paywall_close` / component-interaction events.
- Funnel schema changes (B2) and on-page web checkout (B3) — contract hooks
  only, as specified in the Connect section.
