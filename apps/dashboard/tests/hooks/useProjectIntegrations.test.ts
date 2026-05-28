import { describe, expect, test } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { server } from "../msw/server";
import {
  useProjectIntegrations,
  type IntegrationConnectionRow,
} from "../../src/lib/hooks/useProjectIntegrations";

const BASE = "http://localhost:3000";

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

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
