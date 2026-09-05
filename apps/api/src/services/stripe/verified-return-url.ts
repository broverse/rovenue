import { drizzle } from "@rovenue/db";
import type { Db } from "@rovenue/db";

// =============================================================
// Client-supplied redirect URLs
// =============================================================
//
// Both the billing portal and SDK checkout hand Stripe a URL the browser is
// sent to afterwards, and both take that URL from the client. An unchecked
// redirect target is an open redirect wearing our domain's trust, so every
// such URL passes through here.
//
// The allow-list is the project's `custom_domains` rows — the only place a
// project has an ADMIN-VERIFIED domain on record (ownership is proven there
// by CNAME + TXT challenge for funnel serving). There is no separate
// "allowed redirect domains" setting, and inventing one would mean a second
// list nobody verified.
//
// This lives in its own module rather than inside billing-portal because it
// now has two callers. Two copies of a security rule drift, and the copy that
// drifts is the one nobody was looking at.

export class RedirectUrlNotAllowedError extends Error {
  constructor(rawUrl: string) {
    super(`URL is not one of the project's verified domains: ${rawUrl}`);
    this.name = "RedirectUrlNotAllowedError";
  }
}

/**
 * Returns the URL when its host is one of the project's verified domains,
 * and throws {@link RedirectUrlNotAllowedError} otherwise.
 *
 * https-only: these are browser redirects back into the developer's own
 * site, and the domain record this checks against exists specifically to
 * serve that site over https.
 */
export async function assertRedirectUrlAllowed(
  db: Db,
  projectId: string,
  rawUrl: string,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new RedirectUrlNotAllowedError(rawUrl);
  }
  if (parsed.protocol !== "https:") {
    throw new RedirectUrlNotAllowedError(rawUrl);
  }

  const domains = await drizzle.customDomainRepo.listByProject(db, projectId);
  const verifiedHosts = new Set(
    domains
      .filter((d) => d.verifiedAt !== null)
      .map((d) => d.hostname.toLowerCase()),
  );
  if (!verifiedHosts.has(parsed.hostname.toLowerCase())) {
    throw new RedirectUrlNotAllowedError(rawUrl);
  }
  return parsed.toString();
}
