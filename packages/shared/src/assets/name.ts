import { ASSET_NAME_MAX_LENGTH } from "./constants";

// =============================================================
// isValidAssetName — the author-supplied display name
// =============================================================
//
// The storage key is application-generated, so the stored object's name
// is safe by construction. This guards the OTHER thing the name is: a
// value persisted and rendered in the dashboard, i.e. a stored-XSS
// sink. Allowlist, per OWASP, rather than a denylist.

/** Alphanumeric, hyphen, underscore, space and period. Note the absence
 *  of both path separators and every character that could open a tag. */
const ALLOWED = /^[A-Za-z0-9 ._-]+$/;

export function isValidAssetName(name: string): boolean {
  if (name.length === 0 || name.length > ASSET_NAME_MAX_LENGTH) return false;
  if (!ALLOWED.test(name)) return false;
  // A leading period makes a hidden file; sequential periods are the
  // shape of a traversal attempt even though the allowlist above
  // already excludes the separators one would need.
  if (name.startsWith(".")) return false;
  if (name.includes("..")) return false;
  return true;
}
