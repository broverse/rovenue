# Docs & Developer Experience Implementation Plan (ROADMAP §11)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all six open items in ROADMAP §11 — the Google purchase-token second pass, an error-code catalog, working example apps, a self-host operator handbook, auto-generated SDK references with quickstarts, and an interactive API explorer.

**Architecture:** Six independent phases, sequenced so the only runtime-behaviour change (Phase A, which needs migration 0125) lands first and the two items with cross-dependencies land last. Every generated artifact is generated from the code that produces the behaviour it documents; where generation is impossible (response bodies), a contract test converts silent drift into a named CI failure.

**Tech Stack:** TypeScript strict, Hono, Zod 3.25.76, Drizzle, Vitest, Fumadocs (React Router v7, statically prerendered), SwiftUI, Jetpack Compose, Expo, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-06-docs-and-developer-experience-design.md`

## Global Constraints

- **Stay on the current branch.** Never create or switch branches, never create a worktree. Work happens in the worktree already checked out at `.claude/worktrees/roadmap-11-docs-dx` (branch `worktree-roadmap-11-docs-dx`).
- **No magic values.** Every threshold, path, job kind, coverage floor and preset id is a named constant declared once and imported. Structured data tables (a table of error codes, a table of required fields per job kind) are *not* magic values — those are the desired form.
- **Test runs are throttled — this machine strains.** Never run the full suite. Use `nice -n 19 npx vitest run --maxWorkers=2 <specific-file>`; builds use `--concurrency=2`; strictly sequential, never parallel.
- **Self-confirming tests prove nothing.** Do not assert against hand-built fixtures where the real producer is available. Phase A's match-outcome tests must run against rows written by an actual history import, not hand-inserted rows.
- **`*.integration.test.ts` is not an exhaustive marker for "touches Postgres."** `apps/api/tests/services/import-plan.test.ts` and `packages/db/tests/import-jobs.test.ts` also hit the real per-worker DB. Check a file's header comment before assuming it is pure.
- **Integration tests need Docker up.** `docker ps` before debugging a hang. New migrations require dropping the `rovenue_test_tpl` template DB so it is rebuilt.
- **Migrations are forward-only and expand-only.** Nullable/additive columns; no destructive change.
- **Never write a domain table and Kafka in the same code path.** Emit an `outbox_events` row in the same transaction.
- **Drizzle only** for Postgres. Raw `sql` only when truly necessary, and qualify columns (`"purchases"."id"`) — bare `${table.col}` renders unqualified and breaks correlated subqueries.
- **Conventional commits.** Commit at the end of every task.
- **Next migration number is 0125.** Phase A claims it. Verify nothing else has taken it before writing.

---

# Phase A — Google purchase-token second pass

Closes the ROADMAP item that is a backend feature, not a doc. The roadmap's own proposed fix cannot be built as written; see the spec's §1 for the three verified blockers.

### Task 1: Persist the Google purchase token

**Files:**
- Create: `packages/db/drizzle/migrations/0125_purchases_google_purchase_token.sql`
- Modify: `packages/db/src/drizzle/schema.ts` (the `purchases` table, from line 958)
- Test: `packages/db/tests/purchases-google-token.test.ts`

**Interfaces:**
- Produces: `purchases.googlePurchaseToken` (nullable `text`), Drizzle field name `googlePurchaseToken`, SQL column `googlePurchaseToken`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/purchases-google-token.test.ts
// Real Postgres (DATABASE_URL against the dev stack), matching the
// idiom in packages/db/tests/import-jobs.test.ts.
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "../src";

describe("purchases.googlePurchaseToken", () => {
  it("exists, is nullable, and is text", async () => {
    const rows = await drizzle.db.execute(sql`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'purchases'
        AND column_name = 'googlePurchaseToken'
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ data_type: "text", is_nullable: "YES" });
  });

  it("has a partial index for enrichment lookup", async () => {
    const rows = await drizzle.db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'purchases'
        AND indexname = 'purchases_google_token_enrichment_idx'
    `);
    expect(rows.rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `nice -n 19 npx vitest run --maxWorkers=2 packages/db/tests/purchases-google-token.test.ts`
Expected: FAIL — zero rows returned for both queries.

- [ ] **Step 3: Write the migration**

```sql
-- packages/db/drizzle/migrations/0125_purchases_google_purchase_token.sql
-- Google purchase-token second pass (ROADMAP §11).
--
-- The token was previously transient: normalize.ts carried it in memory,
-- handed it to Phase B's store call, and discarded it. A row imported
-- from an export with no token column was written history-only
-- (androidNoToken, verifiedAt null) with no way to ever re-verify it.
-- This column is where a later enrichment pass puts the token so Phase B
-- can pick the row up.
--
-- Nullable and additive: expand-phase only.
ALTER TABLE "purchases" ADD COLUMN IF NOT EXISTS "googlePurchaseToken" text;

-- Partial: only PLAY_STORE rows that still lack a token are enrichment
-- candidates, which is a small and shrinking slice of the table.
CREATE INDEX IF NOT EXISTS "purchases_google_token_enrichment_idx"
  ON "purchases" ("subscriberId", "productId")
  WHERE "store" = 'PLAY_STORE' AND "googlePurchaseToken" IS NULL;
```

- [ ] **Step 4: Add the column to the Drizzle schema**

In `packages/db/src/drizzle/schema.ts`, inside the `purchases` column block (near `verifiedAt`):

```ts
    // Google Play's purchaseToken for this subscription chain. Null on
    // Apple/Stripe rows and on Play rows imported before the enrichment
    // pass ran. See migration 0125.
    googlePurchaseToken: text("googlePurchaseToken"),
```

And in the index block:

```ts
    googleTokenEnrichmentIdx: index("purchases_google_token_enrichment_idx")
      .on(t.subscriberId, t.productId)
      .where(sql`${t.store} = 'PLAY_STORE' AND ${t.googlePurchaseToken} IS NULL`),
```

- [ ] **Step 5: Drop the test template DB so it rebuilds with the new migration**

Run: `docker ps` (confirm the stack is up), then:
`psql "$DATABASE_URL" -c 'DROP DATABASE IF EXISTS rovenue_test_tpl'`

- [ ] **Step 6: Run the test and confirm it passes**

Run: `nice -n 19 npx vitest run --maxWorkers=2 packages/db/tests/purchases-google-token.test.ts`
Expected: PASS, both cases.

- [ ] **Step 7: Confirm drizzle-kit sees no drift**

Run: `pnpm db:migrate:generate`
Expected: no new migration file is emitted. If one is, the hand-written DDL and the schema disagree — reconcile before committing, and trim any generated `DROP TYPE` noise (a known drizzle-kit behaviour in this repo when enums are not re-exported from `schema.ts`).

- [ ] **Step 8: Commit**

```bash
git add packages/db/drizzle/migrations/0125_purchases_google_purchase_token.sql packages/db/src/drizzle/schema.ts packages/db/tests/purchases-google-token.test.ts
git commit -m "feat(db): persist googlePurchaseToken on purchases (migration 0125)"
```

---

### Task 2: Give import jobs a kind

**Files:**
- Create: `packages/db/drizzle/migrations/0126_import_jobs_kind.sql`
- Modify: `packages/db/src/drizzle/enums.ts` (near `importJobStatus`, line 408), `packages/db/src/drizzle/schema.ts` (`importJobs`, line 3250)
- Test: `packages/db/tests/import-jobs-kind.test.ts`

**Interfaces:**
- Produces: pg enum `ImportJobKind` with values `HISTORY`, `GOOGLE_TOKEN_ENRICHMENT`; Drizzle export `importJobKind`; column `importJobs.kind` NOT NULL DEFAULT `'HISTORY'`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/import-jobs-kind.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "../src";

describe("import_jobs.kind", () => {
  it("has both kinds on the enum", async () => {
    const rows = await drizzle.db.execute(sql`
      SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'ImportJobKind'
      ORDER BY e.enumsortorder
    `);
    expect(rows.rows.map((r: any) => r.enumlabel)).toEqual([
      "HISTORY",
      "GOOGLE_TOKEN_ENRICHMENT",
    ]);
  });

  it("defaults existing rows to HISTORY and is NOT NULL", async () => {
    const rows = await drizzle.db.execute(sql`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'import_jobs' AND column_name = 'kind'
    `);
    expect(rows.rows[0]).toMatchObject({ is_nullable: "NO" });
    expect(String((rows.rows[0] as any).column_default)).toContain("HISTORY");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `nice -n 19 npx vitest run --maxWorkers=2 packages/db/tests/import-jobs-kind.test.ts`
Expected: FAIL — the type does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- packages/db/drizzle/migrations/0126_import_jobs_kind.sql
-- An enrichment import is a different operation from a history import:
-- it creates no purchases, accepts no mapping in the normal sense, and
-- has its own required-field set. Modelling it as a variant of the
-- history import is what made the revenuecat_google_token preset
-- detectable-but-unimportable. See ROADMAP §11.
DO $$ BEGIN
  CREATE TYPE "ImportJobKind" AS ENUM ('HISTORY', 'GOOGLE_TOKEN_ENRICHMENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Every existing job is a history import; the default keeps them so and
-- keeps the column NOT NULL without a rewrite pass.
ALTER TABLE "import_jobs"
  ADD COLUMN IF NOT EXISTS "kind" "ImportJobKind" NOT NULL DEFAULT 'HISTORY';
```

- [ ] **Step 4: Export the enum and add the column**

`packages/db/src/drizzle/enums.ts` — beside `importJobStatus`:

```ts
export const importJobKind = pgEnum("ImportJobKind", [
  "HISTORY",
  "GOOGLE_TOKEN_ENRICHMENT",
]);
```

Re-export it from `schema.ts` alongside the other enums — an enum that is not re-exported from `schema.ts` makes drizzle-kit emit a spurious `DROP TYPE`.

In the `importJobs` column block:

```ts
    kind: importJobKind("kind").notNull().default("HISTORY"),
```

- [ ] **Step 5: Rebuild the template DB and run the test**

Run: `psql "$DATABASE_URL" -c 'DROP DATABASE IF EXISTS rovenue_test_tpl'`
Run: `nice -n 19 npx vitest run --maxWorkers=2 packages/db/tests/import-jobs-kind.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm no drizzle-kit drift**

Run: `pnpm db:migrate:generate`
Expected: no new file.

- [ ] **Step 7: Commit**

```bash
git add packages/db/drizzle/migrations/0126_import_jobs_kind.sql packages/db/src/drizzle/enums.ts packages/db/src/drizzle/schema.ts packages/db/tests/import-jobs-kind.test.ts
git commit -m "feat(db): add ImportJobKind to import_jobs (migration 0126)"
```

---

### Task 3: Required fields become a property of the job kind

**Files:**
- Modify: `packages/shared/src/import/canonical.ts`, `packages/shared/src/import/mapping.ts`
- Test: `packages/shared/src/import/__tests__/mapping.test.ts` (extend)

**Interfaces:**
- Consumes: `ImportJobKind` values from Task 2 (as a string union in `@rovenue/shared`, not a DB import — the shared package must not depend on `@rovenue/db`).
- Produces:
  - `export type ImportJobKind = "HISTORY" | "GOOGLE_TOKEN_ENRICHMENT";`
  - `export const REQUIRED_FIELDS_BY_KIND: Record<ImportJobKind, readonly CanonicalField[]>`
  - `validateMapping(mapping, kind: ImportJobKind = "HISTORY"): MappingValidationResult` — the added parameter is optional so all existing single-argument call sites keep compiling.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/shared/src/import/__tests__/mapping.test.ts
import { validateMapping } from "../mapping";
import { REQUIRED_FIELDS_BY_KIND } from "../canonical";

describe("validateMapping — per job kind", () => {
  const googleTokenMapping = {
    user_id: "subscriberExternalId",
    google_purchase_token: "googlePurchaseToken",
    google_product_id: "productIdentifier",
  } as const;

  it("rejects the 3-column google-token mapping as a HISTORY import", () => {
    const r = validateMapping({ ...googleTokenMapping }, "HISTORY");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingRequired).toEqual(["store", "purchaseDate"]);
  });

  it("accepts the same mapping as a GOOGLE_TOKEN_ENRICHMENT import", () => {
    const r = validateMapping({ ...googleTokenMapping }, "GOOGLE_TOKEN_ENRICHMENT");
    expect(r.ok).toBe(true);
  });

  it("defaults to HISTORY when no kind is supplied", () => {
    expect(validateMapping({ ...googleTokenMapping }).ok).toBe(false);
  });

  it("requires the token for an enrichment import", () => {
    const r = validateMapping(
      { user_id: "subscriberExternalId", google_product_id: "productIdentifier" },
      "GOOGLE_TOKEN_ENRICHMENT",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingRequired).toEqual(["googlePurchaseToken"]);
  });

  it("declares a required-field set for every kind", () => {
    // Guards the failure mode where a new kind silently inherits the
    // wrong set: Record<ImportJobKind, ...> makes omission a compile
    // error, and this asserts none is empty.
    for (const [kind, fields] of Object.entries(REQUIRED_FIELDS_BY_KIND)) {
      expect(fields.length, `${kind} has no required fields`).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `nice -n 19 npx vitest run --maxWorkers=2 packages/shared/src/import/__tests__/mapping.test.ts`
Expected: FAIL — `REQUIRED_FIELDS_BY_KIND` is not exported; `validateMapping` takes one argument.

- [ ] **Step 3: Add the kind-keyed table**

In `packages/shared/src/import/canonical.ts`, after `CANONICAL_FIELDS`:

```ts
/**
 * An import job's kind decides which canonical fields it must have.
 *
 * A history import creates purchases, so it needs enough to describe
 * one. An enrichment import creates nothing — it patches a token onto
 * rows a previous import already wrote — so demanding `store` and
 * `purchaseDate` of it is demanding data its source file cannot
 * contain. That mismatch is the whole reason the
 * `revenuecat_google_token` preset was detectable but never importable.
 *
 * Keyed by kind rather than derived from a `required` flag so that
 * adding a kind without declaring its required fields is a compile
 * error, not a silent inheritance of the wrong set.
 */
export type ImportJobKind = "HISTORY" | "GOOGLE_TOKEN_ENRICHMENT";

export const HISTORY_REQUIRED_FIELDS = CANONICAL_FIELDS.filter((f) => f.required).map(
  (f) => f.key,
) as readonly CanonicalField[];

export const GOOGLE_TOKEN_ENRICHMENT_REQUIRED_FIELDS = [
  "subscriberExternalId",
  "productIdentifier",
  "googlePurchaseToken",
] as const satisfies readonly CanonicalField[];

export const REQUIRED_FIELDS_BY_KIND: Record<ImportJobKind, readonly CanonicalField[]> = {
  HISTORY: HISTORY_REQUIRED_FIELDS,
  GOOGLE_TOKEN_ENRICHMENT: GOOGLE_TOKEN_ENRICHMENT_REQUIRED_FIELDS,
};
```

- [ ] **Step 4: Take the kind in `validateMapping`**

Replace the `missingRequired` computation in `packages/shared/src/import/mapping.ts`:

```ts
export function validateMapping(
  mapping: Record<string, CanonicalField>,
  kind: ImportJobKind = "HISTORY",
): MappingValidationResult {
  const mappedFields = Object.values(mapping);
  const mappedFieldSet = new Set(mappedFields);

  const missingRequired = REQUIRED_FIELDS_BY_KIND[kind].filter(
    (key) => !mappedFieldSet.has(key),
  );
  // ...duplicate-target check unchanged...
```

Import `REQUIRED_FIELDS_BY_KIND` and `ImportJobKind` from `./canonical`.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `nice -n 19 npx vitest run --maxWorkers=2 packages/shared/src/import/__tests__/mapping.test.ts`
Expected: PASS, all five cases.

- [ ] **Step 6: Confirm no existing caller broke**

Run: `nice -n 19 npx vitest run --maxWorkers=2 packages/shared/src/import`
Expected: PASS. Then `pnpm --filter @rovenue/shared typecheck` (or `npx tsc --noEmit -p packages/shared`) — expected clean, proving the default parameter preserved every existing call site.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/import/canonical.ts packages/shared/src/import/mapping.ts packages/shared/src/import/__tests__/mapping.test.ts
git commit -m "feat(shared): key import required-fields on job kind"
```

---

### Task 4: Parse an enrichment row without faking history fields

**Files:**
- Create: `packages/shared/src/import/normalize-enrichment.ts`
- Modify: `packages/shared/src/import/index.ts` (barrel export)
- Test: `packages/shared/src/import/__tests__/normalize-enrichment.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type EnrichmentRow = {
    subscriberExternalId: string;
    productIdentifier: string;
    googlePurchaseToken: string;
  };
  export type EnrichmentRowError = { code: "MISSING_REQUIRED_FIELD"; field: string };
  export function normalizeEnrichmentRow(
    raw: Record<string, string | undefined>,
  ): { ok: true; row: EnrichmentRow } | { ok: false; error: EnrichmentRowError };
  ```

**Why a separate function:** `normalizeRow` (`normalize.ts:359`) independently hard-requires `store` and `purchaseDate` and is the shared gate for `plan.ts`, `write.ts` and `verify.ts`. It is correct for history rows and must not be weakened. Synthesizing fake `store`/`purchaseDate` values to satisfy it would put fabricated data one refactor away from the history writer.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/import/__tests__/normalize-enrichment.test.ts
import { describe, it, expect } from "vitest";
import { normalizeEnrichmentRow } from "../normalize-enrichment";

describe("normalizeEnrichmentRow", () => {
  const valid = {
    subscriberExternalId: "user-1",
    productIdentifier: "com.acme.pro_monthly",
    googlePurchaseToken: "tok_abc",
  };

  it("accepts a complete row", () => {
    const r = normalizeEnrichmentRow(valid);
    expect(r).toEqual({ ok: true, row: valid });
  });

  it("trims surrounding whitespace", () => {
    const r = normalizeEnrichmentRow({ ...valid, googlePurchaseToken: "  tok_abc  " });
    expect(r.ok && r.row.googlePurchaseToken).toBe("tok_abc");
  });

  it.each(["subscriberExternalId", "productIdentifier", "googlePurchaseToken"])(
    "rejects a row missing %s",
    (field) => {
      const r = normalizeEnrichmentRow({ ...valid, [field]: undefined });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toEqual({ code: "MISSING_REQUIRED_FIELD", field });
    },
  );

  it("rejects a whitespace-only value as missing", () => {
    const r = normalizeEnrichmentRow({ ...valid, googlePurchaseToken: "   " });
    expect(r.ok).toBe(false);
  });

  it("never invents store or purchaseDate", () => {
    const r = normalizeEnrichmentRow(valid);
    expect(Object.keys(r.ok ? r.row : {})).toEqual([
      "subscriberExternalId",
      "productIdentifier",
      "googlePurchaseToken",
    ]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `nice -n 19 npx vitest run --maxWorkers=2 packages/shared/src/import/__tests__/normalize-enrichment.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/shared/src/import/normalize-enrichment.ts
// Row gate for GOOGLE_TOKEN_ENRICHMENT imports.
//
// Deliberately NOT a branch inside normalizeRow: that function is the
// history gate, its store/purchaseDate requirements are correct there,
// and it is shared by plan.ts, write.ts and verify.ts. An enrichment row
// legitimately has neither field, and synthesizing placeholder values to
// squeeze it through the history gate would put fabricated data one
// refactor away from the purchase writer.
import { GOOGLE_TOKEN_ENRICHMENT_REQUIRED_FIELDS } from "./canonical";

export type EnrichmentRow = {
  subscriberExternalId: string;
  productIdentifier: string;
  googlePurchaseToken: string;
};

export type EnrichmentRowError = { code: "MISSING_REQUIRED_FIELD"; field: string };

export function normalizeEnrichmentRow(
  raw: Record<string, string | undefined>,
): { ok: true; row: EnrichmentRow } | { ok: false; error: EnrichmentRowError } {
  const out: Record<string, string> = {};
  for (const field of GOOGLE_TOKEN_ENRICHMENT_REQUIRED_FIELDS) {
    const value = raw[field]?.trim();
    if (!value) {
      return { ok: false, error: { code: "MISSING_REQUIRED_FIELD", field } };
    }
    out[field] = value;
  }
  return { ok: true, row: out as EnrichmentRow };
}
```

- [ ] **Step 4: Export from the barrel**

Add to `packages/shared/src/import/index.ts`:

```ts
export * from "./normalize-enrichment";
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `nice -n 19 npx vitest run --maxWorkers=2 packages/shared/src/import/__tests__/normalize-enrichment.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/import/normalize-enrichment.ts packages/shared/src/import/index.ts packages/shared/src/import/__tests__/normalize-enrichment.test.ts
git commit -m "feat(shared): add enrichment row gate that never fakes history fields"
```

---

### Task 5: Resolve an enrichment row to a subscription chain, failing closed

**Files:**
- Create: `apps/api/src/services/import/enrich.ts`
- Modify: `packages/db/src/drizzle/repositories/purchases.ts`
- Test: `apps/api/tests/services/import-enrich.integration.test.ts`

**Interfaces:**
- Consumes: `normalizeEnrichmentRow`, `EnrichmentRow` (Task 4); `purchases.googlePurchaseToken` (Task 1).
- Produces:
  ```ts
  export const ENRICHMENT_OUTCOMES = [
    "enriched", "alreadyEnriched", "noMatch", "ambiguousMatch", "invalidRow",
  ] as const;
  export type EnrichmentOutcome = (typeof ENRICHMENT_OUTCOMES)[number];

  export async function resolveEnrichmentTarget(args: {
    db: Db; projectId: string; row: EnrichmentRow;
  }): Promise<
    | { outcome: "enriched"; purchaseIds: string[] }
    | { outcome: "alreadyEnriched"; purchaseIds: string[] }
    | { outcome: "noMatch" }
    | { outcome: "ambiguousMatch"; chainCount: number }
  >;
  ```
  Repository addition: `findPlayStorePurchasesBySubscriberAndProduct(db, { projectId, subscriberId, productId }): Promise<PurchaseRow[]>`.

**The matching rule** (from the spec — `(subscriberId, productId)` is *not* unique, so this must be explicit): group candidate rows by `originalTransactionId`. Exactly one chain → enrich every row in it, because a Play `purchaseToken` identifies a subscription across its renewals. More than one chain → `ambiguousMatch`, reported and not written, mirroring `plan.ts`'s existing ambiguous-product rule. No rows → `noMatch`. All rows already carrying a token → `alreadyEnriched` (idempotent re-run).

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/tests/services/import-enrich.integration.test.ts
// Real per-worker Postgres (tests/global-setup.ts).
//
// Every fixture below is written by the REAL history-import writer, not
// hand-inserted: a hand-built row would let this test pass while the
// actual writer produces a shape the resolver cannot match.
import { describe, it, expect, beforeEach } from "vitest";
import { drizzle } from "@rovenue/db";
import { resolveEnrichmentTarget } from "../../src/services/import/enrich";
import { seedHistoryImport } from "../helpers/seed-history-import";

describe("resolveEnrichmentTarget", () => {
  let projectId: string;
  beforeEach(async () => { ({ projectId } = await seedHistoryImport.freshProject()); });

  it("enriches every row of a single subscription chain", async () => {
    // Two renewal rows sharing one originalTransactionId.
    const { subscriberExternalId, productIdentifier } = await seedHistoryImport.playChain({
      projectId, renewals: 2, withToken: false,
    });
    const r = await resolveEnrichmentTarget({
      db: drizzle.db, projectId,
      row: { subscriberExternalId, productIdentifier, googlePurchaseToken: "tok_1" },
    });
    expect(r.outcome).toBe("enriched");
    if (r.outcome === "enriched") expect(r.purchaseIds).toHaveLength(2);
  });

  it("fails closed when the pair spans two chains", async () => {
    const { subscriberExternalId, productIdentifier } = await seedHistoryImport.playChain({
      projectId, renewals: 1, withToken: false,
    });
    await seedHistoryImport.additionalChain({ projectId, subscriberExternalId, productIdentifier });
    const r = await resolveEnrichmentTarget({
      db: drizzle.db, projectId,
      row: { subscriberExternalId, productIdentifier, googlePurchaseToken: "tok_1" },
    });
    expect(r.outcome).toBe("ambiguousMatch");
    if (r.outcome === "ambiguousMatch") expect(r.chainCount).toBe(2);
  });

  it("reports noMatch when no history row exists", async () => {
    const r = await resolveEnrichmentTarget({
      db: drizzle.db, projectId,
      row: { subscriberExternalId: "ghost", productIdentifier: "nope", googlePurchaseToken: "t" },
    });
    expect(r.outcome).toBe("noMatch");
  });

  it("reports alreadyEnriched for a chain that has the token", async () => {
    const { subscriberExternalId, productIdentifier } = await seedHistoryImport.playChain({
      projectId, renewals: 1, withToken: true,
    });
    const r = await resolveEnrichmentTarget({
      db: drizzle.db, projectId,
      row: { subscriberExternalId, productIdentifier, googlePurchaseToken: "tok_1" },
    });
    expect(r.outcome).toBe("alreadyEnriched");
  });

  it("never matches a non-Play row", async () => {
    const { subscriberExternalId, productIdentifier } = await seedHistoryImport.appleChain({ projectId });
    const r = await resolveEnrichmentTarget({
      db: drizzle.db, projectId,
      row: { subscriberExternalId, productIdentifier, googlePurchaseToken: "tok_1" },
    });
    expect(r.outcome).toBe("noMatch");
  });
});
```

- [ ] **Step 2: Write the fixture helper**

Create `apps/api/tests/helpers/seed-history-import.ts` exposing `freshProject()`, `playChain({projectId, renewals, withToken})`, `additionalChain(...)` and `appleChain({projectId})`. Each **must drive the real history-import writer** (`apps/api/src/services/import/write.ts`) with a generated CSV rather than inserting purchase rows directly — that is what makes these tests non-self-confirming. Return the external id and product identifier it used.

- [ ] **Step 3: Run and confirm it fails**

Run: `docker ps` then
`nice -n 19 npx vitest run --maxWorkers=2 apps/api/tests/services/import-enrich.integration.test.ts`
Expected: FAIL — `enrich.ts` not found.

- [ ] **Step 4: Add the repository lookup**

In `packages/db/src/drizzle/repositories/purchases.ts`:

```ts
/**
 * PLAY_STORE purchase rows for one (subscriber, product) pair.
 *
 * NOT a unique key — a subscriber holds one row per renewal, and may
 * hold several distinct subscription chains for the same product over
 * time. Callers must group by originalTransactionId and decide; this
 * function deliberately returns all of them rather than picking.
 */
export async function findPlayStorePurchasesBySubscriberAndProduct(
  db: Db,
  args: { projectId: string; subscriberId: string; productId: string },
) {
  return db
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.projectId, args.projectId),
        eq(purchases.subscriberId, args.subscriberId),
        eq(purchases.productId, args.productId),
        eq(purchases.store, "PLAY_STORE"),
      ),
    );
}
```

- [ ] **Step 5: Implement the resolver**

`apps/api/src/services/import/enrich.ts` — resolve `subscriberExternalId` via the existing `resolveSubscriberByRovenueIdOrLegacy`, resolve `productIdentifier` via the existing project-scoped product lookup (reusing `plan.ts`'s `resolveProduct` semantics, including its ambiguous-match-fails-closed behaviour), then apply the grouping rule above. Return `noMatch` when either resolution fails.

- [ ] **Step 6: Run and confirm it passes**

Run: `nice -n 19 npx vitest run --maxWorkers=2 apps/api/tests/services/import-enrich.integration.test.ts`
Expected: PASS, all five cases.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/import/enrich.ts packages/db/src/drizzle/repositories/purchases.ts apps/api/tests/services/import-enrich.integration.test.ts apps/api/tests/helpers/seed-history-import.ts
git commit -m "feat(api): resolve google-token enrichment rows to a chain, failing closed"
```

---

### Task 6: Wire the enrichment job end to end

**Files:**
- Modify: `apps/api/src/routes/dashboard/imports.ts`, `apps/api/src/services/import/report.ts`, `apps/api/src/workers/` (import runner), `apps/dashboard/src/components/imports/job-detail.tsx`, `apps/dashboard/src/components/imports/mapping-editor.tsx`
- Modify: `apps/docs/content/docs/resources/migrating-from-revenuecat.mdx`, `ROADMAP.md`
- Test: `apps/api/tests/routes/imports-enrichment.test.ts`, `apps/api/tests/workers/import-enrichment-runner.integration.test.ts`

- [ ] **Step 1: Write the failing route test**

Assert that `POST /` with a header matching the `revenuecat_google_token` preset creates a job with `kind: "GOOGLE_TOKEN_ENRICHMENT"`; that `PATCH /:id/mapping` **accepts** the 3-column mapping on that job (the exact call that 400s today); and that the same mapping on a `HISTORY` job still 400s with `missingRequired: ["store","purchaseDate"]`.

- [ ] **Step 2: Run and confirm it fails**

Run: `nice -n 19 npx vitest run --maxWorkers=2 apps/api/tests/routes/imports-enrichment.test.ts`

- [ ] **Step 3: Set the kind on upload and honour it in validation**

In `imports.ts`: when `detectPreset` returns `REVENUECAT_GOOGLE_TOKEN_PRESET_ID`, persist `kind: "GOOGLE_TOKEN_ENRICHMENT"`. Pass `job.kind` into both `validateMapping` call sites (`PATCH /:id/mapping` around line 676 and `POST /:id/dry-run` around line 771).

- [ ] **Step 4: Add the enrichment outcomes to the report**

Extend `IMPORT_OUTCOMES` in `report.ts` with the enrichment outcomes from Task 5, keeping the existing history outcomes untouched. The counters are a closed set — a new outcome that is not added here is silently uncounted.

- [ ] **Step 5: Branch the runner**

In the import worker, dispatch on `job.kind`: `HISTORY` keeps the existing two-phase path unchanged; `GOOGLE_TOKEN_ENRICHMENT` runs a dry-run pass that classifies every row via `resolveEnrichmentTarget` without writing, and a commit pass that applies `googlePurchaseToken` to the resolved rows in a transaction and emits the audit entry. After a successful commit, mark the enriched chains eligible for Phase-B verification.

- [ ] **Step 6: Write the failing idempotency test, then make it pass**

```ts
it("is idempotent — re-running the same file writes nothing", async () => {
  const first = await runEnrichmentJob(/* ... */);
  expect(first.counters.enriched).toBeGreaterThan(0);
  const second = await runEnrichmentJob(/* same file */);
  expect(second.counters.enriched).toBe(0);
  expect(second.counters.alreadyEnriched).toBe(first.counters.enriched);
});
```

Run: `nice -n 19 npx vitest run --maxWorkers=2 apps/api/tests/workers/import-enrichment-runner.integration.test.ts`

- [ ] **Step 7: Dashboard — do not offer a mapping UI that cannot apply**

`mapping-editor.tsx` renders one row per `CANONICAL_FIELDS` unconditionally and marks required fields from the global set. Pass the job's kind through so it renders only that kind's fields and validates with the same kind the server uses. `job-detail.tsx` labels an enrichment job as a second pass and explains that it patches existing purchases rather than creating any.

- [ ] **Step 8: Correct the documentation**

`migrating-from-revenuecat.mdx` currently says the two-pass Google token import is *not yet available* (corrected to that on 2026-09-01). Replace with the real procedure. State plainly that rows whose subscriber+product spans more than one subscription chain are reported and skipped rather than guessed at.

- [ ] **Step 9: Tick the ROADMAP item**

In `ROADMAP.md` §11 (line ~993), check the Google purchase-token box and replace the follow-up note with what shipped — including that the roadmap's own proposed lookup was not buildable as written and why.

- [ ] **Step 10: Run the whole import surface**

Run: `nice -n 19 npx vitest run --maxWorkers=2 packages/shared/src/import apps/api/tests/routes/imports.test.ts apps/api/tests/routes/imports-enrichment.test.ts apps/api/tests/services apps/api/tests/workers`
Expected: PASS, no regression in the existing history tests.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(api): google purchase-token second pass, end to end"
```

---

# Phase B — Error-code catalog

### Task 7: A documentation table that cannot drift from `ERROR_CODE`

**Files:**
- Create: `packages/shared/src/error-catalog.ts`
- Modify: `packages/shared/src/index.ts` (export it)
- Test: `packages/shared/src/__tests__/error-catalog.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ErrorCatalogEntry = {
    /** The WIRE value, not the key. Five codes differ. */
    code: ErrorCode;
    httpStatus: number;
    summary: string;
    resolution: string;
  };
  export const ERROR_CATALOG: Record<keyof typeof ERROR_CODE, ErrorCatalogEntry>;
  ```

**The trap this guards:** 42 codes, and five have a key that differs from the wire value — `APPLE_OFFER_SIGNING_UNAVAILABLE`, `APPLE_OFFER_SIGNING_FAILED`, `ASSET_IN_USE`, `ASSET_MISSING`, `PURCHASE_NOT_PAID` are all lowercase on the wire. A catalog built from `Object.keys` publishes five strings no client can match.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/__tests__/error-catalog.test.ts
import { describe, it, expect } from "vitest";
import { ERROR_CODE } from "../index";
import { ERROR_CATALOG } from "../error-catalog";

describe("ERROR_CATALOG", () => {
  it("documents every code exactly once", () => {
    expect(Object.keys(ERROR_CATALOG).sort()).toEqual(Object.keys(ERROR_CODE).sort());
  });

  it("documents each code by its WIRE value, not its key", () => {
    for (const [key, entry] of Object.entries(ERROR_CATALOG)) {
      expect(entry.code, `${key} documented by key instead of value`).toBe(
        ERROR_CODE[key as keyof typeof ERROR_CODE],
      );
    }
  });

  it("covers the five codes whose key and value diverge", () => {
    const divergent = Object.entries(ERROR_CODE).filter(([k, v]) => k !== v);
    expect(divergent).toHaveLength(5);
    for (const [key, value] of divergent) {
      expect(ERROR_CATALOG[key as keyof typeof ERROR_CODE].code).toBe(value);
    }
  });

  it("has real prose for every entry", () => {
    for (const [key, entry] of Object.entries(ERROR_CATALOG)) {
      expect(entry.summary.length, `${key} summary too short`).toBeGreaterThan(20);
      expect(entry.resolution.length, `${key} resolution too short`).toBeGreaterThan(20);
      expect(entry.httpStatus).toBeGreaterThanOrEqual(400);
    }
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `nice -n 19 npx vitest run --maxWorkers=2 packages/shared/src/__tests__/error-catalog.test.ts`

- [ ] **Step 3: Write the catalog**

`Record<keyof typeof ERROR_CODE, ErrorCatalogEntry>` makes omission a compile error. Write real prose for all 42 — only 9 currently carry an explanatory comment, so 33 need it written. Cross-check each `httpStatus` against the throw site rather than guessing.

- [ ] **Step 4: Run and confirm it passes**

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/error-catalog.ts packages/shared/src/index.ts packages/shared/src/__tests__/error-catalog.test.ts
git commit -m "feat(shared): exhaustive API error-code catalog keyed on wire values"
```

---

### Task 8: Render the catalog into the docs site

**Files:**
- Create: `apps/docs/scripts/generate-error-catalog.mjs`, `apps/docs/content/docs/reference/api-errors.mdx` (generated)
- Modify: `apps/docs/content/docs/reference/meta.json`, `apps/docs/content/docs/reference/errors.mdx` (cross-link), `apps/docs/package.json`

- [ ] **Step 1: Write the generator** — reads `ERROR_CATALOG`, emits a table of wire value / HTTP status / meaning / what to do, with a banner marking the file generated and naming its source.
- [ ] **Step 2: Add `"generate:errors"` to `apps/docs/package.json` and call it from the docs `build` script** so the page cannot be stale in a built image.
- [ ] **Step 3: Add `api-errors` to `reference/meta.json`** after `errors`.
- [ ] **Step 4: Cross-link.** `errors.mdx` documents *SDK* `RovenueError` kinds; the new page documents the *API* envelope. Add a line to each pointing at the other. Do not merge them — different audiences.
- [ ] **Step 5: Verify** — run the generator, then `pnpm --filter @rovenue/docs check:links`. Expected: page generated, all links resolve.
- [ ] **Step 6: Commit**

```bash
git add apps/docs
git commit -m "docs: generate the API error-code catalog page"
```

---

### Task 9: Tick the ROADMAP error-code item

- [ ] **Step 1:** Check the box in `ROADMAP.md` §11 and record what shipped, including the key-vs-wire-value hazard and the compile-time exhaustiveness guard.
- [ ] **Step 2: Commit** — `docs(roadmap): tick §11 error-code catalog`

---

# Phase C — Working example apps

### Task 10: `examples/ios-swift`

**Files:** Create `examples/ios-swift/` — an Xcode project consuming `packages/sdk-swift` by local SwiftPM path. No `package.json` (deliberately outside the pnpm workspace, which globs `examples/*`).

- [ ] **Step 1:** Scaffold a SwiftUI app targeting iOS 16.0 — the floor the `Rovenue` pod requires (`packages/sdk-swift/release.config.json`); a lower target fails to resolve.
- [ ] **Step 2:** Implement the shared demonstrated flow: configure → identify → offerings → paywall (`RovenuePaywallView`) → purchase → entitlement reaction → restore, with an on-screen event log. Mirror `packages/sdk-flutter/example/lib/main.dart`, which already demonstrates exactly this.
- [ ] **Step 3:** Do **not** re-fetch inside the change listener — `refreshX()` inside the `XCHANGED` handler emits the event again and loops. The Flutter example refreshes on change deliberately and safely; follow the RN example's log-only pattern unless the same guard is in place.
- [ ] **Step 4:** Write a README covering base-URL configuration for simulator vs device and the ATS local-networking exception.
- [ ] **Step 5: Verify it builds** — `xcodebuild -scheme RovenueExample -destination 'generic/platform=iOS Simulator' build`
- [ ] **Step 6: Commit** — `feat(examples): add a native SwiftUI example app`

---

### Task 11: `examples/android-kotlin`

**Files:** Create `examples/android-kotlin/` — Gradle project consuming `packages/sdk-kotlin` via `includeBuild`, matching how `examples/sample-rn-expo`'s config plugin already wires it.

- [ ] **Step 1:** Scaffold a Compose app, JDK 17.
- [ ] **Step 2:** Implement the same flow as Task 10.
- [ ] **Step 3:** Verify — `./gradlew assembleDebug`
- [ ] **Step 4: Commit** — `feat(examples): add a native Compose example app`

---

### Task 12: Bring `examples/sample-rn-expo` up to the shared flow

- [ ] **Step 1:** It already demonstrates identify/logOut, offerings, purchase, restore, entitlements and credits. Add the paywall step so all four apps teach one flow.
- [ ] **Step 2:** Keep the documented `ExpoModulesCore` hoisting hazard in the README — it is live, and the workaround is required before `pod install`.
- [ ] **Step 3: Commit** — `feat(examples): align the RN example with the shared demo flow`

---

### Task 13: Compile every example in CI

**Files:** Modify `.github/workflows/sdk.yml`

`sdk.yml` already runs `macos-14` jobs and already builds the Flutter example's APK, so this is precedent, not new infrastructure.

- [ ] **Step 1:** Add `example-ios` (macos-14) → `xcodebuild build` for the simulator.
- [ ] **Step 2:** Add `example-android` (ubuntu) → `./gradlew assembleDebug`.
- [ ] **Step 3:** Add `example-rn` (ubuntu) → typecheck + Metro bundle. Do **not** attempt an iOS prebuild: the `ExpoModulesCore` hoisting bug makes it un-greenable, and a job that skips is worse than an honest limit. State the limit in the workflow comment and the README.
- [ ] **Step 4:** Add the example paths to the workflow's `paths:` trigger.
- [ ] **Step 5: Verify** — confirm each job's command runs locally first; a CI job whose command was never executed locally is the exact failure mode that shipped a simulator slice labelled as a device slice.
- [ ] **Step 6: Commit** — `ci: compile every example app`

---

### Task 14: Tick the ROADMAP example-apps item

- [ ] **Step 1:** Check the box, and record that the Flutter example already existed and was already CI-built — the item was partly done before it was written.
- [ ] **Step 2: Commit**

---

# Phase D — Self-host operator handbook

### Task 15: Root `README.md`

There is no root README. For an AGPL self-hosted product this is the highest-leverage missing document in the repository.

- [ ] **Step 1:** Write it: what Rovenue is, the RevenueCat/Adapty framing, a 5-minute self-host quickstart, links to `apps/docs`, and a pointer to the operator handbook.
- [ ] **Step 2:** Execute every command in it once against the local stack; fix anything that does not work verbatim.
- [ ] **Step 3: Commit** — `docs: add a root README`

---

### Task 16: The operator handbook

**Files:** Create `docs/operations/handbook.md`, plus focused runbooks under `docs/runbooks/`.

Cover only the verified gaps — backup/restore and upgrade/rollback are already well covered and get linked, not restated.

- [ ] **Step 1: Scaling.** Reconcile the English content with `deployment-rehberi.md` §11, which is currently the *only* place `API_REPLICAS` is documented. Carry over the load-bearing constraint verbatim: `dispatcher` and `digest-scheduler` must never exceed one replica.
- [ ] **Step 2: Monitoring and alerting.** Document what already ships and is undiscoverable: `deploy/prometheus/rules/slo.yml`'s multi-window burn-rate alerts against a 99.9% availability and 99%-under-500ms latency SLO, the correctness alerts on the access-drift circuit breaker, `deploy/grafana`'s provisioned RED dashboard, the Alloy scrape targets, and the seven metrics the API registers. **State plainly that no Alertmanager is wired into `docker-compose.yml`, so alerts labelled `page` reach nobody until the operator adds one.**
- [ ] **Step 3: Capacity planning** for ClickHouse and Kafka/Redpanda — retention sizing, partition counts, the compose resource limits already set.
- [ ] **Step 4: pg_partman partition maintenance** as a real runbook, including how to verify maintenance actually completed. This has previously never once completed successfully, so the verification query matters more than the description.
- [ ] **Step 5: Connection pooling** — pool sizing against `API_REPLICAS`, `max_connections`.
- [ ] **Step 6: Disaster recovery** — RPO/RTO derived from the operator's chosen backup cadence, stated as arithmetic. `backup-restore.md` explicitly declines to implement retention, so do not invent a guarantee.
- [ ] **Step 7: Secret and key rotation** — the runbook two other docs already refer to and which does not exist. `ENCRYPTION_KEY` rotation must reference the fingerprint-match hazard in `backup-restore.md`.
- [ ] **Step 8: Verify.** Execute every command against the local stack and record real output. Cross-check every metric, alert and service name against the file that defines it. Label anything not executed.
- [ ] **Step 9: Commit** — `docs(ops): add the self-host operator handbook`

---

### Task 17: Alerting delivery gap — record it honestly

- [ ] **Step 1:** Open a ROADMAP entry (§10, production maturity) for wiring Alertmanager. Do **not** fix it inside this docs batch — it is a deployment change with its own verification burden.
- [ ] **Step 2: Commit**

---

### Task 18: Tick the ROADMAP operator-handbook item

- [ ] **Step 1:** Check the box; record what was already covered versus newly written.
- [ ] **Step 2: Commit**

---

# Phase E — SDK quickstarts + generated API reference

### Task 19: Measure and freeze the doc-coverage floor

**Files:** Create `scripts/sdk-doc-coverage.mjs`, `scripts/sdk-doc-coverage.json`

Measured starting density: `core-rs` ~39%, `sdk-swift` ~25%, `sdk-rn` ~22%, `sdk-flutter` ~15%, `sdk-kotlin` ~8%. Generators over API documented this thinly produce hollow references that *look* complete — which is worse than the hand-written `reference/methods.mdx` that exists today.

- [ ] **Step 1:** Write a script measuring documented public symbols per SDK.
- [ ] **Step 2:** Record each SDK's current value as its floor in `sdk-doc-coverage.json` — a ratchet, so density can never regress.
- [ ] **Step 3:** Add `#![warn(missing_docs)]` to `packages/core-rs/src/lib.rs`.
- [ ] **Step 4: Verify** — the script reports the five values above; lowering a floor by hand and re-running fails.
- [ ] **Step 5: Commit** — `chore(sdk): add a documentation-coverage ratchet`

---

### Task 20: Document the public surface to 100%

Prioritise the ~46 public methods each façade exposes (the number the Flutter parity work established) before any internal type.

- [ ] **Step 1:** `packages/core-rs` — rustdoc every public item; `cargo doc` must emit no `missing_docs` warning.
- [ ] **Step 2:** `packages/sdk-swift` — doc-comment every public declaration.
- [ ] **Step 3:** `packages/sdk-kotlin` — KDoc every public declaration (the largest gap at ~8%).
- [ ] **Step 4:** `packages/sdk-rn` — TSDoc every export.
- [ ] **Step 5:** `packages/sdk-flutter` — dartdoc every public member.
- [ ] **Step 6:** Raise every floor in `sdk-doc-coverage.json` to the achieved value.
- [ ] **Step 7:** Commit per SDK — `docs(sdk-<name>): document the public API surface`

---

### Task 21: Generate each SDK's reference

**Files:** Create `scripts/generate-sdk-docs.sh`; modify each SDK's build config.

- [ ] **Step 1:** rustdoc → `cargo doc --no-deps -p librovenue`
- [ ] **Step 2:** DocC → add a `.docc` catalog and build an archive (macOS only).
- [ ] **Step 3:** Dokka → add the plugin to `build.gradle.kts`, emit HTML.
- [ ] **Step 4:** TypeDoc → add the dep and a config, emit HTML.
- [ ] **Step 5:** dartdoc → emit HTML.
- [ ] **Step 6:** Add root script `docs:sdk-ref` generating whatever toolchains the local machine has.
- [ ] **Step 7: Verify each generator produces non-empty output.** A silently-empty archive is exactly the failure mode that shipped a simulator slice labelled as a device slice — assert file counts, not exit codes.
- [ ] **Step 8: Commit** — `feat(docs): generate per-SDK API references`

---

### Task 22: Serve the references from the docs site

**Files:** Create `.github/workflows/sdk-docs.yml`; modify `apps/docs/Dockerfile`, and add the hub page `apps/docs/content/docs/reference/sdk-reference.mdx`.

Generating inside the docs image is impossible — DocC needs macOS and the image is Linux. So generation and serving are separated, and the served result is the chosen outcome: one domain, `docs.rovenue.app/api/<sdk>/`, no `gh-pages` branch.

- [ ] **Step 1:** CI matrix generates each SDK's docs on the runner that can build it (`macos-14` for DocC, JDK for Dokka, cargo, node, Flutter) and uploads each as an artifact.
- [ ] **Step 2:** The docs image build downloads those artifacts into `apps/docs/public/api/<sdk>/` before `react-router build`.
- [ ] **Step 3:** **The docs image build fails if an expected artifact is missing** — never serve a 404 under `/api/<sdk>/`.
- [ ] **Step 4:** Hub page renders a card per SDK, linking the generated site when present and stating plainly that it was not generated locally when absent. Never a dead link.
- [ ] **Step 5: Commit** — `feat(docs): serve generated SDK references under /api/<sdk>/`

---

### Task 23: A quickstart per SDK

**Files:** Modify the five pages under `apps/docs/content/docs/platforms/`.

- [ ] **Step 1:** Each quickstart ends at a working purchase.
- [ ] **Step 2:** **Each is the flow the corresponding example app from Phase C compiles**, so the quickstart and the example cannot disagree.
- [ ] **Step 3:** Avoid bare `{{var}}` in MDX — it breaks the prerender.
- [ ] **Step 4: Verify** — `pnpm --filter @rovenue/docs build` and `check:links`.
- [ ] **Step 5: Commit** — `docs: add a quickstart per SDK`

---

### Task 24: Tick the ROADMAP SDK-reference item

- [ ] **Step 1:** Check the box; record that the doc-comment pass was the larger half and that coverage is now ratcheted in CI.
- [ ] **Step 2: Commit**

---

# Phase F — Interactive API explorer

### Task 25: Two source fixes the generator needs

**Files:** Modify `apps/api/src/lib/validate.ts`, `apps/api/src/middleware/api-key-auth.ts`, `apps/api/src/routes/v1/events.ts`, `apps/api/src/routes/v1/sdk-sessions.ts`

Both are corrections in their own right, not scaffolding.

- [ ] **Step 1: Write the failing test** asserting that a `validate("json", schema)` middleware carries a recoverable `{ target, schema }` tag, and that `events.ts` and `sdk-sessions.ts` use the *same* `requirePublicApiKey` function object.
- [ ] **Step 2: Run and confirm it fails.**
- [ ] **Step 3: Tag the validator.** Attach a symbol-keyed `{ target, schema }` property to the middleware `zValidator` returns. **Verified working:** the tag survives into `app.routes` with the zod schema intact. Leave the generic signature alone — widening `Target` to the bare union erases Hono's per-target metadata and breaks the typed `hc` client.
- [ ] **Step 4: Promote `requirePublicApiKey`** to a shared export in `middleware/api-key-auth.ts` beside `requireSecretKey`, and import it in both route files. Two independently-declared copies of one security predicate is a latent inconsistency regardless of documentation.
- [ ] **Step 5: Run and confirm it passes**, plus the existing `apps/api/tests/routes` suite for regressions.
- [ ] **Step 6: Commit** — `refactor(api): make request schemas and public-key gating introspectable`

---

### Task 26: Walk the routes and emit OpenAPI 3.1

**Files:** Create `apps/api/scripts/generate-openapi.ts`, `apps/api/openapi/responses.ts`; add `zod-to-json-schema` (zod 3 is installed, so this, not zod 4's native export).

**Verified feasible:** `app.ts` imports in ~3.1s with no live infra; `app.routes` yields 641 entries shaped `{basePath, path, method, handler}`, 139 under `/v1`.

- [ ] **Step 1:** Boot the app with `NODE_ENV` left at `development` and walk `app.routes`.
- [ ] **Step 2: De-duplicate the double mount.** `v1Route` is mounted at both `/v1` and `/v1/web/:publicKey`. Document the browser surface as the CORS-restricted variant it is, not as duplicate endpoints.
- [ ] **Step 3: Special-case the two endpoints that bypass `v1Route`** — `config-stream.ts` mounts its own `/v1/config/stream` with its own `apiKeyAuth`, and `paywall-preview.ts` mounts `/v1/preview/paywalls/:token` with **no API-key auth at all**. A generator assuming everything under `/v1` is `v1Route` mis-documents both, including the auth posture of the unauthenticated one.
- [ ] **Step 4:** Detect SECRET gating by reference equality against `requireSecretKey`, and PUBLIC via the now-shared `requirePublicApiKey`.
- [ ] **Step 5:** Convert tagged request schemas with `zod-to-json-schema`.
- [ ] **Step 6: Hand-author responses and parameters in `openapi/responses.ts`.** Nothing in the codebase describes a response body as data — `ok<T>()` is an identity generic erased at runtime — and no route uses `validate("query")` or `validate("param")`. This half cannot be generated; do not pretend otherwise.
- [ ] **Step 7:** Emit `apps/api/openapi/openapi.json`.
- [ ] **Step 8: Commit** — `feat(api): generate an OpenAPI 3.1 spec by walking the route table`

---

### Task 27: The contract test that makes drift a build failure

**Files:** Create `apps/api/tests/openapi-contract.test.ts`

This is the item's actual guarantee: the walk is the index of record, and an endpoint without documentation fails CI **by name**.

- [ ] **Step 1: Write the test**

```ts
it("documents every /v1 endpoint the app actually serves", () => {
  const walked = new Set(walkV1Endpoints(app));   // method + path
  const documented = new Set(Object.keys(spec.paths).flatMap(expandMethods));
  expect([...walked].filter((e) => !documented.has(e))).toEqual([]); // undocumented
  expect([...documented].filter((e) => !walked.has(e))).toEqual([]); // stale
});

it("documents the preview endpoint as unauthenticated", () => {
  expect(spec.paths["/v1/preview/paywalls/{token}"].get.security).toEqual([]);
});

it("does not duplicate endpoints across the browser mount", () => {
  expect(Object.keys(spec.paths).filter((p) => p.startsWith("/v1/web/"))).toEqual([]);
});
```

- [ ] **Step 2:** Add OpenAPI 3.1 schema validation of the emitted document.
- [ ] **Step 3:** Wire generation + the contract test into `ci.yml`.
- [ ] **Step 4: Verify the guard works** — add a throwaway endpoint, confirm CI fails naming it, remove it.
- [ ] **Step 5: Commit** — `test(api): fail CI when the OpenAPI spec and the route table disagree`

---

### Task 28: The explorer page

**Files:** Create `apps/docs/app/components/api-explorer.tsx`, `apps/docs/content/docs/reference/api-explorer.mdx`; modify `reference/meta.json`.

The production docs image is **Caddy serving static files with no Node process**, and `react-router.config.ts` prerenders every page.

- [ ] **Step 1:** Build the explorer as pure client-side JavaScript, SSR-guarded so it does not execute during the prerender pass. `app/routes/docs.tsx` already establishes that boundary with fumadocs' `createClientLoader` — follow it rather than a naive top-level import in MDX.
- [ ] **Step 2:** Base URL is entered by the reader — a self-hosted product has no canonical host to default to.
- [ ] **Step 3:** Link each documented error to its Phase B catalog entry.
- [ ] **Step 4: Verify** — `pnpm --filter @rovenue/docs build` completes (proving the prerender is not broken) and the page works from the built static output, not just the dev server.
- [ ] **Step 5: Commit** — `feat(docs): add the interactive API explorer`

---

### Task 29: Raise the docs-search defect separately

Because production serves static files with no Node runtime, `/api/search`'s server loader (`apps/docs/app/routes/search.ts`) is unreachable in the shipped image — documentation search is dead in production today.

- [ ] **Step 1:** Add it to the ROADMAP as its own item. Do not fix it inside this batch.
- [ ] **Step 2: Commit**

---

### Task 30: Close §11

- [ ] **Step 1:** Tick the explorer item and set §11's score.
- [ ] **Step 2:** Record honestly that the generated spec covers requests and auth, while responses and parameters are hand-authored and guarded by the contract test — not that the whole spec is generated.
- [ ] **Step 3: Run the full verification sweep** (sequential, throttled):
  `nice -n 19 npx vitest run --maxWorkers=2 packages/shared`
  `nice -n 19 npx vitest run --maxWorkers=2 apps/api/tests`
  `pnpm build --concurrency=2`
- [ ] **Step 4: Commit** — `docs(roadmap): close §11`

---

## Operator steps (not part of implementation)

- Run `pnpm db:migrate` to apply 0125 and 0126. Never point `db:migrate:fresh` at an upgrade-path database.
- Wire an Alertmanager if paging is wanted — the shipped alert rules reach nobody without one (Task 17).
