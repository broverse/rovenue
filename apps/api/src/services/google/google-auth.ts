import { JWT, OAuth2Client } from "google-auth-library";
import { logger } from "../../lib/logger";
import type { GoogleServiceAccountCredentials } from "./google-types";

const log = logger.child("google-auth");

const ANDROIDPUBLISHER_SCOPE =
  "https://www.googleapis.com/auth/androidpublisher";

const jwtCache = new Map<string, JWT>();

/**
 * Construct (or return a cached) google-auth-library `JWT` client for a
 * service account. The client handles token refresh internally.
 */
export function getGoogleAuthClient(
  credentials: GoogleServiceAccountCredentials,
): JWT {
  const key = credentials.client_email;
  const existing = jwtCache.get(key);
  if (existing) return existing;

  const client = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [ANDROIDPUBLISHER_SCOPE],
  });
  jwtCache.set(key, client);
  log.debug("provisioned google auth client", {
    client_email: credentials.client_email,
  });
  return client;
}

/**
 * Mint (or reuse) an access token for the androidpublisher scope. Typical
 * callers should prefer {@link getGoogleAuthClient} and pass it directly to
 * `google.androidpublisher({ auth })`.
 */
export async function getGoogleAccessToken(
  credentials: GoogleServiceAccountCredentials,
): Promise<string> {
  const client = getGoogleAuthClient(credentials);
  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error("Google auth: getAccessToken returned no token");
  }
  return token;
}

/** Drop cached client(s) for a given service account. */
export function invalidateGoogleAuthClient(
  credentials: GoogleServiceAccountCredentials,
): void {
  jwtCache.delete(credentials.client_email);
}

// =============================================================
// Pub/Sub push OIDC token verification
// =============================================================

// Shared OAuth2 client for verifying OIDC tokens — stateless, just holds
// Google's public key cache. No config is bound to the instance.
const oauthClient = new OAuth2Client();

const GOOGLE_ISSUERS: ReadonlySet<string> = new Set([
  "accounts.google.com",
  "https://accounts.google.com",
]);

export interface PubSubPushVerifyOptions {
  /** Audience encoded in the OIDC token (matches the Pub/Sub push subscription config). */
  audience: string;
  /** Optional: require the token's `email` claim to equal this service account. */
  serviceAccountEmail?: string;
}

/**
 * Verify an OIDC token attached to an authenticated Pub/Sub push request.
 *
 * Google Cloud Pub/Sub signs a JWT with its service account key when the
 * push subscription is configured with an auth email. The signed JWT is
 * delivered in the `Authorization: Bearer <token>` header. This function
 * validates the signature (against Google's public key set), the audience,
 * the issuer, and optionally the email.
 *
 * See: https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions
 */
export async function verifyPubSubPushToken(
  idToken: string,
  options: PubSubPushVerifyOptions,
): Promise<void> {
  const ticket = await oauthClient.verifyIdToken({
    idToken,
    audience: options.audience,
  });

  const payload = ticket.getPayload();
  if (!payload) {
    throw new Error("Pub/Sub token has no payload");
  }

  if (!payload.iss || !GOOGLE_ISSUERS.has(payload.iss)) {
    throw new Error(`Unexpected Pub/Sub token issuer: ${payload.iss ?? "<missing>"}`);
  }

  if (!payload.email_verified) {
    throw new Error("Pub/Sub token email_verified is false");
  }

  if (
    options.serviceAccountEmail &&
    payload.email !== options.serviceAccountEmail
  ) {
    throw new Error(
      `Pub/Sub token email mismatch: ${payload.email ?? "<missing>"} !== ${options.serviceAccountEmail}`,
    );
  }
}
