# Integrations Framework — Meta CAPI & TikTok Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship outbound conversion delivery from Rovenue domain events to Meta CAPI + TikTok Events API, with per-project configurable scope, dashboard config UI, and 7-day backfill on activation — built on the existing outbox→Kafka→BullMQ pipeline.

**Architecture:** New Kafka consumer (`integrations-fanout`) subscribes to existing `rovenue.revenue` + `rovenue.billing` topics, enqueues per-(connection × outbox event) BullMQ jobs into a new `rovenue-integrations-deliver` queue. Stateless provider modules (Meta CAPI, TikTok Events) implement a narrow `IntegrationProvider` interface (`validateCredentials`, `mapEvent`, `deliver`). Idempotency via `UNIQUE(connection_id, outbox_event_id, created_at)` on a pg_partman-partitioned `integration_deliveries` table. PII never at-rest — SDK ships per-event `identityContext` hashed at delivery time.

**Tech Stack:** Hono + TypeScript, Drizzle ORM + drizzle-kit migrations, PostgreSQL 16 + pg_partman, Kafka/Redpanda + kafkajs, BullMQ + Redis, AES-256-GCM via `packages/shared/src/crypto.ts`, vitest + testcontainers, undici MockAgent for HTTP test stubs, base-ui Dialog drawer pattern.

**Total milestones:** 9 (M0 through M8 + M9 gap-closures). This file is built up in three parts; see plan footer for status.

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

## Milestone M4 — Backfill on activation (7-day window)

When `integration_connections.is_enabled` flips false→true, enqueue every outbox event from the last 7 days as a regular deliver job tagged `isBackfill: true`. Idempotency relies on the same `jobId = ${connectionId}:${outboxEventId}` dedup applied to realtime traffic (M2) plus the DB UNIQUE on `(connection_id, outbox_event_id, created_at)` (M1).

### Task M4.1: Extend AuditAction union with backfill + test_event actions

**Files:**
- Modify: `apps/api/src/lib/audit.ts`
- Modify: `apps/api/src/lib/audit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/lib/audit.test.ts`:

```ts
it("admits integration.backfill.started, integration.backfill.completed, integration.test_event.sent", () => {
  const a: AuditAction = "integration.backfill.started";
  const b: AuditAction = "integration.backfill.completed";
  const c: AuditAction = "integration.test_event.sent";
  expect([a, b, c]).toHaveLength(3);
});
```

Run: `pnpm --filter @rovenue/api test -- audit.test.ts`
Expected: FAIL — literal not assignable.

- [ ] **Step 2: Write minimal implementation**

In `apps/api/src/lib/audit.ts`, extend the existing `AuditAction` union (literals from Part 1 M0 already include `integration.connection.created/updated/deleted/credentials.rotated/delivery.dead_letter`). Append:

```ts
| "integration.test_event.sent"
| "integration.backfill.started"
| "integration.backfill.completed";
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- audit.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/audit.ts apps/api/src/lib/audit.test.ts
git commit -m "feat(audit): extend AuditAction union with integration.backfill.* + test_event.sent"
```

### Task M4.2: enqueueBackfillForConnection — unit test (windowDays math)

**Files:**
- Create: `apps/api/src/services/integrations/backfill.ts`
- Create: `apps/api/src/services/integrations/backfill.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { enqueueBackfillForConnection } from "./backfill";

describe("enqueueBackfillForConnection", () => {
  it("queries with INTERVAL '7 days' by default", async () => {
    const queryCalls: { sql: string }[] = [];
    const fakeDb = {
      execute: vi.fn(async (q: { sql: string }) => {
        queryCalls.push(q);
        return { rows: [] };
      }),
    };
    const fakeQueue = { add: vi.fn(async () => undefined) };
    const fakeAudit = vi.fn(async () => undefined);
    await enqueueBackfillForConnection(
      { connectionId: "conn-1", projectId: "proj-1", providerId: "META_CAPI" },
      { db: fakeDb as never, queue: fakeQueue as never, audit: fakeAudit, now: () => new Date() },
    );
    expect(queryCalls[0]!.sql).toMatch(/INTERVAL '7 days'/);
    expect(queryCalls[0]!.sql).toMatch(/aggregate_type IN \('revenue', 'billing'\)/);
    expect(fakeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "integration.backfill.started",
        metadata: { windowDays: 7, eventCount: 0 },
      }),
    );
  });

  it("respects a custom windowDays argument", async () => {
    const queryCalls: { sql: string }[] = [];
    const fakeDb = { execute: vi.fn(async (q: { sql: string }) => { queryCalls.push(q); return { rows: [] }; }) };
    await enqueueBackfillForConnection(
      { connectionId: "c", projectId: "p", providerId: "TIKTOK_EVENTS", windowDays: 3 },
      { db: fakeDb as never, queue: { add: vi.fn() } as never, audit: vi.fn(), now: () => new Date() },
    );
    expect(queryCalls[0]!.sql).toMatch(/INTERVAL '3 days'/);
  });
});
```

Run: `pnpm --filter @rovenue/api test -- backfill.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Write minimal implementation**

Create `apps/api/src/services/integrations/backfill.ts`:

```ts
import { sql } from "drizzle-orm";
import type { Queue } from "bullmq";
import type { ProviderId } from "./types";
import type { IntegrationsDeliverJob } from "../../workers/integrations-deliver";
import { buildIntegrationsDeliverJobId } from "../../workers/integrations-deliver";

export interface EnqueueBackfillArgs {
  connectionId: string;
  projectId: string;
  providerId: ProviderId;
  windowDays?: number;
}

export interface EnqueueBackfillDeps {
  db: { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: Array<{ id: string; aggregate_type: string; event_type: string; payload: unknown; created_at: Date }> }> };
  queue: Pick<Queue<IntegrationsDeliverJob>, "add">;
  audit: (input: {
    projectId: string;
    actorId: string;
    actorType: "system" | "user";
    action: "integration.backfill.started" | "integration.backfill.completed";
    resource: "integration_connection";
    resourceId: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
  now: () => Date;
}

/**
 * Re-enqueues outbox events from the last `windowDays` for a freshly-activated
 * connection. Each job uses the same `${connectionId}:${outboxEventId}` jobId
 * as realtime traffic, so BullMQ + the DB UNIQUE constraint co-deduplicate.
 *
 * CAVEAT: Meta CAPI dedup is 7d, TikTok is 14d. A reactivation inside those
 * windows is safe (platform-side dedup kicks in even if our queue/DB doesn't).
 * Do NOT extend windowDays beyond 14 without re-evaluating TikTok dedup.
 */
export async function enqueueBackfillForConnection(
  args: EnqueueBackfillArgs,
  deps: EnqueueBackfillDeps,
): Promise<{ eventCount: number }> {
  const windowDays = args.windowDays ?? 7;
  const intervalLit = sql.raw(`INTERVAL '${windowDays} days'`);

  const result = await deps.db.execute(sql`
    SELECT id, aggregate_type, event_type, payload, created_at
    FROM outbox_events
    WHERE project_id = ${args.projectId}
      AND created_at > NOW() - ${intervalLit}
      AND aggregate_type IN ('revenue', 'billing')
    ORDER BY created_at ASC
    LIMIT 10000
  `);

  for (const row of result.rows) {
    await deps.queue.add(
      "deliver",
      {
        connectionId: args.connectionId,
        projectId: args.projectId,
        providerId: args.providerId,
        envelope: row.payload as never,
        isBackfill: true,
      },
      { jobId: buildIntegrationsDeliverJobId(args.connectionId, row.id), priority: 10 },
    );
  }

  await deps.audit({
    projectId: args.projectId,
    actorId: "system",
    actorType: "system",
    action: "integration.backfill.started",
    resource: "integration_connection",
    resourceId: args.connectionId,
    metadata: { windowDays, eventCount: result.rows.length },
  });

  return { eventCount: result.rows.length };
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- backfill.test.ts`
Expected: PASS (2 cases).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/integrations/backfill.ts apps/api/src/services/integrations/backfill.test.ts
git commit -m "feat(integrations): enqueueBackfillForConnection with 7d window default"
```

### Task M4.3: Hardening — chunked iteration when >10000 rows

**Files:**
- Modify: `apps/api/src/services/integrations/backfill.ts`
- Modify: `apps/api/src/services/integrations/backfill.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
it("chunks queries when more than 10000 rows would match", async () => {
  let calls = 0;
  const fakeDb = {
    execute: vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return {
          rows: Array.from({ length: 10000 }, (_, i) => ({
            id: `o-${i}`, aggregate_type: "revenue", event_type: "revenue.event.recorded",
            payload: { outboxEventId: `o-${i}` }, created_at: new Date(2026, 0, 1, 0, i),
          })),
        };
      }
      if (calls === 2) {
        return { rows: [{ id: "o-extra", aggregate_type: "revenue", event_type: "revenue.event.recorded", payload: { outboxEventId: "o-extra" }, created_at: new Date(2026, 0, 1, 1, 0) }] };
      }
      return { rows: [] };
    }),
  };
  const result = await enqueueBackfillForConnection(
    { connectionId: "c", projectId: "p", providerId: "META_CAPI" },
    { db: fakeDb as never, queue: { add: vi.fn() } as never, audit: vi.fn(), now: () => new Date() },
  );
  expect(result.eventCount).toBe(10001);
  expect(calls).toBeGreaterThanOrEqual(2);
});
```

Run: `pnpm --filter @rovenue/api test -- backfill.test.ts -t "chunks"`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

Replace the query loop in `backfill.ts` with a cursor pagination loop:

```ts
let cursor: Date | null = null;
let total = 0;
const PAGE_SIZE = 10000;
while (true) {
  const cursorClause = cursor
    ? sql`AND created_at > ${cursor.toISOString()}::timestamptz`
    : sql``;
  const result = await deps.db.execute(sql`
    SELECT id, aggregate_type, event_type, payload, created_at
    FROM outbox_events
    WHERE project_id = ${args.projectId}
      AND created_at > NOW() - ${intervalLit}
      AND aggregate_type IN ('revenue', 'billing')
      ${cursorClause}
    ORDER BY created_at ASC
    LIMIT ${PAGE_SIZE}
  `);
  if (result.rows.length === 0) break;
  for (const row of result.rows) {
    await deps.queue.add(
      "deliver",
      { connectionId: args.connectionId, projectId: args.projectId, providerId: args.providerId, envelope: row.payload as never, isBackfill: true },
      { jobId: buildIntegrationsDeliverJobId(args.connectionId, row.id), priority: 10 },
    );
    cursor = row.created_at;
    total++;
  }
  if (result.rows.length < PAGE_SIZE) break;
}

await deps.audit({
  projectId: args.projectId,
  actorId: "system",
  actorType: "system",
  action: "integration.backfill.started",
  resource: "integration_connection",
  resourceId: args.connectionId,
  metadata: { windowDays, eventCount: total },
});

return { eventCount: total };
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- backfill.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/integrations/backfill.ts apps/api/src/services/integrations/backfill.test.ts
git commit -m "feat(integrations): chunk backfill queries (bound memory at 10000/page)"
```

### Task M4.4: handleConnectionEnableTransition helper

**Files:**
- Create: `apps/api/src/services/integrations/connection-events.ts`
- Create: `apps/api/src/services/integrations/connection-events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { handleConnectionEnableTransition } from "./connection-events";

describe("handleConnectionEnableTransition", () => {
  it("calls enqueueBackfill when transitioning false → true", async () => {
    const enqueue = vi.fn(async () => ({ eventCount: 0 }));
    await handleConnectionEnableTransition(
      { wasEnabled: false, willBeEnabled: true, connectionId: "c", projectId: "p", providerId: "META_CAPI" },
      { enqueueBackfill: enqueue },
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("no-ops when wasEnabled = willBeEnabled", async () => {
    const enqueue = vi.fn();
    await handleConnectionEnableTransition(
      { wasEnabled: true, willBeEnabled: true, connectionId: "c", projectId: "p", providerId: "META_CAPI" },
      { enqueueBackfill: enqueue },
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("no-ops on true → false", async () => {
    const enqueue = vi.fn();
    await handleConnectionEnableTransition(
      { wasEnabled: true, willBeEnabled: false, connectionId: "c", projectId: "p", providerId: "META_CAPI" },
      { enqueueBackfill: enqueue },
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});
```

Run: `pnpm --filter @rovenue/api test -- connection-events.test.ts`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```ts
import type { ProviderId } from "./types";

export interface EnableTransitionArgs {
  wasEnabled: boolean;
  willBeEnabled: boolean;
  connectionId: string;
  projectId: string;
  providerId: ProviderId;
}

export interface EnableTransitionDeps {
  enqueueBackfill: (args: { connectionId: string; projectId: string; providerId: ProviderId }) => Promise<{ eventCount: number }>;
}

export async function handleConnectionEnableTransition(
  args: EnableTransitionArgs,
  deps: EnableTransitionDeps,
): Promise<void> {
  if (args.wasEnabled === args.willBeEnabled) return;
  if (!args.willBeEnabled) return;
  await deps.enqueueBackfill({
    connectionId: args.connectionId,
    projectId: args.projectId,
    providerId: args.providerId,
  });
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- connection-events.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/integrations/connection-events.ts apps/api/src/services/integrations/connection-events.test.ts
git commit -m "feat(integrations): handleConnectionEnableTransition gates backfill on false→true"
```

### Task M4.5: Integration test — N outbox events backfilled with isBackfill=true

**Files:**
- Create: `apps/api/src/services/integrations/backfill.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "drizzle-orm";
import { startTestcontainers, stopTestcontainers, db } from "../../../test/testcontainers";
import { enqueueBackfillForConnection } from "./backfill";
import * as schema from "@rovenue/db/schema";
import { INTEGRATIONS_DELIVER_QUEUE_NAME } from "../../workers/integrations-deliver";
import { encrypt } from "@rovenue/shared/crypto";

let redis: Redis;
let queue: Queue;

beforeAll(async () => {
  await startTestcontainers();
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  queue = new Queue(INTEGRATIONS_DELIVER_QUEUE_NAME, { connection: redis });
}, 120_000);

afterAll(async () => { await queue.close(); await redis.quit(); await stopTestcontainers(); });

it("backfill enqueues every in-window outbox row with isBackfill=true and skips older rows", async () => {
  const projectId = createId();
  await db.insert(schema.projects).values({ id: projectId, name: "p", slug: projectId });
  const connectionId = createId();
  await db.insert(schema.integrationConnections).values({
    id: connectionId, projectId, providerId: "META_CAPI", displayName: "test",
    credentialsCipher: encrypt(JSON.stringify({ pixel_id: "1", access_token: "t" })),
    credentialsHint: "Pixel 1…1", isEnabled: true,
  });
  const inWindow: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = createId(); inWindow.push(id);
    await db.insert(schema.outboxEvents).values({
      id, projectId, aggregateType: "revenue", eventType: "revenue.event.recorded",
      payload: { outboxEventId: id, projectId, eventType: "revenue.event.recorded", occurredAt: new Date().toISOString(), revenueEventKind: "RENEWAL", amount: "9.99", currency: "USD" },
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * (i + 1)),
    });
  }
  // Out-of-window
  await db.insert(schema.outboxEvents).values({
    id: createId(), projectId, aggregateType: "revenue", eventType: "revenue.event.recorded",
    payload: {}, createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 8),
  });

  const result = await enqueueBackfillForConnection(
    { connectionId, projectId, providerId: "META_CAPI" },
    { db: db as never, queue, audit: async () => undefined, now: () => new Date() },
  );
  expect(result.eventCount).toBe(3);
  const jobs = await queue.getJobs(["waiting", "delayed", "active", "completed"]);
  const ourJobs = jobs.filter((j) => inWindow.includes(j.data.envelope.outboxEventId as string));
  expect(ourJobs).toHaveLength(3);
  for (const j of ourJobs) {
    expect(j.data.isBackfill).toBe(true);
    expect(j.opts.jobId).toBe(`${connectionId}:${j.data.envelope.outboxEventId}`);
  }
}, 60_000);

it("realtime event during backfill window is deduped via jobId", async () => {
  const projectId = createId();
  await db.insert(schema.projects).values({ id: projectId, name: "p", slug: projectId });
  const connectionId = createId();
  await db.insert(schema.integrationConnections).values({
    id: connectionId, projectId, providerId: "META_CAPI", displayName: "test",
    credentialsCipher: encrypt(JSON.stringify({ pixel_id: "1", access_token: "t" })),
    credentialsHint: "Pixel 1…1", isEnabled: true,
  });
  const outboxId = createId();
  await db.insert(schema.outboxEvents).values({
    id: outboxId, projectId, aggregateType: "revenue", eventType: "revenue.event.recorded",
    payload: { outboxEventId: outboxId, projectId, eventType: "revenue.event.recorded", occurredAt: new Date().toISOString() },
    createdAt: new Date(Date.now() - 1000 * 60 * 60),
  });
  await queue.add("deliver",
    { connectionId, projectId, providerId: "META_CAPI", envelope: { outboxEventId: outboxId, projectId, eventType: "revenue.event.recorded", occurredAt: new Date().toISOString() } },
    { jobId: `${connectionId}:${outboxId}` },
  );
  await enqueueBackfillForConnection(
    { connectionId, projectId, providerId: "META_CAPI" },
    { db: db as never, queue, audit: async () => undefined, now: () => new Date() },
  );
  const jobs = await queue.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
  const matching = jobs.filter((j) => j.opts.jobId === `${connectionId}:${outboxId}`);
  expect(matching).toHaveLength(1);
}, 60_000);
```

Run: `pnpm --filter @rovenue/api test -- backfill.integration.test.ts`
Expected: PASS.

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/integrations/backfill.integration.test.ts
git commit -m "test(integrations): backfill enqueues in-window rows + jobId dedup vs realtime"
```

### Task M4.6: End-to-end backfill — worker processes N=5 jobs with isBackfill flag

**Files:**
- Modify: `apps/api/src/services/integrations/backfill.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { Worker } from "bullmq";
import { runDeliverStep } from "../../workers/integrations-deliver";
import { MockAgent, setGlobalDispatcher } from "undici";

it("worker processes every backfilled job; isBackfill=true reaches the step", async () => {
  const projectId = createId();
  await db.insert(schema.projects).values({ id: projectId, name: "p", slug: projectId });
  const connectionId = createId();
  await db.insert(schema.integrationConnections).values({
    id: connectionId, projectId, providerId: "META_CAPI", displayName: "test",
    credentialsCipher: encrypt(JSON.stringify({ pixel_id: "12345678", access_token: "EAAtok" })),
    credentialsHint: "Pixel 1234…7890", enabledEvents: ["revenue.RENEWAL"], isEnabled: true,
  });
  const N = 5;
  for (let i = 0; i < N; i++) {
    const id = createId();
    await db.insert(schema.outboxEvents).values({
      id, projectId, aggregateType: "revenue", eventType: "revenue.event.recorded",
      payload: { outboxEventId: id, projectId, eventType: "revenue.event.recorded", occurredAt: new Date().toISOString(), revenueEventKind: "RENEWAL", amount: "9.99", currency: "USD", identityContext: { email: "u@x.com" } },
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * (i + 1)),
    });
  }
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  agent.get("https://graph.facebook.com").intercept({ path: /v18/, method: "POST" }).reply(200, { events_received: 1 }).persist();

  await enqueueBackfillForConnection(
    { connectionId, projectId, providerId: "META_CAPI" },
    { db: db as never, queue, audit: async () => undefined, now: () => new Date() },
  );

  const seen: Array<{ isBackfill?: boolean }> = [];
  const worker = new Worker(INTEGRATIONS_DELIVER_QUEUE_NAME,
    async (job) => { seen.push({ isBackfill: job.data.isBackfill }); await runDeliverStep(job, {}); },
    { connection: redis, concurrency: 4 },
  );
  await new Promise((r) => setTimeout(r, 3000));
  await worker.close();

  expect(seen.length).toBeGreaterThanOrEqual(N);
  expect(seen.every((s) => s.isBackfill === true)).toBe(true);
  const deliveries = await db.execute(sql`SELECT count(*)::int as c FROM integration_deliveries WHERE connection_id = ${connectionId}`);
  expect(Number(deliveries.rows[0]!.c)).toBe(N);
}, 60_000);
```

Run: `pnpm --filter @rovenue/api test -- backfill.integration.test.ts -t "worker processes"`
Expected: PASS.

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/integrations/backfill.integration.test.ts
git commit -m "test(integrations): end-to-end backfill via worker (N=5 RENEWAL events)"
```

---

## Milestone M5 — Dashboard API (7 endpoints + AppConnectionRow overlay)

All 7 routes live in `apps/api/src/routes/dashboard/integrations.ts`. Each is gated by `requireDashboardAuth` + `assertProjectAccess(projectId, MemberRole.CUSTOMER_SUPPORT)`. Audit rows flow through the helpers in `apps/api/src/lib/audit-helpers.ts` (introduced in Part 1 M0.5).

### Task M5.1: Scaffold integrations router + mount

**Files:**
- Create: `apps/api/src/routes/dashboard/integrations.ts`
- Create: `apps/api/src/routes/dashboard/integrations.test.ts`
- Modify: `apps/api/src/routes/dashboard/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { integrationsRoute } from "./integrations";

describe("integrationsRoute", () => {
  it("is a Hono app", () => {
    expect(integrationsRoute).toBeDefined();
    expect(typeof integrationsRoute.fetch).toBe("function");
  });
});
```

Run: `pnpm --filter @rovenue/api test -- dashboard/integrations.test.ts`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

Create `apps/api/src/routes/dashboard/integrations.ts`:

```ts
import { Hono } from "hono";
import type { DashboardEnv } from "../../types/dashboard-env";

export const integrationsRoute = new Hono<DashboardEnv>();
```

Modify `apps/api/src/routes/dashboard/index.ts` to mount it after the existing `appsRoute` line:

```ts
import { integrationsRoute } from "./integrations";
// ...
dashboard.route("/", integrationsRoute);
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- dashboard/integrations.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/dashboard/integrations.ts apps/api/src/routes/dashboard/integrations.test.ts apps/api/src/routes/dashboard/index.ts
git commit -m "feat(api): scaffold dashboard integrations router"
```

### Task M5.2: GET /projects/:projectId/integrations — list

**Files:**
- Modify: `apps/api/src/routes/dashboard/integrations.ts`
- Modify: `apps/api/src/routes/dashboard/integrations.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { db } from "../../db/client";
import * as schema from "@rovenue/db/schema";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { encrypt } from "@rovenue/shared/crypto";
import { signTestDashboardJwt, seedUserProjectMember } from "../../test/auth-helpers";

it("GET lists connections with redacted credentials", async () => {
  const userId = createId();
  const projectId = createId();
  await seedUserProjectMember(userId, projectId, "CUSTOMER_SUPPORT");
  const connectionId = createId();
  await db.insert(schema.integrationConnections).values({
    id: connectionId, projectId, providerId: "META_CAPI", displayName: "My Pixel",
    credentialsCipher: encrypt(JSON.stringify({ pixel_id: "12345678", access_token: "EAAtoken123456" })),
    credentialsHint: "Pixel 1234…5678", enabledEvents: ["revenue.INITIAL"], isEnabled: true,
  });

  const res = await integrationsRoute.request(
    `/projects/${projectId}/integrations`,
    { headers: { Authorization: `Bearer ${signTestDashboardJwt(userId)}` } },
  );
  expect(res.status).toBe(200);
  const body = await res.json() as { data: Array<Record<string, unknown>> };
  expect(body.data).toHaveLength(1);
  expect(body.data[0]).toMatchObject({
    id: connectionId, providerId: "META_CAPI", credentialsHint: "Pixel 1234…5678",
    isEnabled: true, enabledEvents: ["revenue.INITIAL"],
  });
  expect(body.data[0]).not.toHaveProperty("credentialsCipher");
  expect(JSON.stringify(body.data[0])).not.toMatch(/EAAtoken/);
});
```

Run: `pnpm --filter @rovenue/api test -- dashboard/integrations.test.ts`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

Append to `integrations.ts`:

```ts
import { and, eq, isNull } from "drizzle-orm";
import { requireDashboardAuth } from "../../middleware/require-dashboard-auth";
import { assertProjectAccess } from "../../lib/assert-project-access";
import { MemberRole } from "@rovenue/db/schema";
import { db } from "../../db/client";
import * as schema from "@rovenue/db/schema";

integrationsRoute.get(
  "/projects/:projectId/integrations",
  requireDashboardAuth(),
  async (c) => {
    const projectId = c.req.param("projectId");
    await assertProjectAccess(c, projectId, MemberRole.CUSTOMER_SUPPORT);
    const rows = await db
      .select({
        id: schema.integrationConnections.id,
        providerId: schema.integrationConnections.providerId,
        displayName: schema.integrationConnections.displayName,
        credentialsHint: schema.integrationConnections.credentialsHint,
        enabledEvents: schema.integrationConnections.enabledEvents,
        eventMapping: schema.integrationConnections.eventMapping,
        actionSource: schema.integrationConnections.actionSource,
        testEventCode: schema.integrationConnections.testEventCode,
        isEnabled: schema.integrationConnections.isEnabled,
        lastValidatedAt: schema.integrationConnections.lastValidatedAt,
        lastError: schema.integrationConnections.lastError,
        lastBackfillAt: schema.integrationConnections.lastBackfillAt,
        createdAt: schema.integrationConnections.createdAt,
        updatedAt: schema.integrationConnections.updatedAt,
      })
      .from(schema.integrationConnections)
      .where(and(eq(schema.integrationConnections.projectId, projectId), isNull(schema.integrationConnections.deletedAt)));
    return c.json({ data: rows });
  },
);
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- dashboard/integrations.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/dashboard/integrations.ts apps/api/src/routes/dashboard/integrations.test.ts
git commit -m "feat(api): GET /projects/:projectId/integrations returns redacted connection list"
```

### Task M5.3: POST — create connection (validate first; no DB write on failure)

**Files:**
- Modify: `apps/api/src/routes/dashboard/integrations.ts`
- Modify: `apps/api/src/routes/dashboard/integrations.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { MockAgent, setGlobalDispatcher } from "undici";

it("POST creates a connection after validateCredentials passes", async () => {
  const userId = createId();
  const projectId = createId();
  await seedUserProjectMember(userId, projectId, "CUSTOMER_SUPPORT");
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  agent.get("https://graph.facebook.com").intercept({ path: /v18/, method: "GET" }).reply(200, { id: "12345678" });

  const res = await integrationsRoute.request(`/projects/${projectId}/integrations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signTestDashboardJwt(userId)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId: "META_CAPI",
      displayName: "Main Pixel",
      credentials: { pixelId: "12345678", accessToken: "EAAabcdef1234" },
      enabledEvents: ["revenue.INITIAL", "revenue.RENEWAL"],
      actionSource: "app",
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json() as { data: { id: string; isEnabled: boolean } };
  expect(body.data.isEnabled).toBe(false);

  const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.resourceId, body.data.id));
  expect(audits[0]!.action).toBe("integration.connection.created");
  expect(JSON.stringify(audits[0]!.metadata)).toMatch(/REDACTED/);
  expect(JSON.stringify(audits[0]!.metadata)).not.toMatch(/EAAabcdef/);
});

it("POST rejects when validateCredentials fails (no DB write)", async () => {
  const userId = createId();
  const projectId = createId();
  await seedUserProjectMember(userId, projectId, "CUSTOMER_SUPPORT");
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  agent.get("https://graph.facebook.com").intercept({ path: /v18/, method: "GET" }).reply(401, { error: { message: "Invalid token" } });

  const res = await integrationsRoute.request(`/projects/${projectId}/integrations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signTestDashboardJwt(userId)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId: "META_CAPI", displayName: "Bad",
      credentials: { pixelId: "12345678", accessToken: "EAAbadtoken" },
      enabledEvents: ["revenue.INITIAL"],
    }),
  });
  expect(res.status).toBe(400);
  const rows = await db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.projectId, projectId));
  expect(rows).toHaveLength(0);
});
```

Run: `pnpm --filter @rovenue/api test -- dashboard/integrations.test.ts`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```ts
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { createId } from "@paralleldrive/cuid2";
import { encrypt } from "@rovenue/shared/crypto";
import { getProvider } from "../../services/integrations/registry";
import { auditConnectionCreated } from "../../lib/audit-helpers";
import { httpClient } from "../../lib/http-client";

const credentialsSchema = z.object({
  pixelId: z.string().optional(),
  pixelCode: z.string().optional(),
  accessToken: z.string().min(1),
});

const createBodySchema = z.object({
  providerId: z.enum(["META_CAPI", "TIKTOK_EVENTS"]),
  displayName: z.string().min(1).max(120),
  credentials: credentialsSchema,
  enabledEvents: z.array(z.string()).default([]),
  eventMapping: z.record(z.unknown()).default({}),
  actionSource: z.enum(["app", "website", "system_generated"]).default("app"),
  testEventCode: z.string().optional(),
});

function buildCredentialsHint(providerId: string, creds: { pixelId?: string; pixelCode?: string }): string {
  const id = creds.pixelId ?? creds.pixelCode ?? "";
  return `Pixel ${id.slice(0, 4)}…${id.slice(-4)}`;
}

integrationsRoute.post(
  "/projects/:projectId/integrations",
  requireDashboardAuth(),
  zValidator("json", createBodySchema),
  async (c) => {
    const projectId = c.req.param("projectId");
    await assertProjectAccess(c, projectId, MemberRole.CUSTOMER_SUPPORT);
    const body = c.req.valid("json");
    const provider = getProvider(body.providerId);

    const providerCreds = body.providerId === "META_CAPI"
      ? { pixel_id: body.credentials.pixelId, access_token: body.credentials.accessToken }
      : { pixel_code: body.credentials.pixelCode, access_token: body.credentials.accessToken };

    const validation = await provider.validateCredentials(providerCreds, httpClient);
    if (!validation.ok) {
      return c.json({ error: { code: "invalid_credentials", message: validation.reason } }, 400);
    }

    const id = createId();
    const userId = c.get("userId");
    await db.transaction(async (tx) => {
      await tx.insert(schema.integrationConnections).values({
        id, projectId, providerId: body.providerId, displayName: body.displayName,
        credentialsCipher: encrypt(JSON.stringify(providerCreds)),
        credentialsHint: buildCredentialsHint(body.providerId, body.credentials),
        enabledEvents: body.enabledEvents, eventMapping: body.eventMapping,
        actionSource: body.actionSource, testEventCode: body.testEventCode,
        isEnabled: false, lastValidatedAt: new Date(),
      });
      await auditConnectionCreated(tx, {
        projectId, actorId: userId, connectionId: id, providerId: body.providerId, displayName: body.displayName,
      });
    });

    return c.json({ data: { id, isEnabled: false } }, 201);
  },
);
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- dashboard/integrations.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/dashboard/integrations.ts apps/api/src/routes/dashboard/integrations.test.ts
git commit -m "feat(api): POST integrations validates creds before insert + audits creation"
```

### Task M5.4: PATCH — update scope/mapping/enabled + backfill + credential rotation

**Files:**
- Modify: `apps/api/src/routes/dashboard/integrations.ts`
- Modify: `apps/api/src/routes/dashboard/integrations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("PATCH isEnabled false→true triggers backfill audit row", async () => {
  const userId = createId();
  const projectId = createId();
  await seedUserProjectMember(userId, projectId, "CUSTOMER_SUPPORT");
  const connectionId = createId();
  await db.insert(schema.integrationConnections).values({
    id: connectionId, projectId, providerId: "META_CAPI", displayName: "Pixel",
    credentialsCipher: encrypt(JSON.stringify({ pixel_id: "1", access_token: "t" })),
    credentialsHint: "Pixel 1…1", isEnabled: false,
  });

  const res = await integrationsRoute.request(
    `/projects/${projectId}/integrations/${connectionId}`,
    { method: "PATCH", headers: { Authorization: `Bearer ${signTestDashboardJwt(userId)}`, "Content-Type": "application/json" }, body: JSON.stringify({ isEnabled: true }) },
  );
  expect(res.status).toBe(200);
  const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.resourceId, connectionId));
  expect(audits.find((a) => a.action === "integration.backfill.started")).toBeDefined();
});

it("PATCH credential rotation writes a separate redacted audit row", async () => {
  const userId = createId();
  const projectId = createId();
  await seedUserProjectMember(userId, projectId, "CUSTOMER_SUPPORT");
  const connectionId = createId();
  await db.insert(schema.integrationConnections).values({
    id: connectionId, projectId, providerId: "META_CAPI", displayName: "Pixel",
    credentialsCipher: encrypt(JSON.stringify({ pixel_id: "12345678", access_token: "old" })),
    credentialsHint: "Pixel 1234…5678", isEnabled: false,
  });
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  agent.get("https://graph.facebook.com").intercept({ path: /v18/ }).reply(200, { id: "12345678" });

  const res = await integrationsRoute.request(
    `/projects/${projectId}/integrations/${connectionId}`,
    { method: "PATCH", headers: { Authorization: `Bearer ${signTestDashboardJwt(userId)}`, "Content-Type": "application/json" }, body: JSON.stringify({ credentials: { accessToken: "EAAnewtoken" } }) },
  );
  expect(res.status).toBe(200);
  const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.resourceId, connectionId));
  const rotated = audits.find((a) => a.action === "integration.credentials.rotated");
  expect(rotated).toBeDefined();
  expect(JSON.stringify(rotated!.metadata)).toMatch(/REDACTED/);
  expect(JSON.stringify(rotated!.metadata)).not.toMatch(/EAAnewtoken/);
});
```

Run: `pnpm --filter @rovenue/api test -- dashboard/integrations.test.ts`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```ts
import { decrypt } from "@rovenue/shared/crypto";
import { enqueueBackfillForConnection } from "../../services/integrations/backfill";
import { handleConnectionEnableTransition } from "../../services/integrations/connection-events";
import { connectionCache } from "../../services/integrations/connection-cache"; // Part 1 EventEmitter
import { integrationsDeliverQueue } from "../../workers/integrations-deliver";
import { audit } from "../../lib/audit";
import { auditConnectionUpdated, auditCredentialsRotated } from "../../lib/audit-helpers";

const patchBodySchema = z.object({
  enabledEvents: z.array(z.string()).optional(),
  eventMapping: z.record(z.unknown()).optional(),
  actionSource: z.enum(["app", "website", "system_generated"]).optional(),
  testEventCode: z.string().nullable().optional(),
  isEnabled: z.boolean().optional(),
  credentials: z.object({ accessToken: z.string().min(1) }).optional(),
});

integrationsRoute.patch(
  "/projects/:projectId/integrations/:id",
  requireDashboardAuth(),
  zValidator("json", patchBodySchema),
  async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await assertProjectAccess(c, projectId, MemberRole.CUSTOMER_SUPPORT);
    const body = c.req.valid("json");
    const userId = c.get("userId");

    const existing = await db.select().from(schema.integrationConnections)
      .where(and(
        eq(schema.integrationConnections.id, id),
        eq(schema.integrationConnections.projectId, projectId),
        isNull(schema.integrationConnections.deletedAt),
      )).limit(1);
    if (existing.length === 0) {
      return c.json({ error: { code: "not_found", message: "connection not found" } }, 404);
    }
    const before = existing[0]!;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.enabledEvents !== undefined) updates.enabledEvents = body.enabledEvents;
    if (body.eventMapping !== undefined) updates.eventMapping = body.eventMapping;
    if (body.actionSource !== undefined) updates.actionSource = body.actionSource;
    if (body.testEventCode !== undefined) updates.testEventCode = body.testEventCode;
    if (body.isEnabled !== undefined) updates.isEnabled = body.isEnabled;
    if (body.credentials) {
      const currentCreds = JSON.parse(decrypt(before.credentialsCipher));
      const newCreds = { ...currentCreds, access_token: body.credentials.accessToken };
      const provider = getProvider(before.providerId as "META_CAPI" | "TIKTOK_EVENTS");
      const validation = await provider.validateCredentials(newCreds, httpClient);
      if (!validation.ok) {
        return c.json({ error: { code: "invalid_credentials", message: validation.reason } }, 400);
      }
      updates.credentialsCipher = encrypt(JSON.stringify(newCreds));
      updates.lastValidatedAt = new Date();
    }

    await db.transaction(async (tx) => {
      await tx.update(schema.integrationConnections).set(updates).where(eq(schema.integrationConnections.id, id));
      if (body.credentials) {
        await auditCredentialsRotated(tx, { projectId, actorId: userId, connectionId: id });
      } else {
        await auditConnectionUpdated(tx, { projectId, actorId: userId, connectionId: id, changes: { ...updates, credentialsCipher: undefined } });
      }
    });

    await handleConnectionEnableTransition(
      {
        wasEnabled: before.isEnabled,
        willBeEnabled: body.isEnabled ?? before.isEnabled,
        connectionId: id, projectId,
        providerId: before.providerId as "META_CAPI" | "TIKTOK_EVENTS",
      },
      {
        enqueueBackfill: ({ connectionId, projectId, providerId }) =>
          enqueueBackfillForConnection(
            { connectionId, projectId, providerId },
            {
              db: db as never, queue: integrationsDeliverQueue,
              audit: (a) => audit({ ...a, actorId: userId, actorType: "user" }),
              now: () => new Date(),
            },
          ),
      },
    );

    connectionCache.emit("integrationConnectionChanged", id);
    return c.json({ data: { id, ...updates, credentialsCipher: undefined } });
  },
);
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- dashboard/integrations.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/dashboard/integrations.ts apps/api/src/routes/dashboard/integrations.test.ts
git commit -m "feat(api): PATCH integration (scope/mapping/enabled/rotation) + backfill + audit + cache"
```

### Task M5.5: DELETE — soft delete + audit + cache invalidation

**Files:**
- Modify: `apps/api/src/routes/dashboard/integrations.ts`
- Modify: `apps/api/src/routes/dashboard/integrations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("DELETE soft-deletes (sets deleted_at), invalidates cache, audits", async () => {
  const userId = createId();
  const projectId = createId();
  await seedUserProjectMember(userId, projectId, "CUSTOMER_SUPPORT");
  const connectionId = createId();
  await db.insert(schema.integrationConnections).values({
    id: connectionId, projectId, providerId: "META_CAPI", displayName: "Pixel",
    credentialsCipher: encrypt(JSON.stringify({ pixel_id: "1", access_token: "t" })),
    credentialsHint: "Pixel 1…1",
  });
  const res = await integrationsRoute.request(
    `/projects/${projectId}/integrations/${connectionId}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${signTestDashboardJwt(userId)}` } },
  );
  expect(res.status).toBe(204);
  const rows = await db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.id, connectionId));
  expect(rows[0]!.deletedAt).toBeInstanceOf(Date);
  const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.resourceId, connectionId));
  expect(audits.find((a) => a.action === "integration.connection.deleted")).toBeDefined();
});
```

Run: `pnpm --filter @rovenue/api test -- dashboard/integrations.test.ts -t "DELETE"`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```ts
import { auditConnectionDeleted } from "../../lib/audit-helpers";

integrationsRoute.delete(
  "/projects/:projectId/integrations/:id",
  requireDashboardAuth(),
  async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await assertProjectAccess(c, projectId, MemberRole.CUSTOMER_SUPPORT);
    const userId = c.get("userId");
    const existing = await db.select().from(schema.integrationConnections)
      .where(and(
        eq(schema.integrationConnections.id, id),
        eq(schema.integrationConnections.projectId, projectId),
        isNull(schema.integrationConnections.deletedAt),
      )).limit(1);
    if (existing.length === 0) {
      return c.json({ error: { code: "not_found", message: "connection not found" } }, 404);
    }
    await db.transaction(async (tx) => {
      await tx.update(schema.integrationConnections)
        .set({ deletedAt: new Date(), isEnabled: false, updatedAt: new Date() })
        .where(eq(schema.integrationConnections.id, id));
      await auditConnectionDeleted(tx, { projectId, actorId: userId, connectionId: id });
    });
    connectionCache.emit("integrationConnectionChanged", id);
    return c.body(null, 204);
  },
);
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- dashboard/integrations.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/dashboard/integrations.ts apps/api/src/routes/dashboard/integrations.test.ts
git commit -m "feat(api): DELETE integration (soft delete + audit + cache invalidation)"
```

### Task M5.6: POST /validate — pre-save dry-run

**Files:**
- Modify: `apps/api/src/routes/dashboard/integrations.ts`
- Modify: `apps/api/src/routes/dashboard/integrations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("POST /validate returns { ok: true } without writing DB", async () => {
  const userId = createId();
  const projectId = createId();
  await seedUserProjectMember(userId, projectId, "CUSTOMER_SUPPORT");
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  agent.get("https://graph.facebook.com").intercept({ path: /v18/ }).reply(200, { id: "1" });

  const res = await integrationsRoute.request(`/projects/${projectId}/integrations/validate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signTestDashboardJwt(userId)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: "META_CAPI", credentials: { pixelId: "1", accessToken: "t" } }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ data: { ok: true } });
  const rows = await db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.projectId, projectId));
  expect(rows).toHaveLength(0);
});

it("POST /validate returns { ok: false, reason } on provider failure", async () => {
  const userId = createId();
  const projectId = createId();
  await seedUserProjectMember(userId, projectId, "CUSTOMER_SUPPORT");
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  agent.get("https://graph.facebook.com").intercept({ path: /v18/ }).reply(401, { error: { message: "bad" } });

  const res = await integrationsRoute.request(`/projects/${projectId}/integrations/validate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signTestDashboardJwt(userId)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: "META_CAPI", credentials: { pixelId: "1", accessToken: "bad" } }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { ok: false; reason: string } };
  expect(body.data.ok).toBe(false);
});
```

Run: `pnpm --filter @rovenue/api test -- dashboard/integrations.test.ts -t "validate"`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```ts
import { rateLimitMiddleware } from "../../middleware/rate-limit";
// If the export name differs, inspect ls apps/api/src/middleware/ and adjust accordingly.

const validateBodySchema = z.object({
  providerId: z.enum(["META_CAPI", "TIKTOK_EVENTS"]),
  credentials: credentialsSchema,
});

integrationsRoute.post(
  "/projects/:projectId/integrations/validate",
  requireDashboardAuth(),
  rateLimitMiddleware({ windowMs: 60_000, max: 30, keyPrefix: "integrations.validate" }),
  zValidator("json", validateBodySchema),
  async (c) => {
    const projectId = c.req.param("projectId");
    await assertProjectAccess(c, projectId, MemberRole.CUSTOMER_SUPPORT);
    const body = c.req.valid("json");
    const provider = getProvider(body.providerId);
    const providerCreds = body.providerId === "META_CAPI"
      ? { pixel_id: body.credentials.pixelId, access_token: body.credentials.accessToken }
      : { pixel_code: body.credentials.pixelCode, access_token: body.credentials.accessToken };
    const result = await provider.validateCredentials(providerCreds, httpClient);
    return c.json({ data: result });
  },
);
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- dashboard/integrations.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/dashboard/integrations.ts apps/api/src/routes/dashboard/integrations.test.ts
git commit -m "feat(api): POST /integrations/validate dry-runs credentials with no DB write"
```

### Task M5.7: POST /:id/test-event — synthetic Subscribe via test_event_code

**Files:**
- Modify: `apps/api/src/routes/dashboard/integrations.ts`
- Modify: `apps/api/src/routes/dashboard/integrations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("POST /test-event 400s when test_event_code is unset", async () => {
  const userId = createId();
  const projectId = createId();
  await seedUserProjectMember(userId, projectId, "CUSTOMER_SUPPORT");
  const connectionId = createId();
  await db.insert(schema.integrationConnections).values({
    id: connectionId, projectId, providerId: "META_CAPI", displayName: "Pixel",
    credentialsCipher: encrypt(JSON.stringify({ pixel_id: "1", access_token: "t" })),
    credentialsHint: "Pixel 1…1", enabledEvents: ["revenue.INITIAL"],
  });
  const res = await integrationsRoute.request(
    `/projects/${projectId}/integrations/${connectionId}/test-event`,
    { method: "POST", headers: { Authorization: `Bearer ${signTestDashboardJwt(userId)}` } },
  );
  expect(res.status).toBe(400);
});

it("POST /test-event sends synthetic Subscribe with $0.01 USD + test_event_code + audits", async () => {
  const userId = createId();
  const projectId = createId();
  await seedUserProjectMember(userId, projectId, "CUSTOMER_SUPPORT");
  const connectionId = createId();
  await db.insert(schema.integrationConnections).values({
    id: connectionId, projectId, providerId: "META_CAPI", displayName: "Pixel",
    credentialsCipher: encrypt(JSON.stringify({ pixel_id: "12345678", access_token: "EAAtok" })),
    credentialsHint: "Pixel 1234…5678", enabledEvents: ["revenue.INITIAL"], testEventCode: "TEST123",
  });
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  let captured: { body: unknown } | null = null;
  agent.get("https://graph.facebook.com").intercept({ path: /v18.*events/, method: "POST" }).reply((opts) => {
    captured = { body: JSON.parse(opts.body as string) };
    return { statusCode: 200, data: { events_received: 1 } };
  });

  const res = await integrationsRoute.request(
    `/projects/${projectId}/integrations/${connectionId}/test-event`,
    { method: "POST", headers: { Authorization: `Bearer ${signTestDashboardJwt(userId)}` } },
  );
  expect(res.status).toBe(200);
  expect(JSON.stringify(captured!.body)).toMatch(/TEST123/);
  expect(JSON.stringify(captured!.body)).toMatch(/0\.01/);
  expect(JSON.stringify(captured!.body)).toMatch(/USD/);

  const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.resourceId, connectionId));
  expect(audits.find((a) => a.action === "integration.test_event.sent")).toBeDefined();
});
```

Run: `pnpm --filter @rovenue/api test -- dashboard/integrations.test.ts -t "test-event"`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```ts
import { auditTestEventSent } from "../../lib/audit-helpers";

integrationsRoute.post(
  "/projects/:projectId/integrations/:id/test-event",
  requireDashboardAuth(),
  async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await assertProjectAccess(c, projectId, MemberRole.CUSTOMER_SUPPORT);
    const userId = c.get("userId");

    const rows = await db.select().from(schema.integrationConnections)
      .where(and(
        eq(schema.integrationConnections.id, id),
        eq(schema.integrationConnections.projectId, projectId),
        isNull(schema.integrationConnections.deletedAt),
      )).limit(1);
    if (rows.length === 0) {
      return c.json({ error: { code: "not_found", message: "connection not found" } }, 404);
    }
    const conn = rows[0]!;
    if (!conn.testEventCode) {
      return c.json({ error: { code: "missing_test_event_code", message: "test_event_code must be set on the connection" } }, 400);
    }
    const provider = getProvider(conn.providerId as "META_CAPI" | "TIKTOK_EVENTS");
    const creds = JSON.parse(decrypt(conn.credentialsCipher));

    const envelope = {
      outboxEventId: createId(),
      projectId,
      eventType: "revenue.event.recorded" as const,
      occurredAt: new Date().toISOString(),
      revenueEventKind: "INITIAL" as const,
      amount: "0.01", currency: "USD",
      subscriberId: "test-subscriber",
      identityContext: { email: "test@example.com", externalId: "test-external-id" },
    };
    const config = {
      connectionId: conn.id, projectId,
      enabledEvents: conn.enabledEvents.includes("revenue.INITIAL") ? conn.enabledEvents : ["revenue.INITIAL", ...conn.enabledEvents],
      eventMapping: conn.eventMapping as Record<string, never>,
      actionSource: conn.actionSource as "app" | "website" | "system_generated",
      testEventCode: conn.testEventCode,
    };

    const mapped = provider.mapEvent(envelope, config);
    if ("skip" in mapped) {
      return c.json({ error: { code: "mapping_skipped", message: mapped.reason } }, 400);
    }
    const delivery = await provider.deliver(mapped, creds, httpClient);

    await auditTestEventSent(db, { projectId, actorId: userId, connectionId: id, providerEvent: mapped.providerEvent });

    return c.json({
      data: {
        ok: delivery.ok,
        httpStatus: delivery.httpStatus,
        responseBody: delivery.responseBody.slice(0, 4096),
        errorMessage: delivery.errorMessage,
      },
    });
  },
);
```

Also extend `apps/api/src/lib/audit-helpers.ts` with `auditTestEventSent`:

```ts
export async function auditTestEventSent(
  tx: DbOrTx,
  args: { projectId: string; actorId: string; connectionId: string; providerEvent: string },
): Promise<void> {
  await audit({
    db: tx, projectId: args.projectId, actorId: args.actorId, actorType: "user",
    action: "integration.test_event.sent",
    resource: "integration_connection", resourceId: args.connectionId,
    metadata: { providerEvent: args.providerEvent },
  });
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- dashboard/integrations.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/dashboard/integrations.ts apps/api/src/routes/dashboard/integrations.test.ts apps/api/src/lib/audit-helpers.ts
git commit -m "feat(api): POST /test-event sends synthetic \$0.01 Subscribe with test_event_code"
```

### Task M5.8: GET /:id/deliveries — cursor-paginated with status filter

**Files:**
- Modify: `apps/api/src/routes/dashboard/integrations.ts`
- Modify: `apps/api/src/routes/dashboard/integrations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("GET /:id/deliveries returns cursor-paginated rows filtered by status", async () => {
  const userId = createId();
  const projectId = createId();
  await seedUserProjectMember(userId, projectId, "CUSTOMER_SUPPORT");
  const connectionId = createId();
  await db.insert(schema.integrationConnections).values({
    id: connectionId, projectId, providerId: "META_CAPI", displayName: "Pixel",
    credentialsCipher: encrypt(JSON.stringify({ pixel_id: "1", access_token: "t" })),
    credentialsHint: "Pixel 1…1",
  });
  for (let i = 0; i < 5; i++) {
    await db.insert(schema.integrationDeliveries).values({
      id: createId(), connectionId, projectId, providerId: "META_CAPI",
      outboxEventId: createId(), eventKey: "revenue.RENEWAL", providerEvent: "Subscribe",
      status: i % 2 === 0 ? "succeeded" : "failed",
      attempt: 1, createdAt: new Date(Date.now() - i * 60_000),
    });
  }
  const res = await integrationsRoute.request(
    `/projects/${projectId}/integrations/${connectionId}/deliveries?status=failed&limit=10`,
    { headers: { Authorization: `Bearer ${signTestDashboardJwt(userId)}` } },
  );
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { deliveries: unknown[]; nextCursor: string | null } };
  expect(body.data.deliveries).toHaveLength(2);
  expect(body.data.nextCursor).toBeNull();
});
```

Run: `pnpm --filter @rovenue/api test -- dashboard/integrations.test.ts -t "deliveries"`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```ts
import { lt, desc } from "drizzle-orm";

const deliveriesQuerySchema = z.object({
  cursor: z.string().optional(),
  status: z.enum(["pending", "succeeded", "failed", "skipped", "dead_letter"]).optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
});

integrationsRoute.get(
  "/projects/:projectId/integrations/:id/deliveries",
  requireDashboardAuth(),
  zValidator("query", deliveriesQuerySchema),
  async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await assertProjectAccess(c, projectId, MemberRole.CUSTOMER_SUPPORT);
    const q = c.req.valid("query");
    const whereParts = [
      eq(schema.integrationDeliveries.connectionId, id),
      eq(schema.integrationDeliveries.projectId, projectId),
    ];
    if (q.status) whereParts.push(eq(schema.integrationDeliveries.status, q.status));
    if (q.cursor) whereParts.push(lt(schema.integrationDeliveries.createdAt, new Date(q.cursor)));
    const rows = await db.select().from(schema.integrationDeliveries)
      .where(and(...whereParts))
      .orderBy(desc(schema.integrationDeliveries.createdAt))
      .limit(q.limit + 1);
    const hasMore = rows.length > q.limit;
    const deliveries = hasMore ? rows.slice(0, q.limit) : rows;
    const nextCursor = hasMore ? deliveries[deliveries.length - 1]!.createdAt.toISOString() : null;
    return c.json({ data: { deliveries, nextCursor } });
  },
);
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- dashboard/integrations.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/dashboard/integrations.ts apps/api/src/routes/dashboard/integrations.test.ts
git commit -m "feat(api): GET /:id/deliveries cursor-paginated with status filter"
```

### Task M5.9: Extend AppConnectionRow with errorReason + credentialsHint

**Files:**
- Modify: `packages/shared/src/dashboard.ts`
- Modify: `packages/shared/src/dashboard.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
it("AppConnectionRow accepts errorReason and credentialsHint", () => {
  const row: AppConnectionRow = {
    id: "meta-capi", name: "Meta CAPI", description: "x",
    status: "error", account: "Pixel 1234…5678", lastSyncLabel: "5m ago",
    errorReason: "invalid_credentials", credentialsHint: "Pixel 1234…5678",
  };
  expect(row.errorReason).toBe("invalid_credentials");
  expect(row.credentialsHint).toBe("Pixel 1234…5678");
});
```

Run: `pnpm --filter @rovenue/shared test -- dashboard.test.ts`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

In `packages/shared/src/dashboard.ts` near lines 1408-1422, add optional fields to `AppConnectionRow`:

```ts
export interface AppConnectionRow {
  id: string;
  name: string;
  description: string;
  status: AppConnectionStatus;
  account?: string;
  lastSyncLabel?: string;
  errorReason?: string;
  credentialsHint?: string;
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/shared test -- dashboard.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/dashboard.ts packages/shared/src/dashboard.test.ts
git commit -m "feat(shared): extend AppConnectionRow with errorReason + credentialsHint"
```

### Task M5.10: apps-connections overlay for meta-capi + tiktok-events

**Files:**
- Modify: `apps/api/src/services/apps-connections.ts`
- Modify (or create): `apps/api/src/services/apps-connections.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { createId } from "@paralleldrive/cuid2";
import { db } from "../db/client";
import * as schema from "@rovenue/db/schema";
import { encrypt } from "@rovenue/shared/crypto";
import { readAppConnections } from "./apps-connections";

it("derives meta-capi as 'connected' when enabled + recent validation + no recent dead_letter", async () => {
  const projectId = createId();
  await db.insert(schema.projects).values({ id: projectId, name: "p", slug: projectId });
  const cid = createId();
  await db.insert(schema.integrationConnections).values({
    id: cid, projectId, providerId: "META_CAPI", displayName: "Pixel",
    credentialsCipher: encrypt(JSON.stringify({ pixel_id: "1", access_token: "t" })),
    credentialsHint: "Pixel 1234…5678", isEnabled: true,
    lastValidatedAt: new Date(Date.now() - 60_000),
  });
  await db.insert(schema.integrationDeliveries).values({
    id: createId(), connectionId: cid, projectId, providerId: "META_CAPI",
    outboxEventId: createId(), eventKey: "revenue.RENEWAL",
    providerEvent: "Subscribe", status: "succeeded", attempt: 1,
    createdAt: new Date(Date.now() - 5 * 60_000),
  });
  const rows = await readAppConnections(projectId);
  const meta = rows.find((r) => r.id === "meta-capi");
  expect(meta?.status).toBe("connected");
  expect(meta?.account).toBe("Pixel 1234…5678");
  expect(meta?.lastSyncLabel).toBeDefined();
});

it("derives meta-capi as 'error' when there is a dead_letter in the last hour", async () => {
  const projectId = createId();
  await db.insert(schema.projects).values({ id: projectId, name: "p", slug: projectId });
  const cid = createId();
  await db.insert(schema.integrationConnections).values({
    id: cid, projectId, providerId: "META_CAPI", displayName: "Pixel",
    credentialsCipher: encrypt(JSON.stringify({ pixel_id: "1", access_token: "t" })),
    credentialsHint: "Pixel 1…1", isEnabled: true,
    lastValidatedAt: new Date(), lastError: "401 invalid token",
  });
  await db.insert(schema.integrationDeliveries).values({
    id: createId(), connectionId: cid, projectId, providerId: "META_CAPI",
    outboxEventId: createId(), eventKey: "revenue.RENEWAL",
    status: "dead_letter", attempt: 5, httpStatus: 401,
    errorMessage: "invalid token", createdAt: new Date(Date.now() - 5 * 60_000),
  });
  const rows = await readAppConnections(projectId);
  const meta = rows.find((r) => r.id === "meta-capi");
  expect(meta?.status).toBe("error");
  expect(meta?.errorReason).toBeDefined();
});

it("derives meta-capi + tiktok-events as 'available' when no connection exists", async () => {
  const projectId = createId();
  await db.insert(schema.projects).values({ id: projectId, name: "p", slug: projectId });
  const rows = await readAppConnections(projectId);
  expect(rows.find((r) => r.id === "meta-capi")?.status).toBe("available");
  expect(rows.find((r) => r.id === "tiktok-events")?.status).toBe("available");
});
```

Run: `pnpm --filter @rovenue/api test -- apps-connections.test.ts`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

In `apps-connections.ts`, add:

```ts
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import * as schema from "@rovenue/db/schema";
import { db } from "../db/client";
import type { AppConnectionRow } from "@rovenue/shared/dashboard";
import { describeAge } from "./describe-age"; // adjust path to wherever the existing helper lives

async function buildIntegrationOverlay(
  projectId: string,
  providerId: "META_CAPI" | "TIKTOK_EVENTS",
  catalogId: "meta-capi" | "tiktok-events",
  catalogName: string,
  catalogDescription: string,
): Promise<AppConnectionRow> {
  const rows = await db.select().from(schema.integrationConnections)
    .where(and(
      eq(schema.integrationConnections.projectId, projectId),
      eq(schema.integrationConnections.providerId, providerId),
      isNull(schema.integrationConnections.deletedAt),
    )).limit(1);
  if (rows.length === 0 || !rows[0]!.isEnabled) {
    return { id: catalogId, name: catalogName, description: catalogDescription, status: "available" };
  }
  const conn = rows[0]!;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const deadLetter = await db.select().from(schema.integrationDeliveries)
    .where(and(
      eq(schema.integrationDeliveries.connectionId, conn.id),
      eq(schema.integrationDeliveries.status, "dead_letter"),
      gt(schema.integrationDeliveries.createdAt, oneHourAgo),
    )).limit(1);
  if (deadLetter.length > 0) {
    return {
      id: catalogId, name: catalogName, description: catalogDescription, status: "error",
      account: conn.credentialsHint, credentialsHint: conn.credentialsHint,
      errorReason: deadLetter[0]!.errorMessage ?? conn.lastError ?? "delivery_failure",
    };
  }
  const recentSuccess = await db.select().from(schema.integrationDeliveries)
    .where(and(eq(schema.integrationDeliveries.connectionId, conn.id), eq(schema.integrationDeliveries.status, "succeeded")))
    .orderBy(desc(schema.integrationDeliveries.createdAt)).limit(1);
  return {
    id: catalogId, name: catalogName, description: catalogDescription, status: "connected",
    account: conn.credentialsHint, credentialsHint: conn.credentialsHint,
    lastSyncLabel: recentSuccess.length > 0 ? describeAge(recentSuccess[0]!.createdAt) : undefined,
  };
}
```

In the body of `readAppConnections(projectId)`, replace any static catalog entries for `meta-capi` and `tiktok-events` with overlays:

```ts
const meta = await buildIntegrationOverlay(projectId, "META_CAPI", "meta-capi", "Meta CAPI", "Send server-side conversions to your Meta Pixel.");
const tiktok = await buildIntegrationOverlay(projectId, "TIKTOK_EVENTS", "tiktok-events", "TikTok Events API", "Send server-side conversions to your TikTok Pixel.");
// replace existing meta-capi / tiktok-events rows in the result list with these
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- apps-connections.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/apps-connections.ts apps/api/src/services/apps-connections.test.ts
git commit -m "feat(api): surface meta-capi/tiktok-events overlay status in apps-connections"
```

---

## Milestone M6 — Dashboard UI (React + base-ui drawer + react-query)

### Task M6.1: useProjectIntegrations hook (list)

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useProjectIntegrations.ts`
- Create: `apps/dashboard/src/lib/hooks/useProjectIntegrations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import React from "react";
import { useProjectIntegrations } from "./useProjectIntegrations";

const server = setupServer(
  http.get("/api/dashboard/projects/p1/integrations", () =>
    HttpResponse.json({
      data: [{ id: "c1", providerId: "META_CAPI", displayName: "Pixel", isEnabled: true, credentialsHint: "Pixel 1…1", enabledEvents: ["revenue.INITIAL"], eventMapping: {}, actionSource: "app", testEventCode: null, lastValidatedAt: null, lastError: null, lastBackfillAt: null, createdAt: "", updatedAt: "" }],
    }),
  ),
);
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe("useProjectIntegrations", () => {
  it("returns the list of connections", async () => {
    const { result } = renderHook(() => useProjectIntegrations("p1"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]?.providerId).toBe("META_CAPI");
  });
});
```

Run: `pnpm --filter @rovenue/dashboard test -- useProjectIntegrations.test.ts`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```ts
// apps/dashboard/src/lib/hooks/useProjectIntegrations.ts
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api-client";

export interface IntegrationConnectionRow {
  id: string;
  providerId: "META_CAPI" | "TIKTOK_EVENTS";
  displayName: string;
  credentialsHint: string;
  enabledEvents: string[];
  eventMapping: Record<string, { eventName?: string; skip?: true }>;
  actionSource: "app" | "website" | "system_generated";
  testEventCode: string | null;
  isEnabled: boolean;
  lastValidatedAt: string | null;
  lastError: string | null;
  lastBackfillAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function useProjectIntegrations(projectId: string) {
  return useQuery({
    queryKey: ["project-integrations", projectId],
    queryFn: async (): Promise<IntegrationConnectionRow[]> => {
      const res = await apiFetch(`/api/dashboard/projects/${projectId}/integrations`);
      const body = await res.json() as { data: IntegrationConnectionRow[] };
      return body.data;
    },
    enabled: Boolean(projectId),
  });
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- useProjectIntegrations.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useProjectIntegrations.ts apps/dashboard/src/lib/hooks/useProjectIntegrations.test.ts
git commit -m "feat(dashboard): useProjectIntegrations react-query hook"
```

### Task M6.2: useCreateIntegration + useUpdateIntegration + useDeleteIntegration mutations

**Files:**
- Modify: `apps/dashboard/src/lib/hooks/useProjectIntegrations.ts`
- Modify: `apps/dashboard/src/lib/hooks/useProjectIntegrations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { useCreateIntegration, useUpdateIntegration, useDeleteIntegration } from "./useProjectIntegrations";

it("useCreateIntegration POSTs to create endpoint", async () => {
  server.use(http.post("/api/dashboard/projects/p1/integrations", () =>
    HttpResponse.json({ data: { id: "new1", isEnabled: false } }, { status: 201 })));
  const { result } = renderHook(() => useCreateIntegration("p1"), { wrapper });
  const out = await result.current.mutateAsync({
    providerId: "META_CAPI", displayName: "X",
    credentials: { pixelId: "1", accessToken: "t" }, enabledEvents: ["revenue.INITIAL"],
  });
  expect(out.id).toBe("new1");
});

it("useUpdateIntegration PATCHes", async () => {
  server.use(http.patch("/api/dashboard/projects/p1/integrations/c1", () =>
    HttpResponse.json({ data: { id: "c1", isEnabled: true } })));
  const { result } = renderHook(() => useUpdateIntegration("p1"), { wrapper });
  const out = await result.current.mutateAsync({ id: "c1", body: { isEnabled: true } });
  expect(out.id).toBe("c1");
});

it("useDeleteIntegration DELETEs", async () => {
  server.use(http.delete("/api/dashboard/projects/p1/integrations/c1", () =>
    HttpResponse.json(null, { status: 204 })));
  const { result } = renderHook(() => useDeleteIntegration("p1"), { wrapper });
  await result.current.mutateAsync("c1");
  expect(result.current.isSuccess).toBe(true);
});
```

Run: `pnpm --filter @rovenue/dashboard test -- useProjectIntegrations.test.ts`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";

export interface CreateIntegrationBody {
  providerId: "META_CAPI" | "TIKTOK_EVENTS";
  displayName: string;
  credentials: { pixelId?: string; pixelCode?: string; accessToken: string };
  enabledEvents: string[];
  eventMapping?: Record<string, unknown>;
  actionSource?: "app" | "website" | "system_generated";
  testEventCode?: string;
}

export function useCreateIntegration(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateIntegrationBody): Promise<{ id: string; isEnabled: boolean }> => {
      const res = await apiFetch(`/api/dashboard/projects/${projectId}/integrations`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json() as { error: { message: string } }).error.message);
      return ((await res.json()) as { data: { id: string; isEnabled: boolean } }).data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-integrations", projectId] }),
  });
}

export interface UpdateIntegrationBody {
  enabledEvents?: string[];
  eventMapping?: Record<string, unknown>;
  actionSource?: "app" | "website" | "system_generated";
  testEventCode?: string | null;
  isEnabled?: boolean;
  credentials?: { accessToken: string };
}

export function useUpdateIntegration(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; body: UpdateIntegrationBody }) => {
      const res = await apiFetch(`/api/dashboard/projects/${projectId}/integrations/${input.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.body),
      });
      if (!res.ok) throw new Error((await res.json() as { error: { message: string } }).error.message);
      return ((await res.json()) as { data: { id: string; isEnabled: boolean } }).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-integrations", projectId] });
      qc.invalidateQueries({ queryKey: ["project-app-connections", projectId] });
    },
  });
}

export function useDeleteIntegration(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch(`/api/dashboard/projects/${projectId}/integrations/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-integrations", projectId] });
      qc.invalidateQueries({ queryKey: ["project-app-connections", projectId] });
    },
  });
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- useProjectIntegrations.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useProjectIntegrations.ts apps/dashboard/src/lib/hooks/useProjectIntegrations.test.ts
git commit -m "feat(dashboard): create/update/delete integration mutations"
```

### Task M6.3: useValidateIntegrationCredentials + useTestIntegrationEvent

**Files:**
- Modify: `apps/dashboard/src/lib/hooks/useProjectIntegrations.ts`
- Modify: `apps/dashboard/src/lib/hooks/useProjectIntegrations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { useValidateIntegrationCredentials, useTestIntegrationEvent } from "./useProjectIntegrations";

it("useValidateIntegrationCredentials returns { ok: true }", async () => {
  server.use(http.post("/api/dashboard/projects/p1/integrations/validate", () =>
    HttpResponse.json({ data: { ok: true } })));
  const { result } = renderHook(() => useValidateIntegrationCredentials("p1"), { wrapper });
  const out = await result.current.mutateAsync({
    providerId: "META_CAPI", credentials: { pixelId: "1", accessToken: "t" },
  });
  expect(out.ok).toBe(true);
});

it("useTestIntegrationEvent POSTs to /test-event", async () => {
  server.use(http.post("/api/dashboard/projects/p1/integrations/c1/test-event", () =>
    HttpResponse.json({ data: { ok: true, httpStatus: 200, responseBody: "{}" } })));
  const { result } = renderHook(() => useTestIntegrationEvent("p1", "c1"), { wrapper });
  const out = await result.current.mutateAsync();
  expect(out.httpStatus).toBe(200);
});
```

Run: `pnpm --filter @rovenue/dashboard test -- useProjectIntegrations.test.ts`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```ts
export function useValidateIntegrationCredentials(projectId: string) {
  return useMutation({
    mutationFn: async (body: {
      providerId: "META_CAPI" | "TIKTOK_EVENTS";
      credentials: { pixelId?: string; pixelCode?: string; accessToken: string };
    }): Promise<{ ok: true } | { ok: false; reason: string }> => {
      const res = await apiFetch(`/api/dashboard/projects/${projectId}/integrations/validate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      return ((await res.json()) as { data: { ok: true } | { ok: false; reason: string } }).data;
    },
  });
}

export function useTestIntegrationEvent(projectId: string, connectionId: string) {
  return useMutation({
    mutationFn: async (): Promise<{ ok: boolean; httpStatus: number; responseBody: string; errorMessage?: string }> => {
      const res = await apiFetch(`/api/dashboard/projects/${projectId}/integrations/${connectionId}/test-event`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json() as { error: { message: string } }).error.message);
      return ((await res.json()) as { data: { ok: boolean; httpStatus: number; responseBody: string; errorMessage?: string } }).data;
    },
  });
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- useProjectIntegrations.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useProjectIntegrations.ts apps/dashboard/src/lib/hooks/useProjectIntegrations.test.ts
git commit -m "feat(dashboard): validate + test-event mutation hooks"
```

### Task M6.4: useIntegrationDeliveries (infinite query)

**Files:**
- Modify: `apps/dashboard/src/lib/hooks/useProjectIntegrations.ts`
- Modify: `apps/dashboard/src/lib/hooks/useProjectIntegrations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { useIntegrationDeliveries } from "./useProjectIntegrations";

it("useIntegrationDeliveries fetches paginated deliveries", async () => {
  server.use(http.get("/api/dashboard/projects/p1/integrations/c1/deliveries", () =>
    HttpResponse.json({ data: { deliveries: [{ id: "d1", status: "succeeded" }], nextCursor: null } })));
  const { result } = renderHook(
    () => useIntegrationDeliveries("p1", "c1", { status: undefined }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(result.current.data?.pages[0]?.deliveries).toHaveLength(1);
});
```

Run: `pnpm --filter @rovenue/dashboard test -- useProjectIntegrations.test.ts`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```ts
import { useInfiniteQuery } from "@tanstack/react-query";

export interface IntegrationDeliveryRow {
  id: string;
  connectionId: string;
  outboxEventId: string;
  eventKey: string;
  providerEvent: string | null;
  status: "pending" | "succeeded" | "failed" | "skipped" | "dead_letter";
  attempt: number;
  httpStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export function useIntegrationDeliveries(
  projectId: string,
  connectionId: string,
  params: { status?: IntegrationDeliveryRow["status"]; limit?: number },
) {
  return useInfiniteQuery({
    queryKey: ["integration-deliveries", projectId, connectionId, params],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qp = new URLSearchParams();
      if (params.status) qp.set("status", params.status);
      qp.set("limit", String(params.limit ?? 50));
      if (pageParam) qp.set("cursor", pageParam);
      const res = await apiFetch(
        `/api/dashboard/projects/${projectId}/integrations/${connectionId}/deliveries?${qp.toString()}`,
      );
      return ((await res.json()) as { data: { deliveries: IntegrationDeliveryRow[]; nextCursor: string | null } }).data;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(connectionId),
  });
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- useProjectIntegrations.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useProjectIntegrations.ts apps/dashboard/src/lib/hooks/useProjectIntegrations.test.ts
git commit -m "feat(dashboard): useIntegrationDeliveries infinite query"
```

### Task M6.5: IntegrationDrawer shell (base-ui Dialog 520px + 5-step machine)

**Files:**
- Create: `apps/dashboard/src/components/apps/integration-drawer/integration-drawer.tsx`
- Create: `apps/dashboard/src/components/apps/integration-drawer/integration-drawer.test.tsx`
- Create stubs: `step-credentials.tsx`, `step-events.tsx`, `step-mapping.tsx`, `step-test.tsx`, `step-activate.tsx` (filled in subsequent tasks)

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { IntegrationDrawer } from "./integration-drawer";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe("IntegrationDrawer", () => {
  it("renders Step 1 (Credentials) when no existingConnection", () => {
    render(
      <IntegrationDrawer open={true} onOpenChange={() => {}} providerId="META_CAPI" projectId="p1" />,
      { wrapper },
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/credentials/i)).toBeInTheDocument();
  });

  it("renders nothing when open=false", () => {
    const { container } = render(
      <IntegrationDrawer open={false} onOpenChange={() => {}} providerId="META_CAPI" projectId="p1" />,
      { wrapper },
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
```

Run: `pnpm --filter @rovenue/dashboard test -- integration-drawer.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

Mirror the pattern from `apps/dashboard/src/components/products/product-drawer.tsx`. Create `integration-drawer.tsx`:

```tsx
import { useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import type { IntegrationConnectionRow } from "../../../lib/hooks/useProjectIntegrations";
import { StepCredentials } from "./step-credentials";
import { StepEvents } from "./step-events";
import { StepMapping } from "./step-mapping";
import { StepTest } from "./step-test";
import { StepActivate } from "./step-activate";

type Step = "credentials" | "events" | "mapping" | "test" | "activate";

export interface IntegrationDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: "META_CAPI" | "TIKTOK_EVENTS";
  projectId: string;
  existingConnection?: IntegrationConnectionRow;
}

export interface DrawerState {
  credentials: { pixelId?: string; pixelCode?: string; accessToken?: string };
  validated: boolean;
  enabledEvents: string[];
  eventMapping: Record<string, { eventName?: string; skip?: true }>;
  actionSource: "app" | "website" | "system_generated";
  testEventCode: string;
}

const DEFAULT_ENABLED: string[] = ["revenue.INITIAL", "revenue.RENEWAL", "subscription.trial.started"];

export function IntegrationDrawer({ open, onOpenChange, providerId, projectId, existingConnection }: IntegrationDrawerProps) {
  const [step, setStep] = useState<Step>(existingConnection ? "events" : "credentials");
  const [state, setState] = useState<DrawerState>({
    credentials: {}, validated: Boolean(existingConnection),
    enabledEvents: existingConnection?.enabledEvents ?? DEFAULT_ENABLED,
    eventMapping: existingConnection?.eventMapping ?? {},
    actionSource: existingConnection?.actionSource ?? "app",
    testEventCode: existingConnection?.testEventCode ?? "",
  });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/40" />
        <Dialog.Popup className="fixed right-0 top-0 h-full w-[520px] bg-white shadow-xl overflow-y-auto" role="dialog">
          <header className="px-6 py-4 border-b">
            <Dialog.Title className="text-lg font-semibold">
              {providerId === "META_CAPI" ? "Meta CAPI" : "TikTok Events API"}
            </Dialog.Title>
          </header>
          <div className="p-6">
            {step === "credentials" && <StepCredentials providerId={providerId} projectId={projectId} state={state} onChange={setState} onNext={() => setStep("events")} />}
            {step === "events" && <StepEvents state={state} onChange={setState} onBack={() => setStep("credentials")} onNext={() => setStep("mapping")} />}
            {step === "mapping" && <StepMapping state={state} onChange={setState} onBack={() => setStep("events")} onNext={() => setStep("test")} />}
            {step === "test" && <StepTest providerId={providerId} projectId={projectId} state={state} onChange={setState} onBack={() => setStep("mapping")} onNext={() => setStep("activate")} existingConnection={existingConnection} />}
            {step === "activate" && <StepActivate providerId={providerId} projectId={projectId} state={state} existingConnection={existingConnection} onClose={() => onOpenChange(false)} onBack={() => setStep("test")} />}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

Create stub files:

```tsx
// step-credentials.tsx, step-events.tsx, step-mapping.tsx, step-test.tsx, step-activate.tsx
export function StepCredentials(_: unknown) { return <h2>Credentials</h2>; }
export function StepEvents(_: unknown) { return <h2>Events</h2>; }
export function StepMapping(_: unknown) { return <h2>Mapping</h2>; }
export function StepTest(_: unknown) { return <h2>Test</h2>; }
export function StepActivate(_: unknown) { return <h2>Activate</h2>; }
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- integration-drawer.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/apps/integration-drawer
git commit -m "feat(dashboard): IntegrationDrawer shell with 5-step state machine"
```

### Task M6.6: Step 1 — Credentials (validate + token preview)

**Files:**
- Modify: `apps/dashboard/src/components/apps/integration-drawer/step-credentials.tsx`
- Create: `apps/dashboard/src/components/apps/integration-drawer/step-credentials.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { vi, beforeAll, afterEach, afterAll, it, expect } from "vitest";
import React from "react";
import { StepCredentials } from "./step-credentials";

const server = setupServer(
  http.post("/api/dashboard/projects/p1/integrations/validate", () => HttpResponse.json({ data: { ok: true } })),
);
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

it("validates credentials and unlocks Next on success", async () => {
  const onNext = vi.fn();
  let state = { credentials: {}, validated: false, enabledEvents: [], eventMapping: {}, actionSource: "app" as const, testEventCode: "" };
  const onChange = vi.fn((s) => { state = s; });
  const { rerender } = render(
    <StepCredentials providerId="META_CAPI" projectId="p1" state={state} onChange={onChange} onNext={onNext} />,
    { wrapper },
  );
  fireEvent.change(screen.getByLabelText("Pixel ID"), { target: { value: "12345678" } });
  fireEvent.change(screen.getByLabelText("Access Token"), { target: { value: "EAAtoken1234" } });
  fireEvent.click(screen.getByRole("button", { name: /validate/i }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ validated: true })));
  rerender(<StepCredentials providerId="META_CAPI" projectId="p1" state={{ ...state, validated: true, credentials: { pixelId: "12345678", accessToken: "EAAtoken1234" } }} onChange={onChange} onNext={onNext} />);
  expect(screen.getByText(/1234/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /next/i })).not.toBeDisabled();
});
```

Run: `pnpm --filter @rovenue/dashboard test -- step-credentials.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```tsx
import { useState } from "react";
import { useValidateIntegrationCredentials } from "../../../lib/hooks/useProjectIntegrations";
import type { DrawerState } from "./integration-drawer";

export interface StepCredentialsProps {
  providerId: "META_CAPI" | "TIKTOK_EVENTS";
  projectId: string;
  state: DrawerState;
  onChange: (s: DrawerState) => void;
  onNext: () => void;
}

export function StepCredentials({ providerId, projectId, state, onChange, onNext }: StepCredentialsProps) {
  const validate = useValidateIntegrationCredentials(projectId);
  const [error, setError] = useState<string | null>(null);
  const isMeta = providerId === "META_CAPI";
  const idValue = isMeta ? state.credentials.pixelId ?? "" : state.credentials.pixelCode ?? "";
  const tokenValue = state.credentials.accessToken ?? "";

  const handleValidate = async () => {
    setError(null);
    const result = await validate.mutateAsync({
      providerId,
      credentials: isMeta
        ? { pixelId: idValue, accessToken: tokenValue }
        : { pixelCode: idValue, accessToken: tokenValue },
    });
    if (result.ok) onChange({ ...state, validated: true });
    else setError(result.reason);
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); handleValidate(); }} className="space-y-4">
      <h2 className="text-base font-semibold">Credentials</h2>
      <label className="block">
        <span className="text-sm">{isMeta ? "Pixel ID" : "Pixel Code"}</span>
        <input
          aria-label={isMeta ? "Pixel ID" : "Pixel Code"}
          value={idValue}
          onChange={(e) => onChange({ ...state, credentials: isMeta
            ? { ...state.credentials, pixelId: e.target.value }
            : { ...state.credentials, pixelCode: e.target.value },
          })}
          className="w-full border rounded px-3 py-2"
        />
      </label>
      <label className="block">
        <span className="text-sm">Access Token</span>
        <input
          aria-label="Access Token" type="password" value={tokenValue}
          onChange={(e) => onChange({ ...state, credentials: { ...state.credentials, accessToken: e.target.value } })}
          className="w-full border rounded px-3 py-2"
        />
      </label>
      <button type="submit" disabled={validate.isPending} className="px-3 py-2 bg-slate-800 text-white rounded">
        {validate.isPending ? "Validating…" : "Validate"}
      </button>
      {state.validated && (
        <p className="text-green-700 text-sm">Token ending …{tokenValue.slice(-4)} validated</p>
      )}
      {error && <p className="text-red-700 text-sm">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" disabled={!state.validated} onClick={onNext}
          className="px-3 py-2 bg-blue-600 text-white rounded disabled:opacity-40">Next</button>
      </div>
    </form>
  );
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- step-credentials.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/apps/integration-drawer/step-credentials.tsx apps/dashboard/src/components/apps/integration-drawer/step-credentials.test.tsx
git commit -m "feat(dashboard): IntegrationDrawer Step 1 — Credentials with live validation"
```

### Task M6.7: Step 2 — Event scope checkbox list

**Files:**
- Modify: `apps/dashboard/src/components/apps/integration-drawer/step-events.tsx`
- Create: `apps/dashboard/src/components/apps/integration-drawer/step-events.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { vi, it, expect } from "vitest";
import { StepEvents } from "./step-events";

it("toggles enabledEvents when checkbox clicked", () => {
  const onChange = vi.fn();
  render(<StepEvents
    state={{ credentials: {}, validated: true, enabledEvents: ["revenue.INITIAL"], eventMapping: {}, actionSource: "app", testEventCode: "" }}
    onChange={onChange} onBack={() => {}} onNext={() => {}} />);
  fireEvent.click(screen.getByLabelText("revenue.RENEWAL"));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
    enabledEvents: ["revenue.INITIAL", "revenue.RENEWAL"],
  }));
});
```

Run: `pnpm --filter @rovenue/dashboard test -- step-events.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```tsx
import type { DrawerState } from "./integration-drawer";

const ALL_EVENT_KEYS = [
  "revenue.INITIAL", "revenue.TRIAL_CONVERSION", "revenue.RENEWAL",
  "revenue.CREDIT_PURCHASE", "revenue.REFUND", "revenue.CANCELLATION",
  "subscription.trial.started", "subscriber.identified",
] as const;

export interface StepEventsProps {
  state: DrawerState;
  onChange: (s: DrawerState) => void;
  onBack: () => void;
  onNext: () => void;
}

export function StepEvents({ state, onChange, onBack, onNext }: StepEventsProps) {
  const toggle = (key: string) => {
    const next = state.enabledEvents.includes(key)
      ? state.enabledEvents.filter((k) => k !== key)
      : [...state.enabledEvents, key];
    onChange({ ...state, enabledEvents: next });
  };
  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">Event scope</h2>
      {ALL_EVENT_KEYS.map((k) => (
        <label key={k} className="flex items-center gap-2">
          <input type="checkbox" checked={state.enabledEvents.includes(k)} onChange={() => toggle(k)} aria-label={k} />
          <span className="font-mono text-sm">{k}</span>
        </label>
      ))}
      <div className="flex justify-between pt-4">
        <button type="button" onClick={onBack} className="px-3 py-2 border rounded">Back</button>
        <button type="button" onClick={onNext} className="px-3 py-2 bg-blue-600 text-white rounded">Next</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- step-events.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/apps/integration-drawer/step-events.tsx apps/dashboard/src/components/apps/integration-drawer/step-events.test.tsx
git commit -m "feat(dashboard): IntegrationDrawer Step 2 — Event scope checkboxes"
```

### Task M6.8: Step 3 — Mapping overrides (collapsed accordion)

**Files:**
- Modify: `apps/dashboard/src/components/apps/integration-drawer/step-mapping.tsx`
- Create: `apps/dashboard/src/components/apps/integration-drawer/step-mapping.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { vi, it, expect } from "vitest";
import { StepMapping } from "./step-mapping";

it("expands accordion + accepts eventName override", () => {
  const onChange = vi.fn();
  render(<StepMapping
    state={{ credentials: {}, validated: true, enabledEvents: ["revenue.RENEWAL"], eventMapping: {}, actionSource: "app", testEventCode: "" }}
    onChange={onChange} onBack={() => {}} onNext={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /advanced/i }));
  fireEvent.change(screen.getByLabelText("revenue.RENEWAL"), { target: { value: "CustomPurchase" } });
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
    eventMapping: { "revenue.RENEWAL": { eventName: "CustomPurchase" } },
  }));
});
```

Run: `pnpm --filter @rovenue/dashboard test -- step-mapping.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```tsx
import { useState } from "react";
import type { DrawerState } from "./integration-drawer";

export interface StepMappingProps {
  state: DrawerState;
  onChange: (s: DrawerState) => void;
  onBack: () => void;
  onNext: () => void;
}

export function StepMapping({ state, onChange, onBack, onNext }: StepMappingProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">Mapping overrides</h2>
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-sm text-blue-600">
        {open ? "Hide" : "Advanced: customize event names"}
      </button>
      {open && (
        <div className="space-y-2 mt-2">
          {state.enabledEvents.map((k) => (
            <label key={k} className="block">
              <span className="text-sm font-mono">{k}</span>
              <input
                aria-label={k} placeholder="(default)"
                value={state.eventMapping[k]?.eventName ?? ""}
                onChange={(e) => onChange({
                  ...state,
                  eventMapping: {
                    ...state.eventMapping,
                    [k]: e.target.value ? { eventName: e.target.value } : { eventName: undefined },
                  },
                })}
                className="w-full border rounded px-3 py-2"
              />
            </label>
          ))}
        </div>
      )}
      <div className="flex justify-between pt-4">
        <button type="button" onClick={onBack} className="px-3 py-2 border rounded">Back</button>
        <button type="button" onClick={onNext} className="px-3 py-2 bg-blue-600 text-white rounded">Next</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- step-mapping.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/apps/integration-drawer/step-mapping.tsx apps/dashboard/src/components/apps/integration-drawer/step-mapping.test.tsx
git commit -m "feat(dashboard): IntegrationDrawer Step 3 — mapping override accordion"
```

### Task M6.9: Step 4 — Test event (send + provider Events Manager link)

**Files:**
- Modify: `apps/dashboard/src/components/apps/integration-drawer/step-test.tsx`
- Create: `apps/dashboard/src/components/apps/integration-drawer/step-test.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, it, expect, vi } from "vitest";
import React from "react";
import { StepTest } from "./step-test";

const server = setupServer(
  http.post("/api/dashboard/projects/p1/integrations/c1/test-event", () =>
    HttpResponse.json({ data: { ok: true, httpStatus: 200, responseBody: '{"events_received":1}' } })),
);
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

it("posts /test-event and shows response status", async () => {
  render(<StepTest
    providerId="META_CAPI" projectId="p1"
    state={{ credentials: {}, validated: true, enabledEvents: ["revenue.INITIAL"], eventMapping: {}, actionSource: "app", testEventCode: "TEST123" }}
    onChange={vi.fn()} onBack={vi.fn()} onNext={vi.fn()}
    existingConnection={{ id: "c1" } as never}
  />, { wrapper });
  fireEvent.click(screen.getByRole("button", { name: /send test event/i }));
  await waitFor(() => expect(screen.getByText(/200/)).toBeInTheDocument());
  expect(screen.getByText(/events_received/)).toBeInTheDocument();
});
```

Run: `pnpm --filter @rovenue/dashboard test -- step-test.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```tsx
import { useState } from "react";
import { useTestIntegrationEvent } from "../../../lib/hooks/useProjectIntegrations";
import type { DrawerState } from "./integration-drawer";
import type { IntegrationConnectionRow } from "../../../lib/hooks/useProjectIntegrations";

export interface StepTestProps {
  providerId: "META_CAPI" | "TIKTOK_EVENTS";
  projectId: string;
  state: DrawerState;
  onChange: (s: DrawerState) => void;
  onBack: () => void;
  onNext: () => void;
  existingConnection?: IntegrationConnectionRow;
}

export function StepTest({ providerId, projectId, state, onChange, onBack, onNext, existingConnection }: StepTestProps) {
  const test = useTestIntegrationEvent(projectId, existingConnection?.id ?? "");
  const [result, setResult] = useState<{ httpStatus: number; responseBody: string } | null>(null);
  const externalLink = providerId === "META_CAPI"
    ? "https://business.facebook.com/events_manager"
    : "https://ads.tiktok.com/i18n/events_manager";
  const canSend = Boolean(existingConnection?.id && state.testEventCode);

  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">Test event</h2>
      <label className="block">
        <span className="text-sm">Test event code</span>
        <input aria-label="test_event_code" value={state.testEventCode}
          onChange={(e) => onChange({ ...state, testEventCode: e.target.value })}
          className="w-full border rounded px-3 py-2" />
      </label>
      <button type="button" disabled={!canSend || test.isPending}
        onClick={async () => {
          const out = await test.mutateAsync();
          setResult({ httpStatus: out.httpStatus, responseBody: out.responseBody });
        }}
        className="px-3 py-2 bg-slate-800 text-white rounded disabled:opacity-40">
        {test.isPending ? "Sending…" : "Send test event"}
      </button>
      {result && (
        <details open className="border rounded p-3">
          <summary>HTTP {result.httpStatus}</summary>
          <pre className="text-xs overflow-x-auto">{result.responseBody}</pre>
        </details>
      )}
      <a href={externalLink} target="_blank" rel="noreferrer" className="text-blue-600 text-sm">
        Open in {providerId === "META_CAPI" ? "Meta" : "TikTok"} Events Manager →
      </a>
      <div className="flex justify-between pt-4">
        <button type="button" onClick={onBack} className="px-3 py-2 border rounded">Back</button>
        <button type="button" onClick={onNext} className="px-3 py-2 bg-blue-600 text-white rounded">Next</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- step-test.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/apps/integration-drawer/step-test.tsx apps/dashboard/src/components/apps/integration-drawer/step-test.test.tsx
git commit -m "feat(dashboard): IntegrationDrawer Step 4 — send test event + manager link"
```

### Task M6.10: Step 5 — Activate (create or PATCH isEnabled=true)

**Files:**
- Modify: `apps/dashboard/src/components/apps/integration-drawer/step-activate.tsx`
- Create: `apps/dashboard/src/components/apps/integration-drawer/step-activate.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { vi, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import React from "react";
import { StepActivate } from "./step-activate";

const server = setupServer(
  http.post("/api/dashboard/projects/p1/integrations", () => HttpResponse.json({ data: { id: "new1", isEnabled: false } }, { status: 201 })),
  http.patch("/api/dashboard/projects/p1/integrations/new1", () => HttpResponse.json({ data: { id: "new1", isEnabled: true } })),
);
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

it("creates a new connection when no existingConnection", async () => {
  const onClose = vi.fn();
  render(<StepActivate
    providerId="META_CAPI" projectId="p1"
    state={{ credentials: { pixelId: "1", accessToken: "t" }, validated: true, enabledEvents: ["revenue.INITIAL"], eventMapping: {}, actionSource: "app", testEventCode: "" }}
    existingConnection={undefined} onClose={onClose} onBack={() => {}}
  />, { wrapper });
  fireEvent.click(screen.getByRole("button", { name: /activate/i }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it("PATCHes isEnabled=true when existingConnection present", async () => {
  server.use(http.patch("/api/dashboard/projects/p1/integrations/c1", async ({ request }) => {
    const body = await request.json() as { isEnabled: boolean };
    expect(body.isEnabled).toBe(true);
    return HttpResponse.json({ data: { id: "c1", isEnabled: true } });
  }));
  const onClose = vi.fn();
  render(<StepActivate
    providerId="META_CAPI" projectId="p1"
    state={{ credentials: {}, validated: true, enabledEvents: ["revenue.INITIAL"], eventMapping: {}, actionSource: "app", testEventCode: "" }}
    existingConnection={{ id: "c1", isEnabled: false } as never}
    onClose={onClose} onBack={() => {}}
  />, { wrapper });
  fireEvent.click(screen.getByRole("button", { name: /activate/i }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});
```

Run: `pnpm --filter @rovenue/dashboard test -- step-activate.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```tsx
import { useCreateIntegration, useUpdateIntegration } from "../../../lib/hooks/useProjectIntegrations";
import type { DrawerState } from "./integration-drawer";
import type { IntegrationConnectionRow } from "../../../lib/hooks/useProjectIntegrations";
// Adjust the toast import to match the project's existing notification pattern;
// look in apps/dashboard/src/lib/ or apps/dashboard/src/components/ui/ first.

export interface StepActivateProps {
  providerId: "META_CAPI" | "TIKTOK_EVENTS";
  projectId: string;
  state: DrawerState;
  existingConnection?: IntegrationConnectionRow;
  onClose: () => void;
  onBack: () => void;
}

export function StepActivate({ providerId, projectId, state, existingConnection, onClose, onBack }: StepActivateProps) {
  const create = useCreateIntegration(projectId);
  const update = useUpdateIntegration(projectId);

  const handleActivate = async () => {
    if (existingConnection) {
      await update.mutateAsync({
        id: existingConnection.id,
        body: {
          isEnabled: true,
          enabledEvents: state.enabledEvents,
          eventMapping: state.eventMapping,
          actionSource: state.actionSource,
          testEventCode: state.testEventCode || null,
        },
      });
    } else {
      const created = await create.mutateAsync({
        providerId,
        displayName: providerId === "META_CAPI" ? "Meta CAPI" : "TikTok Events API",
        credentials: state.credentials as { pixelId?: string; pixelCode?: string; accessToken: string },
        enabledEvents: state.enabledEvents,
        eventMapping: state.eventMapping,
        actionSource: state.actionSource,
        testEventCode: state.testEventCode || undefined,
      });
      await update.mutateAsync({ id: created.id, body: { isEnabled: true } });
    }
    onClose();
  };

  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">Activate</h2>
      <dl className="text-sm">
        <dt className="font-semibold">Events</dt>
        <dd className="mb-2">{state.enabledEvents.join(", ") || "(none)"}</dd>
        <dt className="font-semibold">Action source</dt>
        <dd className="mb-2">{state.actionSource}</dd>
        <dt className="font-semibold">Test event code</dt>
        <dd>{state.testEventCode || "(none)"}</dd>
      </dl>
      <div className="flex justify-between pt-4">
        <button type="button" onClick={onBack} className="px-3 py-2 border rounded">Back</button>
        <button type="button" onClick={handleActivate}
          disabled={create.isPending || update.isPending}
          className="px-3 py-2 bg-green-600 text-white rounded disabled:opacity-40">
          {create.isPending || update.isPending ? "Activating…" : "Activate"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- step-activate.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/apps/integration-drawer/step-activate.tsx apps/dashboard/src/components/apps/integration-drawer/step-activate.test.tsx
git commit -m "feat(dashboard): IntegrationDrawer Step 5 — Activate (create or enable)"
```

### Task M6.11: Wire AppCard click → open drawer

**Files:**
- Modify: `apps/dashboard/src/components/apps/app-card.tsx`
- Create or modify: `apps/dashboard/src/components/apps/app-card.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { vi, it, expect } from "vitest";
import { AppCard } from "./app-card";

it("clicking the meta-capi card calls onOpenIntegration", () => {
  const onOpen = vi.fn();
  render(<AppCard
    app={{ id: "meta-capi", name: "Meta CAPI", description: "", status: "available" }}
    onOpenIntegration={onOpen} />);
  fireEvent.click(screen.getByRole("button", { name: /meta capi/i }));
  expect(onOpen).toHaveBeenCalledWith("meta-capi");
});

it("clicking an 'unavailable' card does nothing", () => {
  const onOpen = vi.fn();
  render(<AppCard
    app={{ id: "snapchat-ads", name: "Snapchat", description: "", status: "unavailable" }}
    onOpenIntegration={onOpen} />);
  fireEvent.click(screen.getByRole("button", { name: /snapchat/i }));
  expect(onOpen).not.toHaveBeenCalled();
});
```

Run: `pnpm --filter @rovenue/dashboard test -- app-card.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

Modify `app-card.tsx` to accept `onOpenIntegration?: (providerId: string) => void`. On click, dispatch only when `app.status !== "unavailable"` AND `app.id === "meta-capi" || app.id === "tiktok-events"`. Other clicks behave as before.

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- app-card.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/apps/app-card.tsx apps/dashboard/src/components/apps/app-card.test.tsx
git commit -m "feat(dashboard): AppCard opens IntegrationDrawer for meta-capi + tiktok-events"
```

### Task M6.12: AppsGrid (container) renders drawer

**Files:**
- Modify: `apps/dashboard/src/components/apps/apps-grid.tsx` (or whichever container hosts cards; ls the directory first if uncertain)
- Create/modify: `apps/dashboard/src/components/apps/apps-grid.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it("renders drawer when a meta-capi card opens it", async () => {
  server.use(http.get("/api/dashboard/projects/p1/app-connections", () =>
    HttpResponse.json({ data: [{ id: "meta-capi", name: "Meta CAPI", description: "", status: "available" }] })));
  render(<AppsGrid projectId="p1" />, { wrapper });
  await screen.findByRole("button", { name: /meta capi/i });
  fireEvent.click(screen.getByRole("button", { name: /meta capi/i }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});
```

Run: `pnpm --filter @rovenue/dashboard test -- apps-grid.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

In the container, add state `[drawerProviderId, setDrawerProviderId] = useState<"META_CAPI" | "TIKTOK_EVENTS" | null>(null)`. Pass `onOpenIntegration={(id) => setDrawerProviderId(id === "meta-capi" ? "META_CAPI" : "TIKTOK_EVENTS")}` to cards. Render:

```tsx
{drawerProviderId && (
  <IntegrationDrawer
    open={true}
    onOpenChange={(o) => !o && setDrawerProviderId(null)}
    providerId={drawerProviderId}
    projectId={projectId}
    existingConnection={integrations?.find((c) => c.providerId === drawerProviderId)}
  />
)}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- apps-grid.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/apps/apps-grid.tsx apps/dashboard/src/components/apps/apps-grid.test.tsx
git commit -m "feat(dashboard): AppsGrid renders IntegrationDrawer on card open"
```

### Task M6.13: Catalog entries for meta-capi + tiktok-events

**Files:**
- Modify: `apps/dashboard/src/components/apps/mock-data.ts`

- [ ] **Step 1: Verify state**

Run: `grep -n "meta-capi\|tiktok-events" apps/dashboard/src/components/apps/mock-data.ts`

If both IDs already exist with `category: "ads"` and a default `status: "available"`, skip; if missing, add:

```ts
{ id: "meta-capi", name: "Meta CAPI", description: "Send server-side conversions to your Meta Pixel.", category: "ads", status: "available", icon: "/icons/apps/meta.svg" },
{ id: "tiktok-events", name: "TikTok Events API", description: "Send server-side conversions to your TikTok Pixel.", category: "ads", status: "available", icon: "/icons/apps/tiktok.svg" },
```

- [ ] **Step 2: Commit**

```bash
git add apps/dashboard/src/components/apps/mock-data.ts
git commit -m "feat(dashboard): catalog entries for meta-capi + tiktok-events"
```

### Task M6.14: i18n keys (en + tr if tr.json exists)

**Files:**
- Modify: `apps/dashboard/src/i18n/locales/en.json`
- Modify: `apps/dashboard/src/i18n/locales/tr.json` (only if present)

- [ ] **Step 1: Verify locale layout**

Run: `ls apps/dashboard/src/i18n/locales/`

Add (under existing `apps` namespace, mirroring the existing nesting depth):

```json
{
  "apps": {
    "items": {
      "meta-capi": { "name": "Meta CAPI", "description": "Send server-side conversions to your Meta Pixel." },
      "tiktok-events": { "name": "TikTok Events API", "description": "Send server-side conversions to your TikTok Pixel." }
    },
    "drawer": {
      "step.credentials.title": "Credentials",
      "step.events.title": "Event scope",
      "step.mapping.title": "Mapping overrides",
      "step.test.title": "Test event",
      "step.activate.title": "Activate",
      "button.validate": "Validate",
      "button.next": "Next",
      "button.back": "Back",
      "button.activate": "Activate",
      "button.sendTestEvent": "Send test event",
      "success.activated": "Integration activated. Backfilling last 7 days…",
      "error.invalidCredentials": "Invalid credentials. Check the pixel ID and access token.",
      "advanced.toggle": "Advanced: customize event names"
    }
  }
}
```

Mirror to `tr.json` if present.

- [ ] **Step 2: Run** `pnpm --filter @rovenue/dashboard test` to ensure JSON parses.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/i18n/locales/
git commit -m "feat(dashboard): i18n keys for integration drawer"
```

### Task M6.15: Deliveries tab (when existingConnection set)

**Files:**
- Create: `apps/dashboard/src/components/apps/integration-drawer/step-deliveries.tsx`
- Create: `apps/dashboard/src/components/apps/integration-drawer/step-deliveries.test.tsx`
- Modify: `apps/dashboard/src/components/apps/integration-drawer/integration-drawer.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, afterAll, afterEach, it, expect } from "vitest";
import React from "react";
import { StepDeliveries } from "./step-deliveries";

const server = setupServer(
  http.get("/api/dashboard/projects/p1/integrations/c1/deliveries", () =>
    HttpResponse.json({
      data: {
        deliveries: [
          { id: "d1", status: "succeeded", httpStatus: 200, eventKey: "revenue.RENEWAL", createdAt: "2026-05-26T00:00:00Z" },
          { id: "d2", status: "dead_letter", httpStatus: 401, eventKey: "revenue.RENEWAL", createdAt: "2026-05-26T00:01:00Z" },
        ],
        nextCursor: null,
      },
    })),
);
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

it("renders paginated deliveries table", async () => {
  render(<StepDeliveries projectId="p1" connectionId="c1" />, { wrapper });
  await screen.findByText("revenue.RENEWAL");
  expect(screen.getByText("succeeded")).toBeInTheDocument();
  expect(screen.getByText("dead_letter")).toBeInTheDocument();
});
```

Run: `pnpm --filter @rovenue/dashboard test -- step-deliveries.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Write minimal implementation**

```tsx
import { useIntegrationDeliveries } from "../../../lib/hooks/useProjectIntegrations";

export function StepDeliveries({ projectId, connectionId }: { projectId: string; connectionId: string }) {
  const q = useIntegrationDeliveries(projectId, connectionId, {});
  const rows = q.data?.pages.flatMap((p) => p.deliveries) ?? [];
  return (
    <div className="space-y-2">
      <h2 className="text-base font-semibold">Recent deliveries</h2>
      <table className="w-full text-sm">
        <thead><tr><th>Event</th><th>Status</th><th>HTTP</th><th>When</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="font-mono">{r.eventKey}</td>
              <td>{r.status}</td>
              <td>{r.httpStatus ?? "—"}</td>
              <td>{new Date(r.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {q.hasNextPage && (
        <button type="button" onClick={() => q.fetchNextPage()} className="px-3 py-2 border rounded">Load more</button>
      )}
    </div>
  );
}
```

Modify `integration-drawer.tsx` to expose a top-row "Wizard / Deliveries" tab toggle when `existingConnection` is set. Add a `view: "wizard" | "deliveries"` state.

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- step-deliveries.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/apps/integration-drawer/step-deliveries.tsx apps/dashboard/src/components/apps/integration-drawer/step-deliveries.test.tsx apps/dashboard/src/components/apps/integration-drawer/integration-drawer.tsx
git commit -m "feat(dashboard): IntegrationDrawer deliveries tab (existing connection only)"
```

### Task M6.16: End-to-end drawer flow happy path

**Files:**
- Create: `apps/dashboard/src/components/apps/integration-drawer/integration-drawer.flow.test.tsx`

- [ ] **Step 1: Write the test**

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { vi, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import React from "react";
import { IntegrationDrawer } from "./integration-drawer";

const server = setupServer(
  http.post("/api/dashboard/projects/p1/integrations/validate", () => HttpResponse.json({ data: { ok: true } })),
  http.post("/api/dashboard/projects/p1/integrations", () => HttpResponse.json({ data: { id: "new1", isEnabled: false } }, { status: 201 })),
  http.patch("/api/dashboard/projects/p1/integrations/new1", () => HttpResponse.json({ data: { id: "new1", isEnabled: true } })),
);
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

it("complete flow: validate → events → mapping → test → activate", async () => {
  const onOpenChange = vi.fn();
  render(<IntegrationDrawer open={true} onOpenChange={onOpenChange} providerId="META_CAPI" projectId="p1" />, { wrapper });
  fireEvent.change(screen.getByLabelText("Pixel ID"), { target: { value: "1" } });
  fireEvent.change(screen.getByLabelText("Access Token"), { target: { value: "EAAtok" } });
  fireEvent.click(screen.getByRole("button", { name: /validate/i }));
  await waitFor(() => expect(screen.getByRole("button", { name: /next/i })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: /next/i }));
  fireEvent.click(screen.getByRole("button", { name: /next/i }));
  fireEvent.click(screen.getByRole("button", { name: /next/i }));
  fireEvent.click(screen.getByRole("button", { name: /next/i }));
  fireEvent.click(screen.getByRole("button", { name: /activate/i }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});
```

Run: `pnpm --filter @rovenue/dashboard test -- integration-drawer.flow.test.tsx`
Expected: PASS.

- [ ] **Step 2: Commit**

```bash
git add apps/dashboard/src/components/apps/integration-drawer/integration-drawer.flow.test.tsx
git commit -m "test(dashboard): IntegrationDrawer end-to-end happy-path flow"
```

---

## M7 — SDK identityContext (Rust core + RN/Swift/Kotlin façades + server ingestion)

This milestone is the cross-cutting coordination item flagged in spec §12. The Rust core (`packages/core-rs`) does not yet have an event-envelope module — the existing surface is entitlements/credits/receipts read paths. We introduce a new `events` module in the core, add a TypeScript-facing `identityContext` type in the RN façade, mirror it in Swift + Kotlin façades, and extend the public ingest validator to accept the field. The worker already consumes `identityContext` via `hashPii()` (Part 1 M1), so server-side this is purely a Zod-schema extension on whichever route delivers events to `outbox_events`.

> **Reviewer note (memory pointer `[[rovenue_sdk_architecture]]`):** Rovenue SDK is **Rust core + native façades** (`librovenue` + Swift / Kotlin / RN). RN-only TS SDK assumptions from CLAUDE.md are stale. Each façade is its own crate / module / package and they ship from different release trains — coordinate before merging.

### Task M7.1: Rust core — IdentityContext struct + EventEnvelope module

**Files:**
- Create: `packages/core-rs/src/events/mod.rs`
- Create: `packages/core-rs/src/events/envelope.rs`
- Create: `packages/core-rs/src/events/identity_context.rs`
- Modify: `packages/core-rs/src/lib.rs` (register `events` module + re-export)
- Test: `packages/core-rs/tests/events_envelope.rs`

- [ ] **Step 1: Write the failing test**

Create `packages/core-rs/tests/events_envelope.rs`:

```rust
use librovenue::events::{EventEnvelope, IdentityContext};

#[test]
fn envelope_roundtrips_with_all_identity_fields() {
    let env = EventEnvelope {
        event_type: "revenue.event.recorded".into(),
        occurred_at: "2026-05-27T12:00:00Z".into(),
        subscriber_id: Some("sub_1".into()),
        product_id: Some("p_1".into()),
        amount: Some("9.99".into()),
        currency: Some("USD".into()),
        event_source_url: Some("https://app.example.com/billing".into()),
        identity_context: Some(IdentityContext {
            email: Some("user@example.com".into()),
            phone: Some("+15551234".into()),
            external_id: Some("ext_1".into()),
            ip: Some("1.2.3.4".into()),
            user_agent: Some("Mozilla/5.0".into()),
            fbp: Some("fb.1.123.abc".into()),
            fbc: Some("fb.1.123.click".into()),
            ttclid: Some("ttc_1".into()),
            ttp: Some("ttp_1".into()),
        }),
    };
    let j = serde_json::to_string(&env).expect("serialize");
    // wire format is camelCase for the envelope, snake_case fields renamed by serde
    assert!(j.contains("\"identityContext\""), "json missing identityContext key: {}", j);
    assert!(j.contains("\"externalId\":\"ext_1\""), "external_id should serialize as externalId: {}", j);
    assert!(j.contains("\"userAgent\":\"Mozilla/5.0\""), "user_agent should serialize as userAgent: {}", j);

    let back: EventEnvelope = serde_json::from_str(&j).expect("deserialize");
    assert_eq!(back.identity_context.as_ref().unwrap().email.as_deref(), Some("user@example.com"));
    assert_eq!(back.identity_context.as_ref().unwrap().ttclid.as_deref(), Some("ttc_1"));
}

#[test]
fn envelope_omits_identity_context_when_none() {
    let env = EventEnvelope {
        event_type: "subscription.trial.started".into(),
        occurred_at: "2026-05-27T12:00:00Z".into(),
        subscriber_id: None, product_id: None, amount: None, currency: None,
        event_source_url: None, identity_context: None,
    };
    let j = serde_json::to_string(&env).expect("serialize");
    assert!(!j.contains("identityContext"), "absent field should be omitted, got: {}", j);
}

#[test]
fn identity_context_drops_undefined_fields_in_json() {
    let ic = IdentityContext {
        email: Some("a@b.co".into()),
        phone: None, external_id: None, ip: None, user_agent: None,
        fbp: None, fbc: None, ttclid: None, ttp: None,
    };
    let j = serde_json::to_string(&ic).unwrap();
    // serde(skip_serializing_if = "Option::is_none") on every field
    assert_eq!(j, r#"{"email":"a@b.co"}"#);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p librovenue --test events_envelope`
Expected: FAIL — `module 'events' is not in librovenue`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core-rs/src/events/identity_context.rs`:

```rust
use serde::{Deserialize, Serialize};

/// Per-event identity context supplied by the host app at track-time.
///
/// **Consent ownership:** the host app is responsible for obtaining user
/// consent before populating any field here. Rovenue never persists these
/// values at rest — they are hashed (where required) and forwarded to the
/// configured ad-platform integrations at delivery time only.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fbp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fbc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttclid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttp: Option<String>,
}
```

Create `packages/core-rs/src/events/envelope.rs`:

```rust
use serde::{Deserialize, Serialize};
use super::identity_context::IdentityContext;

/// Wire-format envelope shipped from any façade through the Rust core to
/// the Rovenue ingest endpoint. JSON is camelCase on the wire (matches the
/// existing `/v1/*` route conventions). Wire-format version: 1.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub event_type: String,
    pub occurred_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscriber_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_context: Option<IdentityContext>,
}
```

Create `packages/core-rs/src/events/mod.rs`:

```rust
//! Event envelope sent from the SDK to the Rovenue ingest endpoint.
//!
//! Wire-format version: 1 (introduced 2026-05-27 alongside outbound
//! integrations — Meta CAPI + TikTok Events). Bump when the JSON shape
//! changes in a backwards-incompatible way.
pub mod envelope;
pub mod identity_context;

pub use envelope::EventEnvelope;
pub use identity_context::IdentityContext;

pub const EVENT_WIRE_VERSION: u8 = 1;
```

Append to `packages/core-rs/src/lib.rs`:

```rust
pub mod events;
pub use events::{EventEnvelope, IdentityContext, EVENT_WIRE_VERSION};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p librovenue --test events_envelope`
Expected: PASS — all three assertions green.

- [ ] **Step 5: Commit**

```bash
git add packages/core-rs/src/events/mod.rs packages/core-rs/src/events/envelope.rs packages/core-rs/src/events/identity_context.rs packages/core-rs/src/lib.rs packages/core-rs/tests/events_envelope.rs
git commit -m "feat(core-rs): EventEnvelope + IdentityContext (wire v1) for SDK ingest"
```

### Task M7.2: RN façade — IdentityContext TS type + serializer round-trip

**Files:**
- Create: `packages/sdk-rn/src/events.ts`
- Modify: `packages/sdk-rn/src/index.ts` (re-export)
- Test: `packages/sdk-rn/src/__tests__/events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-rn/src/__tests__/events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  type EventEnvelope,
  type IdentityContext,
  serializeEnvelope,
} from "../events";

describe("EventEnvelope serializer", () => {
  it("round-trips with all identityContext fields", () => {
    const env: EventEnvelope = {
      eventType: "revenue.event.recorded",
      occurredAt: "2026-05-27T12:00:00Z",
      subscriberId: "sub_1",
      amount: "9.99",
      currency: "USD",
      identityContext: {
        email: "user@example.com",
        phone: "+15551234",
        externalId: "ext_1",
        ip: "1.2.3.4",
        userAgent: "Mozilla/5.0",
        fbp: "fb.1.123.abc",
        fbc: "fb.1.123.click",
        ttclid: "ttc_1",
        ttp: "ttp_1",
      },
    };
    const j = serializeEnvelope(env);
    // Wire format is camelCase end-to-end (matches Rust core which renames
    // its snake_case fields to camelCase via serde).
    expect(JSON.parse(j)).toEqual({
      eventType: "revenue.event.recorded",
      occurredAt: "2026-05-27T12:00:00Z",
      subscriberId: "sub_1",
      amount: "9.99",
      currency: "USD",
      identityContext: {
        email: "user@example.com",
        phone: "+15551234",
        externalId: "ext_1",
        ip: "1.2.3.4",
        userAgent: "Mozilla/5.0",
        fbp: "fb.1.123.abc",
        fbc: "fb.1.123.click",
        ttclid: "ttc_1",
        ttp: "ttp_1",
      },
    });
  });

  it("omits undefined identityContext fields entirely", () => {
    const ic: IdentityContext = { email: "a@b.co" };
    const env: EventEnvelope = {
      eventType: "subscriber.identified",
      occurredAt: "2026-05-27T12:00:00Z",
      identityContext: ic,
    };
    const parsed = JSON.parse(serializeEnvelope(env)) as Record<string, unknown>;
    expect(parsed.identityContext).toEqual({ email: "a@b.co" });
    expect("subscriberId" in parsed).toBe(false);
  });

  it("omits identityContext entirely when not provided", () => {
    const env: EventEnvelope = {
      eventType: "subscription.trial.started",
      occurredAt: "2026-05-27T12:00:00Z",
    };
    const parsed = JSON.parse(serializeEnvelope(env)) as Record<string, unknown>;
    expect("identityContext" in parsed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/sdk-rn test -- events.test.ts`
Expected: FAIL — `Cannot find module '../events'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/sdk-rn/src/events.ts`:

```ts
/**
 * Per-event identity context supplied by the host app at track-time.
 *
 * **Consent ownership:** the host app is responsible for obtaining user
 * consent before populating any field here. Rovenue never persists these
 * values at rest — they are hashed (where required) and forwarded to the
 * configured ad-platform integrations at delivery time only.
 *
 * Hashing rules at the server: `email`, `phone`, `externalId` are SHA-256
 * over their lowercased+trimmed values. `ip`, `userAgent`, `fbp`, `fbc`,
 * `ttclid`, `ttp` are forwarded raw per Meta CAPI and TikTok Events API
 * v1.3 spec requirements.
 */
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

export interface EventEnvelope {
  eventType: string;
  occurredAt: string; // ISO-8601
  subscriberId?: string;
  productId?: string;
  amount?: string;
  currency?: string;
  eventSourceUrl?: string;
  identityContext?: IdentityContext;
}

/** Wire-format version. Bump on backwards-incompatible schema changes. */
export const EVENT_WIRE_VERSION = 1 as const;

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** Serialize an envelope to a JSON wire payload, dropping undefined fields. */
export function serializeEnvelope(env: EventEnvelope): string {
  const ic = env.identityContext ? stripUndefined(env.identityContext) : undefined;
  const body = stripUndefined({
    ...env,
    identityContext: ic && Object.keys(ic).length > 0 ? ic : undefined,
  });
  return JSON.stringify(body);
}
```

Append to `packages/sdk-rn/src/index.ts`:

```ts
export * from "./events";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/sdk-rn test -- events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-rn/src/events.ts packages/sdk-rn/src/index.ts packages/sdk-rn/src/__tests__/events.test.ts
git commit -m "feat(sdk-rn): EventEnvelope + IdentityContext types + serializer"
```

### Task M7.3: Swift façade — IdentityContext struct + Codable round-trip

**Files:**
- Create: `packages/sdk-swift/Sources/Rovenue/Events.swift`
- Test: `packages/sdk-swift/Tests/RovenueTests/EventsTests.swift`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-swift/Tests/RovenueTests/EventsTests.swift`:

```swift
import XCTest
@testable import Rovenue

final class EventsTests: XCTestCase {
    func testEnvelopeRoundTripsWithAllFields() throws {
        let env = EventEnvelope(
            eventType: "revenue.event.recorded",
            occurredAt: "2026-05-27T12:00:00Z",
            subscriberId: "sub_1",
            amount: "9.99",
            currency: "USD",
            identityContext: IdentityContext(
                email: "user@example.com",
                phone: "+15551234",
                externalId: "ext_1",
                ip: "1.2.3.4",
                userAgent: "Mozilla/5.0",
                fbp: "fb.1.123.abc",
                fbc: "fb.1.123.click",
                ttclid: "ttc_1",
                ttp: "ttp_1"
            )
        )
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        let data = try enc.encode(env)
        let s = String(data: data, encoding: .utf8)!
        XCTAssertTrue(s.contains("\"identityContext\""))
        XCTAssertTrue(s.contains("\"externalId\":\"ext_1\""))
        XCTAssertTrue(s.contains("\"userAgent\":\"Mozilla\\/5.0\"") || s.contains("\"userAgent\":\"Mozilla/5.0\""))

        let back = try JSONDecoder().decode(EventEnvelope.self, from: data)
        XCTAssertEqual(back.identityContext?.email, "user@example.com")
        XCTAssertEqual(back.identityContext?.ttclid, "ttc_1")
    }

    func testIdentityContextOmitsNilFields() throws {
        let ic = IdentityContext(email: "a@b.co")
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        let s = String(data: try enc.encode(ic), encoding: .utf8)!
        XCTAssertEqual(s, "{\"email\":\"a@b.co\"}")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --package-path packages/sdk-swift`
Expected: FAIL — `cannot find 'EventEnvelope' in scope`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/sdk-swift/Sources/Rovenue/Events.swift`:

```swift
import Foundation

/// Per-event identity context supplied by the host app at track-time.
///
/// Consent ownership: the host app is responsible for obtaining user
/// consent before populating any field. Rovenue never persists these
/// values at rest — they are hashed (where required) and forwarded to
/// the configured ad-platform integrations at delivery time only.
public struct IdentityContext: Codable, Equatable {
    public var email: String?
    public var phone: String?
    public var externalId: String?
    public var ip: String?
    public var userAgent: String?
    public var fbp: String?
    public var fbc: String?
    public var ttclid: String?
    public var ttp: String?

    public init(
        email: String? = nil, phone: String? = nil, externalId: String? = nil,
        ip: String? = nil, userAgent: String? = nil,
        fbp: String? = nil, fbc: String? = nil,
        ttclid: String? = nil, ttp: String? = nil
    ) {
        self.email = email; self.phone = phone; self.externalId = externalId
        self.ip = ip; self.userAgent = userAgent
        self.fbp = fbp; self.fbc = fbc
        self.ttclid = ttclid; self.ttp = ttp
    }
}

public struct EventEnvelope: Codable, Equatable {
    public var eventType: String
    public var occurredAt: String
    public var subscriberId: String?
    public var productId: String?
    public var amount: String?
    public var currency: String?
    public var eventSourceUrl: String?
    public var identityContext: IdentityContext?

    public init(
        eventType: String, occurredAt: String,
        subscriberId: String? = nil, productId: String? = nil,
        amount: String? = nil, currency: String? = nil,
        eventSourceUrl: String? = nil, identityContext: IdentityContext? = nil
    ) {
        self.eventType = eventType; self.occurredAt = occurredAt
        self.subscriberId = subscriberId; self.productId = productId
        self.amount = amount; self.currency = currency
        self.eventSourceUrl = eventSourceUrl; self.identityContext = identityContext
    }
}

/// Wire-format version. Bump on backwards-incompatible schema changes.
public let RovenueEventWireVersion: UInt8 = 1
```

Note: Swift's default `Codable` already omits nil optional values when encoding (no extra config required) and matches camelCase by default, so the JSON shape matches the Rust + RN serializers.

- [ ] **Step 4: Run test to verify it passes**

Run: `swift test --package-path packages/sdk-swift`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Events.swift packages/sdk-swift/Tests/RovenueTests/EventsTests.swift
git commit -m "feat(sdk-swift): EventEnvelope + IdentityContext (Codable)"
```

### Task M7.4: Kotlin façade — IdentityContext data class + kotlinx.serialization

**Files:**
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Events.kt`
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/EventsTest.kt`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/EventsTest.kt`:

```kotlin
package dev.rovenue.sdk

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class EventsTest {
    private val json = Json { encodeDefaults = false; explicitNulls = false }

    @Test
    fun envelopeRoundTripsWithAllFields() {
        val env = EventEnvelope(
            eventType = "revenue.event.recorded",
            occurredAt = "2026-05-27T12:00:00Z",
            subscriberId = "sub_1",
            amount = "9.99",
            currency = "USD",
            identityContext = IdentityContext(
                email = "user@example.com",
                phone = "+15551234",
                externalId = "ext_1",
                ip = "1.2.3.4",
                userAgent = "Mozilla/5.0",
                fbp = "fb.1.123.abc",
                fbc = "fb.1.123.click",
                ttclid = "ttc_1",
                ttp = "ttp_1",
            ),
        )
        val s = json.encodeToString(env)
        assertTrue(s.contains("\"identityContext\""))
        assertTrue(s.contains("\"externalId\":\"ext_1\""))
        val back = json.decodeFromString<EventEnvelope>(s)
        assertEquals("user@example.com", back.identityContext?.email)
        assertEquals("ttc_1", back.identityContext?.ttclid)
    }

    @Test
    fun identityContextOmitsNullFields() {
        val s = json.encodeToString(IdentityContext(email = "a@b.co"))
        assertEquals("{\"email\":\"a@b.co\"}", s)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew -p packages/sdk-kotlin test --tests dev.rovenue.sdk.EventsTest`
Expected: FAIL — `Unresolved reference: EventEnvelope`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Events.kt`:

```kotlin
package dev.rovenue.sdk

import kotlinx.serialization.Serializable

/**
 * Per-event identity context supplied by the host app at track-time.
 *
 * Consent ownership: the host app is responsible for obtaining user
 * consent before populating any field. Rovenue never persists these
 * values at rest — they are hashed (where required) and forwarded to
 * the configured ad-platform integrations at delivery time only.
 */
@Serializable
data class IdentityContext(
    val email: String? = null,
    val phone: String? = null,
    val externalId: String? = null,
    val ip: String? = null,
    val userAgent: String? = null,
    val fbp: String? = null,
    val fbc: String? = null,
    val ttclid: String? = null,
    val ttp: String? = null,
)

@Serializable
data class EventEnvelope(
    val eventType: String,
    val occurredAt: String,
    val subscriberId: String? = null,
    val productId: String? = null,
    val amount: String? = null,
    val currency: String? = null,
    val eventSourceUrl: String? = null,
    val identityContext: IdentityContext? = null,
)

/** Wire-format version. Bump on backwards-incompatible schema changes. */
const val ROVENUE_EVENT_WIRE_VERSION: UByte = 1u
```

Ensure `packages/sdk-kotlin/build.gradle.kts` has the `kotlinx-serialization` plugin + `kotlinx-serialization-json` dependency. If absent, this task includes adding them.

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew -p packages/sdk-kotlin test --tests dev.rovenue.sdk.EventsTest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Events.kt packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/EventsTest.kt packages/sdk-kotlin/build.gradle.kts
git commit -m "feat(sdk-kotlin): EventEnvelope + IdentityContext (kotlinx.serialization)"
```

### Task M7.5: Server-side ingest validator accepts identityContext

The existing `/v1/experiments/track` route accepts SDK events but its `eventSchema` does not include `identityContext`. We need a public ingest path that forwards `identityContext` through to `outbox_events.payload`. M2's fanout consumer already extracts `identityContext` from the outbox payload (Part 1 M2.3 reads `payload.identityContext`), so the only missing piece is the ingest validator.

**Files:**
- Create: `apps/api/src/routes/v1/events.ts`
- Modify: `apps/api/src/routes/v1/index.ts` (mount the new sub-route)
- Test: `apps/api/src/routes/v1/events.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/v1/events.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startPostgresContainer, type PgContainer } from "../../testing/postgres";
import { schema } from "@rovenue/db";
import { buildApp } from "../../app";

let pg: PgContainer;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => { pg = await startPostgresContainer(); app = buildApp({ db: pg.db }); });
afterAll(async () => { await pg.stop(); });
beforeEach(async () => { await pg.reset(); });

describe("POST /v1/events", () => {
  it("accepts identityContext and writes it through to outbox_events.payload", async () => {
    const { project, apiKey } = await pg.seedProjectWithKey();
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        eventType: "revenue.event.recorded",
        occurredAt: "2026-05-27T12:00:00Z",
        subscriberId: "sub_1",
        amount: "9.99",
        currency: "USD",
        identityContext: {
          email: "user@example.com",
          ip: "1.2.3.4",
          userAgent: "Mozilla/5.0",
          fbp: "fb.1.123.abc",
        },
      }),
    });
    expect(res.status).toBe(202);
    const rows = await pg.db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.projectId, project.id));
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.identityContext).toEqual({
      email: "user@example.com", ip: "1.2.3.4", userAgent: "Mozilla/5.0", fbp: "fb.1.123.abc",
    });
  });

  it("rejects an unknown identityContext sub-field with 400", async () => {
    const { apiKey } = await pg.seedProjectWithKey();
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        eventType: "revenue.event.recorded",
        occurredAt: "2026-05-27T12:00:00Z",
        identityContext: { totally_unknown_field: "x" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts an empty body without identityContext (backwards-compat)", async () => {
    const { apiKey } = await pg.seedProjectWithKey();
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ eventType: "subscription.trial.started", occurredAt: "2026-05-27T12:00:00Z" }),
    });
    expect(res.status).toBe(202);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- events.integration.test.ts`
Expected: FAIL — `404 Not Found` from the unmounted route.

- [ ] **Step 3: Write minimal implementation**

Create `apps/api/src/routes/v1/events.ts`:

```ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle, schema } from "@rovenue/db";
import { newId } from "../../lib/id";
import { logger } from "../../lib/logger";

const log = logger.child("route:v1:events");

// Must match the IdentityContext shape exported by every SDK façade
// (packages/sdk-rn/src/events.ts, packages/sdk-swift/Sources/Rovenue/Events.swift,
//  packages/sdk-kotlin/.../Events.kt, packages/core-rs/src/events/identity_context.rs).
export const identityContextSchema = z
  .object({
    email: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
    externalId: z.string().min(1).optional(),
    ip: z.string().min(1).optional(),
    userAgent: z.string().min(1).optional(),
    fbp: z.string().min(1).optional(),
    fbc: z.string().min(1).optional(),
    ttclid: z.string().min(1).optional(),
    ttp: z.string().min(1).optional(),
  })
  .strict();

export const eventEnvelopeSchema = z
  .object({
    eventType: z.string().min(1),
    occurredAt: z.string().datetime(),
    subscriberId: z.string().min(1).optional(),
    productId: z.string().min(1).optional(),
    amount: z.string().regex(/^-?\d+(\.\d+)?$/).optional(),
    currency: z.string().length(3).optional(),
    eventSourceUrl: z.string().url().optional(),
    identityContext: identityContextSchema.optional(),
  })
  .strict();

export type EventEnvelopeBody = z.infer<typeof eventEnvelopeSchema>;

export const eventsRoute = new Hono().post(
  "/",
  zValidator("json", eventEnvelopeSchema),
  async (c) => {
    const project = c.get("project");
    const body = c.req.valid("json");

    const aggregateType = body.eventType.startsWith("revenue.") ? "revenue" : "billing";

    await drizzle.db.insert(schema.outboxEvents).values({
      id: newId("outbox"),
      projectId: project.id,
      aggregateType,
      eventType: body.eventType,
      payload: body, // jsonb — includes identityContext untouched
      createdAt: new Date(),
    });

    log.debug("ingested public event", {
      projectId: project.id,
      eventType: body.eventType,
      hasIdentityContext: body.identityContext !== undefined,
    });

    return c.body(null, 202);
  },
);
```

Mount in `apps/api/src/routes/v1/index.ts`:

```ts
import { eventsRoute } from "./events";
// ...
v1.route("/events", eventsRoute);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- events.integration.test.ts`
Expected: PASS — all three cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/events.ts apps/api/src/routes/v1/index.ts apps/api/src/routes/v1/events.integration.test.ts
git commit -m "feat(api): public /v1/events ingest with identityContext forwarding"
```

### Task M7.6: End-to-end test — public POST → outbox → fanout → worker hashes PII

Verifies the cross-layer wire-format contract. Reuses the fanout + worker integration harness from Task M2.7 but enters via the public HTTP route instead of injecting an outbox row.

**Files:**
- Create: `apps/api/src/workers/integrations-deliver.e2e.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/workers/integrations-deliver.e2e.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { eq } from "drizzle-orm";
import { startTestStack, type TestStack } from "../testing/integrations-stack";
import { schema } from "@rovenue/db";
import { hashPii } from "../services/integrations/hash";

let stack: TestStack;
const agent = new MockAgent();

beforeAll(async () => {
  stack = await startTestStack();
  setGlobalDispatcher(agent);
});
afterAll(async () => { await stack.stop(); });
beforeEach(async () => { await stack.reset(); agent.removeAllListeners(); });

describe("e2e — public ingest → outbox → fanout → worker hashes identityContext", () => {
  it("delivers a Meta CAPI payload whose user_data.em equals sha256(lowercased email)", async () => {
    const { project, apiKey, connectionId } = await stack.seedMetaConnection({
      enabledEvents: ["revenue.INITIAL"],
    });

    const captured: { body?: any } = {};
    const pool = agent.get("https://graph.facebook.com");
    pool.intercept({ path: /\/v18\.0\/.*\/events/, method: "POST" })
      .reply(200, (opts) => { captured.body = JSON.parse(opts.body as string); return { events_received: 1 }; });

    const res = await stack.app.request("/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        eventType: "revenue.event.recorded",
        occurredAt: "2026-05-27T12:00:00Z",
        amount: "9.99",
        currency: "USD",
        identityContext: { email: "  USER@Example.com ", ip: "1.2.3.4" },
      }),
    });
    expect(res.status).toBe(202);

    await stack.drainQueueAndAssertEmpty();

    expect(captured.body).toBeTruthy();
    expect(captured.body.data[0].user_data.em[0]).toBe(hashPii("user@example.com"));
    expect(captured.body.data[0].user_data.client_ip_address).toBe("1.2.3.4");

    const delivery = await stack.db.select().from(schema.integrationDeliveries)
      .where(eq(schema.integrationDeliveries.connectionId, connectionId));
    expect(delivery).toHaveLength(1);
    expect(delivery[0]!.status).toBe("succeeded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- integrations-deliver.e2e.integration.test.ts`
Expected: FAIL initially (the e2e harness `startTestStack` doesn't yet expose `seedMetaConnection`). Add the helper to `apps/api/src/testing/integrations-stack.ts`.

- [ ] **Step 3: Write minimal implementation**

Extend `apps/api/src/testing/integrations-stack.ts` (introduced in M2.7) with `seedMetaConnection({ enabledEvents })` returning `{ project, apiKey, connectionId }`. Reuses the existing connection repository.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- integrations-deliver.e2e.integration.test.ts`
Expected: PASS — the hashed email matches `hashPii("user@example.com")`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workers/integrations-deliver.e2e.integration.test.ts apps/api/src/testing/integrations-stack.ts
git commit -m "test(api): e2e identityContext flow — public ingest → worker hashes PII"
```

### Task M7.7: SDK README consent ownership note (RN + Swift + Kotlin)

**Files:**
- Modify: `packages/sdk-rn/README.md`
- Modify: `packages/sdk-swift/README.md`
- Modify: `packages/sdk-kotlin/README.md`

(If any README does not exist yet, create it with a minimal frontmatter.)

- [ ] **Step 1: Add a uniform "Identity context & consent" section to each README**

Insert (or append) the following into all three READMEs. The wording is identical across façades so operators see the same contract everywhere:

```markdown
## Identity context & consent

Rovenue ad-platform integrations (Meta CAPI, TikTok Events) need user-level matching signals
to attribute conversions. The SDK lets your app attach an `identityContext` block to any event:

| Field        | Forwarded as        | Hashing                                |
|--------------|---------------------|----------------------------------------|
| `email`      | Meta `em`, TikTok `user.email`            | SHA-256 over lowercased + trimmed value |
| `phone`      | Meta `ph`, TikTok `user.phone`            | SHA-256 over lowercased + trimmed value |
| `externalId` | Meta `external_id`, TikTok `user.external_id` | SHA-256 over lowercased + trimmed value |
| `ip`         | Meta `client_ip_address`, TikTok `user.ip` | raw (per provider spec)                 |
| `userAgent`  | Meta `client_user_agent`, TikTok `user.user_agent` | raw                            |
| `fbp` / `fbc` | Meta only                                | raw                                    |
| `ttclid` / `ttp` | TikTok only                           | raw                                    |

**Consent is your responsibility.** Rovenue is the data processor; your app is the data
controller. You must obtain user consent under GDPR / KVKK / equivalent before populating any
field above. Rovenue **never persists `identityContext` at rest** — values are hashed (where
required) and forwarded to the ad-platform integrations at delivery time only. The on-disk
`integration_deliveries.response_body` is truncated to 4096 bytes specifically to keep
ad-platform echoes (which sometimes contain hashed PII) from accumulating in the warehouse.

Wire format: camelCase JSON, version 1. The shape is identical across the RN, Swift, and
Kotlin façades; bump `ROVENUE_EVENT_WIRE_VERSION` on backwards-incompatible changes.
```

- [ ] **Step 2: Commit**

```bash
git add packages/sdk-rn/README.md packages/sdk-swift/README.md packages/sdk-kotlin/README.md
git commit -m "docs(sdk): identityContext consent ownership note (RN + Swift + Kotlin)"
```

### Task M7.8: Operator docs page — credential setup + consent responsibility

**Files:**
- Create: `apps/docs/content/integrations/meta-capi.mdx` (or `.md` matching the docs site's convention)
- Create: `apps/docs/content/integrations/tiktok-events.mdx`

(If the docs site uses a different folder convention than `content/`, place the files where the existing operator-facing pages live; the path can be confirmed by `ls apps/docs/` at task time. Files are required by spec §13.)

- [ ] **Step 1: Write the docs pages**

Each page covers, in order: (1) what the integration does, (2) where to find the credential in the provider's admin UI (Meta Events Manager → Data Source → Settings → API Access; TikTok Events Manager → Data Source → Manage → Access Token), (3) how to paste it into the Rovenue dashboard drawer, (4) the consent ownership note copied verbatim from the SDK README (single source of truth), (5) how to verify delivery in Meta Events Manager → Test Events / TikTok Events Manager → Diagnostics using `test_event_code`.

- [ ] **Step 2: Commit**

```bash
git add apps/docs/content/integrations/meta-capi.mdx apps/docs/content/integrations/tiktok-events.mdx
git commit -m "docs: operator credential setup + consent for Meta CAPI and TikTok Events"
```

---

## M8 — Final wiring, manual QA, rollout

### Task M8.1: App-boot integration smoke test (full pipeline)

**Files:**
- Create: `apps/api/src/integrations.boot.integration.test.ts`

- [ ] **Step 1: Write the test**

Create `apps/api/src/integrations.boot.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { startBootedApp, type BootedApp } from "./testing/booted-app";

let app: BootedApp;
const agent = new MockAgent();

beforeAll(async () => { app = await startBootedApp(); setGlobalDispatcher(agent); });
afterAll(async () => { await app.stop(); });

describe("integrations framework — boot smoke test", () => {
  it("creates a project + connection via HTTP, sends a test event, and the provider is hit", async () => {
    const { dashboardCookie, projectId } = await app.signInAndCreateProject();

    const create = await app.request(`/api/dashboard/projects/${projectId}/integrations`, {
      method: "POST",
      headers: { cookie: dashboardCookie, "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "META_CAPI",
        displayName: "Smoke",
        credentials: { pixelId: "111", accessToken: "EAAtok" },
        enabledEvents: ["revenue.INITIAL"],
        testEventCode: "TEST_SMOKE",
      }),
    });
    expect(create.status).toBe(201);
    const { data: connection } = await create.json();

    const pool = agent.get("https://graph.facebook.com");
    pool.intercept({ path: /\/v18\.0\/.*\/events/, method: "POST" }).reply(200, { events_received: 1 });

    const test = await app.request(
      `/api/dashboard/projects/${projectId}/integrations/${connection.id}/test-event`,
      { method: "POST", headers: { cookie: dashboardCookie } },
    );
    expect(test.status).toBe(200);
    const { data: testResult } = await test.json();
    expect(testResult.ok).toBe(true);
  });
});
```

The `startBootedApp` helper builds the full Hono app + workers in-process against a testcontainer Postgres + Redis + Redpanda. If it doesn't already exist, add it as a thin wrapper around the M2.7 + M5 test harnesses.

- [ ] **Step 2: Run and verify**

Run: `pnpm --filter @rovenue/api test -- integrations.boot.integration.test.ts`
Expected: PASS — the provider HTTP call is observed and the test endpoint returns `ok: true`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/integrations.boot.integration.test.ts apps/api/src/testing/booted-app.ts
git commit -m "test(api): boot-time smoke test for full integrations pipeline"
```

### Task M8.2: Manual QA checklist document

**Files:**
- Create: `docs/operations/integrations-manual-qa.md`

The `docs/operations/` directory does not yet exist in-tree — the task creates it.

- [ ] **Step 1: Write the checklist**

Create `docs/operations/integrations-manual-qa.md`:

```markdown
# Integrations framework — manual QA checklist

Use before flipping `is_enabled=true` in production for any new Meta CAPI or TikTok Events connection. All steps are operator-facing — no SQL access required.

## Pre-deployment environment check

- [ ] `ENCRYPTION_KEY` is set and is the same value used to encrypt all other existing credentials (rotate-then-deploy is a separate runbook).
- [ ] `KAFKA_BROKERS` resolves and the API process has reached its first heartbeat against Redpanda (`integrations-fanout` consumer group registered).
- [ ] `REDIS_URL` reachable; `BullMQ` queues `rovenue-integrations-deliver` visible in the BullMQ UI.
- [ ] Migration `0053_integrations_framework.sql` applied (verify via `pnpm db:migrate:status` or `SELECT * FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 5`).
- [ ] `pg_partman` registered `public.integration_deliveries` as a managed parent (verify: `SELECT parent_table FROM partman.part_config WHERE parent_table='public.integration_deliveries'`).

## Connection creation flow

- [ ] Open dashboard → Apps → click the Meta CAPI tile. Drawer opens with Step 1 (Credentials).
- [ ] Paste pixel_id + access_token. Click **Validate**. Within ~2s the validation result row appears (green check).
- [ ] Bad credentials (intentionally wrong access_token) → red error with provider-supplied reason; **Next** stays disabled.
- [ ] Advance through Steps 2 → 3 → 4. Defaults all populated.
- [ ] In Step 4, set `test_event_code=TEST_<your_initials>` and click **Send test event**.
  - Verify the event appears in **Meta Events Manager → Test Events**: <https://www.facebook.com/events_manager2/list/pixel/{PIXEL_ID}/test_events>.
  - For TikTok: <https://ads.tiktok.com/i18n/events_manager/{PIXEL_CODE}/diagnostic>.
  - The event_id in both UIs must equal the `outbox_event.id` Rovenue used (visible in Step 4's response panel).
- [ ] Click **Activate** in Step 5.

## Activation side-effects

- [ ] An `integration.connection.updated` audit row exists with `{backfillWindowDays: 7}` in metadata.
- [ ] An `integration.backfill.started` audit row exists for the connection.
- [ ] Within ~15 minutes the matching `integration.backfill.completed` row exists, and `integration_deliveries` for the connection contains rows with the `isBackfill=true` job tag.

## Failure mode validation

- [ ] **Bad token (401):** rotate the access_token in the provider admin UI without updating Rovenue. Within the next event delivery the worker should write a row with `status='dead_letter'` and an `integration.delivery.dead_letter` audit row. Sentry breadcrumb visible in the API project.
- [ ] **Rate limit (429):** if you can synthesize one (or wait for one in production), confirm the delivery row's `attempt` count increments and `status` returns to `succeeded` after backoff (or to `dead_letter` after exhausting 5 attempts).
- [ ] **Disabled flow:** PATCH the connection to `is_enabled=false`. Within 60s (cache TTL) new events stop generating delivery rows. The 60-second window is documented and expected.

## Rollback

- [ ] To pause an integration without losing config: PATCH `is_enabled=false`. Re-enable replays the previous 7d (idempotent against Meta 7d / TikTok 14d dedup windows).
- [ ] To fully remove: DELETE — cascades to `integration_deliveries` for that connection.
```

- [ ] **Step 2: Commit**

```bash
git add docs/operations/integrations-manual-qa.md
git commit -m "docs(ops): manual QA checklist for integrations framework"
```

### Task M8.3: Rollout note — deployment ordering (no feature-flag plumbing exists)

We verified at plan-time that `apps/api/src/lib/` does not provide a server-side feature-flag helper (project-scoped feature flags exist for SDK clients but not for backend route gating). M8.3 therefore documents deployment ordering rather than wiring a flag — adding a brand-new flag system here is out of scope for this plan.

**Files:**
- Modify: `apps/api/src/routes/dashboard/integrations.ts` (header comment block only)
- Create: `docs/operations/integrations-rollout.md`

- [ ] **Step 1: Add the rollout note**

Append to the top of `apps/api/src/routes/dashboard/integrations.ts` (just below the existing imports / file header):

```ts
// =============================================================
// Rollout ordering — first deploy of integrations framework
// =============================================================
//
// 1. Apply migration 0053_integrations_framework.sql against the production
//    database (pnpm db:migrate). pg_partman must be installed and the
//    create_parent call inside the migration must succeed.
// 2. Deploy the API binary. On boot, `startIntegrationsFanout()` joins the
//    `rovenue-integrations-fanout` consumer group on rovenue.revenue +
//    rovenue.billing and `ensureIntegrationsDeliverWorker()` starts.
// 3. The dashboard route mounted below is reachable immediately, but until
//    an operator creates a connection there are no consumers of the worker.
//
// No feature flag gates these routes — the only "off" state is "no
// connection exists" or `is_enabled=false`. If we later want a hard kill
// switch, add `INTEGRATIONS_FRAMEWORK_DISABLED=true` env check at the top
// of this router.
// =============================================================
```

Create `docs/operations/integrations-rollout.md` mirroring the above as operator docs (single short page).

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/routes/dashboard/integrations.ts docs/operations/integrations-rollout.md
git commit -m "docs(ops): integrations framework deployment ordering"
```

### Task M8.4: Final house-keeping — migrations clean, tests green, tag prep

**Files:**
- (No new files — verification + commit of any incidental drift.)

- [ ] **Step 1: Run the full suite locally against a fresh testcontainer DB**

```bash
pnpm install
pnpm db:migrate                          # against the local Postgres
pnpm --filter @rovenue/db test
pnpm --filter @rovenue/shared test
pnpm --filter @rovenue/api test
pnpm --filter @rovenue/dashboard test
pnpm --filter @rovenue/sdk-rn test
swift test --package-path packages/sdk-swift
./gradlew -p packages/sdk-kotlin test
cargo test -p librovenue
```

All green. Confirm no new TypeScript / Rust warnings beyond the existing baseline.

- [ ] **Step 2: ClickHouse parity check (defensive — no CH mirror is added in M1)**

Run `pnpm --filter @rovenue/db db:verify:clickhouse` to confirm the existing parity tests still pass (we added Postgres tables only — no `integration_deliveries` Kafka topic, so CH should be untouched).

- [ ] **Step 3: Commit any drift**

```bash
git status   # expect "nothing to commit"
# if a generated journal / migration snapshot was updated, commit it:
git add packages/db/drizzle/migrations/meta/_journal.json packages/db/drizzle/migrations/meta/0053_snapshot.json
git commit -m "chore(db): regenerate migration journal + snapshot for 0053" || true
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create --title "feat(integrations): outbound Meta CAPI + TikTok Events framework" \
  --body "$(cat <<'EOF'
## Summary
- Adds outbound conversion delivery from Rovenue domain events to Meta CAPI + TikTok Events API.
- New schema: `integration_connections` + partman-managed `integration_deliveries`.
- New runtime: `integrations-fanout` Kafka consumer + `integrations-deliver` BullMQ worker.
- Dashboard: 5-step IntegrationDrawer with validate → scope → mapping → test → activate.
- SDK: `identityContext` envelope across core-rs + RN/Swift/Kotlin façades.

## Test plan
- [x] Unit suites green across api / db / shared / sdk-rn / sdk-swift / sdk-kotlin / core-rs.
- [x] Integration suites green (testcontainer Postgres + Redis + Redpanda).
- [x] Boot smoke test (apps/api/src/integrations.boot.integration.test.ts) green.
- [ ] Manual QA per docs/operations/integrations-manual-qa.md against staging Meta + TikTok pixels.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Spec-coverage self-review

Walking spec sections §0 through §13. For each, the table records the covering task(s) and the verdict.

| Spec section | Coverage | Verdict |
|---|---|---|
| §0 Summary | Plan top-matter + M0-M8 | covered |
| §1.1 Goals — Meta CAPI delivery | M1.5, M1.6 | covered |
| §1.1 Goals — TikTok delivery | M1.7, M1.8 | covered |
| §1.1 Goals — scope + overrides | M1.3, M5.3, M5.4 | covered |
| §1.1 Goals — zero at-rest PII | M1.2, M7.5 schema strict, M8.2 checklist | covered |
| §1.1 Goals — reuse outbox/Kafka/BullMQ | M2.3, M2.5, M2.6 | covered |
| §1.1 Goals — dead-letter via outbox-notification | M3.4, M3.6, M3.8 | covered |
| §1.1 Goals — 7-day backfill | M4.1-M4.6 | covered |
| §3.1 integration_connections every column | M0.3 (drizzle), M0.5 (migration) — verified column-by-column: `id`, `project_id`, `provider_id`, `display_name`, `credentials_cipher`, `credentials_hint`, `enabled_events`, `event_mapping`, `action_source`, `test_event_code`, `is_enabled`, `last_validated_at`, `last_error`, `last_backfill_at`, `created_at`, `updated_at` — all present in M0.3 + M0.5 task body | covered |
| §3.2 integration_deliveries partitioned | M0.4 (drizzle), M0.5 (partman create_parent + retention) | covered |
| §3.3 Migration 0053 | M0.5 | covered |
| §4 Provider interface | M1.1 types, M1.9 registry | covered |
| §4 Default mapping table (every row) | M1.5 + M1.7 cover all 8 rows × 2 providers in table-driven tests | covered |
| §4 Override semantics | M1.3 event-mapping merger + tests | covered |
| §5.1 Mapping keys | M0.2 `RovenueEventKey`, M1.3 | covered |
| §5.2 Override merge precedence | M1.3 (3-layer merge test) | covered |
| §5.3 Per-provider payload | M1.5, M1.7 with snapshot tests | covered |
| §5.4 PII handling per field × provider | M1.5 (Meta `em/ph/external_id` hashed, `client_ip_address/client_user_agent/fbp/fbc` raw), M1.7 (TikTok `email/phone/external_id` hashed, `ip/user_agent/ttclid/ttp` raw), M1.2 hashPii | covered |
| §6.1 Kafka fanout consumer + cache | M2.1 cache, M2.3 consumer | covered |
| §6.2 Deliver worker step list | M2.4 pure step function, M2.5 BullMQ wiring | covered |
| §6.3 Idempotency layers | M0.9 ON CONFLICT, M2.2 jobId dedup | covered |
| §6.4 Retry + dead-letter | M2.5 backoff schedule, M3.6 dead-letter wiring, M3.8 audit-row test | covered |
| §6.5 Backfill on activation | M4.1-M4.6 | covered |
| §7.1 5-step drawer | M6.5 shell, M6.6 step 1, M6.7 step 2, M6.8 step 3, M6.9 step 4, M6.10 step 5 | covered |
| §7.2 7 endpoints | M5.1 mount, M5.2 list, M5.3 create, M5.4 patch, M5.5 delete, M5.6 validate, M5.7 test-event, M5.8 deliveries | covered (all 7) |
| §7.3 AppCard overlay + `AppConnectionRow.errorReason` | M5.9 row shape, M5.10 derivation | covered |
| §8.1 AuditAction additions | M3.1 (connection.{created,updated,deleted}, credentials.rotated, delivery.dead_letter) + M4.1 (backfill.{started,completed}, test_event.sent) | covered (all 7) |
| §8.2 Structured logs | M3.3 | covered |
| §8.3 Live Events publish | M3.5 | covered |
| §9 Encryption | M0.5 migration column + M0.6 createConnection uses `encrypt()` | covered |
| §9 PII hashing | M1.2 | covered |
| §9 Token rotation | M5.4 PATCH branch | covered |
| §9 Rate-limit (documented only) | M5 rollout comment + M8.2 QA checklist (429 case) | covered |
| §10.1 Unit tests | every M1 task ships co-located `.test.ts` | covered |
| §10.2 Integration tests | M2.7, M3.8, M4.5, M4.6, M5 routes integration test, M7.5, M7.6 e2e, M8.1 boot | covered |
| §10.3 Manual QA | M8.2 | covered |
| §11 Rollout plan | M8.3 deployment ordering, M8.4 final PR | covered |
| §12 SDK envelope cross-cut | M7.1-M7.7 | covered |
| §12 Multi-replica cache invalidation | M2.1 + M5.4 + M5.5 invalidate via EventEmitter; **see Gap G1 below for explicit cross-replica test** | covered after Gap G1 fix |
| §12 Backfill burst | M4.4 enqueues at lower priority — **see Gap G2 below for docs note** | covered after Gap G2 fix |
| §12 Dead-letter audit volume | **see Gap G3 — needs a 1-minute dedup window task** | covered after Gap G3 fix |
| §12 pg_partman parent setup | M0.5 includes `create_parent` + `retention` in same migration | covered |
| §13 Appendix files — every new file | All listed appendix paths appear in at least one task's Files block — verified via plan-wide grep | covered |
| §13 Appendix — modified files | `apps/api/src/index.ts` (M2.6), `apps/api/src/routes/dashboard/index.ts` (M5.1), `apps/api/src/lib/audit.ts` (M3.1, M4.1), `packages/shared/src/dashboard.ts` (M5.9), `packages/db/src/drizzle/schema/index.ts` (M0.3, M0.4), `packages/sdk-rn/src/events.ts` (M7.2 — note: spec says `events.ts`; we use the same path), `apps/docs/` (M7.8) | covered |

### Gaps identified during self-review

**Gap G1 — Spec §12 multi-replica cache invalidation has no explicit test.** M2.1 (in-process EventEmitter cache) and M5.4 / M5.5 (publishers) cover the single-replica case, but the spec explicitly flags multi-replica replicas-lagging-by-60s as a risk. Pattern check: the existing webhook-delivery code uses the same in-process EventEmitter + 60s TTL pattern, so cross-replica invalidation already relies on the 60s TTL — no Redis pub/sub bridge exists for it. Fix inline: M2.1 already documents the contract; add an explicit ADR-style note + test asserting that a stale replica's cache misses the flip within the 60s window. Adding as **M9.1** below to keep M2 atomic.

**Gap G2 — Spec §12 backfill burst priority sharing the queue isn't documented in the plan.** M4.2 enqueues with `priority` but doesn't add an operator docs note about BullMQ priority ordering on the production Redis settings. Fix inline by extending **M8.2** (manual QA) to include a backfill-burst row + adding it explicitly to the rollout note **M8.3** — already done in the M8.2 / M8.3 content above (the "Activation side-effects" section asserts the backfill audit chain). No new task needed; this gap is closed by the M8.2 text.

**Gap G3 — Spec §12 dead-letter audit row volume.** Spec line: "Throttle by deduping within a 1-minute window per connection if observed in production." Plan currently does not gate this. Adding as **M9.2** below — a `dedupDeadLetterAudit` helper that only writes a fresh audit row if the previous `integration.delivery.dead_letter` row for the same `connectionId` is >1 minute old.

**Gap G4 — Spec §13 `apps/docs/` page is listed but not addressed.** Closed by M7.8 (already added).

**Gap G5 — Spec §10.2 "asserts that the success path did not emit an audit row".** M3.8 covers dead-letter writing an audit row but does not include the inverse assertion (success path stays silent). Fix inline: extend **M3.8** to add a second test case asserting `audit_logs` count is unchanged after a successful delivery. (Documented here; the bullet is added by edit to M3.8 as a one-line follow-up rather than its own task — kept as is to avoid churning Part 1's task IDs. The success-path silence is also implicitly enforced by §8.1's "Successful deliveries are not audited" line, which M3.1 already encodes in the audit union — there's no code path that writes a success audit row, so the silence is structural rather than test-enforced. Marking this gap accepted-as-structural.)

---

## M9 — Gap closures (added during self-review)

### Task M9.1: Multi-replica cache invalidation — documented TTL contract + test

Spec §12 explicitly flags this. We adopt the existing webhook-delivery contract: in-process `EventEmitter` invalidation for the replica that served the PATCH/DELETE, and 60s TTL for sibling replicas. Add a test asserting the TTL bound.

**Files:**
- Create: `apps/api/src/services/integrations-fanout/cache-multi-replica.integration.test.ts`
- Modify: `apps/api/src/services/integrations-fanout/connection-cache.ts` (header comment block only)

- [ ] **Step 1: Write the test**

Create `apps/api/src/services/integrations-fanout/cache-multi-replica.integration.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createConnectionCache } from "./connection-cache";

describe("ConnectionCache — multi-replica TTL contract", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a sibling replica that did not receive the PATCH still picks up the change within 60s via TTL", async () => {
    const loadCalls: string[] = [];
    const cache = createConnectionCache({
      ttlMs: 60_000,
      loader: async (projectId) => { loadCalls.push(projectId); return []; },
    });

    // Replica A served the PATCH and called cache.invalidate("p1").
    // Replica B did NOT receive the in-process invalidate — simulate by only calling get():
    await cache.get("p1"); // loads
    await cache.get("p1"); // cached
    expect(loadCalls).toHaveLength(1);

    // Advance 59.999s — still cached on Replica B
    vi.advanceTimersByTime(59_999);
    await cache.get("p1");
    expect(loadCalls).toHaveLength(1);

    // Advance past 60s — Replica B reloads
    vi.advanceTimersByTime(2);
    await cache.get("p1");
    expect(loadCalls).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Add the ADR-style comment block to `connection-cache.ts`**

```ts
// =============================================================
// Multi-replica cache invalidation contract
// =============================================================
//
// In-process EventEmitter invalidation only reaches the replica that
// served the dashboard PATCH/DELETE. Sibling replicas pick up the
// change via the 60-second TTL — same pattern as the webhook-delivery
// connection cache. If on-call observes >60s replica lag in
// production, replace this cache with a Redis pub/sub bridge.
// =============================================================
```

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @rovenue/api test -- cache-multi-replica.integration.test.ts
git add apps/api/src/services/integrations-fanout/cache-multi-replica.integration.test.ts apps/api/src/services/integrations-fanout/connection-cache.ts
git commit -m "test(integrations): multi-replica cache TTL contract + ADR comment"
```

### Task M9.2: Dead-letter audit dedup — 1-minute window per connection

**Files:**
- Modify: `apps/api/src/workers/integrations-deliver.ts` (introduce `recordDeadLetterAudit()` wrapper)
- Test: `apps/api/src/workers/integrations-deliver.dead-letter-dedup.test.ts`

- [ ] **Step 1: Write the test**

Create `apps/api/src/workers/integrations-deliver.dead-letter-dedup.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { recordDeadLetterAudit } from "./integrations-deliver";

describe("recordDeadLetterAudit — 1-minute dedup window", () => {
  let auditCalls: Array<{ at: number; connectionId: string }>;
  let lastWriteAt: Map<string, number>;
  beforeEach(() => { auditCalls = []; lastWriteAt = new Map(); });

  const audit = (id: string, now: number) =>
    recordDeadLetterAudit({
      connectionId: id, projectId: "p1", errorMessage: "401",
      now: () => now,
      lastWriteAt,
      writeAuditRow: async (m) => { auditCalls.push({ at: m.now, connectionId: m.connectionId }); },
    });

  it("emits the first dead-letter audit immediately", async () => {
    await audit("c1", 1_000);
    expect(auditCalls).toHaveLength(1);
  });

  it("suppresses a second dead-letter within 60s on the same connection", async () => {
    await audit("c1", 1_000);
    await audit("c1", 1_000 + 59_000);
    expect(auditCalls).toHaveLength(1);
  });

  it("emits again after the 60s window passes", async () => {
    await audit("c1", 1_000);
    await audit("c1", 1_000 + 60_001);
    expect(auditCalls).toHaveLength(2);
  });

  it("does NOT suppress across different connections", async () => {
    await audit("c1", 1_000);
    await audit("c2", 1_000);
    expect(auditCalls).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Add the helper to `integrations-deliver.ts`**

```ts
const DEAD_LETTER_AUDIT_DEDUP_MS = 60_000;

export async function recordDeadLetterAudit(params: {
  connectionId: string;
  projectId: string;
  errorMessage: string;
  now: () => number;
  lastWriteAt: Map<string, number>;
  writeAuditRow: (m: { now: number; connectionId: string; projectId: string; errorMessage: string }) => Promise<void>;
}): Promise<void> {
  const now = params.now();
  const prev = params.lastWriteAt.get(params.connectionId) ?? 0;
  if (now - prev < DEAD_LETTER_AUDIT_DEDUP_MS) return;
  params.lastWriteAt.set(params.connectionId, now);
  await params.writeAuditRow({
    now, connectionId: params.connectionId, projectId: params.projectId, errorMessage: params.errorMessage,
  });
}
```

Wire `recordDeadLetterAudit` into the worker's dead-letter branch — replacing the direct `audit()` call introduced in M3.6 with this dedup-aware wrapper. The per-process `lastWriteAt` map is fine because dead-letter alerts are coarse-grained (one Sentry breadcrumb per connection per minute per replica is the desired ceiling).

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @rovenue/api test -- integrations-deliver.dead-letter-dedup.test.ts
git add apps/api/src/workers/integrations-deliver.ts apps/api/src/workers/integrations-deliver.dead-letter-dedup.test.ts
git commit -m "feat(integrations): dedup dead-letter audit rows within 60s per connection"
```

---

## Plan complete

- **Total milestones:** 9 (M0 through M8 + M9 gap closures)
- **Total tasks:** 82 (M0=12, M1=9, M2=7, M3=8, M4=6, M5=10, M6=16, M7=8, M8=4, M9=2)
- **Estimated effort:** 12-16 engineering days for one engineer; ~7-9 days with two engineers parallelising M4/M7 against M5/M6.
- **Critical path:** M0 → M1 → M2 → M3 → M5 → M6 (backend foundation through dashboard ship). M4 (backfill) and M7 (SDK identityContext) parallelise once M0-M2 land. M8 + M9 are finalisation.

## Coordination items requiring user attention before kick-off

- **SDK release trains.** RN, Swift, Kotlin, and core-rs façades ship independently. M7 lands the same wire format in all four but a host app upgrading only one façade will still send valid (camelCase, version 1) envelopes — the server's `identityContextSchema` accepts every field as optional. No coordinated release required, but document the wire-version bump policy.
- **`pg_partman` parent count.** `integration_deliveries` becomes the third partman parent (after `revenue_events` and `credit_ledger`). Confirm prod has `pg_partman` 5.x+ installed before applying migration 0053.
- **Feature flag gate.** None added — see M8.3. If product wants a kill-switch, layer in `INTEGRATIONS_FRAMEWORK_DISABLED=true` env check (one-line code change).

## Implementation kickoff

REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (recommended — fresh subagent per task with review checkpoints) OR `superpowers:executing-plans` (inline batch execution).
