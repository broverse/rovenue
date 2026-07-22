import { z } from "zod";

// =============================================================
// presentedContext — paywall-attribution snapshot
// =============================================================
//
// Carried by receipt bodies (POST /v1/receipts/apple|google) and by
// Stripe subscription metadata (`rovenue_presented_context`, a JSON
// string) so a purchase can be traced back to the placement/paywall/
// experiment-variant that presented it. Every field is an opaque
// client-supplied string — NEVER validated against live placement/
// paywall/experiment rows. Attribution must not fail a purchase: a
// stale or fabricated id here just means weaker analytics, not a
// rejected receipt/webhook.

export const presentedContextSchema = z.object({
  placementId: z.string().min(1),
  paywallId: z.string().min(1),
  variantId: z.string().min(1).optional(),
  experimentKey: z.string().min(1).optional(),
});

export type PresentedContext = z.infer<typeof presentedContextSchema>;

/**
 * Defensively parse the `rovenue_presented_context` Stripe subscription
 * metadata value (a JSON string). Malformed JSON or a shape that doesn't
 * match {@link presentedContextSchema} is ignored — returns `null` — and
 * this NEVER throws. Webhook processing must never fail because a merchant
 * (or a stale integration) wrote a bad metadata value.
 */
export function parsePresentedContextMetadata(
  raw: string | null | undefined,
): PresentedContext | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = presentedContextSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
