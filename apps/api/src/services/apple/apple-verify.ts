import {
  compactVerify,
  decodeProtectedHeader,
  importX509,
  type CompactJWSHeaderParameters,
  type FlattenedJWSInput,
  type KeyLike,
} from "jose";
import type {
  AppleJwsRenewalInfoPayload,
  AppleJwsTransactionPayload,
  AppleResponseBodyV2DecodedPayload,
} from "./apple-types";

/**
 * Function jose uses to look up the verification key for a JWS. In production
 * this inspects the x5c chain in the header; tests inject a fixed public key.
 */
export type AppleKeyLookup = (
  protectedHeader: CompactJWSHeaderParameters,
  token: FlattenedJWSInput,
) => Promise<KeyLike | Uint8Array>;

function pemFromBase64(der: string): string {
  const wrapped = der.match(/.{1,64}/g)?.join("\n") ?? der;
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----\n`;
}

/**
 * Default resolver: imports the leaf cert from the JWS `x5c` header and uses
 * its public key to verify the signature. TODO: also validate the full chain
 * against Apple's root CA (AppleRootCA-G3) before trusting the leaf.
 */
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

export function verifySignedPayload(
  jws: string,
  keyLookup: AppleKeyLookup = defaultAppleKeyLookup,
): Promise<AppleResponseBodyV2DecodedPayload> {
  return verifyJws<AppleResponseBodyV2DecodedPayload>(jws, keyLookup);
}

export function verifySignedTransaction(
  jws: string,
  keyLookup: AppleKeyLookup = defaultAppleKeyLookup,
): Promise<AppleJwsTransactionPayload> {
  return verifyJws<AppleJwsTransactionPayload>(jws, keyLookup);
}

export function verifySignedRenewalInfo(
  jws: string,
  keyLookup: AppleKeyLookup = defaultAppleKeyLookup,
): Promise<AppleJwsRenewalInfoPayload> {
  return verifyJws<AppleJwsRenewalInfoPayload>(jws, keyLookup);
}

/**
 * Decode a JWS payload WITHOUT verifying its signature. Only use for
 * diagnostics and tests — never trust the result in production flows.
 */
export function decodeUnverifiedJws<T>(jws: string): T {
  const parts = jws.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWS: expected 3 parts");
  }
  const payload = Buffer.from(parts[1]!, "base64url").toString("utf8");
  return JSON.parse(payload) as T;
}
