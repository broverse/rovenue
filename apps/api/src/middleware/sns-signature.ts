// =============================================================
// SNS signature verification middleware
// =============================================================
//
// Mounted in front of `/internal/ses-feedback`. Reads the SNS
// payload from the request body, hands it to verifySnsSignature
// (lib/sns-signature) which fetches the signing cert from AWS
// and validates the canonical body. On success the verified
// SnsPayload is stashed on the Hono context for the handler.
//
// Failure modes:
//   - Malformed JSON                 → 400
//   - SigningCertURL not on AWS host → 400 (refuse to fetch)
//   - Signature verification failed  → 401
//
// The SES → SNS subscription will retry on non-2xx, which is
// desirable for transient cert-fetch failures (e.g. AWS network
// blip) and harmless for forged traffic — SNS gives up after the
// configured retry policy expires.

import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  isAmazonSigningCertHost,
  verifySnsSignature,
  type SnsPayload,
} from "../lib/sns-signature";
import { logger } from "../lib/logger";

const log = logger.child("sns-signature");

declare module "hono" {
  interface ContextVariableMap {
    snsMessage?: SnsPayload;
  }
}

function looksLikeSnsPayload(v: unknown): v is SnsPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.Type === "string" &&
    typeof o.MessageId === "string" &&
    typeof o.TopicArn === "string" &&
    typeof o.Signature === "string" &&
    typeof o.SignatureVersion === "string" &&
    typeof o.SigningCertURL === "string"
  );
}

export const requireSnsSignature: MiddlewareHandler = async (c, next) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid SNS JSON body" });
  }
  if (!looksLikeSnsPayload(body)) {
    throw new HTTPException(400, { message: "Not an SNS payload" });
  }

  if (!isAmazonSigningCertHost(body.SigningCertURL)) {
    log.warn("untrusted_signing_cert_host", {
      host: body.SigningCertURL,
      messageId: body.MessageId,
    });
    throw new HTTPException(400, { message: "Untrusted SigningCertURL host" });
  }

  try {
    await verifySnsSignature(body);
  } catch (err) {
    log.warn("verification_failed", {
      messageId: body.MessageId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new HTTPException(401, { message: "Invalid SNS signature" });
  }

  c.set("snsMessage", body);
  await next();
};
