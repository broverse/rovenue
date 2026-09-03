// =============================================================
// streamMetricsExportCsv — ClickHouse-backed metrics export (Task 6,
// 2026-09-01 analytics-integrity-and-proceeds plan)
// =============================================================
//
// This module does NOT issue any ClickHouse queries of its own — it
// composes rows purely from `readChannels` / `readProceeds` /
// `readFunnel` / `readHeatmap` / `readChartSeries` in `./charts`,
// which are already covered by the schema-contract test (charts.ts's
// exports are reflected into its REGISTRY). A second query set here
// would drift from the first and sit outside that net, so this test
// mocks `./charts` directly — proving composition/shaping, not SQL —
// exactly the same division of labour `charts.proceeds.test.ts` draws
// between itself and the schema-contract test.
//
// The truncation marker is the behaviour that matters (design spec
// §4.4, §5a): a low cap must produce a marker line and `truncated:
// true`, not a silently short CSV. The happy path passing proves
// nothing about that on its own.

import { describe, expect, it, vi } from "vitest";
import type {
  ChartChannelsResponse,
  ChartFunnelResponse,
  ChartHeatmapResponse,
  ChartProceedsResponse,
  ChartSeriesResponse,
} from "@rovenue/shared";

const readChannelsMock = vi.fn();
const readProceedsMock = vi.fn();
const readFunnelMock = vi.fn();
const readHeatmapMock = vi.fn();
const readChartSeriesMock = vi.fn();

vi.mock("./charts", () => ({
  readChannels: (...args: unknown[]) => readChannelsMock(...args),
  readProceeds: (...args: unknown[]) => readProceedsMock(...args),
  readFunnel: (...args: unknown[]) => readFunnelMock(...args),
  readHeatmap: (...args: unknown[]) => readHeatmapMock(...args),
  readChartSeries: (...args: unknown[]) => readChartSeriesMock(...args),
}));

import {
  METRICS_EXPORT_ROW_CAP,
  streamMetricsExportCsv,
  type MetricsExportSummary,
} from "./export";
import { SYSTEM_CHART_IDS } from "./chart-catalog";

const EMPTY_CHANNELS: ChartChannelsResponse = {
  windowDays: 28,
  totalUsd: "0.0000",
  rows: [],
};
const EMPTY_PROCEEDS: ChartProceedsResponse = { windowDays: 28, rows: [] };
const EMPTY_FUNNEL: ChartFunnelResponse = {
  windowDays: 28,
  steps: [],
};
const EMPTY_HEATMAP: ChartHeatmapResponse = { windowDays: 28, cells: [] };

function unsupportedSeries(chartId: string): ChartSeriesResponse {
  return {
    chartId,
    axis: "date",
    unit: "count",
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-28T00:00:00.000Z",
    points: [],
    supported: false,
  };
}

async function drain(
  gen: AsyncGenerator<string, MetricsExportSummary, void>,
): Promise<{ lines: string[]; summary: MetricsExportSummary }> {
  const lines: string[] = [];
  let next = await gen.next();
  while (!next.done) {
    lines.push(next.value);
    next = await gen.next();
  }
  return { lines, summary: next.value };
}

function resetMocksToEmpty(): void {
  readChannelsMock.mockReset().mockResolvedValue(EMPTY_CHANNELS);
  readProceedsMock.mockReset().mockResolvedValue(EMPTY_PROCEEDS);
  readFunnelMock.mockReset().mockResolvedValue(EMPTY_FUNNEL);
  readHeatmapMock.mockReset().mockResolvedValue(EMPTY_HEATMAP);
  readChartSeriesMock
    .mockReset()
    .mockImplementation(async (_projectId: string, chartId: string) =>
      unsupportedSeries(chartId),
    );
}

describe("streamMetricsExportCsv", () => {
  it("reuses the chart readers rather than issuing its own queries", async () => {
    resetMocksToEmpty();

    const { summary } = await drain(
      streamMetricsExportCsv({ projectId: "proj_1", windowDays: 28 }),
    );

    expect(readChannelsMock).toHaveBeenCalledWith("proj_1", 28);
    expect(readProceedsMock).toHaveBeenCalledWith("proj_1", 28);
    expect(readFunnelMock).toHaveBeenCalledWith("proj_1", 28);
    expect(readHeatmapMock).toHaveBeenCalledWith("proj_1", 28);
    expect(readChartSeriesMock).toHaveBeenCalledTimes(SYSTEM_CHART_IDS.size);
    expect(summary).toEqual({
      rowCount: 0,
      truncated: false,
      erroredChartIds: [],
    });
  });

  it("emits a header and one row per (store, metric) pair for channels/proceeds, per step for funnel, per cell for heatmap, per point for a supported series", async () => {
    resetMocksToEmpty();
    readChannelsMock.mockResolvedValue({
      windowDays: 28,
      totalUsd: "100.0000",
      rows: [
        { store: "APP_STORE", grossUsd: "100.0000", pct: 100, eventCount: 3 },
      ],
    } satisfies ChartChannelsResponse);
    readProceedsMock.mockResolvedValue({
      windowDays: 28,
      rows: [
        {
          store: "APP_STORE",
          grossUsd: "100.0000",
          refundsUsd: "0.0000",
          netUsd: "100.0000",
          rate: 0.15,
          proceedsUsd: "85.0000",
        },
        {
          store: "PLAY_STORE",
          grossUsd: "50.0000",
          refundsUsd: "0.0000",
          netUsd: "50.0000",
          rate: null,
          proceedsUsd: null,
        },
      ],
    } satisfies ChartProceedsResponse);
    readFunnelMock.mockResolvedValue({
      windowDays: 28,
      steps: [{ key: "purchase", count: 10, pct: 100 }],
    } satisfies ChartFunnelResponse);
    readHeatmapMock.mockResolvedValue({
      windowDays: 28,
      cells: [{ dow: 1, hour: 9, count: 4 }],
    } satisfies ChartHeatmapResponse);
    readChartSeriesMock.mockImplementation(
      async (_projectId: string, chartId: string) => {
        if (chartId === "paywall_view_rate") {
          return {
            chartId,
            axis: "date",
            unit: "percent",
            from: "2026-07-01T00:00:00.000Z",
            to: "2026-07-02T00:00:00.000Z",
            points: [
              {
                bucket: "2026-07-01T00:00:00.000Z",
                value: 42,
                numerator: 4,
                denominator: 10,
              },
            ],
            supported: true,
          } satisfies ChartSeriesResponse;
        }
        return unsupportedSeries(chartId);
      },
    );

    const { lines, summary } = await drain(
      streamMetricsExportCsv({ projectId: "proj_1", windowDays: 28 }),
    );

    expect(lines[0]).toBe(
      "kind,chart_id,store,bucket,period,dow,hour,step,metric,value,unit\n",
    );
    const body = lines.slice(1).join("");

    // channels: gross_usd, pct, event_count
    expect(body).toContain("channels,,APP_STORE,,,,,,gross_usd,100.0000,usd\n");
    expect(body).toContain("channels,,APP_STORE,,,,,,pct,100,percent\n");
    expect(body).toContain("channels,,APP_STORE,,,,,,event_count,3,count\n");

    // proceeds: configured-rate store carries a real rate/proceeds
    expect(body).toContain("proceeds,,APP_STORE,,,,,,rate,0.15,ratio\n");
    expect(body).toContain(
      "proceeds,,APP_STORE,,,,,,proceeds_usd,85.0000,usd\n",
    );
    // unconfigured-rate store: BOTH rate and proceeds_usd blank, never a
    // silent 0% (mirrors readProceeds's own null-together contract)
    expect(body).toContain("proceeds,,PLAY_STORE,,,,,,rate,,ratio\n");
    expect(body).toContain("proceeds,,PLAY_STORE,,,,,,proceeds_usd,,usd\n");

    // funnel
    expect(body).toContain("funnel,,,,,,,purchase,count,10,count\n");
    expect(body).toContain("funnel,,,,,,,purchase,pct,100,percent\n");

    // heatmap
    expect(body).toContain("heatmap,,,,,1,9,,count,4,count\n");

    // series: only the supported chart id produces rows
    expect(body).toContain(
      "series,paywall_view_rate,,2026-07-01T00:00:00.000Z,,,,,value,42,percent\n",
    );
    const unsupportedIds = [...SYSTEM_CHART_IDS].filter(
      (id) => id !== "paywall_view_rate",
    );
    for (const id of unsupportedIds) {
      expect(body).not.toContain(`series,${id},`);
    }

    expect(summary.truncated).toBe(false);
    expect(summary.rowCount).toBeGreaterThan(0);
  });

  it("emits a period, and no bucket, for a cohort-axis series", async () => {
    // retention_curve/ltv have no calendar date at all. The row must
    // carry the period index in its own column and leave `bucket`
    // blank — writing a period into a date column is the exact
    // fabrication ChartSeriesAxis exists to prevent.
    resetMocksToEmpty();
    readChartSeriesMock.mockImplementation(
      async (_projectId: string, chartId: string) => {
        if (chartId === "retention_curve") {
          return {
            chartId,
            axis: "period",
            periodGranularity: "week",
            unit: "percent",
            from: "2026-07-01T00:00:00.000Z",
            to: "2026-07-28T00:00:00.000Z",
            points: [
              { period: 0, value: 100, numerator: 200, denominator: 200 },
              { period: 1, value: 41, numerator: 82, denominator: 200 },
            ],
            supported: true,
          } satisfies ChartSeriesResponse;
        }
        return unsupportedSeries(chartId);
      },
    );

    const { lines } = await drain(
      streamMetricsExportCsv({ projectId: "proj_1", windowDays: 28 }),
    );
    const body = lines.slice(1).join("");

    expect(body).toContain("series,retention_curve,,,0,,,,value,100,percent\n");
    expect(body).toContain("series,retention_curve,,,1,,,,value,41,percent\n");
  });

  it("maps a series response's money unit to this export's own 'usd' vocabulary (task-2 revenue ids)", async () => {
    resetMocksToEmpty();
    readChartSeriesMock.mockImplementation(
      async (_projectId: string, chartId: string) => {
        if (chartId === "mrr") {
          return {
            chartId,
            axis: "date",
            unit: "money",
            from: "2026-07-01T00:00:00.000Z",
            to: "2026-07-01T00:00:00.000Z",
            points: [{ bucket: "2026-07-01T00:00:00.000Z", value: 500 }],
            supported: true,
          } satisfies ChartSeriesResponse;
        }
        return unsupportedSeries(chartId);
      },
    );

    const { lines } = await drain(
      streamMetricsExportCsv({ projectId: "proj_1", windowDays: 28 }),
    );
    const body = lines.slice(1).join("");

    // "money" (ChartSeriesResponse's vocabulary) becomes "usd" (this
    // export's vocabulary) — never passed through raw as "money".
    expect(body).toContain(
      "series,mrr,,2026-07-01T00:00:00.000Z,,,,,value,500,usd\n",
    );
    expect(body).not.toContain(",money\n");
  });

  it("appends an explicit truncation marker and stops early once the row cap is hit — a silently truncated export is a lying export", async () => {
    resetMocksToEmpty();
    // Force the cap well below the natural row count: one store with
    // 5 channel rows worth of metrics (gross_usd/pct/event_count = 3
    // rows) is already enough to exceed a cap of 2.
    readChannelsMock.mockResolvedValue({
      windowDays: 28,
      totalUsd: "100.0000",
      rows: [
        { store: "APP_STORE", grossUsd: "100.0000", pct: 100, eventCount: 3 },
      ],
    } satisfies ChartChannelsResponse);

    const CAP_FOR_TEST = 2;
    const { lines, summary } = await drain(
      streamMetricsExportCsv(
        { projectId: "proj_1", windowDays: 28 },
        CAP_FOR_TEST,
      ),
    );

    expect(summary.truncated).toBe(true);
    expect(summary.rowCount).toBe(CAP_FOR_TEST);
    const markerLine = lines.find((l) => l.startsWith("#"));
    expect(markerLine).toBe(`# truncated at ${CAP_FOR_TEST} rows\n`);
    // The marker must be the LAST line — nothing keeps streaming after it.
    expect(lines[lines.length - 1]).toBe(markerLine);
    // Downstream readers (proceeds/funnel/heatmap/series) must never be
    // reached once the cap has already been hit by an earlier section.
    expect(readProceedsMock).not.toHaveBeenCalled();
    expect(readFunnelMock).not.toHaveBeenCalled();
    expect(readHeatmapMock).not.toHaveBeenCalled();
    expect(readChartSeriesMock).not.toHaveBeenCalled();
  });

  it("has a sane default cap, exported as a named constant (no magic values)", () => {
    expect(METRICS_EXPORT_ROW_CAP).toBeGreaterThan(1000);
  });

  it("fires every chart-id reader concurrently, not one after another (Task 6, Step 4)", async () => {
    resetMocksToEmpty();
    const ids = [...SYSTEM_CHART_IDS];
    let callsSoFarAtFirstResume = -1;
    readChartSeriesMock.mockImplementation(
      async (_projectId: string, chartId: string) => {
        // Yield to the microtask queue without a real timer, THEN read
        // how many calls have been made in total. If the export awaited
        // each reader in turn, only the ONE call that's currently
        // executing would exist by the time its own continuation
        // resumes. If it fans every id out synchronously first (via
        // `.map` + Promise.allSettled, as it now does), every other
        // mock invocation has already been registered before this
        // (the first-scheduled) continuation gets to run.
        await Promise.resolve();
        if (callsSoFarAtFirstResume === -1) {
          callsSoFarAtFirstResume = readChartSeriesMock.mock.calls.length;
        }
        return unsupportedSeries(chartId);
      },
    );

    await drain(streamMetricsExportCsv({ projectId: "proj_1", windowDays: 28 }));

    expect(callsSoFarAtFirstResume).toBe(ids.length);
  });

  it("does not abort the export when a single chart-id reader throws mid-stream (Task 6, Step 5)", async () => {
    resetMocksToEmpty();
    const ids = [...SYSTEM_CHART_IDS];
    const failingIndex = Math.floor(ids.length / 2);
    const FAILING_ID = ids[failingIndex]!;
    // Deliberately AFTER the failing id in iteration order — proves the
    // failure didn't stop the fan-out from reaching ids later in the
    // catalog, not just ones already resolved before it.
    const SURVIVING_ID = ids[failingIndex + 1]!;
    const FAILURE_MESSAGE = "ClickHouse connection reset";

    readChartSeriesMock.mockImplementation(
      async (_projectId: string, chartId: string) => {
        if (chartId === FAILING_ID) {
          throw new Error(FAILURE_MESSAGE);
        }
        if (chartId === SURVIVING_ID) {
          return {
            chartId,
            axis: "date",
            unit: "count",
            from: "2026-07-01T00:00:00.000Z",
            to: "2026-07-02T00:00:00.000Z",
            points: [{ bucket: "2026-07-01T00:00:00.000Z", value: 7 }],
            supported: true,
          } satisfies ChartSeriesResponse;
        }
        return unsupportedSeries(chartId);
      },
    );

    const { lines, summary } = await drain(
      streamMetricsExportCsv({ projectId: "proj_1", windowDays: 28 }),
    );
    const body = lines.join("");

    // Every id was still attempted — the failure of one did not stop
    // the fan-out from reaching the rest.
    expect(readChartSeriesMock).toHaveBeenCalledTimes(ids.length);

    // The failing id's own error is named on a marker line...
    const errorLine = lines.find(
      (l) => l.startsWith("#") && l.includes(FAILING_ID),
    );
    expect(errorLine).toBe(`# error: chart_id=${FAILING_ID}: ${FAILURE_MESSAGE}\n`);

    // ...but a chart id that comes AFTER the failing one in iteration
    // order still streamed its real data. This is the crux of the
    // proof: the failure did not truncate the rest of the export.
    expect(body).toContain(
      `series,${SURVIVING_ID},,2026-07-01T00:00:00.000Z,,,,,value,7,count\n`,
    );

    // The export completes normally (not truncated) and names the
    // failing id for the caller/audit log, rather than silently
    // swallowing which chart went missing.
    expect(summary.truncated).toBe(false);
    expect(summary.erroredChartIds).toEqual([FAILING_ID]);

    // The generator itself never threw — drain() would have rejected
    // if it had.
  });
});
