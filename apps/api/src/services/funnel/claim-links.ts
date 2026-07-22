import { drizzle } from "@rovenue/db";

// =============================================================
// Claim links
// =============================================================
//
// A claim token is only useful if the buyer can carry it into the app,
// so every path that mints one has to hand back the same two URLs. There
// are now two such paths — the dev-mode stub in `routes/public/funnels.ts`
// and the Stripe confirm endpoint — and a second copy of this string
// building is how the two quietly drift apart, which the app would see as
// a deep link that silently stops resolving.
//
// Key casing: settings are read snake_case only, matching every other
// reader in the API (`funnel-magic.ts`, the funnels route). Rows written
// before `normalizeFunnelSettings` landed may still hold the camelCase
// twins; they start resolving when their funnel is next saved. This
// extraction deliberately does not change that behaviour.

export interface ClaimLinkSettings {
  deep_link_scheme?: string;
  universal_link_domain?: string;
}

export interface ClaimLinks {
  token: string;
  deep_link_url: string | null;
  universal_link_url: string | null;
}

/**
 * Pure half: settings + project + plaintext token in, the two URLs out.
 * Either link is null when the funnel has not configured that half.
 */
export function claimLinksFrom(
  settings: ClaimLinkSettings,
  projectId: string,
  token: string,
): ClaimLinks {
  return {
    token,
    deep_link_url: settings.deep_link_scheme
      ? `${settings.deep_link_scheme}://onboarding-complete?token=${token}&project=${projectId}`
      : null,
    universal_link_url: settings.universal_link_domain
      ? `https://${settings.universal_link_domain}/universal/funnels/open/${token}`
      : null,
  };
}

/**
 * Load the session's funnel version and build its claim links. A version
 * that has vanished yields two nulls rather than throwing: the token
 * itself is still valid and still the thing worth returning.
 */
export async function buildClaimLinks(
  session: { projectId: string; funnelVersionId: string },
  token: string,
): Promise<ClaimLinks> {
  const version = await drizzle.funnelVersionRepo.findById(
    drizzle.db,
    session.funnelVersionId,
  );
  const settings = (version?.settingsJson ?? {}) as ClaimLinkSettings;
  return claimLinksFrom(settings, session.projectId, token);
}
