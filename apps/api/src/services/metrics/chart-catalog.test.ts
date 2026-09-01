// =============================================================
// System chart catalog — the two things a catalog entry promises
// =============================================================
//
// A `SYSTEM_CATALOG` row is rendered in the dashboard's left rail and is
// selectable. That makes two promises the catalog file itself cannot
// keep on its own, and both were broken by `estimated_proceeds`:
//
//   1. It has a HUMAN LABEL. `listSystemChartEntries()` returns the id
//      as a translation slug; the dashboard resolves `charts.items.<id>`
//      and i18next has no missing-key handler, so an id with no string
//      renders in the rail as the literal text
//      "charts.items.estimated_proceeds".
//   2. It is a DAILY SERIES the `/series/:chartId` dispatcher serves, or
//      will. Most ids have no reader yet and honestly say so; proceeds
//      is a per-store breakdown that dispatcher can never express (see
//      chart-catalog.ts's comment and proceeds.ts), so listing it told
//      users the number was unavailable while `ProceedsCard` rendered it
//      two panels away.
//
// Promise 1 is checked against the dashboard's real en.json rather than
// a copy: a copy would only prove the copy is complete. The coupling is
// the point — the label and the id are one contract split across two
// apps, and the whole reason this test exists is that nothing noticed
// when half of it shipped without the other.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_CHART_IDS, isSystemChartId } from "./chart-catalog";

const EN_JSON = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../dashboard/src/i18n/locales/en.json",
);

interface EnBundle {
  charts?: { items?: Record<string, string> };
}

describe("system chart catalog", () => {
  it("every id has a `charts.items.<id>` label in the dashboard bundle", () => {
    const bundle = JSON.parse(readFileSync(EN_JSON, "utf8")) as EnBundle;
    const labels = bundle.charts?.items ?? {};

    const unlabelled = [...SYSTEM_CHART_IDS].filter((id) => !labels[id]);

    expect(
      unlabelled,
      `Catalog id(s) with no dashboard label: ${unlabelled.join(", ")}. ` +
        `The left rail renders the raw key "charts.items.<id>" for these — ` +
        `add the string to apps/dashboard/src/i18n/locales/en.json.`,
    ).toEqual([]);
  });

  it("does not list `estimated_proceeds` — it has its own reader and card, not a daily series", () => {
    expect(isSystemChartId("estimated_proceeds")).toBe(false);
  });
});
