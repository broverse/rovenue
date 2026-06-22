export interface RegistrationGateInput {
  /** Total existing users before this creation. */
  userCount: number;
  /** Whether open self-service registration is currently allowed. */
  registrationOpen: boolean;
  /** Whether a pending invitation exists for the signup email. */
  hasPendingInvite: boolean;
}

// The first user always bootstraps the instance. After that, a new account
// is allowed only when open registration is on, or the signup is backed by a
// pending invitation.
export function isRegistrationAllowed(input: RegistrationGateInput): boolean {
  if (input.userCount === 0) return true;
  if (input.registrationOpen) return true;
  return input.hasPendingInvite;
}
