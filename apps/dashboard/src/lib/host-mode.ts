/**
 * Build-time deployment-mode flags, mirrored from the API's HOST_MODE helper.
 *
 * Self-hosters set VITE_HOST_MODE=self (the default) at image build time.
 * Rovenue Cloud sets VITE_HOST_MODE=cloud.
 *
 * Export a pure `computeHostMode(env)` so unit tests can drive it without
 * needing to stub `import.meta.env` at module-evaluation time.
 */

export interface HostModeEnv {
  VITE_HOST_MODE?: string;
  VITE_ALLOW_REGISTRATION?: string;
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
  const hostMode = env.VITE_HOST_MODE ?? "self";
  const allowRegistrationRaw = env.VITE_ALLOW_REGISTRATION;

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
  VITE_HOST_MODE: import.meta.env.VITE_HOST_MODE as string | undefined,
  VITE_ALLOW_REGISTRATION: import.meta.env.VITE_ALLOW_REGISTRATION as string | undefined,
});

export const isCloud = _flags.isCloud;
export const isSelfHosted = _flags.isSelfHosted;
export const billingEnabled = _flags.billingEnabled;
export const byokAllowed = _flags.byokAllowed;
export const registrationOpen = _flags.registrationOpen;
