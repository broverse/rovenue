import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// GET /dashboard/projects/:projectId/charts/series/:chartId
// =============================================================
//
// Thin HTTP layer over `readChartSeries` (Task 2). The service
// already answers `supported: false` (no ClickHouse queries) for
// any catalog id without a wired reader, and for ids outside the
// catalog entirely — this route must pass both straight through as
// 200s, not turn either into a 404/501. Only a real access-control
// rejection should produce a non-200.
//
// Mounts just the inner route with a light middleware shim for
// `user` (mirrors dashboard-placements-metrics-arg.test.ts) so we
// bypass the dashboard auth chain and mock `readChartSeries` /
// `assertProjectAccess` directly rather than the full auth+db stack.

const readChartSeriesMock = vi.hoisted(() => vi.fn());

vi.mock("../src/services/metrics/charts", () => ({
  __chartsConstants: { WINDOW_DEFAULT_DAYS: 28, WINDOW_MAX_DAYS: 365 },
  readChannels: vi.fn(),
  readFilterOptions: vi.fn(),
  readFunnel: vi.fn(),
  readHeatmap: vi.fn(),
  readChartSeries: readChartSeriesMock,
}));

vi.mock("../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));

const assertProjectAccessMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../src/lib/project-access", () => ({
  assertProjectAccess: assertProjectAccessMock,
}));

vi.mock("../src/lib/capabilities", () => ({
  assertProjectCapability: vi.fn(async () => undefined),
}));

vi.mock("@rovenue/db", () => ({
  MemberRole: { CUSTOMER_SUPPORT: "CUSTOMER_SUPPORT" },
  drizzle: {},
}));

import { Hono } from "hono";
import { chartsRoute } from "../src/routes/dashboard/charts";

function buildApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user" as never, { id: "user_test" } as never);
    await next();
  });
  app.route("/dashboard/projects/:projectId/charts", chartsRoute);
  return app;
}

describe("GET /charts/series/:chartId", () => {
  beforeEach(() => {
    readChartSeriesMock.mockReset();
    assertProjectAccessMock.mockReset();
    assertProjectAccessMock.mockResolvedValue(undefined);
  });

  it("returns the series for a supported chart id", async () => {
    readChartSeriesMock.mockResolvedValueOnce({
      chartId: "paywall_view_rate",
      unit: "percent",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-08T00:00:00.000Z",
      points: [{ bucket: "2026-07-01T00:00:00.000Z", value: 42 }],
      supported: true,
    });
    const app = buildApp();
    const res = await app.request(
      "/dashboard/projects/proj_test/charts/series/paywall_view_rate?windowDays=7",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        chartId: string;
        supported: boolean;
        unit: string;
        points: unknown[];
      };
    };
    expect(body.data.chartId).toBe("paywall_view_rate");
    expect(body.data.supported).toBe(true);
    expect(body.data.unit).toBe("percent");
    expect(Array.isArray(body.data.points)).toBe(true);
    expect(readChartSeriesMock).toHaveBeenCalledWith(
      "proj_test",
      "paywall_view_rate",
      7,
    );
  });

  it("returns 200 with supported:false for a catalog id that has no reader", async () => {
    readChartSeriesMock.mockResolvedValueOnce({
      chartId: "churn",
      unit: "count",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-08T00:00:00.000Z",
      points: [],
      supported: false,
    });
    const app = buildApp();
    const res = await app.request(
      "/dashboard/projects/proj_test/charts/series/churn?windowDays=7",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { supported: boolean; points: unknown[] };
    };
    expect(body.data.supported).toBe(false);
    expect(body.data.points).toEqual([]);
  });

  it("returns 200 with supported:false for an id that is not in the catalog at all", async () => {
    readChartSeriesMock.mockResolvedValueOnce({
      chartId: "not_a_chart",
      unit: "count",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-08T00:00:00.000Z",
      points: [],
      supported: false,
    });
    const app = buildApp();
    const res = await app.request(
      "/dashboard/projects/proj_test/charts/series/not_a_chart?windowDays=7",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { supported: boolean } };
    expect(body.data.supported).toBe(false);
  });

  it("rejects a caller without project access", async () => {
    const { HTTPException } = await import("hono/http-exception");
    assertProjectAccessMock.mockRejectedValueOnce(
      new HTTPException(403, { message: "Forbidden" }),
    );
    const app = buildApp();
    const res = await app.request(
      "/dashboard/projects/proj_test/charts/series/paywall_view_rate?windowDays=7",
    );
    expect(res.status).toBe(403);
    expect(readChartSeriesMock).not.toHaveBeenCalled();
  });
});
