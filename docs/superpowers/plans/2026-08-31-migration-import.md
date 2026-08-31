# Migration & Data Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a vendor-agnostic CSV importer that migrates a RevenueCat or Adapty customer's subscribers, purchase history, revenue and live entitlements into a Rovenue project — plus the two migration guides.

**Architecture:** A column-mapping engine (not per-vendor parsers) feeds a canonical row contract. Phase A writes history through existing repositories; Phase B re-validates rows carrying a store anchor. A BullMQ worker streams the file from object storage in checkpointed batches. The dashboard gets the codebase's first upload → dry-run → commit → progress → report job UX.

**Tech Stack:** Hono + TypeScript (strict), Drizzle/Postgres, BullMQ/Redis, S3-compatible object storage, React (Vite) dashboard, Vitest (+ testcontainers), Fumadocs.

**Spec:** `docs/superpowers/specs/2026-08-31-migration-import-design.md` — read it in full before Task 1. Its §4.3 (row semantics), §4.4 (money rules) and §4.5 (side-effect discipline) are requirements, not commentary.

**Vendor research:** `docs/superpowers/research/2026-08-31-rc-adapty-export-formats.md`. Items it marks **unconfirmed may not become confident assertions** in code, comments, tests or docs. If you need one, verify it first-party or keep the hedge.

## Global Constraints

- **Never create or switch branches or worktrees.** Commit on whatever HEAD is checked out.
- **Never stage** `apps/dashboard/src/components/assets/asset-library.tsx` or `packages/db/seed.ts` — pre-existing unrelated dirty files.
- **Throttle every heavy command:** prefix with `nice -n 19`; vitest runs use `--maxWorkers=2`; run suites strictly sequentially, never concurrently; kill lingering vitest processes between suites.
- **No magic values.** Every literal listed in this plan is given as a named constant with its name; use those names.
- TypeScript strict; Zod for API input; all API responses are `{ data: T }` or `{ error: { code, message } }`.
- Postgres access through Drizzle repositories only. In raw `sql`, qualify columns (`"purchases"."id"`) — bare `${table.col}` renders unqualified and breaks correlated subqueries.
- **No self-confirming tests.** The idempotency and no-side-effects claims are proven against real Postgres (testcontainers) by observing state, never by asserting on a helper's return value or reading the code.
- Conventional commits. One task = one commit unless a task says otherwise.
- **Read the real schema before writing DB code.** This plan states the columns confirmed on 2026-08-31; if reality differs, reality wins — report the discrepancy rather than coding around it.

### Confirmed schema facts (verified 2026-08-31 — do not re-derive, but do re-confirm if something fails)

- `purchases`: `productId` **NOT NULL** → `products.id`; `storeTransactionId` and `originalTransactionId` both **NOT NULL**; `verifiedAt` **already exists** (this is the Phase A/B marker — do not add a column); `priceAmount` (decimal 12,4) and `priceCurrency` both nullable; `ownershipType` text; `gracePeriodExpires`, `refundDate`, `cancellationDate`, `autoRenewStatus`, `isTrial`, `isIntroOffer`, `isSandbox`, `environment`, `purchaseDate`, `originalPurchaseDate`, `expiresDate` all present.
- `subscribers`: unique `(projectId, rovenueId)`; `appUserId` nullable; `mergedInto` nullable; `attributes` jsonb; **no `platform` column is set by an importer** (first-install truth from the SDK only).
- Enums: `Store = APP_STORE | PLAY_STORE | STRIPE | MANUAL`; `PurchaseStatus = TRIAL | ACTIVE | EXPIRED | REFUNDED | REVOKED | PAUSED | GRACE_PERIOD`. Read `packages/db/src/drizzle/enums.ts` for `environment`'s members before using it.
- Existing manual-grant representation to mirror: `apps/api/src/services/subscriptions/grant.ts` (`store: "MANUAL"`, `storeTransactionId = originalTransactionId = "comp_<id>"`).
- Next migration number: **0105** (last is `packages/db/drizzle/migrations/0104_integrations_provider_text.sql`).
- Capability table: `apps/api/src/lib/capabilities.ts` — `Capability` union + `CAPABILITY_ROLES`.

---

## File Structure

**New — shared import core (pure, no I/O, heavily unit-tested):**
- `packages/shared/src/import/canonical.ts` — the canonical row contract + field metadata
- `packages/shared/src/import/csv.ts` — RFC 4180 streaming parser
- `packages/shared/src/import/presets.ts` — the RevenueCat Transactions preset + header fingerprinting
- `packages/shared/src/import/mapping.ts` — mapping validation
- `packages/shared/src/import/normalize.ts` — row → canonical record (status, money, timestamps)
- `packages/shared/src/import/keys.ts` — deterministic dedupe key + synthetic-id builders
- `packages/shared/src/import/index.ts` — barrel

**New — persistence:**
- `packages/db/drizzle/migrations/0105_import_jobs.sql`
- `packages/db/src/drizzle/schema.ts` (modify: `importJobs` table), `enums.ts` (modify: `importJobStatus`)
- `packages/db/src/drizzle/repositories/import-jobs.ts`

**New — API:**
- `apps/api/src/services/import/report.ts` — outcome buckets + report writer
- `apps/api/src/services/import/plan.ts` — dry run
- `apps/api/src/services/import/write.ts` — Phase A writer
- `apps/api/src/services/import/verify.ts` — Phase B store re-validation
- `apps/api/src/queues/imports.ts`, `apps/api/src/workers/import-runner.ts`
- `apps/api/src/routes/dashboard/imports.ts`
- modify: `apps/api/src/lib/capabilities.ts`, `apps/api/src/lib/audit.ts`

**New — dashboard:**
- `apps/dashboard/src/routes/.../imports/` page + `components/imports/` (upload, mapping table, dry-run summary, progress, report)

**Docs:**
- modify `apps/docs/content/docs/resources/migrating-from-revenuecat.mdx`
- create `apps/docs/content/docs/resources/migrating-from-adapty.mdx`, modify `resources/meta.json`
- modify `ROADMAP.md` §11

---

## Task 1: Canonical contract + CSV parser

**Files:**
- Create: `packages/shared/src/import/canonical.ts`, `packages/shared/src/import/csv.ts`, `packages/shared/src/import/index.ts`
- Test: `packages/shared/src/import/__tests__/csv.test.ts`

**Interfaces:**
- Produces: `CanonicalField` (union), `CANONICAL_FIELDS` (metadata array), `CanonicalRow`, `parseCsvStream(source: AsyncIterable<Uint8Array>, opts): AsyncGenerator<{ header: string[] } | { row: string[]; lineNumber: number }>`.

- [ ] **Step 1: Write the canonical contract.** Every downstream task targets these names.

```ts
// packages/shared/src/import/canonical.ts
export const CANONICAL_FIELDS = [
  { key: "subscriberExternalId", required: true,  label: "Subscriber ID" },
  { key: "subscriberAliasId",    required: false, label: "Subscriber alias" },
  { key: "store",                required: true,  label: "Store" },
  { key: "storeTransactionId",   required: false, label: "Store transaction ID" },
  { key: "originalTransactionId",required: false, label: "Original transaction ID" },
  { key: "googlePurchaseToken",  required: false, label: "Google purchase token" },
  { key: "stripeSubscriptionId", required: false, label: "Stripe subscription ID" },
  { key: "productIdentifier",    required: true,  label: "Product identifier" },
  { key: "productDisplayName",   required: false, label: "Product display name" },
  { key: "purchaseDate",         required: true,  label: "Purchase date" },
  { key: "expiresDate",          required: false, label: "Expiry date" },
  { key: "effectiveEndDate",     required: false, label: "Effective end date" },
  { key: "gracePeriodEndDate",   required: false, label: "Grace period end" },
  { key: "refundedAt",           required: false, label: "Refunded at" },
  { key: "unsubscribeDetectedAt",required: false, label: "Unsubscribe detected at" },
  { key: "priceUsd",             required: false, label: "Price (USD)" },
  { key: "isTrial",              required: false, label: "Is trial" },
  { key: "isIntroOffer",         required: false, label: "Is intro offer" },
  { key: "isSandbox",            required: false, label: "Is sandbox" },
  { key: "isAutoRenewable",      required: false, label: "Is auto-renewable" },
  { key: "renewalNumber",        required: false, label: "Renewal number" },
  { key: "ownershipType",        required: false, label: "Ownership type" },
  { key: "entitlementIdentifiers", required: false, label: "Entitlement identifiers" },
  { key: "country",              required: false, label: "Country" },
  { key: "customAttributes",     required: false, label: "Custom attributes" },
  { key: "updatedAt",            required: false, label: "Source updated at" },
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number]["key"];
export type CanonicalRow = Partial<Record<CanonicalField, string>>;
```

Note the deliberate absence of a raw local-price field: the spec forbids stamping a guessed currency, and RC's raw-currency column is unconfirmed. Do not add one on speculation.

- [ ] **Step 2: Write the failing parser tests first.** These cases are the parser's whole contract.

```ts
// packages/shared/src/import/__tests__/csv.test.ts
import { describe, expect, it } from "vitest";
import { parseCsvToRows } from "../csv";  // test helper that drains parseCsvStream

const src = (s: string) => (async function* () { yield new TextEncoder().encode(s); })();

describe("parseCsvStream", () => {
  it("parses a simple header and row", async () => {
    const out = await parseCsvToRows(src("a,b\n1,2\n"));
    expect(out.header).toEqual(["a", "b"]);
    expect(out.rows).toEqual([["1", "2"]]);
  });

  it("strips a UTF-8 BOM from the first header cell", async () => {
    const out = await parseCsvToRows(src("﻿a,b\n1,2\n"));
    expect(out.header).toEqual(["a", "b"]);
  });

  it("honours quoted fields containing commas, newlines and escaped quotes", async () => {
    const out = await parseCsvToRows(src('a,b\n"x,y","he said ""hi""\nsecond line"\n'));
    expect(out.rows).toEqual([["x,y", 'he said "hi"\nsecond line']]);
  });

  it("accepts unquoted values (Adapty's documented style)", async () => {
    const out = await parseCsvToRows(src("user_id,token\nu1,t1\n"));
    expect(out.rows).toEqual([["u1", "t1"]]);
  });

  it("handles CRLF line endings", async () => {
    const out = await parseCsvToRows(src("a,b\r\n1,2\r\n"));
    expect(out.rows).toEqual([["1", "2"]]);
  });

  it("does not split a row that straddles two chunks", async () => {
    const chunked = (async function* () {
      yield new TextEncoder().encode('a,b\n"x');
      yield new TextEncoder().encode(',y",2\n');
    })();
    const out = await parseCsvToRows(chunked);
    expect(out.rows).toEqual([["x,y", "2"]]);
  });

  it("reports the source line number with each row", async () => {
    const out = await parseCsvToRows(src("a\n1\n2\n"));
    expect(out.lineNumbers).toEqual([2, 3]);
  });

  it("rejects a row whose column count differs from the header", async () => {
    await expect(parseCsvToRows(src("a,b\n1\n"))).rejects.toThrow(/column count/i);
  });
});
```

- [ ] **Step 3: Run them and watch them fail.** `cd packages/shared && nice -n 19 npx vitest run src/import --maxWorkers=2` → FAIL (module not found).
- [ ] **Step 4: Implement `csv.ts`** as a streaming state machine over decoded chunks (never buffer the whole file; a real export is gigabytes). Export `parseCsvStream` plus the small `parseCsvToRows` test helper. Add the barrel.
- [ ] **Step 5: Green.** Same command → PASS. `nice -n 19 pnpm --filter @rovenue/shared build`.
- [ ] **Step 6: Commit** `feat(import): canonical row contract and streaming CSV parser`.

---

## Task 2: RevenueCat preset, header fingerprinting, mapping validation

**Files:**
- Create: `packages/shared/src/import/presets.ts`, `packages/shared/src/import/mapping.ts`
- Test: `packages/shared/src/import/__tests__/presets.test.ts`, `__tests__/mapping.test.ts`

**Interfaces:**
- Consumes: `CANONICAL_FIELDS`, `CanonicalField` (Task 1).
- Produces: `IMPORT_PRESETS`, `detectPreset(header: string[]): { presetId: string; mapping: Record<string, CanonicalField>; matched: number; total: number } | null`, `validateMapping(mapping): { ok: true } | { ok: false; missingRequired: CanonicalField[] }`.

- [ ] **Step 1: Write the RevenueCat Transactions preset** using exactly these source column names (from the research file's confirmed table):

```ts
// packages/shared/src/import/presets.ts
export const REVENUECAT_TRANSACTIONS_PRESET_ID = "revenuecat_transactions";

const REVENUECAT_TRANSACTIONS_COLUMNS: Record<string, CanonicalField> = {
  rc_original_app_user_id: "subscriberExternalId",
  rc_last_seen_app_user_id_alias: "subscriberAliasId",
  store: "store",
  store_transaction_id: "storeTransactionId",
  product_identifier: "productIdentifier",
  product_display_name: "productDisplayName",
  start_time: "purchaseDate",
  end_time: "expiresDate",
  effective_end_time: "effectiveEndDate",
  grace_period_end_time: "gracePeriodEndDate",
  refunded_at: "refundedAt",
  unsubscribe_detected_at: "unsubscribeDetectedAt",
  price_in_usd: "priceUsd",
  is_trial_period: "isTrial",
  is_in_intro_offer_period: "isIntroOffer",
  is_sandbox: "isSandbox",
  is_auto_renewable: "isAutoRenewable",
  renewal_number: "renewalNumber",
  ownership_type: "ownershipType",
  entitlement_identifiers: "entitlementIdentifiers",
  country: "country",
  custom_subscriber_attributes: "customAttributes",
  updated_at: "updatedAt",
};
```

`store_transaction_id` is included on the strength of RevenueCat's own documented guidance that `store_transaction_id + renewal_number` is the unique key; it was not in the column table the research captured. Say exactly that in a code comment — do not upgrade it to a confirmed column. The mapper is what makes this safe: a customer whose header lacks it simply maps it themselves or gets an unresolved-anchor report.

Also ship `REVENUECAT_GOOGLE_TOKEN_PRESET_ID` for the support-mediated three-column file: `user_id → subscriberExternalId`, `google_purchase_token → googlePurchaseToken`, `google_product_id → productIdentifier`.

**Ship no Adapty preset** (spec §3): its column table is unconfirmed and inventing one would be fabrication.

- [ ] **Step 2: Write failing tests.**

```ts
it("detects the RevenueCat preset from a full header", () => {
  const r = detectPreset(Object.keys(REVENUECAT_TRANSACTIONS_COLUMNS));
  expect(r?.presetId).toBe(REVENUECAT_TRANSACTIONS_PRESET_ID);
  expect(r?.matched).toBe(r?.total);
});

it("proposes a partial mapping without claiming a full match", () => {
  const r = detectPreset(["rc_original_app_user_id", "store", "product_identifier", "start_time", "mystery_column"]);
  expect(r?.presetId).toBe(REVENUECAT_TRANSACTIONS_PRESET_ID);
  expect(r!.matched).toBeLessThan(r!.total);
  expect(r!.mapping).not.toHaveProperty("mystery_column");
});

it("returns null for a header that resembles nothing", () => {
  expect(detectPreset(["foo", "bar", "baz"])).toBeNull();
});

it("detects the Google-token supplemental file as its own preset", () => {
  expect(detectPreset(["user_id", "google_purchase_token", "google_product_id"])?.presetId)
    .toBe(REVENUECAT_GOOGLE_TOKEN_PRESET_ID);
});

it("blocks a mapping that is missing a required field", () => {
  const res = validateMapping({ some_col: "subscriberExternalId" });
  expect(res.ok).toBe(false);
  expect(res.missingRequired).toContain("productIdentifier");
});

it("never maps two source columns onto the same canonical field", () => {
  const res = validateMapping({ a: "productIdentifier", b: "productIdentifier" });
  expect(res.ok).toBe(false);
});
```

- [ ] **Step 3: Run → FAIL. Step 4: Implement. Step 5: Run → PASS.**
- [ ] **Step 6: Commit** `feat(import): RevenueCat presets, header detection and mapping validation`.

---

## Task 3: Row normalizer — status, money, timestamps

This task carries spec §4.3 and §4.4. It is pure, and it is where a migration is right or wrong.

**Files:**
- Create: `packages/shared/src/import/normalize.ts`, `packages/shared/src/import/keys.ts`
- Test: `packages/shared/src/import/__tests__/normalize.test.ts`, `__tests__/keys.test.ts`

**Interfaces:**
- Produces: `normalizeRow(raw: CanonicalRow, ctx: { now: Date }): NormalizedRow | { error: NormalizeError }`, `deriveStatus(...)`, `normalizeMoney(...)`, `buildRevenueDedupeKey(...)`, `buildSyntheticTransactionId(...)`, `STORE_VALUE_MAP`.

- [ ] **Step 1: Store mapping + status derivation.**

```ts
export const STORE_VALUE_MAP: Record<string, "APP_STORE" | "PLAY_STORE" | "STRIPE" | "MANUAL"> = {
  app_store: "APP_STORE",
  play_store: "PLAY_STORE",
  stripe: "STRIPE",
  promotional: "MANUAL",
};

export function deriveStatus(r: NormalizedDates & { isTrial: boolean }, now: Date): PurchaseStatusName {
  if (r.refundedAt) return "REFUNDED";
  const end = r.effectiveEndDate ?? r.expiresDate;
  if (!end) return r.isTrial ? "TRIAL" : "ACTIVE";      // lifetime / non-expiring
  if (end.getTime() > now.getTime()) {
    return r.isTrial ? "TRIAL" : "ACTIVE";
  }
  if (r.gracePeriodEndDate && r.gracePeriodEndDate.getTime() > now.getTime()) return "GRACE_PERIOD";
  return "EXPIRED";
}
```

`effective_end_time` is preferred because RevenueCat documents it as the normalized "when does access end" value that already accounts for each store's refund and grace-period logic. `unsubscribeDetectedAt` maps to `autoRenewStatus = false` and `cancellationDate`, **not** to a status — a cancelled-but-unexpired subscription is still ACTIVE.

- [ ] **Step 2: Write the failing tests.** These encode the rules; each one is a real-world case from the research file.

```ts
const base = { isTrial: false, refundedAt: null, gracePeriodEndDate: null };
const NOW = new Date("2026-08-31T00:00:00Z");
const d = (s: string) => new Date(s);

it("uses effective_end_time in preference to end_time", () => {
  expect(deriveStatus({ ...base, expiresDate: d("2030-01-01T00:00:00Z"), effectiveEndDate: d("2020-01-01T00:00:00Z") }, NOW)).toBe("EXPIRED");
});

it("treats a refund as terminal regardless of dates", () => {
  expect(deriveStatus({ ...base, refundedAt: d("2026-01-01T00:00:00Z"), expiresDate: d("2030-01-01T00:00:00Z"), effectiveEndDate: null }, NOW)).toBe("REFUNDED");
});

it("treats Google's end_time-before-start_time as expired, not malformed", () => {
  const row = normalizeRow({ ...rcRow, start_time_mapped: "2026-05-01 00:00:00", expiresDate: "2026-04-01 00:00:00" }, { now: NOW });
  expect("error" in row).toBe(false);
  expect((row as NormalizedRow).status).toBe("EXPIRED");
});

it("reports grace period only while the grace window is still open", () => {
  expect(deriveStatus({ ...base, expiresDate: d("2026-08-01T00:00:00Z"), effectiveEndDate: d("2026-08-01T00:00:00Z"), gracePeriodEndDate: d("2026-09-30T00:00:00Z") }, NOW)).toBe("GRACE_PERIOD");
  expect(deriveStatus({ ...base, expiresDate: d("2026-08-01T00:00:00Z"), effectiveEndDate: d("2026-08-01T00:00:00Z"), gracePeriodEndDate: d("2026-08-10T00:00:00Z") }, NOW)).toBe("EXPIRED");
});

it("keeps a cancelled-but-unexpired subscription ACTIVE and records auto-renew off", () => {
  const row = normalizeRow({ ...rcRow, unsubscribeDetectedAt: "2026-08-01 00:00:00", effectiveEndDate: "2026-12-01 00:00:00" }, { now: NOW }) as NormalizedRow;
  expect(row.status).toBe("ACTIVE");
  expect(row.autoRenewStatus).toBe(false);
  expect(row.cancellationDate).toEqual(d("2026-08-01T00:00:00Z"));
});

it("maps price_in_usd to a USD amount", () => {
  expect(normalizeMoney({ priceUsd: "9.99" })).toEqual({ priceAmount: "9.99", priceCurrency: "USD" });
});

it("stores a refund amount positive", () => {
  expect(normalizeMoney({ priceUsd: "-9.99" })).toEqual({ priceAmount: "9.99", priceCurrency: "USD" });
});

it("emits no money at all rather than guessing a currency", () => {
  expect(normalizeMoney({})).toEqual({ priceAmount: null, priceCurrency: null });
});

it("parses RevenueCat's space-separated UTC timestamps as UTC", () => {
  expect(parseSourceTimestamp("2023-01-01 08:27:06")).toEqual(new Date("2023-01-01T08:27:06Z"));
});

it("rejects an ambiguous timestamp instead of guessing a zone", () => {
  expect(() => parseSourceTimestamp("01/02/2023")).toThrow();
});

it("marks FAMILY_SHARED rows as revenue-excluded", () => {
  const row = normalizeRow({ ...rcRow, ownershipType: "FAMILY_SHARED" }, { now: NOW }) as NormalizedRow;
  expect(row.excludeFromRevenue).toBe(true);
});
```

- [ ] **Step 3: Key builders — the highest-consequence code in the branch.**

```ts
// packages/shared/src/import/keys.ts
export const IMPORT_DEDUPE_PREFIX = "import";
export const IMPORT_SYNTHETIC_TXN_PREFIX = "comp_import";

/** Stable across re-runs: derived ONLY from source transaction identity.
 *  It must never include the import-job id — that would double a customer's
 *  lifetime revenue on their second attempt. */
export function buildRevenueDedupeKey(p: { store: string; storeTransactionId: string; renewalNumber: string | null }): string {
  return [IMPORT_DEDUPE_PREFIX, p.store, p.storeTransactionId, p.renewalNumber ?? "0"].join(":");
}

/** Anchorless rows (RevenueCat `promotional`, manual grants) have no store
 *  transaction. We mirror grantComp's MANUAL representation, but derive the id
 *  deterministically so a re-run resolves to the same purchase. */
export function buildSyntheticTransactionId(p: { projectId: string; subscriberExternalId: string; productIdentifier: string; purchaseDateIso: string }): string { /* sha256 hex, prefixed */ }
```

Tests: same inputs → identical outputs across calls; different `renewalNumber` → different keys; **a changed job id cannot change either output** (assert by constructing the inputs without one — the function signature makes it impossible, and the test documents why).

- [ ] **Step 4: Run → FAIL → implement → PASS.** `cd packages/shared && nice -n 19 npx vitest run src/import --maxWorkers=2`.
- [ ] **Step 5: Commit** `feat(import): row normalizer with status, money and deterministic key rules`.

---

## Task 4: `import_jobs` table, enum, migration, repository

**Files:**
- Create: `packages/db/drizzle/migrations/0105_import_jobs.sql`, `packages/db/src/drizzle/repositories/import-jobs.ts`
- Modify: `packages/db/src/drizzle/enums.ts`, `packages/db/src/drizzle/schema.ts`, the repositories barrel
- Test: `packages/db/tests/import-jobs.test.ts` (needs `DATABASE_URL` exported — see the `@rovenue/db` vitest setup)

**Interfaces:**
- Produces: `importJobs` table; `importJobStatus` enum with members `PENDING_MAPPING | DRY_RUN_RUNNING | DRY_RUN_COMPLETE | RUNNING | COMPLETED | FAILED | CANCELLED`; repo functions `createImportJob`, `getImportJob`, `listImportJobs`, `updateImportJobMapping`, `setImportJobStatus`, `saveImportJobCheckpoint`, `incrementImportJobCounters`.

- [ ] **Step 1: Columns.** `id` (cuid2), `projectId` (FK cascade), `createdByUserId`, `sourceLabel` (text — the vendor the operator chose, free text, never trusted as schema), `presetId` (nullable), `storageKey`, `fileName`, `fileBytes`, `fileSha256`, `mapping` (jsonb), `options` (jsonb — `skipSandbox`, `importAnchorless`), `status`, `checkpointLine` (integer, default 0), counters (jsonb: one key per outcome bucket), `reportStorageKey` (nullable), `errorMessage` (nullable), `startedAt`, `finishedAt`, `createdAt`, `updatedAt`. Index `(projectId, createdAt desc)`.
- [ ] **Step 2: Generate the migration** with `pnpm db:migrate:generate`, then **read the generated SQL** and trim anything unrelated that drizzle-kit swept in (this repo has been bitten by that before). Confirm the file is numbered `0105`.
- [ ] **Step 3: Write repository tests first** — create → read back; status transitions; checkpoint monotonically advances and never regresses; counters increment additively; `listImportJobs` is project-scoped and cannot see another project's rows.
- [ ] **Step 4: Implement, run → PASS.** `cd packages/db && DATABASE_URL=... nice -n 19 npx vitest run tests/import-jobs --maxWorkers=2`.
- [ ] **Step 5: Commit** `feat(db): import_jobs table and repository`.

---

## Task 5: Upload endpoint, capability, audit actions

**Files:**
- Create: `apps/api/src/routes/dashboard/imports.ts` (upload + create-job only in this task)
- Modify: `apps/api/src/lib/capabilities.ts`, `apps/api/src/lib/audit.ts`, the dashboard route registrar
- Test: `apps/api/tests/routes/imports-upload.test.ts`

**Interfaces:**
- Produces: `POST /dashboard/projects/:projectId/imports` (raw body, returns the created job with the detected preset + proposed mapping); constants `IMPORT_MAX_UPLOAD_BYTES`, `IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE`, `IMPORT_FILE_RETENTION_DAYS`, `IMPORT_STORAGE_PREFIX`.

- [ ] **Step 1: Add the capability.** `"subscribers:import"` → `["OWNER", "ADMIN"]`, with a comment explaining it sits at the GDPR tier because bulk-creating subscribers and purchases is at least as consequential as exporting them.
- [ ] **Step 2: Add audit actions** `"import.started"` and `"import.completed"` to the `AuditAction` union (it is closed — an arbitrary string will not type-check).
- [ ] **Step 3: Write failing route tests.** A member below ADMIN gets 403. A foreign `projectId` gets **404, not 403** (matching the GDPR handlers, so existence does not leak). A body over `IMPORT_MAX_UPLOAD_BYTES` is rejected by the route's own `bodyLimit` — and assert this explicitly, because a root-level `*` bodyLimit once shadowed per-route caps in this repo and the failure surfaced to users as a generic network error. A valid upload returns a job whose `mapping` is the detected proposal and whose status is `PENDING_MAPPING`.
- [ ] **Step 4: Implement.** Mirror `assets.ts`'s raw-body approach (not multipart), stream to object storage under `IMPORT_STORAGE_PREFIX` while hashing, and only then read the header to detect the preset. **The stored object must never be publicly readable** — a bucket policy granting anonymous download also grants `ListBucket`, which would expose every customer's PII export; the policy must be `s3:GetObject`-only and the task must verify both directions.
- [ ] **Step 5: PASS. Commit** `feat(import): upload endpoint, import capability and audit actions`.

---

## Task 6: Dry run — outcome buckets and the report artefact

**Files:**
- Create: `apps/api/src/services/import/report.ts`, `apps/api/src/services/import/plan.ts`
- Test: `apps/api/tests/services/import-plan.test.ts`

**Interfaces:**
- Produces: `IMPORT_OUTCOMES` (the closed bucket list), `planImport(jobId): Promise<ImportPlanSummary>`, `writeReportRow`/`finalizeReport`.

- [ ] **Step 1: Define the buckets as a named constant** — `willCreate`, `willUpdate`, `skippedSandbox`, `unresolvedProduct`, `anchorless`, `androidNoToken`, `invalidRow`, `duplicateInFile`. Every row lands in exactly one; the counts are what the operator sees.
- [ ] **Step 2: Failing tests.**
  - A row whose `productIdentifier` is absent from the project's catalog → `unresolvedProduct`, and **no product is created** (assert the products table is unchanged).
  - A `promotional` row → `anchorless`.
  - A `play_store` row with no `googlePurchaseToken` mapped → `androidNoToken`, and the summary carries a **count**, not a boolean.
  - Sandbox rows → `skippedSandbox` by default; with `options.skipSandbox = false` they move to `willCreate`.
  - Two rows with the same `(store, storeTransactionId)` in one file → the second is `duplicateInFile`.
  - A dry run writes **nothing**: assert subscriber, purchase and revenue-event counts are unchanged afterwards.
- [ ] **Step 3: Implement.** Resolve products against the project's catalog (RC's Stripe `product_identifier` may be `price_…`, `prod_…` or a custom string within one file — handle all three). Resolve subscribers through the existing merge-chain-following resolver in read-only mode. Stream report rows out to object storage rather than accumulating them in memory.
- [ ] **Step 4: PASS. Commit** `feat(import): dry-run planner with outcome buckets and report artefact`.

---

## Task 7: Phase A writer

**Files:**
- Create: `apps/api/src/services/import/write.ts`
- Test: `apps/api/tests/services/import-write.integration.test.ts` (testcontainers — real Postgres)

**Interfaces:**
- Consumes: `planImport` output, the normalizer, the key builders.
- Produces: `writeImportBatch(jobId, rows): Promise<BatchOutcome>`.

- [ ] **Step 1: Write the integration tests first — they are the spec's acceptance criteria 2 and 3.**
  - **Idempotency:** run the same file twice against a real database; assert subscriber count, purchase count and summed revenue are identical after the second run.
  - **No side effects:** after an import, assert **zero** `SUBSCRIPTION`-aggregate outbox rows and **zero** enqueued outgoing webhooks. This must fail if someone later routes the writer through `runPostProcessing`.
  - **Revenue does reach analytics:** assert `REVENUE_EVENT` outbox rows exist and that a second run adds none (the `dedupeKey` claim holds).
  - **Merge chains:** a subscriber whose row is `mergedInto` another must receive writes on the surviving row, not the dead one.
  - **Terminal states:** re-importing an older file over a now-`REFUNDED` purchase does not resurrect it.
  - **Anchorless determinism:** a `promotional` row imported twice yields exactly one `MANUAL` purchase.
- [ ] **Step 2: Implement.** Write through `upsertSubscriber` / `upsertPurchase` / `createRevenueEvent` (always with the dedupe key) and then `syncAccess` per touched subscriber. Set `verifiedAt = null` for Phase A rows. Never write `subscriber_access` directly. Never set `subscribers.platform`.
- [ ] **Step 3: PASS. Commit** `feat(import): phase A writer with idempotent, side-effect-free history load`.

---

## Task 8: Worker, queue, checkpointing, cancellation

**Files:**
- Create: `apps/api/src/queues/imports.ts`, `apps/api/src/workers/import-runner.ts`
- Test: `apps/api/tests/workers/import-runner.integration.test.ts`

**Interfaces:**
- Produces: queue name constant `IMPORT_QUEUE_NAME = "rovenue-imports"`, `IMPORT_BATCH_SIZE`, `IMPORT_JOB_CONCURRENCY_PER_PROJECT = 1`.

- [ ] **Step 1: Failing tests.** Kill the worker mid-file and restart it: the job completes and **no row is written twice** (assert totals, not logs). A cancelled job stops and leaves prior writes intact; re-running the same file completes it. Two jobs for one project do not run concurrently.
- [ ] **Step 2: Implement.** Follow the repo's convention — each worker declares its own `new Queue(...)` with its own `defaultJobOptions`; there is no shared factory. Stream from object storage, process `IMPORT_BATCH_SIZE` rows per checkpoint, persist `checkpointLine` after each batch, and resume from it. **If you enqueue with a custom backoff, you must also pass `backoff: { type: "custom" }` on the job** — this repo has already shipped a dead custom-backoff strategy that BullMQ silently ignored.
- [ ] **Step 3: PASS. Commit** `feat(import): import worker with checkpointed resume and cancellation`.

---

## Task 9: Phase B store re-validation

**Files:**
- Create: `apps/api/src/services/import/verify.ts`
- Test: `apps/api/tests/services/import-verify.test.ts`

**Interfaces:**
- Produces: `verifyImportedAnchors(jobId, deps): Promise<VerifySummary>` with the store clients injected so tests can fake them; `IMPORT_VERIFY_CONCURRENCY`, `IMPORT_VERIFY_RATE_PER_SECOND`.

- [ ] **Step 1: Failing tests, against a faked store client** (a real one would be a self-confirming test of nothing):
  - 40 rows sharing one Apple `originalTransactionId` produce **one** verification call, not 40.
  - A throttling response pauses and resumes rather than failing rows; the job's outcome is `verification incomplete`, not `completed`.
  - A verified row gets `verifiedAt` set and its live status from the store, superseding the imported snapshot.
  - An anchorless row is never sent to verification at all.
  - A row the store no longer recognises stays as history and is **not** deleted — this is the explicit divergence from Adapty's importer.
- [ ] **Step 2: Implement** with bounded concurrency and a paced request rate, reusing the project's configured store credentials and the existing receipt-verification code path rather than a second implementation of it.
- [ ] **Step 3: PASS. Commit** `feat(import): phase B store re-validation with quota-aware pacing`.

---

## Task 10: Job API routes

**Files:**
- Modify: `apps/api/src/routes/dashboard/imports.ts`
- Test: `apps/api/tests/routes/imports.test.ts`

- [ ] **Step 1:** `PATCH .../imports/:id/mapping` (rejects a mapping missing a required field, 400 with the list), `POST .../imports/:id/dry-run`, `POST .../imports/:id/commit` (409 if the job is not `DRY_RUN_COMPLETE`), `POST .../imports/:id/cancel`, `GET .../imports/:id` (status + counters for polling), `GET .../imports/:id/report` (streams the report), `GET .../imports`.
- [ ] **Step 2:** Zod schemas for every body; `{ data }` / `{ error }` envelopes; capability gate on all of them; cross-tenant ids 404.
- [ ] **Step 3: Tests → implement → PASS. Commit** `feat(import): job lifecycle API`.

---

## Task 11: Dashboard migration page

**Files:**
- Create: `apps/dashboard/src/components/imports/*` and the project-scoped route
- Test: colocated component tests

- [ ] **Step 1: Failing tests.** An unmapped required field **blocks** the commit button and names the field. The dry-run summary renders each non-zero bucket with its count, and renders the Android warning with a count when `androidNoToken > 0`. Progress polls and stops polling on a terminal status. The report download link appears only once a report exists.
- [ ] **Step 2: Implement** upload → mapping table → dry-run summary → commit → progress → report. Poll; do not introduce SSE (no job-progress SSE pattern exists and this feature does not justify one). Hoist every interval, threshold and label into named constants.
- [ ] **Step 3: PASS + `nice -n 19 pnpm --filter @rovenue/dashboard build`. Commit** `feat(dashboard): migration import page`.

---

## Task 12: Docs, ROADMAP, full battery

**Files:**
- Modify: `apps/docs/content/docs/resources/migrating-from-revenuecat.mdx`, `resources/meta.json`, `ROADMAP.md`
- Create: `apps/docs/content/docs/resources/migrating-from-adapty.mdx`

- [ ] **Step 1: Extend the RevenueCat guide.** It already exists and is lean — keep its concept-mapping table and "key differences", add the procedure: export from RC, **what the export does and does not contain**, the Google-purchase-token support request and the two-pass import, mapping, dry run, verification, SDK cutover. Do not contradict its existing claims.
- [ ] **Step 2: Write the Adapty guide** and register it in `resources/meta.json`. Be explicit that Adapty's export columns are mapped by hand through the generic mapper because we did not verify its schema.
- [ ] **Step 3: State the limits on both pages** — event history, original historical prices, full renewal chains, and promotional entitlements without a store transaction do not survive any migration in either direction. Conventions: two frontmatter fields only, no top-level `#`, `Tabs`/`Steps`/`Callout` imported per page, no `Cards`/`Accordion` (unused in this corpus), and **generic angle brackets only inside code spans** — bare `<T>` in prose is parsed as JSX and breaks the prerender.
- [ ] **Step 4: ROADMAP §11** — tick the two guides and the import tool; **correct the stale claim** that the RevenueCat guide was unwritten. Leave the rest of §11 open.
- [ ] **Step 5: Full battery**, sequential and throttled, reporting real numbers: `nice -n 19 pnpm build --concurrency=2`; `nice -n 19 pnpm --filter @rovenue/shared test`; `nice -n 19 pnpm --filter @rovenue/db test`; `cd apps/api && nice -n 19 npx vitest run --maxWorkers=2`; `nice -n 19 pnpm --filter @rovenue/dashboard test`; `nice -n 19 pnpm --filter @rovenue/docs build`. Note that `pnpm --filter @rovenue/docs check:links` **already exits 1** on a pre-existing broken link unrelated to this work — report its output, do not "fix" it here, and do not let it hide a new breakage you introduced.
- [ ] **Step 6: Commit** `docs: RevenueCat and Adapty migration guides; roadmap §11 update` with the battery numbers in the body.

---

## Self-review notes (for executors)

- **Ordering is 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12.** Tasks 1-3 are pure and could in principle be parallelised, but never dispatch implementers in parallel in a shared worktree — they race the git index.
- The **dedupe key must never include the import-job id** (Task 3). If a reviewer proposes adding one "for traceability", that is a correctness regression: cite spec §4.5 rule 2.
- **Do not add a `platform` value to imported subscribers** (Task 7), even though it looks like free information. `subscribers.platform` is first-install truth from the SDK and is deliberately not purchase-derived.
- **Do not create products** to satisfy an unresolved row (Task 6). `purchases.productId` is `NOT NULL`, which makes this tempting; the correct outcome is the `unresolvedProduct` bucket.
- The **research file's unconfirmed items are load-bearing**: RC's Subscriber-feed columns, its raw-currency column, Adapty's S3 columns, and the v3/v4/v5 deltas. A task that needs one must verify first-party first. The mapper exists precisely so that being wrong here is recoverable by the operator instead of silent.
