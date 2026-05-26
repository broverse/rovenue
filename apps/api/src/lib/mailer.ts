import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { env } from "./env";
import { logger } from "./logger";
import { SmtpMailer } from "./mailer-smtp";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Tagged onto the outbound mail header (X-Rovenue-Id) for log correlation. */
  correlationId?: string;
  /**
   * Extra headers to attach (e.g. List-Unsubscribe, List-Unsubscribe-Post).
   * Merged with the correlationId header at send time.
   */
  headers?: Record<string, string>;
}

export interface Mailer {
  send(msg: MailMessage): Promise<{ messageId: string }>;
}

function combineHeaders(
  correlationId: string | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const merged: Record<string, string> = { ...(extra ?? {}) };
  if (correlationId) merged["X-Rovenue-Id"] = correlationId;
  return merged;
}

class SesMailer implements Mailer {
  constructor(
    private client: SESv2Client,
    private from: string,
    private configurationSet?: string,
  ) {}

  async send(msg: MailMessage) {
    const headers = combineHeaders(msg.correlationId, msg.headers);
    const headerEntries = Object.entries(headers);
    const cmd = new SendEmailCommand({
      FromEmailAddress: this.from,
      Destination: { ToAddresses: [msg.to] },
      ConfigurationSetName: this.configurationSet,
      Content: {
        Simple: {
          Subject: { Data: msg.subject, Charset: "UTF-8" },
          Body: {
            Html: { Data: msg.html, Charset: "UTF-8" },
            Text: { Data: msg.text, Charset: "UTF-8" },
          },
          Headers: headerEntries.length
            ? headerEntries.map(([Name, Value]) => ({ Name, Value }))
            : undefined,
        },
      },
    });
    const out = await this.client.send(cmd);
    return { messageId: out.MessageId ?? "" };
  }
}

class NoopMailer implements Mailer {
  async send(msg: MailMessage) {
    logger.warn("mailer.noop", { to: msg.to, subject: msg.subject });
    return { messageId: "noop" };
  }
}

let _mailer: Mailer | null = null;

/**
 * Build a Mailer from the runtime env. Exposed so tests can construct
 * one with a custom env shape; the singleton `mailer()` builds via
 * the loaded process env.
 *
 * Selection rules:
 *   - EMAIL_PROVIDER=smtp → SmtpMailer (requires SMTP_HOST/PORT/USER/PASS + a from address)
 *   - EMAIL_PROVIDER=ses + AWS_SES_FROM_EMAIL or EMAIL_FROM set → SesMailer
 *   - otherwise → NoopMailer (dev convenience; logs and returns id="noop")
 */
export function createMailerFromEnv(e: typeof env): Mailer {
  const from = e.EMAIL_FROM ?? e.AWS_SES_FROM_EMAIL;

  if (e.EMAIL_PROVIDER === "smtp") {
    if (!e.SMTP_HOST || !e.SMTP_PORT || !e.SMTP_USER || !e.SMTP_PASS || !from) {
      throw new Error(
        "EMAIL_PROVIDER=smtp requires SMTP_HOST/PORT/USER/PASS and EMAIL_FROM (or AWS_SES_FROM_EMAIL)",
      );
    }
    return new SmtpMailer({
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      user: e.SMTP_USER,
      pass: e.SMTP_PASS,
      secure: e.SMTP_SECURE,
      from,
    });
  }

  if (!from) return new NoopMailer();
  const client = new SESv2Client({ region: e.AWS_SES_REGION });
  return new SesMailer(client, from, e.AWS_SES_CONFIGURATION_SET ?? undefined);
}

export function mailer(): Mailer {
  if (_mailer) return _mailer;
  _mailer = createMailerFromEnv(env);
  return _mailer;
}

/** Test-only injection seam. Pass `null` to clear and let `mailer()` rebuild. */
export function __setMailerForTests(m: Mailer | null) {
  _mailer = m;
}

/** Test-only constructor export so unit tests can build an SesMailer with a mocked client. */
export const _SesMailerForTests = SesMailer;
