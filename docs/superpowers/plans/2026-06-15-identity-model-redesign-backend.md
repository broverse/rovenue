# Identity Model Redesign (Backend Slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-key subscriber identity onto a permanent `rovenueId` with a nullable customer-supplied `appUserId` label, add a public-key `POST /v1/identify` endpoint that binds the label and auto-transfers on collision, and migrate existing data without moving any FK/analytics rows.

**Architecture:** `subscribers.id` (cuid2 PK) stays the immutable internal key that every FK and ClickHouse aggregate already rides on — so no data moves. We add `rovenueId` (device-facing permanent lookup key, backfilled from the current `appUserId`) and make `appUserId` a nullable customer label. Subscriber resolution becomes rovenueId-first with a legacy-`appUserId` dual-read and `mergedInto` redirect-following so nothing 404s during rollover. A new `bindAppUserId` service reuses the existing `transferSubscriber` reassignment primitives to implement RevenueCat-style auto-transfer.

**Tech Stack:** PostgreSQL 16 + Drizzle ORM, drizzle-kit migrations, Hono, Zod, Vitest + testcontainers (`*.integration.test.ts`).

**Scope note:** This plan is the **backend slice**. The client side (Rust `librovenue` optimistic-local identify + `logOut()` + lazy reconcile, native `UserDTO` rename `anonId/knownUserId` → `rovenueId/appUserId`) is a **separate follow-up plan** because all SDK networking lives in the Rust core (see memory: SDK is Rust-core + native façades). This plan delivers the exact server contract that core will call.

**Source spec:** `docs/superpowers/specs/2026-06-15-identity-model-redesign-design.md`

**Confirmed decisions:** auto-transfer default (D3); explicit `logOut()` for hand-off (D4, client plan); optimistic + background sync (D5, client plan); lazy reconciliation + dual-read window (D6); secret-key `/v1/subscribers/transfer` kept (D7).

---

## File Structure

- `packages/db/src/drizzle/schema.ts` — add `rovenueId`, `identifiedAt`; make `appUserId` nullable; swap unique indexes. *Owns the table shape.*
- `packages/db/drizzle/migrations/NNNN_identity_rovenue_id.sql` — generated DDL + hand-added backfill + constraint swap. *Owns the data migration.*
- `packages/db/src/drizzle/repositories/subscribers.ts` — add `findSubscriberByRovenueId`, `resolveSubscriberByRovenueIdOrLegacy`, `setAppUserId`; extend upsert to accept `rovenueId`. *Owns subscriber persistence.*
- `apps/api/src/services/identify.ts` — new `bindAppUserId` service (label bind + auto-transfer). *Owns the identify business rule.*
- `apps/api/src/services/subscriber-transfer.ts` — extract reassignment internals into a reusable helper. *Owns merge mechanics.*
- `apps/api/src/lib/resolve-subscriber.ts` — rovenueId-first dual-read + redirect-follow. *Owns request→subscriber resolution.*
- `apps/api/src/middleware/app-user-context.ts` — accept the rovenue-id header. *Owns context wiring.*
- `apps/api/src/routes/v1/identify.ts` — new public-key `POST /v1/identify` route. *Owns the HTTP surface.*
- `apps/api/src/index.ts` (or the v1 router aggregator) — mount the route. *Owns routing.*
- `apps/docs/content/docs/guides/identifying-users.mdx` — rewrite for the new flow. *Owns developer docs.*

---

## Task 1: Schema — add `rovenueId` / `identifiedAt`, nullable `appUserId`, swap indexes

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts:373-412`
- Create: `packages/db/drizzle/migrations/<generated>_identity_rovenue_id.sql`
- Test: `packages/db/src/drizzle/repositories/subscribers.identity.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// subscribers.identity.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "../client";
// Assumes the shared testcontainer Postgres bootstrap used by other
// *.integration.test.ts suites has already run migrations.

describe("subscribers identity schema", () => {
  it("has rovenueId, identifiedAt columns and a nullable appUserId", async () => {
    const rows = await drizzle.db.execute(sql`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'subscribers'
        AND column_name IN ('rovenueId', 'appUserId', 'identifiedAt')
      ORDER BY column_name
    `);
    const byName = Object.fromEntries(
      (rows as unknown as Array<{ column_name: string; is_nullable: string }>)
        .map((r) => [r.column_name, r.is_nullable]),
    );
    expect(byName.rovenueId).toBe("NO");
    expect(byName.appUserId).toBe("YES");
    expect(byName.identifiedAt).toBe("YES");
  });

  it("backfilled rovenueId from appUserId for pre-existing rows", async () => {
    const rows = await drizzle.db.execute(sql`
      SELECT count(*)::int AS n FROM subscribers
      WHERE "rovenueId" IS NULL
    `);
    expect((rows as unknown as Array<{ n: number }>)[0].n).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/db test subscribers.identity`
Expected: FAIL — column `rovenueId` does not exist.

- [ ] **Step 3: Edit the schema**

In `packages/db/src/drizzle/schema.ts`, replace the `subscribers` column block + index block (lines 380, 404-411) so the table reads:

```typescript
    rovenueId: text("rovenueId").notNull(),
    appUserId: text("appUserId"),
```

(Remove `.notNull()` from `appUserId`; add the `rovenueId` line directly above it. Keep `firstSeenAt`/`lastSeenAt`/`attributes`/`deletedAt`/`mergedInto`/`appleAppAccountToken`/timestamps unchanged.) Add `identifiedAt` directly after `mergedInto`:

```typescript
    mergedInto: text("mergedInto"),
    identifiedAt: timestamp("identifiedAt", { withTimezone: true }),
```

Replace the index block `(t) => ({ ... })`:

```typescript
  (t) => ({
    projectIdRovenueIdKey: uniqueIndex(
      "subscribers_projectId_rovenueId_key",
    ).on(t.projectId, t.rovenueId),
    projectIdAppUserIdKey: uniqueIndex("subscribers_projectId_appUserId_key")
      .on(t.projectId, t.appUserId)
      .where(sql`${t.appUserId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    appleTokenIdx: uniqueIndex("idx_subscribers_apple_app_account_token")
      .on(t.projectId, t.appleAppAccountToken)
      .where(sql`${t.appleAppAccountToken} IS NOT NULL`),
  }),
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:migrate:generate`
This emits a new SQL file under `packages/db/drizzle/migrations/`. Open it.

- [ ] **Step 5: Hand-edit the generated migration for safe backfill ordering**

drizzle-kit will try to add `rovenueId NOT NULL` and drop/recreate indexes in one shot, which fails on a populated table. Replace the generated body with this explicit ordering (keep drizzle-kit's filename + the journal entry):

```sql
-- 1. add columns (rovenueId nullable for now)
ALTER TABLE "subscribers" ADD COLUMN "rovenueId" text;
ALTER TABLE "subscribers" ADD COLUMN "identifiedAt" timestamp with time zone;

-- 2. backfill: the current device-facing key becomes the permanent rovenueId.
--    Applies to soft-deleted rows too so mergedInto redirects keep resolving.
UPDATE "subscribers" SET "rovenueId" = "appUserId" WHERE "rovenueId" IS NULL;

-- 3. enforce
ALTER TABLE "subscribers" ALTER COLUMN "rovenueId" SET NOT NULL;
ALTER TABLE "subscribers" ALTER COLUMN "appUserId" DROP NOT NULL;

-- 4. swap unique indexes
DROP INDEX IF EXISTS "subscribers_projectId_appUserId_key";
CREATE UNIQUE INDEX "subscribers_projectId_rovenueId_key"
  ON "subscribers" ("projectId", "rovenueId");
CREATE UNIQUE INDEX "subscribers_projectId_appUserId_key"
  ON "subscribers" ("projectId", "appUserId")
  WHERE "appUserId" IS NOT NULL AND "deletedAt" IS NULL;
```

- [ ] **Step 6: Run the migration + test to verify it passes**

Run: `pnpm db:migrate && pnpm --filter @rovenue/db test subscribers.identity`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/drizzle/migrations packages/db/src/drizzle/repositories/subscribers.identity.integration.test.ts
git commit -m "feat(db): add rovenueId + identifiedAt to subscribers, nullable appUserId"
```

---

## Task 2: Repositories — rovenueId lookup, redirect-following resolve, setAppUserId

**Files:**
- Modify: `packages/db/src/drizzle/repositories/subscribers.ts`
- Test: `packages/db/src/drizzle/repositories/subscribers.resolve.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// subscribers.resolve.integration.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "../client";
import { subscribers } from "../schema";
import {
  findSubscriberByRovenueId,
  resolveSubscriberByRovenueIdOrLegacy,
  setAppUserId,
} from "./subscribers";

const projectId = "proj_resolve_test"; // created by the suite's seed helper

describe("rovenueId resolution", () => {
  it("finds an active row by rovenueId", async () => {
    const [row] = await drizzle.db
      .insert(subscribers)
      .values({ projectId, rovenueId: "rov_a", appUserId: null })
      .returning();
    const found = await findSubscriberByRovenueId(drizzle.db, {
      projectId,
      rovenueId: "rov_a",
    });
    expect(found?.id).toBe(row.id);
  });

  it("follows mergedInto when the rovenueId points at a soft-deleted row", async () => {
    const [canonical] = await drizzle.db
      .insert(subscribers)
      .values({ projectId, rovenueId: "rov_canon", appUserId: "user_1" })
      .returning();
    await drizzle.db.insert(subscribers).values({
      projectId,
      rovenueId: "rov_old",
      appUserId: null,
      deletedAt: new Date(),
      mergedInto: canonical.id,
    });
    const resolved = await resolveSubscriberByRovenueIdOrLegacy(drizzle.db, {
      projectId,
      key: "rov_old",
    });
    expect(resolved?.id).toBe(canonical.id);
  });

  it("falls back to legacy appUserId lookup", async () => {
    const [row] = await drizzle.db
      .insert(subscribers)
      .values({ projectId, rovenueId: "rov_legacy", appUserId: "legacy_key" })
      .returning();
    const resolved = await resolveSubscriberByRovenueIdOrLegacy(drizzle.db, {
      projectId,
      key: "legacy_key",
    });
    expect(resolved?.id).toBe(row.id);
  });

  it("setAppUserId stamps appUserId + identifiedAt", async () => {
    const [row] = await drizzle.db
      .insert(subscribers)
      .values({ projectId, rovenueId: "rov_b", appUserId: null })
      .returning();
    await setAppUserId(drizzle.db, row.id, "user_b", new Date());
    const after = await findSubscriberByRovenueId(drizzle.db, {
      projectId,
      rovenueId: "rov_b",
    });
    expect(after?.appUserId).toBe("user_b");
    expect(after?.identifiedAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/db test subscribers.resolve`
Expected: FAIL — `findSubscriberByRovenueId` is not exported.

- [ ] **Step 3: Implement the repository functions**

Add to `packages/db/src/drizzle/repositories/subscribers.ts` (after `findSubscriberByAppUserId`, around line 80). Note `appUserId` in the `Subscriber` type is now `string | null` after Task 1, so consumers must handle null.

```typescript
export interface FindByRovenueIdArgs {
  projectId: string;
  rovenueId: string;
}

/** Full-row lookup by (projectId, rovenueId). The primary device key. */
export async function findSubscriberByRovenueId(
  db: Db,
  args: FindByRovenueIdArgs,
): Promise<Subscriber | null> {
  const rows = await db
    .select()
    .from(subscribers)
    .where(
      and(
        eq(subscribers.projectId, args.projectId),
        eq(subscribers.rovenueId, args.rovenueId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface ResolveKeyArgs {
  projectId: string;
  /** The id the SDK sent — a rovenueId, or a legacy appUserId mid-migration. */
  key: string;
}

/**
 * Request→subscriber resolution for the rovenueId era:
 *  1. match by rovenueId; if the row is soft-deleted with a mergedInto
 *     target, follow the redirect to the canonical row;
 *  2. else fall back to a legacy active appUserId match (dual-read window).
 * Returns null when nothing resolves.
 */
export async function resolveSubscriberByRovenueIdOrLegacy(
  db: Db,
  args: ResolveKeyArgs,
): Promise<Subscriber | null> {
  const byRovenue = await findSubscriberByRovenueId(db, {
    projectId: args.projectId,
    rovenueId: args.key,
  });
  if (byRovenue) {
    if (byRovenue.deletedAt && byRovenue.mergedInto) {
      return findSubscriberById(db, byRovenue.mergedInto);
    }
    return byRovenue;
  }
  // Legacy fallback: appUserId that has not yet been re-keyed by a device.
  const rows = await db
    .select()
    .from(subscribers)
    .where(
      and(
        eq(subscribers.projectId, args.projectId),
        eq(subscribers.appUserId, args.key),
        isNull(subscribers.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Attach (or change) the customer label on a subscriber row. */
export async function setAppUserId(
  db: DbOrTx,
  id: string,
  appUserId: string,
  identifiedAt: Date,
): Promise<void> {
  await db
    .update(subscribers)
    .set({ appUserId, identifiedAt, updatedAt: new Date() })
    .where(eq(subscribers.id, id));
}
```

- [ ] **Step 4: Extend `upsertSubscriber` + `createSubscriber` to write `rovenueId`**

The auto-create path must key on `rovenueId`. Change `UpsertSubscriberInput` and the upsert (lines 165-223) so the insert carries `rovenueId` and `ON CONFLICT` targets it; `appUserId` is no longer required on create.

```typescript
export interface UpsertSubscriberInput {
  projectId: string;
  rovenueId: string;
  appUserId?: string | null;
  createAttributes?: unknown;
  updateAttributes?: unknown;
  appleAppAccountToken?: string | null;
}
```

In the upsert body, replace the `.values({...})` and `.onConflictDoUpdate({...})` target:

```typescript
  const rows = await db
    .insert(subscribers)
    .values({
      projectId: input.projectId,
      rovenueId: input.rovenueId,
      appUserId: input.appUserId ?? null,
      attributes: (input.createAttributes ??
        {}) as typeof subscribers.$inferInsert.attributes,
      appleAppAccountToken: input.appleAppAccountToken ?? null,
    })
    .onConflictDoUpdate({
      target: [subscribers.projectId, subscribers.rovenueId],
      set: update,
    })
    .returning();
```

Apply the same `rovenueId` field to `CreateSubscriberInput`/`createSubscriber` (lines 136-163): add `rovenueId: string` to the interface and `rovenueId: input.rovenueId` to the `.values({...})`. For the Apple synthetic-subscriber call site that mints `apple:<origTxId>`, pass that same value as **both** `rovenueId` and `appUserId` (it has no anonymous install). Grep for `createSubscriber(` and update each call site accordingly.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rovenue/db test subscribers.resolve`
Expected: PASS.

- [ ] **Step 6: Fix and run the type check across callers**

Run: `pnpm --filter @rovenue/db build && pnpm --filter @rovenue/api build`
Expected: PASS. Fix any call sites of `upsertSubscriber`/`createSubscriber` that still pass `appUserId` as the create key (they must now pass `rovenueId`). Also handle the now-nullable `appUserId` wherever a non-null was assumed.

**Explicit cross-plan call site — `apps/api/src/services/receipt-verify.ts` (do NOT skip):** the local `upsertSubscriber(projectId, appUserId)` wrapper at lines ~374-380 calls the repo upsert with `{ projectId, appUserId }`. The incoming value is the **device key the SDK sent**, which is the `rovenueId` under the new model. Change the repo call so it passes `rovenueId`:

```typescript
async function upsertSubscriber(
  projectId: string,
  rovenueId: string,
): Promise<Subscriber> {
  const row = await drizzle.subscriberRepo.upsertSubscriber(drizzle.db, {
    projectId,
    rovenueId,
    // appUserId stays null here — receipts identify by the device key;
    // the customer label is attached later via POST /v1/identify.
    ...
  });
  ...
}
```

This path is the hard dependency for the parallel SDK-purchase plan (its `purchase()`/`restorePurchases()` validation flows through lines 150/273/340). Landing Task 2 without this fix breaks receipt validation for that plan.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/drizzle/repositories/subscribers.ts packages/db/src/drizzle/repositories/subscribers.resolve.integration.test.ts
git commit -m "feat(db): rovenueId-keyed subscriber lookup, redirect-following resolve, setAppUserId"
```

---

## Task 3: Extract reusable reassignment helper from `transferSubscriber`

**Files:**
- Modify: `apps/api/src/services/subscriber-transfer.ts`
- Test: `apps/api/tests/subscriber-transfer.test.ts` (existing — must stay green)

- [ ] **Step 1: Run the existing transfer tests to capture the green baseline**

Run: `pnpm --filter @rovenue/api test subscriber-transfer`
Expected: PASS (the 9 existing transfer cases). This is the regression guard for the refactor.

- [ ] **Step 2: Extract the in-tx reassignment into a helper**

In `apps/api/src/services/subscriber-transfer.ts`, add an exported helper that performs the asset move given two resolved subscriber **ids** inside an existing tx. This is the body currently inlined at lines 84-145.

```typescript
import type { Db } from "@rovenue/db";

/**
 * Moves every asset (purchases, access, experiment assignments, credit
 * balance) from `fromId` to `toId` and soft-deletes the source as merged.
 * MUST run inside a transaction that already holds the advisory locks for
 * both subscribers. Returns the number of credits moved. Reused by both
 * `transferSubscriber` (secret-key) and `bindAppUserId` (identify).
 */
export async function reassignAllAssets(
  tx: Db,
  projectId: string,
  from: { id: string; label: string },
  to: { id: string; label: string },
): Promise<number> {
  await drizzle.subscriberRepo.reassignPurchases(tx, from.id, to.id);
  await drizzle.subscriberRepo.reassignSubscriberAccess(tx, from.id, to.id);
  await drizzle.subscriberRepo.reassignExperimentAssignments(tx, from.id, to.id);

  let creditsTransferred = 0;
  const fromBalance = await drizzle.creditLedgerRepo.findLatestBalance(tx, from.id);
  const fromBal = fromBalance?.balance ?? 0;
  if (fromBal > 0) {
    creditsTransferred = fromBal;
    await drizzle.creditLedgerRepo.insertCreditLedger(tx, {
      projectId,
      subscriberId: from.id,
      type: CreditLedgerType.TRANSFER_OUT,
      amount: -fromBal,
      balance: 0,
      referenceType: "transfer",
      referenceId: to.id,
      description: `Credits transferred to ${to.label}`,
    });
    const toBalance = await drizzle.creditLedgerRepo.findLatestBalance(tx, to.id);
    const toBal = toBalance?.balance ?? 0;
    await drizzle.creditLedgerRepo.insertCreditLedger(tx, {
      projectId,
      subscriberId: to.id,
      type: CreditLedgerType.TRANSFER_IN,
      amount: fromBal,
      balance: toBal + fromBal,
      referenceType: "transfer",
      referenceId: from.id,
      description: `Credits received from ${from.label}`,
    });
  }

  await drizzle.subscriberRepo.softDeleteSubscriberAsMerged(
    tx,
    from.id,
    to.id,
    new Date(),
  );
  return creditsTransferred;
}
```

- [ ] **Step 3: Rewrite `transferSubscriber` to use the helper**

Replace the inlined block (lines 84-145) inside `transferSubscriber`'s transaction with:

```typescript
    const creditsTransferred = await reassignAllAssets(
      tx,
      projectId,
      { id: from.id, label: fromAppUserId },
      { id: to.id, label: toAppUserId },
    );
```

Keep the existing find-by-appUserId lookups, the `deletedAt` guard, the `log.info`, the audit block, and the return value unchanged.

- [ ] **Step 4: Run the existing transfer tests to verify no regression**

Run: `pnpm --filter @rovenue/api test subscriber-transfer`
Expected: PASS (same 9 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/subscriber-transfer.ts
git commit -m "refactor(api): extract reassignAllAssets helper from transferSubscriber"
```

---

## Task 4: `bindAppUserId` service — label bind + auto-transfer

**Files:**
- Create: `apps/api/src/services/identify.ts`
- Test: `apps/api/tests/identify.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/tests/identify.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "@rovenue/db";
import { subscribers } from "@rovenue/db";
import { bindAppUserId } from "../src/services/identify";

const projectId = "proj_identify_test"; // seeded by the suite helper

async function insertSub(rovenueId: string, appUserId: string | null) {
  const [row] = await drizzle.db
    .insert(subscribers)
    .values({ projectId, rovenueId, appUserId })
    .returning();
  return row;
}

describe("bindAppUserId", () => {
  it("attaches the label when the appUserId is unused (no transfer)", async () => {
    const self = await insertSub("rov_1", null);
    const res = await bindAppUserId(projectId, "rov_1", "user_1");
    expect(res.transferred).toBe(false);
    expect(res.subscriberId).toBe(self.id);
    const after = await drizzle.subscriberRepo.findSubscriberById(drizzle.db, self.id);
    expect(after?.appUserId).toBe("user_1");
    expect(after?.identifiedAt).not.toBeNull();
  });

  it("is idempotent when the same label is already set", async () => {
    await insertSub("rov_2", "user_2");
    const res = await bindAppUserId(projectId, "rov_2", "user_2");
    expect(res.transferred).toBe(false);
  });

  it("auto-transfers assets from the prior holder to this device", async () => {
    const other = await insertSub("rov_old", "user_3");
    const self = await insertSub("rov_new", null);
    await drizzle.creditLedgerRepo.insertCreditLedger(drizzle.db, {
      projectId,
      subscriberId: other.id,
      type: "BONUS" as never,
      amount: 50,
      balance: 50,
      referenceType: "seed",
      referenceId: "seed",
      description: "seed",
    });

    const res = await bindAppUserId(projectId, "rov_new", "user_3");

    expect(res.transferred).toBe(true);
    expect(res.subscriberId).toBe(self.id);
    // self now owns the label
    const selfAfter = await drizzle.subscriberRepo.findSubscriberById(drizzle.db, self.id);
    expect(selfAfter?.appUserId).toBe("user_3");
    // other is soft-deleted, redirecting to self, label cleared from active uniqueness
    const otherAfter = await drizzle.subscriberRepo.findSubscriberById(drizzle.db, other.id);
    expect(otherAfter?.deletedAt).not.toBeNull();
    expect(otherAfter?.mergedInto).toBe(self.id);
    // credits moved
    const bal = await drizzle.creditLedgerRepo.findLatestBalance(drizzle.db, self.id);
    expect(bal?.balance).toBe(50);
  });

  it("throws when the device row (rovenueId) does not exist", async () => {
    await expect(bindAppUserId(projectId, "rov_missing", "user_x")).rejects.toThrow(
      /not found/i,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test identify`
Expected: FAIL — cannot find `../src/services/identify`.

- [ ] **Step 3: Implement `bindAppUserId`**

```typescript
// apps/api/src/services/identify.ts
import { drizzle } from "@rovenue/db";
import { logger } from "../lib/logger";
import { audit } from "../lib/audit";
import { reassignAllAssets } from "./subscriber-transfer";

const log = logger.child("identify");

export interface BindResult {
  subscriberId: string;
  appUserId: string;
  transferred: boolean;
}

/**
 * Binds a customer `appUserId` label to the device's permanent `rovenueId`
 * row. RevenueCat-style "transfer to new id": if the label currently lives
 * on a different subscriber, that subscriber's assets are auto-transferred
 * onto this device's row and the prior holder is soft-deleted as merged.
 *
 * Serialised by a project-scoped advisory lock on both the rovenueId and
 * the appUserId so concurrent identify/transfer calls can't race the
 * balance read+write or the uniqueness swap.
 */
export async function bindAppUserId(
  projectId: string,
  rovenueId: string,
  appUserId: string,
  userId?: string,
): Promise<BindResult> {
  return drizzle.db.transaction(async (tx) => {
    const [k1, k2] = [`r:${rovenueId}`, `u:${appUserId}`].sort();
    await drizzle.lockRepo.advisoryXactLock2(
      tx,
      `${projectId}:${k1}`,
      `${projectId}:${k2}`,
    );

    const self = await drizzle.subscriberRepo.findSubscriberByRovenueId(tx, {
      projectId,
      rovenueId,
    });
    if (!self) {
      throw new Error(`Device subscriber '${rovenueId}' not found`);
    }

    // Already labelled with this id → idempotent no-op (stamp identifiedAt
    // if it was somehow missing).
    if (self.appUserId === appUserId) {
      if (!self.identifiedAt) {
        await drizzle.subscriberRepo.setAppUserId(tx, self.id, appUserId, new Date());
      }
      return { subscriberId: self.id, appUserId, transferred: false };
    }

    const other = await drizzle.subscriberRepo.findSubscriberByAppUserId(tx, {
      projectId,
      appUserId,
    });

    let transferred = false;
    if (other && !other.deletedAt && other.id !== self.id) {
      // Move the prior holder's assets onto this device, then free its label.
      await reassignAllAssets(
        tx,
        projectId,
        { id: other.id, label: appUserId },
        { id: self.id, label: rovenueId },
      );
      transferred = true;
    }

    await drizzle.subscriberRepo.setAppUserId(tx, self.id, appUserId, new Date());

    log.info("appUserId bound", {
      projectId,
      rovenueId,
      subscriberId: self.id,
      transferred,
    });

    if (userId) {
      await audit(
        {
          projectId,
          userId,
          action: "update",
          resource: "subscriber",
          resourceId: self.id,
          before: { rovenueId, appUserId: self.appUserId },
          after: { appUserId, transferred },
        },
        tx,
      );
    }

    return { subscriberId: self.id, appUserId, transferred };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test identify`
Expected: PASS (all 4 cases). The auto-transfer case relies on `reassignAllAssets` soft-deleting `other`, which frees the partial-unique `(projectId, appUserId) WHERE deletedAt IS NULL` so `setAppUserId(self, "user_3")` does not collide.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/identify.ts apps/api/tests/identify.test.ts
git commit -m "feat(api): bindAppUserId service with RevenueCat-style auto-transfer"
```

---

## Task 5: Resolution + header wiring for the rovenueId era

**Files:**
- Modify: `apps/api/src/lib/resolve-subscriber.ts`
- Modify: `apps/api/src/middleware/app-user-context.ts:23`
- Modify: `apps/api/src/routes/v1/config.ts` (auto-create call)
- Test: `apps/api/tests/resolve-subscriber.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/tests/resolve-subscriber.test.ts
import { describe, expect, it } from "vitest";
import { drizzle, subscribers } from "@rovenue/db";
import { HTTPException } from "hono/http-exception";
import { resolveSubscriber } from "../src/lib/resolve-subscriber";

const projectId = "proj_resolve_lib_test";

describe("resolveSubscriber (rovenueId-first)", () => {
  it("resolves by rovenueId", async () => {
    const [row] = await drizzle.db
      .insert(subscribers)
      .values({ projectId, rovenueId: "rov_lib_1", appUserId: null })
      .returning();
    const got = await resolveSubscriber(projectId, "rov_lib_1");
    expect(got.id).toBe(row.id);
  });

  it("throws 404 when nothing resolves", async () => {
    await expect(resolveSubscriber(projectId, "nope")).rejects.toBeInstanceOf(
      HTTPException,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test resolve-subscriber`
Expected: FAIL — resolveSubscriber still calls `findSubscriberByAppUserId`, and the inserted row has `appUserId: null`, so the rovenueId case returns null → throws on a row that should resolve.

- [ ] **Step 3: Rewrite `resolve-subscriber.ts`**

```typescript
import { HTTPException } from "hono/http-exception";
import { drizzle, type Subscriber } from "@rovenue/db";

/**
 * Resolves the subscriber for an inbound SDK request. `key` is the value
 * the SDK sent — a `rovenueId` going forward, or a legacy `appUserId`
 * during the migration dual-read window. Follows `mergedInto` redirects.
 */
export async function resolveSubscriber(
  projectId: string,
  key: string,
): Promise<Subscriber> {
  const subscriber =
    await drizzle.subscriberRepo.resolveSubscriberByRovenueIdOrLegacy(
      drizzle.db,
      { projectId, key },
    );
  if (!subscriber) {
    throw new HTTPException(404, { message: `Subscriber ${key} not found` });
  }
  return subscriber as Subscriber;
}
```

- [ ] **Step 4: Point the header at the rovenueId (kept name for back-compat)**

The SDK sends the device key in `X-Rovenue-App-User-Id` today; during migration this carries the rovenueId. No code change is required in `app-user-context.ts` — confirm the variable read at line 23 flows into `resolveSubscriber(project.id, key)` (it does). Add a clarifying comment at line 23:

```typescript
  // Carries the device key: a rovenueId going forward, a legacy
  // appUserId during the dual-read migration window.
  const key = c.req.header(HEADER.X_ROVENUE_APP_USER_ID)?.trim();
```

Rename the local `appUserId` → `key` in this file and update the `resolveSubscriber(project.id, key)` call + the 400 message accordingly.

- [ ] **Step 5: Update the `/v1/config` auto-create to key on rovenueId**

In `apps/api/src/routes/v1/config.ts` (around lines 80-111), the value from `resolveSubscriberId(c)` is the device key. Pass it as `rovenueId` to `upsertSubscriber`:

```typescript
    const rovenueId = resolveSubscriberId(c);
    const subscriber = await drizzle.subscriberRepo.upsertSubscriber(
      drizzle.db,
      {
        projectId: project.id,
        rovenueId,
        createAttributes: requestAttributes,
        ...(hasNewAttributes && { updateAttributes: mergedAttributes }),
      },
    );
```

Update the `findSubscriberAttributes` call just above it to look up by rovenueId — add a sibling `findSubscriberAttributesByRovenueId` in the repo mirroring `findSubscriberAttributes` but matching `subscribers.rovenueId`, and call it here. (Same shape as Task 2 Step 3; match on `rovenueId` instead of `appUserId`.)

- [ ] **Step 6: Run tests + type check**

Run: `pnpm --filter @rovenue/api test resolve-subscriber && pnpm --filter @rovenue/api build`
Expected: PASS. Fix any remaining callers that assumed `findSubscriberAttributes`-by-appUserId for the SDK path.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/resolve-subscriber.ts apps/api/src/middleware/app-user-context.ts apps/api/src/routes/v1/config.ts packages/db/src/drizzle/repositories/subscribers.ts apps/api/tests/resolve-subscriber.test.ts
git commit -m "feat(api): rovenueId-first subscriber resolution with legacy dual-read"
```

---

## Task 6: `POST /v1/identify` route (public key)

**Files:**
- Create: `apps/api/src/routes/v1/identify.ts`
- Modify: the v1 router aggregator that mounts sub-routes (grep for `subscribersRoute` mount, e.g. `apps/api/src/routes/v1/index.ts`)
- Test: `apps/api/tests/identify-route.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/tests/identify-route.integration.test.ts
import { describe, expect, it } from "vitest";
import { drizzle, subscribers } from "@rovenue/db";
import { app } from "../src/app"; // the Hono app export used by other route tests

const projectId = "proj_identify_route";
const publicKey = "rov_pub_test_identify"; // seeded with the project

async function call(body: unknown) {
  return app.request("/v1/identify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${publicKey}`,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/identify", () => {
  it("binds appUserId to the device rovenueId", async () => {
    await drizzle.db
      .insert(subscribers)
      .values({ projectId, rovenueId: "rov_route_1", appUserId: null });
    const res = await call({ rovenueId: "rov_route_1", appUserId: "user_route_1" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { transferred: boolean } };
    expect(json.data.transferred).toBe(false);
  });

  it("rejects a missing appUserId with 400", async () => {
    const res = await call({ rovenueId: "rov_route_1" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when the device row is unknown", async () => {
    const res = await call({ rovenueId: "rov_unknown", appUserId: "user_y" });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test identify-route`
Expected: FAIL — route `/v1/identify` not mounted (404).

- [ ] **Step 3: Implement the route**

```typescript
// apps/api/src/routes/v1/identify.ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { bindAppUserId } from "../../services/identify";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";

const log = logger.child("route:v1:identify");

export const identifyBodySchema = z.object({
  rovenueId: z.string().min(1),
  appUserId: z.string().min(1),
});

// Public-key endpoint. The SDK (Rust core) calls this after the app sets
// an identity. It binds the customer label to the device's permanent
// rovenueId and auto-transfers any prior holder's assets. Merging is a
// label-bind, never a privileged read of another user's data, so the
// public key is sufficient — see the spec's Security section (opaque
// appUserId required; authoritative consolidation stays on the
// secret-key /v1/subscribers/transfer endpoint).
export const identifyRoute = new Hono().post(
  "/",
  zValidator("json", identifyBodySchema),
  async (c) => {
    const project = c.get("project");
    const body = c.req.valid("json");
    try {
      const result = await bindAppUserId(
        project.id,
        body.rovenueId,
        body.appUserId,
      );
      log.info("identify completed", { projectId: project.id, ...result });
      return c.json(ok(result));
    } catch (err) {
      if (err instanceof Error) {
        throw new HTTPException(400, { message: err.message });
      }
      throw err;
    }
  },
);
```

- [ ] **Step 4: Mount the route under the public-key middleware**

In the v1 aggregator (where `subscribersRoute` is mounted with the public `apiKeyAuth`), add:

```typescript
import { identifyRoute } from "./identify";
// ... alongside the other public SDK routes (same apiKeyAuth chain that
// /v1/config uses — NOT requireSecretKey):
v1.route("/identify", identifyRoute);
```

Match the exact middleware chain used by `/v1/config` (public key accepted). Confirm by grepping the aggregator for how `configRoute` is mounted and mirror it.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test identify-route`
Expected: PASS (all 3 cases).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/identify.ts apps/api/src/routes/v1/index.ts apps/api/tests/identify-route.integration.test.ts
git commit -m "feat(api): POST /v1/identify public-key endpoint"
```

---

## Task 7: Docs — rewrite the Identifying users guide

**Files:**
- Modify: `apps/docs/content/docs/guides/identifying-users.mdx`

- [ ] **Step 1: Rewrite the guide for the new model**

Replace the body with content covering exactly:

- **Two ids:** `rovenueId` (permanent, generated per install, always present) and `appUserId` (your backend user id, attached via `identify()`).
- **`identify(appUserId)`** now binds the label server-side and, on collision, **auto-transfers** the prior holder's purchases/credits to the current device (RevenueCat-style "transfer to new id").
- **Use opaque, unguessable `appUserId`s** (never email/username) — a one-paragraph security callout explaining the takeover surface.
- **`logOut()`** mints a fresh `rovenueId` so the next user on a shared device starts clean (note: shipped in the SDK client release; cross-reference).
- **`currentUser()`** returns `{ rovenueId, appUserId }`.
- **Authoritative consolidation** still available via secret-key `POST /v1/subscribers/transfer` for backend-driven/bulk merges.
- Remove the old "identify is client-local; you must call transfer yourself" framing.

- [ ] **Step 2: Validate internal links + build the docs site**

Run: `pnpm --filter @rovenue/docs build`
Expected: PASS (internal link validation passes — see CI internal-link check at commit 04e3f6a).

- [ ] **Step 3: Commit**

```bash
git add apps/docs/content/docs/guides/identifying-users.mdx
git commit -m "docs: rewrite identifying-users for rovenueId + appUserId model"
```

---

## Task 8: Full-suite verification

- [ ] **Step 1: Build everything**

Run: `pnpm build`
Expected: PASS (all packages).

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: PASS, including the existing `subscriber-transfer` cases and the new identity/resolve/identify suites. (Requires DB/testcontainers in the runner — see memory `deployment_readiness_and_ci_disabled`.)

- [ ] **Step 3: Verify ClickHouse parity is untouched**

Run: `pnpm --filter @rovenue/db db:verify:clickhouse`
Expected: PASS — analytics key on `subscribers.id`, which this plan never changes.

---

## Follow-up (separate plan, out of scope here)

**Client slice — Rust core + native façades:** `rovenueId` generation, `currentUser()` → `{ rovenueId, appUserId }`, `identify()` optimistic-local apply + background `POST /v1/identify` + lazy reconcile (send both `rovenueId` and any locally-known `appUserId` on first post-upgrade call), and `logOut()`/`reset()` that mints a fresh `rovenueId` and clears the entitlement cache. Native `UserDTO` rename `anonId/knownUserId` → `rovenueId/appUserId` (`packages/sdk-rn/src/specs/RovenueModule.types.ts`), SDK `packages/sdk-rn/src/api/identity.ts` surface, plus Swift/Kotlin/Rust implementations.

**Migration finalization (later migration):** once devices have rolled over, set any remaining cleanup (e.g. drop the legacy dual-read fallback in `resolveSubscriberByRovenueIdOrLegacy`). Gate on telemetry showing legacy-appUserId hits ≈ 0.
