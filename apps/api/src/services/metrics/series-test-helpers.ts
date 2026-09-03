import type {
  ChartSeriesDateResponse,
  ChartSeriesPeriodResponse,
  ChartSeriesResponse,
} from "@rovenue/shared";

// =============================================================
// Narrowing helpers for chart-series assertions
// =============================================================
//
// `ChartSeriesResponse` is a union discriminated on `axis`, so
// `res.points[0].bucket` does not type-check until the response has
// been narrowed. These two helpers narrow AND assert: a reader that
// silently changed axis fails here with a readable message instead of
// a cast quietly hiding it.
//
// Not imported by any runtime module — tsup's entry is src/index.ts, so
// nothing here ships.

export function asDateSeries(res: ChartSeriesResponse): ChartSeriesDateResponse {
  if (res.axis !== "date") {
    throw new Error(
      `expected chart "${res.chartId}" on a date axis, got "${res.axis}"`,
    );
  }
  return res;
}

export function asPeriodSeries(
  res: ChartSeriesResponse,
): ChartSeriesPeriodResponse {
  if (res.axis !== "period") {
    throw new Error(
      `expected chart "${res.chartId}" on a period axis, got "${res.axis}"`,
    );
  }
  return res;
}
