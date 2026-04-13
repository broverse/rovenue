import { JWT } from "google-auth-library";
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
