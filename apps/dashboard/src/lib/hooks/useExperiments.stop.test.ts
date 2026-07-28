import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useStopExperiment } from "./useExperiments";

// =============================================================
// useStopExperiment — placements invalidation on winner-stop.
// Since the server rewrites placement rows when a winner is declared,
// the mutation must also invalidate the ["placements"] query key, but
// only when the stop body carried a winnerVariantId (a winnerless stop
// touches no placement rows). Harness mirrors experiment-popover.test.tsx:
// `rpc`/`unwrap` mocked at the transport layer, mutation runs for real
// inside a real QueryClientProvider.
// =============================================================

const stopPost = vi.hoisted(() => vi.fn());

vi.mock("../api", () => ({
  rpc: {
    dashboard: {
      experiments: {
        ":id": { stop: { $post: stopPost } },
      },
    },
  },
  unwrap: vi.fn(async (p: unknown) => p),
}));

function fakeExperiment(overrides: Record<string, unknown> = {}) {
  return {
    id: "exp_1",
    projectId: "p_1",
    name: "Main paywall A/B",
    description: null,
    type: "PAYWALL",
    key: "main-ab",
    audienceId: "aud_default",
    status: "COMPLETED",
    variants: [],
    metrics: null,
    mutualExclusionGroup: null,
    startedAt: null,
    completedAt: "2026-07-28T00:00:00.000Z",
    winnerVariantId: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useStopExperiment — placements invalidation", () => {
  it("invalidates the placements query key when the stop body carries a winnerVariantId", async () => {
    stopPost.mockResolvedValue({
      experiment: fakeExperiment({ winnerVariantId: "a" }),
      promotedFlag: null,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useStopExperiment(), { wrapper: wrapper(qc) });

    result.current.mutate({ id: "exp_1", body: { winnerVariantId: "a" } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["placements"] });
  });

  it("does not invalidate the placements query key on a winnerless stop", async () => {
    stopPost.mockResolvedValue({
      experiment: fakeExperiment({ winnerVariantId: null }),
      promotedFlag: null,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useStopExperiment(), { wrapper: wrapper(qc) });

    result.current.mutate({ id: "exp_1" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["placements"] });
  });
});
