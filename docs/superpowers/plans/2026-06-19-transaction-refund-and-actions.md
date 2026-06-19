# Transaction Refund + Inspector Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the transaction inspector's footer actions — a store-integrated **Refund** button (Stripe + Google Play; Apple rejected) and a 4-item **`...` overflow menu** (Copy ID, Copy payload, View subscriber, View subscription).

**Architecture:** The dashboard already holds each transaction's `revenue_events.id` (un-truncated) as `tx.id`. A new `POST /dashboard/projects/:projectId/transactions/:id/refund` resolves that id → purchase, then calls the **store's** refund API (Stripe `refunds.create`, Google Play `orders.refund`). It does **not** write the refund to our DB — the existing store-webhook path (`applyChargeRefunded` / Play RTDN) is the single source of truth and records the REFUND revenue_event + `status: REFUNDED` + access revocation idempotently when the store calls back. The UI reflects the change after the webhook lands.

**Tech Stack:** Hono + Drizzle + Zod (API), Stripe Node SDK (`^15`), `googleapis` (`^133`), TanStack Query + TanStack Router + Base UI Menu (dashboard), Vitest + testcontainers.

## Global Constraints

- Stay on the current branch — do **not** create or switch branches/worktrees. Commit on whatever HEAD is checked out.
- All API responses use the `{ data }` / `{ error: { code, message } }` envelope via `ok()` / `fail()` from `apps/api/src/lib/response.ts`.
- TypeScript strict mode everywhere.
- Refund amounts stored POSITIVE (existing convention) — but note this plan does **not** write revenue rows; the webhook path already honors it.
- Conventional commits. End commit messages with the `Co-Authored-By` trailer.
- Apple/iOS refunds are rejected (no merchant API); the Refund button is already hidden for `store === "ios"` in `transaction-inspector.tsx`.

## Open Decisions (resolve before/at execution)

- **D1 — "View subscription" destination:** No subscription detail route exists. This plan implements it as a navigate to the subscriber detail page `/projects/$projectId/subscribers/$id` (same as "View subscriber" but semantically "see the subscription there"). If a dedicated purchase detail page is wanted, that is a separate follow-up plan.
- **D2 — Async refund reconciliation:** Endpoint calls the store API only; DB state updates when the store webhook arrives. Confirmed acceptable (matches the outbox/webhook-source-of-truth architecture). The UI shows a "Refund requested" success state, not an instant row flip.

---

## File Structure

**API (create):**
- `apps/api/src/services/refunds/refund-transaction.ts` — store-routing refund service (`refundTransaction`).
- `apps/api/src/services/refunds/refund-transaction.test.ts` — unit tests (mocked store clients).
- `apps/api/src/routes/dashboard/transactions.refund.integration.test.ts` — endpoint integration test.

**API (modify):**
- `apps/api/src/lib/capabilities.ts` — add `refunds:write`.
- `packages/db/src/drizzle/repositories/revenue-events.ts` — add `findRevenueEventById`.
- `apps/api/src/routes/dashboard/transactions.ts` — add the refund route.

**Dashboard (create):**
- `apps/dashboard/src/lib/hooks/useRefundTransaction.ts` — mutation hook.
- `apps/dashboard/src/components/transactions/refund-confirm-dialog.tsx` — confirm modal.
- `apps/dashboard/src/components/transactions/transaction-actions-menu.tsx` — the `...` overflow menu.

**Dashboard (modify):**
- `apps/dashboard/src/components/transactions/types.ts` — add full `subscriberId` / `purchaseId` to `Transaction`.
- `apps/dashboard/src/routes/_authed/projects/$projectId/transactions.tsx` — set the new fields in `toUiTransaction`.
- `apps/dashboard/src/components/transactions/transaction-inspector.tsx` — wire Refund button + mount menu.
- `apps/dashboard/src/i18n/locales/en.json` — new keys.

---

## Task 1: Add `refunds:write` capability

**Files:**
- Modify: `apps/api/src/lib/capabilities.ts`

**Interfaces:**
- Produces: capability string `"refunds:write"` granted to `["OWNER", "ADMIN"]`.

- [ ] **Step 1: Add to the union and the roles map**

In `apps/api/src/lib/capabilities.ts`, add `| "refunds:write"` to the `Capability` union and this entry to `CAPABILITY_ROLES`:

```typescript
  "refunds:write":          ["OWNER", "ADMIN"],
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @rovenue/api exec tsc --noEmit`
Expected: PASS (the `Record<Capability, ...>` map is now exhaustive again).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/capabilities.ts
git commit -m "feat(api): add refunds:write capability"
```

---

## Task 2: Add `findRevenueEventById` repository function

**Files:**
- Modify: `packages/db/src/drizzle/repositories/revenue-events.ts`
- Test: `packages/db/src/drizzle/repositories/revenue-events.integration.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Produces: `findRevenueEventById(db: DbOrTx, id: string): Promise<RevenueEvent | null>` — returns the row including `projectId`, `purchaseId`, `subscriberId`, `store`, `type`, or `null`.

- [ ] **Step 1: Write the failing test**

Append to the revenue-events integration test (mirror the existing testcontainer setup in the file / sibling repo tests):

```typescript
it("findRevenueEventById returns the row by id, scoped fields intact", async () => {
  const created = await createRevenueEvent(db, baseEventInput); // existing helper/fixture
  const found = await findRevenueEventById(db, created.id);
  expect(found?.id).toBe(created.id);
  expect(found?.purchaseId).toBe(created.purchaseId);
  expect(await findRevenueEventById(db, "rev_does_not_exist")).toBeNull();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @rovenue/db test revenue-events`
Expected: FAIL — `findRevenueEventById is not a function`.

- [ ] **Step 3: Implement**

In `packages/db/src/drizzle/repositories/revenue-events.ts`:

```typescript
export async function findRevenueEventById(
  db: DbOrTx,
  id: string,
): Promise<RevenueEvent | null> {
  const [row] = await db.select().from(revenueEvents).where(eq(revenueEvents.id, id)).limit(1);
  return row ?? null;
}
```

Ensure `revenueEvents`, `eq`, `DbOrTx`, and `RevenueEvent` are imported/exported as the file's existing functions use them. Export `findRevenueEventById` from the repo barrel if the repo is surfaced via an aggregate object (match how `createRevenueEvent` is exposed, e.g. on `drizzle.revenueEventRepo`).

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter @rovenue/db test revenue-events`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/revenue-events.ts packages/db/src/drizzle/repositories/revenue-events.integration.test.ts
git commit -m "feat(db): add findRevenueEventById revenue-events repo fn"
```

---

## Task 3: Store-routing refund service

**Files:**
- Create: `apps/api/src/services/refunds/refund-transaction.ts`
- Test: `apps/api/src/services/refunds/refund-transaction.test.ts`

**Interfaces:**
- Consumes: `getStripeClient(secretKey)` from `services/stripe/stripe-webhook.ts`; `loadStripeCredentials(projectId)` / `loadGoogleCredentials(projectId)` from `lib/project-credentials.ts`; `getGoogleAccessToken(creds)` from `services/google/google-auth.ts`; `Purchase` type from `@rovenue/db`.
- Produces:
  ```typescript
  type RefundResult =
    | { ok: true; store: "stripe" | "play"; reference: string }
    | { ok: false; code: "apple_unsupported" | "already_refunded" | "missing_store_ref" | "store_error"; message: string };

  async function refundTransaction(input: {
    projectId: string;
    purchase: Pick<Purchase, "id" | "store" | "storeTransactionId" | "status">;
  }): Promise<RefundResult>;
  ```

- [ ] **Step 1: Write the failing tests** (mock the store clients)

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const refundsCreate = vi.fn();
vi.mock("../stripe/stripe-webhook", () => ({ getStripeClient: () => ({ refunds: { create: refundsCreate } }) }));
vi.mock("../../lib/project-credentials", () => ({
  loadStripeCredentials: vi.fn(async () => ({ secretKey: "sk_test", webhookSecret: "whsec" })),
  loadGoogleCredentials: vi.fn(async () => ({ packageName: "com.app", serviceAccount: { client_email: "a@b", private_key: "k" } })),
}));
const ordersRefund = vi.fn();
vi.mock("googleapis", () => ({ google: { androidpublisher: () => ({ orders: { refund: ordersRefund } }) } }));
vi.mock("../google/google-auth", () => ({ getGoogleAccessToken: vi.fn(async () => "tok") }));

import { refundTransaction } from "./refund-transaction";

beforeEach(() => { refundsCreate.mockReset(); ordersRefund.mockReset(); });

it("rejects Apple", async () => {
  const r = await refundTransaction({ projectId: "p", purchase: { id: "pu", store: "ios", storeTransactionId: "1000", status: "ACTIVE" } as any });
  expect(r).toEqual({ ok: false, code: "apple_unsupported", message: expect.any(String) });
});

it("rejects already-refunded", async () => {
  const r = await refundTransaction({ projectId: "p", purchase: { id: "pu", store: "stripe", storeTransactionId: "ch_1", status: "REFUNDED" } as any });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe("already_refunded");
});

it("refunds a Stripe charge", async () => {
  refundsCreate.mockResolvedValue({ id: "re_1" });
  const r = await refundTransaction({ projectId: "p", purchase: { id: "pu", store: "stripe", storeTransactionId: "ch_123", status: "ACTIVE" } as any });
  expect(refundsCreate).toHaveBeenCalledWith({ charge: "ch_123" }, { idempotencyKey: "refund_pu" });
  expect(r).toEqual({ ok: true, store: "stripe", reference: "re_1" });
});

it("uses payment_intent when ref starts with pi_", async () => {
  refundsCreate.mockResolvedValue({ id: "re_2" });
  await refundTransaction({ projectId: "p", purchase: { id: "pu", store: "stripe", storeTransactionId: "pi_9", status: "ACTIVE" } as any });
  expect(refundsCreate).toHaveBeenCalledWith({ payment_intent: "pi_9" }, { idempotencyKey: "refund_pu" });
});

it("refunds a Play order", async () => {
  ordersRefund.mockResolvedValue({});
  const r = await refundTransaction({ projectId: "p", purchase: { id: "pu", store: "play", storeTransactionId: "GPA.1", status: "ACTIVE" } as any });
  expect(ordersRefund).toHaveBeenCalledWith({ packageName: "com.app", orderId: "GPA.1", revoke: true });
  expect(r).toEqual({ ok: true, store: "play", reference: "GPA.1" });
});

it("maps store SDK errors to store_error", async () => {
  refundsCreate.mockRejectedValue(new Error("charge already refunded"));
  const r = await refundTransaction({ projectId: "p", purchase: { id: "pu", store: "stripe", storeTransactionId: "ch_x", status: "ACTIVE" } as any });
  expect(r.ok).toBe(false);
  if (!r.ok) { expect(r.code).toBe("store_error"); expect(r.message).toContain("already refunded"); }
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @rovenue/api test refund-transaction`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { google } from "googleapis";
import type { Purchase } from "@rovenue/db";
import { getStripeClient } from "../stripe/stripe-webhook";
import { loadStripeCredentials, loadGoogleCredentials } from "../../lib/project-credentials";
import { getGoogleAccessToken } from "../google/google-auth";

export type RefundResult =
  | { ok: true; store: "stripe" | "play"; reference: string }
  | { ok: false; code: "apple_unsupported" | "already_refunded" | "missing_store_ref" | "store_error"; message: string };

const TERMINAL = new Set(["REFUNDED", "REVOKED"]);

export async function refundTransaction(input: {
  projectId: string;
  purchase: Pick<Purchase, "id" | "store" | "storeTransactionId" | "status">;
}): Promise<RefundResult> {
  const { projectId, purchase } = input;
  if (purchase.store === "ios") {
    return { ok: false, code: "apple_unsupported", message: "Apple processes App Store refunds; no merchant-initiated refund is available." };
  }
  if (TERMINAL.has(String(purchase.status))) {
    return { ok: false, code: "already_refunded", message: "This transaction is already refunded or revoked." };
  }
  const ref = purchase.storeTransactionId;
  if (!ref) return { ok: false, code: "missing_store_ref", message: "No store transaction reference on this purchase." };

  try {
    if (purchase.store === "stripe") {
      const creds = await loadStripeCredentials(projectId);
      const client = getStripeClient(creds.secretKey);
      const params = ref.startsWith("pi_") ? { payment_intent: ref } : { charge: ref };
      const refund = await client.refunds.create(params, { idempotencyKey: `refund_${purchase.id}` });
      return { ok: true, store: "stripe", reference: refund.id };
    }
    if (purchase.store === "play") {
      const creds = await loadGoogleCredentials(projectId);
      const token = await getGoogleAccessToken(creds.serviceAccount);
      const publisher = google.androidpublisher({ version: "v3", headers: { Authorization: `Bearer ${token}` } });
      await publisher.orders.refund({ packageName: creds.packageName, orderId: ref, revoke: true });
      return { ok: true, store: "play", reference: ref };
    }
    return { ok: false, code: "missing_store_ref", message: `Refund unsupported for store "${purchase.store}".` };
  } catch (err) {
    return { ok: false, code: "store_error", message: err instanceof Error ? err.message : "Store refund failed." };
  }
}
```

> Note: confirm `getGoogleAccessToken` accepts the `serviceAccount` shape; if `loadGoogleCredentials` already returns a JWT-ready object, adjust the call to match its actual return type discovered in Task research.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @rovenue/api test refund-transaction`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/refunds/
git commit -m "feat(api): store-routing refundTransaction service (stripe + play)"
```

---

## Task 4: Refund endpoint + integration test

**Files:**
- Modify: `apps/api/src/routes/dashboard/transactions.ts`
- Test: `apps/api/src/routes/dashboard/transactions.refund.integration.test.ts`

**Interfaces:**
- Consumes: `findRevenueEventById` (Task 2), `refundTransaction` (Task 3), `assertProjectCapability`, `audit`, `extractRequestContext`, `ok`/`fail`, purchase repo `findPurchasesByIds`.
- Produces: `POST /dashboard/projects/:projectId/transactions/:id/refund` → `{ data: { status: "refund_requested", store, reference } }` on success; `{ error }` with status 409 (already_refunded), 422 (apple_unsupported / missing_store_ref), 502 (store_error), 404 (not found).

- [ ] **Step 1: Write the failing integration test**

Mirror `projects.integration.test.ts` setup (testcontainer Postgres, `createUserAndSession`, seed project + member + product + purchase + revenue_event). Mock `refundTransaction` via `vi.mock("../../services/refunds/refund-transaction", ...)`.

```typescript
it("refunds a stripe transaction → 200 refund_requested, audited", async () => {
  // seed purchase(store=stripe, storeTransactionId=ch_1, status=ACTIVE) + revenue_event(id=rev_1, purchaseId=pu_1)
  refundMock.mockResolvedValue({ ok: true, store: "stripe", reference: "re_1" });
  const res = await app.request(`/dashboard/projects/${projectId}/transactions/rev_1/refund`, {
    method: "POST", headers: authHeaders,
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data).toEqual({ status: "refund_requested", store: "stripe", reference: "re_1" });
  // assert an audit_logs row exists for resource "transaction", resourceId rev_1
});

it("apple → 422 apple_unsupported", async () => {
  refundMock.mockResolvedValue({ ok: false, code: "apple_unsupported", message: "..." });
  const res = await app.request(`/dashboard/projects/${projectId}/transactions/rev_ios/refund`, { method: "POST", headers: authHeaders });
  expect(res.status).toBe(422);
});

it("already refunded → 409", async () => {
  refundMock.mockResolvedValue({ ok: false, code: "already_refunded", message: "..." });
  const res = await app.request(`/dashboard/projects/${projectId}/transactions/rev_1/refund`, { method: "POST", headers: authHeaders });
  expect(res.status).toBe(409);
});

it("unknown id → 404", async () => {
  const res = await app.request(`/dashboard/projects/${projectId}/transactions/rev_nope/refund`, { method: "POST", headers: authHeaders });
  expect(res.status).toBe(404);
});

it("member without refunds:write → 403", async () => {
  const res = await app.request(`/dashboard/projects/${projectId}/transactions/rev_1/refund`, { method: "POST", headers: viewerHeaders });
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @rovenue/api test transactions.refund`
Expected: FAIL — route returns 404 for the success case (route not yet defined).

- [ ] **Step 3: Implement the route**

Add to `apps/api/src/routes/dashboard/transactions.ts` (follow the file's existing chained-route + middleware style):

```typescript
const STATUS_BY_CODE: Record<string, number> = {
  apple_unsupported: 422, missing_store_ref: 422, already_refunded: 409, store_error: 502,
};

// inside the routes chain:
.post("/:id/refund", async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  const user = c.get("user");
  await assertProjectCapability(projectId, user.id, "refunds:write");

  const event = await drizzle.revenueEventRepo.findRevenueEventById(drizzle.db, id);
  if (!event || event.projectId !== projectId) {
    return c.json(fail("NOT_FOUND", "Transaction not found."), 404);
  }
  const [purchase] = await drizzle.purchaseRepo.findPurchasesByIds(drizzle.db, [event.purchaseId]);
  if (!purchase) return c.json(fail("NOT_FOUND", "Purchase not found."), 404);

  const result = await refundTransaction({ projectId, purchase });
  if (!result.ok) {
    return c.json(fail(result.code.toUpperCase(), result.message), STATUS_BY_CODE[result.code] ?? 502);
  }

  const ctx = extractRequestContext(c);
  await audit({
    projectId, userId: user.id, action: "refund", resource: "transaction", resourceId: id,
    after: { store: result.store, reference: result.reference }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
  });
  return c.json(ok({ status: "refund_requested" as const, store: result.store, reference: result.reference }), 200);
})
```

If `"refund"` / `"transaction"` aren't valid `AuditAction` / `AuditResource` members, add them in `apps/api/src/lib/audit.ts` (extend the unions) and include that change in this task.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @rovenue/api test transactions.refund`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/transactions.ts apps/api/src/lib/audit.ts apps/api/src/routes/dashboard/transactions.refund.integration.test.ts
git commit -m "feat(api): POST transactions/:id/refund endpoint (store-integrated)"
```

---

## Task 5: Plumb full subscriber/purchase ids into the UI Transaction

**Files:**
- Modify: `apps/dashboard/src/components/transactions/types.ts`
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/transactions.tsx`

**Interfaces:**
- Produces: `Transaction.subscriberId: string` and `Transaction.purchaseId: string` (full, un-truncated) on every mapped transaction.

- [ ] **Step 1: Extend the type**

In `types.ts`, add to the `Transaction` type (keep existing `sub`/`user` display fields):

```typescript
  /** Full subscriber id (un-truncated) for navigation/actions. */
  subscriberId: string;
  /** Full purchase id (un-truncated) for navigation/actions. */
  purchaseId: string;
```

- [ ] **Step 2: Set them in the adapter**

In `transactions.tsx` `toUiTransaction`, add to the returned object:

```typescript
    subscriberId: row.subscriberId,
    purchaseId: row.purchaseId,
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/transactions/types.ts apps/dashboard/src/routes/_authed/projects/$projectId/transactions.tsx
git commit -m "feat(dashboard): carry full subscriber/purchase ids on UI Transaction"
```

---

## Task 6: Refund mutation hook

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useRefundTransaction.ts`

**Interfaces:**
- Consumes: `api`, `useMutation`, `useQueryClient`.
- Produces: `useRefundTransaction(projectId: string)` → mutation; `mutateAsync(transactionId: string)`; invalidates `["transactions", "list"]` on success.

- [ ] **Step 1: Implement**

```typescript
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

type RefundResponse = { status: "refund_requested"; store: "stripe" | "play"; reference: string };

export function useRefundTransaction(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (transactionId: string) =>
      api<RefundResponse>(
        `/dashboard/projects/${projectId}/transactions/${transactionId}/refund`,
        { method: "POST" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["transactions", "list"] }),
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useRefundTransaction.ts
git commit -m "feat(dashboard): useRefundTransaction mutation hook"
```

---

## Task 7: Refund confirm dialog

**Files:**
- Create: `apps/dashboard/src/components/transactions/refund-confirm-dialog.tsx`
- Modify: `apps/dashboard/src/i18n/locales/en.json`

**Interfaces:**
- Consumes: existing confirm-modal/dialog component used by the recent "confirm modal + trash icon for unlinking offerings" work (locate it: search `apps/dashboard/src/components/offerings` and `apps/dashboard/src/ui` for the Dialog primitive). Mirror its props.
- Produces: `<RefundConfirmDialog open tx onClose />` that calls `useRefundTransaction`, shows pending/error states inline (no toast — this app surfaces errors inline), and closes on success.

- [ ] **Step 1: Add i18n keys**

Under `transactions.inspector` in `en.json`:

```json
"refund": {
  "title": "Refund this transaction?",
  "body": "This sends a refund request to {{store}}. The transaction updates here once the store confirms.",
  "confirm": "Refund",
  "cancel": "Cancel",
  "pending": "Requesting refund…",
  "success": "Refund requested",
  "error": "Refund failed: {{message}}"
}
```

- [ ] **Step 2: Implement the dialog**

Build on the located Dialog primitive. Pseudocode-complete component:

```tsx
import { useTranslation } from "react-i18next";
import { useRefundTransaction } from "../../lib/hooks/useRefundTransaction";
import type { Transaction } from "./types";
import { Button } from "../../ui/button";
// import { Dialog } from "...located primitive...";

export function RefundConfirmDialog({ projectId, tx, open, onClose }: {
  projectId: string; tx: Transaction; open: boolean; onClose: () => void;
}) {
  const { t } = useTranslation();
  const refund = useRefundTransaction(projectId);
  const storeLabel = tx.store === "stripe" ? "Stripe" : "Google Play";

  async function confirm() {
    try { await refund.mutateAsync(tx.id); onClose(); } catch { /* error shown below */ }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("transactions.inspector.refund.title")}>
      <p>{t("transactions.inspector.refund.body", { store: storeLabel })}</p>
      {refund.error && (
        <div role="alert" className="text-sm text-rv-danger">
          {t("transactions.inspector.refund.error", { message: (refund.error as Error).message })}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="light" onClick={onClose} disabled={refund.isPending}>
          {t("transactions.inspector.refund.cancel")}
        </Button>
        <Button variant="danger" onClick={confirm} disabled={refund.isPending}>
          {refund.isPending ? t("transactions.inspector.refund.pending") : t("transactions.inspector.refund.confirm")}
        </Button>
      </div>
    </Dialog>
  );
}
```

Match the actual Dialog primitive's prop names (`open`/`onOpenChange` vs `onClose`) once located; adjust accordingly.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/transactions/refund-confirm-dialog.tsx apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): refund confirm dialog"
```

---

## Task 8: Transaction actions `...` menu

**Files:**
- Create: `apps/dashboard/src/components/transactions/transaction-actions-menu.tsx`
- Modify: `apps/dashboard/src/i18n/locales/en.json`

**Interfaces:**
- Consumes: Base UI `Menu` (mirror `offering-actions-menu.tsx`: `POPUP_CLASS`, `ITEM_CLASS`), `useNavigate` from `@tanstack/react-router`, `Transaction`.
- Produces: `<TransactionActionsMenu projectId tx />` with 4 items: Copy ID, Copy payload JSON, View subscriber, View subscription.

- [ ] **Step 1: Add i18n keys**

Under `transactions.inspector`:

```json
"menu": {
  "copyId": "Copy transaction ID",
  "copyPayload": "Copy payload JSON",
  "viewSubscriber": "View subscriber",
  "viewSubscription": "View subscription"
}
```

- [ ] **Step 2: Implement**

```tsx
import { Menu } from "@base-ui-components/react/menu";
import { useNavigate } from "@tanstack/react-router";
import { Copy, FileJson, MoreHorizontal, User, CreditCard } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { buttonVariants } from "../../ui/button";
import type { Transaction } from "./types";

const POPUP_CLASS = "min-w-[220px] rounded-lg border border-rv-divider-strong bg-rv-c3 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in";
const ITEM_CLASS = "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-mute-700 outline-none data-[highlighted]:bg-rv-c4 data-[highlighted]:text-foreground";

export function TransactionActionsMenu({ projectId, tx, payload }: {
  projectId: string; tx: Transaction; payload: unknown;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const copy = (text: string) => void navigator.clipboard?.writeText(text);

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(buttonVariants({ variant: "light", size: "icon" }))}
        aria-label={t("transactions.inspector.more")}
      >
        <MoreHorizontal size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-50">
          <Menu.Popup className={POPUP_CLASS}>
            <Menu.Item className={ITEM_CLASS} onClick={() => copy(tx.id)}>
              <Copy size={13} /><span className="flex-1">{t("transactions.inspector.menu.copyId")}</span>
            </Menu.Item>
            <Menu.Item className={ITEM_CLASS} onClick={() => copy(JSON.stringify(payload, null, 2))}>
              <FileJson size={13} /><span className="flex-1">{t("transactions.inspector.menu.copyPayload")}</span>
            </Menu.Item>
            <div className="my-1 h-px bg-rv-divider" />
            <Menu.Item
              className={ITEM_CLASS}
              onClick={() => navigate({ to: "/projects/$projectId/subscribers/$id", params: { projectId, id: tx.subscriberId } })}
            >
              <User size={13} /><span className="flex-1">{t("transactions.inspector.menu.viewSubscriber")}</span>
            </Menu.Item>
            <Menu.Item
              className={ITEM_CLASS}
              onClick={() => navigate({ to: "/projects/$projectId/subscribers/$id", params: { projectId, id: tx.subscriberId } })}
            >
              <CreditCard size={13} /><span className="flex-1">{t("transactions.inspector.menu.viewSubscription")}</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
```

> Per **D1**, "View subscription" routes to the subscriber detail page (no dedicated purchase route exists). If D1 resolves to "build a purchase detail page", change the `to`/`params` here and add that route in a follow-up task.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/transactions/transaction-actions-menu.tsx apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): transaction actions overflow menu"
```

---

## Task 9: Wire the inspector footer

**Files:**
- Modify: `apps/dashboard/src/components/transactions/transaction-inspector.tsx`

**Interfaces:**
- Consumes: `TransactionActionsMenu` (Task 8), `RefundConfirmDialog` (Task 7), `useState`. Needs `projectId` — add it to `Props`.

- [ ] **Step 1: Add projectId prop + state**

Update `Props` to `{ tx: Transaction; projectId: string }`. Add at the top of the component:

```tsx
const [refundOpen, setRefundOpen] = useState(false);
```

Import `useState`, `TransactionActionsMenu`, `RefundConfirmDialog`.

- [ ] **Step 2: Wire the footer**

Replace the footer block. The Refund button (already gated on `tx.store !== "ios"`) gets an onClick; Re-deliver stays visual-only per the chosen scope; the `...` is replaced by the menu:

```tsx
<div className="flex gap-1.5 px-3 py-3">
  {tx.store !== "ios" && (
    <Button variant="flat" size="sm" className="flex-1" onClick={() => setRefundOpen(true)}>
      <RotateCw size={13} />
      {t("transactions.inspector.footer.refund")}
    </Button>
  )}
  <Button variant="flat" size="sm" className="flex-1">
    <Webhook size={13} />
    {t("transactions.inspector.footer.redeliver")}
  </Button>
  <TransactionActionsMenu projectId={projectId} tx={tx} payload={payload} />
</div>
<RefundConfirmDialog projectId={projectId} tx={tx} open={refundOpen} onClose={() => setRefundOpen(false)} />
```

- [ ] **Step 3: Pass projectId at the render site**

In `transactions.tsx`, update `<TransactionInspector tx={selected} />` → `<TransactionInspector tx={selected} projectId={projectId} />` (the route already has `projectId` from `Route.useParams()` — confirm the variable name and use it).

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit && pnpm --filter @rovenue/dashboard build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/transactions/transaction-inspector.tsx apps/dashboard/src/routes/_authed/projects/$projectId/transactions.tsx
git commit -m "feat(dashboard): wire transaction inspector refund + actions menu"
```

---

## Task 10: Full verification

- [ ] **Step 1: API tests**

Run: `pnpm --filter @rovenue/api test`
Expected: refund unit + integration tests green; no new failures beyond the documented pre-existing red integrations.

- [ ] **Step 2: Dashboard typecheck + build**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit && pnpm --filter @rovenue/dashboard build`
Expected: PASS.

- [ ] **Step 3: Manual smoke (optional, via the `run`/`verify` skill)**

Open a transaction inspector; confirm: iOS rows have no Refund button; a Stripe/Play row's Refund opens the confirm dialog; the `...` menu copies id/payload and navigates to the subscriber.

---

## Self-Review Notes

- **Spec coverage:** Refund (Stripe+Play, Apple rejected) — Tasks 3,4,6,7,9. `...` menu 4 items — Task 8. Re-deliver intentionally left visual-only (user choice). iOS hidden — already done pre-plan.
- **Type consistency:** `refundTransaction` `RefundResult` codes match the endpoint `STATUS_BY_CODE` keys and the hook's success shape. `Transaction.subscriberId`/`purchaseId` added in Task 5 consumed in Tasks 8/9.
- **Known gap surfaced:** D1 (no subscription detail route) and D2 (async reconciliation) — both documented; defaults chosen, reversible.
</content>
</invoke>
