import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { env } from "./env";
import { logger } from "./logger";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Tagged onto the outbound mail header (X-Rovenue-Id) for log correlation. */
  correlationId?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<{ messageId: string }>;
}

class SesMailer implements Mailer {
  constructor(
    private client: SESv2Client,
    private from: string,
    private configurationSet?: string,
  ) {}

  async send(msg: MailMessage) {
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
          Headers: msg.correlationId
            ? [{ Name: "X-Rovenue-Id", Value: msg.correlationId }]
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

export function mailer(): Mailer {
  if (_mailer) return _mailer;
  if (!env.AWS_SES_FROM_EMAIL) {
    _mailer = new NoopMailer();
    return _mailer;
  }
  const client = new SESv2Client({ region: env.AWS_SES_REGION });
  _mailer = new SesMailer(
    client,
    env.AWS_SES_FROM_EMAIL,
    env.AWS_SES_CONFIGURATION_SET ?? undefined,
  );
  return _mailer;
}

/** Test-only injection seam. Pass `null` to clear and let `mailer()` rebuild. */
export function __setMailerForTests(m: Mailer | null) {
  _mailer = m;
}

/** Test-only constructor export so unit tests can build an SesMailer with a mocked client. */
export const _SesMailerForTests = SesMailer;
