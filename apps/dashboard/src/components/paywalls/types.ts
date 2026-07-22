import type { DashboardPaywallRow, PaywallRemoteConfig } from "@rovenue/shared";

/**
 * UI alias for the wire row — paywalls are simple enough (no derived
 * sparkline/tint/metrics like offerings) that the API row doubles as
 * the view model.
 */
export type Paywall = DashboardPaywallRow;

export type { PaywallRemoteConfig };
