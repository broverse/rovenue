import type { DeliveryStatus } from "./ses-events";

export interface ResendEventPatch {
  providerMessageId: string;
  status: DeliveryStatus;
  error: string | null;
  recipients: string[];
}

interface ResendEnvelope {
  type?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { message?: string; type?: string; subType?: string };
  };
}

/**
 * Parse a Resend webhook payload into the same patch shape the SES
 * consumer produces. Returns null for events we intentionally ignore
 * (transient bounces, sent/opened/clicked/delayed, unknown types,
 * malformed JSON).
 */
export function parseResendEvent(rawBody: string): ResendEventPatch | null {
  let evt: ResendEnvelope;
  try {
    evt = JSON.parse(rawBody) as ResendEnvelope;
  } catch {
    return null;
  }
  if (!evt || typeof evt !== "object" || !evt.type) return null;

  const emailId = evt.data?.email_id;
  if (!emailId) return null;

  const toRaw = evt.data?.to;
  const recipients = (Array.isArray(toRaw) ? toRaw : toRaw ? [toRaw] : []).map(
    (r) => r.toLowerCase(),
  );

  switch (evt.type) {
    case "email.delivered":
      return { providerMessageId: emailId, status: "DELIVERED", error: null, recipients };
    case "email.bounced": {
      // Same policy as parseSesEvent: only permanent (hard) bounces drive
      // suppression. Resend surfaces the underlying bounce classification;
      // a missing type is treated as permanent (terminal bounce event).
      const bounce = evt.data?.bounce;
      if (bounce?.type && bounce.type.toLowerCase() !== "permanent") return null;
      const diag = [bounce?.type, bounce?.subType, bounce?.message]
        .filter(Boolean)
        .join(": ");
      return {
        providerMessageId: emailId,
        status: "BOUNCED",
        error: diag || "bounced",
        recipients,
      };
    }
    case "email.complained":
      return { providerMessageId: emailId, status: "COMPLAINED", error: null, recipients };
    default:
      return null;
  }
}
