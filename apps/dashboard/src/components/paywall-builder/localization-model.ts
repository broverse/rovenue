import {
  collectLocalizationUsages,
  isMissingLocaleValue,
  type BuilderConfig,
} from "@rovenue/shared/paywall";

// =============================================================
// Pure shaping helpers for the localization matrix. Rows come from what
// the TREE actually uses (not from whatever keys happen to sit in a
// locale table), and "missing" is the shared predicate the validator
// uses — so the matrix and the publish gate agree by construction.
// =============================================================

export interface MatrixRow {
  key: string;
  /** First node (document order) that uses this key — the jump target. */
  nodeId: string;
  nodeType: string;
  viaOverride: boolean;
  /** Further nodes using the same key, if any. */
  otherNodeIds: string[];
}

export interface LocaleCompletion {
  locale: string;
  done: number;
  total: number;
  missingKeys: string[];
}

/** One row per distinct key, in document order; the first owner wins. */
export function buildMatrixRows(config: BuilderConfig): MatrixRow[] {
  const byKey = new Map<string, MatrixRow>();
  for (const usage of collectLocalizationUsages(config.root)) {
    const existing = byKey.get(usage.key);
    if (existing) {
      if (existing.nodeId !== usage.nodeId && !existing.otherNodeIds.includes(usage.nodeId)) {
        existing.otherNodeIds.push(usage.nodeId);
      }
      continue;
    }
    byKey.set(usage.key, {
      key: usage.key,
      nodeId: usage.nodeId,
      nodeType: usage.nodeType,
      viaOverride: usage.viaOverride,
      otherNodeIds: [],
    });
  }
  return [...byKey.values()];
}

/** True when this locale has no real text for the key. */
export function isCellMissing(config: BuilderConfig, key: string, locale: string): boolean {
  return isMissingLocaleValue(config.localizations[locale]?.[key]);
}

/** Filled-cell count for a locale across the matrix's rows. */
export function localeCompletion(
  config: BuilderConfig,
  rows: MatrixRow[],
  locale: string,
): LocaleCompletion {
  const missingKeys = rows.filter((r) => isCellMissing(config, r.key, locale)).map((r) => r.key);
  return {
    locale,
    done: rows.length - missingKeys.length,
    total: rows.length,
    missingKeys,
  };
}

/**
 * The `${locale}:${key}` identity used for the machine-translated marking.
 * One function so the VM and the modal cannot disagree about the shape.
 */
export function machineTranslatedId(locale: string, key: string): string {
  return `${locale}:${key}`;
}

/**
 * Source-locale text for `keys`, ready to send to the translate endpoint.
 *
 * Keys whose SOURCE cell is itself empty are skipped: there is nothing to
 * translate, and sending them would spend quota to have a model invent
 * copy. `isCellMissing` is the same predicate the completion badges and
 * the publish gate use, so all three agree about what "empty" means.
 */
export function sourceEntriesFor(
  config: BuilderConfig,
  sourceLocale: string,
  keys: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (isCellMissing(config, key, sourceLocale)) continue;
    out[key] = config.localizations[sourceLocale]![key]!;
  }
  return out;
}
