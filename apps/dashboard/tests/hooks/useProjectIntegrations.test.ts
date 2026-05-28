import { describe, expect, test } from "vitest";
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
        HttpResponse.json({ data: [mockConnection] }),
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
  test("POST create returns id", async () => {
    server.use(
      http.post(`${BASE}/dashboard/projects/:projectId/integrations`, () =>
        HttpResponse.json({ data: { id: "conn_new" } }),
      ),
      http.get(`${BASE}/dashboard/projects/:projectId/integrations`, () =>
        HttpResponse.json({ data: [] }),
      ),
    );

    const { result } = renderHook(
      () => useCreateIntegration("proj_1"),
      { wrapper: makeWrapper() },
    );

    result.current.mutate({
      providerId: "META_CAPI",
      displayName: "New Connection",
      credentials: { accessToken: "tok_test" },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe("conn_new");
  });
});

describe("useUpdateIntegration", () => {
  test("PATCH update toggles isEnabled", async () => {
    server.use(
      http.patch(
        `${BASE}/dashboard/projects/:projectId/integrations/:id`,
        async ({ request }) => {
          const body = (await request.json()) as { isEnabled?: boolean };
          return HttpResponse.json({
            data: { ...mockConnection, isEnabled: body.isEnabled ?? false },
          });
        },
      ),
      http.get(`${BASE}/dashboard/projects/:projectId/integrations`, () =>
        HttpResponse.json({ data: [] }),
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
        HttpResponse.json({ data: [] }),
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
});
