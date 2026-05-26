export type DeliveryStatus = "DELIVERED" | "BOUNCED" | "COMPLAINED";

export interface SesEventPatch {
  /** SES Configuration Set tag, if present. The webhook handler uses this
   *  to guard against unrelated events arriving at our endpoint. */
  configurationSet: string | null;
  sesMessageId: string;
  status: DeliveryStatus;
  error: string | null;
}

/**
 * Parse the JSON-encoded `Message` field of an SNS notification carrying
 * an SES event. Returns null for events we intentionally ignore
 * (transient bounces, unknown types, malformed JSON).
 */
export function parseSesEvent(rawMessage: string): SesEventPatch | null {
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(rawMessage) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!evt || typeof evt !== "object") return null;
  if (!evt.notificationType) return null;

  const mail = evt.mail as
    | { messageId?: string; tags?: Record<string, string[]> }
    | undefined;
  const sesMessageId = mail?.messageId;
  if (!sesMessageId) return null;

  const csTag = mail?.tags?.["ses:configuration-set"];
  const configurationSet = Array.isArray(csTag) ? (csTag[0] ?? null) : null;

  switch (evt.notificationType) {
    case "Bounce": {
      const bounce = evt.bounce as
        | {
            bounceType?: string;
            bouncedRecipients?: Array<{ diagnosticCode?: string }>;
          }
        | undefined;
      if (bounce?.bounceType !== "Permanent") return null;
      const diag =
        bounce.bouncedRecipients?.[0]?.diagnosticCode ?? "permanent bounce";
      return { configurationSet, sesMessageId, status: "BOUNCED", error: diag };
    }
    case "Complaint":
      return {
        configurationSet,
        sesMessageId,
        status: "COMPLAINED",
        error: null,
      };
    case "Delivery":
      return {
        configurationSet,
        sesMessageId,
        status: "DELIVERED",
        error: null,
      };
    case "Reject":
      return {
        configurationSet,
        sesMessageId,
        status: "BOUNCED",
        error: "rejected",
      };
    default:
      return null;
  }
}
