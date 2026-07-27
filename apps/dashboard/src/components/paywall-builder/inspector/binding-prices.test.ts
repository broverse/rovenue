import { describe, expect, it } from "vitest";
import type { OfferingResolvedPrices, ResolvedPackageInfo, ResolvedStoreEntry } from "@rovenue/shared";
import {
  PERIOD_LABELS,
  activePresetId,
  availablePresets,
  buildPriceRows,
  formatMinorAmount,
  packagePeriod,
  periodLabel,
  periodNoun,
  presetSelection,
  storeBadgeText,
  type PackagePriceRow,
} from "./binding-prices";

function pkg(overrides: Partial<ResolvedPackageInfo> = {}): ResolvedPackageInfo {
  return {
    packageIdentifier: "pkg_monthly",
    productId: "prod_monthly",
    displayName: "Monthly",
    metadataPeriod: "P1M",
    stores: {},
    ...overrides,
  };
}

describe("packagePeriod", () => {
  it("returns the shared period when all ok stores agree", () => {
    const info = pkg({
      stores: {
        apple: { status: "ok", amountMinor: 999, currency: "USD", period: "P1M", trialDays: null },
        google: { status: "ok", amountMinor: 999, currency: "USD", period: "P1M", trialDays: null },
      },
    });
    expect(packagePeriod(info)).toEqual({ period: "P1M", conflict: false });
  });

  it("picks the most frequent period and flags a conflict on disagreement", () => {
    const info = pkg({
      stores: {
        apple: { status: "ok", amountMinor: 999, currency: "USD", period: "P1M", trialDays: null },
        google: { status: "ok", amountMinor: 999, currency: "USD", period: "P1M", trialDays: null },
        stripe: { status: "ok", amountMinor: 999, currency: "USD", period: "P1Y", trialDays: null },
      },
    });
    expect(packagePeriod(info)).toEqual({ period: "P1M", conflict: true });
  });

  it("breaks frequency ties by store precedence apple > google > stripe", () => {
    const info = pkg({
      stores: {
        google: { status: "ok", amountMinor: 999, currency: "USD", period: "P1Y", trialDays: null },
        stripe: { status: "ok", amountMinor: 999, currency: "USD", period: "P1M", trialDays: null },
      },
    });
    // no apple entry; google is the highest-precedence ok store present, so
    // its period (P1Y) wins the tie over stripe's P1M.
    expect(packagePeriod(info)).toEqual({ period: "P1Y", conflict: true });
  });

  it("falls back to metadataPeriod when there are no ok entries", () => {
    const info = pkg({
      metadataPeriod: "P1M",
      stores: {
        apple: { status: "not_configured" },
        google: { status: "error" },
      },
    });
    expect(packagePeriod(info)).toEqual({ period: "P1M", conflict: false });
  });

  it("falls back to a null metadataPeriod when there are no ok entries and no metadata", () => {
    const info = pkg({ metadataPeriod: null, stores: { stripe: { status: "no_mapping" } } });
    expect(packagePeriod(info)).toEqual({ period: null, conflict: false });
  });
});

describe("buildPriceRows", () => {
  const resolved: OfferingResolvedPrices = {
    offeringId: "off_1",
    fetchedAt: "2026-07-27T00:00:00.000Z",
    packages: [
      pkg({
        packageIdentifier: "pkg_annual",
        displayName: "Annual",
        metadataPeriod: "P1Y",
        stores: { apple: { status: "ok", amountMinor: 9999, currency: "USD", period: "P1Y", trialDays: null } },
      }),
      pkg({
        packageIdentifier: "pkg_monthly",
        displayName: "Monthly",
        metadataPeriod: "P1M",
        stores: { apple: { status: "ok", amountMinor: 999, currency: "USD", period: "P1M", trialDays: 7 } },
      }),
    ],
  };

  it("preserves offering order, not resolved.packages order", () => {
    const rows = buildPriceRows(["pkg_monthly", "pkg_annual"], resolved);
    expect(rows.map((r) => r.packageIdentifier)).toEqual(["pkg_monthly", "pkg_annual"]);
    expect(rows[0].displayName).toBe("Monthly");
    expect(rows[0].period).toBe("P1M");
    expect(rows[1].displayName).toBe("Annual");
    expect(rows[1].period).toBe("P1Y");
  });

  it("gives unresolved offering ids a null-shaped row", () => {
    const rows = buildPriceRows(["pkg_monthly", "pkg_missing"], resolved);
    const missing = rows.find((r) => r.packageIdentifier === "pkg_missing");
    expect(missing).toEqual({
      packageIdentifier: "pkg_missing",
      displayName: null,
      period: null,
      periodConflict: false,
      stores: null,
    });
  });

  it("gives every row a null shape when resolved is undefined", () => {
    const rows = buildPriceRows(["pkg_monthly", "pkg_annual"], undefined);
    expect(rows).toEqual<PackagePriceRow[]>([
      { packageIdentifier: "pkg_monthly", displayName: null, period: null, periodConflict: false, stores: null },
      { packageIdentifier: "pkg_annual", displayName: null, period: null, periodConflict: false, stores: null },
    ]);
  });
});

describe("periodLabel", () => {
  it("uses the label table for known periods", () => {
    expect(periodLabel("P1M")).toBe("Monthly");
    expect(periodLabel("P1Y")).toBe("Annual");
  });

  it("falls back to the raw ISO string for unknown periods", () => {
    expect(periodLabel("P2W")).toBe("P2W");
  });

  it("passes null through", () => {
    expect(periodLabel(null)).toBeNull();
  });

  it("covers every entry declared in PERIOD_LABELS", () => {
    for (const [iso, label] of Object.entries(PERIOD_LABELS)) {
      expect(periodLabel(iso)).toBe(label);
    }
  });
});

function rowsFor(periods: readonly (string | null)[]): PackagePriceRow[] {
  return periods.map((period, i) => ({
    packageIdentifier: `pkg_${i}`,
    displayName: `Package ${i}`,
    period,
    periodConflict: false,
    stores: null,
  }));
}

describe("availablePresets", () => {
  it("returns [] for a single-period offering", () => {
    expect(availablePresets(rowsFor(["P1M", "P1M"]))).toEqual([]);
  });

  it("returns [] when there are no known periods at all", () => {
    expect(availablePresets(rowsFor([null, null]))).toEqual([]);
  });

  it("lists singles, the monthly+annual combo, then all — in offering order", () => {
    const rows = rowsFor(["P1M", "P1Y"]);
    const presets = availablePresets(rows);
    expect(presets.map((p) => p.id)).toEqual(["P1M", "P1Y", "P1M+P1Y", "all"]);
    expect(presets.map((p) => p.label)).toEqual(["Monthly", "Annual", "Monthly + Annual", "All"]);
    expect(presets.find((p) => p.id === "P1M+P1Y")?.periods).toEqual(["P1M", "P1Y"]);
    expect(presets.find((p) => p.id === "all")?.periods).toEqual(["P1M", "P1Y"]);
  });

  it("omits the monthly+annual combo unless both periods are present", () => {
    const rows = rowsFor(["P1M", "P1W"]);
    const presets = availablePresets(rows);
    expect(presets.map((p) => p.id)).toEqual(["P1M", "P1W", "all"]);
  });
});

describe("presetSelection", () => {
  const rows = rowsFor(["P1M", "P1Y", "P1M"]);
  // rows: pkg_0=P1M, pkg_1=P1Y, pkg_2=P1M

  it("filters rows whose period is in the preset and keeps a still-included default", () => {
    const preset = { id: "P1M", label: "Monthly", periods: ["P1M"] as const };
    const result = presetSelection(rows, preset, "pkg_2");
    expect(result).toEqual({ packageIds: ["pkg_0", "pkg_2"], defaultSelected: "pkg_2" });
  });

  it("clears defaultSelected when it falls outside the preset", () => {
    const preset = { id: "P1M", label: "Monthly", periods: ["P1M"] as const };
    const result = presetSelection(rows, preset, "pkg_1");
    expect(result).toEqual({ packageIds: ["pkg_0", "pkg_2"], defaultSelected: undefined });
  });

  it("keeps offering order in the result", () => {
    const preset = { id: "all", label: "All", periods: ["P1M", "P1Y"] as const };
    const result = presetSelection(rows, preset, undefined);
    expect(result.packageIds).toEqual(["pkg_0", "pkg_1", "pkg_2"]);
  });

  // P6 final-review finding: "All" was built from availablePresets' distinct
  // NON-NULL periods, so a null-period row (e.g. a lifetime package) was
  // silently dropped from the "all" preset's periods list, and this filter
  // then excluded it from the selection too. ALL_PRESET_ID is now
  // special-cased to every row regardless of period.
  it("the 'all' preset includes every row, including a null-period (e.g. lifetime) row", () => {
    const rowsWithLifetime = rowsFor(["P1M", "P1Y", null]);
    const preset = availablePresets(rowsWithLifetime).find((p) => p.id === "all")!;
    const result = presetSelection(rowsWithLifetime, preset, undefined);
    expect(result.packageIds).toEqual(["pkg_0", "pkg_1", "pkg_2"]);
  });

  it("a single-period preset still excludes the null-period row", () => {
    const rowsWithLifetime = rowsFor(["P1M", "P1Y", null]);
    const preset = availablePresets(rowsWithLifetime).find((p) => p.id === "P1M")!;
    const result = presetSelection(rowsWithLifetime, preset, undefined);
    expect(result.packageIds).toEqual(["pkg_0"]);
  });
});

describe("activePresetId", () => {
  const rows = rowsFor(["P1M", "P1Y"]);
  // pkg_0=P1M, pkg_1=P1Y

  it("matches an exact preset selection", () => {
    expect(activePresetId(rows, ["pkg_0"])).toBe("P1M");
  });

  it("is order-insensitive", () => {
    expect(activePresetId(rows, ["pkg_1", "pkg_0"])).toBe("P1M+P1Y");
  });

  it("returns null for a custom (non-preset) selection", () => {
    expect(activePresetId(rowsFor(["P1M", "P1Y", "P1W"]), ["pkg_0", "pkg_2"])).toBeNull();
  });

  it("treats an empty packageIds as \"all\" when the all preset exists", () => {
    expect(activePresetId(rows, [])).toBe("all");
  });

  it("treats an empty packageIds as null (custom) when there's no all preset", () => {
    expect(activePresetId(rowsFor(["P1M", "P1M"]), [])).toBeNull();
  });

  // P6 final-review finding: the explicit all-ids selection, the []
  // shorthand, and clicking "All" must all agree, including a null-period
  // (e.g. lifetime) row — see the presetSelection fix above.
  it("matches 'all' for an explicit selection that includes a null-period (lifetime) row", () => {
    const rowsWithLifetime = rowsFor(["P1M", "P1Y", null]);
    expect(activePresetId(rowsWithLifetime, ["pkg_0", "pkg_1", "pkg_2"])).toBe("all");
  });

  it("still matches 'all' via the [] shorthand when a null-period (lifetime) row exists", () => {
    const rowsWithLifetime = rowsFor(["P1M", "P1Y", null]);
    expect(activePresetId(rowsWithLifetime, [])).toBe("all");
  });
});

describe("formatMinorAmount", () => {
  it("formats USD minor units as dollars and cents", () => {
    expect(formatMinorAmount(999, "USD")).toBe("$9.99");
  });

  it("formats JPY (a Stripe zero-decimal currency) with no decimals", () => {
    expect(formatMinorAmount(500, "JPY")).toBe("¥500");
  });

  it("falls back to a manual format for an unknown currency code", () => {
    expect(formatMinorAmount(999, "NOT_A_CURRENCY")).toBe("NOT_A_CURRENCY 9.99");
  });
});

describe("storeBadgeText", () => {
  it("renders an ok entry as its formatted amount", () => {
    const entry: ResolvedStoreEntry = { status: "ok", amountMinor: 999, currency: "USD", period: "P1M", trialDays: null };
    expect(storeBadgeText(entry)).toBe("$9.99");
  });

  it("appends a trial suffix when trialDays is positive", () => {
    const entry: ResolvedStoreEntry = { status: "ok", amountMinor: 999, currency: "USD", period: "P1M", trialDays: 7 };
    expect(storeBadgeText(entry)).toBe("$9.99 · 7d trial");
  });

  it("omits the trial suffix when trialDays is zero", () => {
    const entry: ResolvedStoreEntry = { status: "ok", amountMinor: 999, currency: "USD", period: "P1M", trialDays: 0 };
    expect(storeBadgeText(entry)).toBe("$9.99");
  });

  it("renders not_configured, no_mapping and error statuses", () => {
    expect(storeBadgeText({ status: "not_configured" })).toBe("not configured");
    expect(storeBadgeText({ status: "no_mapping" })).toBe("no mapping");
    expect(storeBadgeText({ status: "error" })).toBe("unavailable");
  });
});

describe("periodNoun", () => {
  it("maps single-unit ISO periods to the SDK's noun style", () => {
    expect(periodNoun("P1D")).toBe("day");
    expect(periodNoun("P1W")).toBe("week");
    expect(periodNoun("P1M")).toBe("month");
    expect(periodNoun("P1Y")).toBe("year");
  });

  it("renders multi-unit periods as a count + plural noun", () => {
    expect(periodNoun("P3M")).toBe("3 months");
    expect(periodNoun("P6M")).toBe("6 months");
  });

  it("returns empty string for unknown or null input", () => {
    expect(periodNoun("P2X")).toBe("");
    expect(periodNoun("garbage")).toBe("");
    expect(periodNoun(null)).toBe("");
  });
});
