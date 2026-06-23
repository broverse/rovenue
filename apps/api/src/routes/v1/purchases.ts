import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validate } from "../../lib/validate";
import { ok, fail } from "../../lib/response";
import { loadAppleCredentials } from "../../lib/project-credentials";
import { buildOfferSignaturePayload, signOfferPayload } from "../../services/apple/offer-signature";
import { logger } from "../../lib/logger";

const log = logger.child("apple-offer-signature");

const bodySchema = z.object({
  productId: z.string().min(1),
  offerId: z.string().min(1),
  appAccountToken: z.string().optional(),
});

export const purchasesRoute = new Hono().post(
  "/apple-offer-signature",
  validate("json", bodySchema),
  async (c) => {
    const project = c.get("project");
    const body = c.req.valid("json");
    const creds = await loadAppleCredentials(project.id);
    if (!creds || !creds.privateKey || !creds.keyId || !creds.bundleId) {
      return c.json(
        fail("apple_offer_signing_unavailable", "Apple credentials are not configured for promotional-offer signing"),
        400,
      );
    }
    const nonce = randomUUID().toLowerCase();
    const timestamp = Date.now();
    const appAccountToken = (body.appAccountToken ?? "").toLowerCase();
    const payload = buildOfferSignaturePayload({
      bundleId: creds.bundleId, keyId: creds.keyId, productId: body.productId,
      offerId: body.offerId, appAccountToken, nonce, timestamp,
    });
    let signature: string;
    try {
      signature = signOfferPayload(payload, creds.privateKey);
    } catch {
      log.warn("offer signing failed", { projectId: project.id, productId: body.productId, offerId: body.offerId });
      return c.json(fail("apple_offer_signing_failed", "Failed to sign the promotional offer"), 400);
    }
    log.info("offer signature issued", { projectId: project.id, productId: body.productId, offerId: body.offerId });
    return c.json(ok({ keyIdentifier: creds.keyId, nonce, signature, timestamp }));
  },
);
