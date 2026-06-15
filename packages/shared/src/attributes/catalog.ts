// Reserved subscriber attributes. All keys are `$`-prefixed and
// validated. A `$`-prefixed key NOT in this map is still "reserved"
// (isReservedKey === true) so the input validator can reject it rather
// than silently storing an unknown namespaced key.

const VALUE_MAX = 500;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Loose E.164: optional leading +, 7..15 digits.
const PHONE_RE = /^\+?[0-9]{7,15}$/;
const ATT_CONSENT = ["notDetermined", "restricted", "denied", "authorized"];

export interface ReservedAttributeDef {
  key: string;
  /** Returns an error message, or null when the value is valid. */
  validate: (value: string) => string | null;
}

function maxLen(value: string): string | null {
  return value.length > VALUE_MAX ? `must be ≤ ${VALUE_MAX} characters` : null;
}

function def(key: string, validate: (v: string) => string | null): ReservedAttributeDef {
  return { key, validate: (v) => maxLen(v) ?? validate(v) };
}

const ok = () => null;

export const RESERVED_ATTRIBUTES: Record<string, ReservedAttributeDef> = {
  // --- identity ---
  $email: def("$email", (v) => (EMAIL_RE.test(v) ? null : "must be a valid email address")),
  $displayName: def("$displayName", ok),
  $phoneNumber: def("$phoneNumber", (v) =>
    PHONE_RE.test(v) ? null : "must be a phone number (7-15 digits, optional +)"),
  // --- push tokens ---
  $fcmTokens: def("$fcmTokens", ok),
  $apnsTokens: def("$apnsTokens", ok),
  // --- attribution / campaign ---
  $mediaSource: def("$mediaSource", ok),
  $campaign: def("$campaign", ok),
  $adGroup: def("$adGroup", ok),
  $keyword: def("$keyword", ok),
  $creative: def("$creative", ok),
  $ad: def("$ad", ok),
  // --- device / consent ---
  $idfa: def("$idfa", ok),
  $idfv: def("$idfv", ok),
  $gpsAdId: def("$gpsAdId", ok),
  $attConsentStatus: def("$attConsentStatus", (v) =>
    ATT_CONSENT.includes(v) ? null : `must be one of: ${ATT_CONSENT.join(", ")}`),
};

export function isReservedKey(key: string): boolean {
  return key.startsWith("$");
}

export function getReservedDef(key: string): ReservedAttributeDef | undefined {
  return RESERVED_ATTRIBUTES[key];
}

/**
 * Validate a reserved key's value. Returns an error message, or null
 * when valid. An unknown `$`-prefixed key returns a rejection message.
 */
export function validateReservedValue(key: string, value: string): string | null {
  const d = RESERVED_ATTRIBUTES[key];
  if (!d) return `unknown reserved attribute "${key}"`;
  return d.validate(value);
}
