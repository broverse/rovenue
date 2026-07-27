import { stripeMinorUnitExponent } from "@rovenue/shared";
import type { OfferingResolvedPrices, ResolvedPackageInfo, ResolvedStoreEntry } from "@rovenue/shared";

/**
 * Pure helpers for the paywall-builder inspector's price-binding tab.
 * No react/VM imports — everything here is data in, data out, so it can
 * be unit tested without mounting a component.
 */

/** apple > google > stripe: the tie-break order for packagePeriod's majority pick. */
const STORE_PRECEDENCE = ["apple", "google", "stripe"] as const;

const MONTHLY_PERIOD = "P1M";
const ANNUAL_PERIOD = "P1Y";
const MONTHLY_ANNUAL_COMBO_ID = "P1M+P1Y";
const MONTHLY_ANNUAL_COMBO_LABEL = "Monthly + Annual";
const ALL_PRESET_ID = "all";
const ALL_PRESET_LABEL = "All";
const MIN_DISTINCT_PERIODS_FOR_PRESETS = 2;

const STORE_BADGE_NOT_CONFIGURED = "not configured";
const STORE_BADGE_NO_MAPPING = "no mapping";
const STORE_BADGE_ERROR = "unavailable";

export interface PackagePriceRow {
  packageIdentifier: string;
  displayName: string | null;
  period: string | null;
  periodConflict: boolean;
  stores: ResolvedPackageInfo["stores"] | null;
}

export const PERIOD_LABELS: Readonly<Record<string, string>> = {
  P1D: "Daily",
  P1W: "Weekly",
  P1M: "Monthly",
  P3M: "Quarterly",
  P6M: "6 months",
  P1Y: "Annual",
};

export interface PeriodPreset {
  id: string;
  label: string;
  periods: readonly string[];
}

/**
 * Distinct periods among the package's status-"ok" store entries. One
 * distinct value wins outright; more than one is resolved by frequency,
 * ties broken by STORE_PRECEDENCE (apple > google > stripe). Zero ok
 * entries falls back to the offline metadataPeriod convention.
 */
export function packagePeriod(info: ResolvedPackageInfo): { period: string | null; conflict: boolean } {
  const okPeriods: (string | null)[] = [];
  for (const store of STORE_PRECEDENCE) {
    const entry = info.stores[store];
    if (entry && entry.status === "ok") {
      okPeriods.push(entry.period);
    }
  }

  if (okPeriods.length === 0) {
    return { period: info.metadataPeriod, conflict: false };
  }

  const counts = new Map<string | null, number>();
  for (const period of okPeriods) {
    counts.set(period, (counts.get(period) ?? 0) + 1);
  }

  const distinct = [...counts.keys()];
  if (distinct.length === 1) {
    return { period: distinct[0], conflict: false };
  }

  let best = distinct[0];
  let bestCount = counts.get(best)!;
  for (const period of distinct) {
    const count = counts.get(period)!;
    if (count > bestCount) {
      best = period;
      bestCount = count;
    }
  }
  return { period: best, conflict: true };
}

/** One row per offering package id, in offering order. Ids not present in `resolved` get a null-shaped row. */
export function buildPriceRows(
  offeringPackageIds: readonly string[],
  resolved: OfferingResolvedPrices | undefined,
): PackagePriceRow[] {
  const byId = new Map<string, ResolvedPackageInfo>();
  if (resolved) {
    for (const info of resolved.packages) {
      byId.set(info.packageIdentifier, info);
    }
  }

  return offeringPackageIds.map((packageIdentifier) => {
    const info = byId.get(packageIdentifier);
    if (!info) {
      return {
        packageIdentifier,
        displayName: null,
        period: null,
        periodConflict: false,
        stores: null,
      };
    }
    const { period, conflict } = packagePeriod(info);
    return {
      packageIdentifier,
      displayName: info.displayName,
      period,
      periodConflict: conflict,
      stores: info.stores,
    };
  });
}

/** PERIOD_LABELS table hit, else the raw ISO string; null in, null out. */
export function periodLabel(iso: string | null): string | null {
  if (iso === null) return null;
  return PERIOD_LABELS[iso] ?? iso;
}

/** ISO unit letter → the SDK renderers' period noun (PackageViewMapping's periodLabel style). */
const PERIOD_UNIT_NOUNS: Readonly<Record<string, string>> = {
  D: "day",
  W: "week",
  M: "month",
  Y: "year",
};

const ISO_PERIOD_RE = /^P(\d+)([DWMY])$/;

/**
 * "P1M" → "month", "P3M" → "3 months" — the lowercase noun style the SDK
 * renderers use for `{{period}}` (PackageViewMapping.swift/.kt), so the
 * canvas matches devices. Unknown or null input → "" (no period figure).
 */
export function periodNoun(iso: string | null): string {
  if (iso === null) return "";
  const match = ISO_PERIOD_RE.exec(iso);
  if (!match) return "";
  const count = Number(match[1]);
  const noun = PERIOD_UNIT_NOUNS[match[2]!];
  if (!noun || count < 1) return "";
  return count === 1 ? noun : `${count} ${noun}s`;
}

/**
 * Distinct known (non-null) periods across rows, in offering order.
 * Singles first, then the monthly+annual combo iff both exist, then a
 * catch-all "all" preset. Fewer than two distinct periods → [] (a
 * preset picker is pointless with nothing to switch between).
 */
export function availablePresets(rows: readonly PackagePriceRow[]): PeriodPreset[] {
  const distinct: string[] = [];
  for (const row of rows) {
    if (row.period !== null && !distinct.includes(row.period)) {
      distinct.push(row.period);
    }
  }

  if (distinct.length < MIN_DISTINCT_PERIODS_FOR_PRESETS) {
    return [];
  }

  const presets: PeriodPreset[] = distinct.map((period) => ({
    id: period,
    label: periodLabel(period)!,
    periods: [period],
  }));

  if (distinct.includes(MONTHLY_PERIOD) && distinct.includes(ANNUAL_PERIOD)) {
    presets.push({
      id: MONTHLY_ANNUAL_COMBO_ID,
      label: MONTHLY_ANNUAL_COMBO_LABEL,
      periods: [MONTHLY_PERIOD, ANNUAL_PERIOD],
    });
  }

  presets.push({ id: ALL_PRESET_ID, label: ALL_PRESET_LABEL, periods: distinct });

  return presets;
}

/**
 * Ids of rows whose period is in the preset, offering order; defaultSelected
 * kept only if still included.
 *
 * ALL_PRESET_ID is special-cased to every row regardless of period: its
 * `periods` list only ever contains the *known* (non-null) distinct periods
 * (see availablePresets), so filtering by period would silently drop any
 * null-period row (e.g. a lifetime package) from "All" — final-review P6
 * finding. This keeps the explicit all-ids selection, the `[]` shorthand
 * (see activePresetId), and clicking "All" in agreement, lifetime included.
 */
export function presetSelection(
  rows: readonly PackagePriceRow[],
  preset: PeriodPreset,
  currentDefault: string | undefined,
): { packageIds: string[]; defaultSelected: string | undefined } {
  const packageIds =
    preset.id === ALL_PRESET_ID
      ? rows.map((row) => row.packageIdentifier)
      : rows
          .filter((row) => row.period !== null && preset.periods.includes(row.period))
          .map((row) => row.packageIdentifier);

  const defaultSelected = currentDefault !== undefined && packageIds.includes(currentDefault) ? currentDefault : undefined;

  return { packageIds, defaultSelected };
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

/**
 * The preset whose selection exactly matches packageIds (order-insensitive
 * set equality). An empty packageIds means "every package" by schema
 * semantics: matches the "all" preset when one exists, else null (custom).
 */
export function activePresetId(rows: readonly PackagePriceRow[], packageIds: readonly string[]): string | null {
  const presets = availablePresets(rows);

  if (packageIds.length === 0) {
    return presets.some((preset) => preset.id === ALL_PRESET_ID) ? ALL_PRESET_ID : null;
  }

  for (const preset of presets) {
    const selection = presetSelection(rows, preset, undefined);
    if (sameIdSet(selection.packageIds, packageIds)) {
      return preset.id;
    }
  }
  return null;
}

/**
 * Intl currency formatting over the Stripe (not CLDR) minor-unit divisor.
 * try/catch guards against a bad/unknown currency code crashing the
 * inspector — falls back to a plain "<CODE> <amount>" string.
 */
export function formatMinorAmount(amountMinor: number, currency: string): string {
  try {
    const divisor = 10 ** stripeMinorUnitExponent(currency);
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / divisor);
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
  }
}

export function storeBadgeText(entry: ResolvedStoreEntry): string {
  if (entry.status === "ok") {
    const amount = formatMinorAmount(entry.amountMinor, entry.currency);
    const trialSuffix = typeof entry.trialDays === "number" && entry.trialDays > 0 ? ` · ${entry.trialDays}d trial` : "";
    return `${amount}${trialSuffix}`;
  }
  if (entry.status === "not_configured") return STORE_BADGE_NOT_CONFIGURED;
  if (entry.status === "no_mapping") return STORE_BADGE_NO_MAPPING;
  return STORE_BADGE_ERROR;
}
