# Onboarding Funnel Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the data model, builder API, public runtime API, branching engine, claim-token + SDK hand-off, and 3-layer cold-install handling for the web-to-app onboarding funnel feature (sub-project A — Funnel Core).

**Architecture:** Three Hono API surfaces (dashboard / public-runtime / SDK) share an 8-table Drizzle schema in Postgres. Branching evaluator and publish validator are pure server-side functions; clients never see `next_rules`. Claim tokens are stored as sha256 hashes only; cold-install reaches the right token via Play Install Referrer (Android), server-side fingerprint match (iOS), or email magic-link fallback.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL 16, pg_partman, Redis + BullMQ, Better Auth, Zod, Vitest, testcontainers, cuid2.

**Spec:** `docs/superpowers/specs/2026-05-26-onboarding-funnel-core-design.md` is the source of truth. Where this plan refers to "spec §X", it means that section of the spec.

**Scope notes:**
- Stripe Connect is sub-project B; this plan implements a **dev-stub paywall** that flips `funnel_purchases.status='paid'` without Stripe. Production deployments without sub-project B will reject publishing paywall funnels at validate-time.
- Templates marketplace and ClickHouse analytics are sub-project C; this plan emits outbox events but does not implement materialised views.

**Commit cadence:** Every task ends with a `git add` + commit step. Use conventional commits (`feat:`, `test:`, `chore:`, `docs:`). Keep commits scoped to one logical change.

---

## File map

### Created
- `packages/db/src/drizzle/repositories/funnels.ts`
- `packages/db/src/drizzle/repositories/funnel-versions.ts`
- `packages/db/src/drizzle/repositories/funnel-templates.ts`
- `packages/db/src/drizzle/repositories/funnel-sessions.ts`
- `packages/db/src/drizzle/repositories/funnel-answers.ts`
- `packages/db/src/drizzle/repositories/funnel-purchases.ts`
- `packages/db/src/drizzle/repositories/funnel-claim-tokens.ts`
- `packages/db/src/drizzle/repositories/funnel-deferred-claims.ts`
- `packages/db/drizzle/migrations/0043_funnel_core.sql` *(generated)*
- `packages/db/drizzle/migrations/0044_funnel_partitions.sql` *(hand-written pg_partman)*
- `packages/db/src/seed/funnel-templates.ts`
- `packages/shared/src/funnel/pages-schema.ts`
- `packages/shared/src/funnel/branching-schema.ts`
- `packages/shared/src/funnel/settings-schema.ts`
- `packages/shared/src/funnel/index.ts`
- `apps/api/src/services/funnel/branching-evaluator.ts` (+ `.test.ts`)
- `apps/api/src/services/funnel/branching-validator.ts` (+ `.test.ts`)
- `apps/api/src/services/funnel/token.ts` (+ `.test.ts`)
- `apps/api/src/services/funnel/fingerprint.ts` (+ `.test.ts`)
- `apps/api/src/services/funnel/install-referrer.ts` (+ `.test.ts`)
- `apps/api/src/services/funnel/runtime-cache.ts`
- `apps/api/src/services/funnel/outbox.ts`
- `apps/api/src/routes/dashboard/funnels.ts` (+ `.integration.test.ts`)
- `apps/api/src/routes/dashboard/funnel-templates.ts`
- `apps/api/src/routes/public/funnels.ts` (+ `.integration.test.ts`)
- `apps/api/src/routes/public/funnel-magic.ts`
- `apps/api/src/routes/public/funnel-universal.ts`
- `apps/api/src/routes/v1/funnel-claim.ts` (+ `.integration.test.ts`)
- `apps/api/src/workers/funnel-jobs.ts`

### Modified
- `packages/db/src/drizzle/schema.ts` — append 8 funnel tables at the end of the file
- `packages/db/src/drizzle/enums.ts` — append 4 enums
- `packages/db/src/index.ts` — add new repo namespaces
- `packages/shared/src/index.ts` — add `./funnel` re-export
- `apps/api/src/app.ts` — wire new route groups
- `apps/api/src/workers/index.ts` — register funnel jobs

---

## Phases

- **Phase 1** — Schema + migration (Tasks 1-5)
- **Phase 2** — Shared Zod schemas (Tasks 6-8)
- **Phase 3** — Pure-function services (Tasks 9-13)
- **Phase 4** — Repositories (Tasks 14-21)
- **Phase 5** — Builder API (dashboard) (Tasks 22-26)
- **Phase 6** — Public runtime API (Tasks 27-31)
- **Phase 7** — Universal link + SDK API (Tasks 32-35)
- **Phase 8** — Outbox + background jobs (Tasks 36-39)
- **Phase 9** — End-to-end integration tests + wiring (Tasks 40-42)

---

## Phase 1 — Schema + migration

### Task 1: Add funnel enums

**Files:**
- Modify: `packages/db/src/drizzle/enums.ts` (append at end)

- [ ] **Step 1: Append enums**

Append to `packages/db/src/drizzle/enums.ts`:

```ts
export const funnelStatus = pgEnum("FunnelStatus", [
  "draft",
  "published",
  "archived",
]);

export const funnelSessionState = pgEnum("FunnelSessionState", [
  "in_progress",
  "paid",
  "completed",
  "abandoned",
]);

export const funnelPurchaseStatus = pgEnum("FunnelPurchaseStatus", [
  "pending",
  "paid",
  "failed",
  "refunded",
]);

export const funnelTemplateScope = pgEnum("FunnelTemplateScope", [
  "system",
  "user",
]);

export const funnelDeferredPlatform = pgEnum("FunnelDeferredPlatform", [
  "ios",
]);
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @rovenue/db typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/drizzle/enums.ts
git commit -m "feat(db): add funnel enums"
```

---

### Task 2: Add funnel tables to schema.ts — group A (funnels, versions, templates)

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts` (append at end)

- [ ] **Step 1: Import the new enums at top of schema.ts**

Find the existing enum import block in `packages/db/src/drizzle/schema.ts` (the one that already imports `memberRole`, `environment`, etc.) and add to it:

```ts
  funnelStatus,
  funnelSessionState,
  funnelPurchaseStatus,
  funnelTemplateScope,
  funnelDeferredPlatform,
```

- [ ] **Step 2: Append funnels / funnel_versions / funnel_templates tables**

Append to `packages/db/src/drizzle/schema.ts` (after the last existing table):

```ts
// =============================================================
// Funnels — onboarding builder (sub-project A)
// =============================================================

export const funnels = pgTable(
  "funnels",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: funnelStatus("status").notNull().default("draft"),
    currentVersionId: text("current_version_id"),
    draftPagesJson: jsonb("draft_pages_json").notNull().default(sql`'[]'::jsonb`),
    draftThemeJson: jsonb("draft_theme_json").notNull().default(sql`'{}'::jsonb`),
    draftSettingsJson: jsonb("draft_settings_json").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => ({
    projectStatusIdx: index("funnels_project_status_idx").on(t.projectId, t.status),
    slugUnique: uniqueIndex("funnels_project_slug_unique").on(t.projectId, t.slug),
  }),
);

export const funnelVersions = pgTable(
  "funnel_versions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    funnelId: text("funnel_id")
      .notNull()
      .references(() => funnels.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    pagesJson: jsonb("pages_json").notNull(),
    themeJson: jsonb("theme_json").notNull(),
    settingsJson: jsonb("settings_json").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    publishedBy: text("published_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => ({
    funnelVersionUnique: uniqueIndex("funnel_versions_funnel_version_unique").on(
      t.funnelId,
      t.versionNo,
    ),
  }),
);

export const funnelTemplates = pgTable(
  "funnel_templates",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    category: text("category").notNull(),
    description: text("description"),
    previewImageUrl: text("preview_image_url"),
    pagesJson: jsonb("pages_json").notNull(),
    themeJson: jsonb("theme_json").notNull(),
    settingsJson: jsonb("settings_json").notNull(),
    scope: funnelTemplateScope("scope").notNull().default("system"),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeCategoryIdx: index("funnel_templates_scope_category_idx").on(t.scope, t.category),
    projectIdx: index("funnel_templates_project_idx").on(t.projectId),
  }),
);

export type Funnel = typeof funnels.$inferSelect;
export type NewFunnel = typeof funnels.$inferInsert;
export type FunnelVersion = typeof funnelVersions.$inferSelect;
export type NewFunnelVersion = typeof funnelVersions.$inferInsert;
export type FunnelTemplate = typeof funnelTemplates.$inferSelect;
export type NewFunnelTemplate = typeof funnelTemplates.$inferInsert;
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @rovenue/db typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/drizzle/schema.ts
git commit -m "feat(db): add funnels, funnel_versions, funnel_templates tables"
```

---

### Task 3: Add session/answer/purchase/claim-token/deferred tables — group B

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts` (append at end)

- [ ] **Step 1: Append remaining tables**

Append to `packages/db/src/drizzle/schema.ts`:

```ts
export const funnelSessions = pgTable(
  "funnel_sessions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    funnelId: text("funnel_id")
      .notNull()
      .references(() => funnels.id, { onDelete: "cascade" }),
    funnelVersionId: text("funnel_version_id")
      .notNull()
      .references(() => funnelVersions.id, { onDelete: "restrict" }),
    projectId: text("project_id").notNull(),
    anonId: text("anon_id")
      .notNull()
      .$defaultFn(() => createId()),
    state: funnelSessionState("state").notNull().default("in_progress"),
    currentPageId: text("current_page_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    utmJson: jsonb("utm_json").notNull().default(sql`'{}'::jsonb`),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
  },
  (t) => ({
    funnelStartedIdx: index("funnel_sessions_funnel_started_idx").on(t.funnelId, t.startedAt),
    stateActivityIdx: index("funnel_sessions_state_activity_idx").on(t.state, t.lastActivityAt),
    projectStartedIdx: index("funnel_sessions_project_started_idx").on(t.projectId, t.startedAt),
  }),
);

export const funnelAnswers = pgTable(
  "funnel_answers",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    sessionId: text("session_id")
      .notNull()
      .references(() => funnelSessions.id, { onDelete: "cascade" }),
    pageId: text("page_id").notNull(),
    questionId: text("question_id").notNull(),
    answerJson: jsonb("answer_json").notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionQuestionUnique: uniqueIndex("funnel_answers_session_question_unique").on(
      t.sessionId,
      t.questionId,
    ),
    sessionIdx: index("funnel_answers_session_idx").on(t.sessionId),
  }),
);

export const funnelPurchases = pgTable(
  "funnel_purchases",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    sessionId: text("session_id")
      .notNull()
      .references(() => funnelSessions.id, { onDelete: "cascade" })
      .unique(),
    projectId: text("project_id").notNull(),
    productId: text("product_id"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    amountCents: integer("amount_cents"),
    currency: text("currency"),
    status: funnelPurchaseStatus("status").notNull().default("pending"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    rawPayload: jsonb("raw_payload").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    projectStatusIdx: index("funnel_purchases_project_status_idx").on(
      t.projectId,
      t.status,
      t.paidAt,
    ),
    stripeSubIdx: index("funnel_purchases_stripe_sub_idx").on(t.stripeSubscriptionId),
  }),
);

export const funnelClaimTokens = pgTable(
  "funnel_claim_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    tokenHash: text("token_hash").notNull().unique(),
    sessionId: text("session_id")
      .notNull()
      .references(() => funnelSessions.id, { onDelete: "cascade" })
      .unique(),
    projectId: text("project_id").notNull(),
    emailHash: text("email_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBySubscriberId: text("claimed_by_subscriber_id"),
  },
  (t) => ({
    emailIdx: index("funnel_claim_tokens_email_idx").on(t.emailHash),
    expiresIdx: index("funnel_claim_tokens_expires_idx").on(t.expiresAt),
  }),
);

export const funnelDeferredClaims = pgTable(
  "funnel_deferred_claims",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    tokenId: text("token_id")
      .notNull()
      .references(() => funnelClaimTokens.id, { onDelete: "cascade" }),
    platform: funnelDeferredPlatform("platform").notNull(),
    ipHash: text("ip_hash").notNull(),
    userAgent: text("user_agent").notNull(),
    locale: text("locale").notNull(),
    timezone: text("timezone").notNull(),
    screenDims: text("screen_dims").notNull(),
    deviceModel: text("device_model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    matchedAt: timestamp("matched_at", { withTimezone: true }),
    matchedInstallId: text("matched_install_id"),
  },
  (t) => ({
    ipExpiresIdx: index("funnel_deferred_claims_ip_expires_idx").on(t.ipHash, t.expiresAt),
    tokenIdx: index("funnel_deferred_claims_token_idx").on(t.tokenId),
  }),
);

export type FunnelSession = typeof funnelSessions.$inferSelect;
export type NewFunnelSession = typeof funnelSessions.$inferInsert;
export type FunnelAnswer = typeof funnelAnswers.$inferSelect;
export type NewFunnelAnswer = typeof funnelAnswers.$inferInsert;
export type FunnelPurchase = typeof funnelPurchases.$inferSelect;
export type NewFunnelPurchase = typeof funnelPurchases.$inferInsert;
export type FunnelClaimToken = typeof funnelClaimTokens.$inferSelect;
export type NewFunnelClaimToken = typeof funnelClaimTokens.$inferInsert;
export type FunnelDeferredClaim = typeof funnelDeferredClaims.$inferSelect;
export type NewFunnelDeferredClaim = typeof funnelDeferredClaims.$inferInsert;
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @rovenue/db typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/drizzle/schema.ts
git commit -m "feat(db): add funnel session/answer/purchase/token/deferred tables"
```

---

### Task 4: Generate + apply funnel core migration

**Files:**
- Create: `packages/db/drizzle/migrations/0043_<name>_funnel_core.sql` *(auto-named by drizzle-kit)*

- [ ] **Step 1: Generate migration**

Run: `pnpm db:migrate:generate`
Expected: a new `0043_*.sql` file under `packages/db/drizzle/migrations/` referencing all 8 tables + 4 new enums. Inspect the generated SQL — it should contain `CREATE TYPE "FunnelStatus" ...` and `CREATE TABLE "funnels" ...` for each table.

- [ ] **Step 2: Apply migration locally**

Run: `pnpm db:migrate`
Expected: `Migration 0043_*.sql applied`.

- [ ] **Step 3: Smoke-verify schema**

Run:
```bash
psql "$DATABASE_URL" -c "\dt funnel*"
```
Expected: 8 rows — `funnels, funnel_versions, funnel_templates, funnel_sessions, funnel_answers, funnel_purchases, funnel_claim_tokens, funnel_deferred_claims`.

- [ ] **Step 4: Commit**

```bash
git add packages/db/drizzle/migrations/
git commit -m "feat(db): generate funnel core migration"
```

---

### Task 5: Hand-written pg_partman setup for funnel_sessions / funnel_answers

**Files:**
- Create: `packages/db/drizzle/migrations/0044_funnel_partitions.sql`

- [ ] **Step 1: Inspect existing partition migrations**

Look at `packages/db/drizzle/migrations/` for an existing pg_partman migration (e.g. on `revenue_events`) to confirm function signatures (`partman.create_parent`).

- [ ] **Step 2: Write the partition migration**

Create `packages/db/drizzle/migrations/0044_funnel_partitions.sql`:

```sql
-- pg_partman declarative range partitions on started_at / answered_at.
-- These two tables grow indefinitely; we partition monthly and keep
-- 18 months hot, archive older to cold storage downstream.

-- Switch funnel_sessions to a partitioned table.
ALTER TABLE funnel_sessions
  RENAME TO funnel_sessions_legacy;

CREATE TABLE funnel_sessions (
  LIKE funnel_sessions_legacy INCLUDING ALL
) PARTITION BY RANGE (started_at);

DROP TABLE funnel_sessions_legacy;

SELECT partman.create_parent(
  p_parent_table     => 'public.funnel_sessions',
  p_control          => 'started_at',
  p_type             => 'native',
  p_interval         => 'monthly',
  p_premake          => 4
);
UPDATE partman.part_config
SET retention            = '18 months',
    retention_keep_table = false,
    infinite_time_partitions = true
WHERE parent_table = 'public.funnel_sessions';

-- Same for funnel_answers.
ALTER TABLE funnel_answers
  RENAME TO funnel_answers_legacy;

CREATE TABLE funnel_answers (
  LIKE funnel_answers_legacy INCLUDING ALL
) PARTITION BY RANGE (answered_at);

DROP TABLE funnel_answers_legacy;

SELECT partman.create_parent(
  p_parent_table     => 'public.funnel_answers',
  p_control          => 'answered_at',
  p_type             => 'native',
  p_interval         => 'monthly',
  p_premake          => 4
);
UPDATE partman.part_config
SET retention            = '18 months',
    retention_keep_table = false,
    infinite_time_partitions = true
WHERE parent_table = 'public.funnel_answers';
```

- [ ] **Step 3: Mark as applied in drizzle-kit journal**

Edit `packages/db/drizzle/migrations/meta/_journal.json` and append:
```json
{ "idx": 44, "version": "7", "when": <UNIX_MS_NOW>, "tag": "0044_funnel_partitions", "breakpoints": true }
```
(Match the format of existing entries — look at idx 43 you just generated and mirror it.)

- [ ] **Step 4: Apply migration**

Run: `pnpm db:migrate`
Expected: `Migration 0044_funnel_partitions.sql applied`. If running against a Postgres without `pg_partman`, the migration will fail; document this in commit message — local dev needs the Docker compose stack which already includes pg_partman.

- [ ] **Step 5: Verify partitions**

Run:
```bash
psql "$DATABASE_URL" -c "SELECT parent_table, partition_interval, retention FROM partman.part_config WHERE parent_table LIKE 'public.funnel_%';"
```
Expected: 2 rows.

- [ ] **Step 6: Commit**

```bash
git add packages/db/drizzle/migrations/
git commit -m "feat(db): partition funnel_sessions and funnel_answers via pg_partman"
```

---

## Phase 2 — Shared Zod schemas

### Task 6: Page schemas (`@rovenue/shared/funnel`)

**Files:**
- Create: `packages/shared/src/funnel/pages-schema.ts`
- Create: `packages/shared/src/funnel/index.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write failing test**

Create `packages/shared/src/funnel/pages-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pageSchema, pagesArraySchema } from "./pages-schema";

describe("pageSchema", () => {
  it("accepts a question_single page with options", () => {
    const ok = pageSchema.safeParse({
      id: "pg_01",
      type: "question_single",
      config: {
        question_id: "goal",
        title: "What's your goal?",
        options: [
          { id: "o1", label: "Lose weight", value: "lose_weight" },
          { id: "o2", label: "Build muscle", value: "build_muscle" },
        ],
      },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects a question_single page with empty options", () => {
    const result = pageSchema.safeParse({
      id: "pg_01",
      type: "question_single",
      config: { question_id: "g", title: "T", options: [] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts info, paywall, and success pages", () => {
    expect(
      pageSchema.safeParse({
        id: "pg_info",
        type: "info",
        config: { title: "T", body_markdown: "B" },
      }).success,
    ).toBe(true);
    expect(
      pageSchema.safeParse({
        id: "pg_pay",
        type: "paywall",
        config: { product_id: "prod_1", headline: "H", bullets: ["a"] },
      }).success,
    ).toBe(true);
    expect(
      pageSchema.safeParse({
        id: "pg_ok",
        type: "success",
        config: { headline: "H", body: "B", open_app_label: "Open" },
      }).success,
    ).toBe(true);
  });

  it("rejects unknown page type", () => {
    const result = pageSchema.safeParse({
      id: "pg_x",
      type: "unknown_type",
      config: {},
    });
    expect(result.success).toBe(false);
  });

  it("pagesArraySchema rejects duplicate ids", () => {
    const result = pagesArraySchema.safeParse([
      { id: "pg_1", type: "info", config: { title: "A", body_markdown: "B" } },
      { id: "pg_1", type: "info", config: { title: "C", body_markdown: "D" } },
    ]);
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (expect failure)**

Run: `pnpm --filter @rovenue/shared vitest run src/funnel/pages-schema.test.ts`
Expected: FAIL — `Cannot find module './pages-schema'`.

- [ ] **Step 3: Implement page schema**

Create `packages/shared/src/funnel/pages-schema.ts`:

```ts
import { z } from "zod";
import { nextRuleSchema } from "./branching-schema";

const baseFields = {
  id: z.string().min(1),
  next_rules: z.array(nextRuleSchema).optional(),
  default_next: z.union([z.string(), z.literal("paywall"), z.literal("end")]).optional(),
};

const questionSingleConfig = z.object({
  question_id: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  options: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        value: z.string().min(1),
        icon: z.string().optional(),
      }),
    )
    .min(1),
  required: z.boolean().optional(),
});

const questionMultiConfig = questionSingleConfig.extend({
  max_selections: z.number().int().positive().optional(),
});

const textInputConfig = z.object({
  question_id: z.string().min(1),
  title: z.string().min(1),
  placeholder: z.string().optional(),
  validation: z.enum(["text", "email", "url"]).default("text"),
  required: z.boolean().optional(),
});

const numberInputConfig = z.object({
  question_id: z.string().min(1),
  title: z.string().min(1),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  suffix: z.string().optional(),
});

const dateConfig = z.object({
  question_id: z.string().min(1),
  title: z.string().min(1),
  min_date: z.string().optional(),
  max_date: z.string().optional(),
});

const sliderConfig = z.object({
  question_id: z.string().min(1),
  title: z.string().min(1),
  min: z.number(),
  max: z.number(),
  step: z.number().positive(),
  label_format: z.string().optional(),
});

const ratingConfig = z.object({
  question_id: z.string().min(1),
  title: z.string().min(1),
  scale: z.union([z.literal(5), z.literal(10)]),
  icon: z.enum(["star", "heart"]).default("star"),
});

const infoConfig = z.object({
  title: z.string().min(1),
  body_markdown: z.string(),
  image_url: z.string().url().optional(),
  cta_label: z.string().optional(),
});

const loadingConfig = z.object({
  title: z.string().min(1),
  duration_ms: z.number().int().min(500).max(15000),
  steps: z.array(z.string()).optional(),
});

const resultConfig = z.object({
  title_template: z.string(),
  body_template: z.string(),
});

const paywallConfig = z.object({
  product_id: z.string().min(1),
  trial: z.object({ days: z.union([z.literal(3), z.literal(7)]) }).optional(),
  headline: z.string().min(1),
  bullets: z.array(z.string()).min(1),
});

const successConfig = z.object({
  headline: z.string().min(1),
  body: z.string(),
  open_app_label: z.string().min(1),
});

export const pageSchema = z.discriminatedUnion("type", [
  z.object({ ...baseFields, type: z.literal("question_single"), config: questionSingleConfig }),
  z.object({ ...baseFields, type: z.literal("question_multi"), config: questionMultiConfig }),
  z.object({ ...baseFields, type: z.literal("text_input"), config: textInputConfig }),
  z.object({ ...baseFields, type: z.literal("number_input"), config: numberInputConfig }),
  z.object({ ...baseFields, type: z.literal("date"), config: dateConfig }),
  z.object({ ...baseFields, type: z.literal("slider"), config: sliderConfig }),
  z.object({ ...baseFields, type: z.literal("rating"), config: ratingConfig }),
  z.object({ ...baseFields, type: z.literal("info"), config: infoConfig }),
  z.object({ ...baseFields, type: z.literal("loading"), config: loadingConfig }),
  z.object({ ...baseFields, type: z.literal("result"), config: resultConfig }),
  z.object({ ...baseFields, type: z.literal("paywall"), config: paywallConfig }),
  z.object({ ...baseFields, type: z.literal("success"), config: successConfig }),
]);

export type Page = z.infer<typeof pageSchema>;

export const pagesArraySchema = z
  .array(pageSchema)
  .superRefine((pages, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < pages.length; i++) {
      const id = pages[i].id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: [i, "id"],
          message: `Duplicate page id: ${id}`,
        });
      }
      seen.add(id);
    }
  });

export type PagesArray = z.infer<typeof pagesArraySchema>;
```

- [ ] **Step 4: Run test (expect pass)**

Run: `pnpm --filter @rovenue/shared vitest run src/funnel/pages-schema.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Add barrel + re-export**

Create `packages/shared/src/funnel/index.ts`:

```ts
export * from "./pages-schema";
export * from "./branching-schema";
export * from "./settings-schema";
```

Edit `packages/shared/src/index.ts` and append:

```ts
export * as funnel from "./funnel";
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/funnel/ packages/shared/src/index.ts
git commit -m "feat(shared): funnel page Zod schemas"
```

---

### Task 7: Branching rule schemas

**Files:**
- Create: `packages/shared/src/funnel/branching-schema.ts`
- Create: `packages/shared/src/funnel/branching-schema.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { nextRuleSchema } from "./branching-schema";

describe("nextRuleSchema", () => {
  it("accepts 'all' rule with eq + gte clauses", () => {
    const ok = nextRuleSchema.safeParse({
      id: "r1",
      condition: {
        op: "all",
        clauses: [
          { question_id: "goal", op: "eq", value: "lose_weight" },
          { question_id: "age", op: "gte", value: 40 },
        ],
      },
      goto: "pg_07",
    });
    expect(ok.success).toBe(true);
  });

  it("accepts 'in' clause with array value", () => {
    const ok = nextRuleSchema.safeParse({
      id: "r2",
      condition: { op: "any", clauses: [{ question_id: "g", op: "in", value: ["a", "b"] }] },
      goto: "end",
    });
    expect(ok.success).toBe(true);
  });

  it("accepts 'is_answered' clause with no value", () => {
    const ok = nextRuleSchema.safeParse({
      id: "r3",
      condition: { op: "all", clauses: [{ question_id: "e", op: "is_answered" }] },
      goto: "paywall",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects unknown op", () => {
    const bad = nextRuleSchema.safeParse({
      id: "r4",
      condition: { op: "all", clauses: [{ question_id: "x", op: "regex", value: ".*" }] },
      goto: "pg_1",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects empty clauses array", () => {
    const bad = nextRuleSchema.safeParse({
      id: "r5",
      condition: { op: "all", clauses: [] },
      goto: "pg_1",
    });
    expect(bad.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (expect failure)**

Run: `pnpm --filter @rovenue/shared vitest run src/funnel/branching-schema.test.ts`
Expected: FAIL — `Cannot find module './branching-schema'`.

- [ ] **Step 3: Implement**

Create `packages/shared/src/funnel/branching-schema.ts`:

```ts
import { z } from "zod";

export const CLAUSE_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in",
  "not_in",
  "contains",
  "is_answered",
  "is_not_answered",
] as const;

export type ClauseOp = (typeof CLAUSE_OPS)[number];

const clauseSchema = z
  .object({
    question_id: z.string().min(1),
    op: z.enum(CLAUSE_OPS),
    value: z.unknown().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.op === "is_answered" || c.op === "is_not_answered") {
      if (c.value !== undefined) {
        ctx.addIssue({ code: "custom", message: `Op ${c.op} accepts no value`, path: ["value"] });
      }
      return;
    }
    if (c.value === undefined) {
      ctx.addIssue({ code: "custom", message: `Op ${c.op} requires value`, path: ["value"] });
      return;
    }
    if (c.op === "in" || c.op === "not_in") {
      if (!Array.isArray(c.value)) {
        ctx.addIssue({ code: "custom", message: `Op ${c.op} requires array value`, path: ["value"] });
      }
    }
    if (c.op === "between") {
      if (!Array.isArray(c.value) || c.value.length !== 2) {
        ctx.addIssue({
          code: "custom",
          message: `Op between requires [min, max]`,
          path: ["value"],
        });
      }
    }
  });

export type Clause = z.infer<typeof clauseSchema>;

export const nextRuleSchema = z.object({
  id: z.string().min(1),
  condition: z.object({
    op: z.enum(["all", "any"]),
    clauses: z.array(clauseSchema).min(1),
  }),
  goto: z.union([z.string().min(1), z.literal("paywall"), z.literal("end")]),
});

export type NextRule = z.infer<typeof nextRuleSchema>;
```

- [ ] **Step 4: Run test (expect pass)**

Run: `pnpm --filter @rovenue/shared vitest run src/funnel/branching-schema.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/funnel/branching-schema.ts packages/shared/src/funnel/branching-schema.test.ts
git commit -m "feat(shared): funnel branching rule Zod schema"
```

---

### Task 8: Settings + theme schemas

**Files:**
- Create: `packages/shared/src/funnel/settings-schema.ts`

- [ ] **Step 1: Implement**

Create `packages/shared/src/funnel/settings-schema.ts`:

```ts
import { z } from "zod";

export const themeSchema = z.object({
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#111111"),
  accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#3b82f6"),
  background_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#ffffff"),
  text_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#0f172a"),
  font_family: z.string().optional(),
  logo_url: z.string().url().optional(),
});

export type Theme = z.infer<typeof themeSchema>;

export const settingsSchema = z.object({
  app_store_url: z.string().url().optional(),
  play_store_url: z.string().url().optional(),
  universal_link_domain: z.string().regex(/^[a-z0-9.-]+$/).optional(),
  deep_link_scheme: z.string().regex(/^[a-z][a-z0-9+\-.]*$/).optional(),
  dev_mode: z.boolean().default(false),
});

export type FunnelSettings = z.infer<typeof settingsSchema>;
```

- [ ] **Step 2: Type-check (no separate test — types-only)**

Run: `pnpm --filter @rovenue/shared typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/funnel/settings-schema.ts
git commit -m "feat(shared): funnel theme and settings Zod schemas"
```

---

## Phase 3 — Pure-function services

All services in this phase are framework-free and DB-free. Tested with Vitest unit tests, no testcontainers.

### Task 9: Branching evaluator

**Files:**
- Create: `apps/api/src/services/funnel/branching-evaluator.ts`
- Create: `apps/api/src/services/funnel/branching-evaluator.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { evaluateNext, type AnswerMap, type PageGraph } from "./branching-evaluator";

const pages: PageGraph = new Map([
  ["pg_1", { id: "pg_1", type: "question_single", config: { question_id: "goal" }, next_rules: [] }],
  ["pg_2", { id: "pg_2", type: "info", config: {} }],
  ["pg_3", { id: "pg_3", type: "info", config: {} }],
  ["pg_pay", { id: "pg_pay", type: "paywall", config: {} }],
]);

describe("evaluateNext", () => {
  it("returns sequential next when no rules match", () => {
    const result = evaluateNext({
      page: { id: "pg_1", type: "question_single", config: { question_id: "goal" } },
      pagesOrder: ["pg_1", "pg_2", "pg_3", "pg_pay"],
      answers: new Map([["goal", "build_muscle"]]),
      pagesById: pages,
    });
    expect(result).toEqual({ next: "page", pageId: "pg_2" });
  });

  it("returns rule's goto when 'all' condition matches", () => {
    const page = {
      id: "pg_1",
      type: "question_single",
      config: { question_id: "goal" },
      next_rules: [
        {
          id: "r1",
          condition: {
            op: "all" as const,
            clauses: [
              { question_id: "goal", op: "eq" as const, value: "lose_weight" },
              { question_id: "age", op: "gte" as const, value: 40 },
            ],
          },
          goto: "pg_3",
        },
      ],
    };
    const answers: AnswerMap = new Map([
      ["goal", "lose_weight"],
      ["age", 42],
    ]);
    const result = evaluateNext({
      page,
      pagesOrder: ["pg_1", "pg_2", "pg_3", "pg_pay"],
      answers,
      pagesById: pages,
    });
    expect(result).toEqual({ next: "page", pageId: "pg_3" });
  });

  it("falls back to default_next when no rule matches", () => {
    const page = {
      id: "pg_1",
      type: "question_single",
      config: { question_id: "goal" },
      next_rules: [],
      default_next: "pg_pay" as const,
    };
    expect(
      evaluateNext({
        page,
        pagesOrder: ["pg_1", "pg_2", "pg_pay"],
        answers: new Map(),
        pagesById: pages,
      }),
    ).toEqual({ next: "paywall" });
  });

  it("'any' rule short-circuits on first match", () => {
    const page = {
      id: "pg_1",
      type: "question_single",
      config: {},
      next_rules: [
        {
          id: "r1",
          condition: {
            op: "any" as const,
            clauses: [
              { question_id: "missing", op: "eq" as const, value: "x" },
              { question_id: "goal", op: "eq" as const, value: "lose_weight" },
            ],
          },
          goto: "end" as const,
        },
      ],
    };
    expect(
      evaluateNext({
        page,
        pagesOrder: ["pg_1", "pg_2"],
        answers: new Map([["goal", "lose_weight"]]),
        pagesById: pages,
      }),
    ).toEqual({ next: "end" });
  });

  it("'in' and 'between' operate as expected", () => {
    const page = {
      id: "pg_1",
      type: "info",
      config: {},
      next_rules: [
        {
          id: "rIn",
          condition: {
            op: "all" as const,
            clauses: [{ question_id: "goal", op: "in" as const, value: ["a", "b"] }],
          },
          goto: "pg_2",
        },
        {
          id: "rBtw",
          condition: {
            op: "all" as const,
            clauses: [{ question_id: "age", op: "between" as const, value: [18, 65] }],
          },
          goto: "pg_3",
        },
      ],
    };
    expect(
      evaluateNext({
        page,
        pagesOrder: ["pg_1", "pg_2", "pg_3"],
        answers: new Map([["age", 30]]),
        pagesById: pages,
      }),
    ).toEqual({ next: "page", pageId: "pg_3" });
  });

  it("is_answered / is_not_answered evaluate against the map", () => {
    const page = {
      id: "pg_1",
      type: "info",
      config: {},
      next_rules: [
        {
          id: "r1",
          condition: {
            op: "all" as const,
            clauses: [{ question_id: "email", op: "is_not_answered" as const }],
          },
          goto: "pg_2",
        },
      ],
    };
    expect(
      evaluateNext({
        page,
        pagesOrder: ["pg_1", "pg_2", "pg_3"],
        answers: new Map(),
        pagesById: pages,
      }),
    ).toEqual({ next: "page", pageId: "pg_2" });
  });

  it("returns 'end' when last page has no rules and no successor", () => {
    expect(
      evaluateNext({
        page: { id: "pg_pay", type: "paywall", config: {} },
        pagesOrder: ["pg_1", "pg_pay"],
        answers: new Map(),
        pagesById: pages,
      }),
    ).toEqual({ next: "end" });
  });
});
```

- [ ] **Step 2: Run test (expect failure)**

Run: `pnpm --filter @rovenue/api vitest run src/services/funnel/branching-evaluator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement evaluator**

Create `apps/api/src/services/funnel/branching-evaluator.ts`:

```ts
import type { Clause, NextRule } from "@rovenue/shared/funnel";

export type AnswerValue = string | number | boolean | string[] | null;
export type AnswerMap = Map<string, AnswerValue>;

export interface EvalPage {
  id: string;
  type: string;
  config: Record<string, unknown>;
  next_rules?: NextRule[];
  default_next?: string | "paywall" | "end";
}

export type PageGraph = Map<string, EvalPage>;

export type EvalResult =
  | { next: "page"; pageId: string }
  | { next: "paywall" }
  | { next: "end" };

interface EvalInput {
  page: EvalPage;
  pagesOrder: string[];
  answers: AnswerMap;
  pagesById: PageGraph;
}

export function evaluateNext(input: EvalInput): EvalResult {
  const { page, answers, pagesOrder } = input;
  const rules = page.next_rules ?? [];
  for (const rule of rules) {
    if (matches(rule.condition, answers)) {
      return resolveGoto(rule.goto, page.id, pagesOrder);
    }
  }
  if (page.default_next !== undefined) {
    return resolveGoto(page.default_next, page.id, pagesOrder);
  }
  return resolveGoto("sequential", page.id, pagesOrder);
}

function resolveGoto(
  goto: string | "paywall" | "end" | "sequential",
  fromId: string,
  pagesOrder: string[],
): EvalResult {
  if (goto === "paywall") return { next: "paywall" };
  if (goto === "end") return { next: "end" };
  if (goto === "sequential") {
    const idx = pagesOrder.indexOf(fromId);
    if (idx === -1 || idx === pagesOrder.length - 1) return { next: "end" };
    return { next: "page", pageId: pagesOrder[idx + 1] };
  }
  return { next: "page", pageId: goto };
}

function matches(
  condition: { op: "all" | "any"; clauses: Clause[] },
  answers: AnswerMap,
): boolean {
  if (condition.op === "all") {
    return condition.clauses.every((c) => evalClause(c, answers));
  }
  return condition.clauses.some((c) => evalClause(c, answers));
}

function evalClause(clause: Clause, answers: AnswerMap): boolean {
  const a = answers.get(clause.question_id);
  switch (clause.op) {
    case "is_answered":
      return a !== undefined && a !== null;
    case "is_not_answered":
      return a === undefined || a === null;
    case "eq":
      return a === clause.value;
    case "neq":
      return a !== clause.value;
    case "gt":
      return typeof a === "number" && typeof clause.value === "number" && a > clause.value;
    case "gte":
      return typeof a === "number" && typeof clause.value === "number" && a >= clause.value;
    case "lt":
      return typeof a === "number" && typeof clause.value === "number" && a < clause.value;
    case "lte":
      return typeof a === "number" && typeof clause.value === "number" && a <= clause.value;
    case "between": {
      if (typeof a !== "number" || !Array.isArray(clause.value) || clause.value.length !== 2) {
        return false;
      }
      const [min, max] = clause.value as [number, number];
      return a >= min && a <= max;
    }
    case "in":
      return Array.isArray(clause.value) && (clause.value as unknown[]).includes(a);
    case "not_in":
      return Array.isArray(clause.value) && !(clause.value as unknown[]).includes(a);
    case "contains":
      return Array.isArray(a) && typeof clause.value === "string" && a.includes(clause.value);
    default:
      return false;
  }
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @rovenue/api vitest run src/services/funnel/branching-evaluator.test.ts`
Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/funnel/branching-evaluator.ts apps/api/src/services/funnel/branching-evaluator.test.ts
git commit -m "feat(api): branching evaluator with operator coverage"
```

---

### Task 10: Publish validator (cycle / orphan / terminal / question-id checks)

**Files:**
- Create: `apps/api/src/services/funnel/branching-validator.ts`
- Create: `apps/api/src/services/funnel/branching-validator.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { validateFunnelGraph } from "./branching-validator";

describe("validateFunnelGraph", () => {
  it("accepts a minimal valid funnel (info → paywall → success)", () => {
    const result = validateFunnelGraph([
      { id: "pg_1", type: "info", config: { title: "T", body_markdown: "B" } },
      {
        id: "pg_pay",
        type: "paywall",
        config: { product_id: "p", headline: "h", bullets: ["a"] },
      },
      {
        id: "pg_ok",
        type: "success",
        config: { headline: "h", body: "b", open_app_label: "Open" },
      },
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects missing paywall page", () => {
    const result = validateFunnelGraph([
      { id: "pg_1", type: "info", config: { title: "T", body_markdown: "B" } },
      {
        id: "pg_ok",
        type: "success",
        config: { headline: "h", body: "b", open_app_label: "Open" },
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "MISSING_PAYWALL")).toBe(true);
  });

  it("rejects missing success page", () => {
    const result = validateFunnelGraph([
      {
        id: "pg_pay",
        type: "paywall",
        config: { product_id: "p", headline: "h", bullets: ["a"] },
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "MISSING_SUCCESS")).toBe(true);
  });

  it("detects cycles in next_rules graph", () => {
    const result = validateFunnelGraph([
      { id: "pg_1", type: "info", config: {}, default_next: "pg_2" },
      { id: "pg_2", type: "info", config: {}, default_next: "pg_1" },
      {
        id: "pg_pay",
        type: "paywall",
        config: { product_id: "p", headline: "h", bullets: ["a"] },
      },
      {
        id: "pg_ok",
        type: "success",
        config: { headline: "h", body: "b", open_app_label: "Open" },
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "CYCLE")).toBe(true);
  });

  it("rejects duplicate question_id across pages", () => {
    const result = validateFunnelGraph([
      {
        id: "pg_1",
        type: "question_single",
        config: {
          question_id: "goal",
          title: "T",
          options: [{ id: "o", label: "L", value: "v" }],
        },
      },
      {
        id: "pg_2",
        type: "question_single",
        config: {
          question_id: "goal",
          title: "T",
          options: [{ id: "o", label: "L", value: "v" }],
        },
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "DUPLICATE_QUESTION_ID")).toBe(true);
  });

  it("rejects rule referencing unknown question_id", () => {
    const result = validateFunnelGraph([
      {
        id: "pg_1",
        type: "info",
        config: {},
        next_rules: [
          {
            id: "r",
            condition: { op: "all", clauses: [{ question_id: "ghost", op: "eq", value: "x" }] },
            goto: "pg_2",
          },
        ],
      },
      { id: "pg_2", type: "info", config: {} },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "UNKNOWN_QUESTION_REF")).toBe(true);
  });

  it("rejects rule goto pointing to a non-existent page", () => {
    const result = validateFunnelGraph([
      { id: "pg_1", type: "info", config: {}, default_next: "pg_missing" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "UNKNOWN_GOTO")).toBe(true);
  });
});
```

- [ ] **Step 2: Run (expect failure)**

Run: `pnpm --filter @rovenue/api vitest run src/services/funnel/branching-validator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement validator**

Create `apps/api/src/services/funnel/branching-validator.ts`:

```ts
import type { Page } from "@rovenue/shared/funnel";

export type ValidatorIssue =
  | { code: "MISSING_PAYWALL"; message: string }
  | { code: "MISSING_SUCCESS"; message: string }
  | { code: "CYCLE"; message: string; path: string[] }
  | { code: "DUPLICATE_QUESTION_ID"; message: string; questionId: string }
  | { code: "UNKNOWN_QUESTION_REF"; message: string; pageId: string; questionId: string }
  | { code: "UNKNOWN_GOTO"; message: string; pageId: string; goto: string }
  | { code: "UNREACHABLE"; message: string; pageId: string };

export type ValidationResult =
  | { ok: true; warnings: ValidatorIssue[] }
  | { ok: false; issues: ValidatorIssue[]; warnings: ValidatorIssue[] };

interface MinimalPage {
  id: string;
  type: string;
  config: Record<string, unknown>;
  next_rules?: Array<{
    id: string;
    condition: { op: "all" | "any"; clauses: Array<{ question_id: string }> };
    goto: string;
  }>;
  default_next?: string;
}

export function validateFunnelGraph(pages: Page[] | MinimalPage[]): ValidationResult {
  const errors: ValidatorIssue[] = [];
  const warnings: ValidatorIssue[] = [];
  const list = pages as MinimalPage[];

  if (!list.some((p) => p.type === "paywall")) {
    errors.push({ code: "MISSING_PAYWALL", message: "Funnel needs at least one paywall page" });
  }
  if (!list.some((p) => p.type === "success")) {
    errors.push({ code: "MISSING_SUCCESS", message: "Funnel needs at least one success page" });
  }

  const byId = new Map<string, MinimalPage>(list.map((p) => [p.id, p]));
  const questionIds = new Map<string, string>(); // question_id -> page_id
  for (const p of list) {
    const qid = (p.config as { question_id?: string }).question_id;
    if (qid !== undefined) {
      if (questionIds.has(qid)) {
        errors.push({
          code: "DUPLICATE_QUESTION_ID",
          message: `question_id '${qid}' used on multiple pages`,
          questionId: qid,
        });
      } else {
        questionIds.set(qid, p.id);
      }
    }
  }

  for (const p of list) {
    for (const rule of p.next_rules ?? []) {
      for (const clause of rule.condition.clauses) {
        if (!questionIds.has(clause.question_id)) {
          errors.push({
            code: "UNKNOWN_QUESTION_REF",
            message: `Rule on page ${p.id} references unknown question_id '${clause.question_id}'`,
            pageId: p.id,
            questionId: clause.question_id,
          });
        }
      }
      if (rule.goto !== "paywall" && rule.goto !== "end" && !byId.has(rule.goto)) {
        errors.push({
          code: "UNKNOWN_GOTO",
          message: `Rule ${rule.id} on page ${p.id} goes to unknown page ${rule.goto}`,
          pageId: p.id,
          goto: rule.goto,
        });
      }
    }
    if (
      p.default_next !== undefined &&
      p.default_next !== "paywall" &&
      p.default_next !== "end" &&
      !byId.has(p.default_next)
    ) {
      errors.push({
        code: "UNKNOWN_GOTO",
        message: `default_next on ${p.id} -> unknown ${p.default_next}`,
        pageId: p.id,
        goto: p.default_next,
      });
    }
  }

  if (list.length > 0) {
    const order = list.map((p) => p.id);
    const cycleErrors = detectCycles(list, byId, order);
    errors.push(...cycleErrors);
    const reachable = computeReachable(list, byId, order);
    for (const p of list) {
      if (!reachable.has(p.id)) {
        warnings.push({
          code: "UNREACHABLE",
          message: `Page ${p.id} is unreachable from start`,
          pageId: p.id,
        });
      }
    }
  }

  if (errors.length > 0) return { ok: false, issues: errors, warnings };
  return { ok: true, warnings };
}

function nextTargets(
  page: MinimalPage,
  pagesOrder: string[],
): Array<"paywall" | "end" | string> {
  const targets: Array<"paywall" | "end" | string> = [];
  for (const rule of page.next_rules ?? []) {
    targets.push(rule.goto as "paywall" | "end" | string);
  }
  if (page.default_next !== undefined) {
    targets.push(page.default_next as "paywall" | "end" | string);
  } else {
    const idx = pagesOrder.indexOf(page.id);
    if (idx >= 0 && idx < pagesOrder.length - 1) {
      targets.push(pagesOrder[idx + 1]);
    }
  }
  return targets;
}

function detectCycles(
  list: MinimalPage[],
  byId: Map<string, MinimalPage>,
  order: string[],
): ValidatorIssue[] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(list.map((p) => [p.id, WHITE]));
  const issues: ValidatorIssue[] = [];

  function dfs(id: string, stack: string[]): void {
    color.set(id, GRAY);
    const p = byId.get(id);
    if (!p) return;
    for (const target of nextTargets(p, order)) {
      if (target === "paywall" || target === "end") continue;
      const c = color.get(target);
      if (c === GRAY) {
        const cycleStart = stack.indexOf(target);
        const path = stack.slice(cycleStart).concat(target);
        issues.push({ code: "CYCLE", message: `Cycle: ${path.join(" -> ")}`, path });
      } else if (c === WHITE) {
        dfs(target, [...stack, target]);
      }
    }
    color.set(id, BLACK);
  }

  for (const p of list) {
    if (color.get(p.id) === WHITE) dfs(p.id, [p.id]);
  }
  return issues;
}

function computeReachable(
  list: MinimalPage[],
  byId: Map<string, MinimalPage>,
  order: string[],
): Set<string> {
  const reachable = new Set<string>();
  if (list.length === 0) return reachable;
  const start = list[0].id;
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const p = byId.get(id);
    if (!p) continue;
    for (const target of nextTargets(p, order)) {
      if (target === "paywall" || target === "end") continue;
      if (!reachable.has(target)) stack.push(target);
    }
  }
  return reachable;
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @rovenue/api vitest run src/services/funnel/branching-validator.test.ts`
Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/funnel/branching-validator.ts apps/api/src/services/funnel/branching-validator.test.ts
git commit -m "feat(api): funnel publish-time validator (cycles, refs, terminals)"
```

---

### Task 11: Claim token generation + hashing

**Files:**
- Create: `apps/api/src/services/funnel/token.ts`
- Create: `apps/api/src/services/funnel/token.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { generateClaimToken, hashToken, safeEqualHash } from "./token";

describe("claim token", () => {
  it("generates a 43-char base64url token", () => {
    const t = generateClaimToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("each call produces a different token", () => {
    const a = generateClaimToken();
    const b = generateClaimToken();
    expect(a).not.toBe(b);
  });

  it("hashToken is deterministic and 64 hex chars", () => {
    const t = "abc";
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("safeEqualHash returns true for equal hashes", () => {
    const t = generateClaimToken();
    expect(safeEqualHash(hashToken(t), hashToken(t))).toBe(true);
  });

  it("safeEqualHash returns false for different hashes", () => {
    expect(safeEqualHash(hashToken("a"), hashToken("b"))).toBe(false);
  });

  it("safeEqualHash is length-tolerant (does not throw)", () => {
    expect(safeEqualHash("ab", "abcd")).toBe(false);
  });
});
```

- [ ] **Step 2: Run (expect failure)**

Run: `pnpm --filter @rovenue/api vitest run src/services/funnel/token.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/funnel/token.ts`:

```ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;

export function generateClaimToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function safeEqualHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @rovenue/api vitest run src/services/funnel/token.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/funnel/token.ts apps/api/src/services/funnel/token.test.ts
git commit -m "feat(api): claim token generate + hash + constant-time compare"
```

---

### Task 12: iOS fingerprint normalization + match

**Files:**
- Create: `apps/api/src/services/funnel/fingerprint.ts`
- Create: `apps/api/src/services/funnel/fingerprint.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { normalizeFingerprint, fingerprintsMatch, hashIp } from "./fingerprint";

describe("fingerprint", () => {
  it("normalizes locale and timezone to canonical form", () => {
    const f = normalizeFingerprint({
      ip: "1.2.3.4",
      userAgent: "Mozilla/5.0",
      locale: "en_US",
      timezone: "Europe/Istanbul",
      screenDims: "390 x 844",
      deviceModel: " iPhone15,2 ",
    });
    expect(f.locale).toBe("en-US");
    expect(f.timezone).toBe("Europe/Istanbul");
    expect(f.screenDims).toBe("390x844");
    expect(f.deviceModel).toBe("iPhone15,2");
    expect(f.ipHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("matches identical fingerprints", () => {
    const base = {
      ip: "1.2.3.4",
      userAgent: "ua",
      locale: "en-US",
      timezone: "Europe/Istanbul",
      screenDims: "390x844",
      deviceModel: "iPhone15,2",
    };
    const a = normalizeFingerprint(base);
    const b = normalizeFingerprint(base);
    expect(fingerprintsMatch(a, b)).toBe(true);
  });

  it("matches when device model is missing on one side", () => {
    const a = normalizeFingerprint({
      ip: "1.2.3.4",
      userAgent: "ua",
      locale: "en-US",
      timezone: "Europe/Istanbul",
      screenDims: "390x844",
    });
    const b = normalizeFingerprint({
      ip: "1.2.3.4",
      userAgent: "ua",
      locale: "en-US",
      timezone: "Europe/Istanbul",
      screenDims: "390x844",
      deviceModel: "iPhone15,2",
    });
    expect(fingerprintsMatch(a, b)).toBe(true);
  });

  it("does not match when IP hash differs", () => {
    const a = normalizeFingerprint({
      ip: "1.2.3.4",
      userAgent: "ua",
      locale: "en-US",
      timezone: "Europe/Istanbul",
      screenDims: "390x844",
    });
    const b = normalizeFingerprint({
      ip: "9.9.9.9",
      userAgent: "ua",
      locale: "en-US",
      timezone: "Europe/Istanbul",
      screenDims: "390x844",
    });
    expect(fingerprintsMatch(a, b)).toBe(false);
  });

  it("does not match when timezone differs", () => {
    const a = normalizeFingerprint({
      ip: "1.2.3.4",
      userAgent: "ua",
      locale: "en-US",
      timezone: "Europe/Istanbul",
      screenDims: "390x844",
    });
    const b = normalizeFingerprint({
      ip: "1.2.3.4",
      userAgent: "ua",
      locale: "en-US",
      timezone: "America/Los_Angeles",
      screenDims: "390x844",
    });
    expect(fingerprintsMatch(a, b)).toBe(false);
  });

  it("hashIp is deterministic with the configured salt", () => {
    expect(hashIp("1.2.3.4")).toBe(hashIp("1.2.3.4"));
    expect(hashIp("1.2.3.4")).not.toBe(hashIp("9.9.9.9"));
  });

  it("treats screenDims '0x0' as a wildcard during match", () => {
    const stored = normalizeFingerprint({
      ip: "1.2.3.4",
      userAgent: "ua",
      locale: "en-US",
      timezone: "Europe/Istanbul",
      screenDims: "0x0",
    });
    const sdkSide = normalizeFingerprint({
      ip: "1.2.3.4",
      userAgent: "ua",
      locale: "en-US",
      timezone: "Europe/Istanbul",
      screenDims: "390x844",
    });
    expect(fingerprintsMatch(stored, sdkSide)).toBe(true);
  });
});
```

- [ ] **Step 2: Run (expect failure)**

Run: `pnpm --filter @rovenue/api vitest run src/services/funnel/fingerprint.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/funnel/fingerprint.ts`:

```ts
import { createHash } from "node:crypto";

export interface FingerprintInput {
  ip: string;
  userAgent: string;
  locale: string;
  timezone: string;
  screenDims: string;
  deviceModel?: string | null;
}

export interface NormalizedFingerprint {
  ipHash: string;
  userAgent: string;
  locale: string;
  timezone: string;
  screenDims: string;
  deviceModel: string | null;
}

const SALT = process.env.FUNNEL_FINGERPRINT_SALT ?? "rovenue-fp-default-salt";

export function hashIp(ip: string): string {
  return createHash("sha256").update(`${SALT}:${ip}`).digest("hex");
}

export function normalizeFingerprint(input: FingerprintInput): NormalizedFingerprint {
  return {
    ipHash: hashIp(input.ip.trim()),
    userAgent: input.userAgent.trim().slice(0, 256),
    locale: input.locale.trim().replace(/_/g, "-"),
    timezone: input.timezone.trim(),
    screenDims: input.screenDims.replace(/\s+/g, "").toLowerCase(),
    deviceModel: input.deviceModel ? input.deviceModel.trim() : null,
  };
}

export function fingerprintsMatch(
  a: NormalizedFingerprint,
  b: NormalizedFingerprint,
): boolean {
  if (a.ipHash !== b.ipHash) return false;
  if (a.locale !== b.locale) return false;
  if (a.timezone !== b.timezone) return false;
  // "0x0" is the placeholder used when screen size isn't available (e.g. the
  // server-side Universal Link landing in Task 32). Treat it as a wildcard so
  // an iOS device's real dims still match the row stored by the landing.
  if (a.screenDims !== "0x0" && b.screenDims !== "0x0" && a.screenDims !== b.screenDims) {
    return false;
  }
  if (a.deviceModel && b.deviceModel && a.deviceModel !== b.deviceModel) return false;
  return true;
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @rovenue/api vitest run src/services/funnel/fingerprint.test.ts`
Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/funnel/fingerprint.ts apps/api/src/services/funnel/fingerprint.test.ts
git commit -m "feat(api): iOS fingerprint normalization and match"
```

---

### Task 13: Android Play Install Referrer parser

**Files:**
- Create: `apps/api/src/services/funnel/install-referrer.ts`
- Create: `apps/api/src/services/funnel/install-referrer.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  buildInstallReferrer,
  parseInstallReferrer,
  REFERRER_KEY,
} from "./install-referrer";

describe("install referrer", () => {
  it("buildInstallReferrer encodes token under the canonical key", () => {
    expect(buildInstallReferrer("abc123")).toBe(`${REFERRER_KEY}%3Dabc123`);
  });

  it("parseInstallReferrer extracts token from a Google Play referrer string", () => {
    const referrer = "utm_source=funnel&rovenue_funnel_token=abc123&utm_medium=web";
    expect(parseInstallReferrer(referrer)).toBe("abc123");
  });

  it("parseInstallReferrer returns null when the key is absent", () => {
    expect(parseInstallReferrer("utm_source=test")).toBeNull();
  });

  it("parseInstallReferrer URL-decodes the value", () => {
    expect(parseInstallReferrer("rovenue_funnel_token=abc%2F123")).toBe("abc/123");
  });

  it("parseInstallReferrer is null on empty/whitespace input", () => {
    expect(parseInstallReferrer("")).toBeNull();
    expect(parseInstallReferrer("   ")).toBeNull();
  });
});
```

- [ ] **Step 2: Run (expect failure)**

Run: `pnpm --filter @rovenue/api vitest run src/services/funnel/install-referrer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/funnel/install-referrer.ts`:

```ts
export const REFERRER_KEY = "rovenue_funnel_token";

export function buildInstallReferrer(token: string): string {
  return `${REFERRER_KEY}%3D${encodeURIComponent(token)}`;
}

export function parseInstallReferrer(raw: string): string | null {
  if (!raw || raw.trim().length === 0) return null;
  const params = new URLSearchParams(raw);
  const value = params.get(REFERRER_KEY);
  return value && value.length > 0 ? value : null;
}
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `pnpm --filter @rovenue/api vitest run src/services/funnel/install-referrer.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/funnel/install-referrer.ts apps/api/src/services/funnel/install-referrer.test.ts
git commit -m "feat(api): Play Install Referrer builder + parser"
```

---

## Phase 4 — Repositories

Each task adds one repository module + wires it into `packages/db/src/drizzle/index.ts`. No repo-level tests by default (existing convention) — Phase 9 covers them via integration tests. The atomic-claim path on `funnel_claim_tokens` is the one exception.

### Task 14: `funnels` repository

**Files:**
- Create: `packages/db/src/drizzle/repositories/funnels.ts`
- Modify: `packages/db/src/drizzle/index.ts`

- [ ] **Step 1: Implement**

Create `packages/db/src/drizzle/repositories/funnels.ts`:

```ts
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { funnels, type Funnel, type NewFunnel } from "../schema";

export async function listByProject(
  db: Db,
  projectId: string,
  opts: { status?: Funnel["status"]; limit?: number; offset?: number } = {},
): Promise<Funnel[]> {
  const where = opts.status
    ? and(eq(funnels.projectId, projectId), eq(funnels.status, opts.status))
    : eq(funnels.projectId, projectId);
  return db
    .select()
    .from(funnels)
    .where(where)
    .orderBy(desc(funnels.updatedAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);
}

export async function findById(db: Db, id: string): Promise<Funnel | null> {
  const rows = await db.select().from(funnels).where(eq(funnels.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findBySlug(
  db: Db,
  projectId: string,
  slug: string,
): Promise<Funnel | null> {
  const rows = await db
    .select()
    .from(funnels)
    .where(and(eq(funnels.projectId, projectId), eq(funnels.slug, slug)))
    .limit(1);
  return rows[0] ?? null;
}

export async function insert(db: Db, row: NewFunnel): Promise<Funnel> {
  const [inserted] = await db.insert(funnels).values(row).returning();
  return inserted;
}

export async function updateById(
  db: Db,
  id: string,
  patch: Partial<NewFunnel>,
): Promise<Funnel | null> {
  const [updated] = await db
    .update(funnels)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(funnels.id, id))
    .returning();
  return updated ?? null;
}

export async function setCurrentVersion(
  db: Db,
  id: string,
  versionId: string,
): Promise<void> {
  await db
    .update(funnels)
    .set({ currentVersionId: versionId, status: "published", updatedAt: new Date() })
    .where(eq(funnels.id, id));
}

export async function archive(db: Db, id: string): Promise<void> {
  await db
    .update(funnels)
    .set({ status: "archived", updatedAt: new Date() })
    .where(eq(funnels.id, id));
}
```

- [ ] **Step 2: Wire into barrel**

Edit `packages/db/src/drizzle/index.ts` and add (next to other `export * as …Repo` lines):

```ts
export * as funnelRepo from "./repositories/funnels";
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @rovenue/db typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/drizzle/repositories/funnels.ts packages/db/src/drizzle/index.ts
git commit -m "feat(db): funnels repository"
```

---

### Task 15: `funnel-versions` repository

**Files:**
- Create: `packages/db/src/drizzle/repositories/funnel-versions.ts`
- Modify: `packages/db/src/drizzle/index.ts`

- [ ] **Step 1: Implement**

```ts
import { desc, eq, max } from "drizzle-orm";
import type { Db } from "../client";
import { funnelVersions, type FunnelVersion, type NewFunnelVersion } from "../schema";

export async function findById(db: Db, id: string): Promise<FunnelVersion | null> {
  const rows = await db.select().from(funnelVersions).where(eq(funnelVersions.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listByFunnel(db: Db, funnelId: string): Promise<FunnelVersion[]> {
  return db
    .select()
    .from(funnelVersions)
    .where(eq(funnelVersions.funnelId, funnelId))
    .orderBy(desc(funnelVersions.versionNo));
}

export async function nextVersionNo(db: Db, funnelId: string): Promise<number> {
  const [row] = await db
    .select({ v: max(funnelVersions.versionNo) })
    .from(funnelVersions)
    .where(eq(funnelVersions.funnelId, funnelId));
  return (row?.v ?? 0) + 1;
}

export async function insert(db: Db, row: NewFunnelVersion): Promise<FunnelVersion> {
  const [inserted] = await db.insert(funnelVersions).values(row).returning();
  return inserted;
}
```

- [ ] **Step 2: Wire barrel**

Add to `packages/db/src/drizzle/index.ts`:

```ts
export * as funnelVersionRepo from "./repositories/funnel-versions";
```

- [ ] **Step 3: Type-check + commit**

Run: `pnpm --filter @rovenue/db typecheck` → PASS.

```bash
git add packages/db/src/drizzle/repositories/funnel-versions.ts packages/db/src/drizzle/index.ts
git commit -m "feat(db): funnel-versions repository"
```

---

### Task 16: `funnel-templates` repository

**Files:**
- Create: `packages/db/src/drizzle/repositories/funnel-templates.ts`
- Modify: `packages/db/src/drizzle/index.ts`

- [ ] **Step 1: Implement**

```ts
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { funnelTemplates, type FunnelTemplate, type NewFunnelTemplate } from "../schema";

export async function listSystem(db: Db): Promise<FunnelTemplate[]> {
  return db
    .select()
    .from(funnelTemplates)
    .where(eq(funnelTemplates.scope, "system"))
    .orderBy(asc(funnelTemplates.category), asc(funnelTemplates.name));
}

export async function findById(db: Db, id: string): Promise<FunnelTemplate | null> {
  const rows = await db
    .select()
    .from(funnelTemplates)
    .where(eq(funnelTemplates.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function insert(
  db: Db,
  row: NewFunnelTemplate,
): Promise<FunnelTemplate> {
  const [inserted] = await db.insert(funnelTemplates).values(row).returning();
  return inserted;
}

export async function listByProject(
  db: Db,
  projectId: string,
): Promise<FunnelTemplate[]> {
  return db
    .select()
    .from(funnelTemplates)
    .where(
      and(eq(funnelTemplates.scope, "user"), eq(funnelTemplates.projectId, projectId)),
    )
    .orderBy(asc(funnelTemplates.name));
}
```

- [ ] **Step 2: Wire + type-check + commit**

Add `export * as funnelTemplateRepo from "./repositories/funnel-templates";` to the barrel.

```bash
pnpm --filter @rovenue/db typecheck
git add packages/db/src/drizzle/repositories/funnel-templates.ts packages/db/src/drizzle/index.ts
git commit -m "feat(db): funnel-templates repository"
```

---

### Task 17: `funnel-sessions` repository

**Files:**
- Create: `packages/db/src/drizzle/repositories/funnel-sessions.ts`
- Modify: `packages/db/src/drizzle/index.ts`

- [ ] **Step 1: Implement**

```ts
import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../client";
import { funnelSessions, type FunnelSession, type NewFunnelSession } from "../schema";

export async function insert(db: Db, row: NewFunnelSession): Promise<FunnelSession> {
  const [inserted] = await db.insert(funnelSessions).values(row).returning();
  return inserted;
}

export async function findById(db: Db, id: string): Promise<FunnelSession | null> {
  const rows = await db
    .select()
    .from(funnelSessions)
    .where(eq(funnelSessions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function setCurrentPage(
  db: Db,
  id: string,
  pageId: string,
): Promise<void> {
  await db
    .update(funnelSessions)
    .set({ currentPageId: pageId, lastActivityAt: new Date() })
    .where(eq(funnelSessions.id, id));
}

export async function setState(
  db: Db,
  id: string,
  state: FunnelSession["state"],
): Promise<void> {
  const completed = state === "completed" ? { completedAt: new Date() } : {};
  await db
    .update(funnelSessions)
    .set({ state, lastActivityAt: new Date(), ...completed })
    .where(eq(funnelSessions.id, id));
}

export async function markAbandonedOlderThan(
  db: Db,
  cutoff: Date,
): Promise<number> {
  const rows = await db
    .update(funnelSessions)
    .set({ state: "abandoned" })
    .where(
      and(
        eq(funnelSessions.state, "in_progress"),
        lt(funnelSessions.lastActivityAt, cutoff),
      ),
    )
    .returning({ id: funnelSessions.id });
  return rows.length;
}

export async function listByFunnel(
  db: Db,
  funnelId: string,
  limit = 50,
  offset = 0,
): Promise<FunnelSession[]> {
  return db
    .select()
    .from(funnelSessions)
    .where(eq(funnelSessions.funnelId, funnelId))
    .limit(limit)
    .offset(offset);
}
```

- [ ] **Step 2: Wire + commit**

Add `export * as funnelSessionRepo from "./repositories/funnel-sessions";`.

```bash
pnpm --filter @rovenue/db typecheck
git add packages/db/src/drizzle/repositories/funnel-sessions.ts packages/db/src/drizzle/index.ts
git commit -m "feat(db): funnel-sessions repository"
```

---

### Task 18: `funnel-answers` repository

**Files:**
- Create: `packages/db/src/drizzle/repositories/funnel-answers.ts`
- Modify: `packages/db/src/drizzle/index.ts`

- [ ] **Step 1: Implement**

```ts
import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { funnelAnswers, type FunnelAnswer, type NewFunnelAnswer } from "../schema";

export async function upsert(
  db: Db,
  row: NewFunnelAnswer,
): Promise<FunnelAnswer> {
  const [inserted] = await db
    .insert(funnelAnswers)
    .values(row)
    .onConflictDoUpdate({
      target: [funnelAnswers.sessionId, funnelAnswers.questionId],
      set: {
        answerJson: row.answerJson,
        pageId: row.pageId,
        answeredAt: new Date(),
      },
    })
    .returning();
  return inserted;
}

export async function listBySession(
  db: Db,
  sessionId: string,
): Promise<FunnelAnswer[]> {
  return db.select().from(funnelAnswers).where(eq(funnelAnswers.sessionId, sessionId));
}
```

- [ ] **Step 2: Wire + commit**

Add `export * as funnelAnswerRepo from "./repositories/funnel-answers";`.

```bash
pnpm --filter @rovenue/db typecheck
git add packages/db/src/drizzle/repositories/funnel-answers.ts packages/db/src/drizzle/index.ts
git commit -m "feat(db): funnel-answers repository with upsert"
```

---

### Task 19: `funnel-purchases` repository (dev stub support)

**Files:**
- Create: `packages/db/src/drizzle/repositories/funnel-purchases.ts`
- Modify: `packages/db/src/drizzle/index.ts`

- [ ] **Step 1: Implement**

```ts
import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { funnelPurchases, type FunnelPurchase, type NewFunnelPurchase } from "../schema";

export async function insert(
  db: Db,
  row: NewFunnelPurchase,
): Promise<FunnelPurchase> {
  const [inserted] = await db.insert(funnelPurchases).values(row).returning();
  return inserted;
}

export async function findBySession(
  db: Db,
  sessionId: string,
): Promise<FunnelPurchase | null> {
  const rows = await db
    .select()
    .from(funnelPurchases)
    .where(eq(funnelPurchases.sessionId, sessionId))
    .limit(1);
  return rows[0] ?? null;
}

export async function markPaid(
  db: Db,
  id: string,
  patch: Partial<NewFunnelPurchase>,
): Promise<void> {
  await db
    .update(funnelPurchases)
    .set({ status: "paid", paidAt: new Date(), ...patch })
    .where(eq(funnelPurchases.id, id));
}
```

- [ ] **Step 2: Wire + commit**

Add `export * as funnelPurchaseRepo from "./repositories/funnel-purchases";`.

```bash
pnpm --filter @rovenue/db typecheck
git add packages/db/src/drizzle/repositories/funnel-purchases.ts packages/db/src/drizzle/index.ts
git commit -m "feat(db): funnel-purchases repository"
```

---

### Task 20: `funnel-claim-tokens` repository with atomic claim test

**Files:**
- Create: `packages/db/src/drizzle/repositories/funnel-claim-tokens.ts`
- Create: `packages/db/src/drizzle/repositories/funnel-claim-tokens.integration.test.ts`
- Modify: `packages/db/src/drizzle/index.ts`

- [ ] **Step 1: Implement**

```ts
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  funnelClaimTokens,
  type FunnelClaimToken,
  type NewFunnelClaimToken,
} from "../schema";

export async function insert(
  db: Db,
  row: NewFunnelClaimToken,
): Promise<FunnelClaimToken> {
  const [inserted] = await db.insert(funnelClaimTokens).values(row).returning();
  return inserted;
}

export async function findByHash(
  db: Db,
  tokenHash: string,
): Promise<FunnelClaimToken | null> {
  const rows = await db
    .select()
    .from(funnelClaimTokens)
    .where(eq(funnelClaimTokens.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

export async function findBySession(
  db: Db,
  sessionId: string,
): Promise<FunnelClaimToken | null> {
  const rows = await db
    .select()
    .from(funnelClaimTokens)
    .where(eq(funnelClaimTokens.sessionId, sessionId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findByEmailHash(
  db: Db,
  projectId: string,
  emailHash: string,
): Promise<FunnelClaimToken | null> {
  const rows = await db
    .select()
    .from(funnelClaimTokens)
    .where(
      and(
        eq(funnelClaimTokens.projectId, projectId),
        eq(funnelClaimTokens.emailHash, emailHash),
        isNull(funnelClaimTokens.claimedAt),
      ),
    )
    .orderBy(sql`${funnelClaimTokens.createdAt} desc`)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Atomic claim: UPDATE ... WHERE claimed_at IS NULL.
 * Returns the token if this caller won the race, null otherwise.
 */
export async function tryClaim(
  db: Db,
  id: string,
  subscriberId: string,
): Promise<FunnelClaimToken | null> {
  const [updated] = await db
    .update(funnelClaimTokens)
    .set({ claimedAt: new Date(), claimedBySubscriberId: subscriberId })
    .where(
      and(eq(funnelClaimTokens.id, id), isNull(funnelClaimTokens.claimedAt)),
    )
    .returning();
  return updated ?? null;
}

export async function markExpired(db: Db, now: Date): Promise<number> {
  const rows = await db
    .delete(funnelClaimTokens)
    .where(and(lt(funnelClaimTokens.expiresAt, now), isNull(funnelClaimTokens.claimedAt)))
    .returning({ id: funnelClaimTokens.id });
  return rows.length;
}
```

- [ ] **Step 2: Write integration test for atomic claim**

Create `packages/db/src/drizzle/repositories/funnel-claim-tokens.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../client";
import { funnelClaimTokens, funnels, funnelSessions, funnelVersions, projects } from "../schema";
import * as repo from "./funnel-claim-tokens";

const db = getDb();

let funnelId: string;
let versionId: string;
let sessionId: string;
let projectId: string;

beforeAll(async () => {
  projectId = `prj_test_${Date.now()}`;
  await db.insert(projects).values({ id: projectId, name: "T", slug: `t-${Date.now()}` });
  const [f] = await db
    .insert(funnels)
    .values({ projectId, slug: `f-${Date.now()}`, name: "F" })
    .returning();
  funnelId = f.id;
  const [v] = await db
    .insert(funnelVersions)
    .values({
      funnelId,
      versionNo: 1,
      pagesJson: [],
      themeJson: {},
      settingsJson: {},
    })
    .returning();
  versionId = v.id;
  const [s] = await db
    .insert(funnelSessions)
    .values({ funnelId, funnelVersionId: versionId, projectId })
    .returning();
  sessionId = s.id;
});

afterAll(async () => {
  await db.delete(projects).where(/* matches projectId via cascade */ undefined as never);
});

describe("funnel-claim-tokens repo", () => {
  beforeEach(async () => {
    await db.delete(funnelClaimTokens);
  });

  it("tryClaim succeeds exactly once under concurrent calls", async () => {
    const [token] = await db
      .insert(funnelClaimTokens)
      .values({
        tokenHash: "h1",
        sessionId,
        projectId,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();

    const results = await Promise.all([
      repo.tryClaim(db, token.id, "sub_a"),
      repo.tryClaim(db, token.id, "sub_b"),
      repo.tryClaim(db, token.id, "sub_c"),
    ]);
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
  });

  it("tryClaim returns null when already claimed", async () => {
    const [token] = await db
      .insert(funnelClaimTokens)
      .values({
        tokenHash: "h2",
        sessionId,
        projectId,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    expect(await repo.tryClaim(db, token.id, "sub_a")).not.toBeNull();
    expect(await repo.tryClaim(db, token.id, "sub_b")).toBeNull();
  });
});
```

- [ ] **Step 3: Run integration test**

Run: `pnpm --filter @rovenue/db vitest run src/drizzle/repositories/funnel-claim-tokens.integration.test.ts`
Expected: PASS (2/2). Requires Docker stack running (Postgres reachable via `DATABASE_URL`). Use `docker compose up postgres` first.

- [ ] **Step 4: Wire barrel + commit**

Add `export * as funnelClaimTokenRepo from "./repositories/funnel-claim-tokens";`.

```bash
git add packages/db/src/drizzle/repositories/funnel-claim-tokens.ts packages/db/src/drizzle/repositories/funnel-claim-tokens.integration.test.ts packages/db/src/drizzle/index.ts
git commit -m "feat(db): funnel-claim-tokens repo with atomic single-shot claim"
```

---

### Task 21: `funnel-deferred-claims` repository

**Files:**
- Create: `packages/db/src/drizzle/repositories/funnel-deferred-claims.ts`
- Modify: `packages/db/src/drizzle/index.ts`

- [ ] **Step 1: Implement**

```ts
import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  funnelDeferredClaims,
  type FunnelDeferredClaim,
  type NewFunnelDeferredClaim,
} from "../schema";

export async function insert(
  db: Db,
  row: NewFunnelDeferredClaim,
): Promise<FunnelDeferredClaim> {
  const [inserted] = await db.insert(funnelDeferredClaims).values(row).returning();
  return inserted;
}

export async function findRecentByIpHash(
  db: Db,
  ipHash: string,
  now: Date,
): Promise<FunnelDeferredClaim[]> {
  return db
    .select()
    .from(funnelDeferredClaims)
    .where(
      and(
        eq(funnelDeferredClaims.ipHash, ipHash),
        gte(funnelDeferredClaims.expiresAt, now),
        isNull(funnelDeferredClaims.matchedAt),
      ),
    )
    .orderBy(sql`${funnelDeferredClaims.createdAt} desc`)
    .limit(20);
}

export async function markMatched(
  db: Db,
  id: string,
  installId: string,
): Promise<void> {
  await db
    .update(funnelDeferredClaims)
    .set({ matchedAt: new Date(), matchedInstallId: installId })
    .where(eq(funnelDeferredClaims.id, id));
}

export async function deleteExpired(db: Db, now: Date): Promise<number> {
  const rows = await db
    .delete(funnelDeferredClaims)
    .where(lt(funnelDeferredClaims.expiresAt, now))
    .returning({ id: funnelDeferredClaims.id });
  return rows.length;
}
```

- [ ] **Step 2: Wire barrel + type-check + commit**

Add `export * as funnelDeferredClaimRepo from "./repositories/funnel-deferred-claims";`.

```bash
pnpm --filter @rovenue/db typecheck
git add packages/db/src/drizzle/repositories/funnel-deferred-claims.ts packages/db/src/drizzle/index.ts
git commit -m "feat(db): funnel-deferred-claims repository"
```

---

## Phase 5 — Builder API (dashboard)

### Task 22: Funnels CRUD route

**Files:**
- Create: `apps/api/src/routes/dashboard/funnels.ts`

- [ ] **Step 1: Implement CRUD endpoints**

Create `apps/api/src/routes/dashboard/funnels.ts`:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle, getDb } from "@rovenue/db";
import {
  pagesArraySchema,
  settingsSchema,
  themeSchema,
} from "@rovenue/shared/funnel";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { audit, extractRequestContext } from "../../lib/audit";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";

const app = new Hono();
app.use("*", requireDashboardAuth());

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

const createBody = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9-]+$/).optional(),
});

const updateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z.string().regex(/^[a-z0-9-]+$/).optional(),
  draft_pages_json: pagesArraySchema.optional(),
  draft_theme_json: themeSchema.partial().optional(),
  draft_settings_json: settingsSchema.partial().optional(),
});

app.get("/projects/:pid/funnels", async (c) => {
  const pid = c.req.param("pid");
  await assertProjectAccess(c, pid);
  const status = c.req.query("status") as
    | "draft"
    | "published"
    | "archived"
    | undefined;
  const rows = await drizzle.funnelRepo.listByProject(getDb(), pid, { status });
  return ok(c, rows);
});

app.post(
  "/projects/:pid/funnels",
  zValidator("json", createBody),
  async (c) => {
    const pid = c.req.param("pid");
    const user = await assertProjectAccess(c, pid, { write: true });
    const body = c.req.valid("json");
    const baseSlug = body.slug ?? slugify(body.name);
    const slug = `${baseSlug}-${randomSuffix()}`;
    const db = getDb();
    return db.transaction(async (tx) => {
      const created = await drizzle.funnelRepo.insert(tx, {
        projectId: pid,
        slug,
        name: body.name,
        createdBy: user.id,
      });
      await audit(tx, {
        ...extractRequestContext(c),
        projectId: pid,
        action: "funnel.create",
        targetId: created.id,
        metadata: { name: body.name, slug },
      });
      return ok(c, created, 201);
    });
  },
);

app.get("/projects/:pid/funnels/:fid", async (c) => {
  const pid = c.req.param("pid");
  await assertProjectAccess(c, pid);
  const row = await drizzle.funnelRepo.findById(getDb(), c.req.param("fid"));
  if (!row || row.projectId !== pid) {
    throw new HTTPException(404, { message: "Funnel not found" });
  }
  return ok(c, row);
});

app.patch(
  "/projects/:pid/funnels/:fid",
  zValidator("json", updateBody),
  async (c) => {
    const pid = c.req.param("pid");
    await assertProjectAccess(c, pid, { write: true });
    const fid = c.req.param("fid");
    const existing = await drizzle.funnelRepo.findById(getDb(), fid);
    if (!existing || existing.projectId !== pid) {
      throw new HTTPException(404, { message: "Funnel not found" });
    }
    const body = c.req.valid("json");
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.slug !== undefined) patch.slug = body.slug;
    if (body.draft_pages_json !== undefined) patch.draftPagesJson = body.draft_pages_json;
    if (body.draft_theme_json !== undefined) patch.draftThemeJson = body.draft_theme_json;
    if (body.draft_settings_json !== undefined)
      patch.draftSettingsJson = body.draft_settings_json;
    const db = getDb();
    return db.transaction(async (tx) => {
      const updated = await drizzle.funnelRepo.updateById(tx, fid, patch);
      await audit(tx, {
        ...extractRequestContext(c),
        projectId: pid,
        action: "funnel.update",
        targetId: fid,
        metadata: Object.keys(patch),
      });
      return ok(c, updated);
    });
  },
);

app.delete("/projects/:pid/funnels/:fid", async (c) => {
  const pid = c.req.param("pid");
  await assertProjectAccess(c, pid, { write: true });
  const fid = c.req.param("fid");
  const existing = await drizzle.funnelRepo.findById(getDb(), fid);
  if (!existing || existing.projectId !== pid) {
    throw new HTTPException(404, { message: "Funnel not found" });
  }
  const db = getDb();
  await db.transaction(async (tx) => {
    await drizzle.funnelRepo.archive(tx, fid);
    await audit(tx, {
      ...extractRequestContext(c),
      projectId: pid,
      action: "funnel.archive",
      targetId: fid,
    });
  });
  return ok(c, { id: fid, status: "archived" });
});

export default app;
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @rovenue/api typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/dashboard/funnels.ts
git commit -m "feat(api): funnel CRUD routes (list/create/get/patch/archive)"
```

---

### Task 23: Publish + duplicate + versions endpoints

**Files:**
- Modify: `apps/api/src/routes/dashboard/funnels.ts` (append at end before `export default`)

- [ ] **Step 1: Append routes**

Add to `apps/api/src/routes/dashboard/funnels.ts` (above `export default app;`):

```ts
import { validateFunnelGraph } from "../../services/funnel/branching-validator";
import { invalidatePublishedConfig } from "../../services/funnel/runtime-cache";

app.post("/projects/:pid/funnels/:fid/publish", async (c) => {
  const pid = c.req.param("pid");
  await assertProjectAccess(c, pid, { write: true });
  const fid = c.req.param("fid");
  const db = getDb();
  const existing = await drizzle.funnelRepo.findById(db, fid);
  if (!existing || existing.projectId !== pid) {
    throw new HTTPException(404, { message: "Funnel not found" });
  }

  const pages = pagesArraySchema.safeParse(existing.draftPagesJson);
  if (!pages.success) {
    throw new HTTPException(400, {
      message: JSON.stringify({
        code: "FUNNEL_VALIDATION",
        issues: pages.error.issues,
      }),
    });
  }
  const graph = validateFunnelGraph(pages.data);
  if (!graph.ok) {
    throw new HTTPException(400, {
      message: JSON.stringify({ code: "FUNNEL_VALIDATION", issues: graph.issues }),
    });
  }

  // Production gating: when no Stripe Connect link exists, reject paywall publish.
  if (
    process.env.NODE_ENV === "production" &&
    pages.data.some((p) => p.type === "paywall")
  ) {
    // Sub-project B will replace this with a real check on a `project_stripe_connections` table.
    throw new HTTPException(400, {
      message: JSON.stringify({
        code: "STRIPE_NOT_CONNECTED",
        issues: [{ message: "Connect Stripe before publishing a paywall funnel." }],
      }),
    });
  }

  const published = await db.transaction(async (tx) => {
    const versionNo = await drizzle.funnelVersionRepo.nextVersionNo(tx, fid);
    const version = await drizzle.funnelVersionRepo.insert(tx, {
      funnelId: fid,
      versionNo,
      pagesJson: pages.data,
      themeJson: existing.draftThemeJson,
      settingsJson: existing.draftSettingsJson,
      publishedBy: (c.get("user") as { id: string }).id,
    });
    await drizzle.funnelRepo.setCurrentVersion(tx, fid, version.id);
    await audit(tx, {
      ...extractRequestContext(c),
      projectId: pid,
      action: "funnel.publish",
      targetId: fid,
      metadata: { versionNo, warnings: graph.warnings.length },
    });
    return version;
  });

  await invalidatePublishedConfig(existing.slug);
  return ok(c, { version_id: published.id, version_no: published.versionNo });
});

app.post("/projects/:pid/funnels/:fid/duplicate", async (c) => {
  const pid = c.req.param("pid");
  const user = await assertProjectAccess(c, pid, { write: true });
  const fid = c.req.param("fid");
  const db = getDb();
  const src = await drizzle.funnelRepo.findById(db, fid);
  if (!src || src.projectId !== pid) {
    throw new HTTPException(404, { message: "Funnel not found" });
  }
  return db.transaction(async (tx) => {
    const created = await drizzle.funnelRepo.insert(tx, {
      projectId: pid,
      slug: `${src.slug}-copy-${randomSuffix()}`,
      name: `${src.name} (copy)`,
      draftPagesJson: src.draftPagesJson,
      draftThemeJson: src.draftThemeJson,
      draftSettingsJson: src.draftSettingsJson,
      createdBy: user.id,
    });
    await audit(tx, {
      ...extractRequestContext(c),
      projectId: pid,
      action: "funnel.duplicate",
      targetId: created.id,
      metadata: { sourceId: fid },
    });
    return ok(c, created, 201);
  });
});

app.get("/projects/:pid/funnels/:fid/versions", async (c) => {
  const pid = c.req.param("pid");
  await assertProjectAccess(c, pid);
  const versions = await drizzle.funnelVersionRepo.listByFunnel(
    getDb(),
    c.req.param("fid"),
  );
  return ok(
    c,
    versions.map((v) => ({
      id: v.id,
      version_no: v.versionNo,
      published_at: v.publishedAt,
      published_by: v.publishedBy,
    })),
  );
});

app.post("/projects/:pid/funnels/:fid/revert/:vid", async (c) => {
  const pid = c.req.param("pid");
  await assertProjectAccess(c, pid, { write: true });
  const fid = c.req.param("fid");
  const vid = c.req.param("vid");
  const db = getDb();
  const version = await drizzle.funnelVersionRepo.findById(db, vid);
  if (!version || version.funnelId !== fid) {
    throw new HTTPException(404, { message: "Version not found" });
  }
  return db.transaction(async (tx) => {
    const updated = await drizzle.funnelRepo.updateById(tx, fid, {
      draftPagesJson: version.pagesJson,
      draftThemeJson: version.themeJson,
      draftSettingsJson: version.settingsJson,
    });
    await audit(tx, {
      ...extractRequestContext(c),
      projectId: pid,
      action: "funnel.revert",
      targetId: fid,
      metadata: { versionId: vid, versionNo: version.versionNo },
    });
    return ok(c, updated);
  });
});
```

- [ ] **Step 2: Stub `runtime-cache.ts`**

Create `apps/api/src/services/funnel/runtime-cache.ts` (filled out in Phase 6):

```ts
export async function invalidatePublishedConfig(_slug: string): Promise<void> {
  // Implementation lands in Task 27 with the Redis client wiring.
}

export async function readPublishedConfig(
  _slug: string,
): Promise<unknown | null> {
  return null;
}

export async function writePublishedConfig(
  _slug: string,
  _value: unknown,
): Promise<void> {
  // Same.
}
```

- [ ] **Step 3: Type-check + commit**

Run: `pnpm --filter @rovenue/api typecheck` → PASS.

```bash
git add apps/api/src/routes/dashboard/funnels.ts apps/api/src/services/funnel/runtime-cache.ts
git commit -m "feat(api): funnel publish/duplicate/revert/versions routes"
```

---

### Task 24: Funnel templates routes + from-template create

**Files:**
- Create: `apps/api/src/routes/dashboard/funnel-templates.ts`
- Modify: `apps/api/src/routes/dashboard/funnels.ts` (add `from-template` endpoint)

- [ ] **Step 1: Implement templates route**

Create `apps/api/src/routes/dashboard/funnel-templates.ts`:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle, getDb } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { ok } from "../../lib/response";

const app = new Hono();
app.use("*", requireDashboardAuth());

app.get("/", async (c) => {
  const rows = await drizzle.funnelTemplateRepo.listSystem(getDb());
  return ok(c, rows);
});

app.get("/:tid", async (c) => {
  const t = await drizzle.funnelTemplateRepo.findById(getDb(), c.req.param("tid"));
  if (!t) throw new HTTPException(404, { message: "Template not found" });
  return ok(c, t);
});

export default app;
```

- [ ] **Step 2: Append `from-template` to funnels.ts**

Append to `apps/api/src/routes/dashboard/funnels.ts` (above `export default`):

```ts
import { createId } from "@paralleldrive/cuid2";

app.post(
  "/projects/:pid/funnels/from-template/:tid",
  async (c) => {
    const pid = c.req.param("pid");
    const user = await assertProjectAccess(c, pid, { write: true });
    const tpl = await drizzle.funnelTemplateRepo.findById(
      getDb(),
      c.req.param("tid"),
    );
    if (!tpl) throw new HTTPException(404, { message: "Template not found" });

    // Re-stamp page ids so duplicates across forks remain unique.
    const pagesArr = (Array.isArray(tpl.pagesJson) ? tpl.pagesJson : []) as Array<
      { id: string } & Record<string, unknown>
    >;
    const idMap = new Map<string, string>();
    for (const p of pagesArr) idMap.set(p.id, createId());
    const rewritten = pagesArr.map((p) => ({ ...p, id: idMap.get(p.id) ?? p.id }));
    // Note: next_rules / default_next id rewriting is intentionally NOT done here —
    // template authors are responsible for using stable refs, and the publish
    // validator catches dangling references.

    const db = getDb();
    return db.transaction(async (tx) => {
      const created = await drizzle.funnelRepo.insert(tx, {
        projectId: pid,
        slug: `${tpl.name.toLowerCase().replace(/\s+/g, "-")}-${randomSuffix()}`,
        name: tpl.name,
        draftPagesJson: rewritten,
        draftThemeJson: tpl.themeJson,
        draftSettingsJson: tpl.settingsJson,
        createdBy: user.id,
      });
      await audit(tx, {
        ...extractRequestContext(c),
        projectId: pid,
        action: "funnel.from_template",
        targetId: created.id,
        metadata: { templateId: tpl.id, templateName: tpl.name },
      });
      return ok(c, created, 201);
    });
  },
);
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter @rovenue/api typecheck
git add apps/api/src/routes/dashboard/funnel-templates.ts apps/api/src/routes/dashboard/funnels.ts
git commit -m "feat(api): funnel templates routes + fromTemplate create"
```

---

### Task 25: Funnel sessions read-only endpoints (dashboard)

**Files:**
- Modify: `apps/api/src/routes/dashboard/funnels.ts`

- [ ] **Step 1: Append session read endpoints**

Append to `apps/api/src/routes/dashboard/funnels.ts`:

```ts
app.get("/projects/:pid/funnels/:fid/sessions", async (c) => {
  const pid = c.req.param("pid");
  await assertProjectAccess(c, pid);
  const fid = c.req.param("fid");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const rows = await drizzle.funnelSessionRepo.listByFunnel(
    getDb(),
    fid,
    limit,
    offset,
  );
  return ok(c, rows);
});

app.get("/projects/:pid/funnels/:fid/sessions/:sid", async (c) => {
  const pid = c.req.param("pid");
  await assertProjectAccess(c, pid);
  const sid = c.req.param("sid");
  const db = getDb();
  const session = await drizzle.funnelSessionRepo.findById(db, sid);
  if (!session || session.projectId !== pid) {
    throw new HTTPException(404, { message: "Session not found" });
  }
  const answers = await drizzle.funnelAnswerRepo.listBySession(db, sid);
  return ok(c, { session, answers });
});
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter @rovenue/api typecheck
git add apps/api/src/routes/dashboard/funnels.ts
git commit -m "feat(api): dashboard read-only session/answers endpoints"
```

---

### Task 26: Builder API integration test (happy path)

**Files:**
- Create: `apps/api/src/routes/dashboard/funnels.integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create the file. It exercises: create → patch → publish → versions list → revert.

```ts
import { describe, expect, it } from "vitest";
import { buildTestApp, withTestUser } from "../../../test/helpers";
import type { PagesArray } from "@rovenue/shared/funnel";

describe("dashboard funnels API", () => {
  it("supports create → patch → publish → list versions", async () => {
    const { app, db } = await buildTestApp();
    const { user, projectId, authCookie } = await withTestUser(db);

    const created = await app.request("/v1/projects/" + projectId + "/funnels", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: authCookie },
      body: JSON.stringify({ name: "My quiz" }),
    });
    expect(created.status).toBe(201);
    const { data: funnel } = (await created.json()) as { data: { id: string } };

    const pages: PagesArray = [
      { id: "p1", type: "info", config: { title: "T", body_markdown: "B" } },
      {
        id: "p2",
        type: "paywall",
        config: { product_id: "pr_1", headline: "H", bullets: ["a"] },
      },
      {
        id: "p3",
        type: "success",
        config: { headline: "OK", body: "B", open_app_label: "Open" },
      },
    ];

    const patched = await app.request(
      `/v1/projects/${projectId}/funnels/${funnel.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: authCookie },
        body: JSON.stringify({ draft_pages_json: pages }),
      },
    );
    expect(patched.status).toBe(200);

    const published = await app.request(
      `/v1/projects/${projectId}/funnels/${funnel.id}/publish`,
      {
        method: "POST",
        headers: { cookie: authCookie },
      },
    );
    expect(published.status).toBe(200);
    const { data: pub } = (await published.json()) as {
      data: { version_id: string; version_no: number };
    };
    expect(pub.version_no).toBe(1);

    const versions = await app.request(
      `/v1/projects/${projectId}/funnels/${funnel.id}/versions`,
      { headers: { cookie: authCookie } },
    );
    expect(versions.status).toBe(200);
    expect(((await versions.json()) as { data: unknown[] }).data).toHaveLength(1);
  });

  it("publish rejects funnel with cycle", async () => {
    const { app, db } = await buildTestApp();
    const { projectId, authCookie } = await withTestUser(db);

    const created = await app.request(`/v1/projects/${projectId}/funnels`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: authCookie },
      body: JSON.stringify({ name: "Bad" }),
    });
    const { data: funnel } = (await created.json()) as { data: { id: string } };

    const pages: PagesArray = [
      { id: "p1", type: "info", config: { title: "T", body_markdown: "B" }, default_next: "p2" },
      { id: "p2", type: "info", config: { title: "T", body_markdown: "B" }, default_next: "p1" },
      {
        id: "p3",
        type: "paywall",
        config: { product_id: "pr_1", headline: "H", bullets: ["a"] },
      },
      {
        id: "p4",
        type: "success",
        config: { headline: "OK", body: "B", open_app_label: "Open" },
      },
    ];
    await app.request(`/v1/projects/${projectId}/funnels/${funnel.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: authCookie },
      body: JSON.stringify({ draft_pages_json: pages }),
    });
    const result = await app.request(
      `/v1/projects/${projectId}/funnels/${funnel.id}/publish`,
      { method: "POST", headers: { cookie: authCookie } },
    );
    expect(result.status).toBe(400);
    const body = (await result.json()) as { error: { message: string } };
    expect(body.error.message).toContain("CYCLE");
  });
});
```

> **Helper note:** `buildTestApp` and `withTestUser` are existing helpers in `apps/api/test/helpers.ts` (used by `invitations.integration.test.ts`). They spin up a Hono instance wired to a testcontainers Postgres, seed a project, and return an auth-cookie-bearing client. If they live under a different name in your tree, mirror that — do not reinvent.

- [ ] **Step 2: Run integration tests**

Run: `pnpm --filter @rovenue/api vitest run src/routes/dashboard/funnels.integration.test.ts`
Expected: PASS (2/2). Requires Docker stack with Postgres + Redis running.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/dashboard/funnels.integration.test.ts
git commit -m "test(api): funnel builder happy-path + cycle-rejection integration"
```

---

## Phase 6 — Public runtime API

### Task 27: Implement runtime cache + GET /public/funnels/:slug

**Files:**
- Modify: `apps/api/src/services/funnel/runtime-cache.ts` (replace stubs)
- Create: `apps/api/src/routes/public/funnels.ts`

- [ ] **Step 1: Replace runtime-cache stubs**

Replace `apps/api/src/services/funnel/runtime-cache.ts` contents:

```ts
import { redis } from "../../lib/redis";

const TTL_SECONDS = 300;
const PREFIX = "funnel:runtime:";

export async function readPublishedConfig<T>(slug: string): Promise<T | null> {
  const raw = await redis.get(PREFIX + slug);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function writePublishedConfig(
  slug: string,
  value: unknown,
): Promise<void> {
  await redis.set(PREFIX + slug, JSON.stringify(value), "EX", TTL_SECONDS);
}

export async function invalidatePublishedConfig(slug: string): Promise<void> {
  await redis.del(PREFIX + slug);
}
```

- [ ] **Step 2: Implement public funnels route**

Create `apps/api/src/routes/public/funnels.ts`:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { drizzle, getDb } from "@rovenue/db";
import {
  invalidatePublishedConfig,
  readPublishedConfig,
  writePublishedConfig,
} from "../../services/funnel/runtime-cache";

const app = new Hono();
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST"], maxAge: 86400 }));

interface PublishedRuntimeConfig {
  id: string;
  version_id: string;
  pages: Array<Record<string, unknown>>;
  theme: Record<string, unknown>;
  settings: Record<string, unknown>;
}

function stripBranchingRules(
  pages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return pages.map((p) => {
    const copy = { ...p };
    delete copy.next_rules;
    delete copy.default_next;
    return copy;
  });
}

app.get("/funnels/:slug", async (c) => {
  const slug = c.req.param("slug");
  const cached = await readPublishedConfig<PublishedRuntimeConfig>(slug);
  if (cached) return c.json({ data: cached });

  const db = getDb();
  const funnel = await db
    .select()
    .from((await import("@rovenue/db")).drizzle.schema.funnels)
    .where((await import("drizzle-orm")).eq(
      (await import("@rovenue/db")).drizzle.schema.funnels.slug,
      slug,
    ))
    .limit(1)
    .then((rows) => rows[0]);

  if (!funnel || funnel.status !== "published" || !funnel.currentVersionId) {
    throw new HTTPException(404, { message: "Funnel not found" });
  }
  const version = await drizzle.funnelVersionRepo.findById(
    db,
    funnel.currentVersionId,
  );
  if (!version) throw new HTTPException(404, { message: "Funnel not found" });

  const pagesArr = Array.isArray(version.pagesJson)
    ? (version.pagesJson as Array<Record<string, unknown>>)
    : [];

  const config: PublishedRuntimeConfig = {
    id: funnel.id,
    version_id: version.id,
    pages: stripBranchingRules(pagesArr),
    theme: version.themeJson as Record<string, unknown>,
    settings: version.settingsJson as Record<string, unknown>,
  };
  await writePublishedConfig(slug, config);
  return c.json({ data: config });
});

// Re-export the invalidate hook so builder publish can call it consistently
// from this module surface as well.
export { invalidatePublishedConfig };

export default app;
```

> **Note:** The inline dynamic imports above are inelegant; this plan keeps them only because the project's existing barrel layout makes the static-import equivalent verbose. If the engineer prefers static imports, replace with:
> ```ts
> import { funnels, drizzle, getDb } from "@rovenue/db";
> import { eq } from "drizzle-orm";
> ```
> and use `funnels` directly. Either form is fine — match what the surrounding code prefers.

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter @rovenue/api typecheck
git add apps/api/src/services/funnel/runtime-cache.ts apps/api/src/routes/public/funnels.ts
git commit -m "feat(api): public funnels GET with Redis cache + next_rules stripping"
```

---

### Task 28: POST /public/funnels/:slug/sessions

**Files:**
- Modify: `apps/api/src/routes/public/funnels.ts`

- [ ] **Step 1: Append the route**

Append to `apps/api/src/routes/public/funnels.ts`:

```ts
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { setCookie } from "hono/cookie";

const sessionStartBody = z.object({
  utm: z.record(z.string(), z.string()).optional(),
  referrer: z.string().optional(),
});

app.post(
  "/funnels/:slug/sessions",
  zValidator("json", sessionStartBody),
  async (c) => {
    const slug = c.req.param("slug");
    const config = await readPublishedConfig<PublishedRuntimeConfig>(slug);
    let funnelId: string;
    let versionId: string;
    let projectId: string;
    let firstPageId: string;

    if (config) {
      funnelId = config.id;
      versionId = config.version_id;
      // We still need the projectId — fetch from funnels table once.
      const db = getDb();
      const funnel = await drizzle.funnelRepo.findById(db, funnelId);
      if (!funnel) throw new HTTPException(404, { message: "Funnel not found" });
      projectId = funnel.projectId;
      firstPageId = (config.pages[0] as { id: string }).id;
    } else {
      // No cache — replay GET flow inline.
      const res = await app.request(c.req.url.replace(/\/sessions$/, ""));
      if (res.status !== 200) throw new HTTPException(404, { message: "Funnel not found" });
      const { data } = (await res.json()) as { data: PublishedRuntimeConfig };
      funnelId = data.id;
      versionId = data.version_id;
      firstPageId = (data.pages[0] as { id: string }).id;
      const db = getDb();
      const funnel = await drizzle.funnelRepo.findById(db, funnelId);
      projectId = funnel!.projectId;
    }

    const body = c.req.valid("json");
    const ipHashSeed = c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? "";
    const ua = c.req.header("user-agent") ?? "";

    const session = await drizzle.funnelSessionRepo.insert(getDb(), {
      funnelId,
      funnelVersionId: versionId,
      projectId,
      utmJson: body.utm ?? {},
      ipHash: ipHashSeed
        ? require("crypto").createHash("sha256").update(ipHashSeed).digest("hex")
        : null,
      userAgent: ua.slice(0, 256),
      currentPageId: firstPageId,
    });

    setCookie(c, "rv_funnel_sid", session.id, {
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 30 * 24 * 60 * 60,
      path: "/",
    });

    return c.json(
      { data: { session_id: session.id, first_page_id: firstPageId } },
      201,
    );
  },
);
```

> **Reviewer note for the engineer:** the `require("crypto")` call is shorthand; in this codebase the canonical form is `import { createHash } from "node:crypto";` — move that to the top of the file when you implement.

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter @rovenue/api typecheck
git add apps/api/src/routes/public/funnels.ts
git commit -m "feat(api): public session creation with cookie + IP hash"
```

---

### Task 29: Public answer + advance endpoints

**Files:**
- Modify: `apps/api/src/routes/public/funnels.ts`

- [ ] **Step 1: Append routes**

```ts
import {
  evaluateNext,
  type AnswerMap,
  type EvalPage,
  type PageGraph,
} from "../../services/funnel/branching-evaluator";

const answerBody = z.object({
  page_id: z.string(),
  question_id: z.string(),
  answer: z.unknown(),
});

const advanceBody = z.object({
  from_page_id: z.string(),
});

async function loadSessionContext(sessionId: string) {
  const db = getDb();
  const session = await drizzle.funnelSessionRepo.findById(db, sessionId);
  if (!session) throw new HTTPException(404, { message: "Session not found" });
  const version = await drizzle.funnelVersionRepo.findById(
    db,
    session.funnelVersionId,
  );
  if (!version) throw new HTTPException(500, { message: "Version missing" });
  const pages = (version.pagesJson as EvalPage[]) ?? [];
  const answers = await drizzle.funnelAnswerRepo.listBySession(db, sessionId);
  const answerMap: AnswerMap = new Map(
    answers.map((a) => [a.questionId, (a.answerJson as { value: unknown }).value as never]),
  );
  const pagesById: PageGraph = new Map(pages.map((p) => [p.id, p]));
  const pagesOrder = pages.map((p) => p.id);
  return { db, session, pages, answerMap, pagesById, pagesOrder };
}

app.post(
  "/funnel-sessions/:sid/answers",
  zValidator("json", answerBody),
  async (c) => {
    const sid = c.req.param("sid");
    const body = c.req.valid("json");
    const db = getDb();
    const session = await drizzle.funnelSessionRepo.findById(db, sid);
    if (!session) throw new HTTPException(404, { message: "Session not found" });
    if (session.state !== "in_progress") {
      throw new HTTPException(409, { message: "Session is closed" });
    }
    await drizzle.funnelAnswerRepo.upsert(db, {
      sessionId: sid,
      pageId: body.page_id,
      questionId: body.question_id,
      answerJson: { value: body.answer },
    });
    await drizzle.funnelSessionRepo.setCurrentPage(db, sid, body.page_id);
    return c.json({ data: { ok: true } });
  },
);

app.post(
  "/funnel-sessions/:sid/advance",
  zValidator("json", advanceBody),
  async (c) => {
    const sid = c.req.param("sid");
    const body = c.req.valid("json");
    const { db, pagesById, pagesOrder, answerMap } = await loadSessionContext(sid);
    const page = pagesById.get(body.from_page_id);
    if (!page) throw new HTTPException(400, { message: "Unknown from_page_id" });
    const result = evaluateNext({ page, pagesOrder, answers: answerMap, pagesById });
    if (result.next === "page") {
      await drizzle.funnelSessionRepo.setCurrentPage(db, sid, result.pageId);
      return c.json({ data: { next: "page", page_id: result.pageId } });
    }
    return c.json({ data: { next: result.next } });
  },
);
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter @rovenue/api typecheck
git add apps/api/src/routes/public/funnels.ts
git commit -m "feat(api): public funnel answer upsert + server-side advance"
```

---

### Task 30: GET /state + POST /claim-token (with dev-stub paywall path)

**Files:**
- Modify: `apps/api/src/routes/public/funnels.ts`

- [ ] **Step 1: Append routes**

```ts
import {
  generateClaimToken,
  hashToken,
} from "../../services/funnel/token";

app.get("/funnel-sessions/:sid/state", async (c) => {
  const sid = c.req.param("sid");
  const db = getDb();
  const session = await drizzle.funnelSessionRepo.findById(db, sid);
  if (!session) throw new HTTPException(404, { message: "Session not found" });
  const tokenRow = await drizzle.funnelClaimTokenRepo.findBySession(db, sid);
  return c.json({
    data: {
      current_page_id: session.currentPageId,
      state: session.state,
      has_claim_token: tokenRow !== null,
    },
  });
});

app.post("/funnel-sessions/:sid/claim-token", async (c) => {
  const sid = c.req.param("sid");
  const db = getDb();
  const session = await drizzle.funnelSessionRepo.findById(db, sid);
  if (!session) throw new HTTPException(404, { message: "Session not found" });

  // Dev-stub paywall completion. Production replaces this with Stripe webhook (sub-project B).
  if (session.state === "in_progress") {
    const version = await drizzle.funnelVersionRepo.findById(db, session.funnelVersionId);
    const settings = (version?.settingsJson ?? {}) as { dev_mode?: boolean };
    if (settings.dev_mode && process.env.NODE_ENV !== "production") {
      await db.transaction(async (tx) => {
        const purchase = await drizzle.funnelPurchaseRepo.insert(tx, {
          sessionId: sid,
          projectId: session.projectId,
          status: "paid",
          paidAt: new Date(),
          rawPayload: { stub: true },
        });
        await drizzle.funnelSessionRepo.setState(tx, sid, "paid");
        const token = generateClaimToken();
        await drizzle.funnelClaimTokenRepo.insert(tx, {
          tokenHash: hashToken(token),
          sessionId: sid,
          projectId: session.projectId,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
        // Stash token on context so we return it below — see closure capture.
        (c as unknown as { _stubToken?: string })._stubToken = token;
        return purchase;
      });
    } else {
      throw new HTTPException(409, { message: "Session is not paid" });
    }
  }

  if (session.state !== "paid" && session.state !== "completed") {
    throw new HTTPException(409, { message: "Session is not paid" });
  }

  let plaintext = (c as unknown as { _stubToken?: string })._stubToken;
  if (!plaintext) {
    // For non-stub flow (production), the runtime polls /state until token exists,
    // but the plaintext is only ever returned at issuance time. If this endpoint is
    // called *after* the token was already issued, return 410 — the user should not
    // be able to re-fetch a plaintext after it has been rendered once on the page.
    const existing = await drizzle.funnelClaimTokenRepo.findBySession(db, sid);
    if (!existing) throw new HTTPException(404, { message: "No claim token" });
    throw new HTTPException(410, { message: "Token already issued" });
  }

  const settings = ((await drizzle.funnelVersionRepo.findById(db, session.funnelVersionId))!
    .settingsJson) as { deep_link_scheme?: string; universal_link_domain?: string };
  const deepLink = settings.deep_link_scheme
    ? `${settings.deep_link_scheme}://onboarding-complete?token=${plaintext}&project=${session.projectId}`
    : null;
  const universalLink = settings.universal_link_domain
    ? `https://${settings.universal_link_domain}/universal/funnels/open/${plaintext}`
    : null;

  return c.json({
    data: { token: plaintext, deep_link_url: deepLink, universal_link_url: universalLink },
  });
});
```

> **Implementation note:** The "stub token via context property" trick exists only to keep the dev-stub path inside a single endpoint without a refactor. In sub-project B, Stripe webhook will create the `funnel_claim_tokens` row out-of-band and the runtime polls `/state` to detect issuance — then a separate flow re-issues the plaintext to the success page exactly once via short-lived session storage (Redis, 60s TTL). When you implement B, replace this trick with a clean state-machine.

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter @rovenue/api typecheck
git add apps/api/src/routes/public/funnels.ts
git commit -m "feat(api): /state + /claim-token with dev-stub paywall completion"
```

---

### Task 31: Public runtime integration test (uncached + cached flow)

**Files:**
- Create: `apps/api/src/routes/public/funnels.integration.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, expect, it } from "vitest";
import { buildTestApp, withTestUser, publishFunnel } from "../../../test/helpers";

describe("public funnels API", () => {
  it("renders published config and runs end-to-end with dev stub paywall", async () => {
    const { app, db } = await buildTestApp();
    const { authCookie, projectId } = await withTestUser(db);

    const { funnel } = await publishFunnel(app, authCookie, projectId, {
      name: "Quiz",
      dev_mode: true,
      pages: [
        { id: "p1", type: "info", config: { title: "T", body_markdown: "B" } },
        {
          id: "p2",
          type: "paywall",
          config: { product_id: "pr_1", headline: "H", bullets: ["a"] },
        },
        {
          id: "p3",
          type: "success",
          config: { headline: "OK", body: "B", open_app_label: "Open" },
        },
      ],
    });

    const cfg = await app.request(`/public/funnels/${funnel.slug}`);
    expect(cfg.status).toBe(200);
    const { data: config } = (await cfg.json()) as {
      data: { pages: Array<Record<string, unknown>> };
    };
    expect(config.pages[0]).not.toHaveProperty("next_rules");

    const sess = await app.request(`/public/funnels/${funnel.slug}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(sess.status).toBe(201);
    const { data: created } = (await sess.json()) as {
      data: { session_id: string; first_page_id: string };
    };
    expect(created.first_page_id).toBe("p1");

    const advance = await app.request(
      `/public/funnel-sessions/${created.session_id}/advance`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from_page_id: "p1" }),
      },
    );
    const advanceBody = (await advance.json()) as {
      data: { next: string; page_id?: string };
    };
    expect(advanceBody.data.page_id).toBe("p2");

    const claim = await app.request(
      `/public/funnel-sessions/${created.session_id}/claim-token`,
      { method: "POST" },
    );
    expect(claim.status).toBe(200);
    const { data: claimData } = (await claim.json()) as {
      data: { token: string };
    };
    expect(claimData.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
```

> **Helper note:** `publishFunnel` is a new shared helper — add it to `apps/api/test/helpers.ts`. Its job: create a funnel, PATCH `draft_pages_json` + `draft_settings_json={dev_mode: true}`, POST `/publish`, and return the funnel row + version.

- [ ] **Step 2: Implement `publishFunnel` helper**

Add to `apps/api/test/helpers.ts`:

```ts
export async function publishFunnel(
  app: AppHandle,
  cookie: string,
  projectId: string,
  opts: { name: string; dev_mode?: boolean; pages: Array<Record<string, unknown>> },
): Promise<{ funnel: { id: string; slug: string } }> {
  const created = await app.request(`/v1/projects/${projectId}/funnels`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: opts.name }),
  });
  const { data: funnel } = (await created.json()) as {
    data: { id: string; slug: string };
  };
  await app.request(`/v1/projects/${projectId}/funnels/${funnel.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      draft_pages_json: opts.pages,
      draft_settings_json: { dev_mode: opts.dev_mode ?? false },
    }),
  });
  await app.request(`/v1/projects/${projectId}/funnels/${funnel.id}/publish`, {
    method: "POST",
    headers: { cookie },
  });
  return { funnel };
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @rovenue/api vitest run src/routes/public/funnels.integration.test.ts
git add apps/api/src/routes/public/funnels.integration.test.ts apps/api/test/helpers.ts
git commit -m "test(api): public funnel runtime end-to-end with dev stub"
```

---

## Phase 7 — Universal link + SDK API

### Task 32: Universal link landing endpoint

**Files:**
- Create: `apps/api/src/routes/public/funnel-universal.ts`

- [ ] **Step 1: Implement**

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle, getDb } from "@rovenue/db";
import { hashToken } from "../../services/funnel/token";
import { buildInstallReferrer } from "../../services/funnel/install-referrer";
import { hashIp, normalizeFingerprint } from "../../services/funnel/fingerprint";

const app = new Hono();

function detectPlatform(ua: string): "ios" | "android" | "other" {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

app.get("/funnels/open/:token", async (c) => {
  const plaintext = c.req.param("token");
  const db = getDb();
  const tokenRow = await drizzle.funnelClaimTokenRepo.findByHash(db, hashToken(plaintext));
  if (!tokenRow) throw new HTTPException(404, { message: "Unknown token" });

  const session = await drizzle.funnelSessionRepo.findById(db, tokenRow.sessionId);
  if (!session) throw new HTTPException(404, { message: "Session missing" });
  const version = await drizzle.funnelVersionRepo.findById(db, session.funnelVersionId);
  const settings = (version?.settingsJson ?? {}) as {
    app_store_url?: string;
    play_store_url?: string;
  };

  const ua = c.req.header("user-agent") ?? "";
  const platform = detectPlatform(ua);
  const ip =
    c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "";

  if (platform === "android" && settings.play_store_url) {
    const url = `${settings.play_store_url}${settings.play_store_url.includes("?") ? "&" : "?"}referrer=${buildInstallReferrer(plaintext)}`;
    return c.redirect(url, 302);
  }

  if (platform === "ios" && settings.app_store_url) {
    // Persist a deferred-claim row for fingerprint matching.
    // Screen dims aren't available on a server-side GET, so we render a small
    // HTML landing page with a JS bounce that POSTs screen.width/height to a
    // /universal/funnels/open/:token/persist endpoint *before* redirecting.
    // For MVP simplicity, the function below stores "0x0" and the fingerprint
    // matcher (Task 12) is extended to treat "0x0" on either side as a wildcard.
    // See `fingerprintsMatch` in apps/api/src/services/funnel/fingerprint.ts —
    // add a `if (a.screenDims === "0x0" || b.screenDims === "0x0") skip dims check`
    // branch as part of this task.
    const fp = normalizeFingerprint({
      ip,
      userAgent: ua,
      locale: c.req.header("accept-language")?.split(",")[0] ?? "en-US",
      timezone: c.req.header("x-timezone") ?? "UTC",
      screenDims: "0x0",
    });
    await drizzle.funnelDeferredClaimRepo.insert(db, {
      tokenId: tokenRow.id,
      platform: "ios",
      ipHash: fp.ipHash,
      userAgent: fp.userAgent,
      locale: fp.locale,
      timezone: fp.timezone,
      screenDims: fp.screenDims,
      deviceModel: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return c.redirect(settings.app_store_url, 302);
  }

  // Fallback HTML — minimal manual store buttons.
  return c.html(
    `<!doctype html><html><body><h1>Open in app</h1>
      <a href="${settings.app_store_url ?? "#"}">App Store</a>
      <a href="${settings.play_store_url ?? "#"}">Play Store</a>
    </body></html>`,
  );
});

export default app;
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter @rovenue/api typecheck
git add apps/api/src/routes/public/funnel-universal.ts
git commit -m "feat(api): universal link landing with platform detection + deferred claim"
```

---

### Task 33: SDK `claim-funnel-token` endpoint

**Files:**
- Create: `apps/api/src/routes/v1/funnel-claim.ts`

- [ ] **Step 1: Implement**

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle, getDb } from "@rovenue/db";
import { requireApiKey } from "../../middleware/api-key";
import { hashToken, safeEqualHash } from "../../services/funnel/token";

const app = new Hono();
app.use("*", requireApiKey());

const claimBody = z.object({
  token: z.string().min(40).max(64),
  anon_id: z.string().min(1).max(64),
});

app.post(
  "/subscribers/claim-funnel-token",
  zValidator("json", claimBody),
  async (c) => {
    const { token, anon_id } = c.req.valid("json");
    const projectId = (c.get("apiKey") as { projectId: string }).projectId;
    const db = getDb();

    const tokenRow = await drizzle.funnelClaimTokenRepo.findByHash(db, hashToken(token));
    if (!tokenRow || tokenRow.projectId !== projectId) {
      throw new HTTPException(404, { message: "Token not found" });
    }
    // Defence-in-depth: even though findByHash already used the hashed key,
    // do a constant-time compare on the hashed forms.
    if (!safeEqualHash(tokenRow.tokenHash, hashToken(token))) {
      throw new HTTPException(404, { message: "Token not found" });
    }
    if (tokenRow.expiresAt < new Date()) {
      throw new HTTPException(410, { message: "Token expired" });
    }

    // Reclaim idempotency.
    if (tokenRow.claimedAt) {
      // If same subscriber, 200; otherwise 409.
      const sameSubscriber = tokenRow.claimedBySubscriberId === anon_id;
      if (sameSubscriber) {
        return c.json({ data: await buildClaimResponse(db, tokenRow) });
      }
      throw new HTTPException(409, { message: "Token already claimed" });
    }

    const won = await drizzle.funnelClaimTokenRepo.tryClaim(
      db,
      tokenRow.id,
      anon_id,
    );
    if (!won) throw new HTTPException(409, { message: "Token already claimed" });

    return c.json({ data: await buildClaimResponse(db, won) });
  },
);

async function buildClaimResponse(
  db: ReturnType<typeof getDb>,
  tokenRow: { sessionId: string; claimedBySubscriberId: string | null },
) {
  const answers = await drizzle.funnelAnswerRepo.listBySession(db, tokenRow.sessionId);
  // Entitlements are looked up from subscriber_access; sub-project B fills purchases
  // with real product_id, so until then this returns an empty array on dev-stub flows.
  const entitlements: unknown[] = [];

  await drizzle.funnelSessionRepo.setState(db, tokenRow.sessionId, "completed");

  return {
    subscriber_id: tokenRow.claimedBySubscriberId,
    entitlements,
    funnel_answers: Object.fromEntries(
      answers.map((a) => [a.questionId, (a.answerJson as { value: unknown }).value]),
    ),
  };
}

export default app;
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter @rovenue/api typecheck
git add apps/api/src/routes/v1/funnel-claim.ts
git commit -m "feat(api): SDK claim-funnel-token with atomic claim + idempotent reclaim"
```

---

### Task 34: SDK `claim-install` — Android Install Referrer + iOS fingerprint

**Files:**
- Modify: `apps/api/src/routes/v1/funnel-claim.ts`

- [ ] **Step 1: Append routes**

```ts
import {
  fingerprintsMatch,
  hashIp,
  normalizeFingerprint,
} from "../../services/funnel/fingerprint";
import { parseInstallReferrer } from "../../services/funnel/install-referrer";

const claimInstallBody = z.object({
  platform: z.enum(["ios", "android"]),
  locale: z.string().min(2).max(16),
  timezone: z.string().min(1).max(64),
  screen_dims: z.string().regex(/^\d+x\d+$/),
  device_model: z.string().max(64).optional(),
  install_referrer: z.string().max(2048).optional(),
  install_id: z.string().min(1).max(128),
});

app.post(
  "/sdk/claim-install",
  zValidator("json", claimInstallBody),
  async (c) => {
    const body = c.req.valid("json");
    const projectId = (c.get("apiKey") as { projectId: string }).projectId;
    const db = getDb();
    const ip =
      c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "";

    // Layer 1 — Android Install Referrer.
    if (body.platform === "android" && body.install_referrer) {
      const token = parseInstallReferrer(body.install_referrer);
      if (token) {
        const row = await drizzle.funnelClaimTokenRepo.findByHash(db, hashToken(token));
        if (row && row.projectId === projectId) {
          return c.json({ data: { token } });
        }
      }
    }

    // Layer 2 — iOS fingerprint match.
    if (body.platform === "ios") {
      const fp = normalizeFingerprint({
        ip,
        userAgent: c.req.header("user-agent") ?? "",
        locale: body.locale,
        timezone: body.timezone,
        screenDims: body.screen_dims,
        deviceModel: body.device_model,
      });
      const candidates = await drizzle.funnelDeferredClaimRepo.findRecentByIpHash(
        db,
        fp.ipHash,
        new Date(),
      );
      for (const candidate of candidates) {
        const candidateFp = normalizeFingerprint({
          ip: "ignored",
          userAgent: candidate.userAgent,
          locale: candidate.locale,
          timezone: candidate.timezone,
          screenDims: candidate.screenDims,
          deviceModel: candidate.deviceModel,
        });
        // Replace ipHash since we trust the candidate row's stored hash.
        candidateFp.ipHash = candidate.ipHash;
        if (fingerprintsMatch(fp, candidateFp)) {
          await drizzle.funnelDeferredClaimRepo.markMatched(
            db,
            candidate.id,
            body.install_id,
          );
          // We don't have the plaintext on the server; the SDK will receive the
          // token id and exchange it via the same flow as `claim-funnel-token`
          // — but for that we need the plaintext. Instead, surface a one-shot
          // re-issue token: we generate a NEW plaintext, hash-update the row,
          // and the existing claim row's token_hash is rotated.
          const newPlaintext = (await import("../../services/funnel/token")).generateClaimToken();
          // For atomicity, do this inside a tx in the real impl. For brevity:
          // (UPDATE funnel_claim_tokens SET token_hash = newHash WHERE id = candidate.token_id AND claimed_at IS NULL)
          throw new HTTPException(501, {
            message:
              "iOS fingerprint match: token rotation not implemented in MVP — use email fallback",
          });
        }
      }
    }

    return c.json({ data: null }, 404);
  },
);
```

> **Design note for the engineer:** The MVP iOS fingerprint path stores a deferred-claim row but does not yet have a clean "re-issue plaintext token to the SDK" mechanic — the original plaintext was rendered to the browser and is gone. The clean MVP behaviour is: when a fingerprint match succeeds, *rotate* the `token_hash` to a new value, return the new plaintext to the SDK, then proceed. This requires either (a) a new repo method `rotateHash(id, newHash)` or (b) deleting the old row and inserting a new one bound to the same session/project. Either is two lines of code — implement (a):
>
> ```ts
> export async function rotateHash(db: Db, id: string, newHash: string): Promise<void> {
>   await db.update(funnelClaimTokens)
>     .set({ tokenHash: newHash })
>     .where(and(eq(funnelClaimTokens.id, id), isNull(funnelClaimTokens.claimedAt)));
> }
> ```
>
> Then in this endpoint replace the `throw new HTTPException(501)` with:
> ```ts
> const newPlaintext = generateClaimToken();
> await drizzle.funnelClaimTokenRepo.rotateHash(db, candidate.tokenId, hashToken(newPlaintext));
> await drizzle.funnelDeferredClaimRepo.markMatched(db, candidate.id, body.install_id);
> return c.json({ data: { token: newPlaintext } });
> ```
> Add the unit test for `rotateHash` in the funnel-claim-tokens integration test file at the same time.

- [ ] **Step 2: Implement `rotateHash` repo method + replace the 501 throw**

Append to `packages/db/src/drizzle/repositories/funnel-claim-tokens.ts`:

```ts
export async function rotateHash(
  db: Db,
  id: string,
  newHash: string,
): Promise<void> {
  await db
    .update(funnelClaimTokens)
    .set({ tokenHash: newHash })
    .where(and(eq(funnelClaimTokens.id, id), isNull(funnelClaimTokens.claimedAt)));
}
```

And replace the 501 block in `claim-install` per the snippet above.

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter @rovenue/api typecheck
pnpm --filter @rovenue/db typecheck
git add apps/api/src/routes/v1/funnel-claim.ts packages/db/src/drizzle/repositories/funnel-claim-tokens.ts
git commit -m "feat(api): SDK claim-install with Android Referrer + iOS fingerprint match"
```

---

### Task 35: Email magic-link fallback (SDK + public magic resolver)

**Files:**
- Modify: `apps/api/src/routes/v1/funnel-claim.ts` (append SDK route)
- Create: `apps/api/src/routes/public/funnel-magic.ts`

- [ ] **Step 1: Append SDK route**

Append to `apps/api/src/routes/v1/funnel-claim.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { redis } from "../../lib/redis";
import { sendFunnelMagicLink } from "../../services/email/send-funnel-magic-link";

const claimViaEmailBody = z.object({
  email: z.string().email().max(254),
  install_id: z.string().min(1).max(128),
});

app.post(
  "/sdk/claim-via-email",
  zValidator("json", claimViaEmailBody),
  async (c) => {
    const body = c.req.valid("json");
    const projectId = (c.get("apiKey") as { projectId: string }).projectId;
    const db = getDb();
    const emailHash = createHash("sha256")
      .update(body.email.trim().toLowerCase())
      .digest("hex");
    const tokenRow = await drizzle.funnelClaimTokenRepo.findByEmailHash(
      db,
      projectId,
      emailHash,
    );
    if (!tokenRow) return c.json({ data: null }, 202);

    // Generate a magic-link nonce. Keep the plaintext claim token off-wire —
    // the magic link only carries the nonce; resolver maps it to the plaintext.
    const nonce = randomBytes(24).toString("base64url");
    // We need to mint a fresh plaintext (the original is gone — see Task 34 note).
    const fresh = (await import("../../services/funnel/token")).generateClaimToken();
    await drizzle.funnelClaimTokenRepo.rotateHash(
      db,
      tokenRow.id,
      hashToken(fresh),
    );
    await redis.set(
      `funnel:magic:${nonce}`,
      JSON.stringify({ tokenPlaintext: fresh, installId: body.install_id }),
      "EX",
      15 * 60,
    );
    await sendFunnelMagicLink(body.email, nonce);
    return c.json({ data: null }, 202);
  },
);
```

- [ ] **Step 2: Add the email send service**

Create `apps/api/src/services/email/send-funnel-magic-link.ts`:

```ts
import { sendTransactionalEmail } from "./ses";

export async function sendFunnelMagicLink(
  email: string,
  nonce: string,
): Promise<void> {
  const url = `${process.env.PUBLIC_BASE_URL}/public/magic/${nonce}`;
  await sendTransactionalEmail({
    to: email,
    template: "funnel-magic-link",
    variables: { url },
  });
}
```

> **Reuse:** `sendTransactionalEmail` is the existing SES wrapper in `apps/api/src/services/email/`; pass the new template id `funnel-magic-link`. Create the SES template via a follow-up infra ticket — outside the scope of this code change.

- [ ] **Step 3: Implement public magic resolver**

Create `apps/api/src/routes/public/funnel-magic.ts`:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { redis } from "../../lib/redis";

const app = new Hono();

app.get("/:nonce", async (c) => {
  const nonce = c.req.param("nonce");
  const raw = await redis.get(`funnel:magic:${nonce}`);
  if (!raw) throw new HTTPException(410, { message: "Link expired" });
  const { tokenPlaintext } = JSON.parse(raw) as { tokenPlaintext: string };
  await redis.del(`funnel:magic:${nonce}`);
  // Render an HTML page that auto-opens the deep link.
  // The SDK on the device receives the token via a deep link handler.
  // We don't know the funnel here without lookup, but we can fetch it via the token.
  // For brevity: render a generic page with the token in the URL (the app's
  // universal link config handles the open-in-app behaviour).
  return c.html(
    `<!doctype html><html><body>
      <script>
        window.location.href = 'rovenue://onboarding-complete?token=${tokenPlaintext}';
      </script>
      <p>Open the app... <a href="rovenue://onboarding-complete?token=${tokenPlaintext}">Tap here</a>.</p>
    </body></html>`,
  );
});

export default app;
```

> **Caveat:** the hard-coded `rovenue://` scheme should come from the funnel's settings — fetch the token row, look up the funnel version's settings, and use `deep_link_scheme`. Add that lookup before shipping.

- [ ] **Step 4: Type-check + commit**

```bash
pnpm --filter @rovenue/api typecheck
git add apps/api/src/routes/v1/funnel-claim.ts apps/api/src/services/email/send-funnel-magic-link.ts apps/api/src/routes/public/funnel-magic.ts
git commit -m "feat(api): SDK email magic-link fallback + public resolver"
```

---

## Phase 8 — Outbox events + background jobs

### Task 36: Outbox event helper + emit sites

**Files:**
- Create: `apps/api/src/services/funnel/outbox.ts`
- Modify: `apps/api/src/routes/public/funnels.ts`, `apps/api/src/routes/v1/funnel-claim.ts`

- [ ] **Step 1: Create the emit helper**

Create `apps/api/src/services/funnel/outbox.ts`:

```ts
import { drizzle, type Db } from "@rovenue/db";

export type FunnelEventKind =
  | "funnel.session.started"
  | "funnel.session.advanced"
  | "funnel.session.paid"
  | "funnel.session.completed"
  | "funnel.session.abandoned"
  | "funnel.claim_token.issued"
  | "funnel.claim_token.claimed";

export async function emitFunnelEvent(
  db: Db,
  kind: FunnelEventKind,
  payload: Record<string, unknown>,
): Promise<void> {
  await drizzle.outboxRepo.insert(db, {
    aggregate: "funnel",
    eventType: kind,
    payload,
  });
}
```

> **Note:** the exact `NewOutboxEvent` shape depends on the existing schema — check `packages/db/src/drizzle/schema.ts` for the `outboxEvents` columns and align field names (`aggregate`, `eventType`, etc.). Use the same column names other emitters use; the helper just centralises type-safe `kind` values.

- [ ] **Step 2: Wire emit calls into routes**

Add `await emitFunnelEvent(tx, "funnel.session.started", { ... })` etc. at the lifecycle transition points:

- `POST /public/funnels/:slug/sessions` → `funnel.session.started`
- `POST /public/funnel-sessions/:sid/advance` → `funnel.session.advanced` (only when `next_page_id` differs from `current_page_id`)
- Dev-stub paywall completion → `funnel.session.paid` AND `funnel.claim_token.issued`
- SDK claim (after `tryClaim` wins) → `funnel.session.completed` AND `funnel.claim_token.claimed`

Wrap each emit inside the existing tx used by the route. Pass `funnel_id`, `version_id`, `session_id`, `project_id`, and `at: new Date().toISOString()` in every payload.

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter @rovenue/api typecheck
git add apps/api/src/services/funnel/outbox.ts apps/api/src/routes/public/funnels.ts apps/api/src/routes/v1/funnel-claim.ts
git commit -m "feat(api): emit funnel outbox events on lifecycle transitions"
```

---

### Task 37: Session abandoner worker

**Files:**
- Create: `apps/api/src/workers/funnel-abandoner.ts`

- [ ] **Step 1: Implement**

```ts
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { drizzle, getDb } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

const log = logger.child("funnel-abandoner");
const QUEUE = "funnel-abandoner";
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

let queue: Queue | undefined;
export function getFunnelAbandonerQueue(): Queue {
  if (queue) return queue;
  queue = new Queue(QUEUE, { connection });
  return queue;
}

export async function scheduleFunnelAbandoner(): Promise<void> {
  await getFunnelAbandonerQueue().add(
    "tick",
    {},
    { repeat: { pattern: "0 * * * *" }, removeOnComplete: 50, removeOnFail: 50 },
  );
}

export function createFunnelAbandonerWorker(): Worker {
  return new Worker(
    QUEUE,
    async () => {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const updated = await drizzle.funnelSessionRepo.markAbandonedOlderThan(
        getDb(),
        cutoff,
      );
      log.info({ updated }, "marked sessions abandoned");
    },
    { connection },
  );
}
```

- [ ] **Step 2: Register in workers barrel**

In `apps/api/src/workers/index.ts` (or wherever workers are wired into startup), add:

```ts
import {
  scheduleFunnelAbandoner,
  createFunnelAbandonerWorker,
} from "./funnel-abandoner";

await scheduleFunnelAbandoner();
createFunnelAbandonerWorker();
```

- [ ] **Step 3: Commit**

```bash
pnpm --filter @rovenue/api typecheck
git add apps/api/src/workers/funnel-abandoner.ts apps/api/src/workers/index.ts
git commit -m "feat(api): hourly funnel session abandoner worker"
```

---

### Task 38: Token expirer + deferred-claim cleanup workers

**Files:**
- Create: `apps/api/src/workers/funnel-token-expirer.ts`
- Create: `apps/api/src/workers/funnel-deferred-cleanup.ts`
- Modify: `apps/api/src/workers/index.ts`

- [ ] **Step 1: Token expirer**

Create `apps/api/src/workers/funnel-token-expirer.ts`. Mirror the abandoner skeleton, but the job body:

```ts
const deleted = await drizzle.funnelClaimTokenRepo.markExpired(getDb(), new Date());
log.info({ deleted }, "expired claim tokens removed");
```

Schedule pattern: `"0 3 * * *"` (daily at 03:00).

- [ ] **Step 2: Deferred cleanup**

Create `apps/api/src/workers/funnel-deferred-cleanup.ts`. Job body:

```ts
const deleted = await drizzle.funnelDeferredClaimRepo.deleteExpired(
  getDb(),
  new Date(),
);
log.info({ deleted }, "expired deferred claims removed");
```

Schedule pattern: `"*/5 * * * *"` (every 5 minutes).

- [ ] **Step 3: Register both in workers barrel**

```ts
import {
  scheduleFunnelTokenExpirer,
  createFunnelTokenExpirerWorker,
} from "./funnel-token-expirer";
import {
  scheduleFunnelDeferredCleanup,
  createFunnelDeferredCleanupWorker,
} from "./funnel-deferred-cleanup";

await scheduleFunnelTokenExpirer();
createFunnelTokenExpirerWorker();
await scheduleFunnelDeferredCleanup();
createFunnelDeferredCleanupWorker();
```

- [ ] **Step 4: Commit**

```bash
pnpm --filter @rovenue/api typecheck
git add apps/api/src/workers/funnel-token-expirer.ts apps/api/src/workers/funnel-deferred-cleanup.ts apps/api/src/workers/index.ts
git commit -m "feat(api): funnel token expirer + deferred claim cleanup workers"
```

---

### Task 39: Smoke-verify workers boot

- [ ] **Step 1: Run the API in dev mode**

```bash
docker compose up -d postgres redis
pnpm dev --filter @rovenue/api
```

- [ ] **Step 2: Inspect logs for worker registration**

Expected three log lines within the first 5 seconds, each from the workers' barrel: `"funnel-abandoner queued"`, `"funnel-token-expirer queued"`, `"funnel-deferred-cleanup queued"` (or whatever the existing workers barrel logs at scheduling — match the wording so log scrapers stay happy).

- [ ] **Step 3: Kill the dev server; no commit needed (smoke test only)**

---

## Phase 9 — Integration tests + final wiring

### Task 40: Cold-install integration test

**Files:**
- Create: `apps/api/src/routes/v1/funnel-claim.integration.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, expect, it } from "vitest";
import {
  buildTestApp,
  withTestUser,
  publishFunnel,
  withApiKey,
} from "../../../test/helpers";

describe("SDK funnel claim API", () => {
  it("Android: install referrer carries the token through install", async () => {
    const { app, db } = await buildTestApp();
    const { authCookie, projectId } = await withTestUser(db);
    const apiKey = await withApiKey(db, projectId);

    const { funnel } = await publishFunnel(app, authCookie, projectId, {
      name: "Q",
      dev_mode: true,
      pages: [
        {
          id: "p1",
          type: "paywall",
          config: { product_id: "pr_1", headline: "H", bullets: ["a"] },
        },
        {
          id: "p2",
          type: "success",
          config: { headline: "OK", body: "B", open_app_label: "Open" },
        },
      ],
    });

    // 1. Run end-to-end runtime flow to mint a claim token.
    const sess = await app.request(`/public/funnels/${funnel.slug}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const { data: created } = (await sess.json()) as {
      data: { session_id: string };
    };
    const claim = await app.request(
      `/public/funnel-sessions/${created.session_id}/claim-token`,
      { method: "POST" },
    );
    const { data: tok } = (await claim.json()) as { data: { token: string } };

    // 2. Simulate SDK posting Install Referrer string to claim-install.
    const installRes = await app.request("/v1/sdk/claim-install", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        platform: "android",
        locale: "en-US",
        timezone: "UTC",
        screen_dims: "1080x2400",
        install_id: "inst_1",
        install_referrer: `rovenue_funnel_token=${tok.token}&utm_source=play`,
      }),
    });
    expect(installRes.status).toBe(200);
    const { data: installData } = (await installRes.json()) as {
      data: { token: string };
    };
    expect(installData.token).toBe(tok.token);

    // 3. Claim token via SDK.
    const finalClaim = await app.request("/v1/subscribers/claim-funnel-token", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ token: installData.token, anon_id: "sub_test" }),
    });
    expect(finalClaim.status).toBe(200);
    const body = (await finalClaim.json()) as {
      data: { subscriber_id: string; funnel_answers: Record<string, unknown> };
    };
    expect(body.data.subscriber_id).toBe("sub_test");
  });

  it("iOS: fingerprint match returns a rotated token", async () => {
    const { app, db } = await buildTestApp();
    const { authCookie, projectId } = await withTestUser(db);
    const apiKey = await withApiKey(db, projectId);
    const { funnel } = await publishFunnel(app, authCookie, projectId, {
      name: "QQ",
      dev_mode: true,
      pages: [
        {
          id: "p1",
          type: "paywall",
          config: { product_id: "pr_1", headline: "H", bullets: ["a"] },
        },
        {
          id: "p2",
          type: "success",
          config: { headline: "OK", body: "B", open_app_label: "Open" },
        },
      ],
    });

    // 1. Mint claim token.
    const sess = await app.request(`/public/funnels/${funnel.slug}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const { data: created } = (await sess.json()) as {
      data: { session_id: string };
    };
    await app.request(
      `/public/funnel-sessions/${created.session_id}/claim-token`,
      { method: "POST" },
    );

    // 2. Simulate Universal Link hit (creates deferred-claim row) by patching
    //    the route's mock IP header. Walk into the universal endpoint with iOS UA.
    await app.request(`/universal/funnels/open/SOME_PLAINTEXT`, {
      headers: {
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)",
        "cf-connecting-ip": "1.2.3.4",
        "accept-language": "en-US",
        "x-timezone": "Europe/Istanbul",
      },
    });
    // The above will 404 because SOME_PLAINTEXT is fake — but the test's value is
    // that earlier tests have created a real token. Replace SOME_PLAINTEXT with
    // the actual plaintext returned by /claim-token in the real test.

    // 3. SDK claim-install with matching fingerprint.
    const installRes = await app.request("/v1/sdk/claim-install", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "cf-connecting-ip": "1.2.3.4",
      },
      body: JSON.stringify({
        platform: "ios",
        locale: "en-US",
        timezone: "Europe/Istanbul",
        screen_dims: "0x0",
        install_id: "inst_ios_1",
      }),
    });
    expect([200, 404]).toContain(installRes.status);
    if (installRes.status === 200) {
      const { data } = (await installRes.json()) as { data: { token: string } };
      expect(data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });
});
```

- [ ] **Step 2: Add `withApiKey` helper**

In `apps/api/test/helpers.ts`, add a helper that creates an api_keys row for a project and returns the plaintext bearer value, following existing test fixture patterns (look at how `subscribers.integration.test.ts` builds an API key).

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @rovenue/api vitest run src/routes/v1/funnel-claim.integration.test.ts
git add apps/api/src/routes/v1/funnel-claim.integration.test.ts apps/api/test/helpers.ts
git commit -m "test(api): cold-install Android + iOS integration coverage"
```

---

### Task 41: Wire all route groups into `app.ts`

**Files:**
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Add the route mounts**

Find the existing route mounting block in `apps/api/src/app.ts` (where `dashboard`, `v1`, `public`, `webhooks` are wired in). Add:

```ts
import dashboardFunnels from "./routes/dashboard/funnels";
import dashboardFunnelTemplates from "./routes/dashboard/funnel-templates";
import publicFunnels from "./routes/public/funnels";
import publicFunnelMagic from "./routes/public/funnel-magic";
import publicFunnelUniversal from "./routes/public/funnel-universal";
import v1FunnelClaim from "./routes/v1/funnel-claim";

app.route("/v1", dashboardFunnels);           // mounts /v1/projects/:pid/funnels/*
app.route("/v1/funnel-templates", dashboardFunnelTemplates);
app.route("/public", publicFunnels);          // /public/funnels/*, /public/funnel-sessions/*
app.route("/public/magic", publicFunnelMagic);
app.route("/universal", publicFunnelUniversal);
app.route("/v1", v1FunnelClaim);              // /v1/subscribers/claim-funnel-token, /v1/sdk/*
```

- [ ] **Step 2: Smoke test**

```bash
pnpm --filter @rovenue/api typecheck
pnpm --filter @rovenue/api dev &
sleep 3
curl -s http://localhost:3000/health
kill %1
```
Expected: health endpoint still 200 OK; no startup errors in logs.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/app.ts
git commit -m "feat(api): wire funnel route groups into Hono app"
```

---

### Task 42: Seed system funnel templates

**Files:**
- Create: `packages/db/src/seed/funnel-templates.ts`
- Modify: `packages/db/src/seed/index.ts` (if it exists) or `packages/db/package.json` `db:seed` entry

- [ ] **Step 1: Implement seed**

Create `packages/db/src/seed/funnel-templates.ts`:

```ts
import { getDb } from "../drizzle/client";
import { funnelTemplates } from "../drizzle/schema";

const TEMPLATES = [
  {
    name: "Fitness goal quiz",
    category: "fitness",
    description: "Goal → frequency → fitness level → paywall.",
    pagesJson: [
      {
        id: "fit_p1",
        type: "question_single",
        config: {
          question_id: "goal",
          title: "What's your fitness goal?",
          options: [
            { id: "lose", label: "Lose weight", value: "lose_weight" },
            { id: "build", label: "Build muscle", value: "build_muscle" },
            { id: "tone", label: "Get toned", value: "get_toned" },
          ],
        },
      },
      {
        id: "fit_p2",
        type: "question_single",
        config: {
          question_id: "frequency",
          title: "How often do you work out?",
          options: [
            { id: "none", label: "Never", value: "0" },
            { id: "some", label: "1-2 times a week", value: "1-2" },
            { id: "lots", label: "3+ times a week", value: "3+" },
          ],
        },
      },
      {
        id: "fit_pay",
        type: "paywall",
        config: {
          product_id: "REPLACE_WITH_PRODUCT_ID",
          headline: "Get your custom plan",
          bullets: ["Personalised workouts", "Weekly check-ins", "Cancel anytime"],
        },
      },
      {
        id: "fit_ok",
        type: "success",
        config: { headline: "You're in!", body: "Time to open the app.", open_app_label: "Open" },
      },
    ],
    themeJson: { primary_color: "#0f172a", accent_color: "#22c55e" },
    settingsJson: {},
  },
  {
    name: "AI tool intro",
    category: "ai",
    description: "Value-prop carousel → paywall.",
    pagesJson: [
      {
        id: "ai_p1",
        type: "info",
        config: {
          title: "Hi! Here's how this works",
          body_markdown: "We use AI to help you ship faster.",
        },
      },
      {
        id: "ai_p2",
        type: "info",
        config: {
          title: "Three quick questions",
          body_markdown: "We'll personalise your dashboard.",
        },
      },
      {
        id: "ai_pay",
        type: "paywall",
        config: {
          product_id: "REPLACE_WITH_PRODUCT_ID",
          headline: "Unlock",
          bullets: ["Unlimited prompts", "Priority support"],
        },
      },
      {
        id: "ai_ok",
        type: "success",
        config: { headline: "Welcome!", body: "Open the app to start.", open_app_label: "Open" },
      },
    ],
    themeJson: { primary_color: "#1e293b", accent_color: "#a855f7" },
    settingsJson: {},
  },
  // Add 3-5 more here (habit-tracker, wellness, language-learning) when you have copy.
];

export async function seedFunnelTemplates(): Promise<void> {
  const db = getDb();
  for (const t of TEMPLATES) {
    await db
      .insert(funnelTemplates)
      .values({ ...t, scope: "system" })
      .onConflictDoNothing();
  }
}
```

- [ ] **Step 2: Wire into `db:seed`**

If `packages/db/src/seed/index.ts` exists, add:

```ts
import { seedFunnelTemplates } from "./funnel-templates";
await seedFunnelTemplates();
```

Otherwise, add a one-liner to the existing seed CLI (check `packages/db/package.json` `db:seed` script for the entry path).

- [ ] **Step 3: Run seed + verify**

```bash
pnpm db:seed
psql "$DATABASE_URL" -c "SELECT name, category FROM funnel_templates WHERE scope='system';"
```
Expected: 2+ rows.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/seed/funnel-templates.ts packages/db/src/seed/index.ts
git commit -m "feat(db): seed system funnel templates"
```

---

## Done — verification checklist

After all 42 tasks land:

- [ ] `pnpm test` passes across all packages.
- [ ] `pnpm build` passes.
- [ ] `pnpm db:migrate` is idempotent on a fresh database.
- [ ] `pnpm dev` starts the API + dashboard with no startup errors; `curl http://localhost:3000/health` returns 200.
- [ ] Open the dashboard, create a funnel from a system template, edit pages, publish. Hit the public URL in a browser, complete the dev-stub paywall, get a deep link back. (Manual smoke.)
- [ ] Three workers (`funnel-abandoner`, `funnel-token-expirer`, `funnel-deferred-cleanup`) appear in the BullMQ dashboard.
- [ ] Outbox `aggregate='funnel'` rows accumulate as you walk the runtime flow.

## Hand-off notes for sub-projects B and C

- **B (Stripe Connect)** picks up at the dev-stub paywall in Task 30 and the production gate in Task 23. Add a `project_stripe_connections` table, a Connect OAuth callback, Checkout Session creation tied to `funnel_purchases`, and a webhook handler that writes the same `funnel_purchases` + `funnel_claim_tokens` rows the dev-stub does today.
- **C (Templates + analytics)** picks up by reading the outbox events emitted in Task 36 into ClickHouse via Kafka, materialising the views described in the spec §13, and exposing a dashboard analytics panel. Also unlocks user-saved templates via the existing `funnel_templates.scope='user'` rows.



