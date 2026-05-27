# Integrations Framework — Meta CAPI & TikTok Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship outbound conversion delivery from Rovenue domain events to Meta CAPI + TikTok Events API, with per-project configurable scope, dashboard config UI, and 7-day backfill on activation — built on the existing outbox→Kafka→BullMQ pipeline.

**Architecture:** New Kafka consumer (`integrations-fanout`) subscribes to existing `rovenue.revenue` + `rovenue.billing` topics, enqueues per-(connection × outbox event) BullMQ jobs into a new `rovenue-integrations-deliver` queue. Stateless provider modules (Meta CAPI, TikTok Events) implement a narrow `IntegrationProvider` interface (`validateCredentials`, `mapEvent`, `deliver`). Idempotency via `UNIQUE(connection_id, outbox_event_id, created_at)` on a pg_partman-partitioned `integration_deliveries` table. PII never at-rest — SDK ships per-event `identityContext` hashed at delivery time.

**Tech Stack:** Hono + TypeScript, Drizzle ORM + drizzle-kit migrations, PostgreSQL 16 + pg_partman, Kafka/Redpanda + kafkajs, BullMQ + Redis, AES-256-GCM via `packages/shared/src/crypto.ts`, vitest + testcontainers, undici MockAgent for HTTP test stubs, base-ui Dialog drawer pattern.

**Total milestones:** 8 (M0 through M7). This file is built up in three parts; see plan footer for status.

---

## M0 — Foundations (schema + types + repository)

### Task M0.1: Add integration enums to drizzle enums file

**Files:**
- Modify: `packages/db/src/drizzle/enums.ts`
- Test: `packages/db/src/drizzle/enums.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/drizzle/enums.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { integrationProvider, integrationDeliveryStatus } from "./enums";

describe("integration enums", () => {
  it("exposes IntegrationProvider variants", () => {
    expect(integrationProvider.enumValues).toEqual([
      "META_CAPI",
      "TIKTOK_EVENTS",
    ]);
  });

  it("exposes IntegrationDeliveryStatus variants", () => {
    expect(integrationDeliveryStatus.enumValues).toEqual([
      "pending",
      "succeeded",
      "failed",
      "skipped",
      "dead_letter",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/db test -- enums.test.ts`
Expected: FAIL — `SyntaxError: The requested module './enums' does not provide an export named 'integrationProvider'`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/db/src/drizzle/enums.ts`:

```ts
export const integrationProvider = pgEnum("IntegrationProvider", [
  "META_CAPI",
  "TIKTOK_EVENTS",
]);

export const integrationDeliveryStatus = pgEnum("IntegrationDeliveryStatus", [
  "pending",
  "succeeded",
  "failed",
  "skipped",
  "dead_letter",
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/db test -- enums.test.ts`
Expected: PASS — both assertions green.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/enums.ts packages/db/src/drizzle/enums.test.ts
git commit -m "feat(db): add IntegrationProvider and IntegrationDeliveryStatus enums"
```

### Task M0.2: Add RovenueEventKey shared type

**Files:**
- Create: `packages/shared/src/integrations.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/integrations.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/integrations.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ROVENUE_EVENT_KEYS,
  isRovenueEventKey,
  type RovenueEventKey,
} from "./integrations";

describe("RovenueEventKey", () => {
  it("includes all 8 canonical keys", () => {
    expect(ROVENUE_EVENT_KEYS).toEqual([
      "revenue.INITIAL",
      "revenue.TRIAL_CONVERSION",
      "revenue.RENEWAL",
      "revenue.CREDIT_PURCHASE",
      "revenue.REFUND",
      "revenue.CANCELLATION",
      "subscription.trial.started",
      "subscriber.identified",
    ]);
  });

  it("type-guards a string into RovenueEventKey", () => {
    const candidate = "revenue.RENEWAL";
    expect(isRovenueEventKey(candidate)).toBe(true);
    if (isRovenueEventKey(candidate)) {
      const _t: RovenueEventKey = candidate;
      expect(_t).toBe("revenue.RENEWAL");
    }
  });

  it("rejects unknown strings", () => {
    expect(isRovenueEventKey("revenue.UNKNOWN")).toBe(false);
    expect(isRovenueEventKey("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/shared test -- integrations.test.ts`
Expected: FAIL — `Cannot find module './integrations'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/integrations.ts`:

```ts
export const ROVENUE_EVENT_KEYS = [
  "revenue.INITIAL",
  "revenue.TRIAL_CONVERSION",
  "revenue.RENEWAL",
  "revenue.CREDIT_PURCHASE",
  "revenue.REFUND",
  "revenue.CANCELLATION",
  "subscription.trial.started",
  "subscriber.identified",
] as const;

export type RovenueEventKey = (typeof ROVENUE_EVENT_KEYS)[number];

export function isRovenueEventKey(s: string): s is RovenueEventKey {
  return (ROVENUE_EVENT_KEYS as readonly string[]).includes(s);
}

export type IntegrationProviderId = "META_CAPI" | "TIKTOK_EVENTS";

export type IntegrationDeliveryStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "skipped"
  | "dead_letter";
```

Append to `packages/shared/src/index.ts`:

```ts
export * from "./integrations";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/shared test -- integrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/integrations.ts packages/shared/src/integrations.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add RovenueEventKey canonical mapping keys"
```

### Task M0.3: Drizzle table — integrationConnections

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts`
- Test: `packages/db/src/drizzle/integration-connections.schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/drizzle/integration-connections.schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { integrationConnections } from "./schema";

describe("integrationConnections table", () => {
  it("has every column from spec §3.1", () => {
    const cols = Object.keys(getTableColumns(integrationConnections));
    expect(cols.sort()).toEqual(
      [
        "id",
        "projectId",
        "providerId",
        "displayName",
        "credentialsCipher",
        "credentialsHint",
        "enabledEvents",
        "eventMapping",
        "actionSource",
        "testEventCode",
        "isEnabled",
        "lastValidatedAt",
        "lastError",
        "lastBackfillAt",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
  });

  it("infers expected select / insert types", () => {
    type Row = typeof integrationConnections.$inferSelect;
    const sample: Row = {
      id: "c1",
      projectId: "p1",
      providerId: "META_CAPI",
      displayName: "Test",
      credentialsCipher: "v1:abc",
      credentialsHint: "Pixel 1234",
      enabledEvents: ["revenue.RENEWAL"],
      eventMapping: {},
      actionSource: "app",
      testEventCode: null,
      isEnabled: false,
      lastValidatedAt: null,
      lastError: null,
      lastBackfillAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(sample.providerId).toBe("META_CAPI");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/db test -- integration-connections.schema.test.ts`
Expected: FAIL — `does not provide an export named 'integrationConnections'`.

- [ ] **Step 3: Write minimal implementation**

In `packages/db/src/drizzle/schema.ts`, ensure the imports include `integrationProvider` from `./enums`, then add:

```ts
export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    providerId: integrationProvider("provider_id").notNull(),
    displayName: text("display_name").notNull(),
    credentialsCipher: text("credentials_cipher").notNull(),
    credentialsHint: text("credentials_hint").notNull(),
    enabledEvents: text("enabled_events")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    eventMapping: jsonb("event_mapping")
      .$type<Record<string, { eventName?: string; skip?: true }>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    actionSource: text("action_source").notNull().default("app"),
    testEventCode: text("test_event_code"),
    isEnabled: boolean("is_enabled").notNull().default(false),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastBackfillAt: timestamp("last_backfill_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectProviderUidx: uniqueIndex(
      "integration_connections_project_provider_uidx",
    ).on(t.projectId, t.providerId),
    enabledIdx: index("integration_connections_enabled_idx")
      .on(t.projectId)
      .where(sql`is_enabled = true`),
    actionSourceChk: check(
      "integration_connections_action_source_chk",
      sql`action_source IN ('app', 'website', 'system_generated')`,
    ),
  }),
);

export type IntegrationConnection =
  typeof integrationConnections.$inferSelect;
export type NewIntegrationConnection =
  typeof integrationConnections.$inferInsert;
```

Confirm imports at the top of `schema.ts` include `jsonb`, `boolean`, `uniqueIndex`, `index`, `check`, and `integrationProvider`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/db test -- integration-connections.schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/src/drizzle/integration-connections.schema.test.ts
git commit -m "feat(db): add integrationConnections drizzle table"
```

### Task M0.4: Drizzle table — integrationDeliveries (partitioned)

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts`
- Test: `packages/db/src/drizzle/integration-deliveries.schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/drizzle/integration-deliveries.schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { integrationDeliveries } from "./schema";

describe("integrationDeliveries table", () => {
  it("has spec §3.2 columns", () => {
    const cols = Object.keys(getTableColumns(integrationDeliveries));
    expect(cols.sort()).toEqual(
      [
        "id",
        "connectionId",
        "projectId",
        "providerId",
        "outboxEventId",
        "eventKey",
        "providerEvent",
        "status",
        "attempt",
        "skipReason",
        "httpStatus",
        "responseBody",
        "errorMessage",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
  });

  it("status column is the IntegrationDeliveryStatus enum", () => {
    type Row = typeof integrationDeliveries.$inferSelect;
    const row: Row = {
      id: "d1",
      connectionId: "c1",
      projectId: "p1",
      providerId: "META_CAPI",
      outboxEventId: "o1",
      eventKey: "revenue.RENEWAL",
      providerEvent: "Purchase",
      status: "pending",
      attempt: 0,
      skipReason: null,
      httpStatus: null,
      responseBody: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(row.status).toBe("pending");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/db test -- integration-deliveries.schema.test.ts`
Expected: FAIL — `does not provide an export named 'integrationDeliveries'`.

- [ ] **Step 3: Write minimal implementation**

In `packages/db/src/drizzle/schema.ts`:

```ts
export const integrationDeliveries = pgTable(
  "integration_deliveries",
  {
    id: text("id").notNull(),
    connectionId: text("connection_id").notNull(),
    projectId: text("project_id").notNull(),
    providerId: integrationProvider("provider_id").notNull(),
    outboxEventId: text("outbox_event_id").notNull(),
    eventKey: text("event_key").notNull(),
    providerEvent: text("provider_event"),
    status: integrationDeliveryStatus("status").notNull(),
    attempt: smallint("attempt").notNull().default(0),
    skipReason: text("skip_reason"),
    httpStatus: smallint("http_status"),
    responseBody: text("response_body"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.createdAt] }),
    dedupeUidx: uniqueIndex("integration_deliveries_dedupe_uidx").on(
      t.connectionId,
      t.outboxEventId,
      t.createdAt,
    ),
    connStatusIdx: index(
      "integration_deliveries_connection_status_idx",
    ).on(t.connectionId, t.status, t.createdAt),
    deadLetterIdx: index("integration_deliveries_project_dead_letter_idx")
      .on(t.projectId, t.createdAt)
      .where(sql`status = 'dead_letter'`),
  }),
);

export type IntegrationDelivery =
  typeof integrationDeliveries.$inferSelect;
export type NewIntegrationDelivery =
  typeof integrationDeliveries.$inferInsert;
```

Ensure `smallint`, `primaryKey`, and `integrationDeliveryStatus` are imported at the top of `schema.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/db test -- integration-deliveries.schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/src/drizzle/integration-deliveries.schema.test.ts
git commit -m "feat(db): add integrationDeliveries partitioned drizzle table"
```

### Task M0.5: Migration 0053_integrations_framework.sql

**Files:**
- Create: `packages/db/drizzle/migrations/0053_integrations_framework.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json` (regenerated by drizzle-kit)

- [ ] **Step 1: Write the failing test**

Create `packages/db/drizzle/migrations/0053_integrations_framework.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(
  __dirname,
  "0053_integrations_framework.sql",
);

describe("0053_integrations_framework.sql", () => {
  it("file exists", () => {
    expect(existsSync(FILE)).toBe(true);
  });

  it("creates both tables and the partman parent", () => {
    const sql = readFileSync(FILE, "utf8");
    expect(sql).toContain('CREATE TYPE "public"."IntegrationProvider"');
    expect(sql).toContain('CREATE TABLE "integration_connections"');
    expect(sql).toContain('CREATE TABLE "integration_deliveries"');
    expect(sql).toContain("PARTITION BY RANGE (created_at)");
    expect(sql).toContain("partman.create_parent");
    expect(sql).toContain("p_premake => 7");
    expect(sql).toContain("retention='30 days'");
    expect(sql).toContain("integration_connections_project_provider_uidx");
    expect(sql).toContain("integration_deliveries_dedupe_uidx");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/db test -- 0053_integrations_framework.test.ts`
Expected: FAIL — `existsSync(FILE)` returns false.

- [ ] **Step 3: Write minimal implementation**

Create `packages/db/drizzle/migrations/0053_integrations_framework.sql`:

```sql
CREATE TYPE "public"."IntegrationProvider" AS ENUM('META_CAPI', 'TIKTOK_EVENTS');--> statement-breakpoint
CREATE TYPE "public"."IntegrationDeliveryStatus" AS ENUM('pending', 'succeeded', 'failed', 'skipped', 'dead_letter');--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"provider_id" "IntegrationProvider" NOT NULL,
	"display_name" text NOT NULL,
	"credentials_cipher" text NOT NULL,
	"credentials_hint" text NOT NULL,
	"enabled_events" text[] DEFAULT '{}'::text[] NOT NULL,
	"event_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action_source" text DEFAULT 'app' NOT NULL,
	"test_event_code" text,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_error" text,
	"last_backfill_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connections_action_source_chk" CHECK (action_source IN ('app','website','system_generated'))
);
--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_project_provider_uidx"
  ON "integration_connections" ("project_id", "provider_id");
--> statement-breakpoint
CREATE INDEX "integration_connections_enabled_idx"
  ON "integration_connections" ("project_id") WHERE is_enabled = true;
--> statement-breakpoint
CREATE TABLE "integration_deliveries" (
	"id" text NOT NULL,
	"connection_id" text NOT NULL,
	"project_id" text NOT NULL,
	"provider_id" "IntegrationProvider" NOT NULL,
	"outbox_event_id" text NOT NULL,
	"event_key" text NOT NULL,
	"provider_event" text,
	"status" "IntegrationDeliveryStatus" NOT NULL,
	"attempt" smallint DEFAULT 0 NOT NULL,
	"skip_reason" text,
	"http_status" smallint,
	"response_body" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "integration_deliveries_dedupe_uidx"
  ON "integration_deliveries" ("connection_id", "outbox_event_id", "created_at");
--> statement-breakpoint
CREATE INDEX "integration_deliveries_connection_status_idx"
  ON "integration_deliveries" ("connection_id", "status", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "integration_deliveries_project_dead_letter_idx"
  ON "integration_deliveries" ("project_id", "created_at" DESC) WHERE status = 'dead_letter';
--> statement-breakpoint
SELECT partman.create_parent(
  p_parent_table => 'public.integration_deliveries',
  p_control      => 'created_at',
  p_type         => 'native',
  p_interval     => '1 day',
  p_premake      => 7
);
--> statement-breakpoint
UPDATE partman.part_config
   SET retention='30 days', retention_keep_table=false
 WHERE parent_table='public.integration_deliveries';
```

Also update `packages/db/drizzle/migrations/meta/_journal.json` to register `0053_integrations_framework` after `0052_aggregate_type_funnel` — entry shape mirrors the previous one (idx incremented).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/db test -- 0053_integrations_framework.test.ts`
Expected: PASS.

Also run the migration against the dev DB:

```bash
pnpm db:migrate
```

Expected output: `0053_integrations_framework.sql applied`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/migrations/0053_integrations_framework.sql packages/db/drizzle/migrations/meta/_journal.json packages/db/drizzle/migrations/0053_integrations_framework.test.ts
git commit -m "feat(db): migration 0053 — integration_connections + integration_deliveries"
```

### Task M0.6: integrationConnections repo — createConnection

**Files:**
- Create: `packages/db/src/drizzle/repositories/integration-connections.ts`
- Test: `packages/db/src/drizzle/repositories/integration-connections.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/drizzle/repositories/integration-connections.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { getDb } from "../../index";
import {
  createConnection,
  getConnection,
} from "./integration-connections";
import { schema } from "../schema-export";

const db = getDb();

async function seedProject(): Promise<string> {
  const id = createId();
  await db.insert(schema.projects).values({
    id,
    name: `proj-${id}`,
    slug: `proj-${id}`,
  });
  return id;
}

describe("createConnection", () => {
  let projectId: string;
  beforeEach(async () => {
    projectId = await seedProject();
  });

  it("creates a connection with defaults", async () => {
    const row = await createConnection(db, {
      id: createId(),
      projectId,
      providerId: "META_CAPI",
      displayName: "Meta primary",
      credentialsCipher: "v1:abc",
      credentialsHint: "Pixel 1234…5678",
      enabledEvents: ["revenue.RENEWAL"],
      eventMapping: {},
      actionSource: "app",
    });

    expect(row.isEnabled).toBe(false);
    expect(row.enabledEvents).toEqual(["revenue.RENEWAL"]);
    expect(row.providerId).toBe("META_CAPI");

    const fetched = await getConnection(db, row.id);
    expect(fetched?.id).toBe(row.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/db test -- integration-connections.test.ts`
Expected: FAIL — `Cannot find module './integration-connections'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/db/src/drizzle/repositories/integration-connections.ts`:

```ts
import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleClient } from "../client";
import { integrationConnections } from "../schema";
import type {
  IntegrationConnection,
  NewIntegrationConnection,
} from "../schema";

export async function createConnection(
  db: DrizzleClient,
  values: NewIntegrationConnection,
): Promise<IntegrationConnection> {
  const [row] = await db
    .insert(integrationConnections)
    .values(values)
    .returning();
  if (!row) throw new Error("createConnection: insert returned no row");
  return row;
}

export async function getConnection(
  db: DrizzleClient,
  id: string,
): Promise<IntegrationConnection | undefined> {
  const [row] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, id));
  return row;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/db test -- integration-connections.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/integration-connections.ts packages/db/src/drizzle/repositories/integration-connections.test.ts
git commit -m "feat(db): integration-connections repo — createConnection + getConnection"
```

### Task M0.7: listActiveConnectionsForProject

**Files:**
- Modify: `packages/db/src/drizzle/repositories/integration-connections.ts`
- Modify: `packages/db/src/drizzle/repositories/integration-connections.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `integration-connections.test.ts`:

```ts
import { listActiveConnectionsForProject } from "./integration-connections";

describe("listActiveConnectionsForProject", () => {
  it("returns only is_enabled=true rows", async () => {
    const projectId = await seedProject();
    const enabledId = createId();
    const disabledId = createId();

    await createConnection(db, {
      id: enabledId,
      projectId,
      providerId: "META_CAPI",
      displayName: "Meta on",
      credentialsCipher: "v1:1",
      credentialsHint: "h",
      enabledEvents: ["revenue.RENEWAL"],
      eventMapping: {},
      actionSource: "app",
      isEnabled: true,
    });
    await createConnection(db, {
      id: disabledId,
      projectId,
      providerId: "TIKTOK_EVENTS",
      displayName: "Tt off",
      credentialsCipher: "v1:2",
      credentialsHint: "h",
      enabledEvents: [],
      eventMapping: {},
      actionSource: "app",
      isEnabled: false,
    });

    const active = await listActiveConnectionsForProject(db, projectId);
    expect(active.map((r) => r.id)).toEqual([enabledId]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/db test -- integration-connections.test.ts`
Expected: FAIL — `listActiveConnectionsForProject is not exported`.

- [ ] **Step 3: Write minimal implementation**

Append to `integration-connections.ts`:

```ts
export async function listActiveConnectionsForProject(
  db: DrizzleClient,
  projectId: string,
): Promise<IntegrationConnection[]> {
  return db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.projectId, projectId),
        eq(integrationConnections.isEnabled, true),
      ),
    );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/db test -- integration-connections.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/integration-connections.ts packages/db/src/drizzle/repositories/integration-connections.test.ts
git commit -m "feat(db): listActiveConnectionsForProject"
```

### Task M0.8: updateConnection + softDeleteConnection

**Files:**
- Modify: `packages/db/src/drizzle/repositories/integration-connections.ts`
- Modify: `packages/db/src/drizzle/repositories/integration-connections.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `integration-connections.test.ts`:

```ts
import {
  updateConnection,
  softDeleteConnection,
} from "./integration-connections";

describe("updateConnection", () => {
  it("flips is_enabled and sets updatedAt", async () => {
    const projectId = await seedProject();
    const id = createId();
    await createConnection(db, {
      id,
      projectId,
      providerId: "META_CAPI",
      displayName: "n",
      credentialsCipher: "v1:1",
      credentialsHint: "h",
      enabledEvents: [],
      eventMapping: {},
      actionSource: "app",
    });
    const before = await getConnection(db, id);
    await new Promise((r) => setTimeout(r, 10));
    const updated = await updateConnection(db, id, { isEnabled: true });
    expect(updated.isEnabled).toBe(true);
    expect(updated.updatedAt.getTime()).toBeGreaterThan(
      before!.updatedAt.getTime(),
    );
  });
});

describe("softDeleteConnection", () => {
  it("disables and clears credentials", async () => {
    const projectId = await seedProject();
    const id = createId();
    await createConnection(db, {
      id,
      projectId,
      providerId: "META_CAPI",
      displayName: "n",
      credentialsCipher: "v1:secret",
      credentialsHint: "h",
      enabledEvents: ["revenue.RENEWAL"],
      eventMapping: {},
      actionSource: "app",
      isEnabled: true,
    });
    await softDeleteConnection(db, id);
    const row = await getConnection(db, id);
    expect(row?.isEnabled).toBe(false);
    expect(row?.credentialsCipher).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/db test -- integration-connections.test.ts`
Expected: FAIL — `updateConnection is not exported`.

- [ ] **Step 3: Write minimal implementation**

Append to `integration-connections.ts`:

```ts
export async function updateConnection(
  db: DrizzleClient,
  id: string,
  patch: Partial<NewIntegrationConnection>,
): Promise<IntegrationConnection> {
  const [row] = await db
    .update(integrationConnections)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(integrationConnections.id, id))
    .returning();
  if (!row) throw new Error(`updateConnection: id=${id} not found`);
  return row;
}

export async function softDeleteConnection(
  db: DrizzleClient,
  id: string,
): Promise<void> {
  await db
    .update(integrationConnections)
    .set({
      isEnabled: false,
      credentialsCipher: "",
      credentialsHint: "deleted",
      updatedAt: new Date(),
    })
    .where(eq(integrationConnections.id, id));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/db test -- integration-connections.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/integration-connections.ts packages/db/src/drizzle/repositories/integration-connections.test.ts
git commit -m "feat(db): updateConnection + softDeleteConnection"
```

### Task M0.9: integrationDeliveries repo — insertPendingDelivery (ON CONFLICT)

**Files:**
- Create: `packages/db/src/drizzle/repositories/integration-deliveries.ts`
- Test: `packages/db/src/drizzle/repositories/integration-deliveries.test.ts`

- [ ] **Step 1: Write the failing test**

Create `integration-deliveries.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { getDb } from "../../index";
import { schema } from "../schema-export";
import { createConnection } from "./integration-connections";
import { insertPendingDelivery } from "./integration-deliveries";

const db = getDb();

async function seedProject(): Promise<string> {
  const id = createId();
  await db.insert(schema.projects).values({
    id,
    name: `proj-${id}`,
    slug: `proj-${id}`,
  });
  return id;
}

async function seedConnection(projectId: string): Promise<string> {
  const id = createId();
  await createConnection(db, {
    id,
    projectId,
    providerId: "META_CAPI",
    displayName: "n",
    credentialsCipher: "v1:1",
    credentialsHint: "h",
    enabledEvents: ["revenue.RENEWAL"],
    eventMapping: {},
    actionSource: "app",
  });
  return id;
}

describe("insertPendingDelivery", () => {
  it("inserts a fresh pending row", async () => {
    const projectId = await seedProject();
    const connectionId = await seedConnection(projectId);
    const outboxEventId = createId();

    const row = await insertPendingDelivery(db, {
      id: createId(),
      connectionId,
      projectId,
      providerId: "META_CAPI",
      outboxEventId,
      eventKey: "revenue.RENEWAL",
      status: "pending",
      attempt: 0,
    });

    expect(row?.status).toBe("pending");
    expect(row?.outboxEventId).toBe(outboxEventId);
  });

  it("returns undefined on dedupe conflict", async () => {
    const projectId = await seedProject();
    const connectionId = await seedConnection(projectId);
    const outboxEventId = createId();
    await insertPendingDelivery(db, {
      id: createId(),
      connectionId,
      projectId,
      providerId: "META_CAPI",
      outboxEventId,
      eventKey: "revenue.RENEWAL",
      status: "pending",
      attempt: 0,
    });

    const second = await insertPendingDelivery(db, {
      id: createId(),
      connectionId,
      projectId,
      providerId: "META_CAPI",
      outboxEventId,
      eventKey: "revenue.RENEWAL",
      status: "pending",
      attempt: 0,
    });

    expect(second).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/db test -- integration-deliveries.test.ts`
Expected: FAIL — `Cannot find module './integration-deliveries'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/db/src/drizzle/repositories/integration-deliveries.ts`:

```ts
import { and, desc, eq, gt, lt } from "drizzle-orm";
import type { DrizzleClient } from "../client";
import {
  integrationDeliveries,
  type IntegrationDelivery,
  type NewIntegrationDelivery,
} from "../schema";

export async function insertPendingDelivery(
  db: DrizzleClient,
  values: NewIntegrationDelivery,
): Promise<IntegrationDelivery | undefined> {
  const [row] = await db
    .insert(integrationDeliveries)
    .values(values)
    .onConflictDoNothing({
      target: [
        integrationDeliveries.connectionId,
        integrationDeliveries.outboxEventId,
        integrationDeliveries.createdAt,
      ],
    })
    .returning();
  return row;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/db test -- integration-deliveries.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/integration-deliveries.ts packages/db/src/drizzle/repositories/integration-deliveries.test.ts
git commit -m "feat(db): insertPendingDelivery with ON CONFLICT DO NOTHING"
```

### Task M0.10: updateDeliveryStatus

**Files:**
- Modify: `packages/db/src/drizzle/repositories/integration-deliveries.ts`
- Modify: `packages/db/src/drizzle/repositories/integration-deliveries.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { updateDeliveryStatus } from "./integration-deliveries";

describe("updateDeliveryStatus", () => {
  it("transitions pending → succeeded with httpStatus", async () => {
    const projectId = await seedProject();
    const connectionId = await seedConnection(projectId);
    const id = createId();
    const inserted = await insertPendingDelivery(db, {
      id,
      connectionId,
      projectId,
      providerId: "META_CAPI",
      outboxEventId: createId(),
      eventKey: "revenue.RENEWAL",
      status: "pending",
      attempt: 0,
    });
    if (!inserted) throw new Error("seed failed");

    const updated = await updateDeliveryStatus(db, {
      id: inserted.id,
      createdAt: inserted.createdAt,
      status: "succeeded",
      httpStatus: 200,
      responseBody: '{"events_received":1}',
      attempt: 1,
    });

    expect(updated.status).toBe("succeeded");
    expect(updated.httpStatus).toBe(200);
    expect(updated.attempt).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/db test -- integration-deliveries.test.ts`
Expected: FAIL — `updateDeliveryStatus is not exported`.

- [ ] **Step 3: Write minimal implementation**

Append to `integration-deliveries.ts`:

```ts
export interface UpdateDeliveryStatusInput {
  id: string;
  createdAt: Date;
  status: IntegrationDelivery["status"];
  httpStatus?: number | null;
  responseBody?: string | null;
  errorMessage?: string | null;
  providerEvent?: string | null;
  skipReason?: string | null;
  attempt?: number;
}

export async function updateDeliveryStatus(
  db: DrizzleClient,
  input: UpdateDeliveryStatusInput,
): Promise<IntegrationDelivery> {
  const [row] = await db
    .update(integrationDeliveries)
    .set({
      status: input.status,
      httpStatus: input.httpStatus ?? null,
      responseBody: input.responseBody ?? null,
      errorMessage: input.errorMessage ?? null,
      providerEvent: input.providerEvent ?? null,
      skipReason: input.skipReason ?? null,
      attempt: input.attempt ?? 0,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(integrationDeliveries.id, input.id),
        eq(integrationDeliveries.createdAt, input.createdAt),
      ),
    )
    .returning();
  if (!row) throw new Error(`updateDeliveryStatus: id=${input.id} not found`);
  return row;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/db test -- integration-deliveries.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/integration-deliveries.ts packages/db/src/drizzle/repositories/integration-deliveries.test.ts
git commit -m "feat(db): updateDeliveryStatus"
```

### Task M0.11: listDeliveriesForConnection (cursor paginated)

**Files:**
- Modify: `packages/db/src/drizzle/repositories/integration-deliveries.ts`
- Modify: `packages/db/src/drizzle/repositories/integration-deliveries.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { listDeliveriesForConnection } from "./integration-deliveries";

describe("listDeliveriesForConnection", () => {
  it("returns rows ordered by createdAt desc with cursor paging", async () => {
    const projectId = await seedProject();
    const connectionId = await seedConnection(projectId);

    for (let i = 0; i < 3; i++) {
      await insertPendingDelivery(db, {
        id: createId(),
        connectionId,
        projectId,
        providerId: "META_CAPI",
        outboxEventId: createId(),
        eventKey: "revenue.RENEWAL",
        status: "pending",
        attempt: 0,
      });
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1 = await listDeliveriesForConnection(db, {
      connectionId,
      limit: 2,
    });
    expect(page1.rows.length).toBe(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await listDeliveriesForConnection(db, {
      connectionId,
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.rows.length).toBe(1);
    expect(page2.nextCursor).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/db test -- integration-deliveries.test.ts`
Expected: FAIL — `listDeliveriesForConnection is not exported`.

- [ ] **Step 3: Write minimal implementation**

Append:

```ts
export interface ListDeliveriesInput {
  connectionId: string;
  limit: number;
  cursor?: string; // ISO timestamp of last seen createdAt
  status?: IntegrationDelivery["status"];
}

export interface ListDeliveriesPage {
  rows: IntegrationDelivery[];
  nextCursor?: string;
}

export async function listDeliveriesForConnection(
  db: DrizzleClient,
  input: ListDeliveriesInput,
): Promise<ListDeliveriesPage> {
  const conds = [eq(integrationDeliveries.connectionId, input.connectionId)];
  if (input.cursor) {
    conds.push(lt(integrationDeliveries.createdAt, new Date(input.cursor)));
  }
  if (input.status) {
    conds.push(eq(integrationDeliveries.status, input.status));
  }

  const rows = await db
    .select()
    .from(integrationDeliveries)
    .where(and(...conds))
    .orderBy(desc(integrationDeliveries.createdAt))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: hasMore && last ? last.createdAt.toISOString() : undefined,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/db test -- integration-deliveries.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/integration-deliveries.ts packages/db/src/drizzle/repositories/integration-deliveries.test.ts
git commit -m "feat(db): listDeliveriesForConnection cursor pagination"
```

### Task M0.12: Barrel re-exports for new repos

**Files:**
- Modify: `packages/db/src/drizzle/index.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/drizzle/integrations-barrel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { drizzle } from "../index";

describe("drizzle barrel — integrations", () => {
  it("exposes integrationConnectionRepo and integrationDeliveryRepo", () => {
    expect(typeof drizzle.integrationConnectionRepo.createConnection).toBe(
      "function",
    );
    expect(typeof drizzle.integrationDeliveryRepo.insertPendingDelivery).toBe(
      "function",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/db test -- integrations-barrel.test.ts`
Expected: FAIL — `Cannot read properties of undefined (reading 'createConnection')`.

- [ ] **Step 3: Write minimal implementation**

Update `packages/db/src/drizzle/index.ts` — append the new namespaces alongside the existing repo exports (mirror `outgoingWebhookRepo` style):

```ts
import * as integrationConnectionRepo from "./repositories/integration-connections";
import * as integrationDeliveryRepo from "./repositories/integration-deliveries";

export const drizzle = {
  // ...existing keys...
  integrationConnectionRepo,
  integrationDeliveryRepo,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/db test -- integrations-barrel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/index.ts packages/db/src/drizzle/integrations-barrel.test.ts
git commit -m "feat(db): barrel-export integration repos"
```

---

## M1 — Provider modules

### Task M1.1: Shared provider types

**Files:**
- Create: `apps/api/src/services/integrations/types.ts`
- Test: `apps/api/src/services/integrations/types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type {
  IntegrationProvider,
  RovenueEventEnvelope,
  ConnectionConfig,
  DeliveryResult,
  MapEventResult,
  HttpClient,
} from "./types";

describe("integrations types", () => {
  it("compiles a sample MapEventResult skip union", () => {
    const skip: MapEventResult = {
      skip: true,
      reason: "filtered_by_event_scope",
    };
    expect("skip" in skip).toBe(true);
  });

  it("compiles a sample DeliveryResult", () => {
    const ok: DeliveryResult = {
      ok: true,
      httpStatus: 200,
      responseBody: "{}",
      retriable: false,
    };
    expect(ok.ok).toBe(true);
  });

  it("envelope carries optional identityContext", () => {
    const env: RovenueEventEnvelope = {
      outboxEventId: "o1",
      projectId: "p1",
      eventType: "revenue.event.recorded",
      occurredAt: new Date().toISOString(),
      identityContext: { email: "e@x.com" },
    };
    expect(env.identityContext?.email).toBe("e@x.com");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- types.test.ts`
Expected: FAIL — `Cannot find module './types'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/api/src/services/integrations/types.ts`:

```ts
import type {
  IntegrationProviderId,
  RovenueEventKey,
} from "@rovenue/shared";

export type ProviderId = IntegrationProviderId;

export type RovenueEventType =
  | "revenue.event.recorded"
  | "subscription.trial.started"
  | "subscriber.identified";

export type RevenueEventKind =
  | "INITIAL"
  | "TRIAL_CONVERSION"
  | "RENEWAL"
  | "CREDIT_PURCHASE"
  | "REFUND"
  | "CANCELLATION";

export interface IdentityContext {
  email?: string;
  phone?: string;
  externalId?: string;
  ip?: string;
  userAgent?: string;
  fbp?: string;
  fbc?: string;
  ttclid?: string;
  ttp?: string;
}

export interface RovenueEventEnvelope {
  outboxEventId: string;
  projectId: string;
  eventType: RovenueEventType;
  occurredAt: string;
  revenueEventKind?: RevenueEventKind;
  amount?: string;
  currency?: string;
  subscriberId?: string;
  productId?: string;
  identityContext?: IdentityContext;
  eventSourceUrl?: string;
}

export interface ConnectionConfig {
  connectionId: string;
  projectId: string;
  enabledEvents: RovenueEventKey[];
  eventMapping: Record<string, { eventName?: string; skip?: true }>;
  actionSource: "app" | "website" | "system_generated";
  testEventCode?: string;
}

export interface ProviderPayload {
  eventKey: RovenueEventKey;
  providerEvent: string;
  body: unknown;
}

export type MapEventSkipReason =
  | "no_mapping"
  | "filtered_by_event_scope"
  | "no_user_data";

export type MapEventResult =
  | ProviderPayload
  | { skip: true; reason: MapEventSkipReason };

export interface DeliveryResult {
  ok: boolean;
  httpStatus: number;
  responseBody: string;
  errorMessage?: string;
  retriable: boolean;
}

export interface ProviderCredentials {
  [k: string]: string;
}

export interface HttpClient {
  request(input: {
    method: "GET" | "POST";
    url: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; body: string }>;
}

export interface IntegrationProvider {
  id: ProviderId;
  defaultEventMapping: Partial<Record<RovenueEventKey, string>>;
  validateCredentials(
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  mapEvent(
    envelope: RovenueEventEnvelope,
    config: ConnectionConfig,
    creds: ProviderCredentials,
  ): MapEventResult;
  deliver(
    payload: ProviderPayload,
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<DeliveryResult>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/integrations/types.ts apps/api/src/services/integrations/types.test.ts
git commit -m "feat(integrations): shared provider types"
```

### Task M1.2: hashPii helper

**Files:**
- Create: `apps/api/src/services/integrations/hash-pii.ts`
- Test: `apps/api/src/services/integrations/hash-pii.test.ts`

- [ ] **Step 1: Write the failing test**

Create `hash-pii.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  hashPii,
  normalizeEmail,
  normalizePhone,
  normalizeExternalId,
} from "./hash-pii";

describe("hashPii", () => {
  it("lowercases and trims before hashing", () => {
    const a = hashPii("  USER@Example.COM  ");
    const b = hashPii("user@example.com");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns undefined for empty input", () => {
    expect(hashPii("")).toBeUndefined();
    expect(hashPii("   ")).toBeUndefined();
  });
});

describe("normalizers", () => {
  it("normalizeEmail lowercases + trims", () => {
    expect(normalizeEmail("  USER@x.com ")).toBe("user@x.com");
    expect(normalizeEmail("")).toBeUndefined();
  });

  it("normalizePhone strips non-digits", () => {
    expect(normalizePhone("+1 (555) 123-4567")).toBe("15551234567");
    expect(normalizePhone("nope")).toBeUndefined();
  });

  it("normalizeExternalId trims", () => {
    expect(normalizeExternalId(" sub_abc ")).toBe("sub_abc");
    expect(normalizeExternalId("")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- hash-pii.test.ts`
Expected: FAIL — `Cannot find module './hash-pii'`.

- [ ] **Step 3: Write minimal implementation**

Create `hash-pii.ts`:

```ts
import { createHash } from "node:crypto";

export function hashPii(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  return createHash("sha256").update(trimmed, "utf8").digest("hex");
}

export function normalizeEmail(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim().toLowerCase();
  return t.length === 0 ? undefined : t;
}

export function normalizePhone(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const digits = v.replace(/[^0-9]/g, "");
  return digits.length === 0 ? undefined : digits;
}

export function normalizeExternalId(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- hash-pii.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/integrations/hash-pii.ts apps/api/src/services/integrations/hash-pii.test.ts
git commit -m "feat(integrations): hashPii + normalizers"
```

### Task M1.3: event-mapping merger

**Files:**
- Create: `apps/api/src/services/integrations/event-mapping.ts`
- Test: `apps/api/src/services/integrations/event-mapping.test.ts`

- [ ] **Step 1: Write the failing test**

Create `event-mapping.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVENT_MAPPING,
  applyEventMapping,
} from "./event-mapping";

describe("DEFAULT_EVENT_MAPPING", () => {
  it("has Meta + TikTok defaults for each key", () => {
    expect(DEFAULT_EVENT_MAPPING.META_CAPI["revenue.RENEWAL"]).toBe(
      "Purchase",
    );
    expect(DEFAULT_EVENT_MAPPING.TIKTOK_EVENTS["revenue.RENEWAL"]).toBe(
      "Subscribe",
    );
    expect(
      DEFAULT_EVENT_MAPPING.META_CAPI["revenue.REFUND"],
    ).toBeUndefined();
  });
});

describe("applyEventMapping", () => {
  it("uses default when no override", () => {
    const r = applyEventMapping({
      providerId: "META_CAPI",
      eventKey: "revenue.INITIAL",
      enabledEvents: ["revenue.INITIAL"],
      override: {},
    });
    expect(r).toEqual({ kind: "use", providerEvent: "Subscribe" });
  });

  it("override eventName wins over default", () => {
    const r = applyEventMapping({
      providerId: "META_CAPI",
      eventKey: "revenue.INITIAL",
      enabledEvents: ["revenue.INITIAL"],
      override: { "revenue.INITIAL": { eventName: "MyPurchase" } },
    });
    expect(r).toEqual({ kind: "use", providerEvent: "MyPurchase" });
  });

  it("override skip:true short-circuits even if default exists", () => {
    const r = applyEventMapping({
      providerId: "META_CAPI",
      eventKey: "revenue.INITIAL",
      enabledEvents: ["revenue.INITIAL"],
      override: { "revenue.INITIAL": { skip: true } },
    });
    expect(r).toEqual({ kind: "skip", reason: "no_mapping" });
  });

  it("filtered_by_event_scope when key not in enabledEvents", () => {
    const r = applyEventMapping({
      providerId: "META_CAPI",
      eventKey: "revenue.RENEWAL",
      enabledEvents: ["revenue.INITIAL"],
      override: {},
    });
    expect(r).toEqual({
      kind: "skip",
      reason: "filtered_by_event_scope",
    });
  });

  it("no_mapping when default is undefined and override empty", () => {
    const r = applyEventMapping({
      providerId: "META_CAPI",
      eventKey: "revenue.REFUND",
      enabledEvents: ["revenue.REFUND"],
      override: {},
    });
    expect(r).toEqual({ kind: "skip", reason: "no_mapping" });
  });

  it("tolerates malformed override values", () => {
    const r = applyEventMapping({
      providerId: "META_CAPI",
      eventKey: "revenue.INITIAL",
      enabledEvents: ["revenue.INITIAL"],
      // @ts-expect-error testing runtime tolerance
      override: { "revenue.INITIAL": "garbage" },
    });
    expect(r).toEqual({ kind: "use", providerEvent: "Subscribe" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- event-mapping.test.ts`
Expected: FAIL — `Cannot find module './event-mapping'`.

- [ ] **Step 3: Write minimal implementation**

Create `event-mapping.ts`:

```ts
import type { RovenueEventKey, IntegrationProviderId } from "@rovenue/shared";

export const DEFAULT_EVENT_MAPPING: Record<
  IntegrationProviderId,
  Partial<Record<RovenueEventKey, string>>
> = {
  META_CAPI: {
    "revenue.INITIAL": "Subscribe",
    "revenue.TRIAL_CONVERSION": "Subscribe",
    "revenue.RENEWAL": "Purchase",
    "revenue.CREDIT_PURCHASE": "Purchase",
    "subscription.trial.started": "StartTrial",
    "subscriber.identified": "CompleteRegistration",
  },
  TIKTOK_EVENTS: {
    "revenue.INITIAL": "Subscribe",
    "revenue.TRIAL_CONVERSION": "Subscribe",
    "revenue.RENEWAL": "Subscribe",
    "revenue.CREDIT_PURCHASE": "CompletePayment",
    "subscription.trial.started": "StartTrial",
    "subscriber.identified": "CompleteRegistration",
  },
};

export type ApplyEventMappingInput = {
  providerId: IntegrationProviderId;
  eventKey: RovenueEventKey;
  enabledEvents: RovenueEventKey[];
  override: Record<string, { eventName?: string; skip?: true }>;
};

export type ApplyEventMappingResult =
  | { kind: "use"; providerEvent: string }
  | { kind: "skip"; reason: "no_mapping" | "filtered_by_event_scope" };

export function applyEventMapping(
  input: ApplyEventMappingInput,
): ApplyEventMappingResult {
  if (!input.enabledEvents.includes(input.eventKey)) {
    return { kind: "skip", reason: "filtered_by_event_scope" };
  }

  const ovRaw = input.override[input.eventKey];
  const ov =
    ovRaw && typeof ovRaw === "object" ? ovRaw : undefined;

  if (ov?.skip === true) {
    return { kind: "skip", reason: "no_mapping" };
  }

  const defaultName = DEFAULT_EVENT_MAPPING[input.providerId][input.eventKey];
  const providerEvent = ov?.eventName ?? defaultName;
  if (!providerEvent) {
    return { kind: "skip", reason: "no_mapping" };
  }
  return { kind: "use", providerEvent };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- event-mapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/integrations/event-mapping.ts apps/api/src/services/integrations/event-mapping.test.ts
git commit -m "feat(integrations): event-mapping merger with default + override precedence"
```

### Task M1.4: undici HttpClient adapter

**Files:**
- Create: `apps/api/src/services/integrations/http-client.ts`
- Test: `apps/api/src/services/integrations/http-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `http-client.test.ts`:

```ts
import { describe, expect, it, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "./http-client";

let agent: MockAgent | undefined;
afterEach(async () => {
  if (agent) {
    await agent.close();
    agent = undefined;
  }
});

describe("createUndiciHttpClient", () => {
  it("returns status + body verbatim", async () => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent
      .get("https://example.test")
      .intercept({ path: "/ping", method: "GET" })
      .reply(200, '{"pong":true}');

    const http = createUndiciHttpClient();
    const r = await http.request({
      method: "GET",
      url: "https://example.test/ping",
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"pong":true}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- http-client.test.ts`
Expected: FAIL — `Cannot find module './http-client'`.

- [ ] **Step 3: Write minimal implementation**

Create `http-client.ts`:

```ts
import { request } from "undici";
import type { HttpClient } from "./types";

export function createUndiciHttpClient(): HttpClient {
  return {
    async request(input) {
      const res = await request(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body,
      });
      const text = await res.body.text();
      return { status: res.statusCode, body: text };
    },
  };
}
```

Add `undici` to `apps/api/package.json` dependencies if not already present.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- http-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/integrations/http-client.ts apps/api/src/services/integrations/http-client.test.ts apps/api/package.json
git commit -m "feat(integrations): undici-backed HttpClient adapter"
```

### Task M1.5: Meta CAPI — mapEvent

**Files:**
- Create: `apps/api/src/services/integrations/providers/meta-capi.ts`
- Test: `apps/api/src/services/integrations/providers/meta-capi.test.ts`

- [ ] **Step 1: Write the failing test**

Create `meta-capi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { metaCapiProvider } from "./meta-capi";
import { hashPii } from "../hash-pii";
import type {
  ConnectionConfig,
  RovenueEventEnvelope,
} from "../types";

const baseConfig: ConnectionConfig = {
  connectionId: "c1",
  projectId: "p1",
  enabledEvents: ["revenue.RENEWAL", "revenue.INITIAL"],
  eventMapping: {},
  actionSource: "app",
};

function envelope(
  overrides: Partial<RovenueEventEnvelope> = {},
): RovenueEventEnvelope {
  return {
    outboxEventId: "ob1",
    projectId: "p1",
    eventType: "revenue.event.recorded",
    occurredAt: "2026-05-27T10:00:00Z",
    revenueEventKind: "RENEWAL",
    amount: "9.99",
    currency: "USD",
    identityContext: { email: "u@x.com" },
    ...overrides,
  };
}

describe("metaCapiProvider.mapEvent", () => {
  it("maps RENEWAL → Purchase with hashed email", () => {
    const result = metaCapiProvider.mapEvent(envelope(), baseConfig, {
      pixel_id: "1234",
      access_token: "tok",
    });
    if ("skip" in result) throw new Error("expected payload");
    expect(result.providerEvent).toBe("Purchase");
    expect(result.eventKey).toBe("revenue.RENEWAL");
    const body = result.body as {
      data: Array<{
        event_name: string;
        event_id: string;
        user_data: { em?: string[] };
        custom_data: { currency: string; value: number };
      }>;
    };
    expect(body.data[0].event_name).toBe("Purchase");
    expect(body.data[0].event_id).toBe("ob1");
    expect(body.data[0].user_data.em?.[0]).toBe(hashPii("u@x.com"));
    expect(body.data[0].custom_data.value).toBe(9.99);
  });

  it("skips when not in enabled_events", () => {
    const result = metaCapiProvider.mapEvent(
      envelope({ revenueEventKind: "CANCELLATION" }),
      baseConfig,
      { pixel_id: "1", access_token: "t" },
    );
    expect(result).toEqual({
      skip: true,
      reason: "filtered_by_event_scope",
    });
  });

  it("skips when identityContext is empty", () => {
    const result = metaCapiProvider.mapEvent(
      envelope({ identityContext: {} }),
      baseConfig,
      { pixel_id: "1", access_token: "t" },
    );
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });

  it("test_event_code is forwarded into body", () => {
    const result = metaCapiProvider.mapEvent(
      envelope(),
      { ...baseConfig, testEventCode: "TEST123" },
      { pixel_id: "1", access_token: "t" },
    );
    if ("skip" in result) throw new Error("expected payload");
    const body = result.body as { test_event_code?: string };
    expect(body.test_event_code).toBe("TEST123");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- meta-capi.test.ts`
Expected: FAIL — `Cannot find module './meta-capi'`.

- [ ] **Step 3: Write minimal implementation**

Create `meta-capi.ts`:

```ts
import type {
  IntegrationProvider,
  MapEventResult,
  ProviderPayload,
  RovenueEventEnvelope,
  ConnectionConfig,
  ProviderCredentials,
  HttpClient,
  DeliveryResult,
} from "../types";
import type { RovenueEventKey } from "@rovenue/shared";
import { applyEventMapping } from "../event-mapping";
import {
  hashPii,
  normalizeEmail,
  normalizePhone,
  normalizeExternalId,
} from "../hash-pii";

function deriveEventKey(
  e: RovenueEventEnvelope,
): RovenueEventKey | undefined {
  if (e.eventType === "subscription.trial.started")
    return "subscription.trial.started";
  if (e.eventType === "subscriber.identified")
    return "subscriber.identified";
  if (e.eventType === "revenue.event.recorded" && e.revenueEventKind) {
    return `revenue.${e.revenueEventKind}` as RovenueEventKey;
  }
  return undefined;
}

function buildUserData(e: RovenueEventEnvelope) {
  const ctx = e.identityContext ?? {};
  const ud: Record<string, unknown> = {};
  const em = hashPii(normalizeEmail(ctx.email));
  const ph = hashPii(normalizePhone(ctx.phone));
  const ext = hashPii(normalizeExternalId(ctx.externalId));
  if (em) ud.em = [em];
  if (ph) ud.ph = [ph];
  if (ext) ud.external_id = [ext];
  if (ctx.ip) ud.client_ip_address = ctx.ip;
  if (ctx.userAgent) ud.client_user_agent = ctx.userAgent;
  if (ctx.fbp) ud.fbp = ctx.fbp;
  if (ctx.fbc) ud.fbc = ctx.fbc;
  return ud;
}

export const metaCapiProvider: IntegrationProvider = {
  id: "META_CAPI",
  defaultEventMapping: {
    "revenue.INITIAL": "Subscribe",
    "revenue.TRIAL_CONVERSION": "Subscribe",
    "revenue.RENEWAL": "Purchase",
    "revenue.CREDIT_PURCHASE": "Purchase",
    "subscription.trial.started": "StartTrial",
    "subscriber.identified": "CompleteRegistration",
  },

  async validateCredentials(creds, http) {
    const pixel = creds.pixel_id;
    const token = creds.access_token;
    if (!pixel || !token) {
      return { ok: false, reason: "missing pixel_id or access_token" };
    }
    const res = await http.request({
      method: "GET",
      url: `https://graph.facebook.com/v18.0/${encodeURIComponent(pixel)}?access_token=${encodeURIComponent(token)}`,
    });
    if (res.status === 200) return { ok: true };
    return { ok: false, reason: `validate http ${res.status}: ${res.body.slice(0, 200)}` };
  },

  mapEvent(envelope, config): MapEventResult {
    const eventKey = deriveEventKey(envelope);
    if (!eventKey) return { skip: true, reason: "no_mapping" };
    const decision = applyEventMapping({
      providerId: "META_CAPI",
      eventKey,
      enabledEvents: config.enabledEvents,
      override: config.eventMapping,
    });
    if (decision.kind === "skip") {
      return { skip: true, reason: decision.reason };
    }
    const userData = buildUserData(envelope);
    if (Object.keys(userData).length === 0) {
      return { skip: true, reason: "no_user_data" };
    }
    const customData: Record<string, unknown> = {};
    if (envelope.currency) customData.currency = envelope.currency;
    if (envelope.amount) customData.value = Number(envelope.amount);

    const body: Record<string, unknown> = {
      data: [
        {
          event_name: decision.providerEvent,
          event_time: Math.floor(
            new Date(envelope.occurredAt).getTime() / 1000,
          ),
          event_id: envelope.outboxEventId,
          action_source: config.actionSource,
          ...(envelope.eventSourceUrl
            ? { event_source_url: envelope.eventSourceUrl }
            : {}),
          user_data: userData,
          custom_data: customData,
        },
      ],
    };
    if (config.testEventCode) {
      body.test_event_code = config.testEventCode;
    }

    const payload: ProviderPayload = {
      eventKey,
      providerEvent: decision.providerEvent,
      body,
    };
    return payload;
  },

  async deliver(): Promise<DeliveryResult> {
    throw new Error("not implemented yet");
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- meta-capi.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/integrations/providers/meta-capi.ts apps/api/src/services/integrations/providers/meta-capi.test.ts
git commit -m "feat(integrations): Meta CAPI provider mapEvent"
```

### Task M1.6: Meta CAPI — validateCredentials + deliver

**Files:**
- Modify: `apps/api/src/services/integrations/providers/meta-capi.ts`
- Modify: `apps/api/src/services/integrations/providers/meta-capi.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `meta-capi.test.ts`:

```ts
import { MockAgent, setGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "../http-client";

describe("metaCapiProvider.validateCredentials + deliver", () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it("validateCredentials returns ok on 200", async () => {
    agent
      .get("https://graph.facebook.com")
      .intercept({
        path: /v18\.0\/p1\?access_token=tok/,
        method: "GET",
      })
      .reply(200, '{"id":"p1"}');
    const r = await metaCapiProvider.validateCredentials(
      { pixel_id: "p1", access_token: "tok" },
      createUndiciHttpClient(),
    );
    expect(r).toEqual({ ok: true });
  });

  it("validateCredentials returns failure on 400", async () => {
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /v18/, method: "GET" })
      .reply(400, '{"error":"bad"}');
    const r = await metaCapiProvider.validateCredentials(
      { pixel_id: "p1", access_token: "tok" },
      createUndiciHttpClient(),
    );
    expect(r.ok).toBe(false);
  });

  it("deliver — 200 → ok + retriable:false", async () => {
    agent
      .get("https://graph.facebook.com")
      .intercept({
        path: /v18\.0\/p1\/events\?access_token=tok/,
        method: "POST",
      })
      .reply(200, '{"events_received":1}');
    const r = await metaCapiProvider.deliver(
      { eventKey: "revenue.RENEWAL", providerEvent: "Purchase", body: { data: [] } },
      { pixel_id: "p1", access_token: "tok" },
      createUndiciHttpClient(),
    );
    expect(r.ok).toBe(true);
    expect(r.httpStatus).toBe(200);
    expect(r.retriable).toBe(false);
  });

  it("deliver — 401 → !ok + retriable:false", async () => {
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /v18/, method: "POST" })
      .reply(401, '{"error":"unauth"}');
    const r = await metaCapiProvider.deliver(
      { eventKey: "revenue.RENEWAL", providerEvent: "Purchase", body: { data: [] } },
      { pixel_id: "p1", access_token: "tok" },
      createUndiciHttpClient(),
    );
    expect(r.ok).toBe(false);
    expect(r.retriable).toBe(false);
  });

  it("deliver — 500 → !ok + retriable:true", async () => {
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /v18/, method: "POST" })
      .reply(500, "boom");
    const r = await metaCapiProvider.deliver(
      { eventKey: "revenue.RENEWAL", providerEvent: "Purchase", body: { data: [] } },
      { pixel_id: "p1", access_token: "tok" },
      createUndiciHttpClient(),
    );
    expect(r.ok).toBe(false);
    expect(r.retriable).toBe(true);
  });
});
```

(Add `beforeEach, afterEach` to the vitest import at the top of the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- meta-capi.test.ts`
Expected: FAIL — `deliver` throws "not implemented yet".

- [ ] **Step 3: Write minimal implementation**

Replace the `deliver` stub in `meta-capi.ts`:

```ts
async deliver(payload, creds, http): Promise<DeliveryResult> {
  const pixel = creds.pixel_id;
  const token = creds.access_token;
  if (!pixel || !token) {
    return {
      ok: false,
      httpStatus: 0,
      responseBody: "",
      errorMessage: "missing credentials",
      retriable: false,
    };
  }
  const res = await http.request({
    method: "POST",
    url: `https://graph.facebook.com/v18.0/${encodeURIComponent(pixel)}/events?access_token=${encodeURIComponent(token)}`,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload.body),
  });
  const ok = res.status >= 200 && res.status < 300;
  const retriable = !ok && (res.status === 429 || res.status >= 500);
  return {
    ok,
    httpStatus: res.status,
    responseBody: res.body.slice(0, 4096),
    errorMessage: ok ? undefined : `meta capi http ${res.status}`,
    retriable,
  };
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- meta-capi.test.ts`
Expected: PASS (all 8 tests in the file).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/integrations/providers/meta-capi.ts apps/api/src/services/integrations/providers/meta-capi.test.ts
git commit -m "feat(integrations): Meta CAPI validateCredentials + deliver"
```

### Task M1.7: TikTok Events — mapEvent

**Files:**
- Create: `apps/api/src/services/integrations/providers/tiktok-events.ts`
- Test: `apps/api/src/services/integrations/providers/tiktok-events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tiktok-events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { tiktokEventsProvider } from "./tiktok-events";
import { hashPii } from "../hash-pii";
import type {
  ConnectionConfig,
  RovenueEventEnvelope,
} from "../types";

const baseConfig: ConnectionConfig = {
  connectionId: "c1",
  projectId: "p1",
  enabledEvents: ["revenue.RENEWAL", "revenue.CREDIT_PURCHASE"],
  eventMapping: {},
  actionSource: "app",
};

function envelope(
  overrides: Partial<RovenueEventEnvelope> = {},
): RovenueEventEnvelope {
  return {
    outboxEventId: "ob1",
    projectId: "p1",
    eventType: "revenue.event.recorded",
    occurredAt: "2026-05-27T10:00:00Z",
    revenueEventKind: "RENEWAL",
    amount: "19.99",
    currency: "USD",
    identityContext: { email: "u@x.com", phone: "+1 555 000 1111" },
    ...overrides,
  };
}

describe("tiktokEventsProvider.mapEvent", () => {
  it("RENEWAL → Subscribe with hashed email + phone", () => {
    const result = tiktokEventsProvider.mapEvent(envelope(), baseConfig, {
      pixel_code: "CXX",
      access_token: "tok",
    });
    if ("skip" in result) throw new Error("expected payload");
    expect(result.providerEvent).toBe("Subscribe");
    const body = result.body as {
      event_source: string;
      event_source_id: string;
      data: Array<{
        event: string;
        event_id: string;
        user: { email?: string; phone?: string };
        properties: { currency: string; value: number };
      }>;
    };
    expect(body.event_source).toBe("web");
    expect(body.event_source_id).toBe("CXX");
    expect(body.data[0].event).toBe("Subscribe");
    expect(body.data[0].event_id).toBe("ob1");
    expect(body.data[0].user.email).toBe(hashPii("u@x.com"));
    expect(body.data[0].user.phone).toBe(hashPii("15550001111"));
    expect(body.data[0].properties.value).toBe(19.99);
  });

  it("CREDIT_PURCHASE → CompletePayment", () => {
    const result = tiktokEventsProvider.mapEvent(
      envelope({ revenueEventKind: "CREDIT_PURCHASE" }),
      baseConfig,
      { pixel_code: "CXX", access_token: "tok" },
    );
    if ("skip" in result) throw new Error("expected payload");
    expect(result.providerEvent).toBe("CompletePayment");
  });

  it("skips when identityContext is empty", () => {
    const result = tiktokEventsProvider.mapEvent(
      envelope({ identityContext: {} }),
      baseConfig,
      { pixel_code: "CXX", access_token: "tok" },
    );
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- tiktok-events.test.ts`
Expected: FAIL — `Cannot find module './tiktok-events'`.

- [ ] **Step 3: Write minimal implementation**

Create `tiktok-events.ts`:

```ts
import type {
  IntegrationProvider,
  MapEventResult,
  ProviderPayload,
  RovenueEventEnvelope,
  DeliveryResult,
} from "../types";
import type { RovenueEventKey } from "@rovenue/shared";
import { applyEventMapping } from "../event-mapping";
import {
  hashPii,
  normalizeEmail,
  normalizePhone,
  normalizeExternalId,
} from "../hash-pii";

function deriveEventKey(
  e: RovenueEventEnvelope,
): RovenueEventKey | undefined {
  if (e.eventType === "subscription.trial.started")
    return "subscription.trial.started";
  if (e.eventType === "subscriber.identified")
    return "subscriber.identified";
  if (e.eventType === "revenue.event.recorded" && e.revenueEventKind) {
    return `revenue.${e.revenueEventKind}` as RovenueEventKey;
  }
  return undefined;
}

function buildUser(e: RovenueEventEnvelope) {
  const ctx = e.identityContext ?? {};
  const user: Record<string, unknown> = {};
  const em = hashPii(normalizeEmail(ctx.email));
  const ph = hashPii(normalizePhone(ctx.phone));
  const ext = hashPii(normalizeExternalId(ctx.externalId));
  if (em) user.email = em;
  if (ph) user.phone = ph;
  if (ext) user.external_id = ext;
  if (ctx.ip) user.ip = ctx.ip;
  if (ctx.userAgent) user.user_agent = ctx.userAgent;
  if (ctx.ttclid) user.ttclid = ctx.ttclid;
  if (ctx.ttp) user.ttp = ctx.ttp;
  return user;
}

export const tiktokEventsProvider: IntegrationProvider = {
  id: "TIKTOK_EVENTS",
  defaultEventMapping: {
    "revenue.INITIAL": "Subscribe",
    "revenue.TRIAL_CONVERSION": "Subscribe",
    "revenue.RENEWAL": "Subscribe",
    "revenue.CREDIT_PURCHASE": "CompletePayment",
    "subscription.trial.started": "StartTrial",
    "subscriber.identified": "CompleteRegistration",
  },

  async validateCredentials(creds, http) {
    if (!creds.pixel_code || !creds.access_token) {
      return { ok: false, reason: "missing pixel_code or access_token" };
    }
    const res = await http.request({
      method: "POST",
      url: "https://business-api.tiktok.com/open_api/v1.3/event/track/",
      headers: {
        "content-type": "application/json",
        "Access-Token": creds.access_token,
      },
      body: JSON.stringify({
        event_source: "web",
        event_source_id: creds.pixel_code,
        data: [],
      }),
    });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return {
      ok: false,
      reason: `validate http ${res.status}: ${res.body.slice(0, 200)}`,
    };
  },

  mapEvent(envelope, config, creds): MapEventResult {
    const eventKey = deriveEventKey(envelope);
    if (!eventKey) return { skip: true, reason: "no_mapping" };
    const decision = applyEventMapping({
      providerId: "TIKTOK_EVENTS",
      eventKey,
      enabledEvents: config.enabledEvents,
      override: config.eventMapping,
    });
    if (decision.kind === "skip") {
      return { skip: true, reason: decision.reason };
    }
    const user = buildUser(envelope);
    if (Object.keys(user).length === 0) {
      return { skip: true, reason: "no_user_data" };
    }
    const properties: Record<string, unknown> = {};
    if (envelope.currency) properties.currency = envelope.currency;
    if (envelope.amount) properties.value = Number(envelope.amount);

    const body: Record<string, unknown> = {
      event_source: "web",
      event_source_id: creds.pixel_code,
      data: [
        {
          event: decision.providerEvent,
          event_time: Math.floor(
            new Date(envelope.occurredAt).getTime() / 1000,
          ),
          event_id: envelope.outboxEventId,
          user,
          properties,
        },
      ],
    };
    if (config.testEventCode) body.test_event_code = config.testEventCode;
    const payload: ProviderPayload = {
      eventKey,
      providerEvent: decision.providerEvent,
      body,
    };
    return payload;
  },

  async deliver(): Promise<DeliveryResult> {
    throw new Error("not implemented yet");
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- tiktok-events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/integrations/providers/tiktok-events.ts apps/api/src/services/integrations/providers/tiktok-events.test.ts
git commit -m "feat(integrations): TikTok Events provider mapEvent"
```

### Task M1.8: TikTok Events — deliver

**Files:**
- Modify: `apps/api/src/services/integrations/providers/tiktok-events.ts`
- Modify: `apps/api/src/services/integrations/providers/tiktok-events.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tiktok-events.test.ts`:

```ts
import { beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "../http-client";

describe("tiktokEventsProvider.deliver", () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it("POSTs to /event/track/ with Access-Token header", async () => {
    let observedHeaders: Record<string, string | string[] | undefined> = {};
    agent
      .get("https://business-api.tiktok.com")
      .intercept({
        path: "/open_api/v1.3/event/track/",
        method: "POST",
      })
      .reply((opts) => {
        observedHeaders = opts.headers as Record<string, string>;
        return { statusCode: 200, data: '{"code":0}' };
      });
    const r = await tiktokEventsProvider.deliver(
      { eventKey: "revenue.RENEWAL", providerEvent: "Subscribe", body: {} },
      { pixel_code: "CXX", access_token: "tok" },
      createUndiciHttpClient(),
    );
    expect(r.ok).toBe(true);
    expect(r.httpStatus).toBe(200);
    expect(observedHeaders["access-token"]).toBe("tok");
  });

  it("429 → retriable true", async () => {
    agent
      .get("https://business-api.tiktok.com")
      .intercept({ path: /track/, method: "POST" })
      .reply(429, "rate");
    const r = await tiktokEventsProvider.deliver(
      { eventKey: "revenue.RENEWAL", providerEvent: "Subscribe", body: {} },
      { pixel_code: "CXX", access_token: "tok" },
      createUndiciHttpClient(),
    );
    expect(r.ok).toBe(false);
    expect(r.retriable).toBe(true);
  });

  it("400 → retriable false", async () => {
    agent
      .get("https://business-api.tiktok.com")
      .intercept({ path: /track/, method: "POST" })
      .reply(400, '{"code":40002}');
    const r = await tiktokEventsProvider.deliver(
      { eventKey: "revenue.RENEWAL", providerEvent: "Subscribe", body: {} },
      { pixel_code: "CXX", access_token: "tok" },
      createUndiciHttpClient(),
    );
    expect(r.ok).toBe(false);
    expect(r.retriable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- tiktok-events.test.ts`
Expected: FAIL — `deliver` throws "not implemented yet".

- [ ] **Step 3: Write minimal implementation**

Replace the `deliver` stub in `tiktok-events.ts`:

```ts
async deliver(payload, creds, http): Promise<DeliveryResult> {
  if (!creds.pixel_code || !creds.access_token) {
    return {
      ok: false,
      httpStatus: 0,
      responseBody: "",
      errorMessage: "missing credentials",
      retriable: false,
    };
  }
  const res = await http.request({
    method: "POST",
    url: "https://business-api.tiktok.com/open_api/v1.3/event/track/",
    headers: {
      "content-type": "application/json",
      "Access-Token": creds.access_token,
    },
    body: JSON.stringify(payload.body),
  });
  const ok = res.status >= 200 && res.status < 300;
  const retriable = !ok && (res.status === 429 || res.status >= 500);
  return {
    ok,
    httpStatus: res.status,
    responseBody: res.body.slice(0, 4096),
    errorMessage: ok ? undefined : `tiktok http ${res.status}`,
    retriable,
  };
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- tiktok-events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/integrations/providers/tiktok-events.ts apps/api/src/services/integrations/providers/tiktok-events.test.ts
git commit -m "feat(integrations): TikTok Events deliver"
```

### Task M1.9: Provider registry

**Files:**
- Create: `apps/api/src/services/integrations/registry.ts`
- Test: `apps/api/src/services/integrations/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PROVIDERS, getProvider } from "./registry";

describe("PROVIDERS registry", () => {
  it("contains exactly META_CAPI and TIKTOK_EVENTS", () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual([
      "META_CAPI",
      "TIKTOK_EVENTS",
    ]);
  });

  it("getProvider returns the matching module", () => {
    expect(getProvider("META_CAPI").id).toBe("META_CAPI");
    expect(getProvider("TIKTOK_EVENTS").id).toBe("TIKTOK_EVENTS");
  });

  it("throws on unknown provider", () => {
    expect(() =>
      // @ts-expect-error testing runtime
      getProvider("UNKNOWN"),
    ).toThrow(/unknown provider/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- registry.test.ts`
Expected: FAIL — `Cannot find module './registry'`.

- [ ] **Step 3: Write minimal implementation**

Create `registry.ts`:

```ts
import type { IntegrationProvider, ProviderId } from "./types";
import { metaCapiProvider } from "./providers/meta-capi";
import { tiktokEventsProvider } from "./providers/tiktok-events";

export const PROVIDERS: Record<ProviderId, IntegrationProvider> = {
  META_CAPI: metaCapiProvider,
  TIKTOK_EVENTS: tiktokEventsProvider,
};

export function getProvider(id: ProviderId): IntegrationProvider {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`unknown provider: ${String(id)}`);
  return p;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/integrations/registry.ts apps/api/src/services/integrations/registry.test.ts
git commit -m "feat(integrations): provider registry"
```

---

## M2 — Dispatch pipeline

### Task M2.1: Connection cache helper

**Files:**
- Create: `apps/api/src/services/integrations-fanout/connection-cache.ts`
- Test: `apps/api/src/services/integrations-fanout/connection-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `connection-cache.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  createConnectionCache,
} from "./connection-cache";

describe("createConnectionCache", () => {
  it("returns cached value within TTL", async () => {
    const loader = vi.fn().mockResolvedValue([{ id: "c1" }]);
    const cache = createConnectionCache({ ttlMs: 1000, loader });
    expect(await cache.get("p1")).toEqual([{ id: "c1" }]);
    expect(await cache.get("p1")).toEqual([{ id: "c1" }]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("invalidates on emit", async () => {
    const loader = vi.fn().mockResolvedValue([{ id: "c1" }]);
    const cache = createConnectionCache({ ttlMs: 60_000, loader });
    await cache.get("p1");
    cache.invalidate("p1");
    await cache.get("p1");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("expires by TTL", async () => {
    vi.useFakeTimers();
    const loader = vi.fn().mockResolvedValue([{ id: "c1" }]);
    const cache = createConnectionCache({ ttlMs: 100, loader });
    await cache.get("p1");
    vi.advanceTimersByTime(150);
    await cache.get("p1");
    expect(loader).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- connection-cache.test.ts`
Expected: FAIL — `Cannot find module './connection-cache'`.

- [ ] **Step 3: Write minimal implementation**

Create `connection-cache.ts`:

```ts
import { EventEmitter } from "node:events";
import type { IntegrationConnection } from "@rovenue/db";

interface CacheEntry {
  value: IntegrationConnection[];
  expiresAt: number;
}

export interface ConnectionCacheOptions {
  ttlMs: number;
  loader: (projectId: string) => Promise<IntegrationConnection[]>;
}

export function createConnectionCache(opts: ConnectionCacheOptions) {
  const store = new Map<string, CacheEntry>();
  const emitter = new EventEmitter();

  async function get(projectId: string): Promise<IntegrationConnection[]> {
    const entry = store.get(projectId);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    const value = await opts.loader(projectId);
    store.set(projectId, { value, expiresAt: Date.now() + opts.ttlMs });
    return value;
  }

  function invalidate(projectId: string): void {
    store.delete(projectId);
    emitter.emit("invalidate", projectId);
  }

  function onInvalidate(fn: (projectId: string) => void): () => void {
    emitter.on("invalidate", fn);
    return () => emitter.off("invalidate", fn);
  }

  return { get, invalidate, onInvalidate };
}

export type ConnectionCache = ReturnType<typeof createConnectionCache>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- connection-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/integrations-fanout/connection-cache.ts apps/api/src/services/integrations-fanout/connection-cache.test.ts
git commit -m "feat(integrations): connection cache with TTL + invalidate hook"
```

### Task M2.2: BullMQ queue + job shape

**Files:**
- Create: `apps/api/src/queues/integrations.ts`
- Test: `apps/api/src/queues/integrations.test.ts`

- [ ] **Step 1: Write the failing test**

Create `integrations.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  INTEGRATIONS_DELIVER_QUEUE_NAME,
  INTEGRATIONS_DELIVER_BACKOFF_MS,
  buildIntegrationsDeliverJobId,
  type IntegrationsDeliverJob,
} from "./integrations";

describe("integrations queue constants", () => {
  it("queue name is rovenue-integrations-deliver", () => {
    expect(INTEGRATIONS_DELIVER_QUEUE_NAME).toBe(
      "rovenue-integrations-deliver",
    );
  });

  it("backoff schedule has 5 steps", () => {
    expect(INTEGRATIONS_DELIVER_BACKOFF_MS).toEqual([
      30_000,
      120_000,
      600_000,
      3_600_000,
      21_600_000,
    ]);
  });

  it("buildIntegrationsDeliverJobId concatenates connectionId:outboxEventId", () => {
    expect(buildIntegrationsDeliverJobId("c1", "o1")).toBe("c1:o1");
  });

  it("IntegrationsDeliverJob type compiles", () => {
    const job: IntegrationsDeliverJob = {
      connectionId: "c1",
      projectId: "p1",
      providerId: "META_CAPI",
      envelope: {
        outboxEventId: "o1",
        projectId: "p1",
        eventType: "revenue.event.recorded",
        occurredAt: new Date().toISOString(),
      },
    };
    expect(job.connectionId).toBe("c1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- queues/integrations.test.ts`
Expected: FAIL — `Cannot find module './integrations'`.

- [ ] **Step 3: Write minimal implementation**

Create `integrations.ts`:

```ts
import type { ProviderId, RovenueEventEnvelope } from "../services/integrations/types";

export const INTEGRATIONS_DELIVER_QUEUE_NAME = "rovenue-integrations-deliver";

export const INTEGRATIONS_DELIVER_BACKOFF_MS = [
  30_000,
  120_000,
  600_000,
  3_600_000,
  21_600_000,
];

export const INTEGRATIONS_DELIVER_ATTEMPTS = 5;

export interface IntegrationsDeliverJob {
  connectionId: string;
  projectId: string;
  providerId: ProviderId;
  envelope: RovenueEventEnvelope;
  isBackfill?: boolean;
}

export function buildIntegrationsDeliverJobId(
  connectionId: string,
  outboxEventId: string,
): string {
  return `${connectionId}:${outboxEventId}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- queues/integrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/queues/integrations.ts apps/api/src/queues/integrations.test.ts
git commit -m "feat(integrations): queue name + job shape"
```

### Task M2.3: Kafka fanout consumer

**Files:**
- Create: `apps/api/src/services/integrations-fanout/consumer.ts`
- Test: `apps/api/src/services/integrations-fanout/consumer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `consumer.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { processFanoutMessage } from "./consumer";
import { createConnectionCache } from "./connection-cache";
import type { IntegrationConnection } from "@rovenue/db";

const conn = (
  overrides: Partial<IntegrationConnection> = {},
): IntegrationConnection => ({
  id: "c1",
  projectId: "p1",
  providerId: "META_CAPI",
  displayName: "n",
  credentialsCipher: "v1:x",
  credentialsHint: "h",
  enabledEvents: ["revenue.RENEWAL"],
  eventMapping: {},
  actionSource: "app",
  testEventCode: null,
  isEnabled: true,
  lastValidatedAt: null,
  lastError: null,
  lastBackfillAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("processFanoutMessage", () => {
  it("enqueues one job per enabled connection", async () => {
    const enqueued: Array<{ jobId: string; connId: string }> = [];
    const cache = createConnectionCache({
      ttlMs: 1000,
      loader: async () => [conn({ id: "c1" }), conn({ id: "c2" })],
    });
    await processFanoutMessage(
      {
        outboxEventId: "ob1",
        projectId: "p1",
        eventType: "revenue.event.recorded",
        occurredAt: new Date().toISOString(),
        revenueEventKind: "RENEWAL",
      },
      {
        cache,
        enqueue: async (jobId, job) => {
          enqueued.push({ jobId, connId: job.connectionId });
        },
      },
    );
    expect(enqueued.map((e) => e.connId).sort()).toEqual(["c1", "c2"]);
    expect(enqueued.map((e) => e.jobId).sort()).toEqual(["c1:ob1", "c2:ob1"]);
  });

  it("no-ops when no connections enabled", async () => {
    const enqueue = vi.fn();
    const cache = createConnectionCache({
      ttlMs: 1000,
      loader: async () => [],
    });
    await processFanoutMessage(
      {
        outboxEventId: "ob1",
        projectId: "p1",
        eventType: "revenue.event.recorded",
        occurredAt: new Date().toISOString(),
      },
      { cache, enqueue },
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- integrations-fanout/consumer.test.ts`
Expected: FAIL — `Cannot find module './consumer'`.

- [ ] **Step 3: Write minimal implementation**

Create `consumer.ts`:

```ts
import { Kafka, type Consumer } from "kafkajs";
import { drizzle, getDb } from "@rovenue/db";
import { logger } from "../../lib/logger";
import { env } from "../../lib/env";
import {
  createConnectionCache,
  type ConnectionCache,
} from "./connection-cache";
import {
  buildIntegrationsDeliverJobId,
  type IntegrationsDeliverJob,
} from "../../queues/integrations";
import type { RovenueEventEnvelope } from "../integrations/types";

const log = logger.child("integrations-fanout");

export const FANOUT_CONSUMER_GROUP = "rovenue-integrations-fanout";
export const FANOUT_TOPICS = ["rovenue.revenue", "rovenue.billing"];

export interface ProcessFanoutDeps {
  cache: ConnectionCache;
  enqueue: (jobId: string, job: IntegrationsDeliverJob) => Promise<void>;
}

export async function processFanoutMessage(
  envelope: RovenueEventEnvelope,
  deps: ProcessFanoutDeps,
): Promise<void> {
  const connections = await deps.cache.get(envelope.projectId);
  for (const conn of connections) {
    if (!conn.isEnabled) continue;
    const jobId = buildIntegrationsDeliverJobId(
      conn.id,
      envelope.outboxEventId,
    );
    await deps.enqueue(jobId, {
      connectionId: conn.id,
      projectId: envelope.projectId,
      providerId: conn.providerId,
      envelope,
    });
  }
}

export interface FanoutController {
  stop(): Promise<void>;
}

export async function startIntegrationsFanout(
  enqueue: ProcessFanoutDeps["enqueue"],
): Promise<FanoutController> {
  const cache = createConnectionCache({
    ttlMs: 60_000,
    loader: (projectId) =>
      drizzle.integrationConnectionRepo.listActiveConnectionsForProject(
        getDb(),
        projectId,
      ),
  });

  const kafka = new Kafka({
    clientId: "rovenue-integrations-fanout",
    brokers: env.KAFKA_BROKERS.split(",").map((b) => b.trim()),
  });
  const consumer: Consumer = kafka.consumer({
    groupId: FANOUT_CONSUMER_GROUP,
  });
  await consumer.connect();
  for (const topic of FANOUT_TOPICS) {
    await consumer.subscribe({ topic, fromBeginning: false });
  }
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      try {
        const envelope = JSON.parse(
          message.value.toString("utf8"),
        ) as RovenueEventEnvelope;
        await processFanoutMessage(envelope, { cache, enqueue });
      } catch (err) {
        log.error("fanout parse failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });
  log.info("integrations-fanout started");
  return {
    stop: async () => {
      await consumer.disconnect();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- integrations-fanout/consumer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/integrations-fanout/consumer.ts apps/api/src/services/integrations-fanout/consumer.test.ts
git commit -m "feat(integrations): kafka fanout consumer"
```

### Task M2.4: Deliver worker — pure step function

**Files:**
- Create: `apps/api/src/workers/integrations-deliver.ts`
- Test: `apps/api/src/workers/integrations-deliver.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `integrations-deliver.unit.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { runDeliverStep } from "./integrations-deliver";
import type { IntegrationConnection } from "@rovenue/db";
import type { IntegrationsDeliverJob } from "../queues/integrations";

const conn: IntegrationConnection = {
  id: "c1",
  projectId: "p1",
  providerId: "META_CAPI",
  displayName: "n",
  credentialsCipher: "v1:enc",
  credentialsHint: "h",
  enabledEvents: ["revenue.RENEWAL"],
  eventMapping: {},
  actionSource: "app",
  testEventCode: null,
  isEnabled: true,
  lastValidatedAt: null,
  lastError: null,
  lastBackfillAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const job: IntegrationsDeliverJob = {
  connectionId: "c1",
  projectId: "p1",
  providerId: "META_CAPI",
  envelope: {
    outboxEventId: createId(),
    projectId: "p1",
    eventType: "revenue.event.recorded",
    occurredAt: new Date().toISOString(),
    revenueEventKind: "RENEWAL",
    amount: "9.99",
    currency: "USD",
    identityContext: { email: "u@x.com" },
  },
};

describe("runDeliverStep", () => {
  it("no-ops when connection is disabled", async () => {
    const loadConnection = vi
      .fn()
      .mockResolvedValue({ ...conn, isEnabled: false });
    const r = await runDeliverStep(job, {
      loadConnection,
      decrypt: () => ({ pixel_id: "p", access_token: "t" }),
      insertPendingDelivery: vi.fn(),
      updateDeliveryStatus: vi.fn(),
      provider: {
        id: "META_CAPI",
        mapEvent: vi.fn(),
        deliver: vi.fn(),
      } as never,
      http: { request: vi.fn() } as never,
      attempt: 1,
    });
    expect(r.outcome).toBe("connection_disabled");
  });

  it("writes skipped row when mapEvent skips", async () => {
    const insertPendingDelivery = vi
      .fn()
      .mockResolvedValue({ id: "d1", createdAt: new Date() });
    const updateDeliveryStatus = vi.fn();
    const provider = {
      id: "META_CAPI" as const,
      mapEvent: vi.fn().mockReturnValue({
        skip: true,
        reason: "no_user_data",
      }),
      deliver: vi.fn(),
    };
    const r = await runDeliverStep(job, {
      loadConnection: vi.fn().mockResolvedValue(conn),
      decrypt: () => ({ pixel_id: "p", access_token: "t" }),
      insertPendingDelivery,
      updateDeliveryStatus,
      provider: provider as never,
      http: { request: vi.fn() } as never,
      attempt: 1,
    });
    expect(r.outcome).toBe("skipped");
    expect(provider.deliver).not.toHaveBeenCalled();
    expect(insertPendingDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped", skipReason: "no_user_data" }),
    );
  });

  it("delivers and marks succeeded", async () => {
    const insertPendingDelivery = vi
      .fn()
      .mockResolvedValue({ id: "d1", createdAt: new Date() });
    const updateDeliveryStatus = vi.fn();
    const provider = {
      id: "META_CAPI" as const,
      mapEvent: vi.fn().mockReturnValue({
        eventKey: "revenue.RENEWAL",
        providerEvent: "Purchase",
        body: { data: [] },
      }),
      deliver: vi.fn().mockResolvedValue({
        ok: true,
        httpStatus: 200,
        responseBody: '{"events_received":1}',
        retriable: false,
      }),
    };
    const r = await runDeliverStep(job, {
      loadConnection: vi.fn().mockResolvedValue(conn),
      decrypt: () => ({ pixel_id: "p", access_token: "t" }),
      insertPendingDelivery,
      updateDeliveryStatus,
      provider: provider as never,
      http: { request: vi.fn() } as never,
      attempt: 1,
    });
    expect(r.outcome).toBe("succeeded");
    expect(updateDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded", httpStatus: 200 }),
    );
  });

  it("marks dead_letter on retriable=false failure", async () => {
    const insertPendingDelivery = vi
      .fn()
      .mockResolvedValue({ id: "d1", createdAt: new Date() });
    const updateDeliveryStatus = vi.fn();
    const provider = {
      id: "META_CAPI" as const,
      mapEvent: vi.fn().mockReturnValue({
        eventKey: "revenue.RENEWAL",
        providerEvent: "Purchase",
        body: {},
      }),
      deliver: vi.fn().mockResolvedValue({
        ok: false,
        httpStatus: 401,
        responseBody: "unauth",
        retriable: false,
        errorMessage: "401",
      }),
    };
    const r = await runDeliverStep(job, {
      loadConnection: vi.fn().mockResolvedValue(conn),
      decrypt: () => ({ pixel_id: "p", access_token: "t" }),
      insertPendingDelivery,
      updateDeliveryStatus,
      provider: provider as never,
      http: { request: vi.fn() } as never,
      attempt: 1,
    });
    expect(r.outcome).toBe("dead_letter");
    expect(updateDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "dead_letter" }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- integrations-deliver.unit.test.ts`
Expected: FAIL — `Cannot find module './integrations-deliver'`.

- [ ] **Step 3: Write minimal implementation**

Create `integrations-deliver.ts`:

```ts
import { createId } from "@paralleldrive/cuid2";
import type {
  IntegrationConnection,
  IntegrationDelivery,
  NewIntegrationDelivery,
} from "@rovenue/db";
import type {
  HttpClient,
  IntegrationProvider,
  ProviderCredentials,
} from "../services/integrations/types";
import type { IntegrationsDeliverJob } from "../queues/integrations";
import { INTEGRATIONS_DELIVER_ATTEMPTS } from "../queues/integrations";

export type DeliverOutcome =
  | "connection_disabled"
  | "skipped"
  | "succeeded"
  | "failed"
  | "dead_letter";

export interface DeliverStepDeps {
  loadConnection: (id: string) => Promise<IntegrationConnection | undefined>;
  decrypt: (cipher: string) => ProviderCredentials;
  insertPendingDelivery: (
    values: NewIntegrationDelivery,
  ) => Promise<{ id: string; createdAt: Date } | undefined>;
  updateDeliveryStatus: (input: {
    id: string;
    createdAt: Date;
    status: IntegrationDelivery["status"];
    httpStatus?: number | null;
    responseBody?: string | null;
    errorMessage?: string | null;
    providerEvent?: string | null;
    skipReason?: string | null;
    attempt: number;
  }) => Promise<void>;
  provider: IntegrationProvider;
  http: HttpClient;
  attempt: number;
}

export interface DeliverStepResult {
  outcome: DeliverOutcome;
  deliveryId?: string;
}

export async function runDeliverStep(
  job: IntegrationsDeliverJob,
  deps: DeliverStepDeps,
): Promise<DeliverStepResult> {
  const conn = await deps.loadConnection(job.connectionId);
  if (!conn || !conn.isEnabled) {
    return { outcome: "connection_disabled" };
  }
  const creds = deps.decrypt(conn.credentialsCipher);
  const mapped = deps.provider.mapEvent(
    job.envelope,
    {
      connectionId: conn.id,
      projectId: conn.projectId,
      enabledEvents: conn.enabledEvents as never,
      eventMapping: conn.eventMapping,
      actionSource: conn.actionSource as "app" | "website" | "system_generated",
      testEventCode: conn.testEventCode ?? undefined,
    },
    creds,
  );

  if ("skip" in mapped) {
    const id = createId();
    const inserted = await deps.insertPendingDelivery({
      id,
      connectionId: conn.id,
      projectId: conn.projectId,
      providerId: conn.providerId,
      outboxEventId: job.envelope.outboxEventId,
      eventKey: deriveEventKeyForLog(job),
      providerEvent: null,
      status: "skipped",
      attempt: deps.attempt,
      skipReason: mapped.reason,
    });
    return { outcome: "skipped", deliveryId: inserted?.id };
  }

  const id = createId();
  const inserted = await deps.insertPendingDelivery({
    id,
    connectionId: conn.id,
    projectId: conn.projectId,
    providerId: conn.providerId,
    outboxEventId: job.envelope.outboxEventId,
    eventKey: mapped.eventKey,
    providerEvent: mapped.providerEvent,
    status: "pending",
    attempt: deps.attempt,
  });
  if (!inserted) {
    // dedupe — another worker already succeeded.
    return { outcome: "succeeded" };
  }

  const result = await deps.provider.deliver(mapped, creds, deps.http);
  let status: DeliverOutcome;
  if (result.ok) status = "succeeded";
  else if (!result.retriable) status = "dead_letter";
  else if (deps.attempt >= INTEGRATIONS_DELIVER_ATTEMPTS) status = "dead_letter";
  else status = "failed";

  await deps.updateDeliveryStatus({
    id: inserted.id,
    createdAt: inserted.createdAt,
    status:
      status === "succeeded"
        ? "succeeded"
        : status === "dead_letter"
          ? "dead_letter"
          : "failed",
    httpStatus: result.httpStatus,
    responseBody: result.responseBody.slice(0, 4096),
    errorMessage: result.errorMessage ?? null,
    providerEvent: mapped.providerEvent,
    attempt: deps.attempt,
  });
  return { outcome: status, deliveryId: inserted.id };
}

function deriveEventKeyForLog(job: IntegrationsDeliverJob): string {
  if (job.envelope.eventType === "subscription.trial.started")
    return "subscription.trial.started";
  if (job.envelope.eventType === "subscriber.identified")
    return "subscriber.identified";
  if (
    job.envelope.eventType === "revenue.event.recorded" &&
    job.envelope.revenueEventKind
  ) {
    return `revenue.${job.envelope.revenueEventKind}`;
  }
  return "unknown";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- integrations-deliver.unit.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workers/integrations-deliver.ts apps/api/src/workers/integrations-deliver.unit.test.ts
git commit -m "feat(integrations): pure runDeliverStep with dependency injection"
```

### Task M2.5: BullMQ worker wiring

**Files:**
- Modify: `apps/api/src/workers/integrations-deliver.ts`
- Test: covered by integration test in M2.7

- [ ] **Step 1: Write the failing test**

Add to the bottom of `integrations-deliver.unit.test.ts`:

```ts
import { ensureIntegrationsDeliverWorker } from "./integrations-deliver";

describe("ensureIntegrationsDeliverWorker", () => {
  it("returns an object with a stop() function", async () => {
    const handle = await ensureIntegrationsDeliverWorker({
      autoStart: false,
    });
    expect(typeof handle.stop).toBe("function");
    await handle.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- integrations-deliver.unit.test.ts`
Expected: FAIL — `ensureIntegrationsDeliverWorker is not exported`.

- [ ] **Step 3: Write minimal implementation**

Append to `integrations-deliver.ts`:

```ts
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle, getDb } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { decrypt } from "@rovenue/shared";
import { getProvider } from "../services/integrations/registry";
import { createUndiciHttpClient } from "../services/integrations/http-client";
import {
  INTEGRATIONS_DELIVER_QUEUE_NAME,
  INTEGRATIONS_DELIVER_ATTEMPTS,
  INTEGRATIONS_DELIVER_BACKOFF_MS,
  type IntegrationsDeliverJob,
} from "../queues/integrations";

const log = logger.child("integrations-deliver");

export interface DeliverWorkerHandle {
  queue: Queue<IntegrationsDeliverJob> | null;
  worker: Worker<IntegrationsDeliverJob> | null;
  stop: () => Promise<void>;
}

export async function ensureIntegrationsDeliverWorker(
  opts: { autoStart?: boolean } = {},
): Promise<DeliverWorkerHandle> {
  if (opts.autoStart === false) {
    return { queue: null, worker: null, stop: async () => {} };
  }
  const connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue<IntegrationsDeliverJob>(
    INTEGRATIONS_DELIVER_QUEUE_NAME,
    { connection },
  );
  const http = createUndiciHttpClient();
  const worker = new Worker<IntegrationsDeliverJob>(
    INTEGRATIONS_DELIVER_QUEUE_NAME,
    async (job: Job<IntegrationsDeliverJob>) => {
      const provider = getProvider(job.data.providerId);
      const result = await runDeliverStep(job.data, {
        loadConnection: (id) =>
          drizzle.integrationConnectionRepo.getConnection(getDb(), id),
        decrypt: (cipher) => decrypt(cipher) as ProviderCredentials,
        insertPendingDelivery: (values) =>
          drizzle.integrationDeliveryRepo.insertPendingDelivery(
            getDb(),
            values,
          ),
        updateDeliveryStatus: (input) =>
          drizzle.integrationDeliveryRepo
            .updateDeliveryStatus(getDb(), input)
            .then(() => undefined),
        provider,
        http,
        attempt: job.attemptsMade + 1,
      });
      log.info("delivery step done", {
        outcome: result.outcome,
        connectionId: job.data.connectionId,
        outboxEventId: job.data.envelope.outboxEventId,
      });
      if (result.outcome === "failed") {
        throw new Error("retriable failure — handed to BullMQ for retry");
      }
    },
    {
      connection,
      concurrency: 16,
      settings: {
        backoffStrategy: (attemptsMade: number) => {
          return (
            INTEGRATIONS_DELIVER_BACKOFF_MS[attemptsMade - 1] ??
            INTEGRATIONS_DELIVER_BACKOFF_MS[
              INTEGRATIONS_DELIVER_BACKOFF_MS.length - 1
            ]!
          );
        },
      },
    },
  );
  await queue.waitUntilReady();
  await worker.waitUntilReady();
  log.info("integrations-deliver worker ready");
  return {
    queue,
    worker,
    stop: async () => {
      await worker.close();
      await queue.close();
      await connection.quit();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- integrations-deliver.unit.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workers/integrations-deliver.ts apps/api/src/workers/integrations-deliver.unit.test.ts
git commit -m "feat(integrations): BullMQ deliver worker"
```

### Task M2.6: Boot wiring in apps/api/src/index.ts

**Files:**
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/integrations-boot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  bootIntegrations,
} from "./integrations-boot";

describe("bootIntegrations", () => {
  it("returns a controller with stop()", async () => {
    const handle = await bootIntegrations({ autoStart: false });
    expect(typeof handle.stop).toBe("function");
    await handle.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- integrations-boot.test.ts`
Expected: FAIL — `Cannot find module './integrations-boot'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/api/src/integrations-boot.ts`:

```ts
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "./lib/env";
import { startIntegrationsFanout } from "./services/integrations-fanout/consumer";
import {
  ensureIntegrationsDeliverWorker,
} from "./workers/integrations-deliver";
import {
  INTEGRATIONS_DELIVER_QUEUE_NAME,
  type IntegrationsDeliverJob,
} from "./queues/integrations";

export interface IntegrationsBootHandle {
  stop: () => Promise<void>;
}

export async function bootIntegrations(
  opts: { autoStart?: boolean } = {},
): Promise<IntegrationsBootHandle> {
  if (opts.autoStart === false) {
    return { stop: async () => {} };
  }
  const workerHandle = await ensureIntegrationsDeliverWorker({
    autoStart: true,
  });
  const connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue<IntegrationsDeliverJob>(
    INTEGRATIONS_DELIVER_QUEUE_NAME,
    { connection },
  );
  const fanout = await startIntegrationsFanout(async (jobId, job) => {
    await queue.add("deliver", job, {
      jobId,
      attempts: 5,
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 7 * 86_400 },
    });
  });
  return {
    stop: async () => {
      await fanout.stop();
      await workerHandle.stop();
      await queue.close();
      await connection.quit();
    },
  };
}
```

In `apps/api/src/index.ts`, find the existing block where workers are started (next to `ensureWebhookDeliveryWorker()`); add:

```ts
import { bootIntegrations } from "./integrations-boot";
// ...inside startup main:
const integrations = await bootIntegrations();
// ...inside shutdown handler:
await integrations.stop();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- integrations-boot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/integrations-boot.ts apps/api/src/integrations-boot.test.ts apps/api/src/index.ts
git commit -m "feat(integrations): boot wiring (fanout + worker)"
```

### Task M2.7: End-to-end integration test (testcontainers)

**Files:**
- Create: `apps/api/src/workers/integrations-deliver.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create the integration test, mirroring the testcontainers setup of `send-push-worker.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { and, eq } from "drizzle-orm";
import { MockAgent, setGlobalDispatcher } from "undici";
import { drizzle, getDb } from "@rovenue/db";
import { encrypt } from "@rovenue/shared";
import {
  ensureIntegrationsDeliverWorker,
  type DeliverWorkerHandle,
} from "./integrations-deliver";
import {
  INTEGRATIONS_DELIVER_QUEUE_NAME,
  buildIntegrationsDeliverJobId,
  type IntegrationsDeliverJob,
} from "../queues/integrations";

const db = getDb();
const schema = drizzle.schema;
let worker: DeliverWorkerHandle;
let queue: Queue<IntegrationsDeliverJob>;
let redis: Redis;
let mockAgent: MockAgent;

beforeAll(async () => {
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  queue = new Queue(INTEGRATIONS_DELIVER_QUEUE_NAME, { connection: redis });
  worker = await ensureIntegrationsDeliverWorker({ autoStart: true });
});

afterAll(async () => {
  await worker.stop();
  await queue.close();
  await redis.quit();
});

beforeEach(async () => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

async function seedProject(): Promise<string> {
  const id = createId();
  await db.insert(schema.projects).values({
    id,
    name: `proj-${id}`,
    slug: `proj-${id}`,
  });
  return id;
}

async function seedConnection(projectId: string): Promise<string> {
  const id = createId();
  await drizzle.integrationConnectionRepo.createConnection(db, {
    id,
    projectId,
    providerId: "META_CAPI",
    displayName: "n",
    credentialsCipher: encrypt(
      JSON.stringify({ pixel_id: "p1", access_token: "tok" }),
    ),
    credentialsHint: "h",
    enabledEvents: ["revenue.RENEWAL"],
    eventMapping: {},
    actionSource: "app",
    isEnabled: true,
  });
  return id;
}

async function waitForDelivery(
  connectionId: string,
  outboxEventId: string,
  timeoutMs = 10_000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await db
      .select()
      .from(schema.integrationDeliveries)
      .where(
        and(
          eq(schema.integrationDeliveries.connectionId, connectionId),
          eq(schema.integrationDeliveries.outboxEventId, outboxEventId),
        ),
      );
    if (rows.length > 0) return rows[0];
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timeout waiting for delivery row");
}

describe("integrations-deliver end-to-end", () => {
  it("writes a succeeded row for a successful Meta CAPI delivery", async () => {
    mockAgent
      .get("https://graph.facebook.com")
      .intercept({
        path: /v18\.0\/p1\/events/,
        method: "POST",
      })
      .reply(200, '{"events_received":1}');

    const projectId = await seedProject();
    const connectionId = await seedConnection(projectId);
    const outboxEventId = createId();
    await queue.add(
      "deliver",
      {
        connectionId,
        projectId,
        providerId: "META_CAPI",
        envelope: {
          outboxEventId,
          projectId,
          eventType: "revenue.event.recorded",
          occurredAt: new Date().toISOString(),
          revenueEventKind: "RENEWAL",
          amount: "9.99",
          currency: "USD",
          identityContext: { email: "u@x.com" },
        },
      },
      { jobId: buildIntegrationsDeliverJobId(connectionId, outboxEventId) },
    );

    const row = await waitForDelivery(connectionId, outboxEventId);
    expect(row?.status).toBe("succeeded");
    expect(row?.httpStatus).toBe(200);
  });

  it("skips when identityContext is empty", async () => {
    const projectId = await seedProject();
    const connectionId = await seedConnection(projectId);
    const outboxEventId = createId();
    await queue.add(
      "deliver",
      {
        connectionId,
        projectId,
        providerId: "META_CAPI",
        envelope: {
          outboxEventId,
          projectId,
          eventType: "revenue.event.recorded",
          occurredAt: new Date().toISOString(),
          revenueEventKind: "RENEWAL",
          identityContext: {},
        },
      },
      { jobId: buildIntegrationsDeliverJobId(connectionId, outboxEventId) },
    );
    const row = await waitForDelivery(connectionId, outboxEventId);
    expect(row?.status).toBe("skipped");
    expect(row?.skipReason).toBe("no_user_data");
  });

  it("replay — same outboxEventId twice → one row", async () => {
    mockAgent
      .get("https://graph.facebook.com")
      .intercept({ path: /v18/, method: "POST" })
      .reply(200, "{}")
      .persist();
    const projectId = await seedProject();
    const connectionId = await seedConnection(projectId);
    const outboxEventId = createId();
    const jobOpts = {
      jobId: buildIntegrationsDeliverJobId(connectionId, outboxEventId),
    };
    const data: IntegrationsDeliverJob = {
      connectionId,
      projectId,
      providerId: "META_CAPI",
      envelope: {
        outboxEventId,
        projectId,
        eventType: "revenue.event.recorded",
        occurredAt: new Date().toISOString(),
        revenueEventKind: "RENEWAL",
        amount: "1",
        currency: "USD",
        identityContext: { email: "u@x.com" },
      },
    };
    await queue.add("deliver", data, jobOpts);
    await waitForDelivery(connectionId, outboxEventId);
    await queue.add("deliver", data, jobOpts).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    const all = await db
      .select()
      .from(schema.integrationDeliveries)
      .where(
        and(
          eq(schema.integrationDeliveries.connectionId, connectionId),
          eq(schema.integrationDeliveries.outboxEventId, outboxEventId),
        ),
      );
    expect(all.length).toBe(1);
  });

  it("dead_letter on 401", async () => {
    mockAgent
      .get("https://graph.facebook.com")
      .intercept({ path: /v18/, method: "POST" })
      .reply(401, "unauth");
    const projectId = await seedProject();
    const connectionId = await seedConnection(projectId);
    const outboxEventId = createId();
    await queue.add(
      "deliver",
      {
        connectionId,
        projectId,
        providerId: "META_CAPI",
        envelope: {
          outboxEventId,
          projectId,
          eventType: "revenue.event.recorded",
          occurredAt: new Date().toISOString(),
          revenueEventKind: "RENEWAL",
          amount: "1",
          currency: "USD",
          identityContext: { email: "u@x.com" },
        },
      },
      { jobId: buildIntegrationsDeliverJobId(connectionId, outboxEventId) },
    );
    const row = await waitForDelivery(connectionId, outboxEventId);
    expect(row?.status).toBe("dead_letter");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- integrations-deliver.integration.test.ts`
Expected: FAIL — full pipeline not yet stitched (or row never appears within timeout).

- [ ] **Step 3: Write minimal implementation**

If the test fails, fix the worker wiring discovered by the failure (most commonly: missing `decrypt` JSON parse, missing schema export, or non-cascading FK). Adjust `runDeliverStep` so that `decrypt(cipher)` returns the parsed object (since we encrypt with `JSON.stringify`):

```ts
decrypt: (cipher) => JSON.parse(decrypt(cipher)) as ProviderCredentials,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- integrations-deliver.integration.test.ts`
Expected: PASS (4 cases: success, skip, replay, dead-letter).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workers/integrations-deliver.integration.test.ts apps/api/src/workers/integrations-deliver.ts
git commit -m "test(integrations): end-to-end deliver pipeline integration test"
```

---

## M3 — Audit & observability

### Task M3.1: Extend AuditAction + AuditResource unions

**Files:**
- Modify: `apps/api/src/lib/audit.ts`
- Test: `apps/api/src/lib/audit-integrations.test.ts`

- [ ] **Step 1: Write the failing test**

Create `audit-integrations.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AuditAction, AuditResource } from "./audit";

describe("audit unions — integrations", () => {
  it("AuditAction includes the five integration actions", () => {
    const ok: AuditAction[] = [
      "integration.connection.created",
      "integration.connection.updated",
      "integration.connection.deleted",
      "integration.credentials.rotated",
      "integration.delivery.dead_letter",
    ];
    expect(ok.length).toBe(5);
  });

  it("AuditResource includes integration_connection", () => {
    const r: AuditResource = "integration_connection";
    expect(r).toBe("integration_connection");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- audit-integrations.test.ts`
Expected: FAIL — `Type '"integration.connection.created"' is not assignable to type 'AuditAction'`.

- [ ] **Step 3: Write minimal implementation**

In `apps/api/src/lib/audit.ts`, append to the `AuditAction` union:

```ts
  // --- integrations ---
  | "integration.connection.created"
  | "integration.connection.updated"
  | "integration.connection.deleted"
  | "integration.credentials.rotated"
  | "integration.delivery.dead_letter";
```

And append to `AuditResource`:

```ts
  | "integration_connection";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- audit-integrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/audit.ts apps/api/src/lib/audit-integrations.test.ts
git commit -m "feat(audit): integration.* AuditAction + integration_connection resource"
```

### Task M3.2: audit() in createConnection / updateConnection / softDeleteConnection

**Files:**
- Modify: `packages/db/src/drizzle/repositories/integration-connections.ts` — accept optional `audit` callback
- Create: `apps/api/src/services/integrations/audit-helpers.ts`
- Test: `apps/api/src/services/integrations/audit-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `audit-helpers.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  auditIntegrationCreate,
  auditIntegrationUpdate,
  auditIntegrationDelete,
} from "./audit-helpers";

describe("audit helpers", () => {
  it("auditIntegrationCreate calls audit() with redacted creds", async () => {
    const audit = vi.fn().mockResolvedValue(undefined);
    await auditIntegrationCreate(
      { audit } as never,
      {
        tx: {} as never,
        projectId: "p1",
        userId: "u1",
        resourceId: "c1",
        after: {
          credentialsCipher: "v1:secret",
          displayName: "Meta",
        },
      },
    );
    const call = audit.mock.calls[0][1];
    expect(call.action).toBe("integration.connection.created");
    expect(call.resource).toBe("integration_connection");
    expect(call.after?.credentialsCipher).toBe("[REDACTED]");
    expect(call.after?.displayName).toBe("Meta");
  });

  it("auditIntegrationUpdate redacts before+after credentialsCipher", async () => {
    const audit = vi.fn().mockResolvedValue(undefined);
    await auditIntegrationUpdate(
      { audit } as never,
      {
        tx: {} as never,
        projectId: "p1",
        userId: "u1",
        resourceId: "c1",
        before: { credentialsCipher: "v1:old", isEnabled: false },
        after: { credentialsCipher: "v1:new", isEnabled: true },
      },
    );
    const call = audit.mock.calls[0][1];
    expect(call.before?.credentialsCipher).toBe("[REDACTED]");
    expect(call.after?.credentialsCipher).toBe("[REDACTED]");
    expect(call.after?.isEnabled).toBe(true);
  });

  it("auditIntegrationDelete fires correct action", async () => {
    const audit = vi.fn().mockResolvedValue(undefined);
    await auditIntegrationDelete(
      { audit } as never,
      {
        tx: {} as never,
        projectId: "p1",
        userId: "u1",
        resourceId: "c1",
      },
    );
    expect(audit.mock.calls[0][1].action).toBe(
      "integration.connection.deleted",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- audit-helpers.test.ts`
Expected: FAIL — `Cannot find module './audit-helpers'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/api/src/services/integrations/audit-helpers.ts`:

```ts
import type { audit as auditFn } from "../../lib/audit";

type AuditFn = typeof auditFn;
type Tx = Parameters<AuditFn>[0];

function redactCredentialsBag(
  obj: Record<string, unknown> | undefined | null,
): Record<string, unknown> | null {
  if (!obj) return null;
  const out: Record<string, unknown> = { ...obj };
  if ("credentialsCipher" in out) out.credentialsCipher = "[REDACTED]";
  if ("access_token" in out) out.access_token = "[REDACTED]";
  return out;
}

export interface AuditIntegrationDeps {
  audit: AuditFn;
}

export interface AuditCreateInput {
  tx: Tx;
  projectId: string;
  userId: string;
  resourceId: string;
  after: Record<string, unknown>;
}

export async function auditIntegrationCreate(
  deps: AuditIntegrationDeps,
  input: AuditCreateInput,
): Promise<void> {
  await deps.audit(input.tx, {
    projectId: input.projectId,
    userId: input.userId,
    action: "integration.connection.created",
    resource: "integration_connection",
    resourceId: input.resourceId,
    after: redactCredentialsBag(input.after),
  });
}

export interface AuditUpdateInput {
  tx: Tx;
  projectId: string;
  userId: string;
  resourceId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export async function auditIntegrationUpdate(
  deps: AuditIntegrationDeps,
  input: AuditUpdateInput,
): Promise<void> {
  await deps.audit(input.tx, {
    projectId: input.projectId,
    userId: input.userId,
    action: "integration.connection.updated",
    resource: "integration_connection",
    resourceId: input.resourceId,
    before: redactCredentialsBag(input.before),
    after: redactCredentialsBag(input.after),
  });
}

export interface AuditDeleteInput {
  tx: Tx;
  projectId: string;
  userId: string;
  resourceId: string;
}

export async function auditIntegrationDelete(
  deps: AuditIntegrationDeps,
  input: AuditDeleteInput,
): Promise<void> {
  await deps.audit(input.tx, {
    projectId: input.projectId,
    userId: input.userId,
    action: "integration.connection.deleted",
    resource: "integration_connection",
    resourceId: input.resourceId,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- audit-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/integrations/audit-helpers.ts apps/api/src/services/integrations/audit-helpers.test.ts
git commit -m "feat(integrations): audit helpers with credential redaction"
```

### Task M3.3: Structured log helpers

**Files:**
- Create: `apps/api/src/services/integrations/logging.ts`
- Test: `apps/api/src/services/integrations/logging.test.ts`

- [ ] **Step 1: Write the failing test**

Create `logging.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  logDeliveryAttempt,
  logDeliveryResult,
  logDeliveryDeadLetter,
} from "./logging";

describe("integrations logging", () => {
  it("logDeliveryAttempt emits the integrations.delivery.attempt event", () => {
    const child = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    logDeliveryAttempt(child as never, {
      connectionId: "c1",
      providerId: "META_CAPI",
      outboxEventId: "o1",
      attempt: 2,
      eventKey: "revenue.RENEWAL",
    });
    expect(child.info).toHaveBeenCalledWith(
      "integrations.delivery.attempt",
      expect.objectContaining({ attempt: 2, providerId: "META_CAPI" }),
    );
  });

  it("logDeliveryResult logs durationMs and httpStatus", () => {
    const child = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    logDeliveryResult(child as never, {
      connectionId: "c1",
      providerId: "META_CAPI",
      outboxEventId: "o1",
      attempt: 1,
      eventKey: "revenue.RENEWAL",
      status: "succeeded",
      httpStatus: 200,
      durationMs: 150,
    });
    expect(child.info).toHaveBeenCalledWith(
      "integrations.delivery.result",
      expect.objectContaining({ status: "succeeded", durationMs: 150 }),
    );
  });

  it("logDeliveryDeadLetter emits with errorMessage", () => {
    const child = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    logDeliveryDeadLetter(child as never, {
      connectionId: "c1",
      providerId: "META_CAPI",
      outboxEventId: "o1",
      attempt: 5,
      eventKey: "revenue.RENEWAL",
      errorMessage: "401",
    });
    expect(child.error).toHaveBeenCalledWith(
      "integrations.delivery.dead_letter",
      expect.objectContaining({ errorMessage: "401" }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- logging.test.ts`
Expected: FAIL — `Cannot find module './logging'`.

- [ ] **Step 3: Write minimal implementation**

Create `logging.ts`:

```ts
import type { Logger } from "../../lib/logger";
import type { ProviderId } from "./types";

export interface AttemptFields {
  connectionId: string;
  providerId: ProviderId;
  outboxEventId: string;
  attempt: number;
  eventKey: string;
}

export interface ResultFields extends AttemptFields {
  status: "succeeded" | "failed" | "skipped" | "dead_letter";
  httpStatus?: number | null;
  durationMs: number;
}

export interface DeadLetterFields extends AttemptFields {
  errorMessage?: string | null;
}

export function logDeliveryAttempt(log: Logger, f: AttemptFields): void {
  log.info("integrations.delivery.attempt", { ...f });
}

export function logDeliveryResult(log: Logger, f: ResultFields): void {
  log.info("integrations.delivery.result", { ...f });
}

export function logDeliveryDeadLetter(
  log: Logger,
  f: DeadLetterFields,
): void {
  log.error("integrations.delivery.dead_letter", { ...f });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- logging.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/integrations/logging.ts apps/api/src/services/integrations/logging.test.ts
git commit -m "feat(integrations): structured log helpers"
```

### Task M3.4: Sentry breadcrumb on dead-letter

**Files:**
- Create: `apps/api/src/services/integrations/sentry-bridge.ts`
- Test: `apps/api/src/services/integrations/sentry-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

Create `sentry-bridge.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { reportDeadLetterToSentry } from "./sentry-bridge";

describe("reportDeadLetterToSentry", () => {
  it("invokes captureNotifierError with provider context", () => {
    const captureNotifierError = vi.fn();
    reportDeadLetterToSentry(
      { captureNotifierError } as never,
      {
        connectionId: "c1",
        providerId: "META_CAPI",
        outboxEventId: "o1",
        errorMessage: "401 unauth",
      },
    );
    expect(captureNotifierError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        connectionId: "c1",
        providerId: "META_CAPI",
        outboxEventId: "o1",
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- sentry-bridge.test.ts`
Expected: FAIL — `Cannot find module './sentry-bridge'`.

- [ ] **Step 3: Write minimal implementation**

Create `sentry-bridge.ts`:

```ts
import type { captureNotifierError as capture } from "../../lib/sentry-notifications";
import type { ProviderId } from "./types";

export interface SentryDeps {
  captureNotifierError: typeof capture;
}

export interface DeadLetterContext {
  connectionId: string;
  providerId: ProviderId;
  outboxEventId: string;
  errorMessage?: string | null;
}

export function reportDeadLetterToSentry(
  deps: SentryDeps,
  ctx: DeadLetterContext,
): void {
  const err = new Error(
    `integration delivery dead-letter: ${ctx.providerId} ${ctx.errorMessage ?? "unknown"}`,
  );
  deps.captureNotifierError(err, {
    connectionId: ctx.connectionId,
    providerId: ctx.providerId,
    outboxEventId: ctx.outboxEventId,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- sentry-bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/integrations/sentry-bridge.ts apps/api/src/services/integrations/sentry-bridge.test.ts
git commit -m "feat(integrations): Sentry breadcrumb bridge for dead-letter"
```

### Task M3.5: Live Events publish on successful delivery

**Files:**
- Create: `apps/api/src/services/integrations/live-events.ts`
- Test: `apps/api/src/services/integrations/live-events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `live-events.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { publishIntegrationDeliveryLiveEvent } from "./live-events";

describe("publishIntegrationDeliveryLiveEvent", () => {
  it("publishes to the LIVE_EVENTS_CHANNEL_PREFIX:<projectId> channel", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    await publishIntegrationDeliveryLiveEvent(
      { publish } as never,
      {
        projectId: "p1",
        connectionId: "c1",
        providerId: "META_CAPI",
        eventKey: "revenue.RENEWAL",
        status: "succeeded",
      },
    );
    expect(publish).toHaveBeenCalledWith(
      "rovenue.live-events:p1",
      expect.stringContaining('"kind":"integration_delivery"'),
    );
  });

  it("swallows publish errors (best-effort)", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("redis down"));
    await expect(
      publishIntegrationDeliveryLiveEvent(
        { publish } as never,
        {
          projectId: "p1",
          connectionId: "c1",
          providerId: "META_CAPI",
          eventKey: "revenue.RENEWAL",
          status: "succeeded",
        },
      ),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- live-events.test.ts`
Expected: FAIL — `Cannot find module './live-events'`.

- [ ] **Step 3: Write minimal implementation**

Create `live-events.ts`:

```ts
import type { ProviderId } from "./types";

export const LIVE_EVENTS_CHANNEL_PREFIX = "rovenue.live-events";

export interface LivePublisher {
  publish: (channel: string, message: string) => Promise<unknown>;
}

export interface DeliveryLiveEvent {
  projectId: string;
  connectionId: string;
  providerId: ProviderId;
  eventKey: string;
  status: "succeeded" | "failed" | "skipped" | "dead_letter";
}

export async function publishIntegrationDeliveryLiveEvent(
  pub: LivePublisher,
  ev: DeliveryLiveEvent,
): Promise<void> {
  const channel = `${LIVE_EVENTS_CHANNEL_PREFIX}:${ev.projectId}`;
  const payload = JSON.stringify({
    kind: "integration_delivery",
    connectionId: ev.connectionId,
    providerId: ev.providerId,
    eventKey: ev.eventKey,
    status: ev.status,
    occurredAt: new Date().toISOString(),
  });
  try {
    await pub.publish(channel, payload);
  } catch {
    // best-effort
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- live-events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/integrations/live-events.ts apps/api/src/services/integrations/live-events.test.ts
git commit -m "feat(integrations): Live Events publisher"
```

### Task M3.6: Wire audit + sentry + live-events into the worker

**Files:**
- Modify: `apps/api/src/workers/integrations-deliver.ts`
- Modify: `apps/api/src/workers/integrations-deliver.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `integrations-deliver.unit.test.ts`:

```ts
import { runDeliverStep as runWithSideEffects } from "./integrations-deliver";

describe("runDeliverStep — side effects", () => {
  it("publishes live event + skips audit on success", async () => {
    const insertPendingDelivery = vi
      .fn()
      .mockResolvedValue({ id: "d1", createdAt: new Date() });
    const updateDeliveryStatus = vi.fn();
    const publishLiveEvent = vi.fn().mockResolvedValue(undefined);
    const auditDeadLetter = vi.fn();
    const captureSentry = vi.fn();
    const provider = {
      id: "META_CAPI" as const,
      mapEvent: vi.fn().mockReturnValue({
        eventKey: "revenue.RENEWAL",
        providerEvent: "Purchase",
        body: {},
      }),
      deliver: vi
        .fn()
        .mockResolvedValue({ ok: true, httpStatus: 200, responseBody: "{}", retriable: false }),
    };
    await runWithSideEffects(job, {
      loadConnection: vi.fn().mockResolvedValue(conn),
      decrypt: () => ({}),
      insertPendingDelivery,
      updateDeliveryStatus,
      provider: provider as never,
      http: { request: vi.fn() } as never,
      attempt: 1,
      publishLiveEvent,
      auditDeadLetter,
      captureSentry,
    });
    expect(publishLiveEvent).toHaveBeenCalledTimes(1);
    expect(auditDeadLetter).not.toHaveBeenCalled();
    expect(captureSentry).not.toHaveBeenCalled();
  });

  it("fires audit + sentry on dead_letter", async () => {
    const insertPendingDelivery = vi
      .fn()
      .mockResolvedValue({ id: "d1", createdAt: new Date() });
    const updateDeliveryStatus = vi.fn();
    const publishLiveEvent = vi.fn();
    const auditDeadLetter = vi.fn();
    const captureSentry = vi.fn();
    const provider = {
      id: "META_CAPI" as const,
      mapEvent: vi.fn().mockReturnValue({
        eventKey: "revenue.RENEWAL",
        providerEvent: "Purchase",
        body: {},
      }),
      deliver: vi.fn().mockResolvedValue({
        ok: false,
        httpStatus: 401,
        responseBody: "u",
        retriable: false,
        errorMessage: "401",
      }),
    };
    await runWithSideEffects(job, {
      loadConnection: vi.fn().mockResolvedValue(conn),
      decrypt: () => ({}),
      insertPendingDelivery,
      updateDeliveryStatus,
      provider: provider as never,
      http: { request: vi.fn() } as never,
      attempt: 5,
      publishLiveEvent,
      auditDeadLetter,
      captureSentry,
    });
    expect(auditDeadLetter).toHaveBeenCalledTimes(1);
    expect(captureSentry).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- integrations-deliver.unit.test.ts`
Expected: FAIL — `publishLiveEvent / auditDeadLetter / captureSentry` not part of `DeliverStepDeps`.

- [ ] **Step 3: Write minimal implementation**

Extend `DeliverStepDeps` in `integrations-deliver.ts`:

```ts
export interface DeliverStepDeps {
  // ...existing fields...
  publishLiveEvent?: (ev: {
    projectId: string;
    connectionId: string;
    providerId: ProviderId;
    eventKey: string;
    status: "succeeded" | "failed" | "skipped" | "dead_letter";
  }) => Promise<void>;
  auditDeadLetter?: (input: {
    projectId: string;
    connectionId: string;
    outboxEventId: string;
    providerId: ProviderId;
    errorMessage?: string | null;
  }) => Promise<void>;
  captureSentry?: (input: {
    connectionId: string;
    providerId: ProviderId;
    outboxEventId: string;
    errorMessage?: string | null;
  }) => void;
}
```

(Import `ProviderId` from `../services/integrations/types`.)

At the bottom of `runDeliverStep`, after `updateDeliveryStatus`:

```ts
const final = status === "failed" ? "failed" : status;
if (deps.publishLiveEvent) {
  await deps.publishLiveEvent({
    projectId: conn.projectId,
    connectionId: conn.id,
    providerId: conn.providerId,
    eventKey: mapped.eventKey,
    status: final === "succeeded"
      ? "succeeded"
      : final === "dead_letter"
        ? "dead_letter"
        : "failed",
  });
}
if (final === "dead_letter") {
  if (deps.auditDeadLetter) {
    await deps.auditDeadLetter({
      projectId: conn.projectId,
      connectionId: conn.id,
      outboxEventId: job.envelope.outboxEventId,
      providerId: conn.providerId,
      errorMessage: result.errorMessage,
    });
  }
  if (deps.captureSentry) {
    deps.captureSentry({
      connectionId: conn.id,
      providerId: conn.providerId,
      outboxEventId: job.envelope.outboxEventId,
      errorMessage: result.errorMessage,
    });
  }
}
return { outcome: status, deliveryId: inserted.id };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- integrations-deliver.unit.test.ts`
Expected: PASS (all 7 tests in the unit file).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workers/integrations-deliver.ts apps/api/src/workers/integrations-deliver.unit.test.ts
git commit -m "feat(integrations): worker side effects — audit + sentry + live events"
```

### Task M3.7: Wire side-effect deps from ensureIntegrationsDeliverWorker

**Files:**
- Modify: `apps/api/src/workers/integrations-deliver.ts`

- [ ] **Step 1: Write the failing test**

Re-run the integration test from M2.7 — it should still pass; we want to make sure wiring the audit/Sentry/live-events deps does not regress it. No new test code needed beyond that re-run.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- integrations-deliver.integration.test.ts`
Expected: PASS already, but skip wiring leaves dead-letter audit unwritten. After the next step we expect the dead-letter case to still pass and a follow-up assertion to be writable in M3.8.

- [ ] **Step 3: Write minimal implementation**

In the BullMQ Worker callback inside `ensureIntegrationsDeliverWorker`, expand the `runDeliverStep` call:

```ts
import { Redis } from "ioredis";
import { audit } from "../lib/audit";
import { captureNotifierError } from "../lib/sentry-notifications";
import {
  publishIntegrationDeliveryLiveEvent,
} from "../services/integrations/live-events";
import {
  reportDeadLetterToSentry,
} from "../services/integrations/sentry-bridge";

// pubsub redis (separate connection)
const livePublisher = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

// ...inside the Worker handler:
const result = await runDeliverStep(job.data, {
  // ...existing deps...
  publishLiveEvent: async (ev) =>
    publishIntegrationDeliveryLiveEvent(
      { publish: (c, m) => livePublisher.publish(c, m) },
      ev,
    ),
  auditDeadLetter: async (input) => {
    await audit(getDb(), {
      projectId: input.projectId,
      userId: "system",
      action: "integration.delivery.dead_letter",
      resource: "integration_connection",
      resourceId: input.connectionId,
      after: {
        outboxEventId: input.outboxEventId,
        providerId: input.providerId,
        errorMessage: input.errorMessage ?? null,
      },
    });
  },
  captureSentry: (ctx) =>
    reportDeadLetterToSentry({ captureNotifierError }, ctx),
});
```

In the `stop()` callback, add `await livePublisher.quit();`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- integrations-deliver.integration.test.ts`
Expected: PASS (still 4 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workers/integrations-deliver.ts
git commit -m "feat(integrations): plumb side-effect deps into worker boot"
```

### Task M3.8: Integration test — dead-letter writes audit_logs row

**Files:**
- Modify: `apps/api/src/workers/integrations-deliver.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Append a new case at the end of the file:

```ts
import { desc } from "drizzle-orm";

it("dead_letter case writes an audit_logs row", async () => {
  mockAgent
    .get("https://graph.facebook.com")
    .intercept({ path: /v18/, method: "POST" })
    .reply(401, "u");
  const projectId = await seedProject();
  const connectionId = await seedConnection(projectId);
  const outboxEventId = createId();
  await queue.add(
    "deliver",
    {
      connectionId,
      projectId,
      providerId: "META_CAPI",
      envelope: {
        outboxEventId,
        projectId,
        eventType: "revenue.event.recorded",
        occurredAt: new Date().toISOString(),
        revenueEventKind: "RENEWAL",
        amount: "1",
        currency: "USD",
        identityContext: { email: "u@x.com" },
      },
    },
    { jobId: buildIntegrationsDeliverJobId(connectionId, outboxEventId) },
  );
  await waitForDelivery(connectionId, outboxEventId);

  const audits = await db
    .select()
    .from(schema.auditLogs)
    .where(eq(schema.auditLogs.projectId, projectId))
    .orderBy(desc(schema.auditLogs.createdAt))
    .limit(5);
  const hit = audits.find(
    (a) => a.action === "integration.delivery.dead_letter",
  );
  expect(hit).toBeDefined();
  expect(hit?.resourceId).toBe(connectionId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- integrations-deliver.integration.test.ts -t "dead_letter case writes an audit_logs row"`
Expected: PASS (audit was wired in M3.7).  If it fails, the wiring step did not commit; fix and re-run.

- [ ] **Step 3: Write minimal implementation**

If failure: ensure `auditDeadLetter` is actually invoked in the worker. Check that `audit()` is exported and accepts the shape used here; if the `audit()` first argument is the drizzle client rather than a tx, the worker call must pass `getDb()`, not a transaction. Adjust accordingly.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- integrations-deliver.integration.test.ts`
Expected: PASS (5 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workers/integrations-deliver.integration.test.ts
git commit -m "test(integrations): assert audit row written on dead-letter"
```

---

<!-- PART 1 END (M0-M3). Continue in PART 2 (M4-M6) and PART 3 (M7-M8). -->
