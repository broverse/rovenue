// =============================================================
// Browser origin allow-list entries
// =============================================================
//
// An API key's `allowedOrigins` decides whose JavaScript may use that key
// inside a visitor's browser. One parser serves both the dashboard form and
// the API route that persists the value, because a check that lives only in
// the form is a suggestion rather than a rule.
//
// The comparison at request time is an exact string match against the
// browser's `Origin` header (see apps/api/src/middleware/browser-cors.ts), so
// anything stored must already be in the shape a browser sends: scheme, host,
// and port only — no path, no trailing slash, lowercase host.

/** Schemes a browser can actually send as an `Origin`. */
const BROWSER_ORIGIN_SCHEMES = new Set(["http:", "https:"]);

/**
 * Normalises one allow-list entry, or returns `null` when the input is not a
 * usable origin.
 *
 * Rejections are deliberate rather than incidental:
 *   - a wildcard host (`https://*.example.com`) would turn a subdomain
 *     takeover into an API key;
 *   - a path, query or fragment implies a scoping the browser will not
 *     enforce — `Origin` never carries one;
 *   - a missing or non-http scheme can never match a real `Origin` header,
 *     so storing it produces an entry that silently never matches;
 *   - embedded credentials hide the real host from anyone reading the list.
 */
export function parseAllowedOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // `new URL` accepts `https://*.example.com` and keeps the asterisk in the
  // hostname, so the wildcard has to be refused explicitly rather than left
  // to the parser.
  if (trimmed.includes("*")) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (!BROWSER_ORIGIN_SCHEMES.has(url.protocol)) return null;
  if (!url.hostname) return null;
  if (url.username || url.password) return null;

  // `url.pathname` is "/" for an input with no path at all, which is the one
  // trailing form a human reasonably types. Anything longer is a real path.
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search || url.hash) return null;

  // `URL.origin` is already scheme + lowercased host + non-default port.
  return url.origin;
}

/**
 * Parses a whole list, returning the normalised origins or the first entry
 * that could not be parsed. Callers surface `invalid` to the user rather than
 * silently dropping it — a dropped entry looks like a saved one until a
 * request from that origin is refused.
 */
export function parseAllowedOrigins(
  raw: readonly string[],
): { origins: string[] } | { invalid: string } {
  const origins: string[] = [];
  for (const entry of raw) {
    const parsed = parseAllowedOrigin(entry);
    if (parsed === null) return { invalid: entry };
    if (!origins.includes(parsed)) origins.push(parsed);
  }
  return { origins };
}
