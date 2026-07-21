# Stripe Connect OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-project Stripe API-key integration with Stripe Connect OAuth, so a project owner connects their Stripe account in one click and Rovenue charges on their behalf without ever holding their secrets.

**Architecture:** Rovenue registers as a Stripe Connect *platform*. Customers connect Standard accounts over OAuth; Rovenue persists only the resulting `acct_…` id and calls Stripe with its own platform key plus a `Stripe-Account` header (direct charges, so funds settle with the customer). Connected-account events arrive at one platform-level webhook endpoint and are routed to a project by `event.account`. The old `sk_live_`/`whsec_` path is deleted outright.

**Tech Stack:** Hono + TypeScript (strict), Drizzle ORM on PostgreSQL 16, Redis (OAuth state), BullMQ (webhook queue), `stripe` npm SDK v15, Vitest (unit + testcontainers integration), React + Vite dashboard.

**Spec:** `docs/superpowers/specs/2026-07-21-stripe-connect-oauth-design.md`

## Global Constraints

- TypeScript strict everywhere. Zod for all API input. Every response is `{ data: T }` or `{ error: { code, message } }` — use the `ok()` helper from `apps/api/src/lib/response.ts`.
- Postgres access through Drizzle repositories only, under `packages/db/src/drizzle/repositories`. Barrel-export every new repository through `packages/db/src/drizzle/index.ts`.
- All ids are cuid2 via `createId()`. All timestamps `timestamptz`, UTC.
- `audit()` runs inside the caller's Drizzle transaction. Every dashboard mutation writes an audit row.
- Conventional commits.
- **Never log, persist, or return an OAuth `code`, `access_token`, or `refresh_token`.** The token exchange response is read for `stripe_user_id`, `livemode` and `scope` only; everything else is discarded.
- Stripe API version is pinned to `"2024-12-18.acacia"` on every client this plan creates, matching `apps/api/src/lib/stripe-billing.ts:32`.
- Connect env is **not** gated on `HOST_MODE`. `isBillingEnabled()` is cloud-only and governs Rovenue's own SaaS billing; Connect must work on self-hosted installs.
- The latest existing migration is `packages/db/drizzle/migrations/0085_pricing_consolidation.sql`. This plan adds `0086` and `0087`.
- Tests: `pnpm --filter @rovenue/api test`, `pnpm --filter @rovenue/db test`. `apps/api/tests` is a separate directory from `apps/api/src`; both contain tests.
- Integration tests are `*.integration.test.ts`. Despite what `CLAUDE.md` says about testcontainers, the `apps/api` integration suites run against the **docker-compose dev Postgres on host port 5433** — see `apps/api/tests/billing-webhook-handlers.integration.test.ts:34-36`, which sets `process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue"` before any `@rovenue/db` import so the lazy client singleton binds to the right database. Follow that file's shape exactly.
- Dashboard component tests use `@testing-library/react` with the local `renderWithRouter` helper from `apps/dashboard/src/tests/render`, plus `userEvent` — see `apps/dashboard/src/components/apps/app-card.test.tsx`.
- In `apps/api` tests, environment variables set at the top of a test file are dead code — module import hoisting parses `lib/env` first. Use `vi.hoisted()` or `apps/api/tests/setup.ts` with `??=`.

---

### Task 1: Platform Stripe client and environment

**Files:**
- Modify: `apps/api/src/lib/env.ts:123-128` (schema), `apps/api/src/lib/env.ts:272-288` (superRefine)
- Create: `apps/api/src/lib/stripe-platform.ts`
- Modify: `.env.example:167-176`
- Test: `apps/api/src/lib/stripe-platform.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `getConnectPlatformStripe(livemode: boolean): Stripe | null`, `isConnectConfigured(): boolean`, `connectClientId(mode: "live" | "test"): string | null`, `_resetConnectPlatformStripeForTests(): void` from `apps/api/src/lib/stripe-platform.ts`.

- [ ] **Step 1: Add the env vars**

In `apps/api/src/lib/env.ts`, immediately after the `STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID` line (currently line 128), add:

```ts
    // ---- Stripe Connect (customer accounts) — NOT HOST_MODE gated ---------
    // Rovenue acts as a Connect platform so customers can authorise us to
    // charge on their behalf. Self-hosted installs register their own
    // platform and fill these in; when unset, Stripe features report
    // themselves unavailable rather than crashing at boot.
    STRIPE_CONNECT_CLIENT_ID: z.string().min(1).optional(),
    STRIPE_CONNECT_CLIENT_ID_TEST: z.string().min(1).optional(),
    STRIPE_PLATFORM_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_PLATFORM_SECRET_KEY_TEST: z.string().min(1).optional(),
    STRIPE_PLATFORM_PUBLISHABLE_KEY: z.string().min(1).optional(),
    STRIPE_PLATFORM_PUBLISHABLE_KEY_TEST: z.string().min(1).optional(),
    STRIPE_CONNECT_WEBHOOK_SECRET: z.string().min(1).optional(),
```

Also add `PUBLIC_BASE_URL` next to `DASHBOARD_URL` (currently line 72). It is
already read as a bare `process.env.PUBLIC_BASE_URL` in
`apps/api/src/routes/v1/funnel-claim.ts:102` but has never been schematised;
the OAuth `redirect_uri` must match what is registered with Stripe byte for
byte, so it needs a validated single source:

```ts
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
```

- [ ] **Step 2: Add cross-field validation**

In the same file's `superRefine`, after the closing brace of the `if (data.HOST_MODE === "cloud") { … }` block (currently line 288), add:

```ts
    // Connect is opt-in, but half-configured Connect is a deploy bug: if the
    // client id is present the platform key and webhook secret must be too.
    if (data.STRIPE_CONNECT_CLIENT_ID) {
      require(
        data.STRIPE_PLATFORM_SECRET_KEY,
        "STRIPE_PLATFORM_SECRET_KEY",
        "STRIPE_CONNECT_CLIENT_ID is set so a platform secret key is required in production",
      );
      require(
        data.STRIPE_CONNECT_WEBHOOK_SECRET,
        "STRIPE_CONNECT_WEBHOOK_SECRET",
        "STRIPE_CONNECT_CLIENT_ID is set so a Connect webhook secret is required in production",
      );
    }
```

- [ ] **Step 3: Document in `.env.example`**

After the `STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID=` line, add:

```
# ---- Stripe Connect (customer Stripe accounts) -------------------------
# Independent of HOST_MODE — self-hosted installs register their own
# Connect platform (Stripe Dashboard -> Connect -> Settings) and fill
# these in. Leave blank to disable Stripe features entirely.
# In production, setting STRIPE_CONNECT_CLIENT_ID makes the platform
# secret key and Connect webhook secret mandatory.
STRIPE_CONNECT_CLIENT_ID=
STRIPE_CONNECT_CLIENT_ID_TEST=
STRIPE_PLATFORM_SECRET_KEY=
STRIPE_PLATFORM_SECRET_KEY_TEST=
STRIPE_PLATFORM_PUBLISHABLE_KEY=
STRIPE_PLATFORM_PUBLISHABLE_KEY_TEST=
# Signing secret of the platform webhook endpoint that has
# "listen to Connect events" enabled.
STRIPE_CONNECT_WEBHOOK_SECRET=
```

And, next to `DASHBOARD_URL`:

```
# Public origin of the API. Must match the OAuth redirect URI registered
# with Stripe exactly: <PUBLIC_BASE_URL>/stripe/oauth/callback
PUBLIC_BASE_URL=http://localhost:3000
```

- [ ] **Step 4: Write the failing test**

Create `apps/api/src/lib/stripe-platform.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  STRIPE_CONNECT_CLIENT_ID: undefined as string | undefined,
  STRIPE_CONNECT_CLIENT_ID_TEST: undefined as string | undefined,
  STRIPE_PLATFORM_SECRET_KEY: undefined as string | undefined,
  STRIPE_PLATFORM_SECRET_KEY_TEST: undefined as string | undefined,
}));

vi.mock("./env", () => ({ env: envMock }));

import {
  _resetConnectPlatformStripeForTests,
  connectClientId,
  getConnectPlatformStripe,
  isConnectConfigured,
} from "./stripe-platform";

beforeEach(() => {
  envMock.STRIPE_CONNECT_CLIENT_ID = undefined;
  envMock.STRIPE_CONNECT_CLIENT_ID_TEST = undefined;
  envMock.STRIPE_PLATFORM_SECRET_KEY = undefined;
  envMock.STRIPE_PLATFORM_SECRET_KEY_TEST = undefined;
  _resetConnectPlatformStripeForTests();
});

afterEach(() => {
  _resetConnectPlatformStripeForTests();
});

describe("isConnectConfigured", () => {
  it("is false when the client id is missing", () => {
    envMock.STRIPE_PLATFORM_SECRET_KEY = "sk_live_x";
    expect(isConnectConfigured()).toBe(false);
  });

  it("is false when the platform secret key is missing", () => {
    envMock.STRIPE_CONNECT_CLIENT_ID = "ca_live";
    expect(isConnectConfigured()).toBe(false);
  });

  it("is true when both are present", () => {
    envMock.STRIPE_CONNECT_CLIENT_ID = "ca_live";
    envMock.STRIPE_PLATFORM_SECRET_KEY = "sk_live_x";
    expect(isConnectConfigured()).toBe(true);
  });
});

describe("connectClientId", () => {
  it("returns the live client id for live mode", () => {
    envMock.STRIPE_CONNECT_CLIENT_ID = "ca_live";
    envMock.STRIPE_CONNECT_CLIENT_ID_TEST = "ca_test";
    expect(connectClientId("live")).toBe("ca_live");
  });

  it("returns the test client id for test mode", () => {
    envMock.STRIPE_CONNECT_CLIENT_ID = "ca_live";
    envMock.STRIPE_CONNECT_CLIENT_ID_TEST = "ca_test";
    expect(connectClientId("test")).toBe("ca_test");
  });

  it("returns null when the requested mode has no client id", () => {
    envMock.STRIPE_CONNECT_CLIENT_ID = "ca_live";
    expect(connectClientId("test")).toBeNull();
  });
});

describe("getConnectPlatformStripe", () => {
  it("returns null when the key for that mode is unset", () => {
    envMock.STRIPE_PLATFORM_SECRET_KEY = "sk_live_x";
    expect(getConnectPlatformStripe(false)).toBeNull();
  });

  it("returns a client for live mode and memoises it", () => {
    envMock.STRIPE_PLATFORM_SECRET_KEY = "sk_live_x";
    const first = getConnectPlatformStripe(true);
    expect(first).not.toBeNull();
    expect(getConnectPlatformStripe(true)).toBe(first);
  });

  it("keeps live and test clients separate", () => {
    envMock.STRIPE_PLATFORM_SECRET_KEY = "sk_live_x";
    envMock.STRIPE_PLATFORM_SECRET_KEY_TEST = "sk_test_x";
    expect(getConnectPlatformStripe(true)).not.toBe(getConnectPlatformStripe(false));
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/stripe-platform.test.ts`
Expected: FAIL — `Failed to resolve import "./stripe-platform"`.

- [ ] **Step 6: Implement the module**

Create `apps/api/src/lib/stripe-platform.ts`:

```ts
import Stripe from "stripe";
import { env } from "./env";
import { logger } from "./logger";

// =============================================================
// Platform-Stripe client for Stripe Connect
// =============================================================
//
// Distinct from apps/api/src/lib/stripe-billing.ts, which talks to
// Rovenue's own billing account and is cloud-only. This client is
// Rovenue acting as a Connect *platform*: every customer-facing call
// runs against these keys plus a `Stripe-Account` header naming the
// connected account. Not HOST_MODE gated — self-hosted installs
// register their own platform.
//
// Live and test are fully separate worlds: separate client ids,
// separate secret keys, separate `acct_` namespaces. `livemode` on the
// connection row picks which one to use.

const log = logger.child("stripe-platform");

export type ConnectMode = "live" | "test";

const cached: { live: Stripe | null; test: Stripe | null } = {
  live: null,
  test: null,
};

function platformKey(livemode: boolean): string | undefined {
  return livemode
    ? env.STRIPE_PLATFORM_SECRET_KEY
    : env.STRIPE_PLATFORM_SECRET_KEY_TEST;
}

/** The OAuth client id for a mode, or null when that mode is unconfigured. */
export function connectClientId(mode: ConnectMode): string | null {
  const id =
    mode === "live"
      ? env.STRIPE_CONNECT_CLIENT_ID
      : env.STRIPE_CONNECT_CLIENT_ID_TEST;
  return id ?? null;
}

/** True when the deployment can run the live Connect flow at all. */
export function isConnectConfigured(): boolean {
  return Boolean(env.STRIPE_CONNECT_CLIENT_ID && env.STRIPE_PLATFORM_SECRET_KEY);
}

/**
 * Memoised platform client for one mode. Returns null when that mode's
 * secret key is unset so callers can degrade instead of throwing.
 */
export function getConnectPlatformStripe(livemode: boolean): Stripe | null {
  const slot = livemode ? "live" : "test";
  const existing = cached[slot];
  if (existing) return existing;

  const key = platformKey(livemode);
  if (!key) {
    log.warn("platform Stripe key missing for mode", { livemode });
    return null;
  }

  const client = new Stripe(key, {
    apiVersion: "2024-12-18.acacia" as Stripe.LatestApiVersion,
    typescript: true,
    appInfo: { name: "rovenue-connect", version: "0.1.0" },
  });
  cached[slot] = client;
  return client;
}

// Test-only — clears both cached clients so callers re-read env.
export function _resetConnectPlatformStripeForTests(): void {
  cached.live = null;
  cached.test = null;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/stripe-platform.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/env.ts apps/api/src/lib/stripe-platform.ts apps/api/src/lib/stripe-platform.test.ts .env.example
git commit -m "feat(api): platform Stripe client and Connect environment"
```

---

### Task 2: Connection table, migration, and repository

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts` (append after the `customDomains` block, which ends at line 2419)
- Create: `packages/db/drizzle/migrations/0086_stripe_connect.sql`
- Create: `packages/db/src/drizzle/repositories/project-stripe-connections.ts`
- Modify: `packages/db/src/drizzle/index.ts` (barrel)
- Test: `packages/db/src/drizzle/repositories/project-stripe-connections.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: table `projectStripeConnections`; types `ProjectStripeConnection`, `NewProjectStripeConnection`; repository reachable as `drizzle.stripeConnectionRepo` with `findActiveByProject(db, projectId)`, `findActiveByAccountId(db, accountId)`, `insert(db, values)`, `markDisconnected(db, id, reason)`, `updateAccountState(db, id, state)`.

- [ ] **Step 1: Add the table to the Drizzle schema**

Append to `packages/db/src/drizzle/schema.ts`:

```ts
// =============================================================
// project_stripe_connections — Stripe Connect (Standard accounts)
// =============================================================
//
// One active connection per project. We deliberately do NOT store the
// OAuth access/refresh tokens: direct charges on a Standard account
// need only the account id plus our platform key, so persisting the
// tokens would add a secret to rotate for no capability gained.
//
// Rows are soft-deleted (`disconnected_at`) rather than removed so the
// connect/disconnect history stays auditable.

export const projectStripeConnections = pgTable(
  "project_stripe_connections",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    stripeAccountId: text("stripe_account_id").notNull(),
    livemode: boolean("livemode").notNull(),
    scope: text("scope").notNull(),
    chargesEnabled: boolean("charges_enabled").notNull().default(false),
    payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
    capabilities: jsonb("capabilities").notNull().default(sql`'{}'::jsonb`),
    country: text("country"),
    defaultCurrency: text("default_currency"),
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    connectedBy: text("connected_by").references(() => user.id, {
      onDelete: "set null",
    }),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    disconnectReason: text("disconnect_reason"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (t) => ({
    // At most one live connection per project. Partial so historical
    // disconnected rows never block a reconnect.
    activeUnique: uniqueIndex("project_stripe_connections_active_uq")
      .on(t.projectId)
      .where(sql`${t.disconnectedAt} IS NULL`),
    // Webhook routing looks a project up by the account on the event.
    accountIdx: index("project_stripe_connections_account_idx").on(
      t.stripeAccountId,
    ),
  }),
);

export type ProjectStripeConnection = typeof projectStripeConnections.$inferSelect;
export type NewProjectStripeConnection =
  typeof projectStripeConnections.$inferInsert;
```

- [ ] **Step 2: Write the migration**

Create `packages/db/drizzle/migrations/0086_stripe_connect.sql`:

```sql
-- Stripe Connect: one active connected account per project.
-- OAuth tokens are intentionally not stored (direct charges need only
-- the account id plus the platform key).

CREATE TABLE IF NOT EXISTS "project_stripe_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "stripe_account_id" text NOT NULL,
  "livemode" boolean NOT NULL,
  "scope" text NOT NULL,
  "charges_enabled" boolean NOT NULL DEFAULT false,
  "payouts_enabled" boolean NOT NULL DEFAULT false,
  "capabilities" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "country" text,
  "default_currency" text,
  "connected_at" timestamptz NOT NULL DEFAULT now(),
  "connected_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "disconnected_at" timestamptz,
  "disconnect_reason" text,
  "last_synced_at" timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_stripe_connections_active_uq"
  ON "project_stripe_connections" ("project_id")
  WHERE "disconnected_at" IS NULL;

CREATE INDEX IF NOT EXISTS "project_stripe_connections_account_idx"
  ON "project_stripe_connections" ("stripe_account_id");
```

Note: hand-write this file. Do not run `drizzle-kit generate` and keep its output wholesale — it has previously folded unrelated hand-written DDL into generated migrations in this repo.

- [ ] **Step 3: Write the failing integration test**

Create `packages/db/src/drizzle/repositories/project-stripe-connections.integration.test.ts`, following the exact bootstrap shape of the sibling `credit-ledger.integration.test.ts`: a bare `process.env.DATABASE_URL ??=` assignment as the **first statement in the file, above every import**, then `getDb()` from `../client`, direct inserts for seeding, and an `afterAll` that deletes the project (the connection rows cascade).

```ts
process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { projects, projectStripeConnections } from "../schema";
import * as stripeConnectionRepo from "./project-stripe-connections";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_sc_${RUN_ID}`;

describe("stripeConnectionRepo", () => {
  const projectId = PROJECT_ID;

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  beforeEach(async () => {
    const db = getDb();
    await db
      .insert(projects)
      .values({ id: PROJECT_ID, name: `SC ${RUN_ID}` })
      .onConflictDoNothing();
    // Each case starts from no connection rows.
    await db
      .delete(projectStripeConnections)
      .where(eq(projectStripeConnections.projectId, PROJECT_ID));
  });

  it("insert then findActiveByProject round-trips", async () => {
    await stripeConnectionRepo.insert(getDb(), {
      projectId,
      stripeAccountId: "acct_live_1",
      livemode: true,
      scope: "read_write",
      chargesEnabled: true,
      payoutsEnabled: true,
      capabilities: { card_payments: "active" },
    });

    const found = await stripeConnectionRepo.findActiveByProject(
      getDb(),
      projectId,
    );
    expect(found?.stripeAccountId).toBe("acct_live_1");
    expect(found?.chargesEnabled).toBe(true);
  });

  it("rejects a second active connection for the same project", async () => {
    await stripeConnectionRepo.insert(getDb(), {
      projectId,
      stripeAccountId: "acct_a",
      livemode: true,
      scope: "read_write",
    });

    await expect(
      stripeConnectionRepo.insert(getDb(), {
        projectId,
        stripeAccountId: "acct_b",
        livemode: true,
        scope: "read_write",
      }),
    ).rejects.toThrow();
  });

  it("allows reconnecting after a disconnect", async () => {
    const first = await stripeConnectionRepo.insert(getDb(), {
      projectId,
      stripeAccountId: "acct_a",
      livemode: true,
      scope: "read_write",
    });
    await stripeConnectionRepo.markDisconnected(
      getDb(),
      first.id,
      "user",
    );

    const second = await stripeConnectionRepo.insert(getDb(), {
      projectId,
      stripeAccountId: "acct_b",
      livemode: true,
      scope: "read_write",
    });
    expect(second.stripeAccountId).toBe("acct_b");

    const active = await stripeConnectionRepo.findActiveByProject(
      getDb(),
      projectId,
    );
    expect(active?.id).toBe(second.id);
  });

  it("findActiveByAccountId ignores disconnected rows", async () => {
    const row = await stripeConnectionRepo.insert(getDb(), {
      projectId,
      stripeAccountId: "acct_gone",
      livemode: true,
      scope: "read_write",
    });
    expect(
      await stripeConnectionRepo.findActiveByAccountId(
        getDb(),
        "acct_gone",
      ),
    ).not.toBeNull();

    await stripeConnectionRepo.markDisconnected(
      getDb(),
      row.id,
      "stripe_deauthorized",
    );
    expect(
      await stripeConnectionRepo.findActiveByAccountId(
        getDb(),
        "acct_gone",
      ),
    ).toBeNull();
  });

  it("updateAccountState overwrites capability fields", async () => {
    const row = await stripeConnectionRepo.insert(getDb(), {
      projectId,
      stripeAccountId: "acct_c",
      livemode: true,
      scope: "read_write",
      chargesEnabled: false,
    });

    await stripeConnectionRepo.updateAccountState(getDb(), row.id, {
      chargesEnabled: true,
      payoutsEnabled: true,
      capabilities: { card_payments: "active" },
      country: "TR",
      defaultCurrency: "try",
    });

    const found = await stripeConnectionRepo.findActiveByProject(
      getDb(),
      projectId,
    );
    expect(found?.chargesEnabled).toBe(true);
    expect(found?.country).toBe("TR");
    expect(found?.lastSyncedAt).not.toBeNull();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/db exec vitest run src/drizzle/repositories/project-stripe-connections.integration.test.ts`
Expected: FAIL — cannot resolve `./project-stripe-connections`.

- [ ] **Step 5: Implement the repository**

Create `packages/db/src/drizzle/repositories/project-stripe-connections.ts`:

```ts
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../client";
import {
  projectStripeConnections,
  type NewProjectStripeConnection,
  type ProjectStripeConnection,
} from "../schema";

export type DisconnectReason = "user" | "stripe_deauthorized";

export interface AccountState {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  capabilities: unknown;
  country?: string | null;
  defaultCurrency?: string | null;
}

/** The project's live connection, or null when it has never connected. */
export async function findActiveByProject(
  db: Db,
  projectId: string,
): Promise<ProjectStripeConnection | null> {
  const rows = await db
    .select()
    .from(projectStripeConnections)
    .where(
      and(
        eq(projectStripeConnections.projectId, projectId),
        isNull(projectStripeConnections.disconnectedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Reverse lookup used by the Connect webhook to turn `event.account`
 * into a project. Disconnected rows are excluded so in-flight events
 * for a revoked account resolve to nothing.
 */
export async function findActiveByAccountId(
  db: Db,
  accountId: string,
): Promise<ProjectStripeConnection | null> {
  const rows = await db
    .select()
    .from(projectStripeConnections)
    .where(
      and(
        eq(projectStripeConnections.stripeAccountId, accountId),
        isNull(projectStripeConnections.disconnectedAt),
      ),
    )
    .orderBy(desc(projectStripeConnections.connectedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function insert(
  db: Db,
  values: NewProjectStripeConnection,
): Promise<ProjectStripeConnection> {
  const rows = await db
    .insert(projectStripeConnections)
    .values(values)
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Failed to insert project_stripe_connections row");
  return row;
}

export async function markDisconnected(
  db: Db,
  id: string,
  reason: DisconnectReason,
): Promise<void> {
  await db
    .update(projectStripeConnections)
    .set({ disconnectedAt: new Date(), disconnectReason: reason })
    .where(
      and(
        eq(projectStripeConnections.id, id),
        isNull(projectStripeConnections.disconnectedAt),
      ),
    );
}

export async function updateAccountState(
  db: Db,
  id: string,
  state: AccountState,
): Promise<void> {
  await db
    .update(projectStripeConnections)
    .set({
      chargesEnabled: state.chargesEnabled,
      payoutsEnabled: state.payoutsEnabled,
      capabilities: state.capabilities,
      country: state.country ?? null,
      defaultCurrency: state.defaultCurrency ?? null,
      lastSyncedAt: new Date(),
    })
    .where(eq(projectStripeConnections.id, id));
}
```

- [ ] **Step 6: Barrel-export the repository**

In `packages/db/src/drizzle/index.ts`, add the import alongside the other repository namespace imports and register it on the `drizzle` object as `stripeConnectionRepo`, matching how `funnelPurchaseRepo` is wired at line 77:

```ts
import * as stripeConnectionRepo from "./repositories/project-stripe-connections";
```

and inside the exported object:

```ts
  stripeConnectionRepo,
```

- [ ] **Step 7: Apply the migration and run the test**

Run: `pnpm db:migrate && pnpm --filter @rovenue/db exec vitest run src/drizzle/repositories/project-stripe-connections.integration.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/drizzle/migrations/0086_stripe_connect.sql packages/db/src/drizzle/repositories/project-stripe-connections.ts packages/db/src/drizzle/repositories/project-stripe-connections.integration.test.ts packages/db/src/drizzle/index.ts
git commit -m "feat(db): project_stripe_connections table and repository"
```

---

### Task 3: Connected-account client resolver and capability gate

**Files:**
- Modify: `apps/api/src/lib/stripe-platform.ts`
- Test: `apps/api/src/lib/stripe-connected.test.ts`

**Interfaces:**
- Consumes: `getConnectPlatformStripe` (Task 1), `drizzle.stripeConnectionRepo` (Task 2).
- Produces: `type ConnectedStripe = { stripe: Stripe; accountId: string; livemode: boolean }`, `getConnectedStripe(projectId: string): Promise<ConnectedStripe | null>`, `requireConnectedStripe(projectId: string): Promise<ConnectedStripe>`, `chargesEnabled(projectId: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/stripe-connected.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  STRIPE_CONNECT_CLIENT_ID: "ca_live" as string | undefined,
  STRIPE_CONNECT_CLIENT_ID_TEST: "ca_test" as string | undefined,
  STRIPE_PLATFORM_SECRET_KEY: "sk_live_x" as string | undefined,
  STRIPE_PLATFORM_SECRET_KEY_TEST: "sk_test_x" as string | undefined,
}));
const findActiveByProject = vi.hoisted(() => vi.fn());

vi.mock("./env", () => ({ env: envMock }));
vi.mock("@rovenue/db", () => ({
  drizzle: { db: {}, stripeConnectionRepo: { findActiveByProject } },
}));

import {
  _resetConnectPlatformStripeForTests,
  chargesEnabled,
  getConnectedStripe,
  requireConnectedStripe,
} from "./stripe-platform";

beforeEach(() => {
  findActiveByProject.mockReset();
  _resetConnectPlatformStripeForTests();
});

describe("getConnectedStripe", () => {
  it("returns null when the project has no connection", async () => {
    findActiveByProject.mockResolvedValue(null);
    expect(await getConnectedStripe("p1")).toBeNull();
  });

  it("returns the account id and a live client for a live connection", async () => {
    findActiveByProject.mockResolvedValue({
      stripeAccountId: "acct_1",
      livemode: true,
    });
    const result = await getConnectedStripe("p1");
    expect(result?.accountId).toBe("acct_1");
    expect(result?.livemode).toBe(true);
    expect(result?.stripe).toBeDefined();
  });

  it("selects the test client for a test-mode connection", async () => {
    findActiveByProject.mockResolvedValue({
      stripeAccountId: "acct_t",
      livemode: false,
    });
    const testResult = await getConnectedStripe("p1");
    findActiveByProject.mockResolvedValue({
      stripeAccountId: "acct_l",
      livemode: true,
    });
    const liveResult = await getConnectedStripe("p1");
    expect(testResult?.stripe).not.toBe(liveResult?.stripe);
  });

  it("returns null when the platform key for that mode is unset", async () => {
    envMock.STRIPE_PLATFORM_SECRET_KEY_TEST = undefined;
    _resetConnectPlatformStripeForTests();
    findActiveByProject.mockResolvedValue({
      stripeAccountId: "acct_t",
      livemode: false,
    });
    expect(await getConnectedStripe("p1")).toBeNull();
    envMock.STRIPE_PLATFORM_SECRET_KEY_TEST = "sk_test_x";
  });
});

describe("requireConnectedStripe", () => {
  it("throws an error naming the project when unconnected", async () => {
    findActiveByProject.mockResolvedValue(null);
    await expect(requireConnectedStripe("proj_42")).rejects.toThrow(/proj_42/);
  });
});

describe("chargesEnabled", () => {
  it("is false without a connection", async () => {
    findActiveByProject.mockResolvedValue(null);
    expect(await chargesEnabled("p1")).toBe(false);
  });

  it("is false when Stripe has charges disabled", async () => {
    findActiveByProject.mockResolvedValue({
      stripeAccountId: "acct_1",
      livemode: true,
      chargesEnabled: false,
      capabilities: { card_payments: "active" },
    });
    expect(await chargesEnabled("p1")).toBe(false);
  });

  it("is false when card_payments is not active", async () => {
    findActiveByProject.mockResolvedValue({
      stripeAccountId: "acct_1",
      livemode: true,
      chargesEnabled: true,
      capabilities: { card_payments: "pending" },
    });
    expect(await chargesEnabled("p1")).toBe(false);
  });

  it("is true when both are satisfied", async () => {
    findActiveByProject.mockResolvedValue({
      stripeAccountId: "acct_1",
      livemode: true,
      chargesEnabled: true,
      capabilities: { card_payments: "active" },
    });
    expect(await chargesEnabled("p1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/stripe-connected.test.ts`
Expected: FAIL — `getConnectedStripe is not a function`.

- [ ] **Step 3: Append the resolver to `stripe-platform.ts`**

Add to `apps/api/src/lib/stripe-platform.ts` (and add `import { drizzle } from "@rovenue/db";` at the top):

```ts
export interface ConnectedStripe {
  readonly stripe: Stripe;
  readonly accountId: string;
  readonly livemode: boolean;
}

/**
 * Resolve a project's connected account into a ready-to-use client.
 * Returns null rather than throwing so read paths (health, dashboard
 * status) can branch on it; write paths should use
 * `requireConnectedStripe` instead.
 *
 * Every Stripe call made with this client MUST pass
 * `{ stripeAccount: accountId }` as the request-options argument —
 * that header is what makes it a direct charge on the customer's
 * account rather than on Rovenue's platform account.
 */
export async function getConnectedStripe(
  projectId: string,
): Promise<ConnectedStripe | null> {
  const connection = await drizzle.stripeConnectionRepo.findActiveByProject(
    drizzle.db,
    projectId,
  );
  if (!connection) return null;

  const stripe = getConnectPlatformStripe(connection.livemode);
  if (!stripe) {
    log.error("connection exists but its platform key is unset", {
      projectId,
      livemode: connection.livemode,
    });
    return null;
  }

  return {
    stripe,
    accountId: connection.stripeAccountId,
    livemode: connection.livemode,
  };
}

export class StripeNotConnectedError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} has no active Stripe connection`);
    this.name = "StripeNotConnectedError";
  }
}

export async function requireConnectedStripe(
  projectId: string,
): Promise<ConnectedStripe> {
  const connected = await getConnectedStripe(projectId);
  if (!connected) throw new StripeNotConnectedError(projectId);
  return connected;
}

/**
 * Can this project actually take a card payment right now? Connecting
 * is not enough — Stripe withholds `charges_enabled` and the
 * `card_payments` capability until onboarding and verification finish.
 */
export async function chargesEnabled(projectId: string): Promise<boolean> {
  const connection = await drizzle.stripeConnectionRepo.findActiveByProject(
    drizzle.db,
    projectId,
  );
  if (!connection || !connection.chargesEnabled) return false;
  const caps = (connection.capabilities ?? {}) as Record<string, unknown>;
  return caps.card_payments === "active";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/stripe-connected.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/stripe-platform.ts apps/api/src/lib/stripe-connected.test.ts
git commit -m "feat(api): connected-account Stripe resolver and charges capability gate"
```

---

### Task 4: OAuth state, connect route, callback, disconnect

**Files:**
- Create: `apps/api/src/services/stripe/oauth-state.ts`
- Create: `apps/api/src/routes/dashboard/stripe-connect.ts`
- Create: `apps/api/src/routes/stripe-oauth.ts`
- Modify: `apps/api/src/routes/dashboard/index.ts` (mount), `apps/api/src/app.ts` (mount), `apps/api/src/lib/audit.ts:43-45` (actions)
- Test: `apps/api/src/services/stripe/oauth-state.test.ts`, `apps/api/tests/stripe-connect-routes.test.ts`

**Interfaces:**
- Consumes: `connectClientId`, `getConnectPlatformStripe`, `isConnectConfigured` (Task 1); `drizzle.stripeConnectionRepo` (Task 2).
- Produces: `createOAuthState(payload: OAuthStatePayload): Promise<string>`, `consumeOAuthState(nonce: string): Promise<OAuthStatePayload | null>`, `type OAuthStatePayload = { projectId: string; userId: string; mode: ConnectMode }`; routes `stripeConnectRoute` and `stripeOAuthRoute`.

- [ ] **Step 1: Add the audit actions**

In `apps/api/src/lib/audit.ts`, extend the `AuditAction` union after `"credential.cleared"` (line 45):

```ts
  // --- stripe connect ---
  | "stripe.connected"
  | "stripe.disconnected"
```

- [ ] **Step 2: Write the failing OAuth-state test**

Create `apps/api/src/services/stripe/oauth-state.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
const redisMock = vi.hoisted(() => ({
  set: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    return "OK";
  }),
  getdel: vi.fn(async (key: string) => {
    const value = store.get(key) ?? null;
    store.delete(key);
    return value;
  }),
}));

vi.mock("../../lib/redis", () => ({ redis: redisMock }));

import { consumeOAuthState, createOAuthState } from "./oauth-state";

beforeEach(() => {
  store.clear();
  redisMock.set.mockClear();
  redisMock.getdel.mockClear();
});

describe("oauth state", () => {
  it("round-trips a payload", async () => {
    const nonce = await createOAuthState({
      projectId: "p1",
      userId: "u1",
      mode: "live",
    });
    expect(await consumeOAuthState(nonce)).toEqual({
      projectId: "p1",
      userId: "u1",
      mode: "live",
    });
  });

  it("issues a high-entropy nonce", async () => {
    const nonce = await createOAuthState({
      projectId: "p1",
      userId: "u1",
      mode: "live",
    });
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is single-use", async () => {
    const nonce = await createOAuthState({
      projectId: "p1",
      userId: "u1",
      mode: "test",
    });
    await consumeOAuthState(nonce);
    expect(await consumeOAuthState(nonce)).toBeNull();
  });

  it("returns null for an unknown nonce", async () => {
    expect(await consumeOAuthState("nope")).toBeNull();
  });

  it("sets a 600 second TTL", async () => {
    await createOAuthState({ projectId: "p1", userId: "u1", mode: "live" });
    expect(redisMock.set).toHaveBeenCalledWith(
      expect.stringMatching(/^stripe:oauth:/),
      expect.any(String),
      "EX",
      600,
    );
  });

  it("returns null when the stored value is not valid state", async () => {
    store.set("stripe:oauth:garbage", "{\"nope\":1}");
    expect(await consumeOAuthState("garbage")).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/stripe/oauth-state.test.ts`
Expected: FAIL — cannot resolve `./oauth-state`.

- [ ] **Step 4: Implement OAuth state**

Create `apps/api/src/services/stripe/oauth-state.ts`:

```ts
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { redis } from "../../lib/redis";
import type { ConnectMode } from "../../lib/stripe-platform";

// =============================================================
// Stripe OAuth `state` — CSRF token and flow context
// =============================================================
//
// The nonce is the only thing that travels through the user's browser.
// It carries no project or user information itself; the payload lives
// in Redis under a 10 minute TTL and is deleted on first read, so a
// leaked authorize URL is worthless after use or after ten minutes.

const TTL_SECONDS = 600;
const KEY_PREFIX = "stripe:oauth:";

const payloadSchema = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1),
  mode: z.enum(["live", "test"]),
});

export type OAuthStatePayload = {
  projectId: string;
  userId: string;
  mode: ConnectMode;
};

export async function createOAuthState(
  payload: OAuthStatePayload,
): Promise<string> {
  const nonce = randomBytes(32).toString("base64url");
  await redis.set(
    `${KEY_PREFIX}${nonce}`,
    JSON.stringify(payload),
    "EX",
    TTL_SECONDS,
  );
  return nonce;
}

/** Reads and deletes in one shot — replay of the same nonce yields null. */
export async function consumeOAuthState(
  nonce: string,
): Promise<OAuthStatePayload | null> {
  const raw = await redis.getdel(`${KEY_PREFIX}${nonce}`);
  if (!raw) return null;
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/stripe/oauth-state.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Implement the dashboard connect/disconnect route**

Create `apps/api/src/routes/dashboard/stripe-connect.ts`:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { MemberRole, drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { audit, extractRequestContext } from "../../lib/audit";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { ok } from "../../lib/response";
import {
  connectClientId,
  getConnectPlatformStripe,
  isConnectConfigured,
  type ConnectMode,
} from "../../lib/stripe-platform";
import { createOAuthState } from "../../services/stripe/oauth-state";

// =============================================================
// Dashboard: Stripe Connect
// =============================================================
//
// Connecting and disconnecting rotate who can move money on the
// customer's behalf, so both require OWNER — the same authority the
// removed credential-write route demanded.

const log = logger.child("route:dashboard:stripe-connect");

function redirectUri(): string {
  const base = env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  return `${base}/stripe/oauth/callback`;
}

export const stripeConnectRoute = new Hono()
  .use("*", requireDashboardAuth)

  // ----- GET /dashboard/projects/:projectId/stripe/connect -----
  // 302 to Stripe's consent screen.
  .get("/connect", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.OWNER);

    if (!isConnectConfigured()) {
      throw new HTTPException(503, {
        message: "Stripe Connect is not configured on this deployment",
      });
    }

    const mode: ConnectMode = c.req.query("mode") === "test" ? "test" : "live";
    const clientId = connectClientId(mode);
    if (!clientId) {
      throw new HTTPException(400, {
        message: `Stripe Connect ${mode} mode is not configured`,
      });
    }

    const existing = await drizzle.stripeConnectionRepo.findActiveByProject(
      drizzle.db,
      projectId,
    );
    if (existing) {
      throw new HTTPException(409, {
        message: "Project already has an active Stripe connection",
      });
    }

    const state = await createOAuthState({ projectId, userId: user.id, mode });
    const url = new URL("https://connect.stripe.com/oauth/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", "read_write");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirectUri());

    return c.redirect(url.toString(), 302);
  })

  // ----- GET /dashboard/projects/:projectId/stripe/connection -----
  .get("/connection", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const row = await drizzle.stripeConnectionRepo.findActiveByProject(
      drizzle.db,
      projectId,
    );
    return c.json(
      ok({
        platformConfigured: isConnectConfigured(),
        testModeAvailable: connectClientId("test") !== null,
        connection: row
          ? {
              accountId: row.stripeAccountId,
              livemode: row.livemode,
              chargesEnabled: row.chargesEnabled,
              payoutsEnabled: row.payoutsEnabled,
              country: row.country,
              defaultCurrency: row.defaultCurrency,
              connectedAt: row.connectedAt.toISOString(),
            }
          : null,
      }),
    );
  })

  // ----- DELETE /dashboard/projects/:projectId/stripe/connect -----
  .delete("/connect", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.OWNER);

    const row = await drizzle.stripeConnectionRepo.findActiveByProject(
      drizzle.db,
      projectId,
    );
    if (!row) {
      throw new HTTPException(404, { message: "No active Stripe connection" });
    }

    const stripe = getConnectPlatformStripe(row.livemode);
    const clientId = connectClientId(row.livemode ? "live" : "test");
    if (stripe && clientId) {
      try {
        await stripe.oauth.deauthorize({
          client_id: clientId,
          stripe_user_id: row.stripeAccountId,
        });
      } catch (err) {
        // Stripe may already consider the account deauthorized. Do not
        // strand the local row over it — log and soft-delete anyway.
        log.warn("stripe deauthorize failed; disconnecting locally", {
          projectId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await drizzle.db.transaction(async (tx) => {
      await drizzle.stripeConnectionRepo.markDisconnected(tx, row.id, "user");
      await audit(
        {
          projectId,
          userId: user.id,
          action: "stripe.disconnected",
          resource: "project",
          resourceId: projectId,
          before: { accountId: row.stripeAccountId, livemode: row.livemode },
          ...extractRequestContext(c),
        },
        tx,
      );
    });

    return c.json(ok({ disconnected: true }));
  });
```

Mount it in `apps/api/src/routes/dashboard/index.ts` alongside the other project-scoped sub-routers:

```ts
  .route("/projects/:projectId/stripe", stripeConnectRoute)
```

with `import { stripeConnectRoute } from "./stripe-connect";` at the top.

- [ ] **Step 7: Implement the OAuth callback**

Create `apps/api/src/routes/stripe-oauth.ts`:

```ts
import { Hono } from "hono";
import { drizzle } from "@rovenue/db";
import { audit, extractRequestContext } from "../lib/audit";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { getConnectPlatformStripe } from "../lib/stripe-platform";
import { consumeOAuthState } from "../services/stripe/oauth-state";

// =============================================================
// Stripe OAuth callback
// =============================================================
//
// Unauthenticated by necessity — Stripe redirects the customer's
// browser straight here. All trust rides on the single-use `state`
// nonce, which is deleted the moment we read it.
//
// One fixed redirect_uri serves every project; the nonce carries the
// project, so nothing project-specific is registered with Stripe.

const log = logger.child("route:stripe-oauth");

function dashboardRedirect(projectId: string | null, query: string): string {
  const base = env.DASHBOARD_URL ?? "http://localhost:5173";
  return projectId
    ? `${base}/projects/${projectId}/stores?${query}`
    : `${base}/?${query}`;
}

export const stripeOAuthRoute = new Hono().get("/callback", async (c) => {
  const stateParam = c.req.query("state");
  const errorParam = c.req.query("error");
  const code = c.req.query("code");

  const state = stateParam ? await consumeOAuthState(stateParam) : null;

  // The customer declined on Stripe's consent screen. Nothing to write.
  if (errorParam) {
    log.info("stripe oauth declined", { error: errorParam });
    return c.redirect(
      dashboardRedirect(state?.projectId ?? null, "stripe=declined"),
      302,
    );
  }

  if (!state) {
    return c.json(
      { error: { code: "INVALID_STATE", message: "Invalid or expired state" } },
      400,
    );
  }
  if (!code) {
    return c.json(
      { error: { code: "MISSING_CODE", message: "Missing authorization code" } },
      400,
    );
  }

  const stripe = getConnectPlatformStripe(state.mode === "live");
  if (!stripe) {
    return c.json(
      { error: { code: "NOT_CONFIGURED", message: "Stripe Connect is not configured" } },
      503,
    );
  }

  let accountId: string;
  let livemode: boolean;
  let scope: string;
  try {
    // NOTE: the access_token / refresh_token on this response are
    // deliberately ignored and never persisted or logged. Direct
    // charges on a Standard account need only the account id.
    const token = await stripe.oauth.token({
      grant_type: "authorization_code",
      code,
    });
    if (!token.stripe_user_id) throw new Error("missing stripe_user_id");
    accountId = token.stripe_user_id;
    livemode = Boolean(token.livemode);
    scope = token.scope ?? "read_write";
  } catch (err) {
    log.error("stripe oauth token exchange failed", {
      projectId: state.projectId,
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      { error: { code: "OAUTH_EXCHANGE_FAILED", message: "Stripe rejected the authorization" } },
      502,
    );
  }

  const account = await stripe.accounts.retrieve(accountId);

  await drizzle.db.transaction(async (tx) => {
    await drizzle.stripeConnectionRepo.insert(tx, {
      projectId: state.projectId,
      stripeAccountId: accountId,
      livemode,
      scope,
      chargesEnabled: Boolean(account.charges_enabled),
      payoutsEnabled: Boolean(account.payouts_enabled),
      capabilities: account.capabilities ?? {},
      country: account.country ?? null,
      defaultCurrency: account.default_currency ?? null,
      connectedBy: state.userId,
      lastSyncedAt: new Date(),
    });
    await audit(
      {
        projectId: state.projectId,
        userId: state.userId,
        action: "stripe.connected",
        resource: "project",
        resourceId: state.projectId,
        after: { accountId, livemode, chargesEnabled: Boolean(account.charges_enabled) },
        ...extractRequestContext(c),
      },
      tx,
    );
  });

  log.info("stripe account connected", { projectId: state.projectId, livemode });
  return c.redirect(dashboardRedirect(state.projectId, "stripe=connected"), 302);
});
```

Mount it in `apps/api/src/app.ts` next to the other top-level public routes:

```ts
  .route("/stripe/oauth", stripeOAuthRoute)
```

with `import { stripeOAuthRoute } from "./routes/stripe-oauth";`.

- [ ] **Step 8: Write the route tests**

Create `apps/api/tests/stripe-connect-routes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findActiveByProject = vi.hoisted(() => vi.fn());
const insertConnection = vi.hoisted(() => vi.fn(async (_tx, v) => ({ id: "conn_1", ...v })));
const markDisconnected = vi.hoisted(() => vi.fn());
const oauthToken = vi.hoisted(() => vi.fn());
const oauthDeauthorize = vi.hoisted(() => vi.fn());
const accountsRetrieve = vi.hoisted(() => vi.fn());
const auditFn = vi.hoisted(() => vi.fn());
const assertProjectAccess = vi.hoisted(() => vi.fn());

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
      stripeConnectionRepo: {
        findActiveByProject,
        insert: insertConnection,
        markDisconnected,
      },
    },
  };
});

vi.mock("../src/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/audit")>();
  return { ...actual, audit: auditFn };
});

vi.mock("../src/lib/project-access", () => ({ assertProjectAccess }));

// The dashboard-auth middleware is replaced with a stub that injects a
// fixed user so these tests exercise the route logic, not Better Auth.
vi.mock("../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: "user_1" });
    await next();
  },
}));

vi.mock("../src/lib/stripe-platform", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/stripe-platform")>();
  return {
    ...actual,
    getConnectPlatformStripe: () => ({
      oauth: { token: oauthToken, deauthorize: oauthDeauthorize },
      accounts: { retrieve: accountsRetrieve },
    }),
  };
});

describe("Stripe Connect routes", () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...original };
    process.env.PUBLIC_BASE_URL = "https://api.example.com";
    process.env.DASHBOARD_URL = "https://app.example.com";
    process.env.STRIPE_CONNECT_CLIENT_ID = "ca_live";
    process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_live_fake";
    delete process.env.STRIPE_CONNECT_CLIENT_ID_TEST;
    findActiveByProject.mockReset().mockResolvedValue(null);
    insertConnection.mockClear();
    markDisconnected.mockReset();
    oauthToken.mockReset();
    accountsRetrieve.mockReset();
    auditFn.mockReset();
    assertProjectAccess.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...original };
  });

  async function buildApp() {
    const { createApp } = await import("../src/app");
    return createApp();
  }

  const connectPath = "/dashboard/projects/proj_1/stripe/connect";

  describe("GET …/stripe/connect", () => {
    it("503s when the platform is unconfigured", async () => {
      delete process.env.STRIPE_CONNECT_CLIENT_ID;
      const app = await buildApp();
      const res = await app.request(connectPath);
      expect(res.status).toBe(503);
    });

    it("409s when an active connection already exists", async () => {
      findActiveByProject.mockResolvedValue({ id: "conn_1" });
      const app = await buildApp();
      const res = await app.request(connectPath);
      expect(res.status).toBe(409);
    });

    it("400s when ?mode=test but no test client id is set", async () => {
      const app = await buildApp();
      const res = await app.request(`${connectPath}?mode=test`);
      expect(res.status).toBe(400);
    });

    it("403s for a non-OWNER", async () => {
      assertProjectAccess.mockRejectedValue(
        Object.assign(new Error("forbidden"), { status: 403 }),
      );
      const app = await buildApp();
      const res = await app.request(connectPath);
      expect(res.status).toBe(403);
    });

    it("302s to Stripe with response_type, scope, state and redirect_uri", async () => {
      const app = await buildApp();
      const res = await app.request(connectPath);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") ?? "");
      expect(location.origin + location.pathname).toBe(
        "https://connect.stripe.com/oauth/authorize",
      );
      expect(location.searchParams.get("response_type")).toBe("code");
      expect(location.searchParams.get("scope")).toBe("read_write");
      expect(location.searchParams.get("client_id")).toBe("ca_live");
      expect(location.searchParams.get("redirect_uri")).toBe(
        "https://api.example.com/stripe/oauth/callback",
      );
      expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  describe("GET /stripe/oauth/callback", () => {
    async function connectAndGetState(app: Awaited<ReturnType<typeof buildApp>>) {
      const res = await app.request(connectPath);
      const location = new URL(res.headers.get("location") ?? "");
      return location.searchParams.get("state") ?? "";
    }

    it("400s on an unknown or expired state", async () => {
      const app = await buildApp();
      const res = await app.request("/stripe/oauth/callback?state=nope&code=c");
      expect(res.status).toBe(400);
      expect(insertConnection).not.toHaveBeenCalled();
    });

    it("400s when the same state is replayed", async () => {
      oauthToken.mockResolvedValue({
        stripe_user_id: "acct_1",
        livemode: true,
        scope: "read_write",
      });
      accountsRetrieve.mockResolvedValue({
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: { card_payments: "active" },
        country: "TR",
        default_currency: "try",
      });
      const app = await buildApp();
      const state = await connectAndGetState(app);
      await app.request(`/stripe/oauth/callback?state=${state}&code=c`);
      const replay = await app.request(
        `/stripe/oauth/callback?state=${state}&code=c`,
      );
      expect(replay.status).toBe(400);
      expect(insertConnection).toHaveBeenCalledTimes(1);
    });

    it("redirects with stripe=declined when Stripe returns ?error", async () => {
      const app = await buildApp();
      const state = await connectAndGetState(app);
      const res = await app.request(
        `/stripe/oauth/callback?state=${state}&error=access_denied`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("stripe=declined");
      expect(insertConnection).not.toHaveBeenCalled();
    });

    it("502s and writes nothing when the token exchange rejects", async () => {
      oauthToken.mockRejectedValue(new Error("invalid_grant"));
      const app = await buildApp();
      const state = await connectAndGetState(app);
      const res = await app.request(
        `/stripe/oauth/callback?state=${state}&code=bad`,
      );
      expect(res.status).toBe(502);
      expect(insertConnection).not.toHaveBeenCalled();
    });

    it("persists the account id, livemode and capabilities on success", async () => {
      oauthToken.mockResolvedValue({
        stripe_user_id: "acct_success",
        livemode: true,
        scope: "read_write",
        access_token: "sk_live_LEAK",
        refresh_token: "rt_LEAK",
      });
      accountsRetrieve.mockResolvedValue({
        charges_enabled: true,
        payouts_enabled: false,
        capabilities: { card_payments: "active" },
        country: "TR",
        default_currency: "try",
      });
      const app = await buildApp();
      const state = await connectAndGetState(app);
      const res = await app.request(
        `/stripe/oauth/callback?state=${state}&code=good`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("stripe=connected");
      expect(insertConnection).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          projectId: "proj_1",
          stripeAccountId: "acct_success",
          livemode: true,
          chargesEnabled: true,
          payoutsEnabled: false,
          connectedBy: "user_1",
        }),
      );
      expect(auditFn).toHaveBeenCalledWith(
        expect.objectContaining({ action: "stripe.connected" }),
        expect.anything(),
      );
    });

    it("never hands an OAuth token to the repository", async () => {
      oauthToken.mockResolvedValue({
        stripe_user_id: "acct_1",
        livemode: true,
        scope: "read_write",
        access_token: "sk_live_LEAK",
        refresh_token: "rt_LEAK",
      });
      accountsRetrieve.mockResolvedValue({
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: {},
      });
      const app = await buildApp();
      const state = await connectAndGetState(app);
      await app.request(`/stripe/oauth/callback?state=${state}&code=good`);
      const written = JSON.stringify(insertConnection.mock.calls[0]?.[1] ?? {});
      expect(written).not.toContain("LEAK");
      expect(written).not.toContain("access_token");
      expect(written).not.toContain("refresh_token");
    });
  });

  describe("DELETE …/stripe/connect", () => {
    it("404s when there is nothing to disconnect", async () => {
      const app = await buildApp();
      const res = await app.request(connectPath, { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("soft-deletes locally even when Stripe's deauthorize fails", async () => {
      findActiveByProject.mockResolvedValue({
        id: "conn_1",
        stripeAccountId: "acct_1",
        livemode: true,
      });
      oauthDeauthorize.mockRejectedValue(new Error("already deauthorized"));
      const app = await buildApp();
      const res = await app.request(connectPath, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(markDisconnected).toHaveBeenCalledWith(
        expect.anything(),
        "conn_1",
        "user",
      );
      expect(auditFn).toHaveBeenCalledWith(
        expect.objectContaining({ action: "stripe.disconnected" }),
        expect.anything(),
      );
    });
  });
});
```

- [ ] **Step 9: Run the suite**

Run: `pnpm --filter @rovenue/api exec vitest run tests/stripe-connect-routes.test.ts src/services/stripe/oauth-state.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/stripe/oauth-state.ts apps/api/src/services/stripe/oauth-state.test.ts apps/api/src/routes/dashboard/stripe-connect.ts apps/api/src/routes/stripe-oauth.ts apps/api/src/routes/dashboard/index.ts apps/api/src/app.ts apps/api/src/lib/audit.ts apps/api/tests/stripe-connect-routes.test.ts
git commit -m "feat(api): Stripe Connect OAuth connect, callback and disconnect"
```

---

### Task 5: Connect webhook endpoint

**Files:**
- Create: `apps/api/src/routes/webhooks/stripe-connect.ts`
- Modify: `apps/api/src/routes/webhooks/index.ts`
- Test: `apps/api/tests/stripe-connect-webhook.test.ts`

**Interfaces:**
- Consumes: `getConnectPlatformStripe` (Task 1), `drizzle.stripeConnectionRepo` (Task 2), the existing `webhookReplayGuard` and `enqueueWebhookEvent`.
- Produces: `stripeConnectWebhookRoute`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/stripe-connect-webhook.test.ts`, following the
`vi.resetModules()` + `process.env` + `createApp()` harness that
`apps/api/tests/billing-stripe-webhook.test.ts` uses:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

const SECRET = "whsec_connect_test";

const findActiveByAccountId = vi.hoisted(() => vi.fn());
const markDisconnected = vi.hoisted(() => vi.fn());
const updateAccountState = vi.hoisted(() => vi.fn());
const enqueueWebhookEvent = vi.hoisted(() =>
  vi.fn(async () => ({ id: "job_1" })),
);

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      stripeConnectionRepo: {
        findActiveByAccountId,
        markDisconnected,
        updateAccountState,
      },
    },
  };
});

vi.mock("../src/services/webhook-processor", () => ({ enqueueWebhookEvent }));

describe("POST /webhooks/stripe/connect", () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...original };
    process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_CONNECT_CLIENT_ID = "ca_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = SECRET;
    findActiveByAccountId.mockReset();
    markDisconnected.mockReset();
    updateAccountState.mockReset();
    enqueueWebhookEvent.mockClear();
  });

  afterEach(() => {
    process.env = { ...original };
  });

  async function buildApp() {
    const { createApp } = await import("../src/app");
    return createApp();
  }

  function post(payload: unknown, signed = true) {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signed
      ? Stripe.webhooks.generateTestHeaderString({
          payload: body,
          secret: SECRET,
          timestamp,
        })
      : "t=1,v1=deadbeef";
    return { body, headers: { "stripe-signature": signature } };
  }

  function event(overrides: Record<string, unknown>) {
    return {
      id: "evt_1",
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000),
      account: "acct_connected",
      data: { object: {} },
      ...overrides,
    };
  }

  it("401s when the signature does not verify", async () => {
    const app = await buildApp();
    const { body, headers } = post(event({}), false);
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(401);
  });

  it("400s when the event has no account field", async () => {
    // A platform event reaching the Connect endpoint is a
    // misconfiguration and must be loud, not silently dropped.
    const app = await buildApp();
    const { body, headers } = post(event({ account: undefined }));
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(400);
    expect(enqueueWebhookEvent).not.toHaveBeenCalled();
  });

  it("202s with unknown_account when no active connection matches", async () => {
    // In-flight events after a disconnect must not be retried forever.
    findActiveByAccountId.mockResolvedValue(null);
    const app = await buildApp();
    const { body, headers } = post(event({}));
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { status: "unknown_account" } });
    expect(enqueueWebhookEvent).not.toHaveBeenCalled();
  });

  it("enqueues with the resolved projectId and source STRIPE", async () => {
    findActiveByAccountId.mockResolvedValue({
      id: "conn_1",
      projectId: "proj_1",
      stripeAccountId: "acct_connected",
      livemode: false,
    });
    const app = await buildApp();
    const { body, headers } = post(event({}));
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(202);
    expect(enqueueWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ source: "STRIPE", projectId: "proj_1" }),
    );
  });

  it("does not enqueue the same event id twice", async () => {
    findActiveByAccountId.mockResolvedValue({
      id: "conn_1",
      projectId: "proj_1",
      stripeAccountId: "acct_connected",
      livemode: false,
    });
    const app = await buildApp();
    const { body, headers } = post(event({ id: "evt_dup" }));
    await app.request("/webhooks/stripe/connect", { method: "POST", body, headers });
    const second = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    // The replay guard short-circuits the duplicate before the queue.
    expect(second.status).toBe(400);
    expect(enqueueWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it("soft-disconnects on account.application.deauthorized", async () => {
    findActiveByAccountId.mockResolvedValue({
      id: "conn_1",
      projectId: "proj_1",
      stripeAccountId: "acct_connected",
      livemode: false,
    });
    const app = await buildApp();
    const { body, headers } = post(
      event({ id: "evt_deauth", type: "account.application.deauthorized" }),
    );
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(202);
    expect(markDisconnected).toHaveBeenCalledWith(
      expect.anything(),
      "conn_1",
      "stripe_deauthorized",
    );
    expect(enqueueWebhookEvent).not.toHaveBeenCalled();
  });

  it("refreshes capabilities on account.updated", async () => {
    findActiveByAccountId.mockResolvedValue({
      id: "conn_1",
      projectId: "proj_1",
      stripeAccountId: "acct_connected",
      livemode: false,
    });
    const app = await buildApp();
    const { body, headers } = post(
      event({
        id: "evt_updated",
        type: "account.updated",
        data: {
          object: {
            charges_enabled: true,
            payouts_enabled: true,
            capabilities: { card_payments: "active" },
            country: "TR",
            default_currency: "try",
          },
        },
      }),
    );
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(202);
    expect(updateAccountState).toHaveBeenCalledWith(
      expect.anything(),
      "conn_1",
      expect.objectContaining({ chargesEnabled: true, country: "TR" }),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run tests/stripe-connect-webhook.test.ts`
Expected: FAIL — the route does not exist (404).

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/webhooks/stripe-connect.ts`:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type Stripe from "stripe";
import { drizzle } from "@rovenue/db";
import { webhookReplayGuard } from "../../middleware/webhook-replay-guard";
import { enqueueWebhookEvent } from "../../services/webhook-processor";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { ok } from "../../lib/response";
import { getConnectPlatformStripe } from "../../lib/stripe-platform";

// =============================================================
// Stripe Connect webhook — one endpoint for every connected account
// =============================================================
//
// Replaces the per-project /webhooks/stripe/:projectId route. The
// project is discovered from `event.account` instead of the URL, so
// customers configure no webhook of their own. Everything downstream
// (claimWebhookEvent idempotency on (STRIPE, event.id), status
// mapping, revenue dedupe keys) is unchanged.

const log = logger.child("route:webhook:stripe-connect");
const TOLERANCE_SECONDS = 300;

export const stripeConnectWebhookRoute = new Hono().post(
  "/connect",
  async (c, next) => {
    // Signature verification is inline rather than a shared middleware
    // because it needs no project lookup — one platform-level secret
    // covers every connected account.
    const signature = c.req.header("stripe-signature");
    if (!signature) {
      throw new HTTPException(401, { message: "Missing Stripe-Signature header" });
    }
    const secret = env.STRIPE_CONNECT_WEBHOOK_SECRET;
    const stripe = getConnectPlatformStripe(true) ?? getConnectPlatformStripe(false);
    if (!secret || !stripe) {
      throw new HTTPException(503, { message: "Stripe Connect is not configured" });
    }

    const rawBody = await c.req.text();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        secret,
        TOLERANCE_SECONDS,
      );
    } catch (err) {
      log.warn("connect webhook signature verification failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      throw new HTTPException(401, { message: "Invalid Stripe signature" });
    }

    c.set("verifiedWebhook", { source: "STRIPE", rawBody, event });
    c.set("webhookEventId", event.id);
    c.set("webhookEventTimestamp", event.created);
    await next();
  },
  webhookReplayGuard({ source: "stripe" }),
  async (c) => {
    const verified = c.get("verifiedWebhook");
    if (!verified || verified.source !== "STRIPE") {
      throw new HTTPException(500, { message: "Verified payload missing" });
    }
    const event = verified.event;

    const accountId = event.account;
    if (!accountId) {
      // Platform-account events belong at /billing/stripe/webhook.
      log.warn("connect webhook received an event with no account", {
        eventId: event.id,
        eventType: event.type,
      });
      throw new HTTPException(400, { message: "Event has no connected account" });
    }

    const connection = await drizzle.stripeConnectionRepo.findActiveByAccountId(
      drizzle.db,
      accountId,
    );
    if (!connection) {
      // Almost always an in-flight event for an account that just
      // disconnected. Ack so Stripe stops retrying.
      log.info("connect webhook for unknown account", {
        accountId,
        eventId: event.id,
      });
      return c.json(ok({ status: "unknown_account" as const }), 202);
    }

    const projectId = connection.projectId;

    // Connection lifecycle events are handled here rather than in the
    // subscription pipeline — they are about the link, not about a
    // customer's purchase.
    if (event.type === "account.application.deauthorized") {
      await drizzle.stripeConnectionRepo.markDisconnected(
        drizzle.db,
        connection.id,
        "stripe_deauthorized",
      );
      log.info("stripe account deauthorized from Stripe's side", { projectId });
      return c.json(ok({ status: "disconnected" as const }), 202);
    }

    if (event.type === "account.updated") {
      const account = event.data.object as Stripe.Account;
      await drizzle.stripeConnectionRepo.updateAccountState(
        drizzle.db,
        connection.id,
        {
          chargesEnabled: Boolean(account.charges_enabled),
          payoutsEnabled: Boolean(account.payouts_enabled),
          capabilities: account.capabilities ?? {},
          country: account.country ?? null,
          defaultCurrency: account.default_currency ?? null,
        },
      );
      return c.json(ok({ status: "account_synced" as const }), 202);
    }

    const job = await enqueueWebhookEvent({
      source: "STRIPE",
      projectId,
      event,
    });

    log.info("connect notification enqueued", {
      projectId,
      accountId,
      eventType: event.type,
      eventId: event.id,
      jobId: job.id,
    });

    return c.json(
      ok({ status: "enqueued" as const, jobId: job.id }),
      202,
    );
  },
);
```

- [ ] **Step 4: Mount it**

In `apps/api/src/routes/webhooks/index.ts`, import the new route and mount it, keeping the existing per-store limiter shape:

```ts
import { stripeConnectWebhookRoute } from "./stripe-connect";
```

and in the chain, **before** the existing `.route("/stripe", stripeWebhookRoute)`:

```ts
  .use("/stripe/*", storeLimit("stripe"))
  .route("/stripe", stripeConnectWebhookRoute)
  .route("/stripe", stripeWebhookRoute)   // removed in Task 8
```

Ordering matters here and is easy to get wrong. Two sub-apps are mounted at the
same prefix for the duration of this task, and the old route's pattern is
`/:projectId` — which happily matches the literal segment `connect`. Mounted
in the wrong order, every Connect webhook would be handled by the old
per-project route as though `connect` were a project id, and would 401 on the
credential lookup. Registering the Connect route first makes it win.

Add a regression assertion to the Task 5 test file so the ordering cannot
silently regress before Task 8 deletes the old route:

```ts
it("is not swallowed by the legacy /stripe/:projectId route", async () => {
  findActiveByAccountId.mockResolvedValue(null);
  const app = await buildApp();
  const { body, headers } = post(event({}));
  const res = await app.request("/webhooks/stripe/connect", {
    method: "POST",
    body,
    headers,
  });
  // The legacy route answers 401 for an unknown project; the Connect
  // route answers 202 unknown_account. Anything else means the mount
  // order regressed.
  expect(res.status).toBe(202);
});
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @rovenue/api exec vitest run tests/stripe-connect-webhook.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/webhooks/stripe-connect.ts apps/api/src/routes/webhooks/index.ts apps/api/tests/stripe-connect-webhook.test.ts
git commit -m "feat(api): platform Connect webhook routed by event.account"
```

---

### Task 6: Move refunds and scheduled cancellations onto the connected client

**Files:**
- Modify: `apps/api/src/services/refunds/refund-transaction.ts:126-142`
- Modify: `apps/api/src/workers/scheduled-actions.ts:157-176`
- Test: `apps/api/src/services/refunds/refund-transaction.test.ts` (extend), `apps/api/src/workers/scheduled-actions.test.ts` (extend)

**Interfaces:**
- Consumes: `getConnectedStripe` (Task 3).
- Produces: nothing new.

**Important:** `refundTransaction` does not throw on a missing store
credential — it returns `{ ok: false, code: "store_error", message }`
(`apps/api/src/services/refunds/refund-transaction.ts:126-134`). Preserve that
contract exactly; use `getConnectedStripe` (nullable) rather than
`requireConnectedStripe` so the "not connected" case stays a result value, not
an exception.

- [ ] **Step 1: Write the failing refund tests**

Add to `apps/api/src/services/refunds/refund-transaction.test.ts`:

```ts
it("issues the refund against the connected account", async () => {
  const refundsCreate = vi.fn(async () => ({ id: "re_1" }));
  getConnectedStripe.mockResolvedValue({
    stripe: { refunds: { create: refundsCreate } },
    accountId: "acct_1",
    livemode: true,
  });

  const result = await refundTransaction({
    projectId: "proj_1",
    purchaseId: "pur_1",
  });

  expect(result).toMatchObject({ ok: true, store: "stripe", reference: "re_1" });
  expect(refundsCreate).toHaveBeenCalledWith(
    { payment_intent: "pi_123" },
    { idempotencyKey: "refund_pur_1", stripeAccount: "acct_1" },
  );
});

it("returns store_error when the project has no Stripe connection", async () => {
  getConnectedStripe.mockResolvedValue(null);

  const result = await refundTransaction({
    projectId: "proj_1",
    purchaseId: "pur_1",
  });

  expect(result).toMatchObject({ ok: false, code: "store_error" });
});
```

Mock the module with
`vi.mock("../../lib/stripe-platform", () => ({ getConnectedStripe }))` where
`getConnectedStripe` is a `vi.hoisted(() => vi.fn())`, and arrange the fixture
purchase with `store: "STRIPE"` and `storeTransactionId: "pi_123"` so the
`pi_` branch is the one exercised. Add a sibling case with a `ch_`-prefixed
reference asserting `{ charge: "ch_123" }` — that branching is easy to break
during the rewire.

Add the equivalent pair to `apps/api/src/workers/scheduled-actions.test.ts`
for `subscriptions.update`, asserting the third argument is
`{ stripeAccount: "acct_1" }` and that a missing connection is surfaced the
way that worker already surfaces store failures.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/refunds/refund-transaction.test.ts src/workers/scheduled-actions.test.ts`
Expected: FAIL — the code still calls `loadStripeCredentials` / `getStripeClient`.

- [ ] **Step 3: Rewire the refund path**

In `apps/api/src/services/refunds/refund-transaction.ts`, replace lines 127-141 with:

```ts
      const connected = await getConnectedStripe(projectId);
      if (!connected) {
        return {
          ok: false,
          code: "store_error",
          message: "No Stripe connection for this project.",
        };
      }
      const params = ref.startsWith("pi_")
        ? { payment_intent: ref }
        : { charge: ref };
      const refund = await connected.stripe.refunds.create(params, {
        idempotencyKey: `refund_${purchase.id}`,
        stripeAccount: connected.accountId,
      });
```

Add `import { getConnectedStripe } from "../../lib/stripe-platform";` and drop
the now-unused `loadStripeCredentials` / `getStripeClient` imports. The
idempotency key is unchanged — it must stay `refund_<purchaseId>` or a retried
refund double-charges the customer's account.

- [ ] **Step 4: Rewire the scheduled-cancel path**

In `apps/api/src/workers/scheduled-actions.ts:157-176`, apply the same shape:

```ts
const connected = await getConnectedStripe(projectId);
if (!connected) {
  throw new Error(`Project ${projectId} has no active Stripe connection`);
}
await connected.stripe.subscriptions.update(subscriptionId, updateParams, {
  stripeAccount: connected.accountId,
});
```

Throwing is correct here because this runs inside a BullMQ job, where a throw
is the retry signal — unlike the refund path, which answers a dashboard request
with a result object.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/api exec vitest run src/services/refunds/refund-transaction.test.ts src/workers/scheduled-actions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/refunds/refund-transaction.ts apps/api/src/workers/scheduled-actions.ts apps/api/src/services/refunds/refund-transaction.test.ts apps/api/src/workers/scheduled-actions.test.ts
git commit -m "refactor(api): refunds and scheduled cancels run on the connected account"
```

---

### Task 7: Replace the paywall publish gate

**Files:**
- Modify: `apps/api/src/routes/dashboard/funnels.ts:353-363`
- Test: `apps/api/tests/funnels-publish-gate.test.ts`

**Interfaces:**
- Consumes: `chargesEnabled` (Task 3).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/funnels-publish-gate.test.ts`. Reuse the
`requireDashboardAuth` / `assertProjectAccess` stubs from
`stripe-connect-routes.test.ts`, and mock the funnel repositories so publish
reaches the gate without touching a database:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const chargesEnabled = vi.hoisted(() => vi.fn());
const findFunnelById = vi.hoisted(() => vi.fn());
const nextVersionNo = vi.hoisted(() => vi.fn(async () => 1));
const insertVersion = vi.hoisted(() => vi.fn(async () => ({ id: "ver_1", versionNo: 1 })));
const setCurrentVersion = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/stripe-platform", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/stripe-platform")>();
  return { ...actual, chargesEnabled };
});

vi.mock("../src/lib/project-access", () => ({
  assertProjectAccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "user_1" });
    await next();
  },
}));

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
      funnelRepo: { findById: findFunnelById, setCurrentVersion },
      funnelVersionRepo: { nextVersionNo, insert: insertVersion },
    },
  };
});

const paywallPages = [
  { id: "p1", type: "info", title: "Hi" },
  { id: "p2", type: "paywall", headline: "Unlock" },
  { id: "p3", type: "success", headline: "Done" },
];
const noPaywallPages = [
  { id: "p1", type: "info", title: "Hi" },
  { id: "p3", type: "success", headline: "Done" },
];

function funnel(pages: unknown[]) {
  return {
    id: "fnl_1",
    projectId: "proj_1",
    slug: "onboarding",
    draftPagesJson: pages,
    draftThemeJson: {},
    draftSettingsJson: {},
  };
}

const publishPath = "/dashboard/projects/proj_1/funnels/fnl_1/publish";

async function publish() {
  vi.resetModules();
  const { createApp } = await import("../src/app");
  return createApp().request(publishPath, { method: "POST" });
}

describe("funnel publish paywall gate", () => {
  beforeEach(() => {
    chargesEnabled.mockReset();
    findFunnelById.mockReset();
    insertVersion.mockClear();
  });

  it("rejects with STRIPE_NOT_CONNECTED when the project cannot take charges", async () => {
    findFunnelById.mockResolvedValue(funnel(paywallPages));
    chargesEnabled.mockResolvedValue(false);
    const res = await publish();
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("STRIPE_NOT_CONNECTED");
    expect(insertVersion).not.toHaveBeenCalled();
  });

  it("publishes a paywall funnel when charges are enabled", async () => {
    findFunnelById.mockResolvedValue(funnel(paywallPages));
    chargesEnabled.mockResolvedValue(true);
    const res = await publish();
    expect(res.status).toBe(200);
    expect(insertVersion).toHaveBeenCalled();
  });

  it("publishes a funnel with no paywall page regardless of connection", async () => {
    findFunnelById.mockResolvedValue(funnel(noPaywallPages));
    chargesEnabled.mockResolvedValue(false);
    const res = await publish();
    expect(res.status).toBe(200);
    // The gate must not even ask when there is nothing to charge for.
    expect(chargesEnabled).not.toHaveBeenCalled();
  });

  it("applies the gate outside production too", async () => {
    // The old placeholder only ran when NODE_ENV === "production", which
    // let unpublishable funnels through everywhere else.
    expect(process.env.NODE_ENV).not.toBe("production");
    findFunnelById.mockResolvedValue(funnel(paywallPages));
    chargesEnabled.mockResolvedValue(false);
    const res = await publish();
    expect(res.status).toBe(400);
  });
});
```

Note: the third case asserts `chargesEnabled` is never called for a
paywall-free funnel, which pins the ordering of the `pages.some(...)` check
before the capability lookup.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run tests/funnels-publish-gate.test.ts`
Expected: FAIL — the current gate keys on `NODE_ENV === "production"` only, so the last two cases behave wrongly.

- [ ] **Step 3: Replace the gate**

In `apps/api/src/routes/dashboard/funnels.ts`, replace lines 353-363 with:

```ts
    // Paywall pages require an account that can actually take a card.
    // Connecting is not sufficient — Stripe withholds charges_enabled
    // and the card_payments capability until verification completes.
    if (pages.some((p) => p.type === "paywall")) {
      const canCharge = await chargesEnabled(projectId);
      if (!canCharge) {
        throw new HTTPException(400, {
          message: JSON.stringify({ code: "STRIPE_NOT_CONNECTED" }),
        });
      }
    }
```

Add `import { chargesEnabled } from "../../lib/stripe-platform";` to the imports.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/api exec vitest run tests/funnels-publish-gate.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/funnels.ts apps/api/tests/funnels-publish-gate.test.ts
git commit -m "feat(api): gate paywall publish on real Stripe charge capability"
```

---

### Task 8: Remove the API-key path (server)

**Files:**
- Delete: `apps/api/src/routes/webhooks/stripe.ts`
- Modify: `apps/api/src/routes/webhooks/index.ts`, `apps/api/src/middleware/webhook-verify.ts:265-315`, `apps/api/src/lib/project-credentials.ts:24-29,42,82-101`, `apps/api/src/routes/dashboard/credentials.ts`, `apps/api/src/services/stripe/stripe-webhook.ts:31-41,73-97`, `apps/api/src/routes/health.ts:243-262`, `apps/api/src/routes/dashboard/projects.ts:131`
- Modify: `packages/db/src/helpers/encrypted-field.ts:17-21,57-62`, `packages/db/src/drizzle/repositories/projects.ts:75,94,330,352`, `packages/db/src/drizzle/schema.ts:267`, `packages/shared/src/dashboard.ts:132,165`
- Create: `packages/db/drizzle/migrations/0087_drop_stripe_credentials.sql`
- Modify: `apps/api/tests/dashboard-credentials.test.ts`, `apps/api/tests/webhook-verify.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: `CredentialStore` narrows to `"apple" | "google"`.

- [ ] **Step 1: Delete the route and its mount**

Delete `apps/api/src/routes/webhooks/stripe.ts`. In `apps/api/src/routes/webhooks/index.ts`, remove the `stripeWebhookRoute` import and its `.route("/stripe", stripeWebhookRoute)` line, keeping the Connect route and the `storeLimit("stripe")` use.

- [ ] **Step 2: Delete the verifier**

In `apps/api/src/middleware/webhook-verify.ts`, delete the whole Stripe section (lines 265-315: the `STRIPE_TOLERANCE_SECONDS` constant and `verifyStripeWebhook`) plus the now-unused `loadStripeCredentials`, `getStripeClient` and `STRIPE_SIGNATURE_HEADER` imports.

- [ ] **Step 3: Delete the credential loader**

In `apps/api/src/lib/project-credentials.ts`, delete `stripeSchema` (lines 24-29), the `StripeCredentials` type export (line 42), and `loadStripeCredentials` (lines 82-101).

- [ ] **Step 4: Narrow the credentials route**

In `apps/api/src/routes/dashboard/credentials.ts`: delete `stripeCredentialsBodySchema`, the `store === "stripe"` branch in `safeFields`, the `stripeRow` fetch and its entries in the `project` object and `payload.credentials`, and the stripe arm of the `PUT`/`DELETE` store dispatch. In `packages/shared/src/dashboard.ts`, narrow `CredentialStore` to `"apple" | "google"` and delete `UpdateStripeCredentialsRequest`.

- [ ] **Step 5: Delete the per-secret client cache**

In `apps/api/src/services/stripe/stripe-webhook.ts`, delete `getStripeClient` and its `Map` cache (lines 31-41) and the legacy synchronous `handleStripeNotification` (lines 73-97). Update `apps/api/src/services/webhook-processor.ts:147-160` so the Stripe branch resolves its client with `requireConnectedStripe(projectId)` instead of reloading credentials, and passes `{ stripeAccount: accountId }` on every Stripe call it makes.

- [ ] **Step 6: Drop the column**

Remove `stripeCredentials: jsonb("stripeCredentials"),` from `packages/db/src/drizzle/schema.ts:267`. Remove `"stripeCredentials"` from `CREDENTIAL_FIELDS` and from `ProjectCredentialsInput` in `packages/db/src/helpers/encrypted-field.ts`. Remove the `stripe` branches from `findProjectCredentials`, `writeProjectCredential` and `clearProjectCredential` in `packages/db/src/drizzle/repositories/projects.ts`.

Create `packages/db/drizzle/migrations/0087_drop_stripe_credentials.sql`:

```sql
-- Stripe Connect replaces per-project API keys. This is destructive and
-- irreversible: every project must reconnect via OAuth after deploy.
ALTER TABLE "projects" DROP COLUMN IF EXISTS "stripeCredentials";
```

- [ ] **Step 7: Update health and the settings guard**

In `apps/api/src/routes/health.ts`, replace the Stripe `configured` check with the connection state: `configured` becomes "an active connection exists", and add `chargesEnabled`. In `apps/api/src/routes/dashboard/projects.ts:131`, drop `stripeCredentials` from the guidance message so it reads `store secrets in appleCredentials / googleCredentials instead`.

- [ ] **Step 8: Update the affected tests**

In `apps/api/tests/dashboard-credentials.test.ts`, delete the stripe cases (their replacement coverage lives in `stripe-connect-routes.test.ts`). In `apps/api/tests/webhook-verify.test.ts`, delete the `verifyStripeWebhook` cases (replaced by `stripe-connect-webhook.test.ts`).

- [ ] **Step 9: Run the full API and DB suites**

Run: `pnpm --filter @rovenue/api test && pnpm --filter @rovenue/db test`
Expected: PASS. Any remaining failure naming `stripeCredentials`, `loadStripeCredentials` or `getStripeClient` is a missed reference — fix it before committing.

- [ ] **Step 10: Typecheck the whole workspace**

Run: `pnpm build`
Expected: no TypeScript errors. `CredentialStore` narrowing will surface any dashboard code still naming `"stripe"` as a credential store; those are fixed in Tasks 9-10.

- [ ] **Step 11: Commit**

Stage tracked modifications and deletions plus the one new file explicitly —
never `git add -A` here, which would also sweep up any untracked scratch file
that happens to be in the tree:

```bash
git add -u
git add packages/db/drizzle/migrations/0087_drop_stripe_credentials.sql
git status --short   # confirm nothing unexpected is staged before committing
git commit -m "refactor!: remove per-project Stripe API-key integration

Stripe Connect fully replaces pasted secret and webhook keys. Drops
projects.stripeCredentials, the /webhooks/stripe/:projectId route, the
verifyStripeWebhook middleware and the per-secret client cache.

BREAKING CHANGE: every project must reconnect Stripe via OAuth after
deploy; until then no Stripe webhooks are received for that project."
```

---

### Task 9: Dashboard Stripe Connect card

**Files:**
- Create: `apps/dashboard/src/components/stores/stripe-connect-card.tsx`
- Create: `apps/dashboard/src/lib/hooks/useStripeConnection.ts`
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/stores.tsx`
- Modify: `apps/dashboard/src/i18n/locales/en.json`
- Test: `apps/dashboard/src/components/stores/stripe-connect-card.test.tsx`

**Interfaces:**
- Consumes: `GET /dashboard/projects/:projectId/stripe/connection`, `GET …/stripe/connect`, `DELETE …/stripe/connect` (Task 4).
- Produces: `useStripeConnection(projectId)` returning `{ data, isLoading }` where `data` is `{ platformConfigured: boolean; testModeAvailable: boolean; connection: StripeConnectionSummary | null }`.

- [ ] **Step 1: Write the failing component test**

Create `apps/dashboard/src/components/stores/stripe-connect-card.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "../../tests/render";
import { StripeConnectCard } from "./stripe-connect-card";

const useStripeConnection = vi.hoisted(() => vi.fn());
vi.mock("../../lib/hooks/useStripeConnection", () => ({
  useStripeConnection,
  useDisconnectStripe: () => ({ mutate: vi.fn(), isPending: false }),
}));

function arrange(data: unknown) {
  useStripeConnection.mockReturnValue({ data, isLoading: false });
  return renderWithRouter(<StripeConnectCard projectId="proj_1" />);
}

const CONNECTED = {
  accountId: "acct_1A2B3C",
  livemode: true,
  chargesEnabled: true,
  payoutsEnabled: true,
  country: "TR",
  defaultCurrency: "try",
  connectedAt: "2026-07-21T00:00:00.000Z",
};

describe("StripeConnectCard", () => {
  it("explains the deployment is unconfigured and offers no connect action", () => {
    arrange({ platformConfigured: false, testModeAvailable: false, connection: null });
    expect(screen.getByTestId("stripe-platform-unconfigured")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connect/i })).toBeNull();
  });

  it("offers a connect action when no account is linked", () => {
    arrange({ platformConfigured: true, testModeAvailable: true, connection: null });
    expect(screen.getByRole("button", { name: /connect/i })).toBeInTheDocument();
    expect(screen.queryByText(/acct_/)).toBeNull();
  });

  it("hides the test-mode option when the platform has no test client id", () => {
    arrange({ platformConfigured: true, testModeAvailable: false, connection: null });
    expect(screen.queryByTestId("stripe-connect-test-mode")).toBeNull();
  });

  it("shows the account, a live badge and a disconnect action when connected", () => {
    arrange({ platformConfigured: true, testModeAvailable: true, connection: CONNECTED });
    expect(screen.getByText("acct_1A2B3C")).toBeInTheDocument();
    expect(screen.getByTestId("stripe-livemode-badge")).toHaveTextContent(/live/i);
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
  });

  it("warns that verification is pending when charges are not yet enabled", () => {
    arrange({
      platformConfigured: true,
      testModeAvailable: true,
      connection: { ...CONNECTED, chargesEnabled: false },
    });
    expect(screen.getByTestId("stripe-verification-pending")).toBeInTheDocument();
  });
});
```

The `data-testid` hooks above (`stripe-platform-unconfigured`,
`stripe-connect-test-mode`, `stripe-livemode-badge`,
`stripe-verification-pending`) are part of the component's contract — add them
in Step 4.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/stores/stripe-connect-card.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

Create `apps/dashboard/src/lib/hooks/useStripeConnection.ts` following the shape of the existing `useProjectCredentials.ts`: a `useQuery` keyed `["stripe-connection", projectId]` hitting the connection endpoint through `rpc`/`unwrap`, plus a `useDisconnectStripe(projectId)` mutation that invalidates that key.

- [ ] **Step 4: Implement the card**

Create `apps/dashboard/src/components/stores/stripe-connect-card.tsx`. Connecting is a full-page navigation, not a fetch — the button sets `window.location.href` to the connect endpoint (with `?mode=test` when the user picks test), because the endpoint answers with a 302 to Stripe. Disconnect opens the shared `ConfirmDialog` whose body states plainly that existing subscriptions on the customer's account keep billing and only Rovenue's access stops.

- [ ] **Step 5: Swap it into the Stores page**

In `apps/dashboard/src/routes/_authed/projects/$projectId/stores.tsx`, render `<StripeConnectCard projectId={projectId} />` where the Stripe credential card was, leaving Apple and Google untouched.

- [ ] **Step 6: Add the i18n strings**

Add a `stores.stripe.connect.*` group to `apps/dashboard/src/i18n/locales/en.json` covering: title, description, connect button, test-mode toggle, connected heading, account label, livemode and test badges, verification-pending note, disconnect button, disconnect confirmation title and body, and the platform-unconfigured operator note. Remove the now-dead `stores.stripe.fields.secretKey` and `stores.stripe.fields.webhookSecret` keys.

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/stores/stripe-connect-card.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/components/stores/stripe-connect-card.tsx apps/dashboard/src/components/stores/stripe-connect-card.test.tsx apps/dashboard/src/lib/hooks/useStripeConnection.ts apps/dashboard/src/routes/_authed/projects/\$projectId/stores.tsx apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): Stripe Connect card replaces the credential form"
```

---

### Task 10: Dashboard cleanup — remove the key form and rewire its dependents

**Files:**
- Modify: `apps/dashboard/src/components/stores/store-credential-card.tsx:263-284`
- Modify: `apps/dashboard/src/components/products/store-identifier-fields.tsx:92-94`
- Modify: `apps/dashboard/src/components/project-setup/step-platforms.tsx:134-160`, `apps/dashboard/src/components/project-setup/types.ts:33`, `apps/dashboard/src/components/project-setup/mock-data.ts:81`, `apps/dashboard/src/components/project-setup/step-review.tsx:77`
- Modify: `apps/dashboard/src/lib/hooks/useStoreCredentials.ts`, `apps/dashboard/src/lib/hooks/useProjectCredentials.ts`

**Interfaces:**
- Consumes: `useStripeConnection` (Task 9); the narrowed `CredentialStore` (Task 8).
- Produces: nothing new.

- [ ] **Step 1: Remove the Stripe fields from the credential card**

In `apps/dashboard/src/components/stores/store-credential-card.tsx`, delete the `stripe` branch rendering the secret-key and webhook-secret inputs (lines 263-284) and the `CreditCard` icon import if it becomes unused. The component now handles Apple and Google only; narrow its `store` prop type to match the narrowed `CredentialStore`.

- [ ] **Step 2: Gate the Web price field on the connection**

In `apps/dashboard/src/components/products/store-identifier-fields.tsx`, replace the `credentials.stripe.configured` gate on the "Web" row (lines 92-94) with `useStripeConnection(projectId).data?.connection != null`. The placeholder stays `price_xxx` — `products.storeIds.stripe` still holds a Stripe price id and no product data changes.

- [ ] **Step 3: Make the setup wizard's button real**

In `apps/dashboard/src/components/project-setup/step-platforms.tsx`, delete the `acct_…` `<Input>` and make the button navigate to the connect endpoint for the project being set up. Remove `stripeAcct` from `types.ts:33`, from `mock-data.ts:81`, and from the review row in `step-review.tsx:77`.

- [ ] **Step 4: Drop stripe from the credential hooks**

In `useStoreCredentials.ts` and `useProjectCredentials.ts`, remove `stripe` from the store lists and from any response typing so they match the narrowed `CredentialStore`.

- [ ] **Step 5: Typecheck and run the dashboard suite**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit && pnpm --filter @rovenue/dashboard test`
Expected: no TypeScript errors, tests PASS.

- [ ] **Step 6: Full workspace build**

Run: `pnpm build`
Expected: all packages build clean.

- [ ] **Step 7: Commit**

```bash
git add -u
git status --short   # confirm nothing unexpected is staged before committing
git commit -m "refactor(dashboard): drop the Stripe key form and rewire its dependents"
```

---

### Task 11: End-to-end integration test

**Files:**
- Create: `apps/api/tests/stripe-connect.integration.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the integration test**

Create `apps/api/tests/stripe-connect.integration.test.ts` against the
docker-compose dev Postgres and Redis, with only the Stripe SDK stubbed.
Everything below the routes — DB writes, the audit chain, the partial unique
index — is real.

```ts
// =============================================================
// Stripe Connect — end-to-end lifecycle integration test
// =============================================================
//
// Runs against the docker-compose dev Postgres (host port 5433) and
// Redis, exactly like billing-webhook-handlers.integration.test.ts.
// Only the Stripe SDK is stubbed: `oauth.token`, `oauth.deauthorize`
// and `accounts.retrieve`. The connection row, the audit chain and
// the partial unique index are all real.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { Pool } from "pg";

// MUST precede any @rovenue/db import — the lazy client singleton binds
// DATABASE_URL at first touch.
process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";
process.env.PUBLIC_BASE_URL ??= "https://api.test";
process.env.DASHBOARD_URL ??= "https://app.test";
process.env.STRIPE_CONNECT_CLIENT_ID ??= "ca_live_test";
process.env.STRIPE_PLATFORM_SECRET_KEY ??= "sk_live_fake";
process.env.STRIPE_CONNECT_WEBHOOK_SECRET ??= "whsec_connect_it";

const oauthToken = vi.hoisted(() => vi.fn());
const oauthDeauthorize = vi.hoisted(() => vi.fn(async () => ({})));
const accountsRetrieve = vi.hoisted(() => vi.fn());
const enqueueWebhookEvent = vi.hoisted(() =>
  vi.fn(async () => ({ id: "job_1" })),
);

vi.mock("../src/lib/stripe-platform", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/stripe-platform")>();
  return {
    ...actual,
    getConnectPlatformStripe: () => ({
      oauth: { token: oauthToken, deauthorize: oauthDeauthorize },
      accounts: { retrieve: accountsRetrieve },
      webhooks: Stripe.webhooks,
    }),
  };
});

vi.mock("../src/services/webhook-processor", () => ({ enqueueWebhookEvent }));

vi.mock("../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: USER_ID });
    await next();
  },
}));

vi.mock("../src/lib/project-access", () => ({
  assertProjectAccess: vi.fn().mockResolvedValue(undefined),
}));

const PROJECT_ID = `proj_${randomUUID().slice(0, 8)}`;
const USER_ID = `user_${randomUUID().slice(0, 8)}`;
const ACCOUNT_ID = `acct_${randomUUID().slice(0, 8)}`;
const SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET as string;

let pool: Pool;
let app: Awaited<ReturnType<typeof buildApp>>;

async function buildApp() {
  const { createApp } = await import("../src/app");
  return createApp();
}

function signed(payload: unknown) {
  const body = JSON.stringify(payload);
  return {
    body,
    headers: {
      "stripe-signature": Stripe.webhooks.generateTestHeaderString({
        payload: body,
        secret: SECRET,
        timestamp: Math.floor(Date.now() / 1000),
      }),
    },
  };
}

const connectPath = `/dashboard/projects/${PROJECT_ID}/stripe/connect`;

async function beginConnect(): Promise<string> {
  const res = await app.request(connectPath);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  return location.searchParams.get("state") ?? "";
}

async function activeRows() {
  const { rows } = await pool.query(
    `SELECT * FROM project_stripe_connections
      WHERE project_id = $1 AND disconnected_at IS NULL`,
    [PROJECT_ID],
  );
  return rows;
}

async function auditActions() {
  const { rows } = await pool.query(
    `SELECT action FROM audit_logs WHERE "projectId" = $1 ORDER BY "createdAt"`,
    [PROJECT_ID],
  );
  return rows.map((r) => r.action);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  // Seed the project and user rows the FKs require. Mirror the seeding
  // helper used by billing-webhook-handlers.integration.test.ts.
  await seedProjectAndUser(pool, PROJECT_ID, USER_ID);
  app = await buildApp();

  oauthToken.mockResolvedValue({
    stripe_user_id: ACCOUNT_ID,
    livemode: true,
    scope: "read_write",
    access_token: "sk_live_LEAK",
    refresh_token: "rt_LEAK",
  });
  accountsRetrieve.mockResolvedValue({
    charges_enabled: true,
    payouts_enabled: true,
    capabilities: { card_payments: "active" },
    country: "TR",
    default_currency: "try",
  });
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM project_stripe_connections WHERE project_id = $1",
    [PROJECT_ID],
  );
  await pool.end();
});

describe("Stripe Connect lifecycle", () => {
  it("connects, persists the account and audits it", async () => {
    const state = await beginConnect();
    const res = await app.request(
      `/stripe/oauth/callback?state=${state}&code=ok`,
    );
    expect(res.status).toBe(302);

    const rows = await activeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].stripe_account_id).toBe(ACCOUNT_ID);
    expect(rows[0].livemode).toBe(true);
    expect(rows[0].charges_enabled).toBe(true);
    expect(rows[0].capabilities).toEqual({ card_payments: "active" });
    // The OAuth tokens must not have reached the database in any column.
    expect(JSON.stringify(rows[0])).not.toContain("LEAK");
    expect(await auditActions()).toContain("stripe.connected");
  });

  it("rejects a replayed state and writes no second row", async () => {
    const state = await beginConnect();
    await app.request(`/stripe/oauth/callback?state=${state}&code=ok`);
    const replay = await app.request(
      `/stripe/oauth/callback?state=${state}&code=ok`,
    );
    expect(replay.status).toBe(400);
    expect(await activeRows()).toHaveLength(1);
  });

  it("routes a connected-account webhook to the project", async () => {
    enqueueWebhookEvent.mockClear();
    const { body, headers } = signed({
      id: `evt_${randomUUID().slice(0, 8)}`,
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000),
      account: ACCOUNT_ID,
      data: { object: {} },
    });
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(202);
    expect(enqueueWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ source: "STRIPE", projectId: PROJECT_ID }),
    );
  });

  it("disconnects, audits it, and then ignores that account's events", async () => {
    const del = await app.request(connectPath, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await activeRows()).toHaveLength(0);
    expect(await auditActions()).toContain("stripe.disconnected");

    enqueueWebhookEvent.mockClear();
    const { body, headers } = signed({
      id: `evt_${randomUUID().slice(0, 8)}`,
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000),
      account: ACCOUNT_ID,
      data: { object: {} },
    });
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { status: "unknown_account" } });
    expect(enqueueWebhookEvent).not.toHaveBeenCalled();
  });

  it("allows reconnecting after a disconnect", async () => {
    // Proves the partial unique index is scoped to live rows only.
    const state = await beginConnect();
    const res = await app.request(
      `/stripe/oauth/callback?state=${state}&code=ok`,
    );
    expect(res.status).toBe(302);
    expect(await activeRows()).toHaveLength(1);
  });
});
```

`seedProjectAndUser` is the one helper to lift from
`billing-webhook-handlers.integration.test.ts` — copy its insert statements for
the `user` and `projects` rows rather than inventing new ones, so the FK and
NOT NULL columns stay correct.

- [ ] **Step 2: Run it**

Requires the dev stack to be up (`docker compose up -d postgres redis`).

Run: `pnpm --filter @rovenue/api exec vitest run tests/stripe-connect.integration.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/stripe-connect.integration.test.ts
git commit -m "test(api): end-to-end Stripe Connect lifecycle integration test"
```

---

## Operator runbook (post-merge, before deploy)

This is a breaking change. Perform in order:

1. In the Stripe Dashboard, open **Connect → Settings** and register the platform. Note the live and test OAuth client ids (`ca_…`).
2. Set the redirect URI to `<PUBLIC_BASE_URL>/stripe/oauth/callback` for both modes.
3. Add a platform webhook endpoint pointing at `<PUBLIC_BASE_URL>/webhooks/stripe/connect` with **"Listen to events on Connected accounts"** enabled. Subscribe to the event types the existing dispatcher handles (`customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`) plus `account.updated` and `account.application.deauthorized`. Capture the signing secret.
4. Fill the `STRIPE_CONNECT_*` / `STRIPE_PLATFORM_*` environment group from §6 of the spec.
5. Deploy and run `pnpm db:migrate`.
6. Notify every project owner that they must reconnect Stripe. Until they do, that project receives no Stripe webhooks and its subscription state, entitlements and revenue events stay frozen at their last known values; refunds and scheduled cancellations fail with an explicit error.

Product data survives: `products.storeIds.stripe` holds `price_…` ids on the same account the customer reconnects, so `findProductByStoreId` keeps resolving once the connection is back.
