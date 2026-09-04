// =============================================================
// Custom-host detection
// =============================================================
//
// A funnel bound to a customer's own domain is served by this same SPA
// (the edge proxies custom hosts to the dashboard origin). The root
// route needs to know whether it is running on the canonical dashboard
// host or on someone's custom domain.
//
// Pure function + env-shaped argument, mirroring lib/host-mode.ts, so
// tests never have to stub `import.meta.env`.

import { dashboardHostValue } from "./runtime-config";

export interface CustomHostEnv {
  dashboardHost?: string | undefined;
}

/** Strip an optional :port and lowercase, matching the API-side
 * normalisation in services/custom-domains/host-resolver.ts. */
function normalize(host: string): string {
  return host.split(":")[0]?.toLowerCase() ?? "";
}

/**
 * Whether `hostname` is the canonical dashboard host.
 *
 * An UNSET `VITE_DASHBOARD_HOST` returns false — meaning "not known to be
 * canonical", so the caller performs the host lookup. That direction is
 * deliberate: the variable is an optimisation that skips one request, not
 * a feature switch. Treating unset as canonical would make custom domains
 * silently fail for anyone who never configured it.
 */
export function isCanonicalDashboardHost(
  env: CustomHostEnv,
  hostname: string,
): boolean {
  const configured = env.dashboardHost;
  if (!configured) return false;
  return normalize(configured) === normalize(hostname);
}

export const dashboardHostEnv: CustomHostEnv = {
  dashboardHost: dashboardHostValue(),
};
