// =============================================================
// Funnel settings key normalization
// =============================================================
//
// The dashboard authored settings in camelCase while every reader in the
// API uses the snake_case names in
// packages/shared/src/funnel/settings-schema.ts. Nothing translated, so
// `dev_mode` was never true at runtime and deep links never resolved.
// Normalizing on WRITE fixes new saves; rows written before this keep
// their camelCase keys until their funnel is next saved, which is why
// readers must keep tolerating both for now.

const CAMEL_TO_SNAKE: Record<string, string> = {
  devMode: "dev_mode",
  universalLinkDomain: "universal_link_domain",
  deepLinkScheme: "deep_link_scheme",
  iosUrl: "app_store_url",
  androidUrl: "play_store_url",
};

/**
 * Rewrites known camelCase settings keys to their snake_case names.
 * Unrecognised keys pass through untouched — this is a rename, not a
 * whitelist, so a future setting is never silently dropped. An explicit
 * snake_case key always wins over its camelCase twin.
 */
export function normalizeFunnelSettings(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    const target = CAMEL_TO_SNAKE[key];
    if (!target) {
      out[key] = value;
      continue;
    }
    // Don't let the camelCase twin clobber an explicit snake_case value.
    if (!(target in input)) out[target] = value;
  }

  return out;
}
