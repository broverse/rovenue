# §12.4 Subscription-renewal credit grants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a subscription product grant virtual currency on every renewal
("500 coins a month with Pro"), which today is impossible — grants fire only
for `CONSUMABLE` products at purchase time.

**Architecture:** `product_currency_grants` gains a `grantOn` trigger column.
The renewal grant is driven by a **Kafka consumer group** on the existing
`rovenue.revenue` topic, which `createRevenueEvent`'s outbox row already
publishes to — so none of the eight revenue-event writers is touched. The
consumer only enqueues; a BullMQ worker does the granting, so a transient
failure retries instead of being swallowed the way the integrations fanout
consumer swallows its own. Idempotency comes from `addCredits`'s existing
dedup, not from the job id.

**Tech Stack:** Drizzle + Postgres, kafkajs, BullMQ, prom-client, Vitest
(against the ambient docker-compose stack; a container only if the Kafka
end-to-end test needs an isolated broker).

**Spec:** `docs/superpowers/specs/2026-09-04-roadmap-12-feature-breadth-design.md`
(Sub-project 4)

## Global Constraints

- TDD: a failing test precedes every behaviour change.
- No magic values. `RENEWAL_GRANT_EVENT_TYPES`, `GRANT_TRIGGER_MATCHES`, the
  queue name and the retry policy are all named exported constants.
- Migrations: generate the migration immediately before implementing it and
  **re-check the current head first** — `0119` landed while the spec was being
  written and parallel work may add more.
- A new enum must be re-exported from `packages/db/src/drizzle/schema.ts`, or
  `drizzle-kit` emits a spurious `DROP TYPE` on the next generate.
- New workers declare Prometheus counters in `apps/api/src/lib/metrics.ts`.
- Dashboard strings go through `t()` keys; never interpolate an enum value
  into a key name.
- Postgres access through Drizzle repositories only.
- Throttled test runs: `nice -n 19 npx vitest run --maxWorkers=2`.
- **Do not modify** any `createRevenueEvent` call site, or
  `apps/api/src/services/event-bus.ts`. If a task seems to need that, stop —
  the design is wrong, not the constraint.

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/drizzle/enums.ts` | `currencyGrantTrigger` pgEnum |
| `packages/db/src/drizzle/schema.ts` | `grantOn` column; enum re-export |
| `packages/db/src/drizzle/repositories/product-currency-grants.ts` | trigger-filtered read; grant writes carry `grantOn` |
| `packages/shared/src/virtual-currencies.ts` | `GRANT_TRIGGER_MATCHES` table (shared with the dashboard form) |
| `apps/api/src/services/purchase-credits.ts` | takes a trigger; filters grants |
| `apps/api/src/queues/renewal-grants.ts` | queue name, job shape, job id, retry policy |
| `apps/api/src/services/renewal-grants/consumer.ts` | Kafka consumer: parse, filter, enqueue |
| `apps/api/src/workers/renewal-grant.ts` | BullMQ worker: does the grant |
| `apps/api/src/renewal-grants-boot.ts` | wires consumer + worker + queue |
| `apps/api/src/lib/metrics.ts` | counters |
| `apps/api/src/routes/dashboard/products.ts` | accepts + validates `grantOn` |

---

### Task 1: `grantOn` column and trigger table

**Files:**
- Modify: `packages/db/src/drizzle/enums.ts`
- Modify: `packages/db/src/drizzle/schema.ts` (`productCurrencyGrants`, ~line 723; enum re-export block ~line 2310)
- Create: `packages/db/drizzle/migrations/01xx_currency_grant_trigger.sql` (generated)
- Create: `packages/shared/src/virtual-currencies.grant-trigger.test.ts`
- Modify: `packages/shared/src/virtual-currencies.ts`

**Interfaces:**
- Produces: `currencyGrantTrigger` pgEnum with values `PURCHASE`, `RENEWAL`,
  `BOTH`.
- Produces: `productCurrencyGrants.grantOn` — `NOT NULL DEFAULT 'PURCHASE'`.
- Produces: `export type CurrencyGrantTrigger = "PURCHASE" | "RENEWAL" | "BOTH"`
  and `export type GrantEventTrigger = "PURCHASE" | "RENEWAL"` from
  `@rovenue/shared`.
- Produces: `export function grantTriggerMatches(grantOn: CurrencyGrantTrigger,
  trigger: GrantEventTrigger): boolean` from `@rovenue/shared`.
- Produces: `export function grantTriggersMatching(trigger: GrantEventTrigger):
  CurrencyGrantTrigger[]` from `@rovenue/shared` — the inverse lookup the
  repository uses to build its SQL filter, so the matrix is written once.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/virtual-currencies.grant-trigger.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  grantTriggerMatches,
  grantTriggersMatching,
  type CurrencyGrantTrigger,
  type GrantEventTrigger,
} from "./virtual-currencies";

describe("grantTriggerMatches", () => {
  const cases: Array<[CurrencyGrantTrigger, GrantEventTrigger, boolean]> = [
    ["PURCHASE", "PURCHASE", true],
    ["PURCHASE", "RENEWAL", false],
    ["RENEWAL", "PURCHASE", false],
    ["RENEWAL", "RENEWAL", true],
    ["BOTH", "PURCHASE", true],
    ["BOTH", "RENEWAL", true],
  ];

  test.each(cases)(
    "grantOn=%s trigger=%s -> %s",
    (grantOn, trigger, expected) => {
      expect(grantTriggerMatches(grantOn, trigger)).toBe(expected);
    },
  );

  test("grantTriggersMatching is the inverse of grantTriggerMatches", () => {
    // The repository builds its SQL filter from this. If the two ever
    // disagree, grants silently fire on the wrong events.
    expect(grantTriggersMatching("PURCHASE").sort()).toEqual(["BOTH", "PURCHASE"]);
    expect(grantTriggersMatching("RENEWAL").sort()).toEqual(["BOTH", "RENEWAL"]);
  });

  test("an unknown grantOn never matches", () => {
    // Defensive: a row written by a newer build, read by an older one.
    // Granting on an unrecognised trigger would move real money.
    expect(
      grantTriggerMatches("SOMETHING_NEW" as CurrencyGrantTrigger, "RENEWAL"),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nice -n 19 npx vitest run packages/shared/src/virtual-currencies.grant-trigger.test.ts --maxWorkers=2
```

Expected: FAIL — `grantTriggerMatches` is not exported.

- [ ] **Step 3: Add the trigger table to shared**

Append to `packages/shared/src/virtual-currencies.ts`:

```ts
// =============================================================
// Currency grant triggers
// =============================================================
//
// `grantOn` says which lifecycle events a product's currency grant
// fires on. A grant row is money, so the match is an explicit table
// rather than a string comparison — an unrecognised value must fail
// closed, never fall through to "grant it".

export type CurrencyGrantTrigger = "PURCHASE" | "RENEWAL" | "BOTH";

/** The events that can trigger a grant. `BOTH` is a stored value, never
 *  an event — an event is always one or the other. */
export type GrantEventTrigger = "PURCHASE" | "RENEWAL";

const GRANT_TRIGGER_MATCHES: Record<
  CurrencyGrantTrigger,
  readonly GrantEventTrigger[]
> = {
  PURCHASE: ["PURCHASE"],
  RENEWAL: ["RENEWAL"],
  BOTH: ["PURCHASE", "RENEWAL"],
};

export function grantTriggerMatches(
  grantOn: CurrencyGrantTrigger,
  trigger: GrantEventTrigger,
): boolean {
  return GRANT_TRIGGER_MATCHES[grantOn]?.includes(trigger) ?? false;
}

/**
 * The inverse lookup: which stored `grantOn` values fire on this event.
 * The repository uses this to build its SQL filter, so the matrix above is
 * the ONLY place the mapping is written down. Without it the repository
 * would carry a second hand-maintained copy that can drift silently.
 */
export function grantTriggersMatching(
  trigger: GrantEventTrigger,
): CurrencyGrantTrigger[] {
  return (Object.keys(GRANT_TRIGGER_MATCHES) as CurrencyGrantTrigger[]).filter(
    (grantOn) => grantTriggerMatches(grantOn, trigger),
  );
}
```

If `virtual-currencies.ts` is not already re-exported from
`packages/shared/src/index.ts`, add it.

- [ ] **Step 4: Run it to verify it passes**

```bash
nice -n 19 npx vitest run packages/shared/src/virtual-currencies.grant-trigger.test.ts --maxWorkers=2
```

Expected: PASS (7 assertions).

- [ ] **Step 5: Add the pgEnum**

Append to `packages/db/src/drizzle/enums.ts`:

```ts
// Which lifecycle events a product_currency_grants row fires on.
// PURCHASE is the default so every row that existed before this
// column keeps exactly its previous behaviour.
export const currencyGrantTrigger = pgEnum("CurrencyGrantTrigger", [
  "PURCHASE",
  "RENEWAL",
  "BOTH",
]);
```

- [ ] **Step 6: Add the column and re-export the enum**

In `packages/db/src/drizzle/schema.ts`, add `currencyGrantTrigger` to the
import list from `./enums` (near the existing `featureFlagEnv`,
`featureFlagType` entries), then add the column to `productCurrencyGrants`:

```ts
    amount: integer("amount").notNull(),
    grantOn: currencyGrantTrigger("grantOn").notNull().default("PURCHASE"),
```

Add `currencyGrantTrigger` to the enum re-export block at the bottom of
`schema.ts` (alongside `featureFlagEnv`, `featureFlagType`). **This is not
optional** — an enum imported but not re-exported makes `drizzle-kit` emit a
`DROP TYPE` on the next generate.

- [ ] **Step 7: Generate the migration**

```bash
ls packages/db/drizzle/migrations/*.sql | tail -1   # confirm the current head
pnpm db:migrate:generate
```

Open the generated SQL and confirm it contains only the `CREATE TYPE` and the
`ALTER TABLE ... ADD COLUMN ... DEFAULT 'PURCHASE'`. Delete any unrelated
statement drizzle-kit swept in — hand-written DDL elsewhere in the schema has
been picked up by generate before.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/drizzle/enums.ts packages/db/src/drizzle/schema.ts \
        packages/db/drizzle/migrations packages/shared/src/virtual-currencies.ts \
        packages/shared/src/virtual-currencies.grant-trigger.test.ts \
        packages/shared/src/index.ts
git commit -m "feat(db): add grantOn trigger to product_currency_grants

Defaults to PURCHASE so every existing grant row keeps its current
behaviour and the migration is inert on existing databases."
```

---

### Task 2: Trigger-filtered grant reads and a trigger-aware grant service

**Files:**
- Modify: `packages/db/src/drizzle/repositories/product-currency-grants.ts`
- Modify: `apps/api/src/services/purchase-credits.ts`
- Modify: `apps/api/src/routes/v1/receipts.ts:69` (drop the CONSUMABLE gate)
- Modify: `apps/api/src/services/webhook-processor.ts:304` (drop the CONSUMABLE gate)
- Create: `apps/api/src/services/purchase-credits.test.ts`

**Interfaces:**
- Consumes: `grantTriggerMatches`, `CurrencyGrantTrigger`, `GrantEventTrigger`
  from `@rovenue/shared` (Task 1).
- Produces: `listProductGrantsForTrigger(db: Db, productId: string, trigger:
  GrantEventTrigger): Promise<ProductCurrencyGrantRow[]>` from
  `packages/db/src/drizzle/repositories/product-currency-grants.ts`.
- Produces: `grantProductCurrencies(args: GrantProductCurrenciesArgs):
  Promise<void>` in `apps/api/src/services/purchase-credits.ts`, where
  `GrantProductCurrenciesArgs = { subscriberId: string; productId: string;
  referenceId: string; productIdentifier: string; trigger: GrantEventTrigger }`.
  The existing `grantPurchaseCurrencies` is **renamed** to this; both existing
  call sites are updated in this task.
- Produces: reference types — `"purchase"` when `trigger === "PURCHASE"`,
  `"renewal"` when `"RENEWAL"`. Exported as `GRANT_REFERENCE_TYPE`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/purchase-credits.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";

const { drizzleMock, addCreditsMock } = vi.hoisted(() => ({
  drizzleMock: {
    db: {} as unknown,
    productCurrencyGrantRepo: {
      listProductGrantsForTrigger: vi.fn(async () => [] as unknown[]),
    },
  },
  addCreditsMock: vi.fn(async () => ({ id: "cl_1" })),
}));

vi.mock("@rovenue/db", () => ({ drizzle: drizzleMock }));
vi.mock("./credit-engine", () => ({ addCredits: addCreditsMock }));

import { grantProductCurrencies } from "./purchase-credits";

const SUBSCRIBER_ID = "sub_1";
const PRODUCT_ID = "prd_1";
const REFERENCE_ID = "rev_1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("grantProductCurrencies", () => {
  test("grants each returned row with the renewal reference type", async () => {
    drizzleMock.productCurrencyGrantRepo.listProductGrantsForTrigger.mockResolvedValue(
      [
        { id: "g1", productId: PRODUCT_ID, currencyId: "cur_a", amount: 500, grantOn: "RENEWAL" },
        { id: "g2", productId: PRODUCT_ID, currencyId: "cur_b", amount: 10, grantOn: "BOTH" },
      ],
    );

    await grantProductCurrencies({
      subscriberId: SUBSCRIBER_ID,
      productId: PRODUCT_ID,
      referenceId: REFERENCE_ID,
      productIdentifier: "pro_monthly",
      trigger: "RENEWAL",
    });

    expect(addCreditsMock).toHaveBeenCalledTimes(2);
    expect(addCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriberId: SUBSCRIBER_ID,
        currencyId: "cur_a",
        amount: 500,
        referenceType: "renewal",
        referenceId: REFERENCE_ID,
        dedupeOnReference: true,
      }),
    );
  });

  test("uses the purchase reference type on the purchase trigger", async () => {
    drizzleMock.productCurrencyGrantRepo.listProductGrantsForTrigger.mockResolvedValue(
      [{ id: "g1", productId: PRODUCT_ID, currencyId: "cur_a", amount: 5, grantOn: "PURCHASE" }],
    );

    await grantProductCurrencies({
      subscriberId: SUBSCRIBER_ID,
      productId: PRODUCT_ID,
      referenceId: REFERENCE_ID,
      productIdentifier: "coins_100",
      trigger: "PURCHASE",
    });

    // A distinct referenceType is what stops a consumable purchase and a
    // renewal that share a reference id from collapsing into one another.
    expect(addCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({ referenceType: "purchase" }),
    );
  });

  test("writes nothing when the product has no matching grant rows", async () => {
    drizzleMock.productCurrencyGrantRepo.listProductGrantsForTrigger.mockResolvedValue([]);

    await grantProductCurrencies({
      subscriberId: SUBSCRIBER_ID,
      productId: PRODUCT_ID,
      referenceId: REFERENCE_ID,
      productIdentifier: "pro_monthly",
      trigger: "RENEWAL",
    });

    expect(addCreditsMock).not.toHaveBeenCalled();
  });

  test("skips non-positive amounts", async () => {
    drizzleMock.productCurrencyGrantRepo.listProductGrantsForTrigger.mockResolvedValue(
      [{ id: "g1", productId: PRODUCT_ID, currencyId: "cur_a", amount: 0, grantOn: "RENEWAL" }],
    );

    await grantProductCurrencies({
      subscriberId: SUBSCRIBER_ID,
      productId: PRODUCT_ID,
      referenceId: REFERENCE_ID,
      productIdentifier: "pro_monthly",
      trigger: "RENEWAL",
    });

    expect(addCreditsMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nice -n 19 npx vitest run apps/api/src/services/purchase-credits.test.ts --maxWorkers=2
```

Expected: FAIL — `grantProductCurrencies` is not exported.

- [ ] **Step 3: Add the trigger-filtered repository read**

In `packages/db/src/drizzle/repositories/product-currency-grants.ts`, add:

```ts
import { and, eq, inArray } from "drizzle-orm";
import { grantTriggersMatching, type GrantEventTrigger } from "@rovenue/shared";

/**
 * Grants for a product that fire on `trigger`. Filtering in SQL rather
 * than in the caller keeps the renewal hot path to one indexed read that
 * returns nothing at all for the overwhelmingly common case — a
 * subscription with no currency grants configured.
 */
export async function listProductGrantsForTrigger(
  db: Db,
  productId: string,
  trigger: GrantEventTrigger,
): Promise<ProductCurrencyGrantRow[]> {
  // Derived from the shared matrix, never re-hardcoded here.
  const matching = grantTriggersMatching(trigger);

  return db
    .select()
    .from(productCurrencyGrants)
    .where(
      and(
        eq(productCurrencyGrants.productId, productId),
        inArray(productCurrencyGrants.grantOn, matching),
      ),
    );
}
```

Also extend `setProductGrants` to carry `grantOn` (defaulting to `PURCHASE`
when a caller omits it):

```ts
export async function setProductGrants(
  db: Db,
  productId: string,
  grants: Array<{ currencyId: string; amount: number; grantOn?: CurrencyGrantTrigger }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(productCurrencyGrants)
      .where(eq(productCurrencyGrants.productId, productId));
    if (grants.length > 0) {
      await tx.insert(productCurrencyGrants).values(
        grants.map((g) => ({
          productId,
          currencyId: g.currencyId,
          amount: g.amount,
          grantOn: g.grantOn ?? "PURCHASE",
        })),
      );
    }
  });
}
```

Import `CurrencyGrantTrigger` from `@rovenue/shared` at the top.

- [ ] **Step 4: Rewrite the grant service**

Replace the body of `apps/api/src/services/purchase-credits.ts`:

```ts
import { drizzle } from "@rovenue/db";
import type { GrantEventTrigger } from "@rovenue/shared";
import { addCredits } from "./credit-engine";

// =============================================================
// purchase-credits — product currency grant service
// =============================================================
//
// Grants every virtual currency configured on a product for a given
// lifecycle trigger. Idempotent: addCredits dedupes on
// (referenceType, referenceId, currencyId), so a duplicate webhook or a
// Kafka redelivery grants nothing further.
//
// The two reference types are deliberately distinct. A consumable
// purchase keyed on a purchaseId and a renewal keyed on a
// revenueEventId could in principle collide; a shared referenceType
// would let one silently swallow the other.

export const GRANT_REFERENCE_TYPE: Record<GrantEventTrigger, string> = {
  PURCHASE: "purchase",
  RENEWAL: "renewal",
};

export interface GrantProductCurrenciesArgs {
  subscriberId: string;
  productId: string;
  /** purchaseId for PURCHASE, revenueEventId for RENEWAL. */
  referenceId: string;
  productIdentifier: string;
  trigger: GrantEventTrigger;
}

export async function grantProductCurrencies(
  args: GrantProductCurrenciesArgs,
): Promise<void> {
  const grants =
    await drizzle.productCurrencyGrantRepo.listProductGrantsForTrigger(
      drizzle.db,
      args.productId,
      args.trigger,
    );

  for (const grant of grants) {
    if (grant.amount <= 0) continue;
    await addCredits({
      subscriberId: args.subscriberId,
      currencyId: grant.currencyId,
      amount: grant.amount,
      referenceType: GRANT_REFERENCE_TYPE[args.trigger],
      referenceId: args.referenceId,
      description: `Credits for ${args.productIdentifier}`,
      dedupeOnReference: true,
    });
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

```bash
nice -n 19 npx vitest run apps/api/src/services/purchase-credits.test.ts --maxWorkers=2
```

Expected: PASS (4 tests).

- [ ] **Step 6: Update the two existing call sites**

In `apps/api/src/routes/v1/receipts.ts` around line 69, replace:

```ts
  if (product.type === ProductType.CONSUMABLE) {
    await grantPurchaseCurrencies({
```

with:

```ts
  // No product-type gate: whether a grant fires is decided by the
  // product's grant rows and their trigger, not by the product's type.
  await grantProductCurrencies({
```

Keep the existing argument values, renaming `purchaseId` to `referenceId` and
adding `trigger: "PURCHASE"`. Remove the now-unused `ProductType` import if
nothing else in the file uses it — and check, because it usually does.

Apply the same change in `apps/api/src/services/webhook-processor.ts` around
line 304, where the guard reads
`if (purchase.product.type !== ProductType.CONSUMABLE) return;`.

- [ ] **Step 7: Run the affected suites**

```bash
nice -n 19 npx vitest run apps/api/src/services/purchase-credits.test.ts \
  apps/api/src/services/webhook-processor apps/api/tests --maxWorkers=2
```

Expected: PASS. If a pre-existing test fails because a non-consumable product
now reaches the grant service, read it before touching it — that test may be
asserting the old gate on purpose, in which case update its expectation and
say so in the commit. If it fails for any other reason, stop.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/drizzle/repositories/product-currency-grants.ts \
        apps/api/src/services/purchase-credits.ts \
        apps/api/src/services/purchase-credits.test.ts \
        apps/api/src/routes/v1/receipts.ts \
        apps/api/src/services/webhook-processor.ts
git commit -m "feat(credits): grant by trigger instead of by product type

grantPurchaseCurrencies becomes grantProductCurrencies and takes an
explicit PURCHASE/RENEWAL trigger. The CONSUMABLE-only gate is replaced
by the honest condition: does this product have grant rows for this
trigger."
```

---

### Task 3: Renewal-grant queue, worker and metrics

**Files:**
- Create: `apps/api/src/queues/renewal-grants.ts`
- Create: `apps/api/src/workers/renewal-grant.ts`
- Create: `apps/api/src/workers/renewal-grant.test.ts`
- Modify: `apps/api/src/lib/metrics.ts`

**Interfaces:**
- Consumes: `grantProductCurrencies` (Task 2).
- Produces: `RENEWAL_GRANT_QUEUE_NAME = "rovenue-renewal-grants"`.
- Produces: `interface RenewalGrantJob { revenueEventId: string; projectId:
  string; subscriberId: string; productId: string; type: string }`.
- Produces: `buildRenewalGrantJobId(outboxEventId: string): string`.
- Produces: `renewalGrantJobOptions(jobId: string): JobsOptions`.
- Produces: `runRenewalGrant(job: RenewalGrantJob, deps: RenewalGrantDeps):
  Promise<"granted" | "skipped">` — the pure function, DI'd for unit tests.
- Produces: `ensureRenewalGrantWorker(opts?: { autoStart?: boolean }):
  Promise<{ stop: () => Promise<void> }>`.
- Produces: counters `renewalGrantsAppliedTotal`,
  `renewalGrantsFailedTotal` (labelled `reason`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/workers/renewal-grant.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";
import { runRenewalGrant } from "./renewal-grant";
import type { RenewalGrantJob } from "../queues/renewal-grants";

const job: RenewalGrantJob = {
  revenueEventId: "rev_1",
  projectId: "prj_1",
  subscriberId: "sub_1",
  productId: "prd_1",
  type: "RENEWAL",
};

let grant: ReturnType<typeof vi.fn>;
let loadProduct: ReturnType<typeof vi.fn>;

beforeEach(() => {
  grant = vi.fn(async () => {});
  loadProduct = vi.fn(async (_projectId: string, _productId: string) => ({
    identifier: "pro_monthly",
  }));
});

describe("runRenewalGrant", () => {
  test("grants with the RENEWAL trigger keyed on the revenue event id", async () => {
    const result = await runRenewalGrant(job, { grant, loadProduct });

    expect(result).toBe("granted");
    expect(grant).toHaveBeenCalledWith({
      subscriberId: "sub_1",
      productId: "prd_1",
      referenceId: "rev_1",
      productIdentifier: "pro_monthly",
      trigger: "RENEWAL",
    });
  });

  test("skips an event type that is not a granting type", async () => {
    const result = await runRenewalGrant(
      { ...job, type: "INITIAL" },
      { grant, loadProduct },
    );

    // INITIAL is the PURCHASE trigger's event. If it also granted here, a
    // BOTH row would grant twice on day one.
    expect(result).toBe("skipped");
    expect(grant).not.toHaveBeenCalled();
  });

  test.each(["RENEWAL", "TRIAL_CONVERSION", "REACTIVATION"])(
    "%s is a granting type",
    async (type) => {
      const result = await runRenewalGrant({ ...job, type }, { grant, loadProduct });
      expect(result).toBe("granted");
    },
  );

  test.each(["INITIAL", "REFUND", "CANCELLATION", "CREDIT_PURCHASE"])(
    "%s is not a granting type",
    async (type) => {
      const result = await runRenewalGrant({ ...job, type }, { grant, loadProduct });
      expect(result).toBe("skipped");
    },
  );

  test("skips when the product no longer exists", async () => {
    loadProduct.mockResolvedValue(null);

    const result = await runRenewalGrant(job, { grant, loadProduct });

    expect(result).toBe("skipped");
    expect(grant).not.toHaveBeenCalled();
  });

  test("propagates a grant failure so BullMQ retries it", async () => {
    grant.mockRejectedValue(new Error("db down"));

    // This is the property that separates this worker from the
    // integrations fanout consumer, which logs and swallows. A swallowed
    // error here would lose a subscriber's credits permanently.
    await expect(runRenewalGrant(job, { grant, loadProduct })).rejects.toThrow(
      "db down",
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nice -n 19 npx vitest run apps/api/src/workers/renewal-grant.test.ts --maxWorkers=2
```

Expected: FAIL — module `./renewal-grant` not found.

- [ ] **Step 3: Write the queue module**

Create `apps/api/src/queues/renewal-grants.ts`:

```ts
import type { JobsOptions } from "bullmq";

// =============================================================
// renewal-grants queue
// =============================================================

export const RENEWAL_GRANT_QUEUE_NAME = "rovenue-renewal-grants";

/** Revenue-event types that grant currency on the RENEWAL trigger.
 *  INITIAL is deliberately absent: it is the PURCHASE trigger's event,
 *  and matching both would double-grant a BOTH row on day one. */
export const RENEWAL_GRANT_EVENT_TYPES: readonly string[] = [
  "RENEWAL",
  "TRIAL_CONVERSION",
  "REACTIVATION",
];

export const RENEWAL_GRANT_ATTEMPTS = 5;
export const RENEWAL_GRANT_BACKOFF_MS = 5_000;

export interface RenewalGrantJob {
  revenueEventId: string;
  projectId: string;
  subscriberId: string;
  productId: string;
  /** revenueEventType enum value as it appeared on the outbox payload. */
  type: string;
}

/**
 * Deterministic job id so an obvious Kafka redelivery collapses before it
 * reaches the worker.
 *
 * This is an OPTIMISATION, never the correctness guarantee: BullMQ retains
 * completed job ids only for the `removeOnComplete` window, so a redelivery
 * arriving after eviction re-runs. That is safe because addCredits dedupes
 * on (referenceType, referenceId, currencyId) — which is the real guarantee.
 * Do not remove that dedup on the strength of this job id.
 */
export function buildRenewalGrantJobId(outboxEventId: string): string {
  // BullMQ v5 rejects custom job ids containing ':' unless they have
  // exactly 3 colon-delimited segments, so no colons here.
  return `renewal-grant-${outboxEventId}`;
}

export function renewalGrantJobOptions(jobId: string): JobsOptions {
  return {
    jobId,
    attempts: RENEWAL_GRANT_ATTEMPTS,
    backoff: { type: "exponential", delay: RENEWAL_GRANT_BACKOFF_MS },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: { age: 7 * 86_400 },
  };
}
```

- [ ] **Step 4: Write the worker**

Create `apps/api/src/workers/renewal-grant.ts`:

```ts
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { grantProductCurrencies } from "../services/purchase-credits";
import {
  RENEWAL_GRANT_EVENT_TYPES,
  RENEWAL_GRANT_QUEUE_NAME,
  type RenewalGrantJob,
} from "../queues/renewal-grants";
import {
  renewalGrantsAppliedTotal,
  renewalGrantsFailedTotal,
} from "../lib/metrics";

const log = logger.child("renewal-grant");

export interface RenewalGrantDeps {
  grant: (args: {
    subscriberId: string;
    productId: string;
    referenceId: string;
    productIdentifier: string;
    trigger: "RENEWAL";
  }) => Promise<void>;
  /** Project-scoped: findProductById is (db, projectId, id), and a
   *  product id must never be resolved across project boundaries. */
  loadProduct: (
    projectId: string,
    productId: string,
  ) => Promise<{ identifier: string } | null>;
}

/**
 * Pure job body. Throws on failure — BullMQ's retry is the delivery
 * guarantee, so swallowing here would silently lose a grant.
 */
export async function runRenewalGrant(
  job: RenewalGrantJob,
  deps: RenewalGrantDeps,
): Promise<"granted" | "skipped"> {
  if (!RENEWAL_GRANT_EVENT_TYPES.includes(job.type)) return "skipped";

  const product = await deps.loadProduct(job.projectId, job.productId);
  if (!product) {
    log.warn("product missing for renewal grant", {
      productId: job.productId,
      revenueEventId: job.revenueEventId,
    });
    return "skipped";
  }

  await deps.grant({
    subscriberId: job.subscriberId,
    productId: job.productId,
    referenceId: job.revenueEventId,
    productIdentifier: product.identifier,
    trigger: "RENEWAL",
  });

  return "granted";
}

const liveDeps: RenewalGrantDeps = {
  grant: (args) => grantProductCurrencies(args),
  loadProduct: async (projectId, productId) => {
    const product = await drizzle.productRepo.findProductById(
      drizzle.db,
      projectId,
      productId,
    );
    return product ? { identifier: product.identifier } : null;
  },
};

export async function ensureRenewalGrantWorker(
  opts: { autoStart?: boolean } = {},
): Promise<{ stop: () => Promise<void> }> {
  if (opts.autoStart === false) return { stop: async () => {} };

  const connection = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });

  const worker = new Worker<RenewalGrantJob>(
    RENEWAL_GRANT_QUEUE_NAME,
    async (job) => {
      try {
        const outcome = await runRenewalGrant(job.data, liveDeps);
        if (outcome === "granted") renewalGrantsAppliedTotal.inc();
        return outcome;
      } catch (err) {
        renewalGrantsFailedTotal.inc({
          reason: err instanceof Error ? err.name : "unknown",
        });
        throw err;
      }
    },
    { connection },
  );

  return {
    stop: async () => {
      await worker.close();
      await connection.quit();
    },
  };
}
```

`findProductById` is confirmed to exist with the signature
`(db: Db, projectId: string, id: string): Promise<Product | null>`, exported
through the `drizzle.productRepo` namespace. `assertTopics` (used in Task 4)
is confirmed exported from `apps/api/src/workers/outbox-dispatcher.ts`, and
`getKafka` from `apps/api/src/lib/kafka.ts`.

- [ ] **Step 5: Add the counters**

Append to `apps/api/src/lib/metrics.ts`:

```ts
// Incremented once per renewal that actually granted currency.
export const renewalGrantsAppliedTotal = new Counter({
  name: "rovenue_renewal_grants_applied_total",
  help: "Renewal events that granted product currency",
  registers: [registry],
});

// Incremented on every failed grant attempt, before BullMQ retries it.
// A steady low rate is transient infrastructure; a sustained rate means
// renewals are reaching their attempt ceiling and credits are not landing.
export const renewalGrantsFailedTotal = new Counter({
  name: "rovenue_renewal_grants_failed_total",
  help: "Renewal grant attempts that threw, by error name",
  labelNames: ["reason"] as const,
  registers: [registry],
});
```

- [ ] **Step 6: Run it to verify it passes**

```bash
nice -n 19 npx vitest run apps/api/src/workers/renewal-grant.test.ts --maxWorkers=2
```

Expected: PASS (12 tests including the `test.each` expansions).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/queues/renewal-grants.ts apps/api/src/workers/renewal-grant.ts \
        apps/api/src/workers/renewal-grant.test.ts apps/api/src/lib/metrics.ts
git commit -m "feat(credits): renewal-grant queue and worker

The worker rethrows on failure so BullMQ retries; swallowing would lose
a subscriber's credits permanently. Job id dedup is an optimisation --
addCredits' reference dedup remains the real idempotency guarantee."
```

---

### Task 4: Kafka consumer on `rovenue.revenue`

**Files:**
- Create: `apps/api/src/services/renewal-grants/consumer.ts`
- Create: `apps/api/src/services/renewal-grants/consumer.test.ts`
- Create: `apps/api/src/renewal-grants-boot.ts`
- Modify: `apps/api/src/index.ts` (boot the handle alongside `bootIntegrations`)

**Interfaces:**
- Consumes: `RenewalGrantJob`, `buildRenewalGrantJobId`,
  `renewalGrantJobOptions`, `RENEWAL_GRANT_QUEUE_NAME` (Task 3).
- Consumes: `AGGREGATE_TO_TOPIC.REVENUE_EVENT` — the string
  `"rovenue.revenue"` — from `apps/api/src/lib/outbox-topics.ts`. Read it from
  the map; do not hard-code the topic name.
- Produces: `RENEWAL_GRANT_CONSUMER_GROUP = "rovenue-renewal-grants"`.
- Produces: `toRenewalGrantJob(raw: unknown): { job: RenewalGrantJob;
  outboxEventId: string } | null` — pure, unit-testable parse.
- Produces: `startRenewalGrantConsumer(deps: { enqueue: (job:
  RenewalGrantJob, jobId: string) => Promise<void> }): Promise<{ stop: () =>
  Promise<void> }>`.
- Produces: `bootRenewalGrants(opts?: { autoStart?: boolean }):
  Promise<{ stop: () => Promise<void> }>`.

**Background:** the outbox payload shape is defined by `publishRevenueEvent` in
`apps/api/src/services/event-bus.ts` and carries `revenueEventId`, `projectId`,
`subscriberId`, `purchaseId`, `productId`, `type`, `store`, `amount`,
`amountUsd`, `currency`, `eventDate`. The dispatcher wraps it — read
`apps/api/src/workers/outbox-dispatcher.ts` around line 186 to see the exact
envelope written to Kafka, and confirm where `outboxEventId` and the payload
sit before writing the parser.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/renewal-grants/consumer.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { toRenewalGrantJob } from "./consumer";

// Shape confirmed against outbox-dispatcher.ts's Kafka envelope.
function message(overrides: Record<string, unknown> = {}) {
  return {
    outboxEventId: "obx_1",
    eventType: "revenue.event.recorded",
    payload: {
      revenueEventId: "rev_1",
      projectId: "prj_1",
      subscriberId: "sub_1",
      purchaseId: "pur_1",
      productId: "prd_1",
      type: "RENEWAL",
      store: "APP_STORE",
      amount: "9.9900",
      amountUsd: "9.9900",
      currency: "USD",
      eventDate: "2026-09-04T00:00:00.000Z",
      ...overrides,
    },
  };
}

describe("toRenewalGrantJob", () => {
  test("maps a renewal envelope onto a job", () => {
    const result = toRenewalGrantJob(message());

    expect(result).toEqual({
      outboxEventId: "obx_1",
      job: {
        revenueEventId: "rev_1",
        projectId: "prj_1",
        subscriberId: "sub_1",
        productId: "prd_1",
        type: "RENEWAL",
      },
    });
  });

  test("returns null for a non-granting event type", () => {
    // Filtered at the consumer so the queue never carries work the
    // worker would only discard.
    expect(toRenewalGrantJob(message({ type: "REFUND" }))).toBeNull();
  });

  test("returns null when a required field is missing", () => {
    expect(toRenewalGrantJob(message({ productId: undefined }))).toBeNull();
    expect(toRenewalGrantJob(message({ subscriberId: null }))).toBeNull();
  });

  test("returns null for a shape it does not recognise", () => {
    expect(toRenewalGrantJob(null)).toBeNull();
    expect(toRenewalGrantJob({})).toBeNull();
    expect(toRenewalGrantJob({ payload: "not an object" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nice -n 19 npx vitest run apps/api/src/services/renewal-grants/consumer.test.ts --maxWorkers=2
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the consumer**

Create `apps/api/src/services/renewal-grants/consumer.ts`:

```ts
import { getKafka } from "../../lib/kafka";
import { logger } from "../../lib/logger";
import { AGGREGATE_TO_TOPIC } from "../../lib/outbox-topics";
import {
  RENEWAL_GRANT_EVENT_TYPES,
  buildRenewalGrantJobId,
  type RenewalGrantJob,
} from "../../queues/renewal-grants";

// =============================================================
// renewal-grants Kafka consumer
// =============================================================
//
// A SECOND consumer group on rovenue.revenue, independent of
// rovenue-integrations-fanout, so a slow or failing grant cannot stall
// integration delivery and vice versa.
//
// This consumer does no work of its own: it parses, filters and
// enqueues. The grant runs in the BullMQ worker because THAT is where
// retries live. The fanout consumer next door logs its errors and
// returns, which commits the offset and drops the message — correct
// there, because BullMQ behind it owns the retry. Doing the same here
// would silently lose a subscriber's credits.

const log = logger.child("renewal-grants-consumer");

export const RENEWAL_GRANT_CONSUMER_GROUP = "rovenue-renewal-grants";

const REVENUE_TOPIC = AGGREGATE_TO_TOPIC.REVENUE_EVENT;

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function toRenewalGrantJob(
  raw: unknown,
): { job: RenewalGrantJob; outboxEventId: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const envelope = raw as Record<string, unknown>;

  const outboxEventId = str(envelope.outboxEventId);
  const payload = envelope.payload;
  if (!outboxEventId || typeof payload !== "object" || payload === null) {
    return null;
  }

  const p = payload as Record<string, unknown>;
  const type = str(p.type);
  if (!type || !RENEWAL_GRANT_EVENT_TYPES.includes(type)) return null;

  const revenueEventId = str(p.revenueEventId);
  const projectId = str(p.projectId);
  const subscriberId = str(p.subscriberId);
  const productId = str(p.productId);
  if (!revenueEventId || !projectId || !subscriberId || !productId) return null;

  return {
    outboxEventId,
    job: { revenueEventId, projectId, subscriberId, productId, type },
  };
}

export interface RenewalGrantConsumerDeps {
  enqueue: (job: RenewalGrantJob, jobId: string) => Promise<void>;
}

export async function startRenewalGrantConsumer(
  deps: RenewalGrantConsumerDeps,
): Promise<{ stop: () => Promise<void> }> {
  const kafka = getKafka();
  if (!kafka) {
    log.warn("KAFKA_BROKERS not set — renewal grant consumer disabled");
    return { stop: async () => {} };
  }

  const consumer = kafka.consumer({ groupId: RENEWAL_GRANT_CONSUMER_GROUP });
  await consumer.connect();
  await consumer.subscribe({ topic: REVENUE_TOPIC, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      const rawValue = message.value?.toString() ?? "";
      if (!rawValue) return;

      let parsed: ReturnType<typeof toRenewalGrantJob>;
      try {
        parsed = toRenewalGrantJob(JSON.parse(rawValue));
      } catch (err) {
        // Unparseable JSON can never become parseable — committing the
        // offset is right. A grant that merely FAILED must not take this
        // path; that is why enqueue below is allowed to throw.
        log.error("parse_failed", {
          err: err instanceof Error ? err.message : String(err),
          rawPreview: rawValue.slice(0, 200),
        });
        return;
      }

      if (!parsed) return;

      // Deliberately NOT wrapped in try/catch. A failed enqueue must
      // reject so kafkajs does not advance the offset and the message is
      // redelivered.
      await deps.enqueue(
        parsed.job,
        buildRenewalGrantJobId(parsed.outboxEventId),
      );
    },
  });

  log.info("started", {
    topic: REVENUE_TOPIC,
    groupId: RENEWAL_GRANT_CONSUMER_GROUP,
  });

  let stopped = false;
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await consumer.disconnect();
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
nice -n 19 npx vitest run apps/api/src/services/renewal-grants/consumer.test.ts --maxWorkers=2
```

Expected: PASS (6 assertions across 4 tests).

- [ ] **Step 5: Write the boot module**

Create `apps/api/src/renewal-grants-boot.ts`, mirroring
`integrations-boot.ts`:

```ts
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "./lib/env";
import { attachRedisErrorLogger } from "./lib/redis";
import { startRenewalGrantConsumer } from "./services/renewal-grants/consumer";
import { ensureRenewalGrantWorker } from "./workers/renewal-grant";
import { assertTopics } from "./workers/outbox-dispatcher";
import { AGGREGATE_TO_TOPIC } from "./lib/outbox-topics";
import {
  RENEWAL_GRANT_QUEUE_NAME,
  renewalGrantJobOptions,
  type RenewalGrantJob,
} from "./queues/renewal-grants";

export interface RenewalGrantsBootHandle {
  stop: () => Promise<void>;
}

export async function bootRenewalGrants(
  opts: { autoStart?: boolean } = {},
): Promise<RenewalGrantsBootHandle> {
  if (opts.autoStart === false) return { stop: async () => {} };

  const workerHandle = await ensureRenewalGrantWorker({ autoStart: true });

  const connection = attachRedisErrorLogger(
    new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
    "renewal-grants-boot-queue",
  );

  const queue = new Queue<RenewalGrantJob>(RENEWAL_GRANT_QUEUE_NAME, {
    connection,
  });

  // No-op when KAFKA_BROKERS is unset.
  await assertTopics([AGGREGATE_TO_TOPIC.REVENUE_EVENT]);

  const consumer = await startRenewalGrantConsumer({
    enqueue: async (job, jobId) => {
      await queue.add("grant", job, renewalGrantJobOptions(jobId));
    },
  });

  return {
    stop: async () => {
      await consumer.stop();
      await workerHandle.stop();
      await queue.close();
      await connection.quit();
    },
  };
}
```

- [ ] **Step 6: Boot it**

In `apps/api/src/index.ts`, beside the existing line 328
`const integrationsHandle = bootIntegrations();`, add:

```ts
// bootRenewalGrants() no-ops gracefully when KAFKA_BROKERS is unset.
const renewalGrantsHandle = bootRenewalGrants();
```

with the matching import, and add its `stop()` wherever
`integrationsHandle` is torn down. Read the surrounding shutdown code
before editing — copy how `integrationsHandle` is awaited, do not invent a
new pattern.

- [ ] **Step 7: Type-check and commit**

```bash
nice -n 19 npx tsc --noEmit -p apps/api
nice -n 19 npx vitest run apps/api/src/services/renewal-grants apps/api/src/workers/renewal-grant.test.ts --maxWorkers=2
```

Expected: clean, PASS.

```bash
git add apps/api/src/services/renewal-grants apps/api/src/renewal-grants-boot.ts apps/api/src/index.ts
git commit -m "feat(credits): consume rovenue.revenue for renewal grants

A second consumer group beside rovenue-integrations-fanout. The consumer
parses, filters and enqueues only; a failed enqueue rejects so the offset
is not advanced. None of the eight createRevenueEvent call sites change."
```

---

### Task 5: End-to-end integration test

**Files:**
- Create: `apps/api/src/workers/renewal-grant.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: nothing further tasks depend on.

**Why this test is not optional:** every other consumer of `rovenue.revenue`
in this repo is integration delivery, which is *allowed* to drop a message.
This is the test that proves this consumer is not. The unit tests above pin
the pieces; only this one proves the wiring.

**Test harness — read this before writing the file.** This repo has **no
per-file testcontainers bootstrap and no `withTestDb`/`seedProject` helper**.
`apps/api/tests/setup.ts` points the suite at the ambient docker-compose dev
stack (Postgres host 5433, Redis 6380, Redpanda 19092, ClickHouse 8124) and
tests seed inline with `getDb()` plus direct Drizzle inserts. Follow
`apps/api/src/workers/access-reconciliation.integration.test.ts`, which states
this convention explicitly and is the closest model.

Two consequences:
- Bring the stack up first (`docker compose up -d`). "Docker running" is not
  the same as "the stack is up".
- Seed fixtures with direct SQL/inserts, never by calling the code under test.
  A test that builds its baseline through the same writer it is checking
  asserts only that the writer agrees with itself.

**This file starts its own container, so it must be registered in two
places** or it will run at full worker concurrency and die intermittently
with `(HTTP code 409) container stopped/paused`:
1. Add its path to `CONTAINER_SUITES` in `apps/api/vitest.config.ts` — that
   second pass runs with concurrency turned down.
2. Pin its host port and register that pin in
   `apps/api/tests/host-port-allocations.test.ts`, which keeps the pins
   unique. The port must be known before the container starts, because a
   Kafka client connects on the address the broker advertises.

Also give this file its own queue-name suffix: three existing real-infra
integration files already share a queue name and hardcoded DB/Redis, and
collide when run together.

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// Seeds inline against the ambient stack via getDb(), following
// access-reconciliation.integration.test.ts. If this file ends up
// starting its own Redpanda, mutate `env` in place -- the clients in
// this repo read a frozen env object, so reassigning process.env after
// import has no effect.

describe("renewal grant end to end", () => {
  test("a renewal revenue event grants the product's RENEWAL currency once", async () => {
    // 1. Seed: a project, a virtual currency, a SUBSCRIPTION product, and a
    //    product_currency_grants row with amount 500 and grantOn 'RENEWAL'.
    // 2. Write a RENEWAL revenue event through
    //    drizzle.revenueEventRepo.createRevenueEvent -- the real writer, so
    //    the outbox row is produced the way production produces it.
    // 3. Read the outbox row back and hand its Kafka envelope to
    //    toRenewalGrantJob + runRenewalGrant with LIVE deps (not mocks),
    //    which is the same path bootRenewalGrants wires up.
    // 4. Assert the subscriber's balance for that currency is 500.

    // 5. Run the same job a second time with the same revenueEventId.
    //    Assert the balance is STILL 500 -- this is the redelivery case,
    //    and addCredits' reference dedup is what must catch it.
  });

  test("an INITIAL revenue event grants nothing on the renewal path", async () => {
    // Same seed, but a revenue event of type INITIAL. Assert the balance
    // stays 0: a BOTH row must not grant twice on day one.
  });
});
```

Fill in each numbered comment with real code following the referenced harness.
The comments are the assertions to write, not placeholders to leave.

- [ ] **Step 2: Run it**

```bash
docker ps   # vitest hangs silently when Docker is down
nice -n 19 npx vitest run apps/api/src/workers/renewal-grant.integration.test.ts --maxWorkers=2
```

Expected: PASS. If a new migration means the cached template database is
stale, drop `rovenue_test_tpl` and re-run.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/workers/renewal-grant.integration.test.ts
git commit -m "test(credits): end-to-end renewal grant with redelivery

Proves the grant lands from a real createRevenueEvent write, and that a
second delivery of the same revenue event grants nothing further."
```

---

### Task 6: Dashboard `grantOn` selector

**Files:**
- Modify: `apps/api/src/routes/dashboard/products.ts` (grant body schema + validation)
- Modify: the dashboard product editor's currency-grants section (locate with
  `grep -rn "currencyId" apps/dashboard/src/components | grep -i grant`)
- Modify: the dashboard i18n message catalogue
- Create/modify: the corresponding dashboard route test

**Interfaces:**
- Consumes: `CurrencyGrantTrigger` from `@rovenue/shared` (Task 1).
- Produces: `grantOn` accepted on the product grants write path, defaulting to
  `PURCHASE` when omitted so existing API clients are unaffected.

- [ ] **Step 1: Write the failing test**

Add to the products dashboard route test:

```ts
test("rejects RENEWAL grantOn on a non-subscription product", async () => {
  const res = await app.request(`/dashboard/products/${consumableProductId}/grants`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      grants: [{ currencyId, amount: 100, grantOn: "RENEWAL" }],
    }),
  });

  // Server-side, not form-side: a consumable never renews, so a RENEWAL
  // grant on one would be configured and then silently never fire.
  expect(res.status).toBe(400);
});

test("accepts RENEWAL grantOn on a subscription product", async () => {
  const res = await app.request(`/dashboard/products/${subscriptionProductId}/grants`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      grants: [{ currencyId, amount: 500, grantOn: "RENEWAL" }],
    }),
  });

  expect(res.status).toBe(200);
});

test("defaults grantOn to PURCHASE when omitted", async () => {
  const res = await app.request(`/dashboard/products/${consumableProductId}/grants`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ grants: [{ currencyId, amount: 100 }] }),
  });

  expect(res.status).toBe(200);
  const rows = await drizzle.productCurrencyGrantRepo.listProductGrants(
    drizzle.db,
    consumableProductId,
  );
  expect(rows[0]?.grantOn).toBe("PURCHASE");
});
```

Adapt the request shape to the route's actual signature — read it first.

- [ ] **Step 2: Run it to verify it fails**

```bash
nice -n 19 npx vitest run apps/api/src/routes/dashboard/products --maxWorkers=2
```

Expected: FAIL — `grantOn` is stripped by the Zod schema.

- [ ] **Step 3: Extend the schema and validation**

Add `grantOn: z.enum(["PURCHASE", "RENEWAL", "BOTH"]).default("PURCHASE")` to
the grant item schema, and after parsing, reject any grant whose `grantOn` is
`RENEWAL` or `BOTH` when the product's type is not a subscription type. Read
how `ProductType` is checked elsewhere in the file and match it.

- [ ] **Step 4: Run it to verify it passes**

```bash
nice -n 19 npx vitest run apps/api/src/routes/dashboard/products --maxWorkers=2
```

Expected: PASS.

- [ ] **Step 5: Add the form control and i18n keys**

Add a select to each grant row in the dashboard's currency-grants section,
disabled with an explanatory hint when the product is not a subscription.
Add keys — `products.grants.trigger.label`,
`products.grants.trigger.purchase`, `products.grants.trigger.renewal`,
`products.grants.trigger.both`, `products.grants.trigger.hint`,
`products.grants.trigger.subscriptionOnly` — and look the option labels up
through an explicit map:

```ts
const GRANT_TRIGGER_LABEL_KEYS: Record<CurrencyGrantTrigger, string> = {
  PURCHASE: "products.grants.trigger.purchase",
  RENEWAL: "products.grants.trigger.renewal",
  BOTH: "products.grants.trigger.both",
};
```

Never `t(\`products.grants.trigger.${grantOn}\`)` — a key built at runtime is
invisible to the extractor and ships as a missing translation.

- [ ] **Step 6: Build and commit**

```bash
nice -n 19 npx tsc --noEmit -p apps/dashboard
pnpm build --concurrency=2
```

```bash
git add apps/api/src/routes/dashboard/products.ts apps/dashboard/src
git commit -m "feat(dashboard): per-grant trigger selector

RENEWAL and BOTH are rejected server-side on non-subscription products,
not only disabled in the form."
```

- [ ] **Step 7: Tick the ROADMAP checkbox**

In `ROADMAP.md` §12, mark the credit-grant item done with a one-line note
pointing at the consumer group. Commit.
