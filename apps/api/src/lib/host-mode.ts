import { env } from "./env";

// Single source of truth for deployment-mode behaviour. All functions read
// `env` live so test fixtures that mutate env take effect.

export function isCloud(): boolean {
  return env.HOST_MODE === "cloud";
}

export function isSelfHosted(): boolean {
  return env.HOST_MODE === "self";
}

// Platform billing (Stripe) is cloud-only.
export function isBillingEnabled(): boolean {
  return isCloud();
}

// Self-host runs Rovi without tier quotas.
export function quotasUnlimited(): boolean {
  return isSelfHosted();
}

// Bring-your-own AI provider key is a self-host-only feature.
export function isByokAllowed(): boolean {
  return isSelfHosted();
}

// Open registration: an explicit ALLOW_REGISTRATION wins; otherwise it is
// derived from the host mode (cloud → open, self → closed).
export function registrationOpen(): boolean {
  return env.ALLOW_REGISTRATION ?? isCloud();
}
