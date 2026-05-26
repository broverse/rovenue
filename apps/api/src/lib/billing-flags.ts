import { env } from "./env";

// Single source of truth for whether the platform-billing surface is
// active. Read at runtime so test fixtures that mutate env take effect.
export function isBillingEnabled(): boolean {
  return env.BILLING_ENABLED === true;
}
