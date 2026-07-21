import type { Mailer, MailMessage } from "./mailer";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface ResendMailerOptions {
  apiKey: string;
  from: string;
}

/**
 * Mailer backed by the Resend HTTP API (https://resend.com/docs/api-reference).
 * Plain fetch, matching the push transports (lib/push/fcm.ts, apns.ts) —
 * one POST does not warrant the official SDK dependency.
 */
export class ResendMailer implements Mailer {
  readonly provider = "resend";

  constructor(private readonly opts: ResendMailerOptions) {}

  async send(msg: MailMessage): Promise<{ messageId: string }> {
    const headers: Record<string, string> = { ...(msg.headers ?? {}) };
    if (msg.correlationId) headers["X-Rovenue-Id"] = msg.correlationId;

    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.opts.from,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`resend send failed: ${res.status} ${body}`.trimEnd());
    }
    const out = (await res.json()) as { id?: string };
    return { messageId: out.id ?? "" };
  }
}
