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
