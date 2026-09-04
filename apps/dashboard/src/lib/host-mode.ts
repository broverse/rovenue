/**
 * Deployment-mode flags, mirrored from the API's HOST_MODE helper.
 *
 * Values come from lib/runtime-config.ts — the container's /config.js at
 * runtime, or the VITE_* build args in a from-source build. Self-hosters
 * get `self` (the default); Rovenue Cloud sets `cloud`.
 *
 * Export a pure `computeHostMode(env)` so unit tests can drive it without
 * needing to stub `import.meta.env` at module-evaluation time.
 */

import { allowRegistrationValue, hostModeValue } from "./runtime-config";

export interface HostModeEnv {
  hostMode?: string;
  allowRegistration?: string;
}

export interface HostModeFlags {
  isCloud: boolean;
  isSelfHosted: boolean;
  billingEnabled: boolean;
  byokAllowed: boolean;
  registrationOpen: boolean;
}

/**
 * Pure function — derives all mode flags from an env-shaped object.
 * Constants below are derived from `import.meta.env` at module load time.
 */
export function computeHostMode(env: HostModeEnv): HostModeFlags {
  const hostMode = env.hostMode ?? "self";
  const allowRegistrationRaw = env.allowRegistration;

  const isCloud = hostMode === "cloud";
  const isSelfHosted = !isCloud;
  const billingEnabled = isCloud;
  const byokAllowed = isSelfHosted;
  const registrationOpen =
    allowRegistrationRaw === undefined || allowRegistrationRaw === ""
      ? isCloud
      : allowRegistrationRaw === "true";

  return { isCloud, isSelfHosted, billingEnabled, byokAllowed, registrationOpen };
}

const _flags = computeHostMode({
  hostMode: hostModeValue(),
  allowRegistration: allowRegistrationValue(),
});

export const isCloud = _flags.isCloud;
export const isSelfHosted = _flags.isSelfHosted;
export const billingEnabled = _flags.billingEnabled;
export const byokAllowed = _flags.byokAllowed;
export const registrationOpen = _flags.registrationOpen;
