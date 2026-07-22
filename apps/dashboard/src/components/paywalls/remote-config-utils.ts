import type { PaywallRemoteConfig } from "@rovenue/shared";

// =============================================================
// Pure helpers backing remote-config-editor.tsx
// =============================================================
//
// Kept dependency-free (no React) so they're unit-testable in
// isolation — see __tests__/remote-config-utils.test.ts. Mirrors the
// shape the API's `remoteConfigSchema` enforces server-side
// (apps/api/src/routes/dashboard/paywalls.ts): every locale value
// must be a JSON object, and `defaultLocale` must be a key of
// `locales`.

export function emptyRemoteConfig(defaultLocale = "en"): PaywallRemoteConfig {
  return { defaultLocale, locales: { [defaultLocale]: {} } };
}

export interface LocaleJsonParseResult {
  ok: boolean;
  value?: Record<string, unknown>;
  error?: string;
}

/**
 * Parses a single locale's textarea content as JSON and enforces the
 * same shape the backend requires: a JSON object, not an array,
 * string, number, boolean or null.
 */
export function parseLocaleJson(text: string): LocaleJsonParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid JSON",
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: 'Must be a JSON object, e.g. { "title": "Go Pro" }',
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export function normalizeLocaleCode(raw: string): string {
  return raw.trim().toLowerCase();
}

// BCP-47-ish: "en", "en-US", "pt-BR", "zh-Hans". Loose on purpose —
// the API doesn't validate locale codes beyond non-empty string.
export function isValidLocaleCode(code: string): boolean {
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(code);
}

/** Adds a new, empty-object locale. No-op if the code is blank/duplicate. */
export function addLocale(
  config: PaywallRemoteConfig,
  rawCode: string,
): PaywallRemoteConfig {
  const code = normalizeLocaleCode(rawCode);
  if (!code || Object.prototype.hasOwnProperty.call(config.locales, code)) {
    return config;
  }
  return { ...config, locales: { ...config.locales, [code]: {} } };
}

/**
 * Removes a locale. No-op when it's the last remaining locale (a
 * paywall must always have at least one) or when the code is unknown.
 * If the removed locale was the default, the default falls back to
 * whichever locale key sorts first among the survivors.
 */
export function removeLocale(
  config: PaywallRemoteConfig,
  code: string,
): PaywallRemoteConfig {
  const keys = Object.keys(config.locales);
  if (keys.length <= 1 || !keys.includes(code)) return config;

  const locales = { ...config.locales };
  delete locales[code];

  const defaultLocale =
    config.defaultLocale === code
      ? Object.keys(locales).sort()[0]!
      : config.defaultLocale;

  return { ...config, locales, defaultLocale };
}

/** Replaces one locale's remote-config object. No-op on unknown code. */
export function setLocaleValue(
  config: PaywallRemoteConfig,
  code: string,
  value: Record<string, unknown>,
): PaywallRemoteConfig {
  if (!Object.prototype.hasOwnProperty.call(config.locales, code)) return config;
  return { ...config, locales: { ...config.locales, [code]: value } };
}

/** Sets the default locale. No-op if `code` isn't a known locale key. */
export function setDefaultLocale(
  config: PaywallRemoteConfig,
  code: string,
): PaywallRemoteConfig {
  if (!Object.prototype.hasOwnProperty.call(config.locales, code)) return config;
  return { ...config, defaultLocale: code };
}
