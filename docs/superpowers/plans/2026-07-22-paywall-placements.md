# Paywall Placements (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Placements layer — `getPaywall(placementId)` resolves audience-ordered rows to a paywall or a client-side-drawn PAYWALL-experiment variant, with view events and purchase attribution.

**Architecture:** Two new Postgres tables (`paywalls`, `placements` with embedded jsonb rows), one public endpoint (`GET /v1/placements/:identifier`) reusing the offerings hydration + sift audience matching, client-side deterministic variant draw (Rust port of `bucketing.ts`), exposure→assignment lazy persistence, `paywall_view` → outbox → Kafka → ClickHouse.

**Tech Stack:** Hono + Zod, Drizzle, Rust core (uniffi) + Swift/Kotlin/RN façades, ClickHouse Kafka engine, React dashboard (TanStack Router + base-ui).

**Spec:** `docs/superpowers/specs/2026-07-22-paywall-placements-design.md`

## Global Constraints

- Stay on the current branch (main). NEVER create branches or worktrees.
- TypeScript strict; Zod on every input; responses `{ data: T }` via `ok()` or `{ error: { code, message } }`.
- Postgres via Drizzle repositories only (`packages/db/src/drizzle/repositories/`); in `sql` templates qualify columns (`"placements"."id"`).
- IDs cuid2 via `createId()`; timestamps UTC `withTimezone`.
- Conventional commits; commit after every green task.
- Migration numbering: check `packages/db/drizzle/migrations/` for the next number (0086 = stripe connect; 0087 may exist). `drizzle-kit generate` gotcha: trim any hand-written prior DDL it tries to regenerate; append the journal entry.
- apps/api tests live in `apps/api/tests/` (separate from `src/`); env overrides must use `vi.hoisted` or `tests/setup.ts` `??=` (top-of-file `process.env` before imports is dead code).
- Kotlin façade verification: `pnpm --filter` is not enough — run `./gradlew testDebugUnitTest` in `packages/sdk-kotlin`.
- ClickHouse migration splitter: no comment-prefixed statements; verify with `pnpm --filter @rovenue/db db:verify:clickhouse`.
- Variant `weight` semantics are FRACTIONS summing to 1 (see `selectVariant` in `packages/shared/src/experiments/bucketing.ts`), boundaries rounded — the Rust port must mirror `Math.round` exactly.

---

### Task 1: DB — `paywalls` + `placements` tables, migration, repositories

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts` (after `offerings`, ~line 727)
- Create: `packages/db/src/drizzle/repositories/paywalls.ts`
- Create: `packages/db/src/drizzle/repositories/placements.ts`
- Modify: `packages/db/src/drizzle/repositories/index.ts` (barrel — follow how `offeringRepo` is exported/aggregated into `drizzle`)
- Create: migration via `pnpm db:migrate:generate` (next number)
- Test: `packages/db/src/drizzle/repositories/paywalls.integration.test.ts`, `placements.integration.test.ts` (colocate following existing repo integration tests)

**Interfaces (Produces):**
```ts
// paywallRepo
listPaywalls(db, projectId): Promise<Paywall[]>
findPaywallById(db, projectId, id): Promise<Paywall | null>
findPaywallsByIds(db, projectId, ids: string[]): Promise<Paywall[]>
findPaywallByIdentifier(db, projectId, identifier): Promise<Paywall | null>
createPaywall(db, input): Promise<Paywall>
updatePaywall(db, projectId, id, patch): Promise<Paywall | null>
deletePaywall(db, projectId, id): Promise<boolean>   // reject (throw) when referenced by any placement row or PAYWALL experiment variant

// placementRepo
listPlacements(db, projectId): Promise<Placement[]>
findPlacementByIdentifier(db, projectId, identifier): Promise<Placement | null>
createPlacement(db, input): Promise<Placement>
updatePlacement(db, projectId, id, patch): Promise<Placement | null>  // MUST increment revision when `rows` present in patch
deletePlacement(db, projectId, id): Promise<boolean>
```

Schema (mirror `offerings` style exactly — same imports, same index naming):

```ts
export const paywalls = pgTable(
  "paywalls",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    name: text("name").notNull(),
    offeringId: text("offeringId")
      .notNull()
      .references(() => offerings.id, { onDelete: "restrict" }),
    // { defaultLocale: string, locales: { [locale]: object } }
    remoteConfig: jsonb("remoteConfig").notNull().default(sql`'{}'::jsonb`),
    configFormatVersion: integer("configFormatVersion").notNull().default(1),
    builderConfig: jsonb("builderConfig"), // reserved for Phase B, null in Phase A
    isActive: boolean("isActive").notNull().default(true),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdIdentifierKey: uniqueIndex("paywalls_projectId_identifier_key").on(
      t.projectId, t.identifier,
    ),
  }),
);

export const placements = pgTable(
  "placements",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    name: text("name").notNull(),
    revision: integer("revision").notNull().default(1),
    // Ordered rows: { audienceId: string|null, target: {type:"paywall",paywallId} | {type:"experiment",experimentId} | {type:"none"} }
    rows: jsonb("rows").notNull().default(sql`'[]'::jsonb`),
    isActive: boolean("isActive").notNull().default(true),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdIdentifierKey: uniqueIndex("placements_projectId_identifier_key").on(
      t.projectId, t.identifier,
    ),
  }),
);
```

- [x] **Step 1:** Write failing integration tests (testcontainers, follow an existing repo `.integration.test.ts` bootstrap): create/list/find by identifier; `updatePlacement` with `rows` bumps `revision` 1→2; `deletePaywall` throws when a placement row references it; unique `(projectId, identifier)` violation surfaces.
- [x] **Step 2:** Run: `pnpm --filter @rovenue/db test -- placements` → FAIL (tables missing).
- [x] **Step 3:** Add schema tables, run `pnpm db:migrate:generate`, trim regenerated stale DDL if any, verify journal entry, `pnpm db:migrate`.
- [x] **Step 4:** Implement both repositories (copy `offerings.ts` repo structure; the reference check in `deletePaywall` scans `placements.rows` with a qualified `sql` containment query — `WHERE "placements"."projectId" = ... AND "placements"."rows" @> ...` is not expressible with `@>` for nested arrays of variants shapes, so instead: `SELECT 1 FROM placements WHERE "placements"."projectId" = ${projectId} AND EXISTS (SELECT 1 FROM jsonb_array_elements("placements"."rows") r WHERE r->'target'->>'paywallId' = ${id})` — plus a scan of `experiments.variants` for `type=PAYWALL`: `EXISTS (SELECT 1 FROM jsonb_array_elements("experiments"."variants") v WHERE v->'value'->>'paywallId' = ${id})`).
- [x] **Step 5:** Run tests → PASS. Commit: `feat(db): paywalls and placements tables + repositories`.

---

### Task 2: Shared — placement row schema + bucketing test vectors

**Files:**
- Create: `packages/shared/src/placements/schema.ts`, `packages/shared/src/placements/index.ts`
- Modify: `packages/shared/src/index.ts` (barrel)
- Create: `packages/shared/src/experiments/bucketing-vectors.json`
- Create: `packages/shared/src/experiments/bucketing-vectors.test.ts`

**Interfaces (Produces):**
```ts
export const placementTargetSchema: z.ZodType<PlacementTarget>; // discriminated union on "type"
export const placementRowSchema; export const placementRowsSchema; // array + refinements
export type PlacementRow; export type PlacementTarget;
```

Row schema:

```ts
import { z } from "zod";

export const placementTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paywall"), paywallId: z.string().min(1) }),
  z.object({ type: z.literal("experiment"), experimentId: z.string().min(1) }),
  z.object({ type: z.literal("none") }),
]);

export const placementRowSchema = z.object({
  audienceId: z.string().min(1).nullable(),
  target: placementTargetSchema,
});

export const placementRowsSchema = z
  .array(placementRowSchema)
  .superRefine((rows, ctx) => {
    const nullIdx = rows.findIndex((r) => r.audienceId === null);
    const nullCount = rows.filter((r) => r.audienceId === null).length;
    if (nullCount > 1)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "at most one all-users row" });
    if (nullCount === 1 && nullIdx !== rows.length - 1)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "all-users row must be last" });
  });
```

Vectors fixture — generated ONCE by a throwaway script calling the real `assignBucket`/`selectVariant`, then frozen (these exact values become the cross-language contract; Rust asserts against the same file):

```jsonc
{
  "bucketCount": 10000,
  "cases": [
    // 12+ cases; subscriberIds mix cuid2-like and unicode; seeds are experiment keys;
    // variants use fractional weights incl. FP-hazard splits like 0.34/0.33/0.33 and 0.1/0.9
    { "subscriberId": "ckvt3m8qc0000356mekq0v1x2", "seed": "onboarding-price-test",
      "expectedBucket": null,  // filled by the generator
      "variants": [ { "id": "a", "weight": 0.34 }, { "id": "b", "weight": 0.33 }, { "id": "c", "weight": 0.33 } ],
      "expectedVariantId": null }
  ]
}
```

- [x] **Step 1:** Write `bucketing-vectors.test.ts`: loads the JSON, asserts `assignBucket(c.subscriberId, c.seed) === c.expectedBucket` and `selectVariant(bucket, c.variants).id === c.expectedVariantId` for every case. Also unit tests for `placementRowsSchema` refinements (double-null rejected, null-not-last rejected, happy path).
- [x] **Step 2:** Generate the fixture with a one-off node script in the scratchpad (import from `packages/shared/src/experiments/bucketing.ts`, print JSON, paste). Run: `pnpm --filter @rovenue/shared test -- bucketing-vectors` → PASS.
- [x] **Step 3:** Commit: `feat(shared): placement row schema + cross-language bucketing vectors`.

---

### Task 3: API — extract offering hydration into a shared lib

Small refactor so Task 4 can reuse hydration without importing route internals.

**Files:**
- Create: `apps/api/src/lib/offering-hydration.ts`
- Modify: `apps/api/src/routes/v1/offerings.ts` (import from the new lib; delete the moved code)
- Test: covered by existing offerings tests (`apps/api/tests/` — locate with `grep -rl offerings apps/api/tests`)

**Interfaces (Produces):**
```ts
// apps/api/src/lib/offering-hydration.ts — moved verbatim from routes/v1/offerings.ts
export const packagesSchema; export type PackageSlot;
export function parseStoreIds(raw: unknown): Record<string, string>;
export interface OfferingProductEntry { /* unchanged shape */ }
export function hydrateProducts(memberships, productById): OfferingProductEntry[];
export async function hydrateOffering(projectId: string, offering: { identifier; isDefault; packages; metadata }):
  Promise<{ identifier: string; isDefault: boolean; packages: OfferingProductEntry[]; metadata: unknown }>;
// hydrateOffering = parse packages → offeringRepo.findProductsByIds → hydrateProducts (single-offering convenience)
```

- [x] **Step 1:** Move `packageSchema/packagesSchema/storeIdsSchema/parseStoreIds/OfferingProductEntry/hydrateProducts` verbatim; add `hydrateOffering`. Rewire `offerings.ts` imports.
- [x] **Step 2:** Run existing offerings tests + `pnpm --filter @rovenue/api build` (or `tsc`) → PASS/green.
- [x] **Step 3:** Commit: `refactor(api): extract offering hydration into lib for reuse`.

---

### Task 4: API — `GET /v1/placements/:identifier`

**Files:**
- Create: `apps/api/src/routes/v1/placements.ts`
- Modify: `apps/api/src/routes/v1/index.ts` (mount `.route("/placements", placementsRoute)` — mirror offerings mount)
- Test: `apps/api/tests/placements-resolve.integration.test.ts`

**Interfaces (Consumes):** Task 1 repos, Task 2 `placementRowsSchema`, Task 3 `hydrateOffering`, existing `matchesAudience` + `flattenAttributes` from `@rovenue/shared`, `resolveSubscriberByRovenueIdOrLegacy`.
**Interfaces (Produces):** response envelope per spec (`placement/paywall/experiment` triple) — the Rust wire types in Task 8 decode exactly this.

Handler logic (complete):

```ts
import { Hono } from "hono";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { flattenAttributes, matchesAudience, placementRowsSchema } from "@rovenue/shared";
import { hydrateOffering } from "../../lib/offering-hydration";
import { ok } from "../../lib/response";

const SUBSCRIBER_HEADER = "x-rovenue-user-id";

// remoteConfig column shape
const remoteConfigSchema = z.object({
  defaultLocale: z.string().min(1),
  locales: z.record(z.record(z.unknown())),
}).partial({ defaultLocale: true, locales: true });

function resolveLocale(remoteConfig: unknown, requested: string | undefined) {
  const parsed = remoteConfigSchema.safeParse(remoteConfig);
  if (!parsed.success || !parsed.data.locales) return { locale: null, data: null };
  const locales = parsed.data.locales;
  const fallback = parsed.data.defaultLocale ?? Object.keys(locales)[0] ?? null;
  const pick = (requested && locales[requested]) ? requested : fallback;
  return pick && locales[pick] ? { locale: pick, data: locales[pick] } : { locale: null, data: null };
}

async function hydratePaywall(projectId: string, paywall: Paywall, requestedLocale?: string) {
  const offering = await drizzle.offeringRepo.findOfferingById(drizzle.db, projectId, paywall.offeringId);
  const { locale, data } = resolveLocale(paywall.remoteConfig, requestedLocale);
  return {
    id: paywall.id,
    identifier: paywall.identifier,
    name: paywall.name,
    configFormatVersion: paywall.configFormatVersion,
    remoteConfig: locale ? { locale, data } : null,
    offering: offering ? await hydrateOffering(projectId, offering) : null,
  };
}

export const placementsRoute = new Hono().get("/:identifier", async (c) => {
  const project = c.get("project");
  const identifier = c.req.param("identifier");
  const requestedLocale = c.req.query("locale");

  const placement = await drizzle.placementRepo.findPlacementByIdentifier(
    drizzle.db, project.id, identifier,
  );
  // Unknown/inactive placements return the empty envelope, NOT 404 — a shipped
  // app must never crash because a placement was retired.
  if (!placement || !placement.isActive) {
    return c.json(ok({ placement: null, paywall: null, experiment: null }));
  }

  const placementInfo = { identifier: placement.identifier, revision: placement.revision };
  const rows = placementRowsSchema.safeParse(placement.rows);
  if (!rows.success) return c.json(ok({ placement: placementInfo, paywall: null, experiment: null }));

  // Subscriber attributes for audience matching ({} when anonymous — only
  // audienceId:null rows can match then).
  const appUserId = c.req.query("subscriberId") ?? c.req.header(SUBSCRIBER_HEADER);
  let attributes: Record<string, unknown> = {};
  if (appUserId) {
    const subscriber = await drizzle.subscriberRepo.resolveSubscriberByRovenueIdOrLegacy(
      drizzle.db, { projectId: project.id, key: appUserId },
    );
    if (subscriber) attributes = flattenAttributes(subscriber.attributes);
  }

  // Batch-load referenced audiences once, walk rows top-down.
  const audienceIds = rows.data.map((r) => r.audienceId).filter((x): x is string => !!x);
  const audiences = await drizzle.audienceRepo.findByIds(drizzle.db, project.id, audienceIds);
  const audienceById = new Map(audiences.map((a) => [a.id, a] as const));

  for (const row of rows.data) {
    if (row.audienceId !== null) {
      const audience = audienceById.get(row.audienceId);
      if (!audience) continue; // deleted audience → skip row
      if (!matchesAudience(attributes, audience.rules)) continue;
    }
    // Row matched — resolve target.
    if (row.target.type === "none") {
      return c.json(ok({ placement: placementInfo, paywall: null, experiment: null }));
    }
    if (row.target.type === "paywall") {
      const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, project.id, row.target.paywallId);
      if (!paywall || !paywall.isActive) continue; // dangling ref → next row
      return c.json(ok({
        placement: placementInfo,
        paywall: await hydratePaywall(project.id, paywall, requestedLocale),
        experiment: null,
      }));
    }
    // target.type === "experiment"
    const experiment = await drizzle.experimentRepo.findByIdInProject(
      drizzle.db, row.target.experimentId, project.id,
    );
    if (!experiment || experiment.type !== "PAYWALL" || experiment.status !== "RUNNING") continue;
    const variants = (experiment.variants as Array<{ id: string; weight: number; value: unknown }>) ?? [];
    const hydrated = [];
    for (const v of variants) {
      const paywallId = (v.value as { paywallId?: string } | null)?.paywallId;
      if (!paywallId) continue;
      const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, project.id, paywallId);
      if (!paywall || !paywall.isActive) continue;
      hydrated.push({
        variantId: v.id, weight: v.weight,
        paywall: await hydratePaywall(project.id, paywall, requestedLocale),
      });
    }
    if (hydrated.length === 0) continue; // legacy inline-config experiment → next row
    return c.json(ok({
      placement: placementInfo, paywall: null,
      experiment: { id: experiment.id, key: experiment.key, variants: hydrated },
    }));
  }
  return c.json(ok({ placement: placementInfo, paywall: null, experiment: null }));
});
```

(`audienceRepo.findByIds` and `offeringRepo.findOfferingById` — add to the respective repos if missing, same style as siblings.)

- [x] **Step 1:** Write failing integration tests: anonymous hits all-users row; attribute-matched audience row wins over later rows; `target:none` short-circuits; dangling paywall ref falls through to next row; RUNNING PAYWALL experiment returns variants with weights; DRAFT experiment row skipped; unknown placement → empty envelope 200; locale fallback to defaultLocale.
- [x] **Step 2:** Run → FAIL. **Step 3:** Implement route + mount + missing repo helpers. **Step 4:** Run → PASS.
- [x] **Step 5:** Add `/v1/placements` to edge-cache `CACHEABLE_PREFIXES` (`deploy/cloudflare/edge-cache/src/index.ts`) and confirm `purgeProjectCatalogCache` call sites will cover placement/paywall mutations (dashboard routes come in Task 6 — the purge call is added there).
- [x] **Step 6:** Commit: `feat(api): GET /v1/placements/:identifier resolution endpoint`.

---

### Task 5: API — expose lazy-assignment + `paywall_view` event + receipt attribution

**Files:**
- Modify: `apps/api/src/routes/v1/experiments.ts` (exposeBodySchema + handler)
- Modify: `apps/api/src/routes/v1/events.ts` (envelope + aggregate mapping)
- Modify: `apps/api/src/workers/outbox-dispatcher.ts` (aggregateType→topic map: add `PAYWALL_EVENT` → `rovenue.paywall_events`, mirroring `EXPOSURE`)
- Modify: Apple + Google receipt routes (locate: `grep -rl "receipts" apps/api/src/routes/v1`) — accept optional `presentedContext`
- Modify: `apps/api/src/services/stripe/stripe-webhook.ts` — copy `subscription.metadata.rovenue_presented_context` (JSON string, parse defensively) into revenue-event metadata when present
- Modify: `packages/db/src/drizzle/schema.ts` — `purchases.presentedContext` jsonb nullable column (+ migration)
- Test: `apps/api/tests/placements-events.integration.test.ts`

**Interfaces (Produces):**
```ts
// exposeBodySchema gains: placementId: z.string().min(1).optional()
// eventEnvelopeSchema gains:
paywallContext: z.object({
  paywallId: z.string().min(1),
  placementId: z.string().min(1),
  placementRevision: z.number().int().positive(),
  variantId: z.string().min(1).optional(),
  experimentKey: z.string().min(1).optional(),
}).optional()
// deriveAggregateType: eventType === "paywall_view" → "PAYWALL_EVENT"
// receipt bodies gain: presentedContext { placementId, paywallId, variantId?, experimentKey? } — all opaque strings, never validated against live rows (attribution must not fail a purchase)
```

Expose handler addition (after the existing variant-membership check, before publishExposure):

```ts
// Client-side draw: persist the assignment lazily so results/assignment
// queries keep working without a fetch-time write. Idempotent by design.
await drizzle.experimentAssignmentRepo.insertAssignmentsSkipDuplicates(drizzle.db, [{
  experimentId,
  subscriberId: subscriber.id,
  variantId: input.variantId,
  hashVersion: 1,
}]);
```

- [x] **Step 1:** Failing tests: expose with variantId creates assignment row exactly once across two calls; `paywall_view` envelope lands in outbox with `aggregateType: "PAYWALL_EVENT"`; Apple receipt with `presentedContext` persists it on the purchase row and revenue-event metadata; malformed `rovenue_presented_context` metadata is ignored without failing webhook processing.
- [x] **Step 2:** Run → FAIL. **Step 3:** Implement (envelope is `.strict()` — the new key must be added to the schema; check `insertAssignmentsSkipDuplicates` signature in the repo first and match it). Migration for `purchases.presentedContext`. **Step 4:** Run → PASS.
- [x] **Step 5:** Commit: `feat(api): paywall_view events, lazy exposure assignments, receipt attribution`.

---

### Task 6: API — dashboard CRUD routes for paywalls + placements

**Files:**
- Create: `apps/api/src/routes/dashboard/paywalls.ts`, `apps/api/src/routes/dashboard/placements.ts`
- Modify: dashboard router index (mirror how `dashboard/offerings.ts` is mounted)
- Test: `apps/api/tests/dashboard-paywalls.integration.test.ts`, `dashboard-placements.integration.test.ts`

Follow `apps/api/src/routes/dashboard/offerings.ts` verbatim for auth (`requireDashboardAuth` + `assertProjectAccess`), validation, and `purgeProjectCatalogCache` calls. Endpoints:

- Paywalls: `GET /` list · `POST /` create (Zod: identifier slug regex `^[a-z0-9-_]+$`, name, offeringId must exist in project, remoteConfig validated as `{ defaultLocale, locales }` where every locale value is an object, `defaultLocale ∈ locales`) · `PATCH /:id` · `DELETE /:id` (409 with `{ code: "PAYWALL_IN_USE" }` when repo rejects).
- Placements: `GET /` · `POST /` · `PATCH /:id` (rows validated with `placementRowsSchema` PLUS project-ownership checks: every audienceId/paywallId/experimentId exists in project; experiment targets must be `type=PAYWALL` — 400 `{ code: "INVALID_ROW_REF" }` otherwise) · `DELETE /:id`.
- Experiment write path: where dashboard experiments are created/updated (locate `grep -rl "PAYWALL" apps/api/src/routes/dashboard`), enforce `type=PAYWALL` variants carry `value: { paywallId }` referencing a project paywall.

- [x] **Step 1:** Failing tests: create/patch/delete happy paths; cross-project offeringId rejected; row referencing foreign experiment rejected; rows PATCH bumps revision; purge called (spy/mocked like existing offerings dashboard tests).
- [x] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. **Step 5:** Commit: `feat(api): dashboard CRUD for paywalls and placements`.

---

### Task 7: ClickHouse — paywall events pipeline

**Files:**
- Create: `packages/db/clickhouse/migrations/00NN_paywall_events.sql` (next number; follow `0002_exposures_kafka_engine.sql` structure: `*_queue` Kafka engine table on topic `rovenue.paywall_events` → `raw_paywall_events` ReplacingMergeTree keyed on deterministic `event_id` → `mv_paywall_events_to_raw`)
- Modify: `apps/api/src/services/event-bus.ts` or dispatcher payload shaping so the Kafka message carries flat columns: `event_id` (sha256 of `projectId:subscriberId:paywallId:placementId:clientEventId` — mirror the SDK-sessions deterministic-id pattern), `project_id`, `subscriber_id`, `paywall_id`, `placement_id`, `placement_revision`, `variant_id`, `experiment_key`, `occurred_at`
- Create: `packages/db/clickhouse/migrations/00NN+1_mv_paywall_daily.sql` — MV aggregating `(project_id, placement_id, paywall_id, variant_id, day)` → views + uniq state for unique views (use `AggregateFunction(uniq, String)` — the SummingMergeTree+AggregateFunction(uniq) combo is verified correct in this codebase; do NOT refactor to AggregatingMergeTree)
- Test: extend the CH verify path; integration test asserting a `paywall_view` outbox row round-trips (follow whichever existing test drives exposures through testcontainers Kafka+CH; remember integration tests must mutate `env`, not `process.env`, and never write `FINAL AS alias` — use `AS e FINAL`)

- [x] **Step 1:** Write the migration SQL (no comment-prefixed statements). **Step 2:** `pnpm --filter @rovenue/db db:clickhouse:migrate && pnpm --filter @rovenue/db db:verify:clickhouse` → green. **Step 3:** Integration test → PASS. **Step 4:** Commit: `feat(db): ClickHouse paywall events pipeline`.
- Note: fresh MV+topic — the "pause consumer before MV recreate" gotcha applies only to RE-creating live MVs; creation is safe.

---

### Task 8: Rust core — placements module (fetch, draw, cache, context)

**Files:**
- Create: `packages/core-rs/src/placements/{mod.rs,types.rs,client.rs,bucketing.rs}`
- Modify: `packages/core-rs/src/lib.rs` (module + facade wiring where `get_offerings` is exposed), `packages/core-rs/src/librovenue.udl` (new records + method), `packages/core-rs/Cargo.toml` (add `sha2` if absent)
- Create: `packages/core-rs/src/cache/placements.rs` (clone `cache/offerings.rs`, key prefix `placement:`)
- Test: unit tests in `bucketing.rs` (vectors via `include_str!("../../../shared/src/experiments/bucketing-vectors.json")`), client tests mirroring `offerings/client.rs` tests

**Interfaces (Produces — UDL/FFI):**
```rust
pub struct CorePresentedContext { pub placement_id: String, pub paywall_id: String,
  pub variant_id: Option<String>, pub experiment_key: Option<String>, pub revision: i64 }
pub struct CorePaywall {
  pub placement_identifier: String, pub placement_revision: i64,
  pub paywall_identifier: Option<String>, pub paywall_name: Option<String>,
  pub config_format_version: i64,
  pub remote_config_json: Option<String>,   // raw JSON string; façades decode (avoids uniffi record→HashMap gotcha)
  pub remote_config_locale: Option<String>,
  pub offering: Option<CoreOffering>,       // reuse existing type
  pub presented_context: Option<CorePresentedContext>,
}
// method: get_paywall(placement_id: String, locale: Option<String>) -> RovenueResult<Option<CorePaywall>>
// None ⇔ resolved to nothing (target none / retired placement) — NOT an error.
```

Bucketing port (complete — must match TS byte-for-byte):

```rust
use sha2::{Digest, Sha256};

pub const BUCKET_COUNT: u32 = 10_000;

pub fn assign_bucket(subscriber_id: &str, seed: &str) -> u32 {
    let digest = Sha256::digest(format!("{subscriber_id}:{seed}").as_bytes());
    let hash = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    hash % BUCKET_COUNT
}

/// Weights are fractions summing to 1. Boundary must replicate JS
/// `Math.round` (half-away-from-zero for positives = f64::round here).
pub fn select_variant_index(bucket: u32, weights: &[f64]) -> usize {
    let mut cumulative = 0.0f64;
    for (i, w) in weights.iter().enumerate() {
        cumulative += w * BUCKET_COUNT as f64;
        if (bucket as f64) < cumulative.round() {
            return i;
        }
    }
    weights.len() - 1
}
```

Client: clone `offerings/client.rs` shape — GET `/v1/placements/{id}?locale=`, decode the Task-4 envelope into wire types, cache raw JSON under `placement:{id}` on success, serve cache on `NetworkUnavailable|Timeout`. When the response carries `experiment`: draw with `assign_bucket(subscriber_id, experiment.key)` + `select_variant_index`, fire-and-forget `POST /v1/experiments/{id}/expose` with `{variantId, subscriberId, placementId}` (best-effort: log-and-ignore all errors), return the drawn variant's paywall with `presented_context` populated. Subscriber id source: the same identity the SDK sends on wire (`rovenue_id()` — NEVER `current_user_scope`). Store the returned `presented_context` in core state (`Mutex<Option<CorePresentedContext>>` on the SDK singleton, same place session state lives) so the receipt-submission path attaches it as `presentedContext` on the next purchase POST and clears it after a successful post.

- [x] **Step 1:** Failing vector test (`cargo test -p librovenue bucketing`). **Step 2:** Implement bucketing → vectors PASS (this is the cross-language contract gate).
- [x] **Step 3:** Client + cache tests (mock transport like offerings tests) → PASS. **Step 4:** UDL + `npm run sdk:bindings` regenerates cleanly; `cargo fmt && cargo clippy` green (CI blocks on these).
- [x] **Step 5:** Commit: `feat(core): get_paywall placements client with deterministic variant draw`.

---

### Task 9: Façades — Swift / Kotlin / RN `getPaywall` + `logPaywallShown`

**Files:**
- Swift: `packages/sdk-swift/` — public `getPaywall(placementId:locale:) async throws -> Paywall?`, `logPaywallShown(_ paywall: Paywall)`; `Paywall` struct decodes `remote_config_json` into `[String: Any]`
- Kotlin: `packages/sdk-kotlin/` — same pair (`suspend fun getPaywall(...): Paywall?`); `Types.kt` additions
- RN: `packages/sdk-rn/src/api/paywalls.ts` (`getPaywall(placementId, locale?)`, `logPaywallShown(paywall)`), `specs/RovenueModule.types.ts` `PaywallDTO`, native bridge methods in `RovenueModule.swift`/`.kt`
- Test: Kotlin unit tests (run `./gradlew testDebugUnitTest`); RN DTO-contract test (bridges don't build standalone — DTO contract is the gate); Swift unit test target

**Interfaces (Consumes):** Task 8 `CorePaywall`/`get_paywall`. **Produces:** `logPaywallShown` builds a `paywall_view` event `{ eventType: "paywall_view", occurredAt, eventId: <stable client id>, paywallContext: { paywallId, placementId, placementRevision, variantId?, experimentKey? } }` and enqueues it through the existing at-least-once session-telemetry dispatcher (peek→post→delete-on-2xx — do NOT drain-then-discard).

- [x] **Step 1:** Kotlin failing tests (DTO mapping, null paywall passthrough, logPaywallShown enqueues envelope). **Step 2:** Implement all three façades. **Step 3:** `./gradlew testDebugUnitTest` PASS; RN DTO tests PASS; Swift tests PASS. **Step 4:** Commit: `feat(sdk): getPaywall(placementId) + logPaywallShown across façades`.

---

### Task 10: Dashboard — paywalls section

**Files:**
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/paywalls.tsx`
- Create: `apps/dashboard/src/components/paywalls/{paywall-list.tsx,paywall-form-dialog.tsx,remote-config-editor.tsx,delete-paywall-dialog.tsx,types.ts}`
- Create: react-query hooks alongside existing offering hooks (locate `useProjectOfferings` and colocate `useProjectPaywalls`, `useCreatePaywall`, `useUpdatePaywall`, `useDeletePaywall` with the typed RPC client)

Model every component on `components/offerings/` (list + form dialog + actions menu). `remote-config-editor.tsx`: locale tabs (add/remove locale, default-locale select — reuse the `funnel-builder` `locale-switcher`/`localized-input` interaction patterns, not the components themselves unless they import cleanly) + per-locale JSON textarea with `JSON.parse` validation and error display. i18n via react-i18next like siblings.

- [x] **Step 1:** Implement route + components + hooks. **Step 2:** `pnpm --filter @rovenue/dashboard build` green; manual smoke via `pnpm dev` (create paywall → appears in list → edit remoteConfig locale → persists). **Step 3:** Commit: `feat(dashboard): paywalls CRUD with per-locale remote-config editor`.

---

### Task 11: Dashboard — placements section

**Files:**
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/placements.tsx`
- Create: `apps/dashboard/src/components/placements/{placement-list.tsx,placement-editor.tsx,row-card.tsx,target-picker.tsx,delete-placement-dialog.tsx,types.ts}` + hooks

`placement-editor.tsx`: ordered row cards with move-up/move-down buttons (drag-reorder optional; buttons are sufficient and match a YAGNI cut), per row: audience select (existing audiences hooks; a "All users" pseudo-option = `audienceId: null`, only selectable on the last row), target picker = segmented control paywall/experiment/none feeding a paywall select (`useProjectPaywalls`) or experiment select (existing experiments hooks filtered `type === "PAYWALL" && status === "RUNNING" || "DRAFT"`). Save PATCHes `rows`; surface the returned bumped `revision`. Also: in the experiment edit form, when `type=PAYWALL`, replace the variant `value` free-JSON input with a paywall picker writing `{ paywallId }`.

- [x] **Step 1:** Implement. **Step 2:** Build green + manual smoke (compose a placement with 2 rows + all-users fallback, reorder, save, revision bumps). **Step 3:** Placement detail metrics card: views/unique-views/purchases/CR from a new small API endpoint `GET /dashboard/projects/:projectId/placements/:id/metrics` querying `mv_paywall_daily` + revenue join (follow `apps/api/src/services/metrics/*` + `analytics-router.ts` conventions; graceful zeros when ClickHouse env is blank). **Step 4:** Commit: `feat(dashboard): placements editor with audience rows and metrics card`.

---

### Task 12: Docs + spec checkoff

**Files:**
- Modify: `apps/docs` — new SDK doc page "Placements & Paywalls" (getPaywall/logPaywallShown per platform, remote-config shape, attribution note); update offerings page cross-link
- Modify: `docs/superpowers/plans/2026-07-22-paywall-placements.md` — check off tasks
- Modify: `CLAUDE.md` — one line under Architecture: placements → paywalls resolution, client-side variant draw

- [x] **Step 1:** Write docs following existing Fumadocs page structure. **Step 2:** `pnpm --filter docs build` green. **Step 3:** Commit: `docs: placements + paywalls SDK guide`.

---

## Verification (after all tasks)

- [x] `pnpm build --force` — 8/8 green (2026-07-22)
- [x] `pnpm test` — all NEW placements suites green; api suite carries ~41 pre-existing failures from stale shared test-DB rows (reproduced on clean main via git stash — not regressions)
- [x] `cargo test && cargo fmt --check && cargo clippy` in `packages/core-rs` (fmt required clearing pre-existing drift — commit after f450984a)
- [x] `./gradlew testDebugUnitTest` in `packages/sdk-kotlin` — green
- [ ] `pnpm --filter @rovenue/db db:verify:clickhouse` — code verified green during Task 7 (migrate + verify + real Redpanda/CH round-trip); final re-run blocked by a LOCAL environment issue (rovenue_reader AUTHENTICATION_FAILED — credentials drifted after Task 7's green run; not a code defect)
- [x] Known pre-existing red: 6 integrations-framework tests (missing 0053) — not regressions.
