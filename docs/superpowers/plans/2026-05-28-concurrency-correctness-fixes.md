# Concurrency & Correctness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four verified correctness bugs — a shadowed dashboard route, a missing prod env guard, a non-atomic consumable-credit dedup, and a non-atomic Apple webhook claim — and document the outbox/at-least-once single-dispatcher requirement.

**Architecture:** Two branches. **Branch 1 (cheap, high-value):** route reorder (#6) + `DATABASE_URL` prod requirement (#8) + move consumable-credit dedup inside the per-subscriber advisory lock (#2). **Branch 2 (separate):** atomic compare-and-set claim for Apple webhook events (#3). A final docs-only task (#4/#5) records the single-dispatcher / ClickHouse-`ReplacingMergeTree` dedup contract. TDD throughout; one commit per task.

**Tech Stack:** Hono, Drizzle ORM (Postgres 16, range-partitioned hot tables), Zod, Vitest + testcontainers integration suites, Better Auth sessions.

**Key constraint discovered during planning:** `credit_ledger` and `revenue_events` are declarative **range partitions** on `createdAt`. Postgres forbids a UNIQUE/PRIMARY KEY on a partitioned table unless it includes the partition key. So a partial unique index on `(subscriberId, referenceType, referenceId)` is **not possible** here — the real backstop is the existing per-subscriber `pg_advisory_xact_lock`, with the dedup check moved *inside* that lock. Same reasoning rules out a bare `webhookEventId` unique on `revenue_events` for #3; the fix there is an atomic claim instead.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `apps/api/src/routes/dashboard/queries.ts` | Saved-query + playground routes | Move static `GET /schema` above param `GET /:id` |
| `apps/api/src/lib/env.ts` | Env schema + prod superRefine | Add `DATABASE_URL` to prod `require()` block |
| `apps/api/src/services/credit-engine.ts` | Credit ledger writes | `addCredits` gains in-lock dedup option |
| `apps/api/src/routes/v1/receipts.ts` | Receipt verify + grant | Drop pre-lock dedup; delegate to `addCredits` |
| `packages/db/src/drizzle/repositories/credit-ledger.ts` | Ledger repo | `findExistingPurchaseCredit` accepts a tx handle |
| `packages/db/src/drizzle/repositories/webhook-events.ts` | Webhook-event repo | Add atomic `claimWebhookEvent` |
| `apps/api/src/services/apple/apple-webhook.ts` | Apple notification handler | Use atomic claim instead of upsert+status-read |
| `docs/architecture/outbox-dispatcher.md` | Ops doc | Record single-dispatcher + CH dedup contract |

---

# Branch 1 — Route, Env, Credit Dedup

> Create branch: `git checkout -b fix/concurrency-route-env-credit`

## Task 1: Fix shadowed `GET /schema` route (#6)

**Problem:** `GET /:id` is registered (queries.ts:123) before `GET /schema` (queries.ts:217). Hono matches in registration order, so `GET …/queries/schema` binds `id="schema"`, hits `findSavedQueryById`, and returns `404 {"error":{...,"message":"Query not found"}}`. The schema-introspection endpoint is unreachable.

**Fix:** Static segments must be registered before param segments. Move the `.get("/schema", …)` block so it precedes `.get("/:id", …)`.

**Files:**
- Modify: `apps/api/src/routes/dashboard/queries.ts`
- Test: `apps/api/src/routes/dashboard/queries.integration.test.ts` (create)

- [ ] **Step 1: Write the failing integration test**

Mirror the harness in `apps/api/src/routes/dashboard/credits.integration.test.ts` (real Postgres, Better Auth session, mount on the production path). Create `apps/api/src/routes/dashboard/queries.integration.test.ts`:

```typescript
import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { queriesRoute } from "./queries";

const RUN_ID = Date.now();

function buildApp() {
  return new Hono().route("/projects/:projectId/queries", queriesRoute);
}

async function createUserAndSession(suffix: string): Promise<{ userId: string; cookie: string }> {
  const email = `queriesroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!queriesroute";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: `Queries User ${suffix}` },
  });
  if (!signUp?.user) throw new Error(`signUpEmail failed for ${suffix}`);
  const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (!cookie) throw new Error(`no set-cookie for ${suffix}`);
  return { userId: signUp.user.id, cookie };
}

async function seedProjectWithMember(userId: string) {
  const db = getDb();
  const id = `prj_queriesroute_${RUN_ID}`;
  await db.insert(projects).values({ id, name: `Queries Route Project ${RUN_ID}` });
  await db.insert(drizzle.schema.projectMembers).values({ projectId: id, userId, role: "OWNER" });
  return { id };
}

describe("GET /projects/:projectId/queries/schema", () => {
  afterAll(async () => {
    await getDb().delete(projects).where(
      (await import("drizzle-orm")).eq(projects.id, `prj_queriesroute_${RUN_ID}`),
    );
  });

  it("is not shadowed by GET /:id", async () => {
    const { userId, cookie } = await createUserAndSession("a");
    const { id } = await seedProjectWithMember(userId);
    const app = buildApp();

    const res = await app.request(`/projects/${id}/queries/schema`, {
      headers: { cookie },
    });

    // The shadowing bug returns 404 "Query not found" because /:id
    // captured "schema". The static route must win regardless of how
    // schema introspection itself resolves (ClickHouse degrades in dev).
    expect(res.status).not.toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("Query not found");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- queries.integration`
Expected: FAIL — `res.status` is `404` and body contains `"Query not found"`.

- [ ] **Step 3: Move the `/schema` route above `/:id`**

In `apps/api/src/routes/dashboard/queries.ts`, cut this block (currently at lines 216–226):

```typescript
  // ----- Schema introspection -----
  .get("/schema", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    return c.json(ok(await readPlaygroundSchema(projectId)));
  });
```

Re-insert it immediately **before** the `.get("/:id", …)` handler (currently line 123), so the chain reads `… .post("/", …)` → `.get("/schema", …)` → `.get("/:id", …)`. Because `/schema` is now the terminal method in the chain, append the trailing `;` to the `.get("/:id"…)`→`.patch`→`.delete`→`.post("/execute")` tail instead — i.e. the last `.post("/execute", …)` block keeps the closing `;`, and the moved `/schema` block loses its trailing `;` and ends with `)`.

Result: static `GET /schema` is registered before param `GET /:id`; Hono now matches `/schema` exactly.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- queries.integration`
Expected: PASS.

- [ ] **Step 5: Run the existing dashboard suite to confirm no regression**

Run: `pnpm --filter @rovenue/api test -- dashboard`
Expected: PASS (saved-query CRUD on `/:id` still resolves).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/dashboard/queries.ts apps/api/src/routes/dashboard/queries.integration.test.ts
git commit -m "fix(api): register GET /queries/schema before /:id so it is not shadowed"
```

---

## Task 2: Require `DATABASE_URL` in production (#8)

**Problem:** `DATABASE_URL` is `z.string().url().optional()` (env.ts:21) and absent from the `NODE_ENV === "production"` `superRefine` block (env.ts:156–231). A prod deploy with no `DATABASE_URL` boots and fails later at first query instead of failing fast at startup.

**Files:**
- Modify: `apps/api/src/lib/env.ts`
- Test: `apps/api/tests/database-url-env.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Mirror `apps/api/tests/billing-env.test.ts`. Create `apps/api/tests/database-url-env.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("DATABASE_URL env requirement", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("is optional in development", async () => {
    const origNode = process.env.NODE_ENV;
    const origUrl = process.env.DATABASE_URL;
    process.env.NODE_ENV = "development";
    delete process.env.DATABASE_URL;
    try {
      const { env } = await import("../src/lib/env");
      expect(env.DATABASE_URL).toBeUndefined();
    } finally {
      process.env.NODE_ENV = origNode;
      if (origUrl !== undefined) process.env.DATABASE_URL = origUrl;
    }
  });

  it("is required in production", async () => {
    const origNode = process.env.NODE_ENV;
    const origUrl = process.env.DATABASE_URL;
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;

    // Provide every other production-required var so DATABASE_URL is
    // the only thing missing — isolates the assertion to this check.
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    process.env.PUBSUB_PUSH_AUDIENCE = "https://example.com";
    process.env.APPLE_ROOT_CERTS_DIR = "/certs";
    process.env.BETTER_AUTH_SECRET = "secret";
    process.env.UNSUB_SIGNING_KEY = "b".repeat(64);
    process.env.CLICKHOUSE_URL = "http://localhost:8123";
    process.env.CLICKHOUSE_PASSWORD = "pass";
    process.env.KAFKA_BROKERS = "localhost:9092";

    try {
      await expect(import("../src/lib/env")).rejects.toThrow(/DATABASE_URL/);
    } finally {
      process.env.NODE_ENV = origNode;
      if (origUrl !== undefined) process.env.DATABASE_URL = origUrl;
      delete process.env.ENCRYPTION_KEY;
      delete process.env.PUBSUB_PUSH_AUDIENCE;
      delete process.env.APPLE_ROOT_CERTS_DIR;
      delete process.env.BETTER_AUTH_SECRET;
      delete process.env.UNSUB_SIGNING_KEY;
      delete process.env.CLICKHOUSE_URL;
      delete process.env.CLICKHOUSE_PASSWORD;
      delete process.env.KAFKA_BROKERS;
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- database-url-env`
Expected: FAIL — the production case does not throw (`DATABASE_URL` is unchecked).

- [ ] **Step 3: Add the prod requirement**

In `apps/api/src/lib/env.ts`, inside the `superRefine` block, add as the first `require()` call (immediately after the `require` helper is defined, before the `ENCRYPTION_KEY` check at line 173):

```typescript
    require(
      data.DATABASE_URL,
      "DATABASE_URL",
      "the API cannot serve any request without a Postgres connection",
    );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- database-url-env`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/env.ts apps/api/tests/database-url-env.test.ts
git commit -m "fix(api): require DATABASE_URL in production env validation"
```

---

## Task 3: Make `findExistingPurchaseCredit` tx-aware (#2, prep)

**Problem:** The dedup helper only accepts the top-level `db` handle, so it cannot run inside the advisory-lock transaction. Widen its handle type. No behavior change — pure prep so Task 4 can call it with `tx`.

**Files:**
- Modify: `packages/db/src/drizzle/repositories/credit-ledger.ts:17-34`

- [ ] **Step 1: Widen the handle type**

In `packages/db/src/drizzle/repositories/credit-ledger.ts`, change the signature of `findExistingPurchaseCredit` from `db: Db` to `db: DbOrTx`. Add the alias if it is not already present at the top of the file (the file currently uses `Db`; introduce `type DbOrTx = Db;` next to the import like the other repos do):

```typescript
type DbOrTx = Db;

/**
 * Dedup guard used by receipt verification: has this purchase
 * already produced a ledger entry? Accepts a tx handle so the
 * check can run inside the per-subscriber advisory lock.
 */
export async function findExistingPurchaseCredit(
  db: DbOrTx,
  subscriberId: string,
  purchaseId: string,
): Promise<{ id: string } | null> {
```

(Body unchanged.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @rovenue/db build`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/drizzle/repositories/credit-ledger.ts
git commit -m "refactor(db): let findExistingPurchaseCredit accept a tx handle"
```

---

## Task 4: Move consumable-credit dedup inside the advisory lock (#2)

**Problem:** `receipts.ts:67-73` runs `findExistingPurchaseCredit` on `drizzle.db` (no transaction), then `addCredits` later takes the per-subscriber `pg_advisory_xact_lock` (credit-engine.ts:53-54) but does **not** re-check the dedup inside it. Two concurrent receipts for the same `purchase.id` both see "not credited," both pass the lock serially, and both insert a ledger row → duplicate credits. Because `credit_ledger` is range-partitioned, a unique index cannot enforce this. The fix is to perform the existence check **inside** `addCredits`'s lock-holding transaction, where it is serialized per subscriber.

**Files:**
- Modify: `apps/api/src/services/credit-engine.ts:32-89`
- Modify: `apps/api/src/routes/v1/receipts.ts:62-82`
- Test: `apps/api/tests/credit-dedup.integration.test.ts` (create)

- [ ] **Step 1: Write the failing integration test (concurrent double-credit)**

Create `apps/api/tests/credit-dedup.integration.test.ts`. It seeds a project + subscriber, fires two concurrent `addCredits` calls with the same `referenceType: "purchase"` / `referenceId`, both with `dedupeOnReference: true`, and asserts exactly one ledger row results and the final balance equals a single grant.

```typescript
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, projects, subscribers, drizzle } from "@rovenue/db";
import { addCredits, getBalance } from "../src/services/credit-engine";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_creditdedup_${RUN_ID}`;
const SUB_ID = `sub_creditdedup_${RUN_ID}`;
const PURCHASE_ID = `pur_creditdedup_${RUN_ID}`;

describe("addCredits dedupeOnReference", () => {
  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("inserts exactly one ledger row under concurrent same-reference grants", async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `Credit Dedup ${RUN_ID}` });
    await db.insert(subscribers).values({
      id: SUB_ID,
      projectId: PROJECT_ID,
      appUserId: `app_${RUN_ID}`,
    });

    const grant = () =>
      addCredits({
        subscriberId: SUB_ID,
        amount: 100,
        referenceType: "purchase",
        referenceId: PURCHASE_ID,
        description: "Credits for test",
        dedupeOnReference: true,
      });

    await Promise.all([grant(), grant()]);

    const rows = await db
      .select({ id: drizzle.schema.creditLedger.id })
      .from(drizzle.schema.creditLedger)
      .where(
        and(
          eq(drizzle.schema.creditLedger.subscriberId, SUB_ID),
          eq(drizzle.schema.creditLedger.referenceType, "purchase"),
          eq(drizzle.schema.creditLedger.referenceId, PURCHASE_ID),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(await getBalance(SUB_ID)).toBe(100);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- credit-dedup.integration`
Expected: FAIL — two rows inserted, balance 200 (no `dedupeOnReference` support yet; and even ignoring the unknown option, the pre-existing race double-inserts).

- [ ] **Step 3: Add the in-lock dedup option to `addCredits`**

In `apps/api/src/services/credit-engine.ts`, extend `AddCreditsArgs` and the transaction body. Add the field to the interface (after `metadata?`):

```typescript
  /**
   * When true and referenceId is set, re-check inside the advisory
   * lock whether a ledger row already exists for this purchase
   * reference; if so, return the existing row instead of inserting
   * a duplicate. The lock serialises concurrent grants per
   * subscriber, making check-then-insert atomic — credit_ledger is
   * range-partitioned so a unique index cannot enforce this.
   */
  dedupeOnReference?: boolean;
```

Then inside the `drizzle.db.transaction` callback, after the advisory lock + subscriber lookup and **before** computing `balance`, insert:

```typescript
    if (args.dedupeOnReference && args.referenceId) {
      const existing = await drizzle.creditLedgerRepo.findExistingPurchaseCredit(
        tx,
        args.subscriberId,
        args.referenceId,
      );
      if (existing) {
        log.debug("credit already granted for reference, skipping", {
          subscriberId: args.subscriberId,
          referenceId: args.referenceId,
        });
        const latest = await drizzle.creditLedgerRepo.findLatestBalance(
          tx,
          args.subscriberId,
        );
        // Return the already-persisted ledger row for this reference.
        const rows = await tx
          .select()
          .from(drizzle.schema.creditLedger)
          .where(
            and(
              eq(drizzle.schema.creditLedger.subscriberId, args.subscriberId),
              eq(drizzle.schema.creditLedger.referenceType, "purchase"),
              eq(drizzle.schema.creditLedger.referenceId, args.referenceId),
            ),
          )
          .limit(1);
        void latest;
        return rows[0] as CreditLedger;
      }
    }
```

Add the imports `drizzle` (already imported) plus `and, eq` from `drizzle-orm` at the top of `credit-engine.ts`:

```typescript
import { and, eq } from "drizzle-orm";
```

> Note: `findExistingPurchaseCredit` hardcodes `referenceType = "purchase"`, which matches the only consumable-grant call site. `dedupeOnReference` is opt-in, so all other `addCredits` callers (bonus/refund) keep appending unconditionally.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- credit-dedup.integration`
Expected: PASS — one row, balance 100.

- [ ] **Step 5: Switch the receipt handler to the in-lock dedup**

In `apps/api/src/routes/v1/receipts.ts`, replace the pre-lock check block (lines 62-82) with a single delegating call:

```typescript
  if (
    product.type === ProductType.CONSUMABLE &&
    product.creditAmount &&
    product.creditAmount > 0
  ) {
    await addCredits({
      subscriberId: subscriber.id,
      amount: product.creditAmount,
      referenceType: "purchase",
      referenceId: purchase.id,
      description: `Credits for ${product.identifier}`,
      dedupeOnReference: true,
    });
  }
```

This removes the `findExistingPurchaseCredit` call on the lock-less `drizzle.db` handle. The dedup now happens atomically inside `addCredits`.

- [ ] **Step 6: Run the receipts + credits suites**

Run: `pnpm --filter @rovenue/api test -- receipts credits credit-dedup`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/credit-engine.ts apps/api/src/routes/v1/receipts.ts apps/api/tests/credit-dedup.integration.test.ts
git commit -m "fix(api): dedup consumable credits inside advisory lock to stop double-grant race"
```

---

## Branch 1 wrap-up

- [ ] Run the full API test suite: `pnpm --filter @rovenue/api test`. Expected: PASS.
- [ ] Push branch and open PR `fix/concurrency-route-env-credit`. Use superpowers:finishing-a-development-branch.

---

# Branch 2 — Atomic Apple Webhook Claim (#3)

> From updated `main`, create branch: `git checkout -b fix/atomic-webhook-claim`

## Task 5: Add an atomic `claimWebhookEvent` repo function

**Problem:** `upsertWebhookEvent` (webhook-events.ts:86-110) does an upsert whose conflict branch is a no-op `set: { source }`, returning the existing row with whatever status it already had. The handler (apple-webhook.ts:104) only skips when status is `PROCESSED`. Two concurrent deliveries of the same `notificationUUID` both observe `PROCESSING` and both run `dispatch`, which calls `createRevenueEvent` (an append) → MRR double-counted. `revenue_events` is range-partitioned, so a `webhookEventId` unique cannot enforce dedup; the fix is an atomic compare-and-set claim.

**Approach:** `INSERT … ON CONFLICT (source, storeEventId) DO UPDATE SET status = 'PROCESSING' WHERE webhook_events.status NOT IN ('PROCESSING','PROCESSED') RETURNING *`. Semantics:
- **No conflict** (fresh insert) → row returned → caller owns the claim.
- **Conflict, existing status claimable** (e.g. `FAILED`) → updated, row returned → caller re-claims for retry.
- **Conflict, existing status `PROCESSING` or `PROCESSED`** → `setWhere` predicate fails → no row updated → `.returning()` yields nothing → `null` → caller skips.

**Files:**
- Modify: `packages/db/src/drizzle/repositories/webhook-events.ts`
- Test: `packages/db/src/drizzle/repositories/webhook-events.integration.test.ts` (create)

- [ ] **Step 1: Write the failing integration test**

Create `packages/db/src/drizzle/repositories/webhook-events.integration.test.ts`. Seed a project, then fire two concurrent `claimWebhookEvent` calls for the same `(source, storeEventId)` and assert exactly one returns a row (the claim) and the other returns `null`.

```typescript
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { projects } from "../schema";
import * as webhookEventRepo from "./webhook-events";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_whclaim_${RUN_ID}`;
const STORE_EVENT_ID = `uuid_${RUN_ID}`;

describe("claimWebhookEvent", () => {
  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("lets exactly one of two concurrent claims win", async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `WH Claim ${RUN_ID}` });

    const input = {
      projectId: PROJECT_ID,
      source: "APPLE" as const,
      eventType: "DID_RENEW",
      storeEventId: STORE_EVENT_ID,
      payload: { foo: "bar" },
    };

    const [a, b] = await Promise.all([
      webhookEventRepo.claimWebhookEvent(db, input),
      webhookEventRepo.claimWebhookEvent(db, input),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    const losers = [a, b].filter((r) => r === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]?.status).toBe("PROCESSING");
  });

  it("returns null for an already-PROCESSED event", async () => {
    const db = getDb();
    const storeEventId = `uuid_done_${RUN_ID}`;
    const input = {
      projectId: PROJECT_ID,
      source: "APPLE" as const,
      eventType: "DID_RENEW",
      storeEventId,
      payload: {},
    };
    const first = await webhookEventRepo.claimWebhookEvent(db, input);
    expect(first).not.toBeNull();
    await webhookEventRepo.updateWebhookEvent(db, first!.id, {
      status: "PROCESSED",
      processedAt: new Date(),
    });
    const second = await webhookEventRepo.claimWebhookEvent(db, input);
    expect(second).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/db test -- webhook-events.integration`
Expected: FAIL — `claimWebhookEvent` is not defined.

- [ ] **Step 3: Implement `claimWebhookEvent`**

In `packages/db/src/drizzle/repositories/webhook-events.ts`, add `inArray` to the `drizzle-orm` import and add a new export below `upsertWebhookEvent`:

```typescript
export interface ClaimWebhookEventInput {
  projectId: string;
  source: WebhookSource;
  eventType: string;
  storeEventId: string;
  payload: unknown;
}

/**
 * Atomically claim a webhook event for processing. Inserts the row
 * as PROCESSING; on conflict it transitions an existing row to
 * PROCESSING ONLY when its current status is neither PROCESSING nor
 * PROCESSED. Returns the claimed row, or null when another worker
 * already holds (PROCESSING) or finished (PROCESSED) it.
 *
 * This is the single-flight guard for concurrent deliveries of the
 * same (source, storeEventId): exactly one caller gets a row back.
 */
export async function claimWebhookEvent(
  db: DbOrTx,
  input: ClaimWebhookEventInput,
): Promise<WebhookEvent | null> {
  const rows = await db
    .insert(webhookEvents)
    .values({
      projectId: input.projectId,
      source: input.source,
      eventType: input.eventType,
      storeEventId: input.storeEventId,
      payload: input.payload as typeof webhookEvents.$inferInsert.payload,
      status: "PROCESSING",
    })
    .onConflictDoUpdate({
      target: [webhookEvents.source, webhookEvents.storeEventId],
      set: { status: "PROCESSING" },
      setWhere: sql`${webhookEvents.status} NOT IN ('PROCESSING', 'PROCESSED')`,
    })
    .returning();
  return rows[0] ?? null;
}
```

> `sql` is already imported in this file. `setWhere` is Drizzle's `WHERE` on the `DO UPDATE` branch — when it evaluates false, Postgres skips the update and `RETURNING` yields no row, which is exactly the "already claimed/done" signal.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/db test -- webhook-events.integration`
Expected: PASS — one winner, one `null`; PROCESSED event yields `null`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/webhook-events.ts packages/db/src/drizzle/repositories/webhook-events.integration.test.ts
git commit -m "feat(db): add atomic claimWebhookEvent compare-and-set claim"
```

---

## Task 6: Use the atomic claim in the Apple handler

**Files:**
- Modify: `apps/api/src/services/apple/apple-webhook.ts:90-113`
- Test: `apps/api/src/services/apple/apple-webhook.integration.test.ts` (extend if present; else add a focused test)

- [ ] **Step 1: Write/extend the failing test (concurrent dispatch runs once)**

Add a test that drives `handleAppleNotification` twice concurrently with a stubbed verifier returning the same `notificationUUID`, and asserts `dispatch` side effects (e.g. `createRevenueEvent`) happen once — exactly one result has `status: "processed"` and the other `status: "duplicate"`. If an existing `apple-webhook` test file is present, mirror its verifier-stub setup; otherwise create `apps/api/src/services/apple/apple-webhook.concurrency.integration.test.ts` following the verifier-injection pattern already used by `handleAppleNotification` (`opts.verifier`).

```typescript
// Pseudocode skeleton — fill verifier stub from the existing apple
// test harness (search for `verifier:` usages of handleAppleNotification).
import { describe, expect, it } from "vitest";
import { handleAppleNotification } from "./apple-webhook";

describe("handleAppleNotification concurrency", () => {
  it("dispatches a duplicate notificationUUID exactly once", async () => {
    const opts = makeOptsWithStubVerifier(); // same UUID, valid transaction
    const [a, b] = await Promise.all([
      handleAppleNotification(opts),
      handleAppleNotification(opts),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["duplicate", "processed"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- apple-webhook`
Expected: FAIL — both calls return `processed` (both dispatch).

- [ ] **Step 3: Swap upsert+status-read for the atomic claim**

In `apps/api/src/services/apple/apple-webhook.ts`, replace lines 90-113 (the `upsertWebhookEvent` call plus the `if (webhookEvent.status === WebhookEventStatus.PROCESSED)` block) with:

```typescript
  // Atomic single-flight claim — exactly one concurrent worker wins.
  const webhookEvent = await drizzle.webhookEventRepo.claimWebhookEvent(
    drizzle.db,
    {
      projectId: opts.projectId,
      source: WebhookSource.APPLE,
      eventType: notification.notificationType,
      storeEventId: notification.notificationUUID,
      payload: JSON.parse(JSON.stringify(notification)),
    },
  );

  if (!webhookEvent) {
    log.info("notification already claimed or processed, skipping", {
      uuid: notification.notificationUUID,
      type: notification.notificationType,
    });
    return {
      status: "duplicate",
      notificationType: notification.notificationType,
    };
  }
```

The `WebhookEventStatus` import may now be unused for the literal `PROCESSING`; keep it — it is still used by `updateWebhookEvent(... PROCESSED)` in the success path (line 145) and `FAILED` in the catch.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- apple-webhook`
Expected: PASS — one `processed`, one `duplicate`.

- [ ] **Step 5: Run the webhook suites for regressions**

Run: `pnpm --filter @rovenue/api test -- webhook`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/apple/apple-webhook.ts apps/api/src/services/apple/apple-webhook.concurrency.integration.test.ts
git commit -m "fix(api): claim Apple webhook events atomically to stop double-dispatch MRR double-count"
```

> **Follow-up note (out of scope for this task):** the Google/Pub-Sub webhook handler uses the same upsert+status-read pattern — open a tracking issue to migrate it to `claimWebhookEvent` too.

---

## Branch 2 wrap-up

- [ ] Run full API + db suites: `pnpm --filter @rovenue/api test && pnpm --filter @rovenue/db test`. Expected: PASS.
- [ ] Push branch and open PR `fix/atomic-webhook-claim`. Use superpowers:finishing-a-development-branch.

---

# Task 7 (docs-only): Record outbox single-dispatcher + CH dedup contract (#4/#5)

**Problem:** `claimBatch` (`packages/db/src/drizzle/repositories/outbox.ts`) commits the claim tx before publishing to Kafka, and `apps/api/src/index.ts` starts the dispatcher unconditionally in every instance. Running >1 API instance re-claims and re-publishes rows → at-least-once delivery. This is *safe by design* only if ClickHouse dedups on `eventId` (`ReplacingMergeTree`). The contract is undocumented, so horizontal scaling silently risks double-counts if CH dedup is misconfigured. Outgoing-webhook delivery (#5) is similar but already single-flight via BullMQ `concurrency:1` + shared `jobId` and ships `x-rovenue-event-id` for receiver-side dedup — low severity, documented only.

**Files:**
- Create: `docs/architecture/outbox-dispatcher.md`

- [ ] **Step 1: Verify the CH dedup actually covers revenue**

Run: `pnpm --filter @rovenue/db db:verify:clickhouse`
Then confirm the revenue-bearing tables use `ReplacingMergeTree` keyed on the event id. Search the CH migrations:

Run: `grep -rn "ReplacingMergeTree\|ORDER BY" packages/db/clickhouse/migrations/`
Expected: revenue/MRR materialized targets are `ReplacingMergeTree` with the event id in the sort key. If any revenue target is `MergeTree`/`SummingMergeTree` without event-id replacement, STOP and flag — at-least-once outbox delivery would double-count there.

- [ ] **Step 2: Write the doc**

Create `docs/architecture/outbox-dispatcher.md` capturing: (a) the dispatcher is at-least-once (claim commits before publish); (b) running multiple API instances re-publishes rows, so downstream MUST dedup on `eventId`; (c) the exact CH tables and their `ReplacingMergeTree` keys that provide that dedup (from Step 1); (d) the requirement: either run exactly one dispatcher instance, or shard claims by `aggregateId` hash, before scaling the API horizontally; (e) outgoing-webhook delivery is single-flight via BullMQ `concurrency:1` + shared `jobId`, with receiver dedup via `x-rovenue-event-id`.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/outbox-dispatcher.md
git commit -m "docs(architecture): document outbox at-least-once + single-dispatcher requirement"
```

---

## Self-Review

- **Spec coverage:** #6 → Task 1; #8 → Task 2; #2 → Tasks 3-4; #3 → Tasks 5-6; #4/#5 → Task 7. All five verified findings covered.
- **Partitioning correction:** #2 and #3 do **not** use unique indexes (forbidden on range-partitioned tables); both use the existing serialization primitives (advisory lock / atomic compare-and-set). This corrects the original analysis, which proposed a partial unique index.
- **Type consistency:** `dedupeOnReference` (credit-engine) and `claimWebhookEvent` / `ClaimWebhookEventInput` (webhook-events) names are used identically across their defining and calling tasks. `findExistingPurchaseCredit` widened to `DbOrTx` in Task 3 before Task 4 calls it with `tx`.
- **No placeholders:** every code step shows the exact code; the one pseudocode skeleton (Task 6 Step 1) explicitly points to the existing verifier-injection harness to copy, because the stub shape depends on the live `AppleNotificationVerifier` interface.
