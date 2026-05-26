// =============================================================
// Timezone-at-local-hour helper
// =============================================================
//
// Used by the digest scheduler to discover which IANA timezones
// are currently sitting at a given local hour for a given UTC
// `now`. Phase 11 calls this once an hour with `targetHour = 9`
// to drive the "daily digest at 09:00 local" cadence; the same
// helper works for any hour bucket (weekly digest also uses 9).
//
// We deliberately don't pull luxon — Node 22's `Intl` API ships
// the full IANA database, `Intl.supportedValuesOf("timeZone")`
// enumerates it, and `Intl.DateTimeFormat.formatToParts()` gives
// the local hour in O(1) per zone. The whole pass is ~600 zones
// * a couple of Intl calls; negligible compared to the downstream
// per-user DB scan.

// `Intl.supportedValuesOf` was added in Node 18 LTS; ambient
// types ship with @types/node 18+. The `globalThis.Intl` access
// keeps tsc happy without polluting `lib`.
function listTimezones(): readonly string[] {
  const i = Intl as unknown as {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  if (typeof i.supportedValuesOf === "function") {
    return i.supportedValuesOf("timeZone");
  }
  // Defensive fallback — every supported Node runtime exposes
  // supportedValuesOf, so we shouldn't reach this branch outside
  // a stripped polyfill. Returning [] makes the scheduler a no-op
  // rather than crashing the worker.
  return [];
}

const hourFormatCache = new Map<string, Intl.DateTimeFormat>();

function getHour(zone: string, when: Date): number | null {
  let fmt = hourFormatCache.get(zone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hour: "numeric",
        hour12: false,
      });
    } catch {
      // Zone string isn't recognised by ICU on this runtime —
      // skip it. (Should only happen if `supportedValuesOf`
      // surfaces a zone the ICU build doesn't actually know.)
      return null;
    }
    hourFormatCache.set(zone, fmt);
  }
  // formatToParts is more robust than parsing format() — locale
  // variations can drop a leading zero or use "24" for midnight.
  for (const part of fmt.formatToParts(when)) {
    if (part.type === "hour") {
      const n = Number(part.value);
      if (Number.isFinite(n)) {
        // `hour12: false` with en-US emits 0..23, but some ICU
        // builds emit "24" for midnight. Normalise.
        return n === 24 ? 0 : n;
      }
    }
  }
  return null;
}

/**
 * Returns every IANA timezone whose local clock currently reads
 * `targetHour` (0..23) for the given UTC instant.
 *
 * DST handling is automatic: the underlying ICU database
 * encodes transitions, so the set returned naturally shifts on
 * "spring forward" / "fall back" days without any tz math here.
 */
export function timezonesAtLocalHour(
  utcNow: Date,
  targetHour: number,
): string[] {
  if (
    !Number.isInteger(targetHour) ||
    targetHour < 0 ||
    targetHour > 23
  ) {
    throw new RangeError(
      `timezonesAtLocalHour: targetHour must be 0..23 (got ${targetHour})`,
    );
  }
  const out: string[] = [];
  for (const zone of listTimezones()) {
    if (getHour(zone, utcNow) === targetHour) out.push(zone);
  }
  return out;
}
