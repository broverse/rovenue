import { SignJWT, importPKCS8 } from "jose";
import { logger } from "../../lib/logger";

const log = logger.child("apple-auth");

const AUDIENCE = "appstoreconnect-v1";
const ALG = "ES256";
const MAX_LIFETIME_SECONDS = 60 * 60;
const REFRESH_WINDOW_SECONDS = 60;

export interface AppleAuthConfig {
  /** Key ID from App Store Connect (10-char identifier). */
  keyId: string;
  /** Issuer ID (UUID) from App Store Connect. */
  issuerId: string;
  /** App bundle ID, e.g. "com.example.app". */
  bundleId: string;
  /** Contents of the .p8 private key file (PKCS8 PEM). */
  privateKey: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

function cacheKey(config: AppleAuthConfig): string {
  return `${config.issuerId}:${config.keyId}:${config.bundleId}`;
}

/**
 * Mint (or return a cached) App Store Server API bearer token. Tokens are
 * reused until within {@link REFRESH_WINDOW_SECONDS} of expiry.
 */
export async function getAppleAuthToken(
  config: AppleAuthConfig,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const key = cacheKey(config);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > now + REFRESH_WINDOW_SECONDS) {
    return cached.token;
  }

  const privateKey = await importPKCS8(config.privateKey, ALG);
  const expiresAt = now + MAX_LIFETIME_SECONDS;

  const token = await new SignJWT({ bid: config.bundleId })
    .setProtectedHeader({ alg: ALG, kid: config.keyId, typ: "JWT" })
    .setIssuer(config.issuerId)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(privateKey);

  tokenCache.set(key, { token, expiresAt });
  log.debug("minted app store server api token", {
    keyId: config.keyId,
    bundleId: config.bundleId,
    expiresAt,
  });

  return token;
}

/** Drop the cached token for a config (e.g. after a 401 from Apple). */
export function invalidateAppleAuthToken(config: AppleAuthConfig): void {
  tokenCache.delete(cacheKey(config));
}
