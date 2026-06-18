# Custom Webhook Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the integrations page "Custom webhook" button configure the project's existing single outgoing webhook endpoint (URL + event-category filter + secret rotation), and remove the dead "Request integration" button.

**Architecture:** Additive only. One new `jsonb` column on `projects` (`webhookEventCategories`), a new shared event-category enum + mapping, an event-category filter inside the existing `enqueueOutgoingWebhook`, and a `webhookEventCategories` field threaded through the existing `PATCH /dashboard/projects/:id` read/write. The dashboard gets one centered modal reusing the existing rotate-secret hook. The legacy delivery worker, secret storage, and sdk-api `WebhookCard` are untouched.

**Tech Stack:** TypeScript (strict), Drizzle ORM + PostgreSQL, Hono + Zod, Vitest, React + TanStack Query, base-ui Dialog, i18next.

## Global Constraints

- TypeScript strict mode everywhere.
- All API responses use the `{ data: T }` / `{ error: { code, message } }` envelope via `ok()`.
- Zod validates all API input; barrel exports (`index.ts`) per package.
- `webhookSecret` stays **plaintext** (no encryption change) — matches existing rotate flow.
- `webhookEventCategories` empty array (`[]`) = receive ALL events (today's behavior).
- Unmapped event types **fail open** (still delivered) when a non-empty category filter is set.
- The 7 categories are exactly: `purchase`, `renewal`, `cancellation`, `refund`, `billing_issue`, `expiration`, `product_change`.
- Conventional commits (`feat:` / `fix:` / `docs:`).
- Do NOT switch/create git branches — commit on the current HEAD.

## File Structure

**Backend**
- `packages/shared/src/webhook-events.ts` (new) — category constant + `toWebhookEventCategory`.
- `packages/shared/src/index.ts` (modify) — re-export the above.
- `packages/shared/src/__tests__/webhook-events.test.ts` (new) — mapping tests.
- `packages/db/src/drizzle/schema.ts` (modify) — add `webhookEventCategories` column.
- `packages/db/drizzle/migrations/0075_project_webhook_event_categories.sql` (new).
- `packages/db/src/drizzle/repositories/projects.ts` (modify) — config read + update input.
- `apps/api/src/services/webhook-processor.ts` (modify) — filter in enqueue.
- `apps/api/src/services/webhook-processor.test.ts` (new or existing) — filter tests.
- `apps/api/src/routes/dashboard/projects.ts` (modify) — PATCH body + read field.
- `packages/shared/src/dashboard.ts` (modify) — `ProjectDetail` + `UpdateProjectRequest` fields.

**Dashboard**
- `apps/dashboard/src/lib/hooks/useUpdateProjectWebhook.ts` (new).
- `apps/dashboard/src/components/apps/custom-webhook-modal/custom-webhook-modal.tsx` (new).
- `apps/dashboard/src/components/apps/custom-webhook-modal/index.ts` (new).
- `apps/dashboard/src/routes/_authed/projects/$projectId/apps.tsx` (modify).
- `apps/dashboard/src/i18n/locales/en.json` (modify) — `apps.customWebhook.*` keys.

---

### Task 1: Shared — event categories + mapping

**Files:**
- Create: `packages/shared/src/webhook-events.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/webhook-events.test.ts`

**Interfaces:**
- Produces: `WEBHOOK_EVENT_CATEGORIES` (readonly tuple of 7 strings), `WebhookEventCategory` (union type), `toWebhookEventCategory(eventType: string): WebhookEventCategory | null`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/__tests__/webhook-events.test.ts
import { describe, it, expect } from "vitest";
import {
  WEBHOOK_EVENT_CATEGORIES,
  toWebhookEventCategory,
} from "../webhook-events";

describe("toWebhookEventCategory", () => {
  it("maps Apple notification types", () => {
    expect(toWebhookEventCategory("SUBSCRIBED")).toBe("purchase");
    expect(toWebhookEventCategory("DID_RENEW")).toBe("renewal");
    expect(toWebhookEventCategory("DID_CHANGE_RENEWAL_STATUS")).toBe("cancellation");
    expect(toWebhookEventCategory("REFUND")).toBe("refund");
    expect(toWebhookEventCategory("DID_FAIL_TO_RENEW")).toBe("billing_issue");
    expect(toWebhookEventCategory("EXPIRED")).toBe("expiration");
    expect(toWebhookEventCategory("PRICE_INCREASE")).toBe("product_change");
  });

  it("maps Google notification types", () => {
    expect(toWebhookEventCategory("SUBSCRIPTION_PURCHASED")).toBe("purchase");
    expect(toWebhookEventCategory("SUBSCRIPTION_RENEWED")).toBe("renewal");
    expect(toWebhookEventCategory("SUBSCRIPTION_CANCELED")).toBe("cancellation");
    expect(toWebhookEventCategory("SUBSCRIPTION_ON_HOLD")).toBe("billing_issue");
    expect(toWebhookEventCategory("SUBSCRIPTION_EXPIRED")).toBe("expiration");
    expect(toWebhookEventCategory("SUBSCRIPTION_PRICE_CHANGE_CONFIRMED")).toBe("product_change");
  });

  it("maps Stripe event types", () => {
    expect(toWebhookEventCategory("customer.subscription.created")).toBe("purchase");
    expect(toWebhookEventCategory("invoice.payment_succeeded")).toBe("renewal");
    expect(toWebhookEventCategory("customer.subscription.deleted")).toBe("cancellation");
    expect(toWebhookEventCategory("charge.refunded")).toBe("refund");
    expect(toWebhookEventCategory("invoice.payment_failed")).toBe("billing_issue");
    expect(toWebhookEventCategory("customer.subscription.updated")).toBe("product_change");
  });

  it("returns null for unmapped / consumption events", () => {
    expect(toWebhookEventCategory("CONSUMPTION_REQUEST")).toBeNull();
    expect(toWebhookEventCategory("unknown")).toBeNull();
    expect(toWebhookEventCategory("")).toBeNull();
  });

  it("exposes exactly 7 categories", () => {
    expect(WEBHOOK_EVENT_CATEGORIES).toHaveLength(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/shared test -- webhook-events`
Expected: FAIL — cannot resolve `../webhook-events`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/webhook-events.ts
// =============================================================
// Outgoing-webhook event categories
// =============================================================
//
// Operators subscribe a project's webhook endpoint to a subset of
// these normalized categories. Store-native event strings (Apple
// notificationType, Google notificationType, Stripe eventType) are
// folded into one category via `toWebhookEventCategory`. An empty
// subscription list means "all events".

export const WEBHOOK_EVENT_CATEGORIES = [
  "purchase",
  "renewal",
  "cancellation",
  "refund",
  "billing_issue",
  "expiration",
  "product_change",
] as const;

export type WebhookEventCategory = (typeof WEBHOOK_EVENT_CATEGORIES)[number];

const EVENT_TYPE_TO_CATEGORY: Record<string, WebhookEventCategory> = {
  // Apple App Store Server Notifications v2 (notificationType)
  SUBSCRIBED: "purchase",
  OFFER_REDEEMED: "purchase",
  DID_RENEW: "renewal",
  RENEWAL_EXTENDED: "renewal",
  DID_CHANGE_RENEWAL_STATUS: "cancellation",
  REFUND: "refund",
  REFUND_DECLINED: "refund",
  DID_FAIL_TO_RENEW: "billing_issue",
  GRACE_PERIOD_EXPIRED: "billing_issue",
  EXPIRED: "expiration",
  REVOKE: "expiration",
  DID_CHANGE_RENEWAL_PREF: "product_change",
  PRICE_INCREASE: "product_change",

  // Google Play Real-time Developer Notifications (subscriptionNotificationType)
  SUBSCRIPTION_PURCHASED: "purchase",
  SUBSCRIPTION_RESTARTED: "purchase",
  SUBSCRIPTION_RENEWED: "renewal",
  SUBSCRIPTION_RECOVERED: "renewal",
  SUBSCRIPTION_CANCELED: "cancellation",
  SUBSCRIPTION_PAUSED: "cancellation",
  SUBSCRIPTION_ON_HOLD: "billing_issue",
  SUBSCRIPTION_IN_GRACE_PERIOD: "billing_issue",
  SUBSCRIPTION_EXPIRED: "expiration",
  SUBSCRIPTION_REVOKED: "expiration",
  SUBSCRIPTION_PRICE_CHANGE_CONFIRMED: "product_change",
  SUBSCRIPTION_DEFERRED: "product_change",

  // Stripe (event.type)
  "customer.subscription.created": "purchase",
  "invoice.payment_succeeded": "renewal",
  "invoice.paid": "renewal",
  "customer.subscription.deleted": "cancellation",
  "charge.refunded": "refund",
  "invoice.payment_failed": "billing_issue",
  "customer.subscription.updated": "product_change",
};

/**
 * Fold a store-native event string into a normalized category.
 * Returns null for unmapped values — callers that filter on
 * categories MUST treat null as "deliver anyway" (fail open) so new
 * or unknown event types are never silently dropped.
 */
export function toWebhookEventCategory(
  eventType: string,
): WebhookEventCategory | null {
  return EVENT_TYPE_TO_CATEGORY[eventType] ?? null;
}
```

- [ ] **Step 4: Add the barrel export**

Add to `packages/shared/src/index.ts` (end of file, near other re-exports):

```ts
export * from "./webhook-events";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rovenue/shared test -- webhook-events`
Expected: PASS (5 tests).

> **NOTE (Stripe values):** the Stripe `event.type` strings above are the mapping's source of truth. During this task, open `apps/api/src/routes/webhooks/stripe.ts` and confirm the handler emits these exact strings as `eventType`; correct the map + test if any differ. Apple/Google strings are already verified against the handlers.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/webhook-events.ts packages/shared/src/index.ts packages/shared/src/__tests__/webhook-events.test.ts
git commit -m "feat(shared): webhook event categories + store-native mapping"
```

---

### Task 2: DB — schema column, migration, repo read/update

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts:261-270` (projects table)
- Create: `packages/db/drizzle/migrations/0075_project_webhook_event_categories.sql`
- Modify: `packages/db/src/drizzle/repositories/projects.ts:39-48` (read) and `:217-250` (update)

**Interfaces:**
- Consumes: nothing from prior tasks (uses plain `string[]`).
- Produces: `findProjectWebhookConfig(db, projectId): Promise<{ url: string | null; eventCategories: string[] } | null>`; `UpdateProjectInput.webhookEventCategories?: string[]`.

- [ ] **Step 1: Add the schema column**

In `packages/db/src/drizzle/schema.ts`, inside the `projects` table, immediately after the `webhookSecret` line (`:269`):

```ts
  webhookSecret: text("webhookSecret"),
  webhookEventCategories: jsonb("webhookEventCategories")
    .notNull()
    .$type<string[]>()
    .default(sql`'[]'::jsonb`),
```

(`jsonb` and `sql` are already imported in this file — used by `settings`.)

- [ ] **Step 2: Generate the migration and verify SQL**

Run: `pnpm db:migrate:generate`
This emits a new file under `packages/db/drizzle/migrations`. Rename it to
`0075_project_webhook_event_categories.sql` if drizzle-kit auto-named it, and confirm its
body is exactly:

```sql
ALTER TABLE "projects" ADD COLUMN "webhookEventCategories" jsonb DEFAULT '[]'::jsonb NOT NULL;
```

If generation produced anything else (e.g. touched unrelated tables), discard it and
hand-write the file above plus its journal entry.

- [ ] **Step 3: Add the config read method**

In `packages/db/src/drizzle/repositories/projects.ts`, replace the existing
`findProjectWebhookUrl` (lines ~38-49) with a config reader that returns both fields
(keep the function name's callers in mind — only `webhook-processor.ts` uses it, updated in Task 3):

```ts
/** Scoped read for webhook-processor — endpoint URL + category filter. */
export async function findProjectWebhookConfig(
  db: DbOrTx,
  projectId: string,
): Promise<{ url: string | null; eventCategories: string[] } | null> {
  const rows = await db
    .select({
      webhookUrl: projects.webhookUrl,
      webhookEventCategories: projects.webhookEventCategories,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    url: row.webhookUrl ?? null,
    eventCategories: row.webhookEventCategories ?? [],
  };
}
```

- [ ] **Step 4: Thread the field through `updateProject`**

In the same file, extend `UpdateProjectInput` (lines ~217-222) and `updateProject`
(lines ~234-242):

```ts
export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  webhookUrl?: string | null;
  webhookEventCategories?: string[];
  settings?: unknown;
}
```

```ts
  if (input.webhookUrl !== undefined) {
    patch.webhookUrl = input.webhookUrl;
  }
  if (input.webhookEventCategories !== undefined) {
    patch.webhookEventCategories = input.webhookEventCategories;
  }
```

- [ ] **Step 5: Apply the migration and typecheck**

Run: `pnpm db:migrate && pnpm --filter @rovenue/db build`
Expected: migration applies cleanly; package builds with no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/drizzle/migrations packages/db/src/drizzle/repositories/projects.ts
git commit -m "feat(db): project webhookEventCategories column + config reader"
```

---

### Task 3: API — event-category filter in enqueue

**Files:**
- Modify: `apps/api/src/services/webhook-processor.ts:276-312` (`enqueueOutgoingWebhook`)
- Test: `apps/api/src/services/webhook-processor.test.ts`

**Interfaces:**
- Consumes: `toWebhookEventCategory` (Task 1), `drizzle.projectRepo.findProjectWebhookConfig` (Task 2).

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/webhook-processor.test.ts` (create the file if absent; mock
the repo like the existing service tests do). The function `enqueueOutgoingWebhook` is
module-private — export it for testing by adding `export` to its declaration in Step 3,
then:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { drizzle } from "@rovenue/db";
import { __test_enqueueOutgoingWebhook as enqueueOutgoingWebhook } from "./webhook-processor";

vi.mock("@rovenue/db", async (orig) => {
  const actual = await orig<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      projectRepo: { findProjectWebhookConfig: vi.fn() },
      outgoingWebhookRepo: {
        findRecentOutgoingByPurchaseAndType: vi.fn().mockResolvedValue(null),
        enqueueOutgoingWebhook: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
});

const cfg = (eventCategories: string[]) =>
  vi.mocked(drizzle.projectRepo.findProjectWebhookConfig).mockResolvedValue({
    url: "https://hook.example.com",
    eventCategories,
  });
const enqueueSpy = () => vi.mocked(drizzle.outgoingWebhookRepo.enqueueOutgoingWebhook);

describe("enqueueOutgoingWebhook category filter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("enqueues everything when categories empty", async () => {
    cfg([]);
    await enqueueOutgoingWebhook({ projectId: "p1", subscriberId: "s1", eventType: "DID_RENEW" });
    expect(enqueueSpy()).toHaveBeenCalledTimes(1);
  });

  it("enqueues a matching category", async () => {
    cfg(["renewal"]);
    await enqueueOutgoingWebhook({ projectId: "p1", subscriberId: "s1", eventType: "DID_RENEW" });
    expect(enqueueSpy()).toHaveBeenCalledTimes(1);
  });

  it("skips a non-matching category", async () => {
    cfg(["purchase"]);
    await enqueueOutgoingWebhook({ projectId: "p1", subscriberId: "s1", eventType: "DID_RENEW" });
    expect(enqueueSpy()).not.toHaveBeenCalled();
  });

  it("fails open for unmapped event types", async () => {
    cfg(["purchase"]);
    await enqueueOutgoingWebhook({ projectId: "p1", subscriberId: "s1", eventType: "CONSUMPTION_REQUEST" });
    expect(enqueueSpy()).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no webhook url configured", async () => {
    vi.mocked(drizzle.projectRepo.findProjectWebhookConfig).mockResolvedValue({ url: null, eventCategories: [] });
    await enqueueOutgoingWebhook({ projectId: "p1", subscriberId: "s1", eventType: "DID_RENEW" });
    expect(enqueueSpy()).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- webhook-processor`
Expected: FAIL — `__test_enqueueOutgoingWebhook` / `findProjectWebhookConfig` not found.

- [ ] **Step 3: Update `enqueueOutgoingWebhook`**

In `apps/api/src/services/webhook-processor.ts`:

1. Add the import near the top (with the other `@rovenue/shared` / local imports):

```ts
import { toWebhookEventCategory } from "@rovenue/shared";
```

2. Replace the body of `enqueueOutgoingWebhook` (lines ~276-312) with:

```ts
export async function enqueueOutgoingWebhook(
  args: EnqueueOutgoingWebhookArgs,
): Promise<void> {
  const config = await drizzle.projectRepo.findProjectWebhookConfig(
    drizzle.db,
    args.projectId,
  );
  if (!config?.url) return;

  // Category filter — empty list means "all events". For a non-empty
  // list, drop events whose category isn't subscribed. Unmapped events
  // (category === null) fail open so unknown/new types aren't lost.
  if (config.eventCategories.length > 0) {
    const category = toWebhookEventCategory(args.eventType);
    if (category !== null && !config.eventCategories.includes(category)) {
      return;
    }
  }

  if (args.purchaseId) {
    const existing =
      await drizzle.outgoingWebhookRepo.findRecentOutgoingByPurchaseAndType(
        drizzle.db,
        args.projectId,
        args.subscriberId,
        args.eventType,
        args.purchaseId,
      );
    if (existing) return;
  }

  const payload = {
    eventType: args.eventType,
    subscriberId: args.subscriberId,
    purchaseId: args.purchaseId ?? null,
    timestamp: new Date().toISOString(),
  };

  await drizzle.outgoingWebhookRepo.enqueueOutgoingWebhook(drizzle.db, {
    projectId: args.projectId,
    eventType: args.eventType,
    subscriberId: args.subscriberId,
    purchaseId: args.purchaseId ?? null,
    payload,
    url: config.url,
  });
}
```

3. Add a test alias export at the bottom of the file (so the private function is testable without widening its public surface name):

```ts
export { enqueueOutgoingWebhook as __test_enqueueOutgoingWebhook };
```

(If `enqueueOutgoingWebhook` was already exported in your tree, drop the alias and import the real name in the test.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- webhook-processor`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/webhook-processor.ts apps/api/src/services/webhook-processor.test.ts
git commit -m "feat(api): filter outgoing webhooks by project event categories"
```

---

### Task 4: API — PATCH body + read field + shared types

**Files:**
- Modify: `packages/shared/src/dashboard.ts:45-62` (`ProjectDetail`), `:104-108` (`UpdateProjectRequest`)
- Modify: `apps/api/src/routes/dashboard/projects.ts:133-157` (`toProjectDetail`), `:203-212` (`updateProjectBodySchema`), `:346-352` (update call)
- Test: `apps/api/src/routes/dashboard/projects.test.ts` (or the existing projects route test file)

**Interfaces:**
- Consumes: `WEBHOOK_EVENT_CATEGORIES` (Task 1), `UpdateProjectInput.webhookEventCategories` (Task 2).
- Produces: `ProjectDetail.webhookEventCategories: string[]`.

- [ ] **Step 1: Write the failing route test**

Add to the projects route test (follow the file's existing harness for auth + seeding):

```ts
it("PATCH accepts and persists webhookEventCategories", async () => {
  const owner = await createUserAndSession("wh_cats");
  const project = await seedProject("_wh_cats", owner.id);

  const res = await app.request(`/dashboard/projects/${project.id}`, {
    method: "PATCH",
    headers: { ...owner.authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ webhookEventCategories: ["purchase", "renewal"] }),
  });
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(data.project.webhookEventCategories).toEqual(["purchase", "renewal"]);
});

it("PATCH rejects an unknown category", async () => {
  const owner = await createUserAndSession("wh_cats_bad");
  const project = await seedProject("_wh_cats_bad", owner.id);

  const res = await app.request(`/dashboard/projects/${project.id}`, {
    method: "PATCH",
    headers: { ...owner.authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ webhookEventCategories: ["not_a_category"] }),
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- projects`
Expected: FAIL — response lacks `webhookEventCategories` / 400 not returned.

- [ ] **Step 3: Extend the shared types**

In `packages/shared/src/dashboard.ts`, add to `ProjectDetail` (after `hasWebhookSecret`, `:50`):

```ts
  hasWebhookSecret: boolean;
  webhookEventCategories: string[];
```

and to `UpdateProjectRequest` (after `webhookUrl`, `:107`):

```ts
  webhookUrl?: string | null;
  webhookEventCategories?: string[];
```

- [ ] **Step 4: Extend the route**

In `apps/api/src/routes/dashboard/projects.ts`:

1. Import the enum (top of file, with other `@rovenue/shared` imports):

```ts
import { WEBHOOK_EVENT_CATEGORIES } from "@rovenue/shared";
```

2. Add to `updateProjectBodySchema` (`:203-209`):

```ts
    webhookUrl: z.string().url().nullable().optional(),
    webhookEventCategories: z.array(z.enum(WEBHOOK_EVENT_CATEGORIES)).optional(),
    settings: z.record(z.unknown()).optional(),
```

3. Add to the `updateProject` call object (`:347-352`):

```ts
      ...(body.webhookUrl !== undefined && { webhookUrl: body.webhookUrl }),
      ...(body.webhookEventCategories !== undefined && {
        webhookEventCategories: body.webhookEventCategories,
      }),
```

4. Add to `toProjectDetail` return (`:148-150`):

```ts
    webhookUrl: project.webhookUrl,
    hasWebhookSecret: Boolean(project.webhookSecret),
    webhookEventCategories: project.webhookEventCategories ?? [],
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- projects`
Expected: PASS (both new cases).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/dashboard.ts apps/api/src/routes/dashboard/projects.ts apps/api/src/routes/dashboard/projects.test.ts
git commit -m "feat(api): accept webhookEventCategories on project PATCH + read"
```

---

### Task 5: Dashboard — update hook

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useUpdateProjectWebhook.ts`

**Interfaces:**
- Consumes: `api` helper (`apps/dashboard/src/lib/api.ts`), `ProjectDetail`, `UpdateProjectRequest` (Task 4).
- Produces: `useUpdateProjectWebhook(projectId)` → mutation taking `{ webhookUrl?: string | null; webhookEventCategories?: string[] }`.

- [ ] **Step 1: Write the hook**

```ts
// apps/dashboard/src/lib/hooks/useUpdateProjectWebhook.ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProjectDetail, UpdateProjectRequest } from "@rovenue/shared";
import { api } from "../api";

type WebhookPatch = Pick<UpdateProjectRequest, "webhookUrl" | "webhookEventCategories">;

export function useUpdateProjectWebhook(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: WebhookPatch) =>
      api<{ project: ProjectDetail }>(`/dashboard/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: (res) => {
      qc.setQueryData(["project", projectId], res.project);
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useUpdateProjectWebhook.ts
git commit -m "feat(dashboard): useUpdateProjectWebhook mutation hook"
```

---

### Task 6: Dashboard — custom webhook modal

**Files:**
- Create: `apps/dashboard/src/components/apps/custom-webhook-modal/custom-webhook-modal.tsx`
- Create: `apps/dashboard/src/components/apps/custom-webhook-modal/index.ts`
- Modify: `apps/dashboard/src/i18n/locales/en.json`

**Interfaces:**
- Consumes: `useUpdateProjectWebhook` (Task 5), `useRotateWebhookSecret` (existing), `useProject` (existing), `WEBHOOK_EVENT_CATEGORIES` (Task 1), UI: `Button`, `Input`, `Checkbox`, `CopyButton`, `Chip`.
- Produces: `<CustomWebhookModal open onClose projectId />`.

- [ ] **Step 1: Add i18n keys**

In `apps/dashboard/src/i18n/locales/en.json`, under the `apps` object (sibling of `actions`), add a `customWebhook` block:

```json
"customWebhook": {
  "title": "Custom webhook",
  "subtitle": "Send Rovenue subscription events to your own HTTPS endpoint.",
  "urlLabel": "Endpoint URL",
  "urlPlaceholder": "https://api.yourapp.com/webhooks/rovenue",
  "urlInvalid": "Enter a valid https:// URL.",
  "eventsLabel": "Events",
  "eventsHint": "No selection = receive all events.",
  "categories": {
    "purchase": "Purchase",
    "renewal": "Renewal",
    "cancellation": "Cancellation",
    "refund": "Refund",
    "billing_issue": "Billing issue",
    "expiration": "Expiration",
    "product_change": "Product change"
  },
  "secretLabel": "Signing secret",
  "secretConfigured": "Configured",
  "secretMissing": "Not set",
  "rotate": "Rotate secret",
  "rotating": "Rotating…",
  "secretRevealWarning": "Copy this now — it won't be shown again.",
  "save": "Save",
  "saving": "Saving…",
  "saveError": "Could not save. Check the URL and try again."
}
```

- [ ] **Step 2: Write the modal**

```tsx
// apps/dashboard/src/components/apps/custom-webhook-modal/custom-webhook-modal.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@base-ui-components/react/dialog";
import { X } from "lucide-react";
import { WEBHOOK_EVENT_CATEGORIES } from "@rovenue/shared";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { Checkbox } from "../../../ui/checkbox";
import { Chip } from "../../../ui/chip";
import { CopyButton } from "../../../ui/copy-button";
import { cn } from "../../../lib/cn";
import { useProject } from "../../../lib/hooks/useProject";
import { useUpdateProjectWebhook } from "../../../lib/hooks/useUpdateProjectWebhook";
import { useRotateWebhookSecret } from "../../../lib/hooks/useRotateWebhookSecret";

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: string;
}

function isValidUrl(value: string): boolean {
  if (value.trim() === "") return true; // empty clears the endpoint
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export function CustomWebhookModal({ open, onClose, projectId }: Props) {
  const { t } = useTranslation();
  const { data: project } = useProject(projectId);
  const update = useUpdateProjectWebhook(projectId);
  const rotate = useRotateWebhookSecret(projectId);

  const [url, setUrl] = useState(project?.webhookUrl ?? "");
  const [categories, setCategories] = useState<string[]>(
    project?.webhookEventCategories ?? [],
  );
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const urlValid = isValidUrl(url);
  const canSave = urlValid && !update.isPending;

  const toggle = (cat: string) =>
    setCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );

  const handleSave = async () => {
    await update.mutateAsync({
      webhookUrl: url.trim() === "" ? null : url.trim(),
      webhookEventCategories: categories,
    });
    onClose();
  };

  const handleRotate = async () => {
    const res = await rotate.mutateAsync();
    setRevealedSecret(res.webhookSecret);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex w-[520px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_20px_80px_rgba(0,0,0,0.5)]",
            "transition duration-150 ease-out data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
            "focus:outline-none",
          )}
        >
          {/* Header */}
          <header className="flex items-start justify-between border-b border-rv-divider px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold">
                {t("apps.customWebhook.title")}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
                {t("apps.customWebhook.subtitle")}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label={t("common.cancel")}
              className="rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground"
            >
              <X size={16} />
            </Dialog.Close>
          </header>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <div className="grid grid-cols-1 gap-4">
              {/* URL */}
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                  {t("apps.customWebhook.urlLabel")}
                </label>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={t("apps.customWebhook.urlPlaceholder")}
                />
                {!urlValid && (
                  <p className="mt-1 text-[11px] text-rv-danger" role="alert">
                    {t("apps.customWebhook.urlInvalid")}
                  </p>
                )}
              </div>

              {/* Events */}
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                  {t("apps.customWebhook.eventsLabel")}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {WEBHOOK_EVENT_CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => toggle(cat)}
                      className="flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-2.5 py-2 text-left text-[12.5px] text-foreground hover:bg-rv-c3"
                    >
                      <Checkbox
                        checked={categories.includes(cat)}
                        onChange={() => toggle(cat)}
                        ariaLabel={t(`apps.customWebhook.categories.${cat}`)}
                      />
                      {t(`apps.customWebhook.categories.${cat}`)}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-rv-mute-500">
                  {t("apps.customWebhook.eventsHint")}
                </p>
              </div>

              {/* Secret */}
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                  {t("apps.customWebhook.secretLabel")}
                </div>
                {revealedSecret ? (
                  <div className="rounded-md border border-rv-divider bg-rv-c2 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <code className="truncate font-rv-mono text-[12px] text-foreground">
                        {revealedSecret}
                      </code>
                      <CopyButton size="xs" value={revealedSecret} />
                    </div>
                    <p className="mt-1 text-[11px] text-rv-warning">
                      {t("apps.customWebhook.secretRevealWarning")}
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Chip tone={project?.hasWebhookSecret ? "success" : "warning"}>
                      {project?.hasWebhookSecret
                        ? t("apps.customWebhook.secretConfigured")
                        : t("apps.customWebhook.secretMissing")}
                    </Chip>
                    <Button variant="flat" size="sm" onClick={handleRotate} disabled={rotate.isPending} type="button">
                      {rotate.isPending
                        ? t("apps.customWebhook.rotating")
                        : t("apps.customWebhook.rotate")}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <footer className="flex items-center justify-between border-t border-rv-divider bg-rv-c1 px-5 py-3">
            <span className="text-[12px] text-rv-danger" role="alert">
              {update.isError ? t("apps.customWebhook.saveError") : ""}
            </span>
            <div className="flex gap-2">
              <Button variant="flat" size="sm" onClick={onClose} type="button">
                {t("common.cancel")}
              </Button>
              <Button variant="solid-primary" size="sm" onClick={handleSave} disabled={!canSave} type="button">
                {update.isPending
                  ? t("apps.customWebhook.saving")
                  : t("apps.customWebhook.save")}
              </Button>
            </div>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 3: Add the barrel export**

```ts
// apps/dashboard/src/components/apps/custom-webhook-modal/index.ts
export { CustomWebhookModal } from "./custom-webhook-modal";
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: no errors. (Confirm `Chip` accepts `tone="success" | "warning"` and `Input`
forwards `value`/`onChange`/`placeholder` — both verified in the existing WebhookCard/grant-modal.)

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/apps/custom-webhook-modal apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): custom webhook config modal"
```

---

### Task 7: Dashboard — wire the page, remove "Request integration"

**Files:**
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/apps.tsx:1-5` (imports), `:72-78` (state), `:132-145` (buttons), `:211-221` (render modal)

**Interfaces:**
- Consumes: `CustomWebhookModal` (Task 6).

- [ ] **Step 1: Import the modal and drop the `Plus` icon**

Change the lucide import (`:4`) and add the modal import after the `IntegrationDrawer` import (`:26`):

```ts
import { BookOpen, Webhook } from "lucide-react";
```

```ts
import { CustomWebhookModal } from "../../../../components/apps/custom-webhook-modal";
```

- [ ] **Step 2: Add modal open state**

In `AppsPage`, next to the other `useState` hooks (`:74-78`):

```ts
  const [webhookModalOpen, setWebhookModalOpen] = useState(false);
```

- [ ] **Step 3: Replace the header button group**

Replace lines `:132-145` (the `<div className="flex flex-wrap gap-2">…</div>` block) with — note the "Request integration" button is gone and "Custom webhook" now has an `onClick`:

```tsx
        <div className="flex flex-wrap gap-2">
          <Button variant="flat" size="sm">
            <BookOpen size={13} />
            {t("apps.actions.docs")}
          </Button>
          <Button variant="flat" size="sm" onClick={() => setWebhookModalOpen(true)}>
            <Webhook size={13} />
            {t("apps.actions.customWebhook")}
          </Button>
        </div>
```

- [ ] **Step 4: Render the modal**

After the existing `{drawerProviderId && (…)}` block (`:211-219`), before the closing `</>`:

```tsx
      {webhookModalOpen && (
        <CustomWebhookModal
          open={true}
          onClose={() => setWebhookModalOpen(false)}
          projectId={projectId}
        />
      )}
```

- [ ] **Step 5: Verify build + lint**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit && pnpm --filter @rovenue/dashboard build`
Expected: no type errors, build succeeds. Confirm `Plus` is no longer imported and not
referenced elsewhere in the file (grep returns nothing):

Run: `grep -n "Plus\|apps.actions.request" apps/dashboard/src/routes/_authed/projects/\$projectId/apps.tsx`
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/\$projectId/apps.tsx
git commit -m "feat(dashboard): wire custom webhook modal, remove request integration button"
```

---

## Self-Review Notes

- **Spec coverage:** §4 column → Task 2; §5 categories/mapping → Task 1; §6 filter (fail-open) → Task 3; §7 PATCH + read → Task 4; §8 modal + hook + button removal → Tasks 5-7; §9 tests folded into Tasks 1/3/4. All covered.
- **Type consistency:** `findProjectWebhookConfig` returns `{ url, eventCategories }` and is consumed identically in Task 3; `webhookEventCategories: string[]` consistent across schema, repo input, shared `ProjectDetail`/`UpdateProjectRequest`, hook, and modal; `WEBHOOK_EVENT_CATEGORIES` is the single source for the Zod enum, mapping, and UI checkboxes.
- **Open confirmation (non-blocking):** Stripe `event.type` strings in Task 1 are flagged for handler confirmation; Apple/Google verified. The `enqueueOutgoingWebhook` export-for-test alias assumes the function is currently module-private (verified at `webhook-processor.ts:276`).
- **Out of scope honored:** no `webhook_destinations` table, no delivery-worker/signing change, no secret encryption, `WebhookCard` and `BuildYourOwnCard` untouched.
```
