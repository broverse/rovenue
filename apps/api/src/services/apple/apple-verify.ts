import {
  Environment as AppleSdkEnvironment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";
import {
  compactVerify,
  decodeProtectedHeader,
  importX509,
  type CompactJWSHeaderParameters,
  type FlattenedJWSInput,
  type KeyLike,
} from "jose";
import {
  APPLE_ENVIRONMENT,
  type AppleEnvironment,
  type AppleJwsRenewalInfoPayload,
  type AppleJwsTransactionPayload,
  type AppleResponseBodyV2DecodedPayload,
} from "./apple-types";
import { loadAppleRootCerts } from "./apple-root-ca";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";

const log = logger.child("apple-verify");

// =============================================================
// Verifier interface
// =============================================================

export interface AppleNotificationVerifier {
  verifyNotification(
    signedPayload: string,
  ): Promise<AppleResponseBodyV2DecodedPayload>;
  verifyTransaction(jws: string): Promise<AppleJwsTransactionPayload>;
  verifyRenewalInfo(jws: string): Promise<AppleJwsRenewalInfoPayload>;
}

// =============================================================
// Library-backed verifier — production path
// =============================================================

export interface LibraryVerifierConfig {
  appleRootCertificates: Buffer[];
  environment: AppleEnvironment;
  bundleId: string;
  appAppleId?: number;
  enableOnlineChecks?: boolean;
}

function mapEnvironmentToSdk(envValue: AppleEnvironment): AppleSdkEnvironment {
  return envValue === APPLE_ENVIRONMENT.PRODUCTION
    ? AppleSdkEnvironment.PRODUCTION
    : AppleSdkEnvironment.SANDBOX;
}

export class LibraryAppleNotificationVerifier
  implements AppleNotificationVerifier
{
  private readonly verifier: SignedDataVerifier;

  constructor(config: LibraryVerifierConfig) {
    this.verifier = new SignedDataVerifier(
      config.appleRootCertificates,
      config.enableOnlineChecks ?? false,
      mapEnvironmentToSdk(config.environment),
      config.bundleId,
      config.appAppleId,
    );
  }

  async verifyNotification(signedPayload: string) {
    const result = await this.verifier.verifyAndDecodeNotification(signedPayload);
    return result as unknown as AppleResponseBodyV2DecodedPayload;
  }

  async verifyTransaction(jws: string) {
    const result = await this.verifier.verifyAndDecodeTransaction(jws);
    return result as unknown as AppleJwsTransactionPayload;
  }

  async verifyRenewalInfo(jws: string) {
    const result = await this.verifier.verifyAndDecodeRenewalInfo(jws);
    return result as unknown as AppleJwsRenewalInfoPayload;
  }
}

// =============================================================
// Jose-backed verifier — test fallback (insecure: no chain validation)
// =============================================================

export type AppleKeyLookup = (
  protectedHeader: CompactJWSHeaderParameters,
  token: FlattenedJWSInput,
) => Promise<KeyLike | Uint8Array>;

function pemFromBase64(der: string): string {
  const wrapped = der.match(/.{1,64}/g)?.join("\n") ?? der;
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----\n`;
}

export const defaultAppleKeyLookup: AppleKeyLookup = async (header) => {
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length === 0 || typeof x5c[0] !== "string") {
    throw new Error("Apple JWS missing x5c header");
  }
  return importX509(pemFromBase64(x5c[0]), "ES256");
};

async function verifyJws<T>(
  jws: string,
  keyLookup: AppleKeyLookup,
): Promise<T> {
  const header = decodeProtectedHeader(jws);
  if (header.alg !== "ES256") {
    throw new Error(`Unexpected Apple JWS alg: ${String(header.alg)}`);
  }
  const { payload } = await compactVerify(jws, keyLookup);
  return JSON.parse(new TextDecoder().decode(payload)) as T;
}

export class JoseAppleNotificationVerifier
  implements AppleNotificationVerifier
{
  constructor(
    private readonly keyLookup: AppleKeyLookup = defaultAppleKeyLookup,
  ) {}

  verifyNotification(jws: string) {
    return verifyJws<AppleResponseBodyV2DecodedPayload>(jws, this.keyLookup);
  }

  verifyTransaction(jws: string) {
    return verifyJws<AppleJwsTransactionPayload>(jws, this.keyLookup);
  }

  verifyRenewalInfo(jws: string) {
    return verifyJws<AppleJwsRenewalInfoPayload>(jws, this.keyLookup);
  }
}

// =============================================================
// Back-compat functional wrappers
// =============================================================

export function verifySignedPayload(
  jws: string,
  keyLookup: AppleKeyLookup = defaultAppleKeyLookup,
): Promise<AppleResponseBodyV2DecodedPayload> {
  return new JoseAppleNotificationVerifier(keyLookup).verifyNotification(jws);
}

export function verifySignedTransaction(
  jws: string,
  keyLookup: AppleKeyLookup = defaultAppleKeyLookup,
): Promise<AppleJwsTransactionPayload> {
  return new JoseAppleNotificationVerifier(keyLookup).verifyTransaction(jws);
}

export function verifySignedRenewalInfo(
  jws: string,
  keyLookup: AppleKeyLookup = defaultAppleKeyLookup,
): Promise<AppleJwsRenewalInfoPayload> {
  return new JoseAppleNotificationVerifier(keyLookup).verifyRenewalInfo(jws);
}

export function decodeUnverifiedJws<T>(jws: string): T {
  const parts = jws.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWS: expected 3 parts");
  }
  const payload = Buffer.from(parts[1]!, "base64url").toString("utf8");
  return JSON.parse(payload) as T;
}

// =============================================================
// Factory — picks library verifier when root certs are configured,
// falls back to jose (insecure) otherwise.
// =============================================================

export interface CreateAppleVerifierOpts {
  projectId: string;
  bundleId: string;
  appAppleId?: number;
  environment?: AppleEnvironment;
}

const verifierCache = new Map<string, AppleNotificationVerifier>();

export function createAppleVerifier(
  opts: CreateAppleVerifierOpts,
): AppleNotificationVerifier {
  let certs: Buffer[] | null = null;
  try {
    certs = loadAppleRootCerts();
  } catch (err) {
    if (env.NODE_ENV === "production") {
      // Fail closed in production: a fingerprint mismatch is a
      // deployment-integrity failure, not a dev annoyance. Let the
      // caller see the error.
      throw err;
    }
    log.warn("Apple root cert load failed — dev fallback to jose verifier", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (!certs || certs.length === 0) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "Apple root certs unavailable (APPLE_ROOT_CERTS_DIR unset, missing, or empty) — refusing to construct an unchained verifier in production",
      );
    }
    log.warn("falling back to jose verifier (no Apple root certs)", {
      projectId: opts.projectId,
    });
    return new JoseAppleNotificationVerifier();
  }

  const envKey = opts.environment ?? APPLE_ENVIRONMENT.PRODUCTION;
  const cacheKey = `${opts.projectId}:${opts.bundleId}:${envKey}`;
  const cached = verifierCache.get(cacheKey);
  if (cached) return cached;

  const verifier = new LibraryAppleNotificationVerifier({
    appleRootCertificates: certs,
    environment: envKey,
    bundleId: opts.bundleId,
    appAppleId: opts.appAppleId,
    enableOnlineChecks: false,
  });
  verifierCache.set(cacheKey, verifier);
  return verifier;
}
