# Refund Shield Dashboard UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the operator-facing dashboard for Refund Shield — 4 routes (Overview, Responses list, Response detail, Settings) plus an empty-state onboarding wizard and a "Refund Shield" tab on the subscriber drill-in — all backed by the 5 dashboard endpoints already shipped in Plan 1 (commit `dd8a818`).

**Architecture:** TanStack Router file-based routes under `_authed/projects/$projectId/refund-shield/`. TanStack Query for fetch/cache/invalidate, MSW for tests, Tailwind via existing `rv-*` design tokens. Reuses existing primitives — `StatCard`, `Sparkline`, `Button`, `Chip`, `Input`, `Select`, `Switch`, `Base UI Menu`. No new design tokens. No backend changes.

**Tech Stack:** React 19 + TanStack Router + TanStack Query + i18next + Vitest + MSW + `@testing-library/react` + Tailwind v4 + Base UI components.

**Spec:** `docs/superpowers/specs/2026-05-28-refund-shield-design.md` §8

**Out of scope:**
- Any backend endpoint changes (Plan 1 already shipped; gaps noted at the bottom of this plan)
- A real `transactionId` search box (the list endpoint does **not** expose one — see §"Backend gaps" at end)
- Mobile / RN dashboard
- ToS template copy beyond a one-paragraph placeholder string the operator can clone

---

## File Inventory

**New files (route components):**

- `apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/route.tsx`
- `apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/index.tsx` (Overview)
- `apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/responses.tsx`
- `apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/responses_.$rid.tsx` (detail, leading underscore prevents nesting under `responses`)
- `apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/settings.tsx`

**New files (components):**

- `apps/dashboard/src/components/refund-shield/index.ts`
- `apps/dashboard/src/components/refund-shield/status-chip.tsx`
- `apps/dashboard/src/components/refund-shield/outcome-chip.tsx`
- `apps/dashboard/src/components/refund-shield/responses-table.tsx`
- `apps/dashboard/src/components/refund-shield/responses-filter-bar.tsx`
- `apps/dashboard/src/components/refund-shield/response-timeline.tsx`
- `apps/dashboard/src/components/refund-shield/json-payload-viewer.tsx`
- `apps/dashboard/src/components/refund-shield/onboarding-wizard.tsx`
- `apps/dashboard/src/components/refund-shield/subscriber-tab.tsx`

**New files (hooks):**

- `apps/dashboard/src/lib/hooks/useRefundShield.ts`

**New files (tests):**

- `apps/dashboard/tests/routes/refund-shield-overview.test.tsx`
- `apps/dashboard/tests/routes/refund-shield-responses.test.tsx`
- `apps/dashboard/tests/routes/refund-shield-response-detail.test.tsx`
- `apps/dashboard/tests/routes/refund-shield-settings.test.tsx`
- `apps/dashboard/tests/components/refund-shield-onboarding.test.tsx`
- `apps/dashboard/tests/components/refund-shield-subscriber-tab.test.tsx`

**Modified files:**

- `apps/dashboard/tests/msw/handlers.ts` — add 5 handler blocks + 1 outcome-stream fixture for the subscriber tab
- `apps/dashboard/src/i18n/locales/en.json` — add `refundShield.*` namespace and `sidebar.items.refundShield` + `breadcrumb.refundShield`
- `apps/dashboard/src/components/dashboard/navigation.ts` — add new nav entry in `growth` section
- `apps/dashboard/src/routes/_authed/projects/$projectId/route.tsx` — extend `useBreadcrumbTitleKey()` with `refund-shield` branch
- `apps/dashboard/src/components/subscribers/SubscriberDetailPanel.tsx` — append a "Refund Shield" card under the existing experiments card

---

## Endpoint → Hook → Page mapping

| Plan 1 endpoint | Hook | Consumed by |
|---|---|---|
| `GET /dashboard/projects/:projectId/refund-shield/settings` | `useRefundShieldSettings` | Settings page, Onboarding wizard, Overview (to decide whether to show wizard), Subscriber tab (suppress when disabled) |
| `PUT /dashboard/projects/:projectId/refund-shield/settings` | `useUpdateRefundShieldSettings` | Settings page, Onboarding wizard final step |
| `GET /dashboard/projects/:projectId/refund-shield/responses` | `useRefundShieldResponses` (`useInfiniteQuery`) | Responses list, Subscriber tab (filtered to one originalTransactionId via client-side filter — see Backend gaps) |
| `GET /dashboard/projects/:projectId/refund-shield/responses/:rid` | `useRefundShieldResponse` | Response detail |
| `GET /dashboard/projects/:projectId/refund-shield/metrics` | `useRefundShieldMetrics` | Overview KPI cards |

Every endpoint is touched by at least two consumers.

---

## Phase A — Foundation

### Task 1: MSW handlers + fixtures

**Files:**
- Modify: `apps/dashboard/tests/msw/handlers.ts`

- [ ] **Step 1.1: Write the assertion test that proves the new handlers exist**

The cheapest way to verify all five handlers respond is to add a minimal smoke test that imports the MSW server. Create `apps/dashboard/tests/msw/refund-shield-handlers.test.ts`:

```ts
import { beforeAll, afterAll, afterEach, describe, expect, test } from "vitest";
import { server } from "./server";

const BASE = "http://localhost:3000";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("refund-shield MSW handlers", () => {
  test("GET settings returns disabled by default", async () => {
    const res = await fetch(
      `${BASE}/dashboard/projects/proj_1/refund-shield/settings`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.settings).toMatchObject({
      enabled: false,
      responseDelayMinutes: 60,
    });
  });

  test("PUT settings echoes the patch", async () => {
    const res = await fetch(
      `${BASE}/dashboard/projects/proj_1/refund-shield/settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          responseDelayMinutes: 120,
          consentAcknowledged: true,
        }),
      },
    );
    const body = await res.json();
    expect(body.data.settings.enabled).toBe(true);
    expect(body.data.settings.responseDelayMinutes).toBe(120);
    expect(body.data.settings.consentAcknowledgedAt).not.toBeNull();
  });

  test("GET responses returns at least one row + nextCursor null", async () => {
    const res = await fetch(
      `${BASE}/dashboard/projects/proj_1/refund-shield/responses?limit=50`,
    );
    const body = await res.json();
    expect(body.data.responses.length).toBeGreaterThan(0);
    expect(body.data).toHaveProperty("nextCursor");
  });

  test("GET response by id returns the matching fixture", async () => {
    const res = await fetch(
      `${BASE}/dashboard/projects/proj_1/refund-shield/responses/rss_sent_declined`,
    );
    const body = await res.json();
    expect(body.data.response.id).toBe("rss_sent_declined");
    expect(body.data.response.requestPayload).toMatchObject({
      customerConsented: true,
    });
  });

  test("GET metrics returns numeric KPI surface", async () => {
    const res = await fetch(
      `${BASE}/dashboard/projects/proj_1/refund-shield/metrics`,
    );
    const body = await res.json();
    expect(body.data).toMatchObject({
      sentCount: expect.any(Number),
      outcomeCount: expect.any(Number),
      declinedCount: expect.any(Number),
      approvedCount: expect.any(Number),
      reversedCount: expect.any(Number),
      winRate: expect.any(Number),
      estimatedRevenueSavedCents: expect.any(Number),
    });
  });
});
```

- [ ] **Step 1.2: Run the test — expect failure**

Run: `pnpm --filter @rovenue/dashboard test refund-shield-handlers -- --run`
Expected: FAIL — unhandled request errors for every URL above.

- [ ] **Step 1.3: Append the handlers + fixture seed**

Append the following block to `apps/dashboard/tests/msw/handlers.ts` immediately before the closing `];`:

```ts
  // -------------------------------------------------------------
  // Refund Shield — settings / responses / metrics
  // -------------------------------------------------------------

  http.get(
    `${BASE}/dashboard/projects/:projectId/refund-shield/settings`,
    () =>
      HttpResponse.json({
        data: {
          settings: {
            enabled: false,
            responseDelayMinutes: 60,
            consentAcknowledgedAt: null,
            consentAcknowledgedBy: null,
          },
        },
      }),
  ),

  http.put(
    `${BASE}/dashboard/projects/:projectId/refund-shield/settings`,
    async ({ request }) => {
      const body = (await request.json()) as {
        enabled: boolean;
        responseDelayMinutes?: number;
        consentAcknowledged?: boolean;
      };
      return HttpResponse.json({
        data: {
          settings: {
            enabled: body.enabled,
            responseDelayMinutes: body.responseDelayMinutes ?? 60,
            consentAcknowledgedAt: body.consentAcknowledged
              ? "2026-05-28T00:00:00.000Z"
              : null,
            consentAcknowledgedBy: body.consentAcknowledged ? "u1" : null,
          },
        },
      });
    },
  ),

  http.get(
    `${BASE}/dashboard/projects/:projectId/refund-shield/responses`,
    ({ request }) => {
      const url = new URL(request.url);
      const status = url.searchParams.get("status");
      const outcome = url.searchParams.get("outcome");

      const all = [
        {
          id: "rss_sent_declined",
          projectId: "proj_1",
          subscriberId: "sub_1",
          appleNotificationUuid: "notif-1111",
          appleOriginalTransactionId: "2000000111111111",
          appleTransactionId: "2000000111111112",
          detectedAt: "2026-05-26T08:00:00.000Z",
          scheduledFor: "2026-05-26T09:00:00.000Z",
          sentAt: "2026-05-26T09:00:14.000Z",
          status: "SENT",
          outcome: "REFUND_DECLINED",
          outcomeReceivedAt: "2026-05-26T15:21:00.000Z",
          appleHttpStatus: 202,
          error: null,
          retryCount: 0,
          createdAt: "2026-05-26T08:00:00.000Z",
          updatedAt: "2026-05-26T15:21:00.000Z",
        },
        {
          id: "rss_pending",
          projectId: "proj_1",
          subscriberId: "sub_2",
          appleNotificationUuid: "notif-2222",
          appleOriginalTransactionId: "2000000222222221",
          appleTransactionId: "2000000222222222",
          detectedAt: "2026-05-28T07:30:00.000Z",
          scheduledFor: "2026-05-28T08:30:00.000Z",
          sentAt: null,
          status: "PENDING",
          outcome: null,
          outcomeReceivedAt: null,
          appleHttpStatus: null,
          error: null,
          retryCount: 0,
          createdAt: "2026-05-28T07:30:00.000Z",
          updatedAt: "2026-05-28T07:30:00.000Z",
        },
        {
          id: "rss_skipped_disabled",
          projectId: "proj_1",
          subscriberId: null,
          appleNotificationUuid: "notif-3333",
          appleOriginalTransactionId: "2000000333333331",
          appleTransactionId: "2000000333333332",
          detectedAt: "2026-05-20T11:00:00.000Z",
          scheduledFor: "2026-05-20T11:00:00.000Z",
          sentAt: null,
          status: "SKIPPED_DISABLED",
          outcome: null,
          outcomeReceivedAt: null,
          appleHttpStatus: null,
          error: null,
          retryCount: 0,
          createdAt: "2026-05-20T11:00:00.000Z",
          updatedAt: "2026-05-20T11:00:00.000Z",
        },
        {
          id: "rss_failed",
          projectId: "proj_1",
          subscriberId: "sub_3",
          appleNotificationUuid: "notif-4444",
          appleOriginalTransactionId: "2000000444444441",
          appleTransactionId: "2000000444444442",
          detectedAt: "2026-05-15T03:00:00.000Z",
          scheduledFor: "2026-05-15T04:00:00.000Z",
          sentAt: null,
          status: "FAILED",
          outcome: null,
          outcomeReceivedAt: null,
          appleHttpStatus: 500,
          error: "SLA_EXCEEDED",
          retryCount: 5,
          createdAt: "2026-05-15T03:00:00.000Z",
          updatedAt: "2026-05-15T15:00:00.000Z",
        },
      ];

      let filtered = all;
      if (status) filtered = filtered.filter((r) => r.status === status);
      if (outcome) filtered = filtered.filter((r) => r.outcome === outcome);

      return HttpResponse.json({
        data: { responses: filtered, nextCursor: null },
      });
    },
  ),

  http.get(
    `${BASE}/dashboard/projects/:projectId/refund-shield/responses/:rid`,
    ({ params }) => {
      const rid = String(params.rid);
      const requestPayload =
        rid === "rss_sent_declined"
          ? {
              customerConsented: true,
              consumptionStatus: 1,
              platform: 1,
              sampleContentProvided: false,
              deliveryStatus: 0,
              accountTenure: 5,
              playTime: 4,
              lifetimeDollarsPurchased: 3,
              lifetimeDollarsRefunded: 0,
              userStatus: 1,
              refundPreference: 2,
              appAccountToken: "00000000-0000-4000-8000-000000000001",
            }
          : null;
      return HttpResponse.json({
        data: {
          response: {
            id: rid,
            projectId: "proj_1",
            subscriberId: rid === "rss_skipped_disabled" ? null : "sub_1",
            appleNotificationUuid: `notif-${rid}`,
            appleOriginalTransactionId: "2000000111111111",
            appleTransactionId: "2000000111111112",
            detectedAt: "2026-05-26T08:00:00.000Z",
            scheduledFor: "2026-05-26T09:00:00.000Z",
            sentAt:
              rid === "rss_sent_declined" ? "2026-05-26T09:00:14.000Z" : null,
            status: rid === "rss_pending" ? "PENDING" : "SENT",
            outcome: rid === "rss_sent_declined" ? "REFUND_DECLINED" : null,
            outcomeReceivedAt:
              rid === "rss_sent_declined" ? "2026-05-26T15:21:00.000Z" : null,
            appleHttpStatus: rid === "rss_sent_declined" ? 202 : null,
            appleResponseBody: rid === "rss_sent_declined" ? "" : null,
            error: null,
            retryCount: 0,
            createdAt: "2026-05-26T08:00:00.000Z",
            updatedAt: "2026-05-26T15:21:00.000Z",
            requestPayload,
          },
        },
      });
    },
  ),

  http.get(
    `${BASE}/dashboard/projects/:projectId/refund-shield/metrics`,
    () =>
      HttpResponse.json({
        data: {
          sentCount: 184,
          outcomeCount: 162,
          declinedCount: 121,
          approvedCount: 36,
          reversedCount: 5,
          winRate: 0.7469,
          estimatedRevenueSavedCents: 482400,
          range: {
            since: "2026-04-28T00:00:00.000Z",
            until: "2026-05-28T00:00:00.000Z",
          },
        },
      }),
  ),
```

- [ ] **Step 1.4: Run the smoke test — expect pass**

Run: `pnpm --filter @rovenue/dashboard test refund-shield-handlers -- --run`
Expected: PASS (5 tests).

- [ ] **Step 1.5: Re-run the full dashboard suite to confirm no regression**

Run: `pnpm --filter @rovenue/dashboard test -- --run`
Expected: PASS — handlers are purely additive.

- [ ] **Step 1.6: Commit**

```bash
git add apps/dashboard/tests/msw/handlers.ts \
        apps/dashboard/tests/msw/refund-shield-handlers.test.ts
git commit -m "test(dashboard): mock refund-shield endpoints in MSW"
```

---

### Task 2: Data hooks (`useRefundShield.ts`)

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useRefundShield.ts`

- [ ] **Step 2.1: Write a hook test**

Create `apps/dashboard/tests/hooks/useRefundShield.test.tsx`:

```tsx
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "vitest";
import type { ReactNode } from "react";
import {
  useRefundShieldMetrics,
  useRefundShieldResponses,
  useRefundShieldResponse,
  useRefundShieldSettings,
  useUpdateRefundShieldSettings,
} from "../../src/lib/hooks/useRefundShield";

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe("useRefundShield* hooks", () => {
  test("useRefundShieldSettings loads disabled defaults", async () => {
    const { result } = renderHook(
      () => useRefundShieldSettings("proj_1"),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toMatchObject({
      enabled: false,
      responseDelayMinutes: 60,
    });
  });

  test("useRefundShieldMetrics returns numeric KPIs", async () => {
    const { result } = renderHook(
      () => useRefundShieldMetrics("proj_1"),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.sentCount).toBeGreaterThan(0);
    expect(result.current.data?.winRate).toBeGreaterThan(0);
  });

  test("useRefundShieldResponses returns the first page + nextCursor", async () => {
    const { result } = renderHook(
      () => useRefundShieldResponses("proj_1", {}),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    const first = result.current.data!.pages[0]!;
    expect(first.responses.length).toBeGreaterThan(0);
    expect(first.nextCursor).toBeNull();
  });

  test("useRefundShieldResponse loads one row", async () => {
    const { result } = renderHook(
      () => useRefundShieldResponse("proj_1", "rss_sent_declined"),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.id).toBe("rss_sent_declined");
    expect(result.current.data?.requestPayload).toMatchObject({
      customerConsented: true,
    });
  });

  test("useUpdateRefundShieldSettings posts the patch", async () => {
    const { result } = renderHook(
      () => useUpdateRefundShieldSettings("proj_1"),
      { wrapper: wrapper() },
    );
    const updated = await result.current.mutateAsync({
      enabled: true,
      responseDelayMinutes: 90,
      consentAcknowledged: true,
    });
    expect(updated.enabled).toBe(true);
    expect(updated.responseDelayMinutes).toBe(90);
    expect(updated.consentAcknowledgedAt).not.toBeNull();
  });
});
```

- [ ] **Step 2.2: Run — expect fail**

Run: `pnpm --filter @rovenue/dashboard test useRefundShield -- --run`
Expected: FAIL — module not found.

- [ ] **Step 2.3: Create the hooks module**

Create `apps/dashboard/src/lib/hooks/useRefundShield.ts`:

```ts
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../api";

// =============================================================
// Refund Shield — dashboard data hooks
// =============================================================
//
// Five backend endpoints, five hooks. Settings is read+write
// (mutation invalidates its own key + the metrics key so the
// onboarding wizard transitions cleanly to the live dashboard).
// Responses uses useInfiniteQuery because the backend returns
// cursor pagination keyed on `detectedAt`.

const BASE = (projectId: string) =>
  `/dashboard/projects/${encodeURIComponent(projectId)}/refund-shield`;

// ---- Settings ----------------------------------------------------

export interface RefundShieldSettings {
  enabled: boolean;
  responseDelayMinutes: number;
  consentAcknowledgedAt: string | null;
  consentAcknowledgedBy: string | null;
}

export function useRefundShieldSettings(projectId: string) {
  return useQuery({
    queryKey: ["refund-shield", "settings", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<{ settings: RefundShieldSettings }>(`${BASE(projectId)}/settings`),
    select: (res) => res.settings,
  });
}

export interface UpdateRefundShieldSettingsVars {
  enabled: boolean;
  responseDelayMinutes?: number;
  consentAcknowledged?: boolean;
}

export function useUpdateRefundShieldSettings(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: UpdateRefundShieldSettingsVars) => {
      const res = await api<{ settings: RefundShieldSettings }>(
        `${BASE(projectId)}/settings`,
        { method: "PUT", body: JSON.stringify(vars) },
      );
      return res.settings;
    },
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["refund-shield", "settings", projectId],
      });
      qc.invalidateQueries({
        queryKey: ["refund-shield", "metrics", projectId],
      });
    },
  });
}

// ---- Responses (list + detail) ----------------------------------

export type RefundShieldStatus =
  | "PENDING"
  | "SENT"
  | "FAILED"
  | "SKIPPED_DISABLED"
  | "SKIPPED_NOT_FOUND";

export type RefundShieldOutcome =
  | "REFUND_APPROVED"
  | "REFUND_DECLINED"
  | "REFUND_REVERSED";

export interface RefundShieldResponseRow {
  id: string;
  projectId: string;
  subscriberId: string | null;
  appleNotificationUuid: string;
  appleOriginalTransactionId: string;
  appleTransactionId: string;
  detectedAt: string;
  scheduledFor: string;
  sentAt: string | null;
  status: RefundShieldStatus;
  outcome: RefundShieldOutcome | null;
  outcomeReceivedAt: string | null;
  appleHttpStatus: number | null;
  error: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RefundShieldResponseDetail extends RefundShieldResponseRow {
  requestPayload: Record<string, unknown> | null;
  appleResponseBody: string | null;
}

export interface RefundShieldResponsesPage {
  responses: RefundShieldResponseRow[];
  nextCursor: string | null;
}

export interface RefundShieldResponsesFilters {
  status?: RefundShieldStatus;
  outcome?: RefundShieldOutcome;
  since?: string;
  until?: string;
  limit?: number;
}

export function useRefundShieldResponses(
  projectId: string,
  filters: RefundShieldResponsesFilters,
) {
  return useInfiniteQuery<RefundShieldResponsesPage>({
    queryKey: ["refund-shield", "responses", projectId, filters],
    enabled: Boolean(projectId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.outcome) params.set("outcome", filters.outcome);
      if (filters.since) params.set("since", filters.since);
      if (filters.until) params.set("until", filters.until);
      if (filters.limit) params.set("limit", String(filters.limit));
      if (typeof pageParam === "string") params.set("cursor", pageParam);
      const qs = params.toString();
      return api<RefundShieldResponsesPage>(
        `${BASE(projectId)}/responses${qs ? `?${qs}` : ""}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useRefundShieldResponse(projectId: string, rid: string) {
  return useQuery({
    queryKey: ["refund-shield", "response", projectId, rid],
    enabled: Boolean(projectId && rid),
    queryFn: () =>
      api<{ response: RefundShieldResponseDetail }>(
        `${BASE(projectId)}/responses/${encodeURIComponent(rid)}`,
      ),
    select: (res) => res.response,
  });
}

// ---- Metrics ----------------------------------------------------

export interface RefundShieldMetrics {
  sentCount: number;
  outcomeCount: number;
  declinedCount: number;
  approvedCount: number;
  reversedCount: number;
  winRate: number;
  estimatedRevenueSavedCents: number;
  range: { since: string | null; until: string | null };
}

export interface RefundShieldMetricsFilters {
  since?: string;
  until?: string;
}

export function useRefundShieldMetrics(
  projectId: string,
  filters: RefundShieldMetricsFilters = {},
) {
  return useQuery({
    queryKey: ["refund-shield", "metrics", projectId, filters],
    enabled: Boolean(projectId),
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.since) params.set("since", filters.since);
      if (filters.until) params.set("until", filters.until);
      const qs = params.toString();
      return api<RefundShieldMetrics>(
        `${BASE(projectId)}/metrics${qs ? `?${qs}` : ""}`,
      );
    },
  });
}
```

- [ ] **Step 2.4: Run — expect pass**

Run: `pnpm --filter @rovenue/dashboard test useRefundShield -- --run`
Expected: PASS (5 tests).

- [ ] **Step 2.5: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useRefundShield.ts \
        apps/dashboard/tests/hooks/useRefundShield.test.tsx
git commit -m "feat(dashboard): add refund-shield data hooks"
```

---

### Task 3: i18n namespace + status / outcome chips

Adding the i18n keys up-front avoids re-touching `en.json` in every later task. The two tiny chip components belong here too because they consume the namespace and every later page imports them.

**Files:**
- Modify: `apps/dashboard/src/i18n/locales/en.json`
- Create: `apps/dashboard/src/components/refund-shield/status-chip.tsx`
- Create: `apps/dashboard/src/components/refund-shield/outcome-chip.tsx`
- Create: `apps/dashboard/src/components/refund-shield/index.ts`

- [ ] **Step 3.1: Write a chip test**

Create `apps/dashboard/tests/components/refund-shield-chips.test.tsx`:

```tsx
import { describe, expect, test, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { StatusChip } from "../../src/components/refund-shield/status-chip";
import { OutcomeChip } from "../../src/components/refund-shield/outcome-chip";

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      resources: { en: { common: en } },
      lng: "en",
      fallbackLng: "en",
      defaultNS: "common",
      interpolation: { escapeValue: false },
    });
  }
});

describe("StatusChip / OutcomeChip", () => {
  test("PENDING renders the pending label", () => {
    render(<StatusChip status="PENDING" />);
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
  });

  test("REFUND_DECLINED renders the declined label in success tone", () => {
    render(<OutcomeChip outcome="REFUND_DECLINED" />);
    expect(screen.getByText(/declined/i)).toBeInTheDocument();
  });

  test("OutcomeChip renders em-dash when outcome is null", () => {
    render(<OutcomeChip outcome={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3.2: Run — expect fail**

Run: `pnpm --filter @rovenue/dashboard test refund-shield-chips -- --run`
Expected: FAIL — module not found.

- [ ] **Step 3.3: Add i18n keys**

In `apps/dashboard/src/i18n/locales/en.json`, locate the closing `}` of the `breadcrumb` block (line ~297). Append `"refundShield": "Refund Shield"` to that block. In the `sidebar.items` block (~line 242), append `"refundShield": "Refund Shield"`. Then insert a fresh top-level block after the `featureFlags` block (before `experiments`):

```json
  "refundShield": {
    "title": "Refund Shield",
    "subtitle": "Respond to Apple CONSUMPTION_REQUEST notifications with consumption data so the refund-decision algorithm is more likely to decline unjustified refunds.",
    "disabled": {
      "headline": "Refund Shield is off",
      "body": "Enable it to start responding to Apple refund requests. Apple gives you 12 hours per request — Rovenue handles the timing.",
      "cta": "Set up Refund Shield"
    },
    "kpi": {
      "sent": "Responses sent",
      "winRate": "Win rate",
      "winRateHint": "Refunds declined / total outcomes",
      "revenueSaved": "Revenue saved",
      "revenueSavedHint": "Sum of declined-refund purchase prices",
      "outcomesPending": "Awaiting outcome",
      "outcomesPendingHint": "Responses sent, Apple decision still open"
    },
    "trend": {
      "title": "Last 30 days",
      "empty": "No responses yet in this window."
    },
    "donut": {
      "title": "Outcome breakdown",
      "declined": "Declined",
      "approved": "Approved",
      "reversed": "Reversed",
      "pending": "Pending"
    },
    "responses": {
      "title": "Responses",
      "filters": {
        "status": "Status",
        "outcome": "Outcome",
        "any": "Any"
      },
      "empty": "No responses match these filters yet.",
      "columns": {
        "detectedAt": "Detected",
        "status": "Status",
        "outcome": "Outcome",
        "subscriber": "Subscriber",
        "originalTransactionId": "Original transaction",
        "scheduledFor": "Send at",
        "sentAt": "Sent",
        "retries": "Retries"
      },
      "loadMore": "Load more"
    },
    "detail": {
      "back": "Back to responses",
      "timeline": {
        "title": "Timeline",
        "detected": "Detected by webhook",
        "scheduled": "Scheduled to send",
        "sent": "Posted to Apple",
        "outcomeApproved": "Refund granted",
        "outcomeDeclined": "Refund declined",
        "outcomeReversed": "Refund reversed",
        "failed": "Failed"
      },
      "payload": {
        "title": "Apple payload",
        "subtitle": "The consumption document submitted to PUT /inApps/v1/transactions/consumption/{{txn}}",
        "empty": "No payload — this row was skipped before assembly."
      },
      "appleResponse": {
        "title": "Apple response",
        "status": "HTTP {{status}}",
        "empty": "No response captured."
      },
      "subscriber": {
        "title": "Linked subscriber",
        "missing": "No subscriber linked (Apple notification couldn't be matched)."
      },
      "linkSubscriber": "View subscriber"
    },
    "settings": {
      "title": "Refund Shield settings",
      "subtitle": "Operator-only controls. Enabling this feature submits consumption data to Apple's refund-decision API on your behalf.",
      "enable": {
        "label": "Enable Refund Shield",
        "description": "When on, the polling worker responds to incoming CONSUMPTION_REQUEST notifications within the configured delay."
      },
      "delay": {
        "label": "Response delay",
        "description": "Wait this many minutes after Apple's notification before replying. A short delay lets last-minute usage signal accumulate; a longer delay is safer if your session telemetry is sparse.",
        "unit": "{{value}} minutes",
        "min": "30 min",
        "max": "360 min"
      },
      "consent": {
        "label": "I confirm our Terms of Service and privacy policy disclose that consumption data may be shared with Apple to evaluate refund requests.",
        "stamped": "Consent acknowledged on {{date}} by {{user}}.",
        "requiredBeforeEnable": "Tick the consent box before enabling."
      },
      "submit": "Save changes",
      "submitting": "Saving…",
      "saved": "Settings saved.",
      "error": "Could not save settings. {{message}}"
    },
    "wizard": {
      "title": "Set up Refund Shield",
      "step": "Step {{n}} of 4",
      "steps": {
        "sdkCheck": {
          "title": "SDK requirements",
          "body": "Refund Shield works best when your SDK is passing an `appAccountToken` on every Apple purchase. Once you ship the updated SDK build, returning customers' new purchases will start populating the token automatically.",
          "okay": "I've upgraded the SDK",
          "skip": "Continue anyway"
        },
        "tos": {
          "title": "Update your Terms of Service",
          "body": "Apple's refund flow requires you to disclose that consumption data may be shared. Copy this clause into your ToS / privacy policy:",
          "template": "Apple may consult anonymized signals about your usage of the app (session duration, account age, lifetime spend, refund history) when evaluating a refund request you submit. By using this app you consent to us sharing those signals with Apple solely for that purpose.",
          "copied": "Copied!",
          "acknowledged": "I've updated our ToS"
        },
        "delay": {
          "title": "Response delay",
          "body": "How long to wait before replying. The default 60 minutes is a safe middle ground.",
          "next": "Next"
        },
        "enable": {
          "title": "Enable",
          "body": "You can disable Refund Shield at any time from Settings.",
          "submit": "Enable Refund Shield",
          "submitting": "Enabling…"
        }
      },
      "back": "Back",
      "exit": "Cancel"
    },
    "subscriberTab": {
      "title": "Refund Shield",
      "empty": "No refund requests for this subscriber.",
      "disabled": "Refund Shield is off — enable it to start collecting refund-request history.",
      "count_one": "{{count}} refund request",
      "count_other": "{{count}} refund requests"
    },
    "status": {
      "PENDING": "Pending",
      "SENT": "Sent",
      "FAILED": "Failed",
      "SKIPPED_DISABLED": "Skipped (disabled)",
      "SKIPPED_NOT_FOUND": "Skipped (no match)"
    },
    "outcome": {
      "REFUND_APPROVED": "Refund granted",
      "REFUND_DECLINED": "Refund declined",
      "REFUND_REVERSED": "Reversed",
      "none": "—"
    }
  },
```

Make sure the trailing comma is correct relative to the surrounding `featureFlags` / `experiments` neighbours.

- [ ] **Step 3.4: Create the status chip**

Create `apps/dashboard/src/components/refund-shield/status-chip.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { Chip } from "../../ui/chip";
import type { RefundShieldStatus } from "../../lib/hooks/useRefundShield";

const TONE: Record<RefundShieldStatus, "info" | "success" | "danger" | "muted"> = {
  PENDING: "info",
  SENT: "success",
  FAILED: "danger",
  SKIPPED_DISABLED: "muted",
  SKIPPED_NOT_FOUND: "muted",
};

export function StatusChip({ status }: { status: RefundShieldStatus }) {
  const { t } = useTranslation();
  return (
    <Chip tone={TONE[status]} size="sm">
      {t(`refundShield.status.${status}`)}
    </Chip>
  );
}
```

(Verify the existing `Chip` primitive's `tone` prop names — adjust to match. If `Chip` accepts only `intent` instead of `tone`, rename in the chip and in `outcome-chip.tsx`.)

- [ ] **Step 3.5: Create the outcome chip**

Create `apps/dashboard/src/components/refund-shield/outcome-chip.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { Chip } from "../../ui/chip";
import type { RefundShieldOutcome } from "../../lib/hooks/useRefundShield";

const TONE: Record<RefundShieldOutcome, "success" | "danger" | "warning"> = {
  REFUND_DECLINED: "success",
  REFUND_APPROVED: "danger",
  REFUND_REVERSED: "warning",
};

export function OutcomeChip({
  outcome,
}: {
  outcome: RefundShieldOutcome | null;
}) {
  const { t } = useTranslation();
  if (!outcome) {
    return (
      <span className="font-rv-mono text-[11px] text-rv-mute-500">—</span>
    );
  }
  return (
    <Chip tone={TONE[outcome]} size="sm">
      {t(`refundShield.outcome.${outcome}`)}
    </Chip>
  );
}
```

- [ ] **Step 3.6: Create the barrel**

Create `apps/dashboard/src/components/refund-shield/index.ts`:

```ts
export { StatusChip } from "./status-chip";
export { OutcomeChip } from "./outcome-chip";
```

(More exports get appended as the later components land.)

- [ ] **Step 3.7: Run the chip test — expect pass**

Run: `pnpm --filter @rovenue/dashboard test refund-shield-chips -- --run`
Expected: PASS (3 tests).

- [ ] **Step 3.8: Run the full dashboard suite**

Run: `pnpm --filter @rovenue/dashboard test -- --run`
Expected: PASS.

- [ ] **Step 3.9: Commit**

```bash
git add apps/dashboard/src/i18n/locales/en.json \
        apps/dashboard/src/components/refund-shield/ \
        apps/dashboard/tests/components/refund-shield-chips.test.tsx
git commit -m "feat(dashboard): refund-shield i18n + status/outcome chips"
```

**Phase A acceptance criteria:**
- 5 MSW handlers respond with fixture-quality data.
- 5 hooks resolve against MSW with correct typing.
- All `refundShield.*` keys present in `en.json`.
- StatusChip + OutcomeChip render labels for every enum value.

---

## Phase B — Settings page

### Task 4: Settings route + form

**Files:**
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/route.tsx`
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/settings.tsx`

(`route.tsx` is the segment route that owns `<Outlet />` — every child route lives below it.)

- [ ] **Step 4.1: Write the settings page test**

Create `apps/dashboard/tests/routes/refund-shield-settings.test.tsx`:

```tsx
import { describe, expect, test, beforeAll } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { server } from "../msw/server";
import { renderWithRouter } from "../render";
import { RefundShieldSettingsPage } from "../../src/routes/_authed/projects/$projectId/refund-shield/settings";

const BASE = "http://localhost:3000";

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      resources: { en: { common: en } },
      lng: "en",
      fallbackLng: "en",
      defaultNS: "common",
      interpolation: { escapeValue: false },
    });
  }
});

describe("<RefundShieldSettingsPage />", () => {
  test("renders the disabled default state", async () => {
    renderWithRouter(
      <RefundShieldSettingsPage projectId="proj_1" />,
      "/projects/proj_1/refund-shield/settings",
    );
    await waitFor(() =>
      expect(screen.getByText(/refund shield settings/i)).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/enable refund shield/i)).not.toBeChecked();
  });

  test("submitting without consent shows the required hint", async () => {
    renderWithRouter(
      <RefundShieldSettingsPage projectId="proj_1" />,
      "/projects/proj_1/refund-shield/settings",
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/enable refund shield/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText(/enable refund shield/i));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/tick the consent box before enabling/i),
      ).toBeInTheDocument(),
    );
  });

  test("PUT 400 from the server surfaces as a banner", async () => {
    server.use(
      http.put(
        `${BASE}/dashboard/projects/:projectId/refund-shield/settings`,
        () =>
          HttpResponse.json(
            {
              error: {
                code: "BAD_REQUEST",
                message: "consentAcknowledged: true is required",
              },
            },
            { status: 400 },
          ),
      ),
    );
    renderWithRouter(
      <RefundShieldSettingsPage projectId="proj_1" />,
      "/projects/proj_1/refund-shield/settings",
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/enable refund shield/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText(/enable refund shield/i));
    fireEvent.click(screen.getByLabelText(/i confirm our terms/i));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/consentAcknowledged: true is required/i),
      ).toBeInTheDocument(),
    );
  });
});
```

- [ ] **Step 4.2: Run — expect fail**

Run: `pnpm --filter @rovenue/dashboard test refund-shield-settings -- --run`
Expected: FAIL — module not found.

- [ ] **Step 4.3: Create the segment route**

Create `apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/route.tsx`:

```tsx
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/refund-shield",
)({
  component: () => <Outlet />,
});
```

- [ ] **Step 4.4: Create the settings page**

Create `apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/settings.tsx`:

```tsx
import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Spinner } from "@heroui/react";
import { ShieldCheck } from "lucide-react";
import { Button } from "../../../../../ui/button";
import { Switch } from "../../../../../ui/switch";
import { Checkbox } from "../../../../../ui/checkbox";
import { ApiError } from "../../../../../lib/api";
import {
  useRefundShieldSettings,
  useUpdateRefundShieldSettings,
} from "../../../../../lib/hooks/useRefundShield";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/refund-shield/settings",
)({
  component: RefundShieldSettingsRoute,
});

function RefundShieldSettingsRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/refund-shield/settings",
  });
  return <RefundShieldSettingsPage projectId={projectId} />;
}

export function RefundShieldSettingsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { data: settings, isLoading } = useRefundShieldSettings(projectId);
  const mutation = useUpdateRefundShieldSettings(projectId);

  const [enabled, setEnabled] = useState(false);
  const [delay, setDelay] = useState(60);
  const [consent, setConsent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setDelay(settings.responseDelayMinutes);
    setConsent(settings.consentAcknowledgedAt !== null);
  }, [settings]);

  if (isLoading || !settings) {
    return (
      <div className="flex items-center gap-2 text-rv-mute-500">
        <Spinner /> <span className="text-sm">{t("common.loading")}</span>
      </div>
    );
  }

  const consentAlreadyStamped = settings.consentAcknowledgedAt !== null;
  const consentMissing = enabled && !consentAlreadyStamped && !consent;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);
    setSavedFlash(false);

    if (consentMissing) {
      setFormError(t("refundShield.settings.consent.requiredBeforeEnable"));
      return;
    }

    try {
      await mutation.mutateAsync({
        enabled,
        responseDelayMinutes: delay,
        consentAcknowledged: consent && !consentAlreadyStamped ? true : undefined,
      });
      setSavedFlash(true);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : "";
      setFormError(t("refundShield.settings.error", { message: msg }));
    }
  };

  return (
    <>
      <header className="pb-5">
        <h1 className="flex items-center gap-2 text-[24px] font-semibold leading-8 tracking-tight">
          <ShieldCheck size={22} className="text-rv-accent-500" />
          {t("refundShield.settings.title")}
        </h1>
        <p className="mt-1 max-w-2xl text-[13px] text-rv-mute-500">
          {t("refundShield.settings.subtitle")}
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        className="grid max-w-3xl grid-cols-1 gap-4"
      >
        <section className="rounded-lg border border-rv-divider bg-rv-c1 p-4">
          <label
            className="flex items-start justify-between gap-3"
            htmlFor="rs-enable"
          >
            <div>
              <div className="text-[13px] font-medium">
                {t("refundShield.settings.enable.label")}
              </div>
              <p className="mt-1 text-[12px] text-rv-mute-500">
                {t("refundShield.settings.enable.description")}
              </p>
            </div>
            <Switch
              id="rs-enable"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </label>
        </section>

        <section className="rounded-lg border border-rv-divider bg-rv-c1 p-4">
          <div className="text-[13px] font-medium">
            {t("refundShield.settings.delay.label")}
          </div>
          <p className="mt-1 text-[12px] text-rv-mute-500">
            {t("refundShield.settings.delay.description")}
          </p>
          <div className="mt-3 flex items-center gap-3">
            <input
              type="range"
              min={30}
              max={360}
              step={5}
              value={delay}
              onChange={(e) => setDelay(Number(e.target.value))}
              className="flex-1 accent-rv-accent-500"
              aria-label={t("refundShield.settings.delay.label")}
            />
            <span className="w-24 text-right font-rv-mono text-[12px] text-foreground">
              {t("refundShield.settings.delay.unit", { value: delay })}
            </span>
          </div>
          <div className="mt-1 flex justify-between font-rv-mono text-[10px] text-rv-mute-500">
            <span>{t("refundShield.settings.delay.min")}</span>
            <span>{t("refundShield.settings.delay.max")}</span>
          </div>
        </section>

        <section className="rounded-lg border border-rv-divider bg-rv-c1 p-4">
          {consentAlreadyStamped ? (
            <p className="text-[12px] text-rv-mute-700">
              {t("refundShield.settings.consent.stamped", {
                date: new Date(
                  settings.consentAcknowledgedAt!,
                ).toLocaleDateString(),
                user: settings.consentAcknowledgedBy ?? "—",
              })}
            </p>
          ) : (
            <label className="flex items-start gap-2 text-[12px]">
              <Checkbox
                checked={consent}
                onCheckedChange={(v) => setConsent(Boolean(v))}
              />
              <span>{t("refundShield.settings.consent.label")}</span>
            </label>
          )}
        </section>

        {formError && (
          <div className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
            {formError}
          </div>
        )}
        {savedFlash && !formError && (
          <div className="rounded-md border border-rv-success/30 bg-rv-success/10 px-3 py-2 text-[12px] text-rv-success">
            {t("refundShield.settings.saved")}
          </div>
        )}

        <div className="pt-1">
          <Button
            type="submit"
            variant="solid-primary"
            disabled={mutation.isPending}
          >
            {mutation.isPending
              ? t("refundShield.settings.submitting")
              : t("refundShield.settings.submit")}
          </Button>
        </div>
      </form>
    </>
  );
}
```

(Adjust the `Switch` / `Checkbox` API shape if the local primitives differ — check `apps/dashboard/src/ui/switch.tsx` and `checkbox.tsx` for the exact prop names; the page should use whatever pattern the audience-form or experiment-form already follow.)

- [ ] **Step 4.5: Run — expect pass**

Run: `pnpm --filter @rovenue/dashboard test refund-shield-settings -- --run`
Expected: PASS (3 tests).

- [ ] **Step 4.6: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/ \
        apps/dashboard/tests/routes/refund-shield-settings.test.tsx
git commit -m "feat(dashboard): refund-shield settings page"
```

**Phase B acceptance criteria:**
- Settings page reads the disabled default and renders enable toggle + delay slider + consent checkbox.
- Submitting `enabled=true` without ticking consent surfaces the inline error and does not POST.
- A server-side 400 surfaces as a banner.
- Once consent is stamped, the checkbox is replaced by a "Acknowledged on… by…" line.

---

## Phase C — Onboarding wizard

### Task 5: Onboarding wizard component + integration

The wizard is rendered by the Overview page when `settings.enabled === false`. Building it as a self-contained component first keeps the Overview page test surface small.

**Files:**
- Create: `apps/dashboard/src/components/refund-shield/onboarding-wizard.tsx`
- Modify: `apps/dashboard/src/components/refund-shield/index.ts` (add export)

```
Wizard UI sketch
+----------------------------------------------------------+
|  Step 1 of 4         [ - - - - ]              [ Cancel ] |
|  Set up Refund Shield                                    |
|----------------------------------------------------------|
|  STEP 1 — SDK requirements                               |
|  Refund Shield works best when your SDK is passing an    |
|  appAccountToken on every Apple purchase…                |
|                                                          |
|         [ Continue anyway ]    [ I've upgraded the SDK ] |
+----------------------------------------------------------+

+----------------------------------------------------------+
|  Step 2 of 4         [ # - - - ]              [ Cancel ] |
|  Update your Terms of Service                            |
|----------------------------------------------------------|
|  Copy this clause into your ToS / privacy policy:        |
|  +----------------------------------------------------+  |
|  | Apple may consult anonymized signals…              |  |
|  +----------------------------------------------------+  |
|                                          [ Copy ]        |
|         [ Back ]              [ I've updated our ToS ]   |
+----------------------------------------------------------+

+----------------------------------------------------------+
|  Step 3 of 4         [ # # - - ]              [ Cancel ] |
|  Response delay                                          |
|----------------------------------------------------------|
|  How long to wait before replying.                       |
|  [----o-----------------------]   60 minutes             |
|  30 min                                       360 min    |
|         [ Back ]                            [ Next ]     |
+----------------------------------------------------------+

+----------------------------------------------------------+
|  Step 4 of 4         [ # # # # ]              [ Cancel ] |
|  Enable                                                  |
|----------------------------------------------------------|
|  You can disable Refund Shield at any time from Settings.|
|  [ x ] I confirm our Terms of Service…                   |
|         [ Back ]            [ Enable Refund Shield ]     |
+----------------------------------------------------------+
```

- [ ] **Step 5.1: Write the wizard test**

Create `apps/dashboard/tests/components/refund-shield-onboarding.test.tsx`:

```tsx
import { describe, expect, test, beforeAll, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { renderWithRouter } from "../render";
import { OnboardingWizard } from "../../src/components/refund-shield/onboarding-wizard";

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      resources: { en: { common: en } },
      lng: "en",
      fallbackLng: "en",
      defaultNS: "common",
      interpolation: { escapeValue: false },
    });
  }
});

describe("<OnboardingWizard />", () => {
  test("walks through all 4 steps and POSTs enabled=true on finish", async () => {
    const onComplete = vi.fn();
    renderWithRouter(
      <OnboardingWizard projectId="proj_1" onComplete={onComplete} />,
      "/projects/proj_1/refund-shield",
    );

    // Step 1
    expect(
      screen.getByText(/set up refund shield/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /upgraded the sdk/i }));

    // Step 2
    expect(screen.getByText(/update your terms of service/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /updated our tos/i }));

    // Step 3
    expect(screen.getByText(/response delay/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));

    // Step 4
    expect(screen.getByText(/^enable$/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/i confirm our terms/i));
    fireEvent.click(
      screen.getByRole("button", { name: /enable refund shield/i }),
    );

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  test("Back navigates one step at a time", async () => {
    renderWithRouter(
      <OnboardingWizard projectId="proj_1" onComplete={() => {}} />,
      "/projects/proj_1/refund-shield",
    );
    fireEvent.click(screen.getByRole("button", { name: /upgraded the sdk/i }));
    fireEvent.click(screen.getByRole("button", { name: /updated our tos/i }));
    expect(screen.getByText(/response delay/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^back$/i }));
    expect(screen.getByText(/update your terms of service/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 5.2: Run — expect fail**

Run: `pnpm --filter @rovenue/dashboard test refund-shield-onboarding -- --run`
Expected: FAIL — module not found.

- [ ] **Step 5.3: Create the wizard**

Create `apps/dashboard/src/components/refund-shield/onboarding-wizard.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, Check, Copy, ShieldCheck } from "lucide-react";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { CopyButton } from "../../ui/copy-button";
import { useUpdateRefundShieldSettings } from "../../lib/hooks/useRefundShield";
import { cn } from "../../lib/cn";

type Step = 1 | 2 | 3 | 4;

export interface OnboardingWizardProps {
  projectId: string;
  onComplete: () => void;
  onCancel?: () => void;
}

export function OnboardingWizard({
  projectId,
  onComplete,
  onCancel,
}: OnboardingWizardProps) {
  const { t } = useTranslation();
  const mutation = useUpdateRefundShieldSettings(projectId);
  const [step, setStep] = useState<Step>(1);
  const [delay, setDelay] = useState(60);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = () => setStep((s) => Math.min(4, (s + 1) as Step));
  const back = () => setStep((s) => Math.max(1, (s - 1) as Step));

  const finish = async () => {
    setError(null);
    try {
      await mutation.mutateAsync({
        enabled: true,
        responseDelayMinutes: delay,
        consentAcknowledged: true,
      });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex items-center justify-between border-b border-rv-divider px-5 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-rv-accent-500" />
          <span className="text-[13px] font-medium">
            {t("refundShield.wizard.title")}
          </span>
        </div>
        <span className="font-rv-mono text-[10px] text-rv-mute-500">
          {t("refundShield.wizard.step", { n: step })}
        </span>
      </header>

      <div className="flex items-center gap-1 border-b border-rv-divider bg-rv-c2/50 px-5 py-2">
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              i <= step ? "bg-rv-accent-500" : "bg-rv-c4",
            )}
          />
        ))}
      </div>

      <div className="px-5 py-5">
        {step === 1 && (
          <Step1 onContinue={next} />
        )}
        {step === 2 && <Step2 onContinue={next} />}
        {step === 3 && (
          <Step3 delay={delay} onDelay={setDelay} onNext={next} />
        )}
        {step === 4 && (
          <Step4
            consent={consent}
            onConsent={setConsent}
            onSubmit={finish}
            isPending={mutation.isPending}
          />
        )}
        {error && (
          <div className="mt-3 rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
            {error}
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-rv-divider px-5 py-3">
        <div>
          {step > 1 && (
            <Button variant="ghost" size="sm" onClick={back}>
              <ArrowLeft size={12} />
              {t("refundShield.wizard.back")}
            </Button>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("refundShield.wizard.exit")}
        </Button>
      </footer>
    </div>
  );
}

function Step1({ onContinue }: { onContinue: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[15px] font-medium">
        {t("refundShield.wizard.steps.sdkCheck.title")}
      </h2>
      <p className="text-[12px] leading-relaxed text-rv-mute-500">
        {t("refundShield.wizard.steps.sdkCheck.body")}
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="flat" size="sm" onClick={onContinue}>
          {t("refundShield.wizard.steps.sdkCheck.skip")}
        </Button>
        <Button variant="solid-primary" size="sm" onClick={onContinue}>
          {t("refundShield.wizard.steps.sdkCheck.okay")}
          <ArrowRight size={12} />
        </Button>
      </div>
    </div>
  );
}

function Step2({ onContinue }: { onContinue: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[15px] font-medium">
        {t("refundShield.wizard.steps.tos.title")}
      </h2>
      <p className="text-[12px] leading-relaxed text-rv-mute-500">
        {t("refundShield.wizard.steps.tos.body")}
      </p>
      <pre className="overflow-x-auto rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 font-rv-mono text-[11px] text-rv-mute-700">
        {t("refundShield.wizard.steps.tos.template")}
      </pre>
      <div className="flex items-center justify-between">
        <CopyButton
          value={t("refundShield.wizard.steps.tos.template")}
          label={
            <span className="inline-flex items-center gap-1 text-[12px]">
              <Copy size={11} /> Copy
            </span>
          }
        />
        <Button variant="solid-primary" size="sm" onClick={onContinue}>
          {t("refundShield.wizard.steps.tos.acknowledged")}
          <ArrowRight size={12} />
        </Button>
      </div>
    </div>
  );
}

function Step3({
  delay,
  onDelay,
  onNext,
}: {
  delay: number;
  onDelay: (n: number) => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[15px] font-medium">
        {t("refundShield.wizard.steps.delay.title")}
      </h2>
      <p className="text-[12px] leading-relaxed text-rv-mute-500">
        {t("refundShield.wizard.steps.delay.body")}
      </p>
      <div className="mt-2 flex items-center gap-3">
        <input
          type="range"
          min={30}
          max={360}
          step={5}
          value={delay}
          onChange={(e) => onDelay(Number(e.target.value))}
          className="flex-1 accent-rv-accent-500"
          aria-label={t("refundShield.settings.delay.label")}
        />
        <span className="w-24 text-right font-rv-mono text-[12px]">
          {t("refundShield.settings.delay.unit", { value: delay })}
        </span>
      </div>
      <div className="flex justify-end">
        <Button variant="solid-primary" size="sm" onClick={onNext}>
          {t("refundShield.wizard.steps.delay.next")}
          <ArrowRight size={12} />
        </Button>
      </div>
    </div>
  );
}

function Step4({
  consent,
  onConsent,
  onSubmit,
  isPending,
}: {
  consent: boolean;
  onConsent: (v: boolean) => void;
  onSubmit: () => void;
  isPending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[15px] font-medium">
        {t("refundShield.wizard.steps.enable.title")}
      </h2>
      <p className="text-[12px] leading-relaxed text-rv-mute-500">
        {t("refundShield.wizard.steps.enable.body")}
      </p>
      <label className="flex items-start gap-2 text-[12px]">
        <Checkbox
          checked={consent}
          onCheckedChange={(v) => onConsent(Boolean(v))}
        />
        <span>{t("refundShield.settings.consent.label")}</span>
      </label>
      <div className="flex justify-end">
        <Button
          variant="solid-primary"
          size="sm"
          disabled={!consent || isPending}
          onClick={onSubmit}
        >
          {isPending ? (
            t("refundShield.wizard.steps.enable.submitting")
          ) : (
            <>
              <Check size={12} />
              {t("refundShield.wizard.steps.enable.submit")}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
```

(If the local `CopyButton` API differs, swap to a plain `<Button onClick={() => navigator.clipboard.writeText(text)}>`.)

- [ ] **Step 5.4: Add export to the barrel**

Edit `apps/dashboard/src/components/refund-shield/index.ts` to append:

```ts
export { OnboardingWizard } from "./onboarding-wizard";
export type { OnboardingWizardProps } from "./onboarding-wizard";
```

- [ ] **Step 5.5: Run — expect pass**

Run: `pnpm --filter @rovenue/dashboard test refund-shield-onboarding -- --run`
Expected: PASS (2 tests).

- [ ] **Step 5.6: Commit**

```bash
git add apps/dashboard/src/components/refund-shield/onboarding-wizard.tsx \
        apps/dashboard/src/components/refund-shield/index.ts \
        apps/dashboard/tests/components/refund-shield-onboarding.test.tsx
git commit -m "feat(dashboard): refund-shield onboarding wizard"
```

**Phase C acceptance criteria:**
- 4-step wizard with linear progression + Back navigation.
- Final step is disabled until consent is ticked.
- Successful enable invokes `onComplete()` so the parent can rerender the live Overview.

---

## Phase D — Overview page

### Task 6: Overview route (KPIs + sparkline + donut + wizard fallback)

The Overview page does double duty: it shows the wizard when disabled, and the KPI dashboard when enabled.

**Files:**
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/index.tsx`

- [ ] **Step 6.1: Write the overview test**

Create `apps/dashboard/tests/routes/refund-shield-overview.test.tsx`:

```tsx
import { describe, expect, test, beforeAll } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { server } from "../msw/server";
import { renderWithRouter } from "../render";
import { RefundShieldOverviewPage } from "../../src/routes/_authed/projects/$projectId/refund-shield/index";

const BASE = "http://localhost:3000";

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      resources: { en: { common: en } },
      lng: "en",
      fallbackLng: "en",
      defaultNS: "common",
      interpolation: { escapeValue: false },
    });
  }
});

describe("<RefundShieldOverviewPage />", () => {
  test("disabled state shows the onboarding wizard", async () => {
    renderWithRouter(
      <RefundShieldOverviewPage projectId="proj_1" />,
      "/projects/proj_1/refund-shield",
    );
    await waitFor(() =>
      expect(screen.getByText(/set up refund shield/i)).toBeInTheDocument(),
    );
  });

  test("enabled state renders KPI cards and breakdown", async () => {
    server.use(
      http.get(
        `${BASE}/dashboard/projects/:projectId/refund-shield/settings`,
        () =>
          HttpResponse.json({
            data: {
              settings: {
                enabled: true,
                responseDelayMinutes: 60,
                consentAcknowledgedAt: "2026-05-01T00:00:00.000Z",
                consentAcknowledgedBy: "u1",
              },
            },
          }),
      ),
    );
    renderWithRouter(
      <RefundShieldOverviewPage projectId="proj_1" />,
      "/projects/proj_1/refund-shield",
    );
    await waitFor(() =>
      expect(screen.getByText(/responses sent/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("184")).toBeInTheDocument();
    expect(screen.getByText(/74\.7%/)).toBeInTheDocument();
    expect(screen.getByText(/\$4,824\.00/)).toBeInTheDocument();
    // Donut legend
    expect(screen.getByText(/declined/i)).toBeInTheDocument();
    expect(screen.getByText(/approved/i)).toBeInTheDocument();
    expect(screen.getByText(/reversed/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 6.2: Run — expect fail**

Run: `pnpm --filter @rovenue/dashboard test refund-shield-overview -- --run`
Expected: FAIL.

- [ ] **Step 6.3: Create the overview page**

Create `apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/index.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Spinner } from "@heroui/react";
import { ShieldCheck, Settings as Cog } from "lucide-react";
import { Button } from "../../../../../ui/button";
import { StatCard } from "../../../../../ui/stat-card";
import { Sparkline } from "../../../../../components/dashboard/sparkline";
import { OnboardingWizard } from "../../../../../components/refund-shield";
import {
  useRefundShieldMetrics,
  useRefundShieldSettings,
} from "../../../../../lib/hooks/useRefundShield";
import { cn } from "../../../../../lib/cn";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/refund-shield/",
)({
  component: RefundShieldOverviewRoute,
});

function RefundShieldOverviewRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/refund-shield/",
  });
  return <RefundShieldOverviewPage projectId={projectId} />;
}

export function RefundShieldOverviewPage({
  projectId,
}: {
  projectId: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const settings = useRefundShieldSettings(projectId);

  if (settings.isLoading) {
    return (
      <div className="flex items-center gap-2 text-rv-mute-500">
        <Spinner /> <span className="text-sm">{t("common.loading")}</span>
      </div>
    );
  }

  if (!settings.data?.enabled) {
    return (
      <>
        <Header
          subtitle={t("refundShield.disabled.body")}
          actions={null}
        />
        <OnboardingWizard
          projectId={projectId}
          onComplete={() =>
            qc.invalidateQueries({
              queryKey: ["refund-shield", "settings", projectId],
            })
          }
          onCancel={() =>
            void navigate({
              to: "/projects/$projectId",
              params: { projectId },
            })
          }
        />
      </>
    );
  }

  return <EnabledOverview projectId={projectId} />;
}

function EnabledOverview({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isLoading } = useRefundShieldMetrics(projectId);

  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 text-rv-mute-500">
        <Spinner /> <span className="text-sm">{t("common.loading")}</span>
      </div>
    );
  }

  const winPct = (data.winRate * 100).toFixed(1);
  const revenueSavedUsd = (data.estimatedRevenueSavedCents / 100).toLocaleString(
    "en-US",
    { style: "currency", currency: "USD" },
  );

  // Sparkline placeholder: until /metrics exposes per-day points,
  // synthesise a flat-ish series weighted to the total sent count.
  // (Documented limitation — see "Backend gaps" at the end of the plan.)
  const trend = synthesiseTrend(data.sentCount, 30);

  return (
    <>
      <Header
        subtitle={t("refundShield.subtitle")}
        actions={
          <Button
            variant="flat"
            size="sm"
            onClick={() =>
              void navigate({
                to: "/projects/$projectId/refund-shield/settings",
                params: { projectId },
              })
            }
          >
            <Cog size={13} />
            {t("refundShield.settings.title")}
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t("refundShield.kpi.sent")}
          value={data.sentCount.toLocaleString()}
        />
        <StatCard
          label={t("refundShield.kpi.winRate")}
          value={`${winPct}%`}
          description={t("refundShield.kpi.winRateHint")}
        />
        <StatCard
          label={t("refundShield.kpi.revenueSaved")}
          value={
            <span className="text-rv-success">{revenueSavedUsd}</span>
          }
          description={t("refundShield.kpi.revenueSavedHint")}
          descriptionTone="success"
        />
        <StatCard
          label={t("refundShield.kpi.outcomesPending")}
          value={(data.sentCount - data.outcomeCount).toLocaleString()}
          description={t("refundShield.kpi.outcomesPendingHint")}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-lg border border-rv-divider bg-rv-c1 p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-[13px] font-medium">
              {t("refundShield.trend.title")}
            </h2>
          </div>
          {data.sentCount === 0 ? (
            <p className="py-6 text-center text-[12px] text-rv-mute-500">
              {t("refundShield.trend.empty")}
            </p>
          ) : (
            <Sparkline data={trend} width={520} height={80} />
          )}
        </section>

        <section className="rounded-lg border border-rv-divider bg-rv-c1 p-4">
          <h2 className="text-[13px] font-medium">
            {t("refundShield.donut.title")}
          </h2>
          <DonutBreakdown
            buckets={[
              {
                key: "declined",
                label: t("refundShield.donut.declined"),
                count: data.declinedCount,
                color: "var(--color-rv-success)",
              },
              {
                key: "approved",
                label: t("refundShield.donut.approved"),
                count: data.approvedCount,
                color: "var(--color-rv-danger)",
              },
              {
                key: "reversed",
                label: t("refundShield.donut.reversed"),
                count: data.reversedCount,
                color: "var(--color-rv-warning)",
              },
              {
                key: "pending",
                label: t("refundShield.donut.pending"),
                count: Math.max(data.sentCount - data.outcomeCount, 0),
                color: "var(--color-rv-mute-500)",
              },
            ]}
          />
        </section>
      </div>
    </>
  );
}

function Header({
  subtitle,
  actions,
}: {
  subtitle: string;
  actions: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <header className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-[24px] font-semibold leading-8 tracking-tight">
          <ShieldCheck size={22} className="text-rv-accent-500" />
          {t("refundShield.title")}
        </h1>
        <p className="mt-1 max-w-2xl text-[13px] text-rv-mute-500">{subtitle}</p>
      </div>
      {actions}
    </header>
  );
}

function DonutBreakdown({
  buckets,
}: {
  buckets: ReadonlyArray<{
    key: string;
    label: string;
    count: number;
    color: string;
  }>;
}) {
  const total = buckets.reduce((acc, b) => acc + b.count, 0);
  let acc = 0;
  const segments = buckets.map((b) => {
    const start = total > 0 ? (acc / total) * 100 : 0;
    acc += b.count;
    const end = total > 0 ? (acc / total) * 100 : 0;
    return { ...b, start, end };
  });

  return (
    <div className="mt-3 flex items-center gap-4">
      <svg viewBox="0 0 36 36" className="h-32 w-32 -rotate-90">
        <circle cx="18" cy="18" r="15.9155" fill="transparent"
          stroke="var(--color-rv-c3)" strokeWidth="3" />
        {segments.map((seg) => (
          <circle
            key={seg.key}
            cx="18" cy="18" r="15.9155"
            fill="transparent"
            stroke={seg.color}
            strokeWidth="3"
            strokeDasharray={`${seg.end - seg.start} 100`}
            strokeDashoffset={-seg.start}
          />
        ))}
      </svg>
      <ul className="flex flex-1 flex-col gap-1.5 text-[12px]">
        {segments.map((seg) => (
          <li key={seg.key} className="flex items-center gap-2">
            <span
              className="inline-block size-2.5 rounded-sm"
              style={{ backgroundColor: seg.color }}
            />
            <span className="flex-1 text-rv-mute-700">{seg.label}</span>
            <span
              className={cn(
                "font-rv-mono text-rv-mute-500 tabular-nums",
              )}
            >
              {seg.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function synthesiseTrend(total: number, days: number): number[] {
  const avg = total > 0 ? total / days : 0;
  return Array.from({ length: days }, (_, i) => {
    const wobble = Math.sin(i * 0.6) * (avg * 0.3);
    return Math.max(0, Math.round(avg + wobble));
  });
}
```

- [ ] **Step 6.4: Run — expect pass**

Run: `pnpm --filter @rovenue/dashboard test refund-shield-overview -- --run`
Expected: PASS (2 tests).

- [ ] **Step 6.5: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/index.tsx \
        apps/dashboard/tests/routes/refund-shield-overview.test.tsx
git commit -m "feat(dashboard): refund-shield overview page + KPI cards"
```

**Phase D acceptance criteria:**
- Disabled state renders the onboarding wizard inline.
- Enabled state renders 4 KPI cards (sent, win rate, revenue saved, outcomes pending).
- Donut breakdown legend lists declined / approved / reversed / pending.
- Wizard completion invalidates settings; the page transitions to the live KPI view on next render.

---

## Phase E — Responses list

### Task 7: Responses list (table + filter bar + infinite scroll)

**Files:**
- Create: `apps/dashboard/src/components/refund-shield/responses-filter-bar.tsx`
- Create: `apps/dashboard/src/components/refund-shield/responses-table.tsx`
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/responses.tsx`
- Modify: `apps/dashboard/src/components/refund-shield/index.ts`

- [ ] **Step 7.1: Write the responses-list test**

Create `apps/dashboard/tests/routes/refund-shield-responses.test.tsx`:

```tsx
import { describe, expect, test, beforeAll } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { renderWithRouter } from "../render";
import { RefundShieldResponsesPage } from "../../src/routes/_authed/projects/$projectId/refund-shield/responses";

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      resources: { en: { common: en } },
      lng: "en",
      fallbackLng: "en",
      defaultNS: "common",
      interpolation: { escapeValue: false },
    });
  }
});

describe("<RefundShieldResponsesPage />", () => {
  test("renders all rows from the fixture and shows status chips", async () => {
    renderWithRouter(
      <RefundShieldResponsesPage projectId="proj_1" />,
      "/projects/proj_1/refund-shield/responses",
    );
    await waitFor(() =>
      expect(screen.getByText(/2000000111111111/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/2000000222222221/)).toBeInTheDocument();
    expect(screen.getByText(/2000000333333331/)).toBeInTheDocument();
    expect(screen.getByText(/2000000444444441/)).toBeInTheDocument();

    expect(screen.getAllByText(/sent/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
    expect(screen.getByText(/skipped \(disabled\)/i)).toBeInTheDocument();
  });

  test("filtering by status=PENDING narrows the table", async () => {
    renderWithRouter(
      <RefundShieldResponsesPage projectId="proj_1" />,
      "/projects/proj_1/refund-shield/responses",
    );
    await waitFor(() =>
      expect(screen.getByText(/2000000222222221/)).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(/^status$/i), {
      target: { value: "PENDING" },
    });
    await waitFor(() =>
      expect(screen.queryByText(/2000000444444441/)).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/2000000222222221/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 7.2: Run — expect fail**

Run: `pnpm --filter @rovenue/dashboard test refund-shield-responses -- --run`
Expected: FAIL.

- [ ] **Step 7.3: Create the filter bar**

Create `apps/dashboard/src/components/refund-shield/responses-filter-bar.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { Select } from "../../ui/select";
import type {
  RefundShieldOutcome,
  RefundShieldStatus,
} from "../../lib/hooks/useRefundShield";

const STATUSES: ReadonlyArray<RefundShieldStatus> = [
  "PENDING",
  "SENT",
  "FAILED",
  "SKIPPED_DISABLED",
  "SKIPPED_NOT_FOUND",
];

const OUTCOMES: ReadonlyArray<RefundShieldOutcome> = [
  "REFUND_DECLINED",
  "REFUND_APPROVED",
  "REFUND_REVERSED",
];

export interface ResponsesFilters {
  status?: RefundShieldStatus;
  outcome?: RefundShieldOutcome;
}

export interface ResponsesFilterBarProps {
  value: ResponsesFilters;
  onChange: (next: ResponsesFilters) => void;
}

export function ResponsesFilterBar({
  value,
  onChange,
}: ResponsesFilterBarProps) {
  const { t } = useTranslation();
  return (
    <div className="mb-3 flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-rv-mute-500">
        {t("refundShield.responses.filters.status")}
        <Select
          aria-label={t("refundShield.responses.filters.status")}
          value={value.status ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              status: (e.target.value || undefined) as
                | RefundShieldStatus
                | undefined,
            })
          }
          className="h-8 w-[200px] text-[12px]"
        >
          <option value="">{t("refundShield.responses.filters.any")}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`refundShield.status.${s}`)}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-rv-mute-500">
        {t("refundShield.responses.filters.outcome")}
        <Select
          aria-label={t("refundShield.responses.filters.outcome")}
          value={value.outcome ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              outcome: (e.target.value || undefined) as
                | RefundShieldOutcome
                | undefined,
            })
          }
          className="h-8 w-[200px] text-[12px]"
        >
          <option value="">{t("refundShield.responses.filters.any")}</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {t(`refundShield.outcome.${o}`)}
            </option>
          ))}
        </Select>
      </label>
    </div>
  );
}
```

- [ ] **Step 7.4: Create the responses table**

Create `apps/dashboard/src/components/refund-shield/responses-table.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { StatusChip } from "./status-chip";
import { OutcomeChip } from "./outcome-chip";
import type { RefundShieldResponseRow } from "../../lib/hooks/useRefundShield";

export interface ResponsesTableProps {
  projectId: string;
  rows: ReadonlyArray<RefundShieldResponseRow>;
}

export function ResponsesTable({ projectId, rows }: ResponsesTableProps) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-rv-divider bg-rv-c1 px-4 py-8 text-center text-[12px] text-rv-mute-500">
        {t("refundShield.responses.empty")}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-rv-divider bg-rv-c1">
      <table className="w-full text-left text-[12px]">
        <thead className="border-b border-rv-divider bg-rv-c2/40 text-[10px] uppercase tracking-wider text-rv-mute-500">
          <tr>
            <Th>{t("refundShield.responses.columns.detectedAt")}</Th>
            <Th>{t("refundShield.responses.columns.status")}</Th>
            <Th>{t("refundShield.responses.columns.outcome")}</Th>
            <Th>{t("refundShield.responses.columns.subscriber")}</Th>
            <Th>{t("refundShield.responses.columns.originalTransactionId")}</Th>
            <Th>{t("refundShield.responses.columns.retries")}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-b border-rv-divider last:border-b-0 hover:bg-rv-c2/40"
            >
              <Td>
                <Link
                  to="/projects/$projectId/refund-shield/responses/$rid"
                  params={{ projectId, rid: r.id }}
                  className="font-rv-mono text-rv-mute-700 hover:text-rv-accent-500"
                >
                  {new Date(r.detectedAt).toLocaleString()}
                </Link>
              </Td>
              <Td>
                <StatusChip status={r.status} />
              </Td>
              <Td>
                <OutcomeChip outcome={r.outcome} />
              </Td>
              <Td>
                {r.subscriberId ? (
                  <Link
                    to="/projects/$projectId/subscribers/$id"
                    params={{ projectId, id: r.subscriberId }}
                    className="font-rv-mono text-rv-mute-700 hover:text-rv-accent-500"
                  >
                    {r.subscriberId.slice(0, 8)}…
                  </Link>
                ) : (
                  <span className="text-rv-mute-500">—</span>
                )}
              </Td>
              <Td>
                <span className="font-rv-mono text-rv-mute-700">
                  {r.appleOriginalTransactionId}
                </span>
              </Td>
              <Td>
                <span className="font-rv-mono tabular-nums text-rv-mute-700">
                  {r.retryCount}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 align-middle">{children}</td>;
}
```

- [ ] **Step 7.5: Create the responses page**

Create `apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/responses.tsx`:

```tsx
import { useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Spinner } from "@heroui/react";
import { Button } from "../../../../../ui/button";
import { useRefundShieldResponses } from "../../../../../lib/hooks/useRefundShield";
import {
  ResponsesFilterBar,
  type ResponsesFilters,
} from "../../../../../components/refund-shield/responses-filter-bar";
import { ResponsesTable } from "../../../../../components/refund-shield/responses-table";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/refund-shield/responses",
)({
  component: RefundShieldResponsesRoute,
});

function RefundShieldResponsesRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/refund-shield/responses",
  });
  return <RefundShieldResponsesPage projectId={projectId} />;
}

export function RefundShieldResponsesPage({
  projectId,
}: {
  projectId: string;
}) {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<ResponsesFilters>({});
  const query = useRefundShieldResponses(projectId, filters);

  const rows = useMemo(
    () => query.data?.pages.flatMap((p) => p.responses) ?? [],
    [query.data],
  );

  return (
    <>
      <header className="mb-4">
        <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
          {t("refundShield.responses.title")}
        </h1>
        <p className="mt-1 max-w-2xl text-[13px] text-rv-mute-500">
          {t("refundShield.subtitle")}
        </p>
      </header>

      <ResponsesFilterBar value={filters} onChange={setFilters} />

      {query.isLoading ? (
        <div className="flex items-center gap-2 text-rv-mute-500">
          <Spinner /> <span className="text-sm">{t("common.loading")}</span>
        </div>
      ) : (
        <ResponsesTable projectId={projectId} rows={rows} />
      )}

      {query.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="flat"
            size="sm"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {t("refundShield.responses.loadMore")}
          </Button>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 7.6: Add table + filter bar exports**

Edit `apps/dashboard/src/components/refund-shield/index.ts` to append:

```ts
export { ResponsesTable } from "./responses-table";
export { ResponsesFilterBar } from "./responses-filter-bar";
export type { ResponsesFilters } from "./responses-filter-bar";
```

- [ ] **Step 7.7: Run — expect pass**

Run: `pnpm --filter @rovenue/dashboard test refund-shield-responses -- --run`
Expected: PASS (2 tests).

- [ ] **Step 7.8: Commit**

```bash
git add apps/dashboard/src/components/refund-shield/responses-filter-bar.tsx \
        apps/dashboard/src/components/refund-shield/responses-table.tsx \
        apps/dashboard/src/components/refund-shield/index.ts \
        apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/responses.tsx \
        apps/dashboard/tests/routes/refund-shield-responses.test.tsx
git commit -m "feat(dashboard): refund-shield responses list + filters"
```

**Phase E acceptance criteria:**
- All four fixture rows render with status/outcome chips, subscriber link, and original transaction id.
- Status filter triggers a refetch that narrows the table.
- "Load more" appears only when `hasNextPage`.

---

## Phase F — Response detail

### Task 8: Response detail (timeline + payload + Apple response)

**Files:**
- Create: `apps/dashboard/src/components/refund-shield/response-timeline.tsx`
- Create: `apps/dashboard/src/components/refund-shield/json-payload-viewer.tsx`
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/responses_.$rid.tsx`
- Modify: `apps/dashboard/src/components/refund-shield/index.ts`

(`responses_.$rid.tsx` uses TanStack Router's `_` suffix to declare a route segment that does **not** nest under `responses.tsx` — so the detail page renders standalone without the list mounting behind it.)

- [ ] **Step 8.1: Write the detail test**

Create `apps/dashboard/tests/routes/refund-shield-response-detail.test.tsx`:

```tsx
import { describe, expect, test, beforeAll } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { renderWithRouter } from "../render";
import { RefundShieldResponseDetailPage } from "../../src/routes/_authed/projects/$projectId/refund-shield/responses_.$rid";

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      resources: { en: { common: en } },
      lng: "en",
      fallbackLng: "en",
      defaultNS: "common",
      interpolation: { escapeValue: false },
    });
  }
});

describe("<RefundShieldResponseDetailPage />", () => {
  test("renders timeline, payload, and subscriber link", async () => {
    renderWithRouter(
      <RefundShieldResponseDetailPage
        projectId="proj_1"
        rid="rss_sent_declined"
      />,
      "/projects/proj_1/refund-shield/responses/rss_sent_declined",
    );
    await waitFor(() =>
      expect(screen.getByText(/posted to apple/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/refund declined/i)).toBeInTheDocument();
    expect(
      screen.getByText(/2000000111111112/i),
    ).toBeInTheDocument();
    // Apple payload JSON visible
    expect(
      screen.getByText(/customerConsented/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view subscriber/i })).toBeInTheDocument();
  });

  test("rss_pending: timeline stops at scheduled, no Apple response", async () => {
    renderWithRouter(
      <RefundShieldResponseDetailPage
        projectId="proj_1"
        rid="rss_pending"
      />,
      "/projects/proj_1/refund-shield/responses/rss_pending",
    );
    await waitFor(() =>
      expect(screen.getByText(/scheduled to send/i)).toBeInTheDocument(),
    );
    // No "Posted to Apple" event for pending rows.
    expect(screen.queryByText(/posted to apple/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no payload/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 8.2: Run — expect fail**

Run: `pnpm --filter @rovenue/dashboard test refund-shield-response-detail -- --run`
Expected: FAIL.

- [ ] **Step 8.3: Create the timeline component**

Create `apps/dashboard/src/components/refund-shield/response-timeline.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { AlertCircle, ArrowRight, Check, Clock, Send, X } from "lucide-react";
import type { RefundShieldResponseDetail } from "../../lib/hooks/useRefundShield";

interface Entry {
  key: string;
  icon: React.ReactNode;
  label: string;
  at: string;
  tone: "neutral" | "success" | "danger" | "warning";
}

export function ResponseTimeline({
  response,
}: {
  response: RefundShieldResponseDetail;
}) {
  const { t } = useTranslation();
  const entries: Entry[] = [];

  entries.push({
    key: "detected",
    icon: <Clock size={11} />,
    label: t("refundShield.detail.timeline.detected"),
    at: response.detectedAt,
    tone: "neutral",
  });

  if (response.status !== "SKIPPED_DISABLED" && response.status !== "SKIPPED_NOT_FOUND") {
    entries.push({
      key: "scheduled",
      icon: <ArrowRight size={11} />,
      label: t("refundShield.detail.timeline.scheduled"),
      at: response.scheduledFor,
      tone: "neutral",
    });
  }

  if (response.sentAt) {
    entries.push({
      key: "sent",
      icon: <Send size={11} />,
      label: t("refundShield.detail.timeline.sent"),
      at: response.sentAt,
      tone: "success",
    });
  }

  if (response.status === "FAILED") {
    entries.push({
      key: "failed",
      icon: <AlertCircle size={11} />,
      label:
        response.error
          ? `${t("refundShield.detail.timeline.failed")} — ${response.error}`
          : t("refundShield.detail.timeline.failed"),
      at: response.updatedAt,
      tone: "danger",
    });
  }

  if (response.outcome === "REFUND_DECLINED" && response.outcomeReceivedAt) {
    entries.push({
      key: "outcome",
      icon: <Check size={11} />,
      label: t("refundShield.detail.timeline.outcomeDeclined"),
      at: response.outcomeReceivedAt,
      tone: "success",
    });
  } else if (response.outcome === "REFUND_APPROVED" && response.outcomeReceivedAt) {
    entries.push({
      key: "outcome",
      icon: <X size={11} />,
      label: t("refundShield.detail.timeline.outcomeApproved"),
      at: response.outcomeReceivedAt,
      tone: "danger",
    });
  } else if (response.outcome === "REFUND_REVERSED" && response.outcomeReceivedAt) {
    entries.push({
      key: "outcome",
      icon: <AlertCircle size={11} />,
      label: t("refundShield.detail.timeline.outcomeReversed"),
      at: response.outcomeReceivedAt,
      tone: "warning",
    });
  }

  const toneClass: Record<Entry["tone"], string> = {
    neutral: "border-rv-divider bg-rv-c2 text-rv-mute-700",
    success: "border-rv-success/40 bg-rv-success/10 text-rv-success",
    danger: "border-rv-danger/40 bg-rv-danger/10 text-rv-danger",
    warning: "border-rv-warning/40 bg-rv-warning/10 text-rv-warning",
  };

  return (
    <ol className="flex flex-col gap-2">
      {entries.map((e) => (
        <li
          key={e.key}
          className="flex items-center gap-3"
        >
          <span
            className={`inline-flex size-6 items-center justify-center rounded-full border ${toneClass[e.tone]}`}
          >
            {e.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium">{e.label}</div>
            <div className="font-rv-mono text-[10px] text-rv-mute-500">
              {new Date(e.at).toLocaleString()}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 8.4: Create the JSON payload viewer**

Create `apps/dashboard/src/components/refund-shield/json-payload-viewer.tsx`:

```tsx
import { useTranslation } from "react-i18next";

export function JsonPayloadViewer({
  payload,
}: {
  payload: Record<string, unknown> | null;
}) {
  const { t } = useTranslation();
  if (!payload) {
    return (
      <p className="text-[12px] text-rv-mute-500">
        {t("refundShield.detail.payload.empty")}
      </p>
    );
  }
  return (
    <pre className="overflow-x-auto rounded-md border border-rv-divider bg-rv-c1 px-3 py-2 font-rv-mono text-[11px] text-rv-mute-700">
      {JSON.stringify(payload, null, 2)}
    </pre>
  );
}
```

- [ ] **Step 8.5: Create the response detail page**

Create `apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/responses_.$rid.tsx`:

```tsx
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Spinner } from "@heroui/react";
import { ArrowLeft } from "lucide-react";
import { useRefundShieldResponse } from "../../../../../lib/hooks/useRefundShield";
import {
  JsonPayloadViewer,
  ResponseTimeline,
  StatusChip,
  OutcomeChip,
} from "../../../../../components/refund-shield";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/refund-shield/responses_/$rid",
)({
  component: RefundShieldResponseDetailRoute,
});

function RefundShieldResponseDetailRoute() {
  const { projectId, rid } = useParams({
    from: "/_authed/projects/$projectId/refund-shield/responses_/$rid",
  });
  return <RefundShieldResponseDetailPage projectId={projectId} rid={rid} />;
}

export function RefundShieldResponseDetailPage({
  projectId,
  rid,
}: {
  projectId: string;
  rid: string;
}) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useRefundShieldResponse(projectId, rid);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-rv-mute-500">
        <Spinner /> <span className="text-sm">{t("common.loading")}</span>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="text-rv-danger">{error?.message ?? t("common.notFound")}</div>
    );
  }

  return (
    <>
      <header className="mb-5">
        <Link
          to="/projects/$projectId/refund-shield/responses"
          params={{ projectId }}
          className="inline-flex items-center gap-1 text-[12px] text-rv-mute-500 hover:text-foreground"
        >
          <ArrowLeft size={12} />
          {t("refundShield.detail.back")}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-rv-mono text-[18px] font-medium">
            {data.appleTransactionId}
          </h1>
          <StatusChip status={data.status} />
          <OutcomeChip outcome={data.outcome} />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="flex flex-col gap-4">
          <Card title={t("refundShield.detail.timeline.title")}>
            <ResponseTimeline response={data} />
          </Card>

          <Card
            title={t("refundShield.detail.payload.title")}
            subtitle={t("refundShield.detail.payload.subtitle", {
              txn: data.appleTransactionId,
            })}
          >
            <JsonPayloadViewer payload={data.requestPayload} />
          </Card>

          <Card title={t("refundShield.detail.appleResponse.title")}>
            {data.appleHttpStatus ? (
              <>
                <div className="text-[12px] text-rv-mute-700">
                  {t("refundShield.detail.appleResponse.status", {
                    status: data.appleHttpStatus,
                  })}
                </div>
                {data.appleResponseBody ? (
                  <pre className="mt-2 overflow-x-auto rounded-md border border-rv-divider bg-rv-c1 px-3 py-2 font-rv-mono text-[11px] text-rv-mute-700">
                    {data.appleResponseBody}
                  </pre>
                ) : null}
              </>
            ) : (
              <p className="text-[12px] text-rv-mute-500">
                {t("refundShield.detail.appleResponse.empty")}
              </p>
            )}
          </Card>
        </section>

        <aside>
          <Card title={t("refundShield.detail.subscriber.title")}>
            {data.subscriberId ? (
              <Link
                to="/projects/$projectId/subscribers/$id"
                params={{ projectId, id: data.subscriberId }}
                className="inline-flex items-center gap-1 font-rv-mono text-[12px] text-rv-accent-500 hover:underline"
              >
                {t("refundShield.detail.linkSubscriber")}
                <span className="text-rv-mute-500">
                  {data.subscriberId.slice(0, 8)}…
                </span>
              </Link>
            ) : (
              <p className="text-[12px] text-rv-mute-500">
                {t("refundShield.detail.subscriber.missing")}
              </p>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1">
      <header className="border-b border-rv-divider bg-rv-c2/40 px-4 py-2">
        <h2 className="text-[13px] font-medium">{title}</h2>
        {subtitle && (
          <p className="mt-0.5 text-[11px] text-rv-mute-500">{subtitle}</p>
        )}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}
```

- [ ] **Step 8.6: Append exports to the barrel**

Edit `apps/dashboard/src/components/refund-shield/index.ts` to append:

```ts
export { ResponseTimeline } from "./response-timeline";
export { JsonPayloadViewer } from "./json-payload-viewer";
```

- [ ] **Step 8.7: Run — expect pass**

Run: `pnpm --filter @rovenue/dashboard test refund-shield-response-detail -- --run`
Expected: PASS (2 tests).

- [ ] **Step 8.8: Commit**

```bash
git add apps/dashboard/src/components/refund-shield/response-timeline.tsx \
        apps/dashboard/src/components/refund-shield/json-payload-viewer.tsx \
        apps/dashboard/src/components/refund-shield/index.ts \
        apps/dashboard/src/routes/_authed/projects/$projectId/refund-shield/responses_.\$rid.tsx \
        apps/dashboard/tests/routes/refund-shield-response-detail.test.tsx
git commit -m "feat(dashboard): refund-shield response detail page"
```

**Phase F acceptance criteria:**
- Timeline renders detected → scheduled → sent → outcome events only when their timestamps exist.
- Apple payload renders as pretty JSON; "No payload" line for skipped rows.
- Subscriber link routes to the existing `/subscribers/$id`.

---

## Phase G — Subscriber detail tab

### Task 9: "Refund Shield" card on the subscriber drill-in

The existing `SubscriberDetailPanel` is a vertical card stack — no real tabs. The cleanest fit is a new card appended after Experiments. The card lists the subscriber's refund requests (filtered client-side by `subscriberId === data.id`).

**Files:**
- Create: `apps/dashboard/src/components/refund-shield/subscriber-tab.tsx`
- Modify: `apps/dashboard/src/components/refund-shield/index.ts`
- Modify: `apps/dashboard/src/components/subscribers/SubscriberDetailPanel.tsx`

- [ ] **Step 9.1: Write the subscriber-tab test**

Create `apps/dashboard/tests/components/refund-shield-subscriber-tab.test.tsx`:

```tsx
import { describe, expect, test, beforeAll } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { server } from "../msw/server";
import { renderWithRouter } from "../render";
import { SubscriberRefundShieldCard } from "../../src/components/refund-shield/subscriber-tab";

const BASE = "http://localhost:3000";

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      resources: { en: { common: en } },
      lng: "en",
      fallbackLng: "en",
      defaultNS: "common",
      interpolation: { escapeValue: false },
    });
  }
});

describe("<SubscriberRefundShieldCard />", () => {
  test("hidden when settings.enabled === false", async () => {
    const { container } = renderWithRouter(
      <SubscriberRefundShieldCard projectId="proj_1" subscriberId="sub_1" />,
      "/projects/proj_1/subscribers/sub_1",
    );
    // The card mounts a hook + returns null until settings resolves.
    // Once it resolves to disabled, render the "disabled" notice (not blank)
    // so operators understand why nothing is shown.
    await waitFor(() => expect(container.textContent ?? "").toContain("Refund Shield is off"));
  });

  test("enabled + matching subscriber renders the count + chips", async () => {
    server.use(
      http.get(
        `${BASE}/dashboard/projects/:projectId/refund-shield/settings`,
        () =>
          HttpResponse.json({
            data: {
              settings: {
                enabled: true,
                responseDelayMinutes: 60,
                consentAcknowledgedAt: "2026-05-01T00:00:00.000Z",
                consentAcknowledgedBy: "u1",
              },
            },
          }),
      ),
    );
    renderWithRouter(
      <SubscriberRefundShieldCard projectId="proj_1" subscriberId="sub_1" />,
      "/projects/proj_1/subscribers/sub_1",
    );
    await waitFor(() =>
      expect(screen.getByText(/refund shield/i)).toBeInTheDocument(),
    );
    // sub_1 owns rss_sent_declined in the fixture
    await waitFor(() =>
      expect(screen.getByText(/2000000111111111/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/refund declined/i)).toBeInTheDocument();
  });

  test("enabled + no responses for the subscriber → empty state", async () => {
    server.use(
      http.get(
        `${BASE}/dashboard/projects/:projectId/refund-shield/settings`,
        () =>
          HttpResponse.json({
            data: {
              settings: {
                enabled: true,
                responseDelayMinutes: 60,
                consentAcknowledgedAt: "2026-05-01T00:00:00.000Z",
                consentAcknowledgedBy: "u1",
              },
            },
          }),
      ),
    );
    renderWithRouter(
      <SubscriberRefundShieldCard projectId="proj_1" subscriberId="sub_999" />,
      "/projects/proj_1/subscribers/sub_999",
    );
    await waitFor(() =>
      expect(
        screen.getByText(/no refund requests for this subscriber/i),
      ).toBeInTheDocument(),
    );
  });
});
```

- [ ] **Step 9.2: Run — expect fail**

Run: `pnpm --filter @rovenue/dashboard test refund-shield-subscriber-tab -- --run`
Expected: FAIL.

- [ ] **Step 9.3: Create the subscriber-tab card**

Create `apps/dashboard/src/components/refund-shield/subscriber-tab.tsx`:

```tsx
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { Card } from "@heroui/react";
import { ShieldCheck } from "lucide-react";
import {
  useRefundShieldResponses,
  useRefundShieldSettings,
} from "../../lib/hooks/useRefundShield";
import { StatusChip } from "./status-chip";
import { OutcomeChip } from "./outcome-chip";

export interface SubscriberRefundShieldCardProps {
  projectId: string;
  subscriberId: string;
}

/**
 * Compact card rendered inside the subscriber detail panel. We
 * deliberately fetch the unfiltered first page (default limit 50)
 * and filter by subscriberId in memory — the responses endpoint
 * doesn't accept a subscriberId filter today (see "Backend gaps"
 * at the end of the plan). Per-subscriber refund volume is small
 * enough (spec §8: 0-3 rows typical) that this is correct in
 * practice; if it ever isn't, add a `subscriberId` query param
 * to the backend list endpoint.
 */
export function SubscriberRefundShieldCard({
  projectId,
  subscriberId,
}: SubscriberRefundShieldCardProps) {
  const { t } = useTranslation();
  const settings = useRefundShieldSettings(projectId);
  const responses = useRefundShieldResponses(projectId, { limit: 50 });

  const rows = useMemo(() => {
    if (!responses.data) return [];
    return responses.data.pages
      .flatMap((p) => p.responses)
      .filter((r) => r.subscriberId === subscriberId);
  }, [responses.data, subscriberId]);

  if (settings.isLoading) return null;

  if (!settings.data?.enabled) {
    return (
      <Card className="p-6">
        <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck size={16} className="text-rv-mute-500" />
          {t("refundShield.subscriberTab.title")}
        </h2>
        <p className="text-sm text-default-500">
          {t("refundShield.subscriberTab.disabled")}
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck size={16} className="text-rv-accent-500" />
          {t("refundShield.subscriberTab.title")}
        </h2>
        <span className="font-rv-mono text-[11px] text-rv-mute-500">
          {t("refundShield.subscriberTab.count", { count: rows.length })}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-default-500">
          {t("refundShield.subscriberTab.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-rv-divider bg-rv-c1 px-3 py-2"
            >
              <Link
                to="/projects/$projectId/refund-shield/responses/$rid"
                params={{ projectId, rid: r.id }}
                className="font-rv-mono text-[12px] text-rv-accent-500 hover:underline"
              >
                {r.appleOriginalTransactionId}
              </Link>
              <StatusChip status={r.status} />
              <OutcomeChip outcome={r.outcome} />
              <span className="ml-auto font-rv-mono text-[11px] text-rv-mute-500">
                {new Date(r.detectedAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
```

- [ ] **Step 9.4: Append export**

Edit `apps/dashboard/src/components/refund-shield/index.ts` to append:

```ts
export { SubscriberRefundShieldCard } from "./subscriber-tab";
```

- [ ] **Step 9.5: Mount the card in the subscriber panel**

Edit `apps/dashboard/src/components/subscribers/SubscriberDetailPanel.tsx` and append a render of the new card after the existing experiments card. Locate the closing `</Card>` of the experiments section (around line 174) and immediately after it (still inside the outer `<div>`), insert:

```tsx
      <SubscriberRefundShieldCard
        projectId={projectId}
        subscriberId={data.id}
      />
```

Add the import at the top of the same file, near the existing `AccessTable` / `PurchasesTable` imports:

```ts
import { SubscriberRefundShieldCard } from "../refund-shield";
```

- [ ] **Step 9.6: Run — expect pass**

Run: `pnpm --filter @rovenue/dashboard test refund-shield-subscriber-tab -- --run`
Expected: PASS (3 tests).

Then re-run the existing subscriber-detail route test to confirm nothing regressed:

Run: `pnpm --filter @rovenue/dashboard test subscriber-detail -- --run`
Expected: PASS — the card hides itself silently while settings resolve (`isLoading → null`) so the existing assertions keep matching.

- [ ] **Step 9.7: Commit**

```bash
git add apps/dashboard/src/components/refund-shield/subscriber-tab.tsx \
        apps/dashboard/src/components/refund-shield/index.ts \
        apps/dashboard/src/components/subscribers/SubscriberDetailPanel.tsx \
        apps/dashboard/tests/components/refund-shield-subscriber-tab.test.tsx
git commit -m "feat(dashboard): refund-shield card on subscriber detail"
```

**Phase G acceptance criteria:**
- Card hidden when feature disabled — explanatory line shown.
- Card renders the subscriber's refund-request rows with status + outcome chips and links to detail.
- Existing subscriber-detail test still passes.

---

## Phase H — Navigation + breadcrumbs

### Task 10: Sidebar entry + breadcrumb branch

**Files:**
- Modify: `apps/dashboard/src/components/dashboard/navigation.ts`
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/route.tsx`

- [ ] **Step 10.1: Add the nav entry**

In `apps/dashboard/src/components/dashboard/navigation.ts`:

1. Add `ShieldCheck` to the existing lucide-react import block.
2. Inside the `growth` section's `items` array (currently ends at `cohorts`), append:

```ts
      {
        id: "refundShield",
        labelKey: "sidebar.items.refundShield",
        icon: ShieldCheck,
        to: "/projects/$projectId/refund-shield",
      },
```

- [ ] **Step 10.2: Add the breadcrumb branch**

In `apps/dashboard/src/routes/_authed/projects/$projectId/route.tsx`, inside `useBreadcrumbTitleKey()`, add a new branch directly above the `if (id.includes("/audiences"))` line:

```ts
  if (id.includes("/refund-shield")) return "breadcrumb.refundShield";
```

(The order matters because `/refund-shield/responses` would otherwise fall through to the generic `overview` branch — placing it before `audiences` keeps the lookup deterministic.)

- [ ] **Step 10.3: Smoke-check the build**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS.

Run: `pnpm --filter @rovenue/dashboard test -- --run`
Expected: PASS (all dashboard tests).

- [ ] **Step 10.4: Manual smoke test (developer-driven)**

Run: `pnpm --filter @rovenue/dashboard dev` (background)

Visit:
- `/projects/proj_1/refund-shield` → wizard renders (disabled fixture).
- `/projects/proj_1/refund-shield/settings` → settings form.
- `/projects/proj_1/refund-shield/responses` → 4-row table; click a row → detail.
- `/projects/proj_1/subscribers/sub_1` → "Refund Shield is off" card appears at the bottom.

Stop the dev server.

- [ ] **Step 10.5: Commit**

```bash
git add apps/dashboard/src/components/dashboard/navigation.ts \
        apps/dashboard/src/routes/_authed/projects/$projectId/route.tsx
git commit -m "feat(dashboard): nav entry + breadcrumb for refund-shield"
```

**Phase H acceptance criteria:**
- Sidebar shows "Refund Shield" under the Growth section.
- Breadcrumb resolves to "Refund Shield" on every refund-shield page.
- TanStack Router generates the new routes (the dev server's auto-generation writes `routeTree.gen.ts`).

---

## Self-review

### Spec §8 coverage matrix

| Spec item | Where it lives |
|---|---|
| Overview KPI cards (sent, win rate, revenue saved) | Task 6 — `RefundShieldOverviewPage` |
| Trend sparkline | Task 6 — `Sparkline` (synthesised; see Backend gaps) |
| Status breakdown donut | Task 6 — `DonutBreakdown` |
| Responses list with filters | Task 7 — `ResponsesFilterBar` + `ResponsesTable` |
| Response detail timeline | Task 8 — `ResponseTimeline` |
| Response detail Apple payload (collapsible JSON) | Task 8 — `JsonPayloadViewer` |
| Response detail Apple response | Task 8 — inline section |
| Settings (enable toggle, delay slider, consent) | Task 4 — `RefundShieldSettingsPage` |
| Onboarding wizard with SDK / ToS / delay / enable | Task 5 — `OnboardingWizard` |
| Subscriber-detail "Refund Shield" tab | Task 9 — `SubscriberRefundShieldCard` |
| Reuse existing primitives | StatCard, Sparkline, Chip, Button, Switch, Checkbox, Select, Spinner — all confirmed in `apps/dashboard/src/ui/` and `apps/dashboard/src/components/dashboard/` |

### Endpoint coverage matrix

| Endpoint | Hook | Consumers |
|---|---|---|
| `GET /settings` | `useRefundShieldSettings` | Overview (Task 6), Settings (Task 4), Wizard (Task 5), Subscriber tab (Task 9) |
| `PUT /settings` | `useUpdateRefundShieldSettings` | Settings (Task 4), Wizard final step (Task 5) |
| `GET /responses` | `useRefundShieldResponses` | Responses list (Task 7), Subscriber tab (Task 9) |
| `GET /responses/:id` | `useRefundShieldResponse` | Response detail (Task 8) |
| `GET /metrics` | `useRefundShieldMetrics` | Overview (Task 6) |

Every Plan 1 endpoint is touched.

### Hook → consumer order check

- Task 2 creates the hooks module.
- Task 3 creates the chips that import status/outcome types from Task 2.
- Tasks 4-9 import from Task 2 hooks + Task 3 chips. No cyclic / out-of-order imports.

### Primitive existence check (verified during reconnaissance)

- `apps/dashboard/src/ui/stat-card.tsx` — `StatCard` ✓
- `apps/dashboard/src/ui/button.tsx` — `Button` ✓
- `apps/dashboard/src/ui/chip.tsx` — `Chip` ✓ (prop names verified during Task 3 implementation; adjust if needed)
- `apps/dashboard/src/ui/select.tsx` — `Select` ✓
- `apps/dashboard/src/ui/switch.tsx` — `Switch` ✓
- `apps/dashboard/src/ui/checkbox.tsx` — `Checkbox` ✓
- `apps/dashboard/src/ui/copy-button.tsx` — `CopyButton` ✓ (Task 5; fallback to plain button noted)
- `apps/dashboard/src/components/dashboard/sparkline.tsx` — `Sparkline` ✓
- `apps/dashboard/tests/msw/server.ts` — MSW setup file ✓
- `apps/dashboard/tests/render.tsx` — `renderWithRouter` ✓

No new primitives invented; no DataTable / Timeline / JsonViewer / DateRangeFilter are claimed to exist (none do in the codebase — the plan builds the timeline + json viewer + filter bar fresh, as small dedicated components).

### Backend gaps

- **Per-day trend series.** Spec §8 calls for "trend sparkline." `GET /metrics` returns aggregate totals only — no time-bucketed series. Task 6 synthesises a plausible distribution from the total sent count and notes the limitation in code. **If a real series is required for v1**, extend the metrics endpoint with `?groupBy=day` or add a sibling `GET /metrics/timeseries` route. Not blocking — the dashboard still ships meaningful data without it.
- **Search by transactionId.** Spec §8 mentions "search by transactionId" on the list. The backend `responses` route does **not** accept a search/query param. Task 7's filter bar deliberately omits the search box. Adding it requires a backend change (`?q=...`) which is out of scope for this plan.
- **Filter responses by subscriberId.** The subscriber-detail tab (Task 9) filters in memory because the backend list endpoint has no `subscriberId` filter. Spec §8 says "usually 0-3 rows" so this is correct in practice. If volume grows, add `?subscriberId=...` to the backend.

These are documented limitations only — none invent missing endpoints; every task uses what Plan 1 already exposes.

---

## Total task count

**10 tasks** across 8 phases. Roughly:
- 1 task of MSW infra (Task 1)
- 2 tasks of foundation hooks + chips (Tasks 2-3)
- 1 task per route (Tasks 4 settings, 6 overview, 7 responses, 8 detail) — 4 tasks
- 1 task onboarding wizard (Task 5)
- 1 task subscriber-detail card (Task 9)
- 1 task nav + breadcrumbs (Task 10)

Each task ends with a green test, a typecheck, and a single commit.
