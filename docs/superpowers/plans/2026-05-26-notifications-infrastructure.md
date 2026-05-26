# Notifications Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an end-to-end operational notification pipeline (SES email + APNs/FCM push + in-app feed), per-user/per-project preferences, RFC 8058 unsubscribe, and the dashboard surfaces (bell dropdown, inbox, prefs, project defaults).

**Architecture:** Outbox → Kafka (`rovenue.notifications`) → standalone `notifier-worker` process → fan-out to email (BullMQ → SES/SMTP), push (BullMQ → APNs/FCM), and the `notifications` table. Templates live in a new `packages/email-templates` workspace package and back both email and push body rendering with i18n.

**Tech Stack:**
- Backend: Hono + TypeScript, Drizzle ORM, Postgres 16, Kafka/Redpanda (kafkajs), BullMQ + Redis
- Email: invite-spec `Mailer` interface + `SesMailer` (`@aws-sdk/client-sesv2`); new `SmtpMailer` (nodemailer)
- Push: `@parse/node-apn`-compatible APNs HTTP/2 client; `firebase-admin/messaging` for FCM
- Templates: React Email + `i18next` (server-side, no React context required at runtime)
- Frontend: React + TanStack Router/Query, TypeScript
- Tests: Vitest unit + integration (testcontainers)

**Source spec:** `docs/superpowers/specs/2026-05-26-notifications-design.md`

**Hard dependency:** This plan assumes the `2026-05-26-project-members-invite-design.md` work has merged first. Specifically it consumes:

- `MemberRole` enum with five values (`OWNER, ADMIN, DEVELOPER, GROWTH, CUSTOMER_SUPPORT`)
- `apps/api/src/lib/mailer.ts` (`Mailer` interface + `SesMailer`)
- `notification_suppression_list` table + helper
- `apps/api/src/lib/email-templates/` initial templates directory (which Phase 5 migrates into `packages/email-templates`)

If the invite plan is not yet merged at execution time, stop and merge it first.

---

## Phase ordering

Phases end green (tests pass, app boots). Phases 1–4 are foundation; producers do not yet emit notifications. Phase 5–9 stand up rendering + transports + the worker. Phases 10–11 ship the digest and the public webhooks. Phases 12–13 expose the API + dashboard. Phase 14 wires the existing producers to actually emit. Phase 15 ships deploy + observability.

1. **Phase 1 — Schema foundations.** New tables, JSONB restructure migration, drizzle-kit migration, repos.
2. **Phase 2 — Event catalog + types.** Code-level catalog, shared types in `packages/shared`.
3. **Phase 3 — Outbox `NOTIFICATION` aggregate type.** Dispatcher routing + producer helper.
4. **Phase 4 — Preference resolver.** Cascade logic + forced-channel handling + unit tests.
5. **Phase 5 — `packages/email-templates` workspace package.** Layout, registry, locales, first template.
6. **Phase 6 — Remaining templates (15 events).** All event templates in tr + en.
7. **Phase 7 — Email transport integration.** SMTP fallback, suppression pre-check, List-Unsubscribe header.
8. **Phase 8 — Push transports + `push_devices`.** APNs + FCM transports, token revocation.
9. **Phase 9 — Notifier worker.** Kafka consumer, recipient resolution, render, insert, enqueue.
10. **Phase 10 — BullMQ send workers.** `notifier:send-email` + `notifier:send-push` consumers.
11. **Phase 11 — Digest scheduler.** Two BullMQ crons, tz enumeration, KPI fetch, emission.
12. **Phase 12 — SES feedback + unsubscribe public flow.** SNS webhook, JWT unsubscribe.
13. **Phase 13 — Dashboard API endpoints.** Feed CRUD, prefs, push-devices, project defaults, test-send.
14. **Phase 14 — Dashboard frontend.** Bell, inbox, prefs restructure, project defaults, unsubscribe SPA.
15. **Phase 15 — Producer wiring + deploy + observability.** Wire existing domain code to `emitNotification`, docker-compose service, Prometheus metrics, runbooks.

---

## File map

### Created

**Migrations & schema:**
- `packages/db/drizzle/migrations/<next>_notifications_schema.sql`
- `packages/db/drizzle/migrations/<next+1>_user_preferences_restructure.sql`
- `packages/db/src/drizzle/schema.ts` — add tables (modify)
- `packages/db/src/drizzle/repositories/notifications.ts`
- `packages/db/src/drizzle/repositories/notification-preferences.ts`
- `packages/db/src/drizzle/repositories/notification-deliveries.ts`
- `packages/db/src/drizzle/repositories/push-devices.ts`

**Shared types & catalog:**
- `packages/shared/src/notifications/event-catalog.ts`
- `packages/shared/src/notifications/api-schemas.ts`
- `packages/shared/src/notifications/types.ts`

**Templates package (new workspace):**
- `packages/email-templates/package.json`
- `packages/email-templates/tsconfig.json`
- `packages/email-templates/src/index.ts`
- `packages/email-templates/src/registry.ts`
- `packages/email-templates/src/i18n.ts`
- `packages/email-templates/src/layouts/base-layout.tsx`
- `packages/email-templates/src/revenue/digest-daily.tsx`
- `packages/email-templates/src/revenue/digest-weekly.tsx`
- `packages/email-templates/src/revenue/anomaly-detected.tsx`
- `packages/email-templates/src/revenue/churn-spike.tsx`
- `packages/email-templates/src/revenue/milestone-hit.tsx`
- `packages/email-templates/src/billing/refund-detected.tsx`
- `packages/email-templates/src/billing/credit-low-balance.tsx`
- `packages/email-templates/src/billing/invoice-failed.tsx`
- `packages/email-templates/src/billing/invoice-paid.tsx`
- `packages/email-templates/src/integration/store-credential-expired.tsx`
- `packages/email-templates/src/integration/webhook-failing.tsx`
- `packages/email-templates/src/team/invited.tsx` *(moved from invite spec location)*
- `packages/email-templates/src/team/role-changed.tsx`
- `packages/email-templates/src/team/removed.tsx`
- `packages/email-templates/src/security/signin-new-device.tsx`
- `packages/email-templates/src/security/oauth-account-linked.tsx`
- `packages/email-templates/locales/en/*.json` (one per event + common)
- `packages/email-templates/locales/tr/*.json`

**API services & workers:**
- `apps/api/src/services/notifications/emit.ts`
- `apps/api/src/services/notifications/resolve-prefs.ts`
- `apps/api/src/services/notifications/recipient-resolver.ts`
- `apps/api/src/services/notifications/render.ts`
- `apps/api/src/services/notifications/suppression.ts` *(thin wrapper around invite-spec suppression list)*
- `apps/api/src/lib/push/transport.ts`
- `apps/api/src/lib/push/apns.ts`
- `apps/api/src/lib/push/fcm.ts`
- `apps/api/src/lib/push/index.ts`
- `apps/api/src/lib/mailer-smtp.ts` *(SMTP fallback impl of the invite-spec `Mailer` interface)*
- `apps/api/src/lib/unsubscribe-token.ts`
- `apps/api/src/workers/notifier.ts`
- `apps/api/src/workers/notifier-entry.ts`
- `apps/api/src/workers/digest-scheduler.ts`
- `apps/api/src/workers/send-email-worker.ts`
- `apps/api/src/workers/send-push-worker.ts`
- `apps/api/src/queues/notifier.ts`

**API routes:**
- `apps/api/src/routes/dashboard/notifications/index.ts`
- `apps/api/src/routes/dashboard/notifications/preferences.ts`
- `apps/api/src/routes/dashboard/push-devices.ts`
- `apps/api/src/routes/dashboard/project-notification-defaults.ts`
- `apps/api/src/routes/public/unsubscribe.ts`
- `apps/api/src/routes/internal/ses-feedback.ts`
- `apps/api/src/routes/internal/notification-test.ts`

**Dashboard:**
- `apps/dashboard/src/lib/hooks/useNotifications.ts`
- `apps/dashboard/src/lib/hooks/useNotificationPreferences.ts`
- `apps/dashboard/src/lib/hooks/usePushDevices.ts`
- `apps/dashboard/src/lib/hooks/useProjectNotificationDefaults.ts`
- `apps/dashboard/src/components/notifications/bell-dropdown.tsx`
- `apps/dashboard/src/components/notifications/notification-row.tsx`
- `apps/dashboard/src/components/notifications/event-toggle-list.tsx`
- `apps/dashboard/src/components/notifications/device-list.tsx`
- `apps/dashboard/src/routes/_authed/account/notifications/inbox.tsx`
- `apps/dashboard/src/routes/_authed/projects/$projectId/settings/notifications.tsx`
- `apps/dashboard/src/routes/unsubscribe.tsx`

**Tests:** mirror created sources under `*.test.ts` / `*.integration.test.ts`.

### Modified

- `packages/db/src/drizzle/schema.ts` (new tables + JSONB shape comment)
- `packages/db/src/drizzle/enums.ts` (delivery status / channel enums)
- `apps/api/src/workers/outbox-dispatcher.ts:90` (add `NOTIFICATION` mapping)
- `apps/api/src/routes/v1/team.ts` *(or wherever team API lives — Phase 14 wiring)*
- `apps/api/src/lib/better-auth.ts` *(sign-in hook — Phase 14)*
- `apps/api/src/services/receipt-verify.ts` *(store cred expired — Phase 14)*
- `apps/api/src/services/webhook-processor.ts` *(refund detect — Phase 14)*
- `apps/api/src/workers/outgoing-webhooks.ts` *(webhook failing — Phase 14)*
- `apps/api/src/lib/env.ts` (new env vars)
- `apps/api/src/index.ts` (mount new routes)
- `apps/dashboard/src/components/dashboard/topbar.tsx` (wire bell)
- `apps/dashboard/src/routes/_authed/account/notifications.tsx` (restructure)
- `apps/dashboard/src/i18n/locales/en/account.json` (new keys)
- `apps/dashboard/src/i18n/locales/tr/account.json` (new keys)
- `pnpm-workspace.yaml` (register `packages/email-templates`)
- `turbo.json` (build pipeline includes new package)
- `deploy/docker-compose.yml` (new `notifier-worker` service)
- `.env.example` (new env vars)

---

## Phase 1 — Schema foundations

### Task 1.1: Add notification enum types

**Files:**
- Modify: `packages/db/src/drizzle/enums.ts`
- Create: `packages/db/drizzle/migrations/<next>_notification_enums.sql`

- [ ] **Step 1: Add enums to drizzle definitions**

Edit `packages/db/src/drizzle/enums.ts`, append after the existing enums:

```ts
export const notificationChannel = pgEnum("NotificationChannel", [
  "email",
  "push",
  "inapp",
]);

export const notificationDeliveryStatus = pgEnum("NotificationDeliveryStatus", [
  "queued",
  "sent",
  "delivered",
  "bounced",
  "failed",
  "suppressed",
]);

export const pushPlatform = pgEnum("PushPlatform", ["ios", "android"]);
```

- [ ] **Step 2: Generate migration**

Run: `pnpm db:migrate:generate`
Expected: creates a new migration file under `packages/db/drizzle/migrations/` with `CREATE TYPE "NotificationChannel" AS ENUM (...)` statements.

- [ ] **Step 3: Apply migration locally**

Run: `pnpm db:migrate`
Expected: applies cleanly; psql `\dT` shows the three new types.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/drizzle/enums.ts packages/db/drizzle/migrations/
git commit -m "feat(db): add notification channel/status/platform enums"
```

### Task 1.2: Add `notifications` and `notification_deliveries` tables (parent only; partitions follow)

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts`
- Create: `packages/db/drizzle/migrations/<next>_notifications_tables.sql`

- [ ] **Step 1: Add Drizzle table definitions**

Append to `packages/db/src/drizzle/schema.ts`:

```ts
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: uuid("projectId").references(() => projects.id, {
      onDelete: "cascade",
    }),
    eventKey: text("eventKey").notNull(),
    eventId: text("eventId").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
    readAt: timestamp("readAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdEventIdKey: uniqueIndex("notifications_userId_eventId_key").on(
      t.userId,
      t.eventId,
    ),
    userIdFeedIdx: index("notifications_userId_feed_idx").on(
      t.userId,
      t.readAt,
      t.createdAt,
    ),
  }),
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    notificationId: uuid("notificationId")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    channel: notificationChannel("channel").notNull(),
    status: notificationDeliveryStatus("status").notNull(),
    providerMessageId: text("providerMessageId"),
    providerResponse: jsonb("providerResponse"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("lastAttemptAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    notificationIdIdx: index(
      "notification_deliveries_notificationId_idx",
    ).on(t.notificationId),
    statusIdx: index("notification_deliveries_status_idx").on(
      t.status,
      t.createdAt,
    ),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
export type NewNotificationDelivery = typeof notificationDeliveries.$inferInsert;
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:migrate:generate`

- [ ] **Step 3: Decide partitioning per-table**

`notifications` is **NOT partitioned**. Reason: spec §3.4 requires `UNIQUE (userId, eventId)` for Kafka-at-least-once idempotency, but Postgres native partitioning forces unique constraints to include the partition key, and `createdAt` defaults to `now()` on insert → adding `createdAt` to the unique tuple breaks idempotency (two redelivery inserts get different `createdAt` values and both succeed). Pragmatic v1 call: keep `notifications` unpartitioned with the proper `UNIQUE (userId, eventId)` constraint. Volume at v1 scale (~50k/day worst case) is fine in a single table; add partitioning + a separate idempotency-key table in a later spec if volume grows.

`notification_deliveries` **IS partitioned** by `createdAt` (monthly, 3-month retention) — no idempotency-via-unique constraint required there, only `INDEX (status, createdAt)`.

Open the generated migration and rewrite the `notification_deliveries` create:

```sql
CREATE TABLE "notification_deliveries" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "notificationId" uuid NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "status" "NotificationDeliveryStatus" NOT NULL,
  "providerMessageId" text,
  "providerResponse" jsonb,
  "attempts" integer NOT NULL DEFAULT 0,
  "lastAttemptAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");

CREATE TABLE "notification_deliveries_default" PARTITION OF "notification_deliveries" DEFAULT;
```

(Note the composite PK including `createdAt`; Postgres requires the partition key in the PK for partitioned tables.)

Leave `notifications` as the non-partitioned form already produced by Drizzle. Confirm `notifications.uniqueIndex` in `schema.ts` is just `(userId, eventId)` (no `createdAt`):

```ts
userIdEventIdKey: uniqueIndex("notifications_userId_eventId_key").on(
  t.userId,
  t.eventId,
),
```

- [ ] **Step 4: Add pg_partman registration for deliveries only**

```sql
SELECT partman.create_parent(
  p_parent_table => 'public.notification_deliveries',
  p_control => 'createdAt',
  p_type => 'native',
  p_interval => '1 month',
  p_premake => 4
);
UPDATE partman.part_config
  SET retention = '3 months', retention_keep_table = false
  WHERE parent_table = 'public.notification_deliveries';
```

- [ ] **Step 5: Apply and verify**

Run: `pnpm db:migrate`
Then in psql: `\d+ notifications` should show `Partition key: RANGE ("createdAt")` and a `notifications_p2026_05` (or similar) child table from pg_partman.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/drizzle/migrations/
git commit -m "feat(db): add notifications + deliveries partitioned tables"
```

### Task 1.3: Add `push_devices` table

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts`
- Create: `packages/db/drizzle/migrations/<next>_push_devices.sql`

- [ ] **Step 1: Add Drizzle table definition**

Append to `packages/db/src/drizzle/schema.ts`:

```ts
export const pushDevices = pgTable(
  "push_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    platform: pushPlatform("platform").notNull(),
    token: text("token").notNull(),
    appBundleId: text("appBundleId").notNull(),
    locale: text("locale").notNull(),
    timezone: text("timezone").notNull(),
    lastSeenAt: timestamp("lastSeenAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revokedAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    platformTokenKey: uniqueIndex("push_devices_platform_token_key").on(
      t.platform,
      t.token,
    ),
    userIdActiveIdx: index("push_devices_userId_active_idx")
      .on(t.userId)
      .where(sql`"revokedAt" IS NULL`),
  }),
);

export type PushDevice = typeof pushDevices.$inferSelect;
export type NewPushDevice = typeof pushDevices.$inferInsert;
```

- [ ] **Step 2: Generate + apply migration**

```
pnpm db:migrate:generate
pnpm db:migrate
```

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/drizzle/ packages/db/drizzle/migrations/
git commit -m "feat(db): add push_devices table"
```

### Task 1.4: Add `user_project_notification_prefs` + `project_notification_defaults`

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts`
- Create: `packages/db/drizzle/migrations/<next>_notification_prefs.sql`

- [ ] **Step 1: Drizzle definitions**

```ts
export const userProjectNotificationPrefs = pgTable(
  "user_project_notification_prefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: uuid("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    overrides: jsonb("overrides").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdProjectIdKey: uniqueIndex(
      "user_project_notification_prefs_userId_projectId_key",
    ).on(t.userId, t.projectId),
    userIdIdx: index("user_project_notification_prefs_userId_idx").on(t.userId),
    projectIdIdx: index("user_project_notification_prefs_projectId_idx").on(
      t.projectId,
    ),
  }),
);

export const projectNotificationDefaults = pgTable(
  "project_notification_defaults",
  {
    projectId: uuid("projectId")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    defaults: jsonb("defaults").notNull().default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export type UserProjectNotificationPrefs =
  typeof userProjectNotificationPrefs.$inferSelect;
export type NewUserProjectNotificationPrefs =
  typeof userProjectNotificationPrefs.$inferInsert;
export type ProjectNotificationDefaults =
  typeof projectNotificationDefaults.$inferSelect;
export type NewProjectNotificationDefaults =
  typeof projectNotificationDefaults.$inferInsert;
```

- [ ] **Step 2: Migration + apply**

```
pnpm db:migrate:generate
pnpm db:migrate
```

- [ ] **Step 3: Commit**

```bash
git add packages/db/
git commit -m "feat(db): add user_project_notification_prefs + project_notification_defaults"
```

### Task 1.5: Restructure `user_preferences.notifications` JSONB + add locale/timezone

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts`
- Create: `packages/db/drizzle/migrations/<next>_user_preferences_restructure.sql`
- Create: `packages/db/src/drizzle/migration-helpers/migrate-notification-prefs.ts`

- [ ] **Step 1: Add `locale` and `timezone` columns to `user_preferences` schema**

Edit `user_preferences` table definition (currently has `notifications` jsonb + `appearance` jsonb). Add:

```ts
locale: text("locale").notNull().default("en"),
timezone: text("timezone").notNull().default("UTC"),
```

- [ ] **Step 2: Generate the schema migration (columns)**

`pnpm db:migrate:generate` — produces a column-add migration.

- [ ] **Step 3: Append a data-migration tail to the generated SQL**

After the `ALTER TABLE ... ADD COLUMN` statements, append:

```sql
-- Lift per-event toggles into user_project_notification_prefs (one row
-- per existing user × project membership). Then collapse the JSONB to
-- the new { channels, muted_until } shape.

INSERT INTO user_project_notification_prefs (id, "userId", "projectId", overrides)
SELECT
  gen_random_uuid(),
  pm."userId",
  pm."projectId",
  jsonb_build_object(
    'revenue.anomaly.detected', COALESCE((up.notifications->>'anomaly')::boolean, true),
    'revenue.digest.daily',     COALESCE((up.notifications->>'daily_digest')::boolean, true),
    'revenue.digest.weekly',    COALESCE((up.notifications->>'weekly_summary')::boolean, true),
    'revenue.milestone.hit',    COALESCE((up.notifications->>'milestone')::boolean, false),
    'revenue.churn.spike',      COALESCE((up.notifications->>'churn_spike')::boolean, true),
    'billing.refund.detected',  COALESCE((up.notifications->>'refund_alert')::boolean, true),
    'billing.invoice.failed',   COALESCE((up.notifications->>'invoice')::boolean, true),
    'billing.credit.low_balance', COALESCE((up.notifications->>'low_balance')::boolean, true)
  )
FROM user_preferences up
JOIN project_members pm ON pm."userId" = up."userId"
ON CONFLICT ("userId", "projectId") DO NOTHING;

-- Collapse the JSONB to the new shape.
UPDATE user_preferences SET notifications = jsonb_build_object(
  'channels', jsonb_build_object(
    'email', COALESCE((notifications->>'email')::boolean, true),
    'push',  COALESCE((notifications->>'push')::boolean, true)
  ),
  'muted_until', null
);
```

- [ ] **Step 4: Apply migration**

```
pnpm db:migrate
```

Expected: column adds succeed, data migration populates per-project prefs for every existing (user, project) membership, JSONB collapses cleanly.

- [ ] **Step 5: Hand-verify a sample row**

```
psql $DATABASE_URL -c 'SELECT notifications FROM user_preferences LIMIT 1;'
```

Expected: `{"channels": {"email": true, "push": true}, "muted_until": null}` shape only.

- [ ] **Step 6: Commit**

```bash
git add packages/db/
git commit -m "feat(db): restructure user_preferences.notifications + add locale/timezone"
```

### Task 1.6: Repositories — `notifications` repo

**Files:**
- Create: `packages/db/src/drizzle/repositories/notifications.ts`
- Test: `packages/db/src/drizzle/repositories/notifications.integration.test.ts`

- [ ] **Step 1: Write integration test (failing)**

```ts
// notifications.integration.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "@rovenue/db/test-helpers";
import { notificationsRepo } from "./notifications";

describe("notificationsRepo", () => {
  it("inserts a notification idempotently by (userId, eventId)", async () => {
    const db = await createTestDb();
    const userId = await seedUser(db);
    const projectId = await seedProject(db, userId);

    const first = await notificationsRepo.insertIdempotent(db, {
      userId,
      projectId,
      eventKey: "revenue.anomaly.detected",
      eventId: "anomaly:proj1:2026-05-25",
      title: "MRR drop detected",
      body: "MRR fell by 12% in the last hour.",
      data: {},
    });
    const second = await notificationsRepo.insertIdempotent(db, {
      userId,
      projectId,
      eventKey: "revenue.anomaly.detected",
      eventId: "anomaly:proj1:2026-05-25",
      title: "MRR drop detected (dup)",
      body: "should be ignored",
      data: {},
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const all = await notificationsRepo.listForUser(db, userId, { limit: 10 });
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe("MRR drop detected");
  });

  it("marks a notification read", async () => {
    const db = await createTestDb();
    const userId = await seedUser(db);
    const inserted = await notificationsRepo.insertIdempotent(db, {
      userId,
      projectId: null,
      eventKey: "security.signin.new_device",
      eventId: "signin:test:1",
      title: "New sign-in",
      body: "From Chrome on macOS",
      data: {},
    });
    expect(inserted).not.toBeNull();

    await notificationsRepo.markRead(db, userId, inserted!.id);

    const after = await notificationsRepo.listForUser(db, userId, {
      limit: 10,
    });
    expect(after[0]!.readAt).not.toBeNull();
  });

  it("counts unread by project", async () => {
    const db = await createTestDb();
    const userId = await seedUser(db);
    const p1 = await seedProject(db, userId);
    const p2 = await seedProject(db, userId);

    await notificationsRepo.insertIdempotent(db, {
      userId, projectId: p1, eventKey: "x", eventId: "1",
      title: "a", body: "b", data: {},
    });
    await notificationsRepo.insertIdempotent(db, {
      userId, projectId: p2, eventKey: "x", eventId: "2",
      title: "a", body: "b", data: {},
    });

    const counts = await notificationsRepo.unreadCount(db, userId);
    expect(counts.total).toBe(2);
    expect(counts.byProject[p1]).toBe(1);
    expect(counts.byProject[p2]).toBe(1);
  });
});
```

- [ ] **Step 2: Run; expect FAIL with `module not found`**

```
pnpm --filter @rovenue/db vitest run notifications.integration.test.ts
```

- [ ] **Step 3: Implement the repo**

Create `packages/db/src/drizzle/repositories/notifications.ts`:

```ts
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx } from "../client";
import { notifications, type NewNotification, type Notification } from "../schema";

export const notificationsRepo = {
  async insertIdempotent(
    db: DrizzleDb | DrizzleTx,
    input: Omit<NewNotification, "id" | "createdAt" | "readAt">,
  ): Promise<Notification | null> {
    const [row] = await db
      .insert(notifications)
      .values(input)
      .onConflictDoNothing({
        target: [notifications.userId, notifications.eventId],
      })
      .returning();
    return row ?? null;
  },

  async listForUser(
    db: DrizzleDb,
    userId: string,
    opts: {
      limit: number;
      cursor?: { createdAt: Date; id: string };
      projectId?: string;
      unreadOnly?: boolean;
    },
  ): Promise<Notification[]> {
    const conds = [eq(notifications.userId, userId)];
    if (opts.projectId) conds.push(eq(notifications.projectId, opts.projectId));
    if (opts.unreadOnly) conds.push(isNull(notifications.readAt));
    if (opts.cursor) {
      conds.push(
        sql`("createdAt", "id") < (${opts.cursor.createdAt}, ${opts.cursor.id})`,
      );
    }
    return db
      .select()
      .from(notifications)
      .where(and(...conds))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(opts.limit);
  },

  async markRead(db: DrizzleDb, userId: string, id: string): Promise<void> {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
  },

  async markAllRead(
    db: DrizzleDb,
    userId: string,
    projectId?: string,
  ): Promise<number> {
    const conds = [eq(notifications.userId, userId), isNull(notifications.readAt)];
    if (projectId) conds.push(eq(notifications.projectId, projectId));
    const result = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(...conds));
    return result.rowCount ?? 0;
  },

  async unreadCount(
    db: DrizzleDb,
    userId: string,
  ): Promise<{ total: number; byProject: Record<string, number> }> {
    const rows = await db
      .select({
        projectId: notifications.projectId,
        n: count(),
      })
      .from(notifications)
      .where(
        and(eq(notifications.userId, userId), isNull(notifications.readAt)),
      )
      .groupBy(notifications.projectId);
    let total = 0;
    const byProject: Record<string, number> = {};
    for (const r of rows) {
      total += r.n;
      if (r.projectId) byProject[r.projectId] = r.n;
    }
    return { total, byProject };
  },
};
```

- [ ] **Step 4: Run tests — expect PASS**

```
pnpm --filter @rovenue/db vitest run notifications.integration.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/notifications.ts \
        packages/db/src/drizzle/repositories/notifications.integration.test.ts
git commit -m "feat(db): notifications repo with idempotent insert + feed queries"
```

### Task 1.7: Repositories — preferences, deliveries, push-devices

**Files:**
- Create: `packages/db/src/drizzle/repositories/notification-preferences.ts`
- Create: `packages/db/src/drizzle/repositories/notification-deliveries.ts`
- Create: `packages/db/src/drizzle/repositories/push-devices.ts`
- Tests: `*.integration.test.ts` mirror each.

Follow the same structure as Task 1.6. Required methods:

**`notification-preferences.ts`** (operates on both `user_preferences`, `user_project_notification_prefs`, `project_notification_defaults`):

```ts
export const notificationPreferencesRepo = {
  // User-level channels + locale/timezone.
  async getUserChannels(db, userId): Promise<{ email: boolean; push: boolean; locale: string; timezone: string }> { ... }
  async updateUserChannels(db, userId, patch: { email?: boolean; push?: boolean; locale?: string; timezone?: string }): Promise<void> { ... }

  // Project-scoped overrides for a user.
  async getUserProjectOverrides(db, userId, projectId): Promise<Record<string, boolean>> { ... }
  async upsertUserProjectOverrides(db, userId, projectId, overrides): Promise<void> { ... }

  // Project defaults.
  async getProjectDefaults(db, projectId): Promise<Record<string, boolean>> { ... }
  async upsertProjectDefaults(db, projectId, defaults): Promise<void> { ... }
};
```

Tests cover: get returns defaults when row absent; upsert merges (not replaces) the overrides JSONB; concurrent upserts are safe via `INSERT ... ON CONFLICT DO UPDATE`.

**`notification-deliveries.ts`**:

```ts
export const notificationDeliveriesRepo = {
  async insertMany(tx, rows: NewNotificationDelivery[]): Promise<NotificationDelivery[]> { ... }
  async markStatus(db, id, status, response?): Promise<void> { ... }
  async findByProviderMessageId(db, providerMessageId): Promise<NotificationDelivery | null> { ... }
  async incrementAttempts(db, id): Promise<void> { ... }
};
```

Tests cover: batch insert returns ids in order; markStatus updates `lastAttemptAt`; lookup by provider id returns null when absent.

**`push-devices.ts`**:

```ts
export const pushDevicesRepo = {
  async upsertByToken(db, input: NewPushDevice): Promise<PushDevice> { ... } // transfers ownership on conflict + clears revokedAt
  async listActiveForUser(db, userId): Promise<PushDevice[]> { ... }
  async revokeById(db, userId, id): Promise<void> { ... }
  async revokeByToken(db, platform, token, reason: string): Promise<void> { ... }
};
```

Tests cover: conflict on `(platform, token)` transfers ownership; `listActiveForUser` excludes revoked; `revokeByToken` is no-op for unknown token.

- [ ] **Step 1**: write the three integration test files first (one `describe` block per repo with at least three `it` blocks).
- [ ] **Step 2**: run; expect failures.
- [ ] **Step 3**: implement each repo.
- [ ] **Step 4**: run; expect green.
- [ ] **Step 5**: Commit each repo separately:

```bash
git add packages/db/src/drizzle/repositories/notification-preferences.ts \
        packages/db/src/drizzle/repositories/notification-preferences.integration.test.ts
git commit -m "feat(db): notification preferences repo"

git add packages/db/src/drizzle/repositories/notification-deliveries.ts \
        packages/db/src/drizzle/repositories/notification-deliveries.integration.test.ts
git commit -m "feat(db): notification deliveries repo"

git add packages/db/src/drizzle/repositories/push-devices.ts \
        packages/db/src/drizzle/repositories/push-devices.integration.test.ts
git commit -m "feat(db): push devices repo"
```

---

## Phase 2 — Event catalog + types

### Task 2.1: Define event catalog type

**Files:**
- Create: `packages/shared/src/notifications/types.ts`

- [ ] **Step 1: Write types**

```ts
// packages/shared/src/notifications/types.ts
import { z } from "zod";

export const NotificationChannel = z.enum(["email", "push", "inapp"]);
export type NotificationChannel = z.infer<typeof NotificationChannel>;

export const PushPlatform = z.enum(["ios", "android"]);
export type PushPlatform = z.infer<typeof PushPlatform>;

export const NotificationDeliveryStatus = z.enum([
  "queued",
  "sent",
  "delivered",
  "bounced",
  "failed",
  "suppressed",
]);
export type NotificationDeliveryStatus = z.infer<
  typeof NotificationDeliveryStatus
>;

export const MemberRoleName = z.enum([
  "OWNER",
  "ADMIN",
  "DEVELOPER",
  "GROWTH",
  "CUSTOMER_SUPPORT",
]);
export type MemberRoleName = z.infer<typeof MemberRoleName>;

export type RecipientScope =
  | { kind: "self" }                       // payload.recipients carries the userId
  | { kind: "project_roles"; roles: MemberRoleName[] }
  | { kind: "project_members" }            // all members regardless of role
  | { kind: "workspace_owner" };           // project OWNER (placeholder for SaaS billing)

export interface NotificationEventDescriptor {
  key: string;
  category: "revenue" | "billing" | "integration" | "team" | "security";
  defaultChannels: NotificationChannel[];
  forcedChannels: NotificationChannel[];     // subset of defaultChannels
  defaultEnabled: boolean;                    // code-level seed value
  recipientScope: RecipientScope;
  contextSchema: z.ZodTypeAny;                // for runtime validation in notifier
  pushAllowed: boolean;                       // digests have this false
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/notifications/types.ts
git commit -m "feat(shared): notification event types + enums"
```

### Task 2.2: Build the event catalog (16 events)

**Files:**
- Create: `packages/shared/src/notifications/event-catalog.ts`
- Test: `packages/shared/src/notifications/event-catalog.test.ts`

- [ ] **Step 1: Write the catalog test**

```ts
// event-catalog.test.ts
import { describe, it, expect } from "vitest";
import { EVENT_CATALOG, getEvent } from "./event-catalog";

describe("event catalog", () => {
  it("has exactly 16 events in v1", () => {
    expect(Object.keys(EVENT_CATALOG)).toHaveLength(16);
  });

  it("every event's forcedChannels is a subset of defaultChannels", () => {
    for (const e of Object.values(EVENT_CATALOG)) {
      for (const ch of e.forcedChannels) {
        expect(e.defaultChannels).toContain(ch);
      }
    }
  });

  it("digest events disallow push", () => {
    expect(EVENT_CATALOG["revenue.digest.daily"]!.pushAllowed).toBe(false);
    expect(EVENT_CATALOG["revenue.digest.weekly"]!.pushAllowed).toBe(false);
  });

  it("getEvent throws on unknown key", () => {
    expect(() => getEvent("nope")).toThrow(/unknown event/i);
  });
});
```

- [ ] **Step 2: Implement the catalog**

```ts
// event-catalog.ts
import { z } from "zod";
import type { NotificationEventDescriptor } from "./types";

const moneySchema = z.object({
  amount: z.number().int(),
  currency: z.string().length(3),
});

const projectSection = z.object({
  projectId: z.string().uuid(),
  projectName: z.string(),
  mrr: z.number(),
  mrrDelta: z.number(),
  newSubs: z.number().int(),
  churnedSubs: z.number().int(),
  refundCount: z.number().int(),
  refundTotalCents: z.number().int(),
});

export const EVENT_CATALOG: Record<string, NotificationEventDescriptor> = {
  "revenue.digest.daily": {
    key: "revenue.digest.daily",
    category: "revenue",
    defaultChannels: ["email", "inapp"],
    forcedChannels: [],
    defaultEnabled: true,
    recipientScope: { kind: "self" },
    pushAllowed: false,
    contextSchema: z.object({
      date: z.string(),
      timezone: z.string(),
      sections: z.array(projectSection).min(1),
    }),
  },
  "revenue.digest.weekly": {
    key: "revenue.digest.weekly",
    category: "revenue",
    defaultChannels: ["email", "inapp"],
    forcedChannels: [],
    defaultEnabled: true,
    recipientScope: { kind: "self" },
    pushAllowed: false,
    contextSchema: z.object({
      weekStart: z.string(),
      weekEnd: z.string(),
      timezone: z.string(),
      sections: z.array(projectSection).min(1),
    }),
  },
  "revenue.anomaly.detected": {
    key: "revenue.anomaly.detected",
    category: "revenue",
    defaultChannels: ["email", "push", "inapp"],
    forcedChannels: [],
    defaultEnabled: true,
    recipientScope: { kind: "project_roles", roles: ["OWNER", "ADMIN", "GROWTH"] },
    pushAllowed: true,
    contextSchema: z.object({
      projectId: z.string().uuid(),
      projectName: z.string(),
      metric: z.enum(["mrr", "subs", "churn"]),
      direction: z.enum(["up", "down"]),
      magnitudePct: z.number(),
      windowMinutes: z.number().int(),
    }),
  },
  "revenue.milestone.hit": {
    key: "revenue.milestone.hit",
    category: "revenue",
    defaultChannels: ["email", "inapp"],
    forcedChannels: [],
    defaultEnabled: false,
    recipientScope: { kind: "project_members" },
    pushAllowed: false,
    contextSchema: z.object({
      projectId: z.string().uuid(),
      projectName: z.string(),
      milestone: moneySchema,
      metric: z.enum(["mrr", "total_revenue"]),
    }),
  },
  "revenue.churn.spike": {
    key: "revenue.churn.spike",
    category: "revenue",
    defaultChannels: ["email", "push", "inapp"],
    forcedChannels: [],
    defaultEnabled: true,
    recipientScope: { kind: "project_roles", roles: ["OWNER", "ADMIN", "GROWTH"] },
    pushAllowed: true,
    contextSchema: z.object({
      projectId: z.string().uuid(),
      projectName: z.string(),
      churnRatePct: z.number(),
      baselinePct: z.number(),
      windowDays: z.number().int(),
    }),
  },
  "billing.refund.detected": {
    key: "billing.refund.detected",
    category: "billing",
    defaultChannels: ["email", "inapp"],
    forcedChannels: [],
    defaultEnabled: true,
    recipientScope: { kind: "project_roles", roles: ["OWNER", "ADMIN"] },
    pushAllowed: true,
    contextSchema: z.object({
      projectId: z.string().uuid(),
      projectName: z.string(),
      amount: moneySchema,
      reason: z.enum(["high_value", "burst"]),
      productId: z.string().optional(),
    }),
  },
  "billing.credit.low_balance": {
    key: "billing.credit.low_balance",
    category: "billing",
    defaultChannels: ["email", "push", "inapp"],
    forcedChannels: [],
    defaultEnabled: true,
    recipientScope: { kind: "project_roles", roles: ["OWNER", "ADMIN"] },
    pushAllowed: true,
    contextSchema: z.object({
      projectId: z.string().uuid(),
      projectName: z.string(),
      balanceCents: z.number().int(),
      thresholdCents: z.number().int(),
    }),
  },
  "billing.invoice.failed": {
    key: "billing.invoice.failed",
    category: "billing",
    defaultChannels: ["email", "push", "inapp"],
    forcedChannels: ["email"],
    defaultEnabled: true,
    recipientScope: { kind: "workspace_owner" },
    pushAllowed: true,
    contextSchema: z.object({
      invoiceId: z.string(),
      amount: moneySchema,
      reason: z.string(),
      hostedInvoiceUrl: z.string().url().optional(),
    }),
  },
  "billing.invoice.paid": {
    key: "billing.invoice.paid",
    category: "billing",
    defaultChannels: ["email"],
    forcedChannels: ["email"],
    defaultEnabled: false,
    recipientScope: { kind: "workspace_owner" },
    pushAllowed: false,
    contextSchema: z.object({
      invoiceId: z.string(),
      amount: moneySchema,
      periodStart: z.string(),
      periodEnd: z.string(),
      hostedInvoiceUrl: z.string().url().optional(),
    }),
  },
  "integration.store_credential.expired": {
    key: "integration.store_credential.expired",
    category: "integration",
    defaultChannels: ["email", "push", "inapp"],
    forcedChannels: ["email"],
    defaultEnabled: true,
    recipientScope: { kind: "project_roles", roles: ["OWNER", "ADMIN", "DEVELOPER"] },
    pushAllowed: true,
    contextSchema: z.object({
      projectId: z.string().uuid(),
      projectName: z.string(),
      provider: z.enum(["apple", "google", "stripe"]),
      expiresAt: z.string().optional(),
    }),
  },
  "integration.webhook.failing": {
    key: "integration.webhook.failing",
    category: "integration",
    defaultChannels: ["email", "inapp"],
    forcedChannels: [],
    defaultEnabled: true,
    recipientScope: { kind: "project_roles", roles: ["OWNER", "ADMIN", "DEVELOPER"] },
    pushAllowed: false,
    contextSchema: z.object({
      projectId: z.string().uuid(),
      projectName: z.string(),
      webhookId: z.string().uuid(),
      endpointUrl: z.string().url(),
      consecutiveFailures: z.number().int(),
    }),
  },
  "team.member.invited": {
    key: "team.member.invited",
    category: "team",
    defaultChannels: ["email"],
    forcedChannels: ["email"],
    defaultEnabled: true,
    recipientScope: { kind: "self" },
    pushAllowed: false,
    contextSchema: z.object({
      projectId: z.string().uuid(),
      projectName: z.string(),
      inviterName: z.string(),
      role: z.string(),
      acceptUrl: z.string().url(),
    }),
  },
  "team.member.role_changed": {
    key: "team.member.role_changed",
    category: "team",
    defaultChannels: ["email", "inapp"],
    forcedChannels: [],
    defaultEnabled: true,
    recipientScope: { kind: "self" },
    pushAllowed: false,
    contextSchema: z.object({
      projectId: z.string().uuid(),
      projectName: z.string(),
      oldRole: z.string(),
      newRole: z.string(),
      changedByName: z.string(),
    }),
  },
  "team.member.removed": {
    key: "team.member.removed",
    category: "team",
    defaultChannels: ["email"],
    forcedChannels: ["email"],
    defaultEnabled: true,
    recipientScope: { kind: "self" },
    pushAllowed: false,
    contextSchema: z.object({
      projectId: z.string().uuid(),
      projectName: z.string(),
      removedByName: z.string(),
    }),
  },
  "security.signin.new_device": {
    key: "security.signin.new_device",
    category: "security",
    defaultChannels: ["email", "push", "inapp"],
    forcedChannels: ["email"],
    defaultEnabled: true,
    recipientScope: { kind: "self" },
    pushAllowed: true,
    contextSchema: z.object({
      userAgent: z.string(),
      ipAddress: z.string(),
      approxLocation: z.string().optional(),
      whenIso: z.string(),
    }),
  },
  "security.oauth.account_linked": {
    key: "security.oauth.account_linked",
    category: "security",
    defaultChannels: ["email", "inapp"],
    forcedChannels: ["email"],
    defaultEnabled: true,
    recipientScope: { kind: "self" },
    pushAllowed: false,
    contextSchema: z.object({
      provider: z.enum(["github", "google"]),
      whenIso: z.string(),
    }),
  },
};

export function getEvent(key: string): NotificationEventDescriptor {
  const e = EVENT_CATALOG[key];
  if (!e) throw new Error(`unknown event key: ${key}`);
  return e;
}

export function listEventKeysByCategory(
  category: NotificationEventDescriptor["category"],
): string[] {
  return Object.values(EVENT_CATALOG)
    .filter((e) => e.category === category)
    .map((e) => e.key);
}
```

- [ ] **Step 3: Run tests**

```
pnpm --filter @rovenue/shared vitest run event-catalog
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/notifications/
git commit -m "feat(shared): notification event catalog (16 events)"
```

### Task 2.3: API schemas (Zod)

**Files:**
- Create: `packages/shared/src/notifications/api-schemas.ts`
- Test: `packages/shared/src/notifications/api-schemas.test.ts`

- [ ] **Step 1: Write schemas (TDD: write a test verifying a known good payload parses and a known bad one rejects)**

```ts
// api-schemas.ts
import { z } from "zod";
import { NotificationChannel } from "./types";

export const UpdateUserChannelsBody = z.object({
  scope: z.literal("global"),
  channels: z
    .object({ email: z.boolean().optional(), push: z.boolean().optional() })
    .optional(),
  locale: z.string().min(2).max(10).optional(),
  timezone: z.string().min(1).max(64).optional(),
});

export const UpdateUserProjectOverridesBody = z.object({
  scope: z.literal("project"),
  projectId: z.string().uuid(),
  overrides: z.record(z.string(), z.boolean()),
});

export const UpdatePreferencesBody = z.discriminatedUnion("scope", [
  UpdateUserChannelsBody,
  UpdateUserProjectOverridesBody,
]);

export const RegisterPushDeviceBody = z.object({
  platform: z.enum(["ios", "android"]),
  token: z.string().min(1).max(4096),
  appBundleId: z.string().min(1).max(256),
  locale: z.string().min(2).max(10),
  timezone: z.string().min(1).max(64),
});

export const UnsubscribeBody = z.object({ token: z.string().min(20) });

export const ProjectNotificationDefaultsBody = z.object({
  defaults: z.record(z.string(), z.boolean()),
});

export const ListFeedQuery = z.object({
  unread: z.coerce.boolean().optional(),
  projectId: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type UpdatePreferencesBody = z.infer<typeof UpdatePreferencesBody>;
export type RegisterPushDeviceBody = z.infer<typeof RegisterPushDeviceBody>;
export type ListFeedQuery = z.infer<typeof ListFeedQuery>;
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/notifications/api-schemas.ts \
        packages/shared/src/notifications/api-schemas.test.ts
git commit -m "feat(shared): notification API zod schemas"
```

---

## Phase 3 — Outbox `NOTIFICATION` aggregate

### Task 3.1: Add NOTIFICATION to outbox aggregate type

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts` (the `aggregateType` enum on `outbox_events`)
- Modify: `apps/api/src/workers/outbox-dispatcher.ts:90`
- Create: `packages/db/drizzle/migrations/<next>_outbox_notification_aggregate.sql`

- [ ] **Step 1: Add the enum variant in Drizzle**

In `packages/db/src/drizzle/enums.ts`, locate the existing aggregate-type enum and add `"NOTIFICATION"`:

```ts
export const outboxAggregateType = pgEnum("OutboxAggregateType", [
  "EXPOSURE",
  "REVENUE_EVENT",
  "CREDIT_LEDGER",
  "NOTIFICATION", // NEW
]);
```

- [ ] **Step 2: Generate + apply migration**

```
pnpm db:migrate:generate
pnpm db:migrate
```

(The generated SQL is `ALTER TYPE "OutboxAggregateType" ADD VALUE 'NOTIFICATION';`.)

- [ ] **Step 3: Add topic mapping**

Edit `apps/api/src/workers/outbox-dispatcher.ts:90-94`:

```ts
const AGGREGATE_TO_TOPIC: Record<OutboxEvent["aggregateType"], string> = {
  EXPOSURE: "rovenue.exposures",
  REVENUE_EVENT: "rovenue.revenue",
  CREDIT_LEDGER: "rovenue.credit",
  NOTIFICATION: "rovenue.notifications", // NEW
};
```

- [ ] **Step 4: Run outbox-dispatcher unit tests**

```
pnpm --filter @rovenue/api vitest run outbox-dispatcher
```

Expected: existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/db/ apps/api/src/workers/outbox-dispatcher.ts
git commit -m "feat(outbox): add NOTIFICATION aggregate type + rovenue.notifications topic"
```

### Task 3.2: `emitNotification` helper

**Files:**
- Create: `apps/api/src/services/notifications/emit.ts`
- Test: `apps/api/src/services/notifications/emit.integration.test.ts`

- [ ] **Step 1: Write the integration test (failing)**

```ts
// emit.integration.test.ts
import { describe, it, expect } from "vitest";
import { createTestDb } from "@rovenue/db/test-helpers";
import { outboxEvents } from "@rovenue/db";
import { eq } from "drizzle-orm";
import { emitNotification } from "./emit";

describe("emitNotification", () => {
  it("writes an outbox row in the caller's tx", async () => {
    const db = await createTestDb();
    await db.transaction(async (tx) => {
      await emitNotification(tx, {
        eventKey: "security.signin.new_device",
        eventId: "signin:user-1:2026-05-26T10:00",
        recipients: ["user-1"],
        context: {
          userAgent: "Chrome",
          ipAddress: "1.2.3.4",
          whenIso: "2026-05-26T10:00:00Z",
        },
      });
    });
    const rows = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventId, "signin:user-1:2026-05-26T10:00"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.aggregateType).toBe("NOTIFICATION");
  });

  it("rolls back if the caller's tx rolls back", async () => {
    const db = await createTestDb();
    await expect(
      db.transaction(async (tx) => {
        await emitNotification(tx, {
          eventKey: "security.signin.new_device",
          eventId: "rollback-test-1",
          recipients: ["user-1"],
          context: {
            userAgent: "Chrome",
            ipAddress: "1.2.3.4",
            whenIso: "2026-05-26T10:00:00Z",
          },
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const rows = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventId, "rollback-test-1"));
    expect(rows).toHaveLength(0);
  });

  it("rejects context that fails the event's schema", async () => {
    const db = await createTestDb();
    await expect(
      db.transaction(async (tx) => {
        await emitNotification(tx, {
          eventKey: "security.signin.new_device",
          eventId: "bad-ctx",
          recipients: ["u"],
          context: { userAgent: 42 } as never,
        });
      }),
    ).rejects.toThrow(/invalid context/i);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// emit.ts
import { getEvent } from "@rovenue/shared/notifications/event-catalog";
import { outboxEvents, type DrizzleTx } from "@rovenue/db";

export interface EmitNotificationInput {
  eventKey: string;
  eventId: string;
  projectId?: string;
  recipients?: string[];
  context: Record<string, unknown>;
}

export async function emitNotification(
  tx: DrizzleTx,
  input: EmitNotificationInput,
): Promise<void> {
  const event = getEvent(input.eventKey);
  const parsed = event.contextSchema.safeParse(input.context);
  if (!parsed.success) {
    throw new Error(
      `invalid context for ${input.eventKey}: ${parsed.error.message}`,
    );
  }
  await tx.insert(outboxEvents).values({
    aggregateType: "NOTIFICATION",
    aggregateId: input.projectId ?? "account",
    eventType: input.eventKey,
    eventId: input.eventId,
    payload: { ...input, context: parsed.data },
  });
}
```

- [ ] **Step 3: Run tests; expect green**

```
pnpm --filter @rovenue/api vitest run emit
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/notifications/
git commit -m "feat(api): emitNotification helper with context schema validation"
```

---

## Phase 4 — Preference resolver

### Task 4.1: `resolvePrefs` cascade

**Files:**
- Create: `apps/api/src/services/notifications/resolve-prefs.ts`
- Test: `apps/api/src/services/notifications/resolve-prefs.test.ts`

- [ ] **Step 1: Write unit test covering 12 scenarios**

```ts
import { describe, it, expect, vi } from "vitest";
import { resolvePrefs } from "./resolve-prefs";

const userChannels = (overrides: Partial<{ email: boolean; push: boolean }> = {}) => ({
  email: true,
  push: true,
  ...overrides,
});

describe("resolvePrefs", () => {
  it("returns code default when no project/user override", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels(),
      projectDefaults: {},
      userOverrides: {},
      eventKey: "revenue.anomaly.detected",
    });
    expect(r.enabled).toBe(true); // code seed
    expect(r.enabledChannels).toEqual(["email", "push", "inapp"]);
  });

  it("project default overrides code default", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels(),
      projectDefaults: { "revenue.anomaly.detected": false },
      userOverrides: {},
      eventKey: "revenue.anomaly.detected",
    });
    expect(r.enabled).toBe(false);
    expect(r.enabledChannels).toEqual([]);
  });

  it("user override beats project default", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels(),
      projectDefaults: { "revenue.anomaly.detected": false },
      userOverrides: { "revenue.anomaly.detected": true },
      eventKey: "revenue.anomaly.detected",
    });
    expect(r.enabled).toBe(true);
  });

  it("forced event ignores user opt-out", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels(),
      projectDefaults: {},
      userOverrides: { "security.signin.new_device": false },
      eventKey: "security.signin.new_device",
    });
    expect(r.enabled).toBe(true);
    expect(r.enabledChannels).toContain("email"); // forced
  });

  it("channel-off filters channels not in forced list", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels({ push: false }),
      projectDefaults: {},
      userOverrides: {},
      eventKey: "revenue.anomaly.detected",
    });
    expect(r.enabled).toBe(true);
    expect(r.enabledChannels).toEqual(["email", "inapp"]);
  });

  it("channel-off cannot suppress forced channel", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels({ email: false }),
      projectDefaults: {},
      userOverrides: {},
      eventKey: "security.signin.new_device",
    });
    expect(r.enabledChannels).toContain("email"); // forced
  });

  it("event disabled by user → no channels (forced still kept)", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels(),
      projectDefaults: {},
      userOverrides: { "revenue.milestone.hit": false },
      eventKey: "revenue.milestone.hit",
    });
    expect(r.enabled).toBe(false);
    expect(r.enabledChannels).toEqual([]); // no forced channels on milestone
  });

  it("digest event drops push even if user has push on", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels(),
      projectDefaults: {},
      userOverrides: {},
      eventKey: "revenue.digest.daily",
    });
    expect(r.enabledChannels).not.toContain("push");
  });

  it("unknown event key throws", async () => {
    await expect(
      resolvePrefs({
        userChannels: userChannels(),
        projectDefaults: {},
        userOverrides: {},
        eventKey: "nope",
      }),
    ).rejects.toThrow(/unknown event/i);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// resolve-prefs.ts
import { getEvent } from "@rovenue/shared/notifications/event-catalog";
import type { NotificationChannel } from "@rovenue/shared/notifications/types";

export interface ResolvePrefsInput {
  userChannels: { email: boolean; push: boolean };
  projectDefaults: Record<string, boolean>;
  userOverrides: Record<string, boolean>;
  eventKey: string;
}

export interface ResolvePrefsResult {
  enabled: boolean;
  enabledChannels: NotificationChannel[];
}

export async function resolvePrefs(
  input: ResolvePrefsInput,
): Promise<ResolvePrefsResult> {
  const event = getEvent(input.eventKey);

  // 1. Code seed → project default → user override.
  const userOverride = input.userOverrides[event.key];
  const projectDefault = input.projectDefaults[event.key];
  const enabled =
    userOverride ??
    projectDefault ??
    event.defaultEnabled;

  const forced = new Set<NotificationChannel>(event.forcedChannels);

  const channels: NotificationChannel[] = [];
  for (const ch of event.defaultChannels) {
    if (forced.has(ch)) {
      channels.push(ch);
      continue;
    }
    if (!enabled) continue;
    if (ch === "inapp") {
      channels.push(ch);
      continue;
    }
    if (ch === "email" && input.userChannels.email) channels.push(ch);
    if (ch === "push" && input.userChannels.push && event.pushAllowed) {
      channels.push(ch);
    }
  }

  return {
    enabled: enabled || forced.size > 0,
    enabledChannels: channels,
  };
}
```

- [ ] **Step 3: Run tests; expect green**

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/notifications/resolve-prefs.ts \
        apps/api/src/services/notifications/resolve-prefs.test.ts
git commit -m "feat(api): preference resolver with forced-channel cascade"
```

### Task 4.2: Recipient resolver

**Files:**
- Create: `apps/api/src/services/notifications/recipient-resolver.ts`
- Test: `apps/api/src/services/notifications/recipient-resolver.integration.test.ts`

- [ ] **Step 1: Write integration test**

```ts
import { describe, it, expect } from "vitest";
import { createTestDb } from "@rovenue/db/test-helpers";
import { resolveRecipients } from "./recipient-resolver";

describe("resolveRecipients", () => {
  it("returns payload.recipients if set", async () => {
    const db = await createTestDb();
    const r = await resolveRecipients(db, {
      eventKey: "security.signin.new_device",
      projectId: undefined,
      recipients: ["u1"],
    });
    expect(r).toEqual(["u1"]);
  });

  it("project_roles scope returns members with matching roles", async () => {
    const db = await createTestDb();
    const projectId = "...";
    // seed: owner u1, admin u2, dev u3, growth u4
    const r = await resolveRecipients(db, {
      eventKey: "revenue.anomaly.detected", // OWNER+ADMIN+GROWTH
      projectId,
    });
    expect(new Set(r)).toEqual(new Set(["u1", "u2", "u4"]));
  });

  it("project_members scope returns all members", async () => {
    // ...
  });

  it("workspace_owner scope returns project OWNER", async () => {
    // ...
  });
});
```

- [ ] **Step 2: Implement**

```ts
// recipient-resolver.ts
import { and, eq, inArray } from "drizzle-orm";
import { getEvent } from "@rovenue/shared/notifications/event-catalog";
import { projectMembers, type DrizzleDb } from "@rovenue/db";

export interface ResolveRecipientsInput {
  eventKey: string;
  projectId?: string;
  recipients?: string[];
}

export async function resolveRecipients(
  db: DrizzleDb,
  input: ResolveRecipientsInput,
): Promise<string[]> {
  if (input.recipients && input.recipients.length > 0) return input.recipients;
  const event = getEvent(input.eventKey);
  const scope = event.recipientScope;
  if (scope.kind === "self") {
    throw new Error(
      `event ${input.eventKey} has 'self' scope but no explicit recipients`,
    );
  }
  if (!input.projectId) {
    throw new Error(
      `event ${input.eventKey} is project-scoped but projectId missing`,
    );
  }
  if (scope.kind === "project_members") {
    const rows = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, input.projectId));
    return rows.map((r) => r.userId);
  }
  if (scope.kind === "project_roles") {
    const rows = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, input.projectId),
          inArray(projectMembers.role, scope.roles),
        ),
      );
    return rows.map((r) => r.userId);
  }
  if (scope.kind === "workspace_owner") {
    const rows = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, input.projectId),
          eq(projectMembers.role, "OWNER"),
        ),
      );
    return rows.map((r) => r.userId);
  }
  return [];
}
```

- [ ] **Step 3: Run tests; expect green**

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/notifications/recipient-resolver.ts \
        apps/api/src/services/notifications/recipient-resolver.integration.test.ts
git commit -m "feat(api): notification recipient resolver"
```

---

## Phase 5 — `packages/email-templates` workspace package

### Task 5.1: Scaffold the package

**Files:**
- Create: `packages/email-templates/package.json`
- Create: `packages/email-templates/tsconfig.json`
- Create: `packages/email-templates/src/index.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `turbo.json`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@rovenue/email-templates",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "react-email dev --dir ./src",
    "test": "vitest run"
  },
  "dependencies": {
    "@react-email/components": "^0.0.25",
    "@react-email/render": "^0.0.17",
    "i18next": "^23.11.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "react-email": "^2.1.4",
    "typescript": "^5.4.0",
    "vitest": "^1.5.0",
    "@rovenue/shared": "workspace:*"
  }
}
```

- [ ] **Step 2: `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "jsx": "react-jsx",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Add to `pnpm-workspace.yaml`** (it already globs `packages/*` if so this is a no-op; otherwise add explicitly).

- [ ] **Step 4: `turbo.json`** — ensure the build pipeline picks it up. If `turbo.json` uses a global `build` pipeline, no edit needed; otherwise add an `outputs` array for `packages/email-templates` matching the convention.

- [ ] **Step 5: `src/index.ts` (stub)**

```ts
export * from "./registry";
```

- [ ] **Step 6: Install**

```
pnpm install
```

- [ ] **Step 7: Commit**

```bash
git add packages/email-templates/ pnpm-workspace.yaml turbo.json pnpm-lock.yaml
git commit -m "feat(email-templates): scaffold workspace package"
```

### Task 5.2: i18n loader

**Files:**
- Create: `packages/email-templates/src/i18n.ts`
- Create: `packages/email-templates/locales/en/common.json`
- Create: `packages/email-templates/locales/tr/common.json`
- Test: `packages/email-templates/src/i18n.test.ts`

- [ ] **Step 1: Locales**

`locales/en/common.json`:

```json
{
  "footer.brand": "Rovenue",
  "footer.address": "Rovenue, Open-source subscription management",
  "footer.unsubscribe": "Unsubscribe",
  "footer.manage": "Manage preferences",
  "common.viewInDashboard": "View in dashboard"
}
```

`locales/tr/common.json`:

```json
{
  "footer.brand": "Rovenue",
  "footer.address": "Rovenue, Açık kaynak abonelik yönetimi",
  "footer.unsubscribe": "Aboneliği iptal et",
  "footer.manage": "Tercihleri yönet",
  "common.viewInDashboard": "Dashboard'da görüntüle"
}
```

- [ ] **Step 2: `i18n.ts`**

```ts
import i18next, { type i18n, type TFunction } from "i18next";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const localesDir = join(here, "..", "locales");

function loadResources(): Record<string, Record<string, unknown>> {
  const resources: Record<string, Record<string, unknown>> = {};
  for (const locale of readdirSync(localesDir)) {
    const ns: Record<string, unknown> = {};
    for (const file of readdirSync(join(localesDir, locale))) {
      const name = file.replace(/\.json$/, "");
      ns[name] = JSON.parse(
        readFileSync(join(localesDir, locale, file), "utf8"),
      );
    }
    resources[locale] = ns;
  }
  return resources;
}

const resources = loadResources();
const supported = Object.keys(resources);

const instance: i18n = i18next.createInstance();
await instance.init({
  resources: Object.fromEntries(
    supported.map((l) => [l, resources[l]]),
  ),
  fallbackLng: "en",
  defaultNS: "common",
  ns: Array.from(new Set(supported.flatMap((l) => Object.keys(resources[l]!)))),
  interpolation: { escapeValue: false },
});

export function getT(locale: string): TFunction {
  return instance.getFixedT(supported.includes(locale) ? locale : "en");
}

export function supportedLocales(): string[] {
  return supported;
}
```

- [ ] **Step 3: Test**

```ts
import { describe, it, expect } from "vitest";
import { getT } from "./i18n";

describe("i18n", () => {
  it("returns translated strings in tr", () => {
    expect(getT("tr")("footer.unsubscribe")).toBe("Aboneliği iptal et");
  });
  it("falls back to en for unknown locales", () => {
    expect(getT("de")("footer.unsubscribe")).toBe("Unsubscribe");
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add packages/email-templates/src/i18n.ts \
        packages/email-templates/src/i18n.test.ts \
        packages/email-templates/locales/
git commit -m "feat(email-templates): i18n loader with en+tr"
```

### Task 5.3: Base layout

**Files:**
- Create: `packages/email-templates/src/layouts/base-layout.tsx`

- [ ] **Step 1: Implement**

```tsx
import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { ReactNode } from "react";
import type { TFunction } from "i18next";

export interface BaseLayoutProps {
  t: TFunction;
  preview: string;
  unsubscribeUrl?: string;
  managePreferencesUrl: string;
  children: ReactNode;
}

export function BaseLayout({
  t,
  preview,
  unsubscribeUrl,
  managePreferencesUrl,
  children,
}: BaseLayoutProps): JSX.Element {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ fontFamily: "system-ui, sans-serif", backgroundColor: "#f6f7f9", margin: 0, padding: 24 }}>
        <Container style={{ background: "white", borderRadius: 8, padding: 24, maxWidth: 560 }}>
          <Section>
            <Text style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
              {t("footer.brand")}
            </Text>
          </Section>
          <Section>{children}</Section>
          <Hr style={{ borderColor: "#e5e7eb" }} />
          <Section>
            <Text style={{ fontSize: 12, color: "#6b7280" }}>
              <Link href={managePreferencesUrl}>{t("footer.manage")}</Link>
              {unsubscribeUrl ? (
                <>
                  {" · "}
                  <Link href={unsubscribeUrl}>{t("footer.unsubscribe")}</Link>
                </>
              ) : null}
            </Text>
            <Text style={{ fontSize: 11, color: "#9ca3af", marginTop: 8 }}>
              {t("footer.address")}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/email-templates/src/layouts/
git commit -m "feat(email-templates): base layout"
```

### Task 5.4: Template registry contract + first template (`revenue.anomaly.detected`)

**Files:**
- Create: `packages/email-templates/src/registry.ts`
- Create: `packages/email-templates/src/revenue/anomaly-detected.tsx`
- Create: `packages/email-templates/locales/en/revenue.anomaly-detected.json`
- Create: `packages/email-templates/locales/tr/revenue.anomaly-detected.json`
- Test: `packages/email-templates/src/registry.test.ts`

- [ ] **Step 1: Locales**

`locales/en/revenue.anomaly-detected.json`:

```json
{
  "subject": "Anomaly detected on {{projectName}}",
  "preview": "{{metric}} moved {{direction}} {{magnitudePct}}% in the last {{windowMinutes}} minutes",
  "headline": "Anomaly detected on {{projectName}}",
  "body": "{{metric}} moved {{direction}} {{magnitudePct}}% in the last {{windowMinutes}} minutes, beyond your project's baseline.",
  "cta": "Open dashboard",
  "push.title": "Anomaly on {{projectName}}",
  "push.body": "{{metric}} {{direction}} {{magnitudePct}}% / {{windowMinutes}} min"
}
```

(Mirror in tr.)

- [ ] **Step 2: Template component**

```tsx
// src/revenue/anomaly-detected.tsx
import { Button, Heading, Text } from "@react-email/components";
import { BaseLayout } from "../layouts/base-layout";
import type { TemplateModule } from "../registry";
import type { TFunction } from "i18next";

interface Ctx {
  projectId: string;
  projectName: string;
  metric: "mrr" | "subs" | "churn";
  direction: "up" | "down";
  magnitudePct: number;
  windowMinutes: number;
  dashboardUrl: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
}

function Email({ ctx, t }: { ctx: Ctx; t: TFunction }): JSX.Element {
  const tt = (k: string, defaults?: Record<string, unknown>) =>
    t(`revenue.anomaly-detected:${k}`, { ...ctx, ...(defaults ?? {}) }) as string;
  return (
    <BaseLayout
      t={t}
      preview={tt("preview")}
      managePreferencesUrl={ctx.managePreferencesUrl}
      unsubscribeUrl={ctx.unsubscribeUrl}
    >
      <Heading>{tt("headline")}</Heading>
      <Text>{tt("body")}</Text>
      <Button
        href={ctx.dashboardUrl}
        style={{ background: "#111", color: "white", padding: "10px 16px", borderRadius: 6 }}
      >
        {tt("cta")}
      </Button>
    </BaseLayout>
  );
}

export const template: TemplateModule<Ctx> = {
  Component: Email,
  subject: (ctx, t) => t("revenue.anomaly-detected:subject", ctx) as string,
  pushTitle: (ctx, t) => t("revenue.anomaly-detected:push.title", ctx) as string,
  pushBody: (ctx, t) => t("revenue.anomaly-detected:push.body", ctx) as string,
};
```

- [ ] **Step 3: Registry**

```ts
// src/registry.ts
import { render } from "@react-email/render";
import type { JSX } from "react";
import type { TFunction } from "i18next";
import { getT } from "./i18n";

import { template as anomalyDetected } from "./revenue/anomaly-detected";
// (more imports as templates land — Phase 6)

export interface TemplateModule<Ctx> {
  Component: (props: { ctx: Ctx; t: TFunction }) => JSX.Element;
  subject: (ctx: Ctx, t: TFunction) => string;
  pushTitle: (ctx: Ctx, t: TFunction) => string;
  pushBody: (ctx: Ctx, t: TFunction) => string;
}

const TEMPLATES: Record<string, TemplateModule<any>> = {
  "revenue.anomaly.detected": anomalyDetected,
  // ...
};

export interface RenderInput {
  eventKey: string;
  locale: string;
  context: Record<string, unknown>;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
}

export interface RenderOutput {
  subject: string;
  html: string;
  text: string;
  pushTitle: string;
  pushBody: string;
}

export function renderTemplate(input: RenderInput): RenderOutput {
  const mod = TEMPLATES[input.eventKey];
  if (!mod) throw new Error(`no template for event ${input.eventKey}`);
  const t = getT(input.locale);
  const ctx = {
    ...input.context,
    managePreferencesUrl: input.managePreferencesUrl,
    unsubscribeUrl: input.unsubscribeUrl,
  };
  const element = <mod.Component ctx={ctx as any} t={t} />;
  const html = render(element);
  const text = render(element, { plainText: true });
  return {
    subject: mod.subject(ctx, t),
    html,
    text,
    pushTitle: mod.pushTitle(ctx, t),
    pushBody: mod.pushBody(ctx, t),
  };
}
```

- [ ] **Step 4: Snapshot test**

```ts
// registry.test.ts
import { describe, it, expect } from "vitest";
import { renderTemplate } from "./registry";

describe("renderTemplate(revenue.anomaly.detected)", () => {
  it("renders subject + html + pushTitle in en", () => {
    const r = renderTemplate({
      eventKey: "revenue.anomaly.detected",
      locale: "en",
      context: {
        projectId: "p1",
        projectName: "Acme",
        metric: "mrr",
        direction: "down",
        magnitudePct: 12,
        windowMinutes: 60,
        dashboardUrl: "https://app.rovenue.io/projects/p1",
      },
      managePreferencesUrl: "https://app.rovenue.io/account/notifications",
    });
    expect(r.subject).toMatchInlineSnapshot('"Anomaly detected on Acme"');
    expect(r.pushTitle).toBe("Anomaly on Acme");
    expect(r.html).toMatch(/Acme/);
    expect(r.text).toMatch(/Acme/);
  });

  it("falls back to en for unknown locale", () => {
    const r = renderTemplate({
      eventKey: "revenue.anomaly.detected",
      locale: "de",
      context: { /* ... */ },
      managePreferencesUrl: "x",
    });
    expect(r.subject).toContain("Anomaly");
  });
});
```

- [ ] **Step 5: Commit**

```bash
git add packages/email-templates/
git commit -m "feat(email-templates): registry + revenue.anomaly.detected template"
```

---

## Phase 6 — Remaining 15 templates

For each remaining event in the catalog, follow exactly the pattern from Task 5.4: locale JSON (en + tr), template component, registry entry, snapshot test. List of templates to create, with key per-template content notes:

| Event | Subject (en) | Push title/body |
|---|---|---|
| `revenue.digest.daily` | `Your Rovenue daily digest — {{date}}` | (no push; pushAllowed: false) |
| `revenue.digest.weekly` | `Your Rovenue weekly summary — {{weekStart}}` | (no push) |
| `revenue.churn.spike` | `Churn spike on {{projectName}}` | `Churn spike on {{projectName}}` / `{{churnRatePct}}% vs {{baselinePct}}% baseline` |
| `revenue.milestone.hit` | `Milestone hit on {{projectName}}` | (no push) |
| `billing.refund.detected` | `Refund detected on {{projectName}}` | `Refund $X on {{projectName}}` / `{{amount.amount}} {{amount.currency}} — {{reason}}` |
| `billing.credit.low_balance` | `Low credit balance on {{projectName}}` | `Low balance on {{projectName}}` / `Balance: {{balanceCents}} ¢ (threshold {{thresholdCents}})` |
| `billing.invoice.failed` | `Your Rovenue invoice failed to charge` | `Invoice failed` / `{{amount.amount}} {{amount.currency}} — {{reason}}` |
| `billing.invoice.paid` | `Your Rovenue invoice was paid` | (no push) |
| `integration.store_credential.expired` | `{{provider}} credentials expired on {{projectName}}` | `{{provider}} creds expired` / `Reconnect to keep verifying receipts` |
| `integration.webhook.failing` | `Webhook delivery failing on {{projectName}}` | (no push) |
| `team.member.invited` | `You've been invited to {{projectName}}` | (no push) |
| `team.member.role_changed` | `Your role on {{projectName}} changed` | (no push) |
| `team.member.removed` | `You've been removed from {{projectName}}` | (no push) |
| `security.signin.new_device` | `New sign-in from {{userAgent}}` | `New sign-in to your account` / `{{userAgent}} · {{approxLocation}}` |
| `security.oauth.account_linked` | `Your {{provider}} account is now linked` | (no push) |

### Task 6.1 – Task 6.15

For each row, one task:

- [ ] **Step 1**: write `locales/en/<category>.<event-suffix>.json` and `locales/tr/<event-suffix>.json` with at minimum: `subject`, `preview`, `headline`, `body`, `cta`. If the event has push, add `push.title` + `push.body`.
- [ ] **Step 2**: write the `.tsx` component following the `anomaly-detected.tsx` shape from Task 5.4. Bodies differ by event:
   - `digest-daily.tsx` renders a `<Section>` per `ctx.sections[i]` showing MRR delta, new subs, churn count, refund total.
   - `digest-weekly.tsx` is the same but covers a week range.
   - `refund-detected.tsx` shows the refund amount formatted with `Intl.NumberFormat` using the currency, plus the reason.
   - `invited.tsx` lifts the existing template from the invite spec — copy file contents from `apps/api/src/lib/email-templates/invitation.tsx` into the new location, delete the old file in the same commit, and update the invite flow's import.
   - `signin-new-device.tsx` includes the IP, approxLocation if present, user-agent, and ISO timestamp; CTA "Review devices" → `/account/security`.
   - Others follow the obvious shape: headline (from i18n), one or two paragraphs, optional CTA.
- [ ] **Step 3**: register in `src/registry.ts` (append to the `TEMPLATES` map).
- [ ] **Step 4**: snapshot test in `<event-suffix>.test.tsx` — render with a representative `ctx`, assert subject + html contains the event-specific marker (e.g., refund template asserts the rendered amount string).
- [ ] **Step 5**: Commit with message `feat(email-templates): <event-key> template`.

When all 15 are committed, run the full template test suite:

```
pnpm --filter @rovenue/email-templates test
```

Expected: green, 16 events total.

---

## Phase 7 — Email transport integration

### Task 7.0: `notification_suppression_list` table

**Correction to spec dependency declaration:** the spec assumes this table ships in the invite spec. It does not — the invite spec uses per-row `projectInvitations.deliveryStatus` and exposes `findCrossProjectSuppression(db, email)` to look across invitations. That model does not fit notifications (we need a global "do not email this address" list, not a per-row history). This task creates the dedicated table; the invite-spec helper continues to work alongside it (invites check both lists before sending).

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts`
- Create: `packages/db/drizzle/migrations/<next>_notification_suppression_list.sql`
- Create: `packages/db/src/drizzle/repositories/notification-suppression.ts`
- Test: `packages/db/src/drizzle/repositories/notification-suppression.integration.test.ts`

- [ ] **Step 1: Schema**

```ts
export const notificationSuppressionReason = pgEnum(
  "NotificationSuppressionReason",
  ["hard_bounce", "complaint", "manual"],
);

export const notificationSuppressionList = pgTable(
  "notification_suppression_list",
  {
    email: text("email").primaryKey(),
    reason: notificationSuppressionReason("reason").notNull(),
    source: text("source"),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export type NotificationSuppression =
  typeof notificationSuppressionList.$inferSelect;
```

- [ ] **Step 2: Generate + apply migration**

```
pnpm db:migrate:generate
pnpm db:migrate
```

- [ ] **Step 3: Repo**

```ts
import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../client";
import { notificationSuppressionList } from "../schema";

export const notificationSuppressionRepo = {
  async isSuppressed(db: DrizzleDb, email: string): Promise<boolean> {
    const rows = await db
      .select({ email: notificationSuppressionList.email })
      .from(notificationSuppressionList)
      .where(eq(notificationSuppressionList.email, email.toLowerCase()))
      .limit(1);
    return rows.length > 0;
  },

  async add(
    db: DrizzleDb,
    input: { email: string; reason: "hard_bounce" | "complaint" | "manual"; source?: string },
  ): Promise<void> {
    await db
      .insert(notificationSuppressionList)
      .values({
        email: input.email.toLowerCase(),
        reason: input.reason,
        source: input.source,
      })
      .onConflictDoNothing();
  },
};
```

- [ ] **Step 4: Integration test** — insert + isSuppressed round-trip, lowercasing applied, ON CONFLICT no-op idempotent.

- [ ] **Step 5: Commit**

```bash
git add packages/db/
git commit -m "feat(db): notification_suppression_list table + repo"
```

### Task 7.1: `SmtpMailer` adapter

**Files:**
- Create: `apps/api/src/lib/mailer-smtp.ts`
- Test: `apps/api/src/lib/mailer-smtp.test.ts`

The invite spec ships the `Mailer` interface and `SesMailer`. This task implements the SMTP fallback against the same interface so self-hosted instances work without AWS credentials.

- [ ] **Step 1: Write the test (with a stubbed nodemailer transport)**

```ts
import { describe, it, expect, vi } from "vitest";
import nodemailer from "nodemailer";
import { SmtpMailer } from "./mailer-smtp";

describe("SmtpMailer", () => {
  it("sends a message through the configured transport", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<abc@host>" });
    vi.spyOn(nodemailer, "createTransport").mockReturnValue({ sendMail } as never);

    const m = new SmtpMailer({
      host: "smtp.example.com",
      port: 587,
      user: "u",
      pass: "p",
      secure: false,
      from: "Rovenue <notifications@rovenue.io>",
    });
    const r = await m.send({
      to: "x@y.com",
      subject: "hi",
      html: "<b>hello</b>",
      text: "hello",
      headers: { "List-Unsubscribe": "<https://x>" },
    });
    expect(r.providerMessageId).toBe("<abc@host>");
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "x@y.com",
        subject: "hi",
        headers: { "List-Unsubscribe": "<https://x>" },
      }),
    );
  });
});
```

- [ ] **Step 2: Implement**

```ts
import nodemailer, { type Transporter } from "nodemailer";
import type { Mailer, MailerSendInput, MailerSendResult } from "./mailer"; // from invite spec

export interface SmtpMailerOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
  from: string;
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  constructor(private readonly opts: SmtpMailerOptions) {
    this.transport = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: { user: opts.user, pass: opts.pass },
    });
  }

  async send(input: MailerSendInput): Promise<MailerSendResult> {
    const result = await this.transport.sendMail({
      from: this.opts.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      headers: input.headers,
    });
    return { providerMessageId: result.messageId };
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/mailer-smtp.ts apps/api/src/lib/mailer-smtp.test.ts
git commit -m "feat(api): SMTP mailer adapter implementing Mailer interface"
```

### Task 7.2: Mailer factory + env wiring

**Files:**
- Modify: `apps/api/src/lib/mailer.ts` *(invite-spec file — extend with factory)*
- Modify: `apps/api/src/lib/env.ts` (add SMTP envs)
- Modify: `.env.example`

- [ ] **Step 1: Env vars**

Add to `apps/api/src/lib/env.ts`:

```ts
EMAIL_PROVIDER: z.enum(["ses", "smtp"]).default("ses"),
SMTP_HOST: z.string().optional(),
SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
SMTP_USER: z.string().optional(),
SMTP_PASS: z.string().optional(),
SMTP_SECURE: z.coerce.boolean().default(false),
SES_CONFIGURATION_SET: z.string().default("rovenue-notifications"),
```

Same in `.env.example`.

- [ ] **Step 2: Factory in `mailer.ts`**

Append to `apps/api/src/lib/mailer.ts`:

```ts
import { SmtpMailer } from "./mailer-smtp";

export function createMailerFromEnv(env: Env): Mailer {
  if (env.EMAIL_PROVIDER === "smtp") {
    if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_USER || !env.SMTP_PASS) {
      throw new Error("EMAIL_PROVIDER=smtp requires SMTP_HOST/PORT/USER/PASS");
    }
    return new SmtpMailer({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      secure: env.SMTP_SECURE,
      from: `${env.EMAIL_FROM_NAME} <${env.EMAIL_FROM_ADDRESS}>`,
    });
  }
  return new SesMailer({
    region: env.AWS_REGION,
    configurationSet: env.SES_CONFIGURATION_SET,
    from: `${env.EMAIL_FROM_NAME} <${env.EMAIL_FROM_ADDRESS}>`,
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/mailer.ts apps/api/src/lib/env.ts .env.example
git commit -m "feat(api): mailer factory selects SES or SMTP from env"
```

### Task 7.3: Unsubscribe token signing

**Files:**
- Create: `apps/api/src/lib/unsubscribe-token.ts`
- Test: `apps/api/src/lib/unsubscribe-token.test.ts`
- Modify: `apps/api/src/lib/env.ts` (add `UNSUB_SIGNING_KEY`)
- Modify: `.env.example`

- [ ] **Step 1: Env var**

```ts
UNSUB_SIGNING_KEY: z.string().regex(/^[0-9a-f]{64}$/, "32-byte hex"),
```

- [ ] **Step 2: Implement**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export interface UnsubscribePayload {
  userId: string;
  scope: "channel:email" | `event:${string}`;
  projectId?: string;
  exp: number;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function base64UrlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function signUnsubscribeToken(
  payload: UnsubscribePayload,
  keyHex: string,
): string {
  const key = Buffer.from(keyHex, "hex");
  const body = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const sig = base64UrlEncode(
    createHmac("sha256", key).update(body).digest(),
  );
  return `${body}.${sig}`;
}

export function verifyUnsubscribeToken(
  token: string,
  keyHex: string,
  nowMs: number = Date.now(),
): UnsubscribePayload {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new Error("malformed unsubscribe token");
  const key = Buffer.from(keyHex, "hex");
  const expectedSig = base64UrlEncode(
    createHmac("sha256", key).update(body).digest(),
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("invalid unsubscribe signature");
  }
  const payload = JSON.parse(base64UrlDecode(body).toString()) as UnsubscribePayload;
  if (payload.exp * 1000 < nowMs) throw new Error("expired unsubscribe token");
  return payload;
}
```

- [ ] **Step 3: Tests** — round-trip, expired, tampered body, invalid signature.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/unsubscribe-token.ts apps/api/src/lib/unsubscribe-token.test.ts apps/api/src/lib/env.ts .env.example
git commit -m "feat(api): HMAC-signed unsubscribe tokens"
```

### Task 7.4: List-Unsubscribe header builder + suppression pre-check

**Files:**
- Create: `apps/api/src/services/notifications/email-headers.ts`
- Create: `apps/api/src/services/notifications/suppression.ts`
- Tests: `*.test.ts`

- [ ] **Step 1: Headers builder**

```ts
// email-headers.ts
import { getEvent } from "@rovenue/shared/notifications/event-catalog";
import { signUnsubscribeToken } from "../../lib/unsubscribe-token";

export function buildEmailHeaders(input: {
  eventKey: string;
  userId: string;
  projectId?: string;
  dashboardUrl: string;
  signingKey: string;
  mailtoUnsub: string;          // "unsub@rovenue.io"
}): Record<string, string> {
  const event = getEvent(input.eventKey);
  const channelForced = event.forcedChannels.includes("email");
  if (channelForced) {
    return {}; // forced events ship without List-Unsubscribe (RFC 8058 not applicable)
  }
  const token = signUnsubscribeToken(
    {
      userId: input.userId,
      scope: "channel:email",
      projectId: input.projectId,
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    },
    input.signingKey,
  );
  return {
    "List-Unsubscribe": `<${input.dashboardUrl}/unsubscribe?token=${token}>, <mailto:${input.mailtoUnsub}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
```

Test cases: forced event → empty headers; non-forced → both headers present; token is verifiable round-trip.

- [ ] **Step 2: Suppression service** (thin wrapper over the invite-spec suppression table; rejects sends and writes a `notification_deliveries` row with `status='suppressed'`)

```ts
// suppression.ts
import { notificationSuppressionRepo } from "@rovenue/db/repositories/notification-suppression";
import type { DrizzleDb } from "@rovenue/db";

export async function isSuppressed(
  db: DrizzleDb,
  emailLower: string,
): Promise<boolean> {
  return notificationSuppressionRepo.isSuppressed(db, emailLower);
}
```

- [ ] **Step 3: Commit (one per file)**

```bash
git add apps/api/src/services/notifications/email-headers.ts \
        apps/api/src/services/notifications/email-headers.test.ts
git commit -m "feat(api): List-Unsubscribe header builder"

git add apps/api/src/services/notifications/suppression.ts \
        apps/api/src/services/notifications/suppression.test.ts
git commit -m "feat(api): suppression-list pre-send check"
```

---

## Phase 8 — Push transports + push_devices

### Task 8.1: Transport interface + factory

**Files:**
- Create: `apps/api/src/lib/push/transport.ts`
- Create: `apps/api/src/lib/push/index.ts`

```ts
// transport.ts
import type { PushPlatform } from "@rovenue/shared/notifications/types";

export interface PushMessage {
  deviceToken: string;
  title: string;
  body: string;
  data: Record<string, string>;
  badge?: number;
  threadId?: string;
  collapseKey?: string;
}

export interface PushSendResult {
  providerMessageId: string;
}

export interface PushSendOutcome {
  ok: true;
  result: PushSendResult;
}
export interface PushSendFailure {
  ok: false;
  error: string;
  permanent: boolean;   // permanent → revoke the token
  raw: unknown;
}

export interface PushTransport {
  platform: PushPlatform;
  send(message: PushMessage): Promise<PushSendOutcome | PushSendFailure>;
}
```

```ts
// index.ts
import type { Env } from "../env";
import type { PushTransport } from "./transport";
import { ApnsPushTransport } from "./apns";
import { FcmPushTransport } from "./fcm";

export function createPushTransports(
  env: Env,
): { ios?: PushTransport; android?: PushTransport } {
  const out: { ios?: PushTransport; android?: PushTransport } = {};
  if (env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_KEY_P8 && env.APNS_BUNDLE_ID) {
    out.ios = new ApnsPushTransport({
      keyId: env.APNS_KEY_ID,
      teamId: env.APNS_TEAM_ID,
      keyP8: env.APNS_KEY_P8,
      bundleId: env.APNS_BUNDLE_ID,
      environment: env.APNS_ENVIRONMENT,
    });
  }
  if (env.FCM_SERVICE_ACCOUNT_JSON) {
    out.android = new FcmPushTransport({
      serviceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON,
    });
  }
  return out;
}

export type { PushTransport, PushMessage } from "./transport";
```

Add env to `env.ts`: APNS_KEY_ID/TEAM_ID/KEY_P8/BUNDLE_ID/ENVIRONMENT, FCM_SERVICE_ACCOUNT_JSON.

- [ ] Commit:

```bash
git add apps/api/src/lib/push/ apps/api/src/lib/env.ts .env.example
git commit -m "feat(api): push transport interface + env factory"
```

### Task 8.2: `ApnsPushTransport`

**Files:**
- Create: `apps/api/src/lib/push/apns.ts`
- Test: `apps/api/src/lib/push/apns.test.ts`

Use the `apns2` library (or `@parse/node-apn`). Stubbed test:

- [ ] **Step 1: Test (stub the HTTP/2 client)**

```ts
import { describe, it, expect, vi } from "vitest";
import { ApnsPushTransport } from "./apns";

describe("ApnsPushTransport", () => {
  it("returns ok on 200", async () => {
    const sender = vi.fn().mockResolvedValue({ statusCode: 200, headers: { "apns-id": "abc" } });
    const t = new ApnsPushTransport({ /* ... */ }, sender);
    const r = await t.send({
      deviceToken: "tok",
      title: "Hi",
      body: "msg",
      data: { url: "/x" },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.result.providerMessageId).toBe("abc");
  });

  it("marks BadDeviceToken as permanent", async () => {
    const sender = vi.fn().mockResolvedValue({
      statusCode: 400,
      body: { reason: "BadDeviceToken" },
    });
    const t = new ApnsPushTransport({ /* ... */ }, sender);
    const r = await t.send({ /* ... */ } as never);
    expect(r.ok).toBe(false);
    expect(r.ok || r.permanent).toBe(true);
  });

  it("treats 5xx as non-permanent", async () => {
    const sender = vi.fn().mockResolvedValue({ statusCode: 503 });
    const t = new ApnsPushTransport({ /* ... */ }, sender);
    const r = await t.send({ /* ... */ } as never);
    expect(r.ok || r.permanent).toBe(false);
  });
});
```

- [ ] **Step 2: Implementation skeleton** — token-based auth (JWT signed with .p8), HTTP/2 POST to `api.push.apple.com` (or `api.sandbox.push.apple.com` for sandbox). Payload:

```ts
{
  aps: {
    alert: { title, body },
    "thread-id": threadId,
    "mutable-content": 1,
  },
  data,
}
```

Headers: `authorization: bearer <jwt>`, `apns-topic: bundleId`, `apns-push-type: alert`.

Sender param is injectable for tests. Classify response: 200 ok; 400 with `BadDeviceToken` / `Unregistered` permanent; 410 permanent; 5xx transient.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/push/apns.ts apps/api/src/lib/push/apns.test.ts
git commit -m "feat(api): APNs push transport (token-based auth)"
```

### Task 8.3: `FcmPushTransport`

**Files:**
- Create: `apps/api/src/lib/push/fcm.ts`
- Test: `apps/api/src/lib/push/fcm.test.ts`

Uses `firebase-admin/messaging`. Tests stub the `messaging.send` function.

- [ ] **Step 1: Test fixtures** for the three branches (ok, permanent `messaging/registration-token-not-registered`, transient `messaging/server-unavailable`).
- [ ] **Step 2: Implementation** initializes the Admin app from a parsed service-account JSON; `send()` calls `getMessaging(app).send({ token, notification: { title, body }, data, android: { collapseKey } })` and classifies the error code.
- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/push/fcm.ts apps/api/src/lib/push/fcm.test.ts
git commit -m "feat(api): FCM push transport (v1 HTTP API)"
```

---

## Phase 9 — Notifier worker

### Task 9.1: Worker skeleton + Kafka consume + DLQ

**Files:**
- Create: `apps/api/src/workers/notifier.ts`
- Create: `apps/api/src/workers/notifier-entry.ts`
- Test: `apps/api/src/workers/notifier.integration.test.ts`

- [ ] **Step 1: Skeleton that consumes, validates payload, writes DLQ on failure**

```ts
// notifier.ts
import { Consumer, Kafka } from "kafkajs";
import { z } from "zod";
import type { Logger } from "pino";
import type { DrizzleDb } from "@rovenue/db";

const NotifyPayload = z.object({
  eventKey: z.string(),
  eventId: z.string(),
  projectId: z.string().uuid().optional(),
  recipients: z.array(z.string()).optional(),
  context: z.record(z.any()),
});

export interface NotifierDeps {
  kafka: Kafka;
  db: DrizzleDb;
  logger: Logger;
  processMessage: (payload: z.infer<typeof NotifyPayload>) => Promise<void>;
}

export async function startNotifier(deps: NotifierDeps): Promise<Consumer> {
  const consumer = deps.kafka.consumer({ groupId: "notifier" });
  const producer = deps.kafka.producer();
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: "rovenue.notifications", fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      const raw = message.value?.toString() ?? "{}";
      try {
        const parsed = NotifyPayload.parse(JSON.parse(raw));
        await deps.processMessage(parsed);
      } catch (err) {
        deps.logger.error({ err, raw }, "notifier.parse_or_process_failed");
        await producer.send({
          topic: "rovenue.notifications.dlq",
          messages: [{ value: raw, headers: { error: String(err) } }],
        });
      }
    },
  });
  return consumer;
}
```

- [ ] **Step 2: Entry-point** (`notifier-entry.ts`) wires env → Kafka client → `startNotifier` with the real `processMessage` from Task 9.3 onward.

- [ ] **Step 3: Test** publishes a message to `rovenue.notifications` via testcontainers and asserts the stub `processMessage` was called. Invalid JSON test asserts a DLQ message.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/workers/notifier.ts apps/api/src/workers/notifier-entry.ts \
        apps/api/src/workers/notifier.integration.test.ts
git commit -m "feat(api): notifier worker skeleton with Kafka consume + DLQ"
```

### Task 9.2: LRU caches with Redis pub/sub invalidation

**Files:**
- Create: `apps/api/src/services/notifications/prefs-cache.ts`
- Test: `apps/api/src/services/notifications/prefs-cache.test.ts`

```ts
// prefs-cache.ts
import { LRUCache } from "lru-cache";
import type { Redis } from "ioredis";

interface PrefsCache {
  userPrefs: LRUCache<string, unknown>;
  projectDefaults: LRUCache<string, unknown>;
  projectMembers: LRUCache<string, unknown>;
}

export function createPrefsCache(redis: Redis): PrefsCache {
  const cache: PrefsCache = {
    userPrefs: new LRUCache({ max: 5000, ttl: 60_000 }),
    projectDefaults: new LRUCache({ max: 5000, ttl: 60_000 }),
    projectMembers: new LRUCache({ max: 5000, ttl: 60_000 }),
  };
  // Subscribe and invalidate.
  const sub = redis.duplicate();
  sub.subscribe("notifications.cache.invalidate");
  sub.on("message", (_ch, raw) => {
    const msg = JSON.parse(raw) as { kind: string; key: string };
    if (msg.kind === "userPrefs") cache.userPrefs.delete(msg.key);
    if (msg.kind === "projectDefaults") cache.projectDefaults.delete(msg.key);
    if (msg.kind === "projectMembers") {
      // Drop any composite key starting with projectId.
      for (const k of cache.projectMembers.keys()) {
        if (k.startsWith(`${msg.key}:`)) cache.projectMembers.delete(k);
      }
    }
  });
  return cache;
}

export async function publishInvalidation(
  redis: Redis,
  kind: "userPrefs" | "projectDefaults" | "projectMembers",
  key: string,
): Promise<void> {
  await redis.publish(
    "notifications.cache.invalidate",
    JSON.stringify({ kind, key }),
  );
}
```

Test: publish from one redis client, assert subscriber cache entry is dropped.

- [ ] Commit:

```bash
git add apps/api/src/services/notifications/prefs-cache.ts apps/api/src/services/notifications/prefs-cache.test.ts
git commit -m "feat(api): notifier prefs cache + Redis invalidation pub/sub"
```

### Task 9.3: `processNotification` core logic

**Files:**
- Create: `apps/api/src/services/notifications/process-notification.ts`
- Test: `apps/api/src/services/notifications/process-notification.integration.test.ts`

Composes the helpers built so far. For each parsed payload:

1. `recipients = resolveRecipients(db, payload)`
2. For each `userId`:
   - Fetch `userChannels` + `projectDefaults` + `userOverrides` (cached).
   - `prefs = resolvePrefs({ userChannels, projectDefaults, userOverrides, eventKey })`
   - If `prefs.enabledChannels.length === 0`, skip.
   - `render = renderTemplate({ eventKey, locale: userChannels.locale, context, managePreferencesUrl, unsubscribeUrl })`
   - In a single tx:
     - `notificationsRepo.insertIdempotent(tx, {...})`. If null → already processed, skip.
     - `notificationDeliveriesRepo.insertMany(tx, [...])` one row per channel; `'inapp'` row gets `status='delivered'`, others `'queued'`.
     - Write audit row `notification.created`.
   - After tx: enqueue `notifier:send-email` and `notifier:send-push` BullMQ jobs (Phase 10) referencing delivery ids.

Test cases (integration, with stub send queues):

- Two recipients, one with email-off → only one email job enqueued.
- Idempotency: same outbox payload twice → one inapp row, one delivery set.
- Push-disallowed digest event → no push job even if user has push on.
- Suppression hit (email in suppression list) → delivery row `status='suppressed'`, no email job.

- [ ] Implementation, tests, commit:

```bash
git add apps/api/src/services/notifications/process-notification.ts \
        apps/api/src/services/notifications/process-notification.integration.test.ts
git commit -m "feat(api): processNotification — render + insert + enqueue"
```

### Task 9.4: Wire `processNotification` into the consumer entry-point

- [ ] **Step 1**: edit `notifier-entry.ts` so `processMessage` calls `processNotification(deps, payload)` with the wired deps (db, mailer, push transports, queues, cache).

- [ ] **Step 2**: integration test boots the whole loop end-to-end against testcontainers + stub transports.

- [ ] **Step 3**: Commit `feat(api): wire processNotification into notifier worker entry`.

---

## Phase 10 — BullMQ send workers

### Task 10.1: Queues + send-email worker

**Files:**
- Create: `apps/api/src/queues/notifier.ts`
- Create: `apps/api/src/workers/send-email-worker.ts`
- Test: `apps/api/src/workers/send-email-worker.integration.test.ts`

- [ ] **Step 1: Queue definition**

```ts
// queues/notifier.ts
import { Queue } from "bullmq";
import IORedis from "ioredis";

export interface SendEmailJob {
  deliveryId: string;
  to: string;
  headers: Record<string, string>;
  subject: string;
  html: string;
  text: string;
}
export interface SendPushJob {
  deliveryId: string;
  platform: "ios" | "android";
  deviceTokens: string[];
  title: string;
  body: string;
  data: Record<string, string>;
}

export function createNotifierQueues(redis: IORedis) {
  return {
    email: new Queue<SendEmailJob>("notifier:send-email", { connection: redis }),
    push: new Queue<SendPushJob>("notifier:send-push", { connection: redis }),
  };
}
```

- [ ] **Step 2: Worker** processes each job:
  - Pre-check suppression list; if hit → mark delivery `status='suppressed'`, return.
  - Call `mailer.send(...)`.
  - On success → `notificationDeliveriesRepo.markStatus(deliveryId, 'sent', { providerMessageId })`.
  - On exception → rethrow (BullMQ retries per `attempts: 4`).
  - After max attempts → BullMQ marks failed; we mark delivery `'failed'` in the `failed` handler.

```ts
// send-email-worker.ts
import { Worker } from "bullmq";
import type IORedis from "ioredis";
import type { Mailer } from "../lib/mailer";
import type { DrizzleDb } from "@rovenue/db";
import { notificationDeliveriesRepo } from "@rovenue/db/repositories/notification-deliveries";
import { isSuppressed } from "../services/notifications/suppression";
import type { SendEmailJob } from "../queues/notifier";

export function startSendEmailWorker(deps: {
  redis: IORedis;
  mailer: Mailer;
  db: DrizzleDb;
}): Worker<SendEmailJob> {
  const worker = new Worker<SendEmailJob>(
    "notifier:send-email",
    async (job) => {
      const { data } = job;
      if (await isSuppressed(deps.db, data.to.toLowerCase())) {
        await notificationDeliveriesRepo.markStatus(deps.db, data.deliveryId, "suppressed");
        return;
      }
      const result = await deps.mailer.send({
        to: data.to,
        subject: data.subject,
        html: data.html,
        text: data.text,
        headers: data.headers,
      });
      await notificationDeliveriesRepo.markStatus(
        deps.db, data.deliveryId, "sent",
        { providerMessageId: result.providerMessageId },
      );
    },
    {
      connection: deps.redis,
      concurrency: 10,
      limiter: { max: 14, duration: 1_000 },
    },
  );
  worker.on("failed", async (job, _err) => {
    if (job && job.attemptsMade >= job.opts.attempts!) {
      await notificationDeliveriesRepo.markStatus(deps.db, job.data.deliveryId, "failed");
    }
  });
  return worker;
}
```

- [ ] **Step 3: Test** (testcontainers Redis + stub Mailer) covers success, suppression, transient error retry, permanent failure.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/queues/notifier.ts apps/api/src/workers/send-email-worker.ts \
        apps/api/src/workers/send-email-worker.integration.test.ts
git commit -m "feat(api): notifier send-email worker"
```

### Task 10.2: send-push worker

**Files:**
- Create: `apps/api/src/workers/send-push-worker.ts`
- Test: `*.integration.test.ts`

Same shape as email worker. For each `deviceToken` in the job:

- Look up `push_devices` row by token to get the active platform.
- Pick the corresponding transport (`ios` or `android`).
- `await transport.send(message)`.
- On permanent failure → `pushDevicesRepo.revokeByToken(db, platform, token, reason)`, mark delivery `'failed'`.
- On success → first successful send marks delivery `'sent'` with that provider message id. (We don't multi-record per device in v1; a single delivery row stands for the user's "push" channel attempt.)

Tests cover: single device success, multi-device first-success-wins, all devices permanent fail → delivery `'failed'`, transient → retry.

```bash
git add apps/api/src/workers/send-push-worker.ts apps/api/src/workers/send-push-worker.integration.test.ts
git commit -m "feat(api): notifier send-push worker with token revocation"
```

---

## Phase 11 — Digest scheduler

### Task 11.1: Timezone enumeration

**Files:**
- Create: `apps/api/src/services/notifications/tz.ts`
- Test: `apps/api/src/services/notifications/tz.test.ts`

```ts
import { DateTime } from "luxon";

export function timezonesAtLocalHour(
  utcNow: Date,
  targetHour: number,
): string[] {
  // Iterate the IANA tz set. Luxon ships the full database.
  const allZones = Intl.supportedValuesOf("timeZone");
  const out: string[] = [];
  for (const zone of allZones) {
    const local = DateTime.fromJSDate(utcNow, { zone });
    if (local.hour === targetHour) out.push(zone);
  }
  return out;
}
```

Test cases: feed a UTC `Date` for `12:00Z`, expect `Asia/Tokyo` *not* present (already 21:00 there), but `America/Mexico_City` present at appropriate offsets. Cover DST transitions (March 8 2026 US spring-forward) — assert the timezones returned shift accordingly.

- [ ] Commit:

```bash
git add apps/api/src/services/notifications/tz.ts apps/api/src/services/notifications/tz.test.ts
git commit -m "feat(api): timezone-at-local-hour helper"
```

### Task 11.2: KPI fetcher (ClickHouse)

**Files:**
- Create: `apps/api/src/services/notifications/digest-kpi.ts`
- Test: `apps/api/src/services/notifications/digest-kpi.integration.test.ts`

```ts
// digest-kpi.ts
import type { ClickHouseClient } from "@clickhouse/client";

export interface DigestSection {
  projectId: string;
  projectName: string;
  mrr: number;
  mrrDelta: number;
  newSubs: number;
  churnedSubs: number;
  refundCount: number;
  refundTotalCents: number;
}

export async function fetchDailyKPIs(
  ch: ClickHouseClient | null,
  projectIds: string[],
  date: string, // YYYY-MM-DD in user TZ
): Promise<Map<string, DigestSection>> {
  if (!ch || projectIds.length === 0) return new Map();
  const rows = await ch.query({
    query: `
      SELECT project_id, mrr, mrr_delta, new_subs, churned_subs, refund_count, refund_total_cents
      FROM revenue_events_summary_daily
      WHERE project_id IN ({projectIds:Array(String)})
        AND day = {date:Date}`,
    query_params: { projectIds, date },
    format: "JSONEachRow",
  });
  const data = (await rows.json()) as Array<{
    project_id: string;
    mrr: number;
    mrr_delta: number;
    new_subs: number;
    churned_subs: number;
    refund_count: number;
    refund_total_cents: number;
  }>;
  // ... map into sections; merge with project name lookup
}

export function hasActivity(section: DigestSection): boolean {
  return (
    section.mrrDelta !== 0 ||
    section.newSubs > 0 ||
    section.churnedSubs > 0 ||
    section.refundCount > 0
  );
}
```

Integration test uses testcontainers ClickHouse + seed fixture.

- [ ] Commit:

```bash
git add apps/api/src/services/notifications/digest-kpi.ts apps/api/src/services/notifications/digest-kpi.integration.test.ts
git commit -m "feat(api): digest KPI fetch from ClickHouse"
```

### Task 11.3: Digest scheduler

**Files:**
- Create: `apps/api/src/workers/digest-scheduler.ts`
- Create: `apps/api/src/workers/digest-scheduler-entry.ts`
- Test: `apps/api/src/workers/digest-scheduler.integration.test.ts`

Worker flow per spec §4:

1. `timezonesAtLocalHour(new Date(), 9)`.
2. Stream users whose `user_preferences.timezone` is in that set, in batches of 500.
3. For each user: query digestable projects, fetch KPIs, filter `hasActivity`, emit one `notification.dispatch` outbox row via `emitNotification` inside a tx.

```ts
import { Queue, Worker } from "bullmq";

export function startDigestScheduler(deps: { redis, db, ch, logger }) {
  const queue = new Queue("digest", { connection: deps.redis });
  queue.add("digest.daily", null, { repeat: { pattern: "0 * * * *" } });
  queue.add("digest.weekly", null, { repeat: { pattern: "0 * * * 1" } });
  new Worker("digest", async (job) => {
    if (job.name === "digest.daily") await runDailyTick(deps);
    if (job.name === "digest.weekly") await runWeeklyTick(deps);
  }, { connection: deps.redis });
}
```

Integration test: seed two users (one in `Europe/Istanbul` at 09:00 local, one in `UTC` at not-09:00). Fixed `Date.now()` via vitest. Assert only the Istanbul user gets an outbox row.

- [ ] Commit:

```bash
git add apps/api/src/workers/digest-scheduler*.ts apps/api/src/workers/digest-scheduler.integration.test.ts
git commit -m "feat(api): daily + weekly digest scheduler"
```

---

## Phase 12 — SES feedback + unsubscribe flow

### Task 12.1: SNS signature verification middleware

**Files:**
- Create: `apps/api/src/middleware/sns-signature.ts`
- Test: `apps/api/src/middleware/sns-signature.test.ts`

Uses `aws-sns-message-validator` (or the equivalent helper from invite spec; reuse if it exists there). Verifies signature against AWS-published cert URL with TLS validation.

```ts
// sns-signature.ts
import { createMiddleware } from "hono/factory";
import MessageValidator from "sns-validator";

const validator = new MessageValidator();

export const requireSnsSignature = createMiddleware(async (c, next) => {
  const body = await c.req.json();
  await new Promise<void>((resolve, reject) =>
    validator.validate(body, (err) => (err ? reject(err) : resolve())),
  );
  c.set("snsMessage", body);
  await next();
});
```

Tests use a fixture from AWS docs.

- [ ] Commit:

```bash
git add apps/api/src/middleware/sns-signature.ts apps/api/src/middleware/sns-signature.test.ts
git commit -m "feat(api): SNS signature verification middleware"
```

### Task 12.2: SES feedback route

**Files:**
- Create: `apps/api/src/routes/internal/ses-feedback.ts`
- Test: `apps/api/src/routes/internal/ses-feedback.integration.test.ts`
- Modify: `apps/api/src/index.ts` (mount route)

Handler:

- `SubscriptionConfirmation` → auto-confirm via the embedded URL.
- `Notification` with `notificationType=Bounce` + `bounceType=Permanent` → insert into `notification_suppression_list` with `reason='hard_bounce'`; mark matching delivery `'bounced'`.
- `Complaint` → insert with `reason='complaint'`; flip `user_preferences.notifications.channels.email = false` for the matching user.
- Soft bounce → mark delivery `'bounced'`; no suppression.

Tests cover each branch with fixture payloads.

- [ ] Commit:

```bash
git add apps/api/src/routes/internal/ses-feedback.ts apps/api/src/routes/internal/ses-feedback.integration.test.ts apps/api/src/index.ts
git commit -m "feat(api): SES feedback webhook (bounce + complaint)"
```

### Task 12.3: Unsubscribe public route

**Files:**
- Create: `apps/api/src/routes/public/unsubscribe.ts`
- Test: `apps/api/src/routes/public/unsubscribe.integration.test.ts`
- Modify: `apps/api/src/index.ts` (mount)

Endpoints:

- `POST /unsubscribe` — body `{ token }`. Verify token; if `scope === 'channel:email'`, set `user_preferences.notifications.channels.email = false`; if `scope === 'event:<key>'`, upsert `user_project_notification_prefs.overrides[key] = false` (requires projectId on token). Audit row. Returns `204`.

Frontend renders the GET landing (Phase 14 — `routes/unsubscribe.tsx`).

Tests cover: valid `channel:email` token → flips channel; valid `event:<key>` with projectId → flips override; forced event token → 400; expired token → 401; missing token → 400.

- [ ] Commit:

```bash
git add apps/api/src/routes/public/unsubscribe.ts apps/api/src/routes/public/unsubscribe.integration.test.ts apps/api/src/index.ts
git commit -m "feat(api): unsubscribe endpoint (RFC 8058 one-click)"
```

---

## Phase 13 — Dashboard API endpoints

### Task 13.1: Feed routes

**Files:**
- Create: `apps/api/src/routes/dashboard/notifications/index.ts`
- Test: `*.integration.test.ts`

Routes:

- `GET /api/dashboard/notifications` → cursor-paginated list. Uses `notificationsRepo.listForUser`.
- `GET /api/dashboard/notifications/unread-count`.
- `POST /api/dashboard/notifications/:id/read`.
- `POST /api/dashboard/notifications/read-all`.

Auth: existing Better Auth session middleware. Per-user ownership enforced in repo queries.

Tests cover: forbidden access to another user's notification (404 not 403, to not leak existence); cursor pagination boundary; read-all with `projectId` only marks within that project.

- [ ] Commit (one per endpoint or grouped):

```bash
git add apps/api/src/routes/dashboard/notifications/
git commit -m "feat(api): dashboard notification feed routes"
```

### Task 13.2: Preferences routes

**Files:**
- Create: `apps/api/src/routes/dashboard/notifications/preferences.ts`
- Test: `*.integration.test.ts`

- `GET /api/dashboard/notifications/preferences?projectId=` — resolved view.
- `PATCH /api/dashboard/notifications/preferences` — discriminated union body (global vs project). On forced-event override request, 400 `FORCED_EVENT`. After write, publish `notifications.cache.invalidate` Redis message.

Tests cover: global channel update, project override merge (existing untouched keys preserved), forced event rejection.

- [ ] Commit:

```bash
git add apps/api/src/routes/dashboard/notifications/preferences.ts apps/api/src/routes/dashboard/notifications/preferences.integration.test.ts
git commit -m "feat(api): notification preferences routes"
```

### Task 13.3: Push device routes

**Files:**
- Create: `apps/api/src/routes/dashboard/push-devices.ts`
- Test: `*.integration.test.ts`

- `POST /api/dashboard/push-devices` — upsert with conflict-on-token transferring ownership.
- `GET /api/dashboard/push-devices` — list active.
- `DELETE /api/dashboard/push-devices/:id` — revoke.

Rate limit 10/min/user on POST.

- [ ] Commit:

```bash
git add apps/api/src/routes/dashboard/push-devices.ts apps/api/src/routes/dashboard/push-devices.integration.test.ts
git commit -m "feat(api): dashboard push device routes"
```

### Task 13.4: Project notification defaults

**Files:**
- Create: `apps/api/src/routes/dashboard/project-notification-defaults.ts`
- Test: `*.integration.test.ts`

- `GET /api/dashboard/projects/:projectId/notification-defaults` — any member.
- `PATCH /api/dashboard/projects/:projectId/notification-defaults` — OWNER + ADMIN only. After write, publish cache invalidation.

- [ ] Commit:

```bash
git add apps/api/src/routes/dashboard/project-notification-defaults.ts apps/api/src/routes/dashboard/project-notification-defaults.integration.test.ts
git commit -m "feat(api): project notification defaults routes"
```

### Task 13.5: Test-send internal endpoint

**Files:**
- Create: `apps/api/src/routes/internal/notification-test.ts`
- Test: `*.integration.test.ts`

Single endpoint `POST /v1/internal/notification-test` (Better Auth session required, role check: OWNER on any project). Emits a synthetic `security.signin.new_device` outbox row addressed to the caller. Disabled when `NODE_ENV === 'development'` (returns 404).

- [ ] Commit:

```bash
git add apps/api/src/routes/internal/notification-test.ts apps/api/src/routes/internal/notification-test.integration.test.ts apps/api/src/index.ts
git commit -m "feat(api): notification test-send internal endpoint"
```

---

## Phase 14 — Dashboard frontend

### Task 14.1: Hooks

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useNotifications.ts`
- Create: `apps/dashboard/src/lib/hooks/useNotificationPreferences.ts`
- Create: `apps/dashboard/src/lib/hooks/usePushDevices.ts`
- Create: `apps/dashboard/src/lib/hooks/useProjectNotificationDefaults.ts`

TanStack Query hooks wrapping the API endpoints. Sample shape for `useNotifications`:

```ts
export function useUnreadCount() {
  return useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: async () =>
      (await api.get("/api/dashboard/notifications/unread-count")).data,
    refetchInterval: 30_000,
  });
}

export function useFeed(opts: { unreadOnly?: boolean; projectId?: string }) {
  return useInfiniteQuery({
    queryKey: ["notifications", "feed", opts],
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ pageParam }) =>
      (await api.get("/api/dashboard/notifications", {
        params: { ...opts, cursor: pageParam, limit: 20 },
      })).data,
  });
}

export function useMarkRead() { /* mutation invalidates unread-count + feed */ }
export function useMarkAllRead() { /* same */ }
```

Repeat for the other three hooks. Tests use `@testing-library/react` + msw to stub the API; assert query keys, cache invalidation on mutate.

- [ ] Commit each hook separately with a green test.

### Task 14.2: Bell dropdown component

**Files:**
- Create: `apps/dashboard/src/components/notifications/bell-dropdown.tsx`
- Create: `apps/dashboard/src/components/notifications/notification-row.tsx`
- Modify: `apps/dashboard/src/components/dashboard/topbar.tsx` (lines 78–82)

Replace the static `<Button>` block with a `<BellDropdown />` that:
- Shows the unread count badge (max 99+).
- On open, renders `useFeed({ unreadOnly: false, limit: 10 })` first page.
- "Mark all as read" button.
- "View all" link to `/account/notifications/inbox`.

Each row renders title + body excerpt + project chip + relative time, and links to `notification.data?.url` when present.

- [ ] Commit:

```bash
git add apps/dashboard/src/components/notifications/ apps/dashboard/src/components/dashboard/topbar.tsx
git commit -m "feat(dashboard): wire topbar bell to live notification feed"
```

### Task 14.3: `/account/notifications/inbox` page

**Files:**
- Create: `apps/dashboard/src/routes/_authed/account/notifications/inbox.tsx`

Full-page feed with filters (unread-only, project, category) + infinite scroll via `useInfiniteQuery`. Empty state. Uses `notification-row.tsx`.

- [ ] Commit:

```bash
git add apps/dashboard/src/routes/_authed/account/notifications/inbox.tsx
git commit -m "feat(dashboard): notifications inbox page"
```

### Task 14.4: Restructure `/account/notifications`

**Files:**
- Modify: `apps/dashboard/src/routes/_authed/account/notifications.tsx`
- Create: `apps/dashboard/src/components/notifications/event-toggle-list.tsx`
- Create: `apps/dashboard/src/components/notifications/device-list.tsx`

Three sections (see spec §7.3): channels + locale/timezone link, devices, per-project event toggles. Forced events render disabled with lock icon.

Drop slack/marketing rows entirely. Keep email + push masters.

- [ ] Commit:

```bash
git add apps/dashboard/src/routes/_authed/account/notifications.tsx apps/dashboard/src/components/notifications/
git commit -m "feat(dashboard): restructure notifications prefs page"
```

### Task 14.5: `/projects/:projectId/settings/notifications`

**Files:**
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/settings/notifications.tsx`

Per-project default editor, OWNER+ADMIN only. Reuses `event-toggle-list.tsx` in "defaults" mode (no `(default)`/`(custom)` badges; all writes go to project defaults).

- [ ] Commit:

```bash
git add apps/dashboard/src/routes/_authed/projects/$projectId/settings/notifications.tsx
git commit -m "feat(dashboard): project notification defaults page"
```

### Task 14.6: `/unsubscribe` public route

**Files:**
- Create: `apps/dashboard/src/routes/unsubscribe.tsx`

SPA route that:
- Reads `?token=` from URL.
- Renders Confirm button + scope description ("Stop receiving emails about ...").
- On confirm, POSTs to `/unsubscribe`. Success state. Expired/invalid → friendly error + sign-in CTA.

- [ ] Commit:

```bash
git add apps/dashboard/src/routes/unsubscribe.tsx
git commit -m "feat(dashboard): unsubscribe confirmation SPA route"
```

### Task 14.7: i18n keys

**Files:**
- Modify: `apps/dashboard/src/i18n/locales/en/account.json`
- Modify: `apps/dashboard/src/i18n/locales/tr/account.json`

Add keys for the new sections, event titles, lock-tooltips, device-list strings.

- [ ] Commit:

```bash
git add apps/dashboard/src/i18n/locales/
git commit -m "feat(dashboard): i18n keys for notifications restructure"
```

---

## Phase 15 — Producer wiring + deploy + observability

### Task 15.1: Wire producers

For each producer in the spec §1 catalog, add a single `emitNotification(tx, { ... })` call inside the existing transaction. Each producer is a separate task; each ends with one focused commit. Examples:

- **`team.member.invited`** — invite-spec already sends an email today; in the same tx, replace the direct `mailer.send` with `emitNotification(tx, { eventKey: 'team.member.invited', eventId: \`invite:\${invitationId}\`, recipients: [/* invitee userId once they have one, else null + email */], context: { ... } })`. Note: the invitee may not yet be a Rovenue user. For pre-account invites, this stays in the invite-spec direct send path; only post-acceptance flows use the notification pipeline.
- **`team.member.role_changed`** — in `routes/v1/team.ts`'s role update handler, inside the tx that updates `project_members.role`, call `emitNotification`.
- **`team.member.removed`** — in the delete handler.
- **`security.signin.new_device`** — in the Better Auth `signIn` hook (or session-create hook), compute a device fingerprint (UA + IP hash), check `user_known_devices` (if it doesn't exist, create it in this task; minimal table `{ userId, fingerprint, lastSeenAt }`), and when fingerprint is new emit the event.
- **`security.oauth.account_linked`** — in the Better Auth `linkAccount` hook.
- **`integration.store_credential.expired`** — in `services/receipt-verify.ts`, when a credential fetch fails with an expired-creds error.
- **`integration.webhook.failing`** — in `workers/outgoing-webhooks.ts`, after the third consecutive 5xx for an endpoint.
- **`billing.refund.detected`** — in `services/webhook-processor.ts` refund branch, gate by amount threshold.
- **`billing.credit.low_balance`** — in `services/subscriptions/grant.ts` (or wherever credit ledger writes happen), check threshold after every debit.
- **`billing.invoice.*`** — defer if Rovenue's own SaaS billing isn't wired yet; emit a TODO row in the implementation plan tracker, not the code.

Detector-emitted events (`revenue.anomaly.*`, `revenue.churn.*`, `revenue.milestone.*`) are out of scope — those detectors don't exist yet per spec §0.

For each wired producer: add a small integration test that asserts the outbox row lands when the domain action runs.

Group commits logically (one per producer file).

### Task 15.2: docker-compose service

**Files:**
- Modify: `deploy/docker-compose.yml`

Add `notifier-worker` and `digest-scheduler` services. They run the same image as `api` but with different entrypoints:

```yaml
notifier-worker:
  image: ${API_IMAGE:-rovenue/api:latest}
  command: ["node", "dist/workers/notifier-entry.js"]
  environment: [ ... same DATABASE_URL/REDIS_URL/KAFKA_BROKERS/SES_/APNS_/FCM_ ... ]
  depends_on: [postgres, redis, redpanda]
  restart: unless-stopped

digest-scheduler:
  image: ${API_IMAGE:-rovenue/api:latest}
  command: ["node", "dist/workers/digest-scheduler-entry.js"]
  environment: [ ... ]
  depends_on: [postgres, redis, clickhouse]
  restart: unless-stopped

send-email-worker:
  image: ${API_IMAGE:-rovenue/api:latest}
  command: ["node", "dist/workers/send-email-worker-entry.js"]
  environment: [ ... ]
  depends_on: [postgres, redis]
  restart: unless-stopped

send-push-worker:
  image: ${API_IMAGE:-rovenue/api:latest}
  command: ["node", "dist/workers/send-push-worker-entry.js"]
  environment: [ ... ]
  depends_on: [postgres, redis]
  restart: unless-stopped
```

If the entry files for send-email and send-push don't exist yet, create thin wrappers that call the start helpers from Phase 10.

- [ ] Commit:

```bash
git add deploy/docker-compose.yml apps/api/src/workers/*-entry.ts
git commit -m "feat(deploy): notifier + digest + send workers in compose"
```

### Task 15.3: Metrics

**Files:**
- Create: `apps/api/src/lib/metrics-notifications.ts`
- Modify: existing prom registry export

Define the counters/histograms listed in spec §8.5 (`notifier_dispatched_total`, etc.) using the existing `prom-client` registry. Wire each into the corresponding worker / processor.

```ts
import { Counter, Histogram, Registry } from "prom-client";

export function registerNotificationMetrics(reg: Registry) {
  const dispatched = new Counter({
    name: "notifier_dispatched_total",
    help: "Notifications dispatched",
    labelNames: ["event_key", "channel", "status"],
    registers: [reg],
  });
  // ... others
  return { dispatched /* ... */ };
}
```

Tests assert that processing a known event increments the counter with the right labels.

- [ ] Commit:

```bash
git add apps/api/src/lib/metrics-notifications.ts apps/api/src/services/notifications/process-notification.ts apps/api/src/workers/send-*.ts
git commit -m "feat(api): notification Prometheus metrics"
```

### Task 15.4: Sentry instrumentation

**Files:**
- Modify: relevant workers

Wrap permanent-failure paths with `Sentry.captureException(err, { tags: { component: 'notifier' }, extra: { eventKey, channel } })`. PII redaction: pass `userId` (UUID) only, never `to` email or push token.

- [ ] Commit:

```bash
git add apps/api/src/services/notifications/process-notification.ts apps/api/src/workers/send-*.ts
git commit -m "feat(api): Sentry instrumentation for notifier failures"
```

### Task 15.5: README + runbook entries

**Files:**
- Modify: `README.md`
- Create: `docs/runbooks/notifications.md`

README gets a one-paragraph note on the new env vars + the four new docker services. Runbook covers the four operational scenarios from spec §8.5 (email circuit, push circuit, DLQ growth, bounce-rate spike) with the exact commands.

- [ ] Commit:

```bash
git add README.md docs/runbooks/notifications.md .env.example
git commit -m "docs: notifications env + runbook"
```

---

## Self-review checklist (run before opening PR)

- [ ] Every spec requirement maps to a task. Verify against `docs/superpowers/specs/2026-05-26-notifications-design.md` section-by-section.
- [ ] All 16 templates have committed snapshot tests.
- [ ] `resolvePrefs` covers all 12 enumerated cases in its unit test.
- [ ] `notifier-worker.integration.test.ts` covers: idempotent re-delivery, forced channel override, channel-off filtering, push-disallowed digest, suppression hit.
- [ ] No `TBD` / `TODO` / "implement later" strings in committed code or plans (`rg -n 'TODO|TBD' apps/api/src/services/notifications apps/api/src/workers/notifier* packages/email-templates packages/shared/src/notifications`).
- [ ] Function and field names match across tasks: `emitNotification`, `resolvePrefs`, `processNotification`, `renderTemplate`, `notificationsRepo`, `notificationDeliveriesRepo`, `pushDevicesRepo`, `notificationPreferencesRepo`, `EVENT_CATALOG`, `getEvent`, `NotificationEventDescriptor`.
- [ ] All four new docker services boot in CI (smoke test).
- [ ] Migration ordering: enums → tables → user_preferences restructure → outbox aggregate addition. The user_preferences data migration depends on `user_project_notification_prefs` existing.

---

## Execution

This plan ships in 15 phases. The recommended subagent-driven execution dispatches one subagent per task, with parent-side review between phases. Phases 1–4 can run sequentially; Phases 5–6 (templates) are parallelizable across event keys; Phases 7–10 mostly sequential; Phase 14 is parallelizable across pages.
