import { describe, expect, test, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { server } from "../msw/server";
import {
  useProjectIntegrations,
  useCreateIntegration,
  useUpdateIntegration,
  useDeleteIntegration,
  useValidateIntegrationCredentials,
  useTestIntegrationEvent,
  useIntegrationDeliveries,
  useRotateWebhookSecret,
  useRevealWebhookSecret,
  useRedeliverDelivery,
  type IntegrationConnectionRow,
  type IntegrationDeliveryRow,
} from "../../src/lib/hooks/useProjectIntegrations";

const BASE = "http://localhost:3000";

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

const mockDelivery: IntegrationDeliveryRow = {
  id: "del_1",
  connectionId: "conn_1",
  outboxEventId: "obx_1",
  eventKey: "purchase",
  providerEvent: "Purchase",
  status: "succeeded",
  attempt: 1,
  httpStatus: 200,
  responseBody: '{"events_received":1}',
  errorMessage: null,
  skipReason: null,
  createdAt: "2026-05-27T12:00:00Z",
};

const mockConnection: IntegrationConnectionRow = {
  id: "conn_1",
  providerId: "META_CAPI",
  displayName: "Meta CAPI (Production)",
  credentialsHint: "***1234",
  enabledEvents: ["purchase", "trial_started"],
  eventMapping: { purchase: { eventName: "Purchase" } },
  actionSource: "app",
  testEventCode: null,
  isEnabled: true,
  lastValidatedAt: "2026-05-27T10:00:00Z",
  lastError: null,
  lastBackfillAt: null,
  createdAt: "2026-05-20T00:00:00Z",
  updatedAt: "2026-05-27T10:00:00Z",
};

// ---------------------------------------------------------------------------
// M6.1 — useProjectIntegrations (list)
// ---------------------------------------------------------------------------

describe("useProjectIntegrations", () => {
  test("returns META_CAPI row from GET /integrations", async () => {
    server.use(
      http.get(`${BASE}/dashboard/projects/:projectId/integrations`, () =>
        // The real route returns `ok({ connections: rows })`
        // (apps/api/src/routes/dashboard/integrations.ts:197), so after
        // `api()` unwraps the envelope the hook reads `.connections`.
        // Mocking a bare array made the hook read `.connections` off an
        // array and get undefined — the mock described a response the
        // server has never produced.
        HttpResponse.json({ data: { connections: [mockConnection] } }),
      ),
    );

    const { result } = renderHook(
      () => useProjectIntegrations("proj_1"),
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.providerId).toBe("META_CAPI");
  });
});

// ---------------------------------------------------------------------------
// M6.2 — Create / Update / Delete mutations
// ---------------------------------------------------------------------------

describe("useCreateIntegration", () => {
  test("POST create returns the connection (and no secret for a non-webhook provider)", async () => {
    server.use(
      http.post(`${BASE}/dashboard/projects/:projectId/integrations`, () =>
        // `ok({ connection: row })` — integrations.ts:289.
        HttpResponse.json({
          data: { connection: { ...mockConnection, id: "conn_new" } },
        }),
      ),
      http.get(`${BASE}/dashboard/projects/:projectId/integrations`, () =>
        HttpResponse.json({ data: { connections: [] } }),
      ),
    );

    const { result } = renderHook(
      () => useCreateIntegration("proj_1"),
      { wrapper: makeWrapper() },
    );

    result.current.mutate({
      providerId: "META_CAPI",
      displayName: "New Connection",
      credentials: { access_token: "tok_test" },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.connection.id).toBe("conn_new");
    expect(result.current.data?.secret).toBeUndefined();
  });

  test("POST create for CUSTOM_WEBHOOK returns the server-generated secret", async () => {
    server.use(
      http.post(`${BASE}/dashboard/projects/:projectId/integrations`, () =>
        // `ok({ connection: row, secret })` — createWebhookConnection in
        // integrations.ts.
        HttpResponse.json({
          data: {
            connection: { ...mockConnection, id: "wh_new", providerId: "CUSTOM_WEBHOOK" },
            secret: "whsec_abc123",
          },
        }),
      ),
    );

    const { result } = renderHook(
      () => useCreateIntegration("proj_1"),
      { wrapper: makeWrapper() },
    );

    result.current.mutate({
      providerId: "CUSTOM_WEBHOOK",
      displayName: "api.example.com",
      credentials: { url: "https://api.example.com/hooks" },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.connection.id).toBe("wh_new");
    expect(result.current.data?.secret).toBe("whsec_abc123");
  });
});

describe("useUpdateIntegration", () => {
  test("PATCH update toggles isEnabled", async () => {
    server.use(
      http.patch(
        `${BASE}/dashboard/projects/:projectId/integrations/:id`,
        async ({ request }) => {
          const body = (await request.json()) as { isEnabled?: boolean };
          // `ok({ connection: updated })` — integrations.ts:545.
          return HttpResponse.json({
            data: {
              connection: {
                ...mockConnection,
                isEnabled: body.isEnabled ?? false,
              },
            },
          });
        },
      ),
      http.get(`${BASE}/dashboard/projects/:projectId/integrations`, () =>
        HttpResponse.json({ data: { connections: [] } }),
      ),
    );

    const { result } = renderHook(
      () => useUpdateIntegration("proj_1"),
      { wrapper: makeWrapper() },
    );

    result.current.mutate({ connectionId: "conn_1", body: { isEnabled: false } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect((result.current.data as IntegrationConnectionRow).isEnabled).toBe(false);
  });
});

describe("useDeleteIntegration", () => {
  test("DELETE marks isSuccess", async () => {
    server.use(
      http.delete(
        `${BASE}/dashboard/projects/:projectId/integrations/:id`,
        () => HttpResponse.json({ data: { deleted: true } }),
      ),
      http.get(`${BASE}/dashboard/projects/:projectId/integrations`, () =>
        HttpResponse.json({ data: { connections: [] } }),
      ),
    );

    const { result } = renderHook(
      () => useDeleteIntegration("proj_1"),
      { wrapper: makeWrapper() },
    );

    result.current.mutate("conn_1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});

// ---------------------------------------------------------------------------
// M6.3 — Validate + test-event mutations
// ---------------------------------------------------------------------------

describe("useValidateIntegrationCredentials", () => {
  test("POST /validate returns ok:true", async () => {
    server.use(
      http.post(
        `${BASE}/dashboard/projects/:projectId/integrations/:id/validate`,
        () => HttpResponse.json({ data: { ok: true } }),
      ),
    );

    const { result } = renderHook(
      () => useValidateIntegrationCredentials("proj_1"),
      { wrapper: makeWrapper() },
    );

    result.current.mutate("conn_1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect((result.current.data as { ok: boolean }).ok).toBe(true);
  });
});

describe("useTestIntegrationEvent", () => {
  test("POST /test-event returns ok + httpStatus", async () => {
    server.use(
      http.post(
        `${BASE}/dashboard/projects/:projectId/integrations/:id/test-event`,
        () =>
          HttpResponse.json({
            data: { ok: true, httpStatus: 200, responseBody: '{"success":1}' },
          }),
      ),
    );

    const { result } = renderHook(
      () => useTestIntegrationEvent("proj_1", "conn_1"),
      { wrapper: makeWrapper() },
    );

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.ok).toBe(true);
    expect(result.current.data?.httpStatus).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// M6.4 — useIntegrationDeliveries (infinite query)
// ---------------------------------------------------------------------------

describe("useIntegrationDeliveries", () => {
  test("single page returned; data.pages[0].deliveries has length 1", async () => {
    server.use(
      http.get(
        `${BASE}/dashboard/projects/:projectId/integrations/:id/deliveries`,
        () =>
          HttpResponse.json({
            data: { deliveries: [mockDelivery], nextCursor: null },
          }),
      ),
    );

    const { result } = renderHook(
      () => useIntegrationDeliveries("proj_1", "conn_1"),
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pages[0]?.deliveries).toHaveLength(1);
  });

  test("passes the status filter through as a query param", async () => {
    let capturedStatus: string | null = null;
    server.use(
      http.get(
        `${BASE}/dashboard/projects/:projectId/integrations/:id/deliveries`,
        ({ request }) => {
          capturedStatus = new URL(request.url).searchParams.get("status");
          return HttpResponse.json({
            data: { deliveries: [mockDelivery], nextCursor: null },
          });
        },
      ),
    );

    const { result } = renderHook(
      () => useIntegrationDeliveries("proj_1", "conn_1", { status: "dead_letter" }),
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedStatus).toBe("dead_letter");
  });
});

// ---------------------------------------------------------------------------
// Task 12 — webhook secret rotate/reveal + manual redeliver
// ---------------------------------------------------------------------------

describe("useRotateWebhookSecret", () => {
  test("POST rotate-secret returns the new secret", async () => {
    server.use(
      http.post(
        `${BASE}/dashboard/projects/:projectId/integrations/:id/rotate-secret`,
        () => HttpResponse.json({ data: { secret: "whsec_rotated" } }),
      ),
      http.get(`${BASE}/dashboard/projects/:projectId/integrations`, () =>
        HttpResponse.json({ data: { connections: [] } }),
      ),
    );

    const { result } = renderHook(
      () => useRotateWebhookSecret("proj_1"),
      { wrapper: makeWrapper() },
    );

    result.current.mutate("wh_1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.secret).toBe("whsec_rotated");
  });
});

describe("useRevealWebhookSecret", () => {
  test("GET secret returns the current secret", async () => {
    server.use(
      http.get(
        `${BASE}/dashboard/projects/:projectId/integrations/:id/secret`,
        () => HttpResponse.json({ data: { secret: "whsec_revealed" } }),
      ),
    );

    const { result } = renderHook(
      () => useRevealWebhookSecret("proj_1"),
      { wrapper: makeWrapper() },
    );

    result.current.mutate("wh_1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.secret).toBe("whsec_revealed");
  });
});

describe("useRedeliverDelivery", () => {
  test("POST redeliver returns enqueued:true and invalidates the deliveries query", async () => {
    server.use(
      http.post(
        `${BASE}/dashboard/projects/:projectId/integrations/:id/deliveries/:deliveryId/redeliver`,
        () => HttpResponse.json({ data: { enqueued: true } }, { status: 202 }),
      ),
      http.get(
        `${BASE}/dashboard/projects/:projectId/integrations/:id/deliveries`,
        () =>
          HttpResponse.json({
            data: { deliveries: [mockDelivery], nextCursor: null },
          }),
      ),
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const deliveries = renderHook(
      () => useIntegrationDeliveries("proj_1", "conn_1"),
      { wrapper },
    );
    await waitFor(() => expect(deliveries.result.current.isSuccess).toBe(true));

    const { result } = renderHook(
      () => useRedeliverDelivery("proj_1", "conn_1"),
      { wrapper },
    );

    result.current.mutate("del_1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.enqueued).toBe(true);
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["integration-deliveries", "proj_1", "conn_1"],
      }),
    );
  });
});
